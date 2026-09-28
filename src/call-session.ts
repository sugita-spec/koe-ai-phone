import { DurableObject } from "cloudflare:workers";
import type { CallContext, CallRecord, WorkerEnv } from "./worker-lib";
import {
  buildLiveGreetingCommands,
  CALL_DISPOSITIONS,
  callNeedsSummary,
  getCall,
  getSettings,
  LIVE_GREETING_DELAY_MS,
  normalizeJapaneseDomestic,
  normalizeJapanesePhone,
  patchCall,
  saveCall,
  sendCallNotification,
  summarizeCallTranscript,
  xmlEscape
} from "./worker-lib";

interface StartInput {
  realtimeId: string;
  context: CallContext;
  openingInstruction: string;
  protocol: "live" | "realtime";
}

interface RealtimeEvent {
  type?: string;
  transcript?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  item?: { type?: string; call_id?: string; name?: string; arguments?: string };
  delta?: string;
  event?: RealtimeEvent;
}

const CALL_TOOL_NAMES = new Set([
  "take_message",
  "save_call_outcome",
  "mark_do_not_call",
  "check_calendar_availability",
  "schedule_appointment",
  "transfer_to_human"
]);

function textArgument(args: Record<string, unknown>, name: string, limit: number): string {
  return typeof args[name] === "string" ? args[name].trim().slice(0, limit) : "";
}

function canonicalJapanesePhone(value: string): string {
  const compact = value.normalize("NFKC").replace(/[\s\-‐‑‒–—―ー−()（）.]/g, "");
  if (/^\+81\d{9,10}$/.test(compact)) return `0${compact.slice(3)}`;
  return normalizeJapaneseDomestic(compact);
}

function japanesePhoneToE164(value: string): string {
  const compact = value.normalize("NFKC").replace(/[\s\-‐‑‒–—―ー−()（）.]/g, "");
  if (/^\+81\d{9,10}$/.test(compact)) return compact;
  return normalizeJapanesePhone(compact);
}

function checkedEmail(value: string): string {
  if (!value) return "";
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new Error("メールアドレスを確認できませんでした");
  }
  return value;
}

function checkedFutureDate(value: string, label: string): string {
  if (!value) throw new Error(`${label}を確認できませんでした`);
  if (!/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error(`${label}はタイムゾーン付きの日時で指定してください`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${label}はタイムゾーン付きの日時で指定してください`);
  if (date.getTime() <= Date.now()) throw new Error(`${label}には現在より後の日時を指定してください`);
  return date.toISOString();
}

export class CallSession extends DurableObject<WorkerEnv> {
  private socket: WebSocket | null = null;
  private handledTools = new Set<string>();
  private input: StartInput | null = null;
  private liveCallerTranscript = "";
  private liveAgentTranscript = "";
  private greetingSent = false;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
          id INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS session_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          realtime_id TEXT NOT NULL,
          local_id TEXT NOT NULL,
          context_json TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          status TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS transcript (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (1);
      `);
    });
  }

  async start(input: StartInput): Promise<{ connected: boolean }> {
    const current = this.ctx.storage.sql.exec<{ status: string }>("SELECT status FROM session_state WHERE id = 1").toArray()[0];
    if (current?.status === "connected" && this.socket) return { connected: true };
    if (!this.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY が未設定です");

    this.input = input;
    this.greetingSent = false;
    this.ctx.storage.sql.exec(
      `INSERT INTO session_state (id, realtime_id, local_id, context_json, started_at, status)
       VALUES (1, ?, ?, ?, ?, 'connecting')
       ON CONFLICT(id) DO UPDATE SET realtime_id = excluded.realtime_id, local_id = excluded.local_id,
       context_json = excluded.context_json, started_at = excluded.started_at, status = excluded.status`,
      input.realtimeId,
      input.context.localId,
      JSON.stringify(input.context),
      Date.now()
    );

    const websocketUrl = input.protocol === "live"
      ? `https://api.openai.com/v1/live/sessions/${encodeURIComponent(input.realtimeId)}/attach`
      : `https://api.openai.com/v1/realtime?call_id=${encodeURIComponent(input.realtimeId)}`;
    const response = await fetch(websocketUrl, {
      headers: {
        Authorization: `Bearer ${this.env.OPENAI_API_KEY}`,
        Upgrade: "websocket"
      }
    });
    const socket = response.webSocket;
    if (!socket || response.status !== 101) {
      this.ctx.storage.sql.exec("UPDATE session_state SET status = 'failed' WHERE id = 1");
      throw new Error(`OpenAI Realtime WebSocket接続に失敗しました (${response.status})`);
    }

    socket.accept();
    this.socket = socket;
    this.ctx.storage.sql.exec("UPDATE session_state SET status = 'connected' WHERE id = 1");
    socket.addEventListener("message", (event) => this.ctx.waitUntil(this.handleMessage(event.data)));
    socket.addEventListener("close", () => this.ctx.waitUntil(this.finish("completed")));
    socket.addEventListener("error", () => this.ctx.waitUntil(this.finish("failed", "Realtime WebSocket error")));
    if (input.protocol === "realtime") {
      socket.send(JSON.stringify({
        type: "response.create",
        response: { instructions: input.openingInstruction }
      }));
    }
    return { connected: true };
  }

  async status(): Promise<{ status: string; connected: boolean }> {
    const row = this.ctx.storage.sql.exec<{ status: string }>("SELECT status FROM session_state WHERE id = 1").toArray()[0];
    return { status: row?.status || "not_started", connected: Boolean(this.socket) };
  }

  private async handleMessage(raw: string | ArrayBuffer): Promise<void> {
    let event: RealtimeEvent;
    try {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      event = JSON.parse(text) as RealtimeEvent;
    } catch {
      return;
    }

    if (event.type === "conversation.item.input_audio_transcription.completed") {
      await this.addTranscript("caller", event.transcript || "");
    }
    if (["response.output_audio_transcript.done", "response.audio_transcript.done"].includes(event.type || "")) {
      await this.addTranscript("agent", event.transcript || "");
    }
    if (event.type === "response.function_call_arguments.done") {
      await this.handleTool(event.call_id, event.name, event.arguments);
    }
    if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      await this.handleTool(event.item.call_id, event.item.name, event.item.arguments);
    }
    if (event.type === "session.started" && this.input?.protocol === "live" && !this.greetingSent) {
      this.greetingSent = true;
      const eventId = crypto.randomUUID();
      const [prepareGreeting, startGreeting] = buildLiveGreetingCommands(this.input.openingInstruction, eventId);
      const socket = this.socket;
      socket?.send(JSON.stringify(prepareGreeting));
      await scheduler.wait(LIVE_GREETING_DELAY_MS);
      if (socket && this.socket === socket && socket.readyState === 1) socket.send(JSON.stringify(startGreeting));
    }
    if (event.type === "session.input_transcript.delta") {
      if (this.liveAgentTranscript) await this.flushLiveTranscript("agent");
      this.liveCallerTranscript += event.delta || "";
    }
    if (event.type === "session.output_transcript.delta") {
      if (this.liveCallerTranscript) await this.flushLiveTranscript("caller");
      this.liveAgentTranscript += event.delta || "";
    }
    if (event.type === "response.event" && event.event?.type === "response.output_item.done" && event.event.item?.type === "function_call") {
      await this.handleTool(event.event.item.call_id, event.event.item.name, event.event.item.arguments);
    }
    if (event.type === "session.closed") {
      await this.finish("completed");
    }
  }

  private async flushLiveTranscript(role: "caller" | "agent"): Promise<void> {
    const text = role === "caller" ? this.liveCallerTranscript : this.liveAgentTranscript;
    if (!text.trim()) return;
    if (role === "caller") this.liveCallerTranscript = "";
    else this.liveAgentTranscript = "";
    await this.addTranscript(role, text);
  }

  private async addTranscript(role: string, text: string): Promise<void> {
    if (!text || !this.input) return;
    const at = new Date().toISOString();
    this.ctx.storage.sql.exec("INSERT INTO transcript (role, text, created_at) VALUES (?, ?, ?)", role, text, at);
    if (this.env.STORE_TRANSCRIPTS === "false") return;
    const rows = this.ctx.storage.sql.exec<{ role: string; text: string; created_at: string }>(
      "SELECT role, text, created_at FROM transcript ORDER BY id DESC LIMIT 100"
    ).toArray().reverse();
    const call = await getCall(this.env.DB, this.input.context.localId);
    if (!call) return;
    call.transcript = rows.map((row) => ({ role: row.role, text: row.text, at: row.created_at }));
    await saveCall(this.env.DB, call);
  }

  private campaignId(call: CallRecord): string | null {
    return call.campaignId || this.input?.context.campaignId || null;
  }

  private campaignLeadId(call: CallRecord): string | null {
    return call.campaignLeadId || this.input?.context.campaignLeadId || null;
  }

  private async writeAudit(
    action: string,
    targetType: string,
    targetId: string,
    details: Record<string, unknown>
  ): Promise<void> {
    try {
      await this.env.DB.prepare(`INSERT INTO audit_log
        (id, actor_token_id, actor_label, action, entity_type, entity_id, metadata_json, created_at)
        VALUES (?, NULL, 'AI電話エージェント', ?, ?, ?, ?, ?)`)
        .bind(`audit_${crypto.randomUUID()}`, action, targetType, targetId, JSON.stringify(details), new Date().toISOString())
        .run();
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "ai_call_audit_failed",
        action,
        targetType,
        targetId,
        error: error instanceof Error ? error.message.slice(0, 500) : "監査ログの保存に失敗しました"
      }));
    }
  }

  private async updateLeadOutcome(
    call: CallRecord,
    disposition: string,
    note: string,
    callbackAt: string | null
  ): Promise<void> {
    const leadId = this.campaignLeadId(call);
    if (!leadId) return;
    await this.env.DB.prepare(`UPDATE outbound_campaign_leads
      SET disposition = ?, disposition_note = ?, callback_at = ?, next_attempt_at = ?, updated_at = ?
      WHERE id = ?`)
      .bind(disposition, note, callbackAt, callbackAt, new Date().toISOString(), leadId)
      .run();
  }

  private async postIntegration(url: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    const headers = new Headers({ "content-type": "application/json" });
    const token = this.env.INTEGRATION_WEBHOOK_TOKEN || this.env.NOTIFICATION_WEBHOOK_TOKEN || "";
    if (token) {
      headers.set("authorization", `Bearer ${token}`);
    }
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(token ? { ...payload, token } : payload) });
    const result = await response.json<Record<string, unknown>>().catch(() => ({}));
    if (!response.ok) throw new Error(`連携先がエラーを返しました (${response.status})`);
    return result;
  }

  private async checkCalendarAvailability(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const calendarWebhookUrl = await this.integrationUrl("calendar", this.env.CALENDAR_WEBHOOK_URL);
    if (!calendarWebhookUrl) return { ok: false, error: "Googleカレンダーが未接続です" };
    const rawFrom = textArgument(args, "from", 100);
    const from = rawFrom ? checkedFutureDate(rawFrom, "検索開始日時") : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const days = Math.max(1, Math.min(30, Number(args.days || 14) || 14));
    const durationMinutes = [30, 60].includes(Number(args.duration_minutes)) ? Number(args.duration_minutes) : 30;
    const result = await this.postIntegration(calendarWebhookUrl, {
      event: "calendar.availability",
      from,
      days,
      duration_minutes: durationMinutes,
      max_slots: 6
    });
    if (result.ok === false) return { ok: false, error: "Googleカレンダーの空き時間を確認できませんでした" };
    const slots = Array.isArray(result.slots)
      ? result.slots.filter((slot): slot is string => typeof slot === "string" && !Number.isNaN(new Date(slot).getTime())).slice(0, 6)
      : [];
    return slots.length
      ? { ok: true, timezone: "Asia/Tokyo", duration_minutes: durationMinutes, slots }
      : { ok: false, error: "指定期間に案内できる空き時間がありません" };
  }

  private async integrationUrl(id: "crm" | "calendar" | "team_chat" | "sheets", environmentUrl?: string): Promise<string> {
    if (environmentUrl) return environmentUrl;
    try {
      const row = await this.env.DB.prepare(`SELECT endpoint_url FROM integration_settings
        WHERE id = ? AND enabled = 1 LIMIT 1`)
        .bind(id)
        .first<{ endpoint_url: string }>();
      return row?.endpoint_url || "";
    } catch {
      return "";
    }
  }

  private async takeMessage(call: CallRecord, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    call.contactName = textArgument(args, "contact_name", 100) || call.contactName || "未確認";
    call.phone = textArgument(args, "callback_number", 50) || call.phone || "不明";
    call.purpose = textArgument(args, "purpose", 200) || call.purpose || "受付";
    call.summary = textArgument(args, "summary", 3000) || "伝言を受け付けました";
    const urgency = textArgument(args, "urgency", 20);
    call.urgency = ["low", "normal", "high"].includes(urgency) ? urgency as CallRecord["urgency"] : "normal";
    await saveCall(this.env.DB, call);
    await this.writeAudit("call.message_saved", "call", call.id, {
      campaignId: this.campaignId(call),
      leadId: this.campaignLeadId(call),
      purpose: call.purpose
    });
    return { ok: true, message: "伝言を保存しました" };
  }

  private async saveCallOutcome(call: CallRecord, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const disposition = textArgument(args, "disposition", 80);
    if (!(CALL_DISPOSITIONS as readonly string[]).includes(disposition)) {
      throw new Error("通話結果を確認できませんでした");
    }
    const note = textArgument(args, "note", 1000);
    if (disposition === "do_not_call") {
      return this.markDoNotCall(call, { reason: note || "今後の架電停止を希望" });
    }
    const rawCallbackAt = textArgument(args, "callback_at", 100);
    const callbackAt = rawCallbackAt ? checkedFutureDate(rawCallbackAt, "折り返し日時") : null;
    if (disposition === "callback" && !callbackAt) {
      throw new Error("折り返し日時を復唱確認してから保存してください");
    }
    const email = checkedEmail(textArgument(args, "email", 254));
    call.disposition = disposition;
    call.dispositionNote = note;
    call.callbackAt = callbackAt || undefined;
    if (email) call.contactEmail = email;
    await saveCall(this.env.DB, call);
    await this.updateLeadOutcome(call, disposition, note, callbackAt);
    await this.writeAudit("call.outcome_saved", "call", call.id, {
      disposition,
      note,
      callbackAt,
      email,
      campaignId: this.campaignId(call),
      leadId: this.campaignLeadId(call)
    });
    return { ok: true, message: "通話結果を保存しました", disposition, callback_at: callbackAt, email };
  }

  private async markDoNotCall(call: CallRecord, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reason = textArgument(args, "reason", 500);
    if (!reason) throw new Error("架電停止の理由を確認できませんでした");
    const phone = canonicalJapanesePhone(this.input?.context.phone || "") || canonicalJapanesePhone(call.phone);
    if (!phone) throw new Error("架電停止へ登録できる電話番号を確認できませんでした");
    const now = new Date().toISOString();
    const campaignId = this.campaignId(call);
    const leadId = this.campaignLeadId(call);
    await this.env.DB.prepare(`INSERT INTO do_not_call_entries
      (phone, reason, source, campaign_id, lead_id, created_by_token_id, created_at, updated_at)
      VALUES (?, ?, 'ai_call', ?, ?, NULL, ?, ?)
      ON CONFLICT(phone) DO UPDATE SET reason = excluded.reason, source = excluded.source,
      campaign_id = excluded.campaign_id, lead_id = excluded.lead_id, updated_at = excluded.updated_at`)
      .bind(phone, reason, campaignId, leadId, now, now)
      .run();
    await this.env.DB.prepare(`UPDATE outbound_campaign_leads
      SET status = 'blocked', disposition = 'do_not_call', disposition_note = ?,
      callback_at = NULL, next_attempt_at = NULL, updated_at = ?
      WHERE phone = ? AND status = 'queued'`)
      .bind(reason, now, phone)
      .run();
    call.disposition = "do_not_call";
    call.dispositionNote = reason;
    call.doNotCall = true;
    call.doNotCallReason = reason;
    call.callbackAt = undefined;
    await saveCall(this.env.DB, call);
    await this.updateLeadOutcome(call, "do_not_call", reason, null);
    await this.writeAudit("dnc.created", "phone", phone, {
      callId: call.id,
      campaignId,
      leadId,
      reason,
      source: "ai_call"
    });
    return { ok: true, message: "今後この番号へ架電しないよう登録しました", phone };
  }

  private async scheduleAppointment(call: CallRecord, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const startsAt = checkedFutureDate(textArgument(args, "starts_at", 100), "予約日時");
    const notes = textArgument(args, "notes", 1000);
    const email = checkedEmail(textArgument(args, "email", 254)) || call.contactEmail || "";
    const campaignId = this.campaignId(call);
    const leadId = this.campaignLeadId(call);
    const existing = await this.env.DB.prepare(`SELECT id, external_id FROM appointments
      WHERE call_id = ? AND starts_at = ? AND status IN ('requested', 'confirmed') LIMIT 1`)
      .bind(call.id, startsAt)
      .first<{ id: string; external_id: string | null }>();
    const appointmentId = existing?.id || `appointment_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    let externalId = existing?.external_id || "";
    let externalSync: "not_configured" | "sent" | "failed" = "not_configured";
    let externalError = "";
    const calendarWebhookUrl = await this.integrationUrl("calendar", this.env.CALENDAR_WEBHOOK_URL);
    if (calendarWebhookUrl && !externalId) {
      try {
        const result = await this.postIntegration(calendarWebhookUrl, {
          id: appointmentId,
          call_id: call.id,
          campaign_id: campaignId,
          lead_id: leadId,
          contact_name: call.contactName || "未確認",
          phone: canonicalJapanesePhone(call.phone) || call.phone.slice(0, 50),
          email,
          starts_at: startsAt,
          duration_minutes: 30,
          status: "requested",
          notes,
          external_id: null,
          created_at: now,
          updated_at: now,
          event: "appointment.created"
        });
        if (result.ok === false) {
          const alternatives = Array.isArray(result.alternatives)
            ? result.alternatives.filter((slot): slot is string => typeof slot === "string").slice(0, 4)
            : [];
          return {
            ok: false,
            error: "その時間は直前に予定が入りました。別の空き時間を選んでください",
            alternatives,
            timezone: "Asia/Tokyo"
          };
        }
        externalId = textArgument(result, "external_id", 255) || textArgument(result, "id", 255);
        if (!externalId) throw new Error("カレンダー予定の識別子を確認できませんでした");
        externalSync = "sent";
      } catch (error) {
        externalSync = "failed";
        externalError = error instanceof Error ? error.message.slice(0, 500) : "カレンダー連携に失敗しました";
        console.error(JSON.stringify({ level: "error", event: "calendar_webhook_failed", appointmentId, error: externalError }));
      }
    }
    if (!existing) {
      await this.env.DB.prepare(`INSERT INTO appointments
        (id, call_id, campaign_id, lead_id, contact_name, phone, email, starts_at, status,
         notes, external_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`) 
        .bind(
          appointmentId,
          call.id,
          campaignId,
          leadId,
          call.contactName || "未確認",
          canonicalJapanesePhone(call.phone) || call.phone.slice(0, 50),
          email,
          startsAt,
          externalId ? "confirmed" : "requested",
          notes,
          externalId || null,
          now,
          now
        )
        .run();
    } else if (externalId && !existing.external_id) {
      await this.env.DB.prepare("UPDATE appointments SET external_id = ?, status = 'confirmed', updated_at = ? WHERE id = ?")
        .bind(externalId, now, appointmentId)
        .run();
    }
    call.disposition = "appointment";
    call.dispositionNote = notes;
    call.appointmentId = appointmentId;
    call.appointmentStartsAt = startsAt;
    if (email) call.contactEmail = email;
    await saveCall(this.env.DB, call);
    await this.updateLeadOutcome(call, "appointment", notes, null);
    await this.writeAudit("appointment.created", "appointment", appointmentId, {
      callId: call.id,
      campaignId,
      leadId,
      startsAt,
      email,
      deduplicated: Boolean(existing)
    });
    if (externalSync === "sent") await this.writeAudit("appointment.webhook_sent", "appointment", appointmentId, { externalId });
    if (externalSync === "failed") await this.writeAudit("appointment.webhook_failed", "appointment", appointmentId, { error: externalError });
    return {
      ok: true,
      message: externalSync === "failed"
        ? "予約希望は保存しました。外部カレンダーへの反映は担当者が確認します"
        : "予約を登録しました",
      appointment_id: appointmentId,
      starts_at: startsAt,
      external_id: externalId || null,
      external_sync: externalSync
    };
  }

  private async transferToHuman(call: CallRecord, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const reason = textArgument(args, "reason", 500);
    if (!reason) throw new Error("有人転送の理由を確認できませんでした");
    const terminal = new Set(["completed", "failed", "no-answer", "busy", "canceled"]);
    if (!call.twilioSid || terminal.has(call.status)) throw new Error("現在の通話を転送できません");
    const settings = await getSettings(this.env.DB);
    const destination = japanesePhoneToE164(settings.escalationNumber || "");
    if (!destination) throw new Error("有人転送先が設定されていません");
    if (!this.env.TWILIO_ACCOUNT_SID || !this.env.TWILIO_AUTH_TOKEN) {
      throw new Error("電話転送の接続設定が完了していません");
    }
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial answerOnBridge="true">${xmlEscape(destination)}</Dial></Response>`;
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.env.TWILIO_ACCOUNT_SID)}/Calls/${encodeURIComponent(call.twilioSid)}.json`,
      {
        method: "POST",
        headers: {
          authorization: `Basic ${btoa(`${this.env.TWILIO_ACCOUNT_SID}:${this.env.TWILIO_AUTH_TOKEN}`)}`,
          "content-type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({ Twiml: twiml })
      }
    );
    if (!response.ok) {
      const payload: { message?: string } = await response.json<{ message?: string }>().catch(() => ({}));
      throw new Error(String(payload.message || `電話転送に失敗しました (${response.status})`).slice(0, 500));
    }
    call.disposition = "connected";
    call.dispositionNote = reason;
    call.transferredAt = new Date().toISOString();
    call.transferReason = reason;
    await saveCall(this.env.DB, call);
    await this.updateLeadOutcome(call, "connected", `有人転送: ${reason}`.slice(0, 1000), null);
    await this.writeAudit("call.transferred", "call", call.id, {
      campaignId: this.campaignId(call),
      leadId: this.campaignLeadId(call),
      reason,
      destination
    });
    return { ok: true, message: "担当者への転送を開始しました" };
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.input) throw new Error("通話情報を確認できませんでした");
    const call = await getCall(this.env.DB, this.input.context.localId);
    if (!call) throw new Error("通話情報を確認できませんでした");
    switch (name) {
      case "take_message": return this.takeMessage(call, args);
      case "save_call_outcome": return this.saveCallOutcome(call, args);
      case "mark_do_not_call": return this.markDoNotCall(call, args);
      case "check_calendar_availability": return this.checkCalendarAvailability(args);
      case "schedule_appointment": return this.scheduleAppointment(call, args);
      case "transfer_to_human": return this.transferToHuman(call, args);
      default: throw new Error("対応していない操作です");
    }
  }

  private sendToolResult(id: string, name: string, result: Record<string, unknown>): void {
    const output = JSON.stringify(result);
    if (this.input?.protocol === "live") {
      this.socket?.send(JSON.stringify({
        type: "response.item.create",
        event_id: `tool_result_${crypto.randomUUID()}`,
        item: { type: "function_call_output", call_id: id, output }
      }));
      this.socket?.send(JSON.stringify({ type: "response.create", event_id: `continue_${crypto.randomUUID()}` }));
      return;
    }
    this.socket?.send(JSON.stringify({
      type: "conversation.item.create",
      item: { type: "function_call_output", call_id: id, output }
    }));
    const instruction = result.ok === false
      ? "操作を完了できなかったことを簡潔に伝え、必要であれば担当者からの折り返しを提案してください。"
      : name === "mark_do_not_call"
      ? "今後の架電停止を登録したことを伝え、謝意を述べて丁寧に通話を終了してください。"
      : name === "schedule_appointment"
      ? "ツール結果のメッセージに従い、予約または予約希望を復唱して案内してください。"
      : name === "check_calendar_availability"
      ? "返された空き時間を日本時間で一つずつ、最大三候補まで案内してください。空きがない場合は担当者からの折り返しを提案してください。"
      : name === "transfer_to_human"
      ? "担当者へ転送することを短く伝えてください。"
      : name === "take_message"
      ? "伝言を確かに承ったことを伝え、ほかに用件がなければ丁寧に通話を終了してください。"
      : "保存した事実を自然に確認し、会話を続けてください。";
    this.socket?.send(JSON.stringify({ type: "response.create", response: { instructions: instruction } }));
  }

  private async handleTool(id?: string, name?: string, rawArgs?: string): Promise<void> {
    if (!id || !name || !CALL_TOOL_NAMES.has(name) || this.handledTools.has(id) || !this.input) return;
    this.handledTools.add(id);
    let result: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawArgs || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("操作内容を確認できませんでした");
      result = await this.executeTool(name, parsed as Record<string, unknown>);
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "操作を完了できませんでした";
      result = { ok: false, error: message };
      console.error(JSON.stringify({ level: "error", event: "ai_call_tool_failed", name, callId: this.input.context.localId, error: message }));
    }
    this.sendToolResult(id, name, result);
  }

  private async finish(status: string, monitorError?: string): Promise<void> {
    await this.flushLiveTranscript("caller");
    await this.flushLiveTranscript("agent");
    const row = this.ctx.storage.sql.exec<{ local_id: string; started_at: number; status: string }>(
      "SELECT local_id, started_at, status FROM session_state WHERE id = 1"
    ).toArray()[0];
    if (!row || ["completed", "failed"].includes(row.status)) return;
    this.ctx.storage.sql.exec("UPDATE session_state SET status = ? WHERE id = 1", status);
    this.socket = null;
    let call = await getCall(this.env.DB, row.local_id);
    if (!call) return;
    const callId = call.id;
    call.status = status;
    call.duration = Math.max(1, Math.round((Date.now() - row.started_at) / 1000));
    call.endedAt = new Date().toISOString();
    if (monitorError) call.monitorError = monitorError;
    if (callNeedsSummary(call)) {
      try {
        call = await summarizeCallTranscript(this.env, call);
        console.log(JSON.stringify({ level: "info", event: "call_summary_created", callId: call.id }));
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 500) : "通話要約に失敗しました";
        call.monitorError = [call.monitorError, message].filter(Boolean).join(" / ").slice(0, 500);
        console.error(JSON.stringify({ level: "error", event: "call_summary_failed", callId: call.id, error: message }));
      }
    }
    await saveCall(this.env.DB, call);
    if (call.finalNotificationStatus !== "sent") {
      try {
        await sendCallNotification(this.env, call);
        call = (await patchCall(this.env.DB, call.id, {
          finalNotificationStatus: "sent",
          finalNotificationSentAt: new Date().toISOString(),
          finalNotificationError: undefined
        })) || call;
        console.log(JSON.stringify({ level: "info", event: "call_final_notification_sent", callId: call.id, direction: call.direction }));
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 500) : "メール通知に失敗しました";
        await patchCall(this.env.DB, call.id, {
          finalNotificationStatus: "failed",
          finalNotificationError: message
        }).catch((patchError) => {
          console.error(JSON.stringify({
            level: "error",
            event: "call_final_notification_status_save_failed",
            callId,
            error: patchError instanceof Error ? patchError.message.slice(0, 500) : "通知状態の保存に失敗しました"
          }));
        });
        console.error(JSON.stringify({ level: "error", event: "call_final_notification_failed", callId: call.id, direction: call.direction, error: message }));
      }
    }

    const crmWebhookUrl = await this.integrationUrl("crm", this.env.CRM_WEBHOOK_URL);
    if (crmWebhookUrl) {
      try {
        call = (await getCall(this.env.DB, call.id)) || call;
        await this.postIntegration(crmWebhookUrl, { ...call, event: "call.completed" });
        await patchCall(this.env.DB, call.id, { crmWebhookStatus: "sent", crmWebhookError: undefined });
        await this.writeAudit("call.crm_webhook_sent", "call", call.id, { direction: call.direction });
        console.log(JSON.stringify({ level: "info", event: "crm_webhook_sent", callId: call.id }));
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 500) : "CRM連携に失敗しました";
        await patchCall(this.env.DB, call.id, { crmWebhookStatus: "failed", crmWebhookError: message }).catch(() => {});
        await this.writeAudit("call.crm_webhook_failed", "call", call.id, { error: message });
        console.error(JSON.stringify({ level: "error", event: "crm_webhook_failed", callId: call.id, error: message }));
      }
    }
    for (const destination of ["team_chat", "sheets"] as const) {
      const endpoint = await this.integrationUrl(destination);
      if (!endpoint) continue;
      try {
        call = (await getCall(this.env.DB, call.id)) || call;
        await this.postIntegration(endpoint, { ...call, event: "call.completed", destination });
        await this.writeAudit(`call.${destination}_webhook_sent`, "call", call.id, { direction: call.direction });
      } catch (error) {
        console.error(JSON.stringify({ level: "error", event: `${destination}_webhook_failed`, callId: call.id,
          error: error instanceof Error ? error.message.slice(0, 500) : "外部連携に失敗しました" }));
      }
    }
  }
}
