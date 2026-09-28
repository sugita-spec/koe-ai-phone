import { CallSession } from "./call-session";
import {
  assignCampaignVariant,
  calculateNextRetryAt,
  classifyCallOutcome,
  ensureCampaignOperationsSchema,
  hashAccessToken,
  hasRolePermission,
  isRetryableCallStatus,
  normalizeIntegrationEndpoint,
  normalizeDisposition,
  type TeamRole
} from "./campaign-operations";
import {
  DEFAULT_SETTINGS,
  DEFAULT_VOICE,
  SALES_VOICE_CLIP_DEFINITIONS,
  buildLiveSession,
  buildOpeningInstruction,
  buildRealtimeSession,
  demoCalls,
  ensureSchema,
  getCall,
  getSettings,
  getVoice,
  isAuthorized,
  isDemo,
  isOutboundSalesWindow,
  listCalls,
  makeInboundTwiml,
  makeOutboundTwiml,
  normalizeJapaneseDomestic,
  normalizeJapanesePhone,
  patchCall,
  sanitizeSettings,
  safeDecodeURIComponent,
  saveAppState,
  saveCall,
  sendCallNotification,
  callNeedsSummary,
  summarizeCallTranscript,
  shouldRejectWebhook,
  verifyOpenAIWebhook,
  verifyTwilioWebhook,
  type CallContext,
  type CallRecord,
  type Settings,
  type VoiceState,
  type WorkerEnv
} from "./worker-lib";

export { CallSession };

const MAX_JSON = 1_000_000;
const MAX_AUDIO = 11 * 1024 * 1024;
const MAX_GREETING_AUDIO = 2 * 1024 * 1024;
const GREETING_KEY = "greeting.wav";
const MAX_CAMPAIGN_CONTACTS = 500;

interface CampaignContactInput {
  companyName?: unknown;
  contactName?: unknown;
  phone?: unknown;
  note?: unknown;
  industry?: unknown;
  companySize?: unknown;
  source?: unknown;
}

interface CampaignLeadRow {
  id: string;
  campaign_id: string;
  company_name: string;
  contact_name: string;
  phone: string;
  note: string;
  purpose: string;
  script: string;
  service_id: string;
  service_name: string;
  seller_name: string;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  disposition: string;
  variant: "A" | "B";
  variant_b_script: string;
  retry_minutes: number;
  voicemail_action: "retry" | "leave_message" | "end";
  daily_limit: number;
  max_concurrency: number;
  pace_seconds: number;
  start_hour: number;
  end_hour: number;
  allowed_weekdays: string;
  transfer_number: string;
}

interface SalesServiceRow {
  id: string;
  name: string;
  seller_name: string;
  purpose: string;
  description: string;
  script: string;
}

interface RequestActor {
  tokenId: string;
  label: string;
  role: TeamRole;
}

function salesVoiceClip(serviceId: string, clipId: string) {
  return SALES_VOICE_CLIP_DEFINITIONS.find((clip) => clip.serviceId === serviceId && clip.id === clipId);
}

function salesVoiceClipKey(serviceId: string, clipId: string, version: string): string {
  return `sales-voice/${serviceId}/${clipId}/${version}.wav`;
}

class HttpError extends Error {
  constructor(message: string, readonly status = 500, readonly details?: unknown) {
    super(message);
  }
}

function json(payload: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(payload, {
    status,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers
    }
  });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const body = await readBoundedText(request, MAX_JSON);
  try { return JSON.parse(body || "{}") as Record<string, unknown>; }
  catch { throw new HttpError("invalid_json", 400); }
}

async function readBoundedText(request: Request, limit: number): Promise<string> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > limit) throw new HttpError("request_too_large", 413);
  const body = await request.text();
  if (new TextEncoder().encode(body).length > limit) throw new HttpError("request_too_large", 413);
  return body;
}

async function readAudio(request: Request): Promise<ArrayBuffer> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_AUDIO) throw new HttpError("音声ファイルは11MB以下にしてください", 413);
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_AUDIO) throw new HttpError("音声ファイルは11MB以下にしてください", 413);
  if (!raw.byteLength) throw new HttpError("録音するか、音声ファイルを選択してください", 400);
  return raw;
}

async function readGreetingAudio(request: Request): Promise<ArrayBuffer> {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_GREETING_AUDIO) throw new HttpError("案内音声は2MB以下にしてください", 413);
  const raw = await request.arrayBuffer();
  if (!raw.byteLength) throw new HttpError("録音するか、音声ファイルを選択してください", 400);
  if (raw.byteLength > MAX_GREETING_AUDIO) throw new HttpError("案内音声は2MB以下にしてください", 413);
  const bytes = new Uint8Array(raw);
  const marker = (offset: number) => String.fromCharCode(...bytes.slice(offset, offset + 4));
  if (raw.byteLength < 44 || marker(0) !== "RIFF" || marker(8) !== "WAVE") {
    throw new HttpError("音声をWAV形式に変換できませんでした。サイトで録音し直してください", 415);
  }
  return raw;
}

function decodedHeader(request: Request, name: string, fallback: string, limit: number): string {
  return safeDecodeURIComponent(request.headers.get(name) || fallback, limit);
}

function useLiveVoiceApi(env: WorkerEnv): boolean {
  return !isDemo(env) || env.VOICE_LIVE_MODE === "true";
}

async function openAI(env: WorkerEnv, pathname: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  if (!env.OPENAI_API_KEY) throw new HttpError("OPENAI_API_KEY が未設定です", 503);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${env.OPENAI_API_KEY}`);
  const response = await fetch(`https://api.openai.com${pathname}`, { ...init, headers });
  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try { payload = text ? JSON.parse(text) as Record<string, unknown> : {}; }
  catch { payload = { message: text }; }
  if (!response.ok) {
    const apiError = payload.error as Record<string, unknown> | undefined;
    throw new HttpError(String(apiError?.message || payload.message || `OpenAI API error (${response.status})`), response.status, payload);
  }
  return payload;
}

function bearerToken(request: Request): string {
  return request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() || "";
}

async function authenticateRequest(request: Request, env: WorkerEnv): Promise<RequestActor | null> {
  if (isDemo(env)) return { tokenId: "demo", label: "デモ管理者", role: "admin" };
  if (await isAuthorized(request, env)) return { tokenId: "root", label: "管理者", role: "admin" };
  const supplied = bearerToken(request);
  if (!supplied) return null;
  const tokenHash = await hashAccessToken(supplied);
  const row = await env.DB.prepare(`SELECT id, name, role FROM team_access_tokens
    WHERE token_hash = ? AND active = 1 AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`)
    .bind(tokenHash, new Date().toISOString()).first<{ id: string; name: string; role: TeamRole }>();
  if (!row) return null;
  await env.DB.prepare("UPDATE team_access_tokens SET last_used_at = ?, updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), new Date().toISOString(), row.id).run();
  return { tokenId: row.id, label: row.name, role: row.role };
}

function accessDenied(env: WorkerEnv, authenticated: boolean): Response {
  if (!authenticated && !isDemo(env) && !env.ADMIN_TOKEN) {
    return json({ error: "本番モードでは ADMIN_TOKEN の設定が必要です" }, 503);
  }
  return json({ error: authenticated ? "この操作を行う権限がありません" : "社内パスワードが必要です" }, authenticated ? 403 : 401,
    authenticated ? {} : { "www-authenticate": "Bearer" });
}

async function writeAudit(
  db: D1Database,
  actor: RequestActor | null,
  action: string,
  entityType: string,
  entityId: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await db.prepare(`INSERT INTO audit_log
    (id, actor_token_id, actor_label, action, entity_type, entity_id, metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(`audit_${crypto.randomUUID()}`, actor?.tokenId || "system", actor?.label || "system", action,
      entityType, entityId, JSON.stringify(metadata).slice(0, 8000), new Date().toISOString()).run();
}

async function listDncEntries(db: D1Database): Promise<Array<Record<string, unknown>>> {
  const result = await db.prepare(`SELECT phone, reason, source, campaign_id AS campaignId,
    lead_id AS leadId, created_at AS createdAt, updated_at AS updatedAt
    FROM do_not_call_entries ORDER BY updated_at DESC LIMIT 200`).all<Record<string, unknown>>();
  return result.results;
}

async function listAppointments(db: D1Database): Promise<Array<Record<string, unknown>>> {
  const result = await db.prepare(`SELECT id, call_id AS callId, campaign_id AS campaignId,
    lead_id AS leadId, phone, contact_name AS contactName, email, starts_at AS startsAt,
    timezone, duration_minutes AS durationMinutes, status, external_id AS externalId,
    notes, created_at AS createdAt, updated_at AS updatedAt
    FROM appointments ORDER BY starts_at DESC, created_at DESC LIMIT 200`).all<Record<string, unknown>>();
  return result.results;
}

async function listOperationTasks(db: D1Database): Promise<Array<Record<string, unknown>>> {
  const result = await db.prepare(`SELECT id, title, kind, due_at AS dueAt, status,
    related_call_id AS relatedCallId, related_lead_id AS relatedLeadId,
    assigned_to AS assignedTo, notes, created_at AS createdAt, updated_at AS updatedAt
    FROM operation_tasks ORDER BY status, COALESCE(due_at, '9999-12-31'), created_at DESC LIMIT 300`)
    .all<Record<string, unknown>>();
  return result.results;
}

async function listInboundRules(db: D1Database): Promise<Array<Record<string, unknown>>> {
  const result = await db.prepare(`SELECT id, name, enabled, priority,
    condition_type AS conditionType, condition_value AS conditionValue,
    action_type AS actionType, action_value AS actionValue,
    created_at AS createdAt, updated_at AS updatedAt
    FROM inbound_rules ORDER BY priority, created_at`).all<Record<string, unknown>>();
  return result.results.map((row) => ({ ...row, enabled: Boolean(row.enabled) }));
}

async function listOperationalLeads(db: D1Database): Promise<Array<Record<string, unknown>>> {
  const result = await db.prepare(`SELECT l.id, l.campaign_id AS campaignId, c.name AS campaignName,
    l.company_name AS companyName, l.contact_name AS contactName, l.phone, l.note,
    l.status, l.disposition, l.disposition_note AS dispositionNote, l.callback_at AS callbackAt,
    l.attempt_count AS attemptCount, l.max_attempts AS maxAttempts, l.next_attempt_at AS nextAttemptAt,
    l.last_call_status AS lastCallStatus, l.variant, l.industry, l.company_size AS companySize,
    l.source, l.call_id AS callId, l.created_at AS createdAt, l.updated_at AS updatedAt
    FROM outbound_campaign_leads l JOIN outbound_campaigns c ON c.id = l.campaign_id
    ORDER BY l.updated_at DESC LIMIT 500`).all<Record<string, unknown>>();
  return result.results;
}

async function listTeamMembers(db: D1Database): Promise<Array<Record<string, unknown>>> {
  const result = await db.prepare(`SELECT id, name, role, active, expires_at AS expiresAt,
    last_used_at AS lastUsedAt, created_at AS createdAt
    FROM team_access_tokens WHERE active = 1 ORDER BY created_at DESC LIMIT 100`).all<Record<string, unknown>>();
  return result.results.map((row) => ({ ...row, active: Boolean(row.active) }));
}

async function getIntegrationSettings(db: D1Database): Promise<Record<string, unknown>> {
  const result = await db.prepare(`SELECT id, enabled, endpoint_url, config_json
    FROM integration_settings WHERE id IN ('crm', 'calendar', 'sms', 'team_chat', 'sheets')`).all<{
      id: string; enabled: number; endpoint_url: string; config_json: string;
    }>();
  const rows = new Map(result.results.map((row) => [row.id, row]));
  const smsConfig = (() => {
    try { return JSON.parse(rows.get("sms")?.config_json || "{}") as Record<string, unknown>; }
    catch { return {}; }
  })();
  return {
    crmWebhookUrl: rows.get("crm")?.endpoint_url || "",
    crmEnabled: Boolean(rows.get("crm")?.enabled),
    calendarWebhookUrl: rows.get("calendar")?.endpoint_url || "",
    calendarEnabled: Boolean(rows.get("calendar")?.enabled),
    teamChatWebhookUrl: rows.get("team_chat")?.endpoint_url || "",
    teamChatEnabled: Boolean(rows.get("team_chat")?.enabled),
    sheetsWebhookUrl: rows.get("sheets")?.endpoint_url || "",
    sheetsEnabled: Boolean(rows.get("sheets")?.enabled),
    followupSmsEnabled: Boolean(rows.get("sms")?.enabled) && smsConfig.followup !== false
  };
}

async function getCampaignAnalytics(db: D1Database): Promise<Record<string, unknown>> {
  const totals = await db.prepare(`SELECT COUNT(*) AS total,
    SUM(CASE WHEN attempt_count > 0 THEN 1 ELSE 0 END) AS attempted,
    SUM(CASE WHEN disposition IN ('connected','interested','callback','appointment') THEN 1 ELSE 0 END) AS connected,
    SUM(CASE WHEN disposition = 'interested' THEN 1 ELSE 0 END) AS interested,
    SUM(CASE WHEN disposition = 'appointment' THEN 1 ELSE 0 END) AS appointments,
    SUM(CASE WHEN disposition = 'do_not_call' THEN 1 ELSE 0 END) AS dnc,
    SUM(CASE WHEN disposition = 'voicemail' THEN 1 ELSE 0 END) AS voicemail,
    SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
    FROM outbound_campaign_leads`).first<Record<string, unknown>>();
  const variants = await db.prepare(`SELECT variant, COUNT(*) AS total,
    SUM(CASE WHEN disposition IN ('connected','interested','callback','appointment') THEN 1 ELSE 0 END) AS connected,
    SUM(CASE WHEN disposition = 'appointment' THEN 1 ELSE 0 END) AS appointments,
    SUM(CASE WHEN disposition = 'do_not_call' THEN 1 ELSE 0 END) AS dnc
    FROM outbound_campaign_leads GROUP BY variant ORDER BY variant`).all<Record<string, unknown>>();
  const total = Number(totals?.total || 0);
  const attempted = Number(totals?.attempted || 0);
  const connected = Number(totals?.connected || 0);
  const appointments = Number(totals?.appointments || 0);
  return {
    total,
    attempted,
    connected,
    interested: Number(totals?.interested || 0),
    appointments,
    dnc: Number(totals?.dnc || 0),
    voicemail: Number(totals?.voicemail || 0),
    failed: Number(totals?.failed || 0),
    connectionRate: attempted ? Math.round(connected / attempted * 1000) / 10 : 0,
    appointmentRate: connected ? Math.round(appointments / connected * 1000) / 10 : 0,
    variants: variants.results.map((row) => ({
      variant: row.variant || "A",
      total: Number(row.total || 0),
      connected: Number(row.connected || 0),
      appointments: Number(row.appointments || 0),
      dnc: Number(row.dnc || 0)
    }))
  };
}

async function publicState(env: WorkerEnv, actor?: RequestActor): Promise<Record<string, unknown>> {
  const [settings, voice, storedCalls, campaigns, salesServices, salesVoiceClipDefinitions, salesVoiceClips, dnc, appointments, analytics, integrations, teamMembers, leads, tasks, inboundRules] = await Promise.all([
    getSettings(env.DB), getVoice(env.DB), listCalls(env.DB), listCampaigns(env.DB), listSalesServices(env.DB),
    listSalesVoiceClipDefinitions(env.DB), listSalesVoiceClips(env.DB), listDncEntries(env.DB), listAppointments(env.DB),
    getCampaignAnalytics(env.DB), getIntegrationSettings(env.DB), listTeamMembers(env.DB),
    listOperationalLeads(env.DB), listOperationTasks(env.DB), listInboundRules(env.DB)
  ]);
  return {
    settings,
    voice,
    calls: storedCalls.length ? storedCalls : (isDemo(env) ? demoCalls() : []),
    campaigns,
    salesServices,
    salesVoiceClipDefinitions,
    salesVoiceClips,
    dnc,
    appointments,
    analytics,
    integrations,
    teamMembers,
    leads,
    tasks,
    inboundRules,
    access: { role: actor?.role || "admin", name: actor?.label || "管理者" },
    system: {
      demo: isDemo(env),
      openai: Boolean(env.OPENAI_API_KEY),
      webhookSecret: Boolean(env.OPENAI_WEBHOOK_SECRET),
      project: Boolean(env.OPENAI_PROJECT_ID),
      twilio: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER),
      publicUrl: Boolean(env.PUBLIC_BASE_URL),
      cloudflare: true,
      emailNotifications: Boolean(
        (env.NOTIFICATION_WEBHOOK_URL && env.NOTIFICATION_WEBHOOK_TOKEN && env.NOTIFICATION_TO)
        || (env.EMAIL && env.NOTIFICATION_TO && env.NOTIFICATION_FROM)
      ),
      adminProtected: !isDemo(env) && Boolean(env.ADMIN_TOKEN),
      sms: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_SMS_NUMBER || env.TWILIO_PHONE_NUMBER))
    }
  };
}

async function createConsent(request: Request, env: WorkerEnv): Promise<Response> {
  const raw = await readAudio(request);
  const filename = decodedHeader(request, "x-filename", "consent.webm", 200);
  const name = decodedHeader(request, "x-name", "koe_consent", 100);
  const form = new FormData();
  form.append("name", name);
  form.append("language", (request.headers.get("x-language") || "ja").slice(0, 10));
  form.append("recording", new Blob([raw], { type: request.headers.get("content-type") || "audio/webm" }), filename);
  const live = useLiveVoiceApi(env);
  const payload = live ? await openAI(env, "/v1/audio/voice_consents", { method: "POST", body: form }) : { id: `cons_demo_${Date.now()}` };
  const settings = await getSettings(env.DB);
  const voice = { ...(await getVoice(env.DB)), consentId: String(payload.id), status: "consent_ready" } as VoiceState;
  await saveAppState(env.DB, settings, voice);
  return json({ id: payload.id, demo: !live }, 201);
}

async function createVoice(request: Request, env: WorkerEnv): Promise<Response> {
  const raw = await readAudio(request);
  const settings = await getSettings(env.DB);
  const previous = await getVoice(env.DB);
  const consentId = (request.headers.get("x-consent-id") || previous.consentId).slice(0, 200);
  if (!consentId) throw new HttpError("同意音声とサンプル音声の両方が必要です", 400);
  const filename = decodedHeader(request, "x-filename", "sample.webm", 200);
  const name = decodedHeader(request, "x-name", "my_phone_voice", 100);
  const form = new FormData();
  form.append("name", name);
  form.append("consent", consentId);
  form.append("audio_sample", new Blob([raw], { type: request.headers.get("content-type") || "audio/webm" }), filename);
  const live = useLiveVoiceApi(env);
  const payload = live ? await openAI(env, "/v1/audio/voices", { method: "POST", body: form }) : { id: `voice_demo_${Date.now()}`, name };
  const voice: VoiceState = { consentId, voiceId: String(payload.id), name: String(payload.name || name), status: "ready" };
  settings.customVoiceId = voice.voiceId;
  await saveAppState(env.DB, settings, voice);
  return json({ id: voice.voiceId, name: voice.name, demo: !live }, 201);
}

async function makeOutboundCall(input: Record<string, unknown>, env: WorkerEnv): Promise<CallRecord> {
  const twilioPhone = normalizeJapanesePhone(input.to);
  if (!twilioPhone) throw new HttpError("日本の電話番号を 090-1234-5678 や 03-1234-5678 の形式で入力してください", 400);
  const domesticPhone = normalizeJapaneseDomestic(input.to);
  const blocked = await env.DB.prepare("SELECT reason FROM do_not_call_entries WHERE phone = ? LIMIT 1")
    .bind(domesticPhone).first<{ reason: string }>();
  if (blocked) throw new HttpError(`この番号は架電停止リストに登録されています${blocked.reason ? `（${blocked.reason}）` : ""}`, 409);
  const now = new Date().toISOString();
  const call: CallRecord = {
    id: `call_${crypto.randomUUID()}`,
    direction: "outbound",
    phone: domesticPhone,
    contactName: String(input.contactName || "未登録").trim().slice(0, 100),
    purpose: String(input.purpose || "ご連絡").trim().slice(0, 200),
    script: String(input.script || "").trim().slice(0, 8000),
    summary: "架電を受け付けました",
    status: isDemo(env) ? "demo" : "queued",
    duration: 0,
    createdAt: now,
    demo: isDemo(env)
  };
  call.companyName = String(input.companyName || "").trim().slice(0, 120);
  call.sellerName = String(input.sellerName || "").trim().slice(0, 120) || undefined;
  call.serviceId = String(input.serviceId || "").trim().slice(0, 100) || undefined;
  call.serviceName = String(input.serviceName || "").trim().slice(0, 120) || undefined;
  call.campaignId = String(input.campaignId || "").trim().slice(0, 100) || undefined;
  call.campaignLeadId = String(input.campaignLeadId || "").trim().slice(0, 100) || undefined;
  call.salesCampaign = input.salesCampaign === true;
  if (call.salesCampaign && call.serviceId && env.PUBLIC_BASE_URL) {
    const automaticClip = SALES_VOICE_CLIP_DEFINITIONS.find((clip) => clip.serviceId === call.serviceId && clip.automatic);
    if (automaticClip) {
      const stored = await env.DB.prepare(`SELECT version FROM sales_voice_clips
        WHERE service_id = ? AND clip_id = ? LIMIT 1`).bind(call.serviceId, automaticClip.id).first<{ version: string }>();
      if (stored?.version) {
        call.prerecordedGreeting = true;
        call.outboundGreetingUrl = `${env.PUBLIC_BASE_URL.replace(/\/$/, "")}/media/service-voice/${encodeURIComponent(call.serviceId)}/${encodeURIComponent(automaticClip.id)}.wav?v=${encodeURIComponent(stored.version)}`;
      }
    }
  }
  await saveCall(env.DB, call);
  if (isDemo(env)) return call;

  const required: Array<keyof WorkerEnv> = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "OPENAI_PROJECT_ID", "PUBLIC_BASE_URL"];
  const missing = required.filter((key) => !env[key]);
  if (missing.length) {
    await patchCall(env.DB, call.id, { status: "failed", summary: `未設定: ${missing.join(", ")}` });
    throw new HttpError(`未設定: ${missing.join(", ")}`, 503);
  }
  const body = new URLSearchParams({
    To: twilioPhone,
    From: env.TWILIO_PHONE_NUMBER!,
    Twiml: makeOutboundTwiml(env.OPENAI_PROJECT_ID!, call, call.outboundGreetingUrl),
    StatusCallback: `${env.PUBLIC_BASE_URL!.replace(/\/$/, "")}/webhooks/twilio/status`,
    StatusCallbackMethod: "POST",
    StatusCallbackEvent: "initiated ringing answered completed"
  });
  if (call.salesCampaign) {
    const voicemailAction = String(input.voicemailAction || "retry");
    body.set("MachineDetection", voicemailAction === "leave_message" ? "DetectMessageEnd" : "Enable");
    body.set("AsyncAmd", "true");
    body.set("AsyncAmdStatusCallback", `${env.PUBLIC_BASE_URL!.replace(/\/$/, "")}/webhooks/twilio/amd`);
    body.set("AsyncAmdStatusCallbackMethod", "POST");
  }
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Calls.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });
  const payload = await response.json<Record<string, unknown>>();
  if (!response.ok) {
    await patchCall(env.DB, call.id, { status: "failed", summary: String(payload.message || "Twilioで架電に失敗しました") });
    throw new HttpError(String(payload.message || `Twilio API error (${response.status})`), response.status);
  }
  return (await patchCall(env.DB, call.id, { twilioSid: String(payload.sid), status: String(payload.status || "queued") }))!;
}

async function listSalesServices(db: D1Database): Promise<Array<Record<string, unknown>>> {
  const result = await db.prepare(`SELECT id, name, seller_name AS sellerName, purpose, description, script
    FROM sales_services WHERE active = 1 ORDER BY created_at, name`).all<Record<string, unknown>>();
  return result.results;
}

async function prepareSingleOutboundInput(input: Record<string, unknown>, db: D1Database): Promise<Record<string, unknown>> {
  const serviceId = String(input.serviceId || "").trim().slice(0, 100);
  if (!serviceId) {
    return {
      ...input,
      companyName: "",
      sellerName: "",
      serviceId: "",
      serviceName: "",
      salesCampaign: false
    };
  }
  const service = await db.prepare(`SELECT id, name, seller_name, purpose, description, script
    FROM sales_services WHERE id = ? AND active = 1 LIMIT 1`).bind(serviceId).first<SalesServiceRow>();
  if (!service) throw new HttpError("利用できる営業サービスを選択してください", 400);
  const script = await scriptWithServicePhrases(db, service.id, String(input.script || service.script));
  return {
    ...input,
    purpose: String(input.purpose || service.purpose).trim().slice(0, 200),
    script,
    companyName: service.seller_name,
    sellerName: service.seller_name,
    serviceId: service.id,
    serviceName: service.name,
    salesCampaign: true
  };
}

async function listSalesVoiceClips(db: D1Database): Promise<Array<Record<string, unknown>>> {
  const result = await db.prepare(`SELECT service_id AS serviceId, clip_id AS clipId, version, updated_at AS updatedAt
    FROM sales_voice_clips ORDER BY service_id, clip_id`).all<Record<string, unknown>>();
  return result.results;
}

async function listSalesVoiceClipDefinitions(db: D1Database): Promise<Array<Record<string, unknown>>> {
  const result = await db.prepare(`SELECT service_id AS serviceId, clip_id AS clipId, text, updated_at AS updatedAt
    FROM sales_voice_phrase_overrides ORDER BY service_id, clip_id`).all<Record<string, unknown>>();
  const overrides = new Map(result.results.map((row) => [`${row.serviceId}:${row.clipId}`, row]));
  return SALES_VOICE_CLIP_DEFINITIONS.map((definition) => {
    const override = overrides.get(`${definition.serviceId}:${definition.id}`);
    return {
      ...definition,
      defaultText: definition.text,
      text: typeof override?.text === "string" ? override.text : definition.text,
      customized: Boolean(override),
      updatedAt: override?.updatedAt || ""
    };
  });
}

async function scriptWithServicePhrases(db: D1Database, serviceId: string, baseScript: string): Promise<string> {
  const definitions = (await listSalesVoiceClipDefinitions(db))
    .filter((definition) => definition.serviceId === serviceId && !definition.automatic);
  if (!definitions.length) return baseScript.trim().slice(0, 8000);
  const phrases = definitions.map((definition) =>
    `- ${String(definition.phase)}／${String(definition.title)}: ${String(definition.text)}`).join("\n");
  return `${baseScript.trim().slice(0, 6000)}\n\n画面で設定された推奨フレーズ（状況に合わせて自然に使用する）:\n${phrases}`.slice(0, 8000);
}

async function listCampaigns(db: D1Database): Promise<Array<Record<string, unknown>>> {
  const result = await db.prepare(`SELECT c.id, c.name, c.purpose, c.status, c.created_at AS createdAt,
    c.max_attempts AS maxAttempts, c.retry_minutes AS retryMinutes,
    c.voicemail_action AS voicemailAction, c.variant_b_script AS variantBScript,
    c.canceled_at AS canceledAt, c.daily_limit AS dailyLimit,
    c.max_concurrency AS maxConcurrency, c.pace_seconds AS paceSeconds,
    c.start_hour AS startHour, c.end_hour AS endHour,
    c.allowed_weekdays AS allowedWeekdays, c.transfer_number AS transferNumber,
    m.service_id AS serviceId, m.service_name AS serviceName,
    COUNT(l.id) AS total,
    SUM(CASE WHEN l.status = 'queued' THEN 1 ELSE 0 END) AS queued,
    SUM(CASE WHEN l.status = 'calling' THEN 1 ELSE 0 END) AS calling,
    SUM(CASE WHEN l.status = 'completed' THEN 1 ELSE 0 END) AS completed,
    SUM(CASE WHEN l.status = 'failed' THEN 1 ELSE 0 END) AS failed,
    SUM(CASE WHEN l.status = 'canceled' THEN 1 ELSE 0 END) AS canceled,
    SUM(CASE WHEN l.status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
    SUM(CASE WHEN l.disposition = 'appointment' THEN 1 ELSE 0 END) AS appointments,
    SUM(CASE WHEN l.disposition = 'interested' THEN 1 ELSE 0 END) AS interested,
    SUM(CASE WHEN l.disposition = 'do_not_call' THEN 1 ELSE 0 END) AS dnc,
    SUM(CASE WHEN l.disposition = 'voicemail' THEN 1 ELSE 0 END) AS voicemail
    FROM outbound_campaigns c
    LEFT JOIN outbound_campaign_leads l ON l.campaign_id = c.id
    LEFT JOIN outbound_campaign_metadata m ON m.campaign_id = c.id
    GROUP BY c.id ORDER BY c.created_at DESC LIMIT 30`).all<Record<string, unknown>>();
  return result.results.map((row) => ({
    ...row,
    total: Number(row.total || 0),
    queued: Number(row.queued || 0),
    calling: Number(row.calling || 0),
    completed: Number(row.completed || 0),
    failed: Number(row.failed || 0),
    canceled: Number(row.canceled || 0),
    blocked: Number(row.blocked || 0),
    appointments: Number(row.appointments || 0),
    interested: Number(row.interested || 0),
    dnc: Number(row.dnc || 0),
    voicemail: Number(row.voicemail || 0)
  }));
}

async function refreshCampaignStatus(db: D1Database, campaignId: string): Promise<void> {
  const pending = await db.prepare(`SELECT COUNT(*) AS count FROM outbound_campaign_leads
    WHERE campaign_id = ? AND status IN ('queued', 'calling')`).bind(campaignId).first<{ count: number }>();
  if (Number(pending?.count || 0) === 0) {
    await db.prepare("UPDATE outbound_campaigns SET status = 'completed', updated_at = ? WHERE id = ? AND status = 'running'")
      .bind(new Date().toISOString(), campaignId).run();
  }
}

async function scheduleCampaignLeadRetry(
  db: D1Database,
  leadId: string,
  campaignId: string,
  callStatus: string,
  disposition = ""
): Promise<boolean> {
  const lead = await db.prepare(`SELECT l.attempt_count, l.max_attempts, l.status,
    c.retry_minutes, c.voicemail_action, c.status AS campaign_status
    FROM outbound_campaign_leads l JOIN outbound_campaigns c ON c.id = l.campaign_id
    WHERE l.id = ? AND l.campaign_id = ? LIMIT 1`).bind(leadId, campaignId).first<{
      attempt_count: number; max_attempts: number; status: string; retry_minutes: number;
      voicemail_action: string; campaign_status: string;
  }>();
  if (!lead || lead.campaign_status !== "running" || lead.status === "blocked" || lead.status === "canceled") return false;
  if (lead.status === "queued") return true;
  if (!isRetryableCallStatus(callStatus, disposition, lead.voicemail_action)) return false;
  if (Number(lead.attempt_count || 0) >= Number(lead.max_attempts || 1)) return false;
  const nextAttemptAt = calculateNextRetryAt(new Date(), Number(lead.retry_minutes || 60)).toISOString();
  await db.prepare(`UPDATE outbound_campaign_leads SET status = 'queued', next_attempt_at = ?,
    last_call_status = ?, disposition = CASE WHEN ? != '' THEN ? ELSE disposition END,
    error = NULL, updated_at = ? WHERE id = ?`)
    .bind(nextAttemptAt, callStatus, disposition, disposition, new Date().toISOString(), leadId).run();
  return true;
}

async function processNextCampaignLead(env: WorkerEnv): Promise<{ started: boolean; reason?: string; callId?: string }> {
  const now = new Date().toISOString();
  const stale = new Date(Date.now() - 30 * 60_000).toISOString();
  await env.DB.prepare(`UPDATE outbound_campaign_leads
    SET status = CASE WHEN attempt_count < max_attempts THEN 'queued' ELSE 'failed' END,
      next_attempt_at = CASE WHEN attempt_count < max_attempts THEN ? ELSE next_attempt_at END,
      last_call_status = 'timeout', error = '発信処理が30分以上完了しませんでした', updated_at = ?
    WHERE status = 'calling' AND updated_at < ?`).bind(now, now, stale).run();
  await env.DB.prepare(`UPDATE outbound_campaign_leads SET status = 'blocked', disposition = 'do_not_call',
    disposition_note = '全社共通の架電停止リストに登録済み', updated_at = ?
    WHERE status = 'queued' AND EXISTS (
      SELECT 1 FROM do_not_call_entries d WHERE d.phone = outbound_campaign_leads.phone
    )`).bind(now).run();
  const candidates = await env.DB.prepare(`SELECT l.id, l.campaign_id, l.company_name, l.contact_name, l.phone, l.note,
    l.attempt_count, l.max_attempts, l.next_attempt_at, l.disposition, l.variant,
    c.purpose, c.script, COALESCE(m.service_id, '') AS service_id,
    COALESCE(m.service_name, '') AS service_name, COALESCE(m.seller_name, '') AS seller_name,
    c.variant_b_script, c.retry_minutes, c.voicemail_action, c.daily_limit, c.max_concurrency,
    c.pace_seconds, c.start_hour, c.end_hour, c.allowed_weekdays, c.transfer_number
    FROM outbound_campaign_leads l
    JOIN outbound_campaigns c ON c.id = l.campaign_id
    LEFT JOIN outbound_campaign_metadata m ON m.campaign_id = c.id
    LEFT JOIN do_not_call_entries d ON d.phone = l.phone
    WHERE l.status = 'queued' AND c.status = 'running' AND d.phone IS NULL
      AND (l.next_attempt_at IS NULL OR l.next_attempt_at <= ?)
    ORDER BY c.created_at, l.row_number LIMIT 50`).bind(now).all<CampaignLeadRow>();
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", weekday: "short", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const weekday = ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as Record<string, number>)[parts.find((part) => part.type === "weekday")?.value || "Sun"];
  const hour = Number(parts.find((part) => part.type === "hour")?.value || 0);
  let lead: CampaignLeadRow | null = null;
  for (const candidate of candidates.results) {
    if (!String(candidate.allowed_weekdays || "1,2,3,4,5").split(",").map(Number).includes(weekday)) continue;
    if (hour < Number(candidate.start_hour || 10) || hour >= Number(candidate.end_hour || 19)) continue;
    const active = await env.DB.prepare("SELECT COUNT(*) AS count FROM outbound_campaign_leads WHERE campaign_id = ? AND status = 'calling'")
      .bind(candidate.campaign_id).first<{ count: number }>();
    if (Number(active?.count || 0) >= Number(candidate.max_concurrency || 1)) continue;
    const dayStart = new Date(Date.now() + 9 * 60 * 60_000); dayStart.setUTCHours(0, 0, 0, 0); dayStart.setTime(dayStart.getTime() - 9 * 60 * 60_000);
    const daily = await env.DB.prepare("SELECT COUNT(*) AS count FROM outbound_campaign_leads WHERE campaign_id = ? AND attempt_count > 0 AND updated_at >= ?")
      .bind(candidate.campaign_id, dayStart.toISOString()).first<{ count: number }>();
    if (Number(daily?.count || 0) >= Number(candidate.daily_limit || 200)) continue;
    const latest = await env.DB.prepare("SELECT MAX(updated_at) AS latest FROM outbound_campaign_leads WHERE campaign_id = ? AND attempt_count > 0")
      .bind(candidate.campaign_id).first<{ latest: string | null }>();
    if (latest?.latest && Date.now() - new Date(latest.latest).getTime() < Number(candidate.pace_seconds || 60) * 1000) continue;
    lead = candidate;
    break;
  }
  if (!lead) return { started: false, reason: "empty_queue" };
  const claimed = await env.DB.prepare(`UPDATE outbound_campaign_leads SET status = 'calling',
    attempt_count = attempt_count + 1, next_attempt_at = NULL, updated_at = ?
    WHERE id = ? AND status = 'queued'`)
    .bind(now, lead.id).run();
  if (!claimed.meta.changes) return { started: false, reason: "already_claimed" };
  try {
    const selectedScript = lead.variant === "B" && lead.variant_b_script ? lead.variant_b_script : lead.script;
    const script = [selectedScript, `この連絡先の台本パターン: ${lead.variant || "A"}`,
      lead.note ? `この連絡先の個別メモ: ${lead.note}` : ""].filter(Boolean).join("\n");
    const call = await makeOutboundCall({
      to: lead.phone,
      companyName: lead.company_name,
      contactName: lead.contact_name || "ご担当者",
      purpose: lead.purpose,
      script,
      sellerName: lead.seller_name,
      serviceId: lead.service_id,
      serviceName: lead.service_name,
      campaignId: lead.campaign_id,
      campaignLeadId: lead.id,
      voicemailAction: lead.voicemail_action,
      transferNumber: lead.transfer_number,
      salesCampaign: true
    }, env);
    const leadStatus = call.demo ? "completed" : "calling";
    await env.DB.prepare("UPDATE outbound_campaign_leads SET status = ?, call_id = ?, error = NULL, updated_at = ? WHERE id = ?")
      .bind(leadStatus, call.id, new Date().toISOString(), lead.id).run();
    if (call.demo) await refreshCampaignStatus(env.DB, lead.campaign_id);
    console.log(JSON.stringify({ level: "info", event: "campaign_call_started", campaignId: lead.campaign_id, leadId: lead.id, callId: call.id }));
    return { started: true, callId: call.id };
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : "架電に失敗しました";
    const nextAttemptAt = (Number(lead.attempt_count || 0) + 1) < Number(lead.max_attempts || 1)
      ? calculateNextRetryAt(new Date(), Number(lead.retry_minutes || 60)).toISOString()
      : null;
    await env.DB.prepare(`UPDATE outbound_campaign_leads SET status = ?, next_attempt_at = ?,
      last_call_status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
      .bind(nextAttemptAt ? "queued" : "failed", nextAttemptAt, message, new Date().toISOString(), lead.id).run();
    await refreshCampaignStatus(env.DB, lead.campaign_id);
    console.error(JSON.stringify({ level: "error", event: "campaign_call_failed", campaignId: lead.campaign_id, leadId: lead.id, error: message }));
    return { started: false, reason: message };
  }
}

async function dncPhones(db: D1Database, phones: string[]): Promise<Set<string>> {
  const blocked = new Set<string>();
  for (let offset = 0; offset < phones.length; offset += 80) {
    const chunk = phones.slice(offset, offset + 80);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => "?").join(",");
    const result = await db.prepare(`SELECT phone FROM do_not_call_entries WHERE phone IN (${placeholders})`)
      .bind(...chunk).all<{ phone: string }>();
    result.results.forEach((row) => blocked.add(row.phone));
  }
  return blocked;
}

async function createCampaign(input: Record<string, unknown>, env: WorkerEnv): Promise<Record<string, unknown>> {
  if (input.confirmed !== true) throw new HttpError("架電可能なリストであることを確認してください", 400);
  const serviceId = String(input.serviceId || "high_school_recruiting_support").trim().slice(0, 100);
  const service = await env.DB.prepare(`SELECT id, name, seller_name, purpose, description, script
    FROM sales_services WHERE id = ? AND active = 1 LIMIT 1`).bind(serviceId).first<SalesServiceRow>();
  if (!service) throw new HttpError("営業サービスを選択してください", 400);
  const name = String(input.name || "").trim().slice(0, 120);
  const purpose = String(input.purpose || service.purpose).trim().slice(0, 200);
  const script = await scriptWithServicePhrases(env.DB, service.id, String(input.script || service.script));
  const rawVariantBScript = String(input.variantBScript || "").trim();
  const variantBScript = rawVariantBScript ? await scriptWithServicePhrases(env.DB, service.id, rawVariantBScript) : "";
  const maxAttempts = Math.max(1, Math.min(5, Number(input.maxAttempts || 3) || 3));
  const retryMinutes = Math.max(5, Math.min(10_080, Number(input.retryMinutes || 60) || 60));
  const voicemailAction = ["retry", "leave_message", "end"].includes(String(input.voicemailAction || ""))
    ? String(input.voicemailAction)
    : "retry";
  const dailyLimit = Math.max(1, Math.min(5000, Number(input.dailyLimit || 200) || 200));
  const maxConcurrency = Math.max(1, Math.min(10, Number(input.maxConcurrency || 1) || 1));
  const paceSeconds = Math.max(10, Math.min(3600, Number(input.paceSeconds || 60) || 60));
  const startHour = Math.max(8, Math.min(20, Number(input.startHour ?? 10) || 10));
  const endHour = Math.max(startHour + 1, Math.min(21, Number(input.endHour ?? 19) || 19));
  const allowedWeekdays = String(input.allowedWeekdays || "1,2,3,4,5").replace(/[^0-6,]/g, "").slice(0, 20) || "1,2,3,4,5";
  const transferNumber = normalizeJapaneseDomestic(input.transferNumber) || "";
  if (!name || !purpose || !script) throw new HttpError("リスト名・営業目的・台本を入力してください", 400);
  const rawContacts = Array.isArray(input.contacts) ? input.contacts as CampaignContactInput[] : [];
  if (!rawContacts.length) throw new HttpError("電話リストに架電可能な連絡先がありません", 400);
  if (rawContacts.length > MAX_CAMPAIGN_CONTACTS) throw new HttpError(`1回の登録は${MAX_CAMPAIGN_CONTACTS}件までです`, 400);
  const seen = new Set<string>();
  const normalizedContacts = rawContacts.flatMap((item, index) => {
    const phone = normalizeJapaneseDomestic(item.phone);
    if (!phone || seen.has(phone)) return [];
    seen.add(phone);
    return [{
      rowNumber: index + 2,
      companyName: String(item.companyName || "").trim().slice(0, 120),
      contactName: String(item.contactName || "").trim().slice(0, 100),
      phone,
      note: String(item.note || "").trim().slice(0, 1000),
      industry: String(item.industry || "").trim().slice(0, 100),
      companySize: String(item.companySize || "").trim().slice(0, 100),
      source: String(item.source || "CSV").trim().slice(0, 100)
    }];
  });
  const campaignId = `campaign_${crypto.randomUUID()}`;
  const blockedPhones = await dncPhones(env.DB, normalizedContacts.map((contact) => contact.phone));
  const contacts = normalizedContacts.filter((contact) => !blockedPhones.has(contact.phone));
  if (!contacts.length) throw new HttpError(blockedPhones.size ? "すべての番号が架電停止リストに登録されています" : "有効な日本の電話番号がありません", 400);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO outbound_campaigns
      (id, name, purpose, script, status, max_attempts, retry_minutes, voicemail_action,
       variant_b_script, daily_limit, max_concurrency, pace_seconds, start_hour, end_hour,
       allowed_weekdays, transfer_number, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(campaignId, name, purpose, script, maxAttempts, retryMinutes, voicemailAction, variantBScript,
        dailyLimit, maxConcurrency, paceSeconds, startHour, endHour, allowedWeekdays, transferNumber, now, now),
    env.DB.prepare(`INSERT INTO outbound_campaign_metadata (campaign_id, service_id, service_name, seller_name)
      VALUES (?, ?, ?, ?)`).bind(campaignId, service.id, service.name, service.seller_name)
  ]);
  for (let offset = 0; offset < contacts.length; offset += 50) {
    const chunk = contacts.slice(offset, offset + 50);
    const variants = await Promise.all(chunk.map((contact) =>
      assignCampaignVariant(campaignId, `${contact.phone}:${contact.rowNumber}`, Boolean(variantBScript))));
    await env.DB.batch(chunk.map((contact, index) => env.DB.prepare(`INSERT INTO outbound_campaign_leads
      (id, campaign_id, row_number, company_name, contact_name, phone, note, status,
       max_attempts, variant, industry, company_size, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`)
      .bind(`lead_${crypto.randomUUID()}`, campaignId, contact.rowNumber, contact.companyName,
        contact.contactName, contact.phone, contact.note, maxAttempts, variants[index],
        contact.industry, contact.companySize, contact.source, now, now)));
  }
  const process = await processNextCampaignLead(env);
  return {
    id: campaignId,
    name,
    serviceId: service.id,
    serviceName: service.name,
    total: contacts.length,
    skippedDnc: blockedPhones.size,
    maxAttempts,
    retryMinutes,
    voicemailAction,
    dailyLimit,
    maxConcurrency,
    paceSeconds,
    abTest: Boolean(variantBScript),
    process
  };
}

function csvValue(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function callsCsv(calls: CallRecord[]): string {
  const header = ["着信日時", "方向", "相手名", "電話番号", "用件", "要約", "状態", "通話秒数", "会話内容"];
  const rows = calls.map((call) => [
    call.createdAt,
    call.direction === "inbound" ? "着信" : "架電",
    call.contactName,
    call.phone,
    call.purpose,
    call.summary,
    call.status,
    call.duration,
    (call.transcript || []).map((item) => `${item.role}: ${item.text}`).join("\n")
  ]);
  return `\uFEFF${[header, ...rows].map((row) => row.map(csvValue).join(",")).join("\r\n")}`;
}

function safeServiceInput(input: Record<string, unknown>): {
  name: string; sellerName: string; purpose: string; description: string; script: string;
} {
  const clean = {
    name: String(input.name || "").trim().slice(0, 120),
    sellerName: String(input.sellerName || "").trim().slice(0, 120),
    purpose: String(input.purpose || "").trim().slice(0, 240),
    description: String(input.description || "").trim().slice(0, 1000),
    script: String(input.script || "").trim().slice(0, 8000)
  };
  if (!clean.name || !clean.sellerName || !clean.purpose || !clean.description || !clean.script) {
    throw new HttpError("サービス名・発信会社名・営業目的・説明・台本を入力してください", 400);
  }
  return clean;
}

function randomAccessToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `koe_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function upsertIntegration(
  db: D1Database,
  id: "crm" | "calendar" | "sms" | "team_chat" | "sheets",
  provider: string,
  enabled: boolean,
  endpointUrl: string,
  config: Record<string, unknown>
): Promise<void> {
  const now = new Date().toISOString();
  await db.prepare(`INSERT INTO integration_settings
    (id, provider, enabled, endpoint_url, config_json, credential_ref, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, '', ?, ?)
    ON CONFLICT(id) DO UPDATE SET provider = excluded.provider, enabled = excluded.enabled,
      endpoint_url = excluded.endpoint_url, config_json = excluded.config_json, updated_at = excluded.updated_at`)
    .bind(id, provider, enabled ? 1 : 0, endpointUrl, JSON.stringify(config), now, now).run();
}

async function postTwilio(env: WorkerEnv, path: string, body: URLSearchParams): Promise<Record<string, unknown>> {
  if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) throw new HttpError("Twilio接続が未設定です", 503);
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/${path}`, {
    method: "POST",
    headers: {
      authorization: `Basic ${btoa(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`)}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });
  const payload = await response.json<Record<string, unknown>>().catch(() => ({} as Record<string, unknown>));
  if (!response.ok) throw new HttpError(String(payload.message || `Twilio API error (${response.status})`), response.status);
  return payload;
}

function appointmentIcs(appointment: Record<string, unknown>): string {
  const start = new Date(String(appointment.startsAt || ""));
  if (!Number.isFinite(start.getTime())) throw new HttpError("予約日時が不正です", 400);
  const durationMinutes = Math.max(15, Number(appointment.durationMinutes || 30));
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const escape = (value: unknown) => String(value || "").replaceAll("\\", "\\\\").replaceAll(";", "\\;").replaceAll(",", "\\,").replace(/\r?\n/g, "\\n");
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Koe AI Phone//JP", "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT", `UID:${escape(appointment.id)}@koe-ai-phone`, `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`, `DTEND:${stamp(end)}`,
    `SUMMARY:${escape(`AI電話フォロー ${appointment.contactName || appointment.phone || ""}`)}`,
    `DESCRIPTION:${escape(appointment.notes || "Koe AI電話で受け付けた予定")}`,
    `CONTACT:${escape(appointment.email || appointment.phone || "")}`,
    "END:VEVENT", "END:VCALENDAR", ""
  ].join("\r\n");
}

function escapeXml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;"
  })[character] || character);
}

async function handleApi(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const actor = await authenticateRequest(request, env);
  if (!actor) return accessDenied(env, false);
  if (request.method !== "GET") {
    const adminOnly = ["/api/settings", "/api/greeting-audio", "/api/voice/", "/api/team-members", "/api/integrations", "/api/services", "/api/calendar"]
      .some((prefix) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`));
    const requiredRole: TeamRole = adminOnly ? "admin" : "operator";
    if (!hasRolePermission(actor.role, requiredRole)) return accessDenied(env, true);
  }
  if (request.method === "GET" && url.pathname === "/api/state") return json(await publicState(env, actor));
  if (request.method === "GET" && url.pathname === "/api/health") {
    await env.DB.prepare("SELECT 1").first();
    return json({ ok: true, mode: isDemo(env) ? "demo" : "live", runtime: "cloudflare-workers" });
  }
  if (request.method === "POST" && url.pathname === "/api/tasks") {
    const input = await readJson(request);
    const title = String(input.title || "").trim().slice(0, 200);
    if (!title) throw new HttpError("タスク名を入力してください", 400);
    const dueRaw = String(input.dueAt || "").trim();
    const dueAt = dueRaw && Number.isFinite(new Date(dueRaw).getTime()) ? new Date(dueRaw).toISOString() : null;
    const kind = ["followup", "callback", "review", "appointment"].includes(String(input.kind)) ? String(input.kind) : "followup";
    const id = `task_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO operation_tasks
      (id, title, kind, due_at, status, related_call_id, related_lead_id, assigned_to, notes, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`)
      .bind(id, title, kind, dueAt, String(input.relatedCallId || "").slice(0, 120) || null,
        String(input.relatedLeadId || "").slice(0, 120) || null, String(input.assignedTo || "").trim().slice(0, 100),
        String(input.notes || "").trim().slice(0, 2000), now, now).run();
    await writeAudit(env.DB, actor, "task.created", "task", id, { title, kind });
    return json({ ok: true, tasks: await listOperationTasks(env.DB) }, 201);
  }
  const taskMatch = url.pathname.match(/^\/api\/tasks\/(task_[A-Za-z0-9_-]+)$/);
  if (request.method === "PUT" && taskMatch) {
    const input = await readJson(request);
    const status = input.status === "done" ? "done" : "open";
    const result = await env.DB.prepare("UPDATE operation_tasks SET status = ?, updated_at = ? WHERE id = ?")
      .bind(status, new Date().toISOString(), taskMatch[1]).run();
    if (!result.meta.changes) throw new HttpError("タスクが見つかりません", 404);
    await writeAudit(env.DB, actor, "task.updated", "task", taskMatch[1], { status });
    return json({ ok: true, tasks: await listOperationTasks(env.DB) });
  }
  if (request.method === "POST" && url.pathname === "/api/inbound-rules") {
    const input = await readJson(request);
    const name = String(input.name || "").trim().slice(0, 160);
    if (!name) throw new HttpError("ルール名を入力してください", 400);
    const conditionType = ["always", "business_hours", "outside_hours", "caller_prefix"].includes(String(input.conditionType)) ? String(input.conditionType) : "always";
    const actionType = ["ai_reception", "take_message", "transfer", "reject"].includes(String(input.actionType)) ? String(input.actionType) : "ai_reception";
    const id = `rule_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO inbound_rules
      (id, name, enabled, priority, condition_type, condition_value, action_type, action_value, created_at, updated_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, name, Math.max(1, Math.min(999, Number(input.priority || 100) || 100)), conditionType,
        String(input.conditionValue || "").trim().slice(0, 200), actionType,
        String(input.actionValue || "").trim().slice(0, 200), now, now).run();
    await writeAudit(env.DB, actor, "inbound_rule.created", "inbound_rule", id, { name, conditionType, actionType });
    return json({ ok: true, inboundRules: await listInboundRules(env.DB) }, 201);
  }
  const ruleMatch = url.pathname.match(/^\/api\/inbound-rules\/(rule_[A-Za-z0-9_-]+|rule_business_hours|rule_after_hours)$/);
  if (request.method === "PUT" && ruleMatch) {
    const input = await readJson(request);
    const result = await env.DB.prepare("UPDATE inbound_rules SET enabled = ?, updated_at = ? WHERE id = ?")
      .bind(input.enabled === true ? 1 : 0, new Date().toISOString(), ruleMatch[1]).run();
    if (!result.meta.changes) throw new HttpError("受電ルールが見つかりません", 404);
    await writeAudit(env.DB, actor, "inbound_rule.updated", "inbound_rule", ruleMatch[1], { enabled: input.enabled === true });
    return json({ ok: true, inboundRules: await listInboundRules(env.DB) });
  }
  if (request.method === "POST" && url.pathname === "/api/calendar/availability") {
    const integrations = await getIntegrationSettings(env.DB);
    const endpoint = String(integrations.calendarWebhookUrl || "");
    const token = env.INTEGRATION_WEBHOOK_TOKEN || env.NOTIFICATION_WEBHOOK_TOKEN || "";
    if (!integrations.calendarEnabled || !endpoint || !token) throw new HttpError("Googleカレンダー連携が未設定です", 409);
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        token,
        event: "calendar.availability",
        from: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        days: 14,
        duration_minutes: 30,
        max_slots: 6
      })
    });
    const result: Record<string, unknown> = await response.json<Record<string, unknown>>().catch(() => ({}));
    if (!response.ok || result.ok === false) {
      const detail = typeof result.detail === "string" ? result.detail.slice(0, 300) : "";
      console.error(JSON.stringify({ event: "calendar_availability_failed", status: response.status, error: result.error || "unknown", detail }));
      throw new HttpError(detail
        ? `Googleカレンダーの空き時間を取得できませんでした（${detail}）`
        : "Googleカレンダーの空き時間を取得できませんでした", 502);
    }
    const slots = Array.isArray(result.slots)
      ? result.slots.filter((slot): slot is string => typeof slot === "string" && !Number.isNaN(new Date(slot).getTime())).slice(0, 6)
      : [];
    return json({ ok: true, timezone: "Asia/Tokyo", durationMinutes: 30, slots });
  }
  if (request.method === "GET" && url.pathname === "/api/calls/export") {
    const csv = callsCsv(await listCalls(env.DB));
    return new Response(csv, {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="koe-calls-${new Date().toISOString().slice(0, 10)}.csv"`,
        "content-type": "text/csv; charset=utf-8",
        "x-content-type-options": "nosniff"
      }
    });
  }
  if (request.method === "POST" && url.pathname === "/api/dnc") {
    const input = await readJson(request);
    const phone = normalizeJapaneseDomestic(input.phone);
    if (!phone) throw new HttpError("日本の電話番号を入力してください", 400);
    const reason = String(input.reason || "ご本人から架電停止の希望").trim().slice(0, 500);
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO do_not_call_entries
        (phone, reason, source, created_by_token_id, created_at, updated_at)
        VALUES (?, ?, 'manual', ?, ?, ?)
        ON CONFLICT(phone) DO UPDATE SET reason = excluded.reason, source = excluded.source,
          created_by_token_id = excluded.created_by_token_id, updated_at = excluded.updated_at`)
        .bind(phone, reason, actor.tokenId, now, now),
      env.DB.prepare(`UPDATE outbound_campaign_leads SET status = 'blocked', disposition = 'do_not_call',
        disposition_note = ?, updated_at = ? WHERE phone = ? AND status = 'queued'`)
        .bind(reason, now, phone)
    ]);
    await writeAudit(env.DB, actor, "dnc.created", "phone", phone, { reason });
    return json({ ok: true, dnc: await listDncEntries(env.DB) }, 201);
  }
  const dncMatch = url.pathname.match(/^\/api\/dnc\/(.+)$/);
  if (request.method === "DELETE" && dncMatch) {
    const phone = normalizeJapaneseDomestic(safeDecodeURIComponent(dncMatch[1], 50));
    if (!phone) throw new HttpError("電話番号が不正です", 400);
    await env.DB.prepare("DELETE FROM do_not_call_entries WHERE phone = ?").bind(phone).run();
    await writeAudit(env.DB, actor, "dnc.deleted", "phone", phone);
    return json({ ok: true, dnc: await listDncEntries(env.DB) });
  }
  if (request.method === "PUT" && url.pathname === "/api/settings") {
    const previous = await getSettings(env.DB);
    const voice = await getVoice(env.DB);
    const settings = sanitizeSettings(await readJson(request), previous);
    if (settings.customVoiceId) Object.assign(voice, { voiceId: settings.customVoiceId, status: "ready" });
    await saveAppState(env.DB, settings, voice);
    await writeAudit(env.DB, actor, "settings.updated", "settings", "main");
    return json(await publicState(env, actor));
  }
  if (request.method === "POST" && url.pathname === "/api/outbound") {
    const input = await prepareSingleOutboundInput(await readJson(request), env.DB);
    const call = await makeOutboundCall(input, env);
    return json({ call, demo: isDemo(env) }, 201);
  }
  if (request.method === "POST" && url.pathname === "/api/campaigns") {
    const campaign = await createCampaign(await readJson(request), env);
    await writeAudit(env.DB, actor, "campaign.created", "campaign", String(campaign.id), {
      name: campaign.name, total: campaign.total, skippedDnc: campaign.skippedDnc
    });
    return json({ campaign, campaigns: await listCampaigns(env.DB) }, 201);
  }
  if (request.method === "POST" && url.pathname === "/api/campaigns/emergency-stop") {
    const input = await readJson(request);
    const now = new Date().toISOString();
    const activeRows = await env.DB.prepare(`SELECT data_json FROM calls
      WHERE json_extract(data_json, '$.campaignId') IS NOT NULL
        AND json_extract(data_json, '$.status') IN ('queued','ringing','in-progress')
      ORDER BY created_at DESC LIMIT 50`).all<{ data_json: string }>();
    await env.DB.batch([
      env.DB.prepare("UPDATE outbound_campaigns SET status = 'canceled', canceled_at = ?, updated_at = ? WHERE status IN ('running','paused')").bind(now, now),
      env.DB.prepare("UPDATE outbound_campaign_leads SET status = 'canceled', updated_at = ? WHERE status = 'queued'").bind(now)
    ]);
    let hungUp = 0;
    if (input.hangupActive === true) {
      for (const row of activeRows.results) {
        const call = JSON.parse(row.data_json) as CallRecord;
        if (!call.twilioSid) continue;
        try {
          await postTwilio(env, `Calls/${encodeURIComponent(call.twilioSid)}.json`, new URLSearchParams({ Status: "completed" }));
          hungUp += 1;
        } catch (error) {
          console.error(JSON.stringify({ level: "error", event: "emergency_hangup_failed", callId: call.id,
            error: error instanceof Error ? error.message : String(error) }));
        }
      }
    }
    await writeAudit(env.DB, actor, "campaign.emergency_stop", "campaign", "all", { hangupActive: input.hangupActive === true, hungUp });
    return json({ ok: true, hungUp, campaigns: await listCampaigns(env.DB) });
  }
  const campaignStatusMatch = url.pathname.match(/^\/api\/campaigns\/(campaign_[A-Za-z0-9_-]+)\/status$/);
  if (request.method === "POST" && campaignStatusMatch) {
    const input = await readJson(request);
    const status = String(input.status || "");
    if (!["running", "paused", "canceled"].includes(status)) throw new HttpError("状態が不正です", 400);
    const now = new Date().toISOString();
    const result = await env.DB.prepare(`UPDATE outbound_campaigns SET status = ?,
      canceled_at = CASE WHEN ? = 'canceled' THEN ? ELSE canceled_at END, updated_at = ?
      WHERE id = ? AND status NOT IN ('completed','canceled')`)
      .bind(status, status, now, now, campaignStatusMatch[1]).run();
    if (!result.meta.changes) throw new HttpError("架電リストが見つからないか、すでに完了しています", 404);
    if (status === "canceled") {
      await env.DB.prepare("UPDATE outbound_campaign_leads SET status = 'canceled', updated_at = ? WHERE campaign_id = ? AND status = 'queued'")
        .bind(now, campaignStatusMatch[1]).run();
    }
    const process = status === "running" ? await processNextCampaignLead(env) : { started: false, reason: "paused" };
    await writeAudit(env.DB, actor, `campaign.${status}`, "campaign", campaignStatusMatch[1]);
    return json({ ok: true, status, process, campaigns: await listCampaigns(env.DB) });
  }
  const campaignLeadsMatch = url.pathname.match(/^\/api\/campaigns\/(campaign_[A-Za-z0-9_-]+)\/leads$/);
  if (request.method === "GET" && campaignLeadsMatch) {
    const result = await env.DB.prepare(`SELECT id, row_number AS rowNumber, company_name AS companyName,
      contact_name AS contactName, phone, note, status, call_id AS callId, error,
      attempt_count AS attemptCount, max_attempts AS maxAttempts, next_attempt_at AS nextAttemptAt,
      last_call_status AS lastCallStatus, disposition, disposition_note AS dispositionNote,
      callback_at AS callbackAt, variant, created_at AS createdAt, updated_at AS updatedAt
      FROM outbound_campaign_leads WHERE campaign_id = ? ORDER BY row_number LIMIT 500`)
      .bind(campaignLeadsMatch[1]).all<Record<string, unknown>>();
    return json({ leads: result.results });
  }
  const leadDispositionMatch = url.pathname.match(/^\/api\/campaigns\/(campaign_[A-Za-z0-9_-]+)\/leads\/(lead_[A-Za-z0-9_-]+)\/disposition$/);
  if (request.method === "POST" && leadDispositionMatch) {
    const input = await readJson(request);
    const disposition = normalizeDisposition(input.disposition);
    const note = String(input.note || "").trim().slice(0, 1000);
    const callbackAtRaw = String(input.callbackAt || "").trim();
    const callbackAt = callbackAtRaw && Number.isFinite(new Date(callbackAtRaw).getTime()) ? new Date(callbackAtRaw).toISOString() : null;
    const status = disposition === "callback" && callbackAt ? "queued" : "completed";
    const result = await env.DB.prepare(`UPDATE outbound_campaign_leads SET disposition = ?, disposition_note = ?,
      callback_at = ?, next_attempt_at = ?, status = ?, updated_at = ? WHERE campaign_id = ? AND id = ?`)
      .bind(disposition, note, callbackAt, callbackAt, status, new Date().toISOString(), leadDispositionMatch[1], leadDispositionMatch[2]).run();
    if (!result.meta.changes) throw new HttpError("連絡先が見つかりません", 404);
    if (disposition === "do_not_call") {
      const lead = await env.DB.prepare("SELECT phone FROM outbound_campaign_leads WHERE id = ?").bind(leadDispositionMatch[2]).first<{ phone: string }>();
      if (lead?.phone) {
        const now = new Date().toISOString();
        await env.DB.prepare(`INSERT INTO do_not_call_entries
          (phone, reason, source, campaign_id, lead_id, created_by_token_id, created_at, updated_at)
          VALUES (?, ?, 'manual_result', ?, ?, ?, ?, ?)
          ON CONFLICT(phone) DO UPDATE SET reason = excluded.reason, source = excluded.source, updated_at = excluded.updated_at`)
          .bind(lead.phone, note || "架電結果から停止登録", leadDispositionMatch[1], leadDispositionMatch[2], actor.tokenId, now, now).run();
      }
    }
    await writeAudit(env.DB, actor, "lead.disposition_updated", "lead", leadDispositionMatch[2], { disposition, callbackAt });
    return json({ ok: true, disposition, status });
  }
  const appointmentStatusMatch = url.pathname.match(/^\/api\/appointments\/(appointment_[A-Za-z0-9_-]+)\/status$/);
  if (request.method === "POST" && appointmentStatusMatch) {
    const input = await readJson(request);
    const status = String(input.status || "");
    if (!["requested", "confirmed", "completed", "canceled", "no-show"].includes(status)) throw new HttpError("予約状態が不正です", 400);
    const result = await env.DB.prepare("UPDATE appointments SET status = ?, updated_at = ? WHERE id = ?")
      .bind(status, new Date().toISOString(), appointmentStatusMatch[1]).run();
    if (!result.meta.changes) throw new HttpError("予約が見つかりません", 404);
    await writeAudit(env.DB, actor, "appointment.status_updated", "appointment", appointmentStatusMatch[1], { status });
    return json({ ok: true, appointments: await listAppointments(env.DB) });
  }
  const appointmentCalendarMatch = url.pathname.match(/^\/api\/appointments\/(appointment_[A-Za-z0-9_-]+)\/calendar\.ics$/);
  if (request.method === "GET" && appointmentCalendarMatch) {
    const row = await env.DB.prepare(`SELECT id, phone, contact_name AS contactName, email,
      starts_at AS startsAt, duration_minutes AS durationMinutes, notes FROM appointments WHERE id = ? LIMIT 1`)
      .bind(appointmentCalendarMatch[1]).first<Record<string, unknown>>();
    if (!row) throw new HttpError("予約が見つかりません", 404);
    return new Response(appointmentIcs(row), {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="${appointmentCalendarMatch[1]}.ics"`,
        "content-type": "text/calendar; charset=utf-8"
      }
    });
  }
  if (request.method === "PUT" && url.pathname === "/api/integrations") {
    const input = await readJson(request);
    const crmRaw = String(input.crmWebhookUrl || "").trim();
    const calendarRaw = String(input.calendarWebhookUrl || "").trim();
    const teamChatRaw = String(input.teamChatWebhookUrl || "").trim();
    const sheetsRaw = String(input.sheetsWebhookUrl || "").trim();
    let crm = "";
    let calendar = "";
    let teamChat = "";
    let sheets = "";
    try {
      crm = crmRaw ? normalizeIntegrationEndpoint(crmRaw) : "";
      calendar = calendarRaw ? normalizeIntegrationEndpoint(calendarRaw) : "";
      teamChat = teamChatRaw ? normalizeIntegrationEndpoint(teamChatRaw) : "";
      sheets = sheetsRaw ? normalizeIntegrationEndpoint(sheetsRaw) : "";
    } catch (error) {
      throw new HttpError(error instanceof Error ? error.message : "連携URLが不正です", 400);
    }
    await Promise.all([
      upsertIntegration(env.DB, "crm", "webhook", Boolean(crm), crm, {}),
      upsertIntegration(env.DB, "calendar", "webhook", Boolean(calendar), calendar, {}),
      upsertIntegration(env.DB, "team_chat", "webhook", Boolean(teamChat), teamChat, { supports: ["Slack", "Chatwork", "LINE WORKS"] }),
      upsertIntegration(env.DB, "sheets", "webhook", Boolean(sheets), sheets, { supports: ["Google Sheets"] }),
      upsertIntegration(env.DB, "sms", "twilio", input.followupSmsEnabled === true, "", { followup: true })
    ]);
    await writeAudit(env.DB, actor, "integrations.updated", "integrations", "main", {
      crmEnabled: Boolean(crm), calendarEnabled: Boolean(calendar), followupSmsEnabled: input.followupSmsEnabled === true
    });
    return json({ ok: true, integrations: await getIntegrationSettings(env.DB) });
  }
  if (request.method === "POST" && url.pathname === "/api/team-members") {
    const input = await readJson(request);
    const name = String(input.name || "").trim().slice(0, 100);
    const role = String(input.role || "viewer") as TeamRole;
    if (!name || !["viewer", "operator", "admin"].includes(role)) throw new HttpError("名前と権限を選択してください", 400);
    const token = randomAccessToken();
    const tokenHash = await hashAccessToken(token);
    const id = `token_${crypto.randomUUID()}`;
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO team_access_tokens
      (id, name, token_hash, role, active, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)`)
      .bind(id, name, tokenHash, role, now, now).run();
    await writeAudit(env.DB, actor, "team_member.created", "team_access_token", id, { name, role });
    return json({ ok: true, token, member: { id, name, role, active: true, createdAt: now }, teamMembers: await listTeamMembers(env.DB) }, 201);
  }
  const teamMemberMatch = url.pathname.match(/^\/api\/team-members\/(token_[A-Za-z0-9_-]+)$/);
  if (request.method === "DELETE" && teamMemberMatch) {
    await env.DB.prepare("UPDATE team_access_tokens SET active = 0, updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), teamMemberMatch[1]).run();
    await writeAudit(env.DB, actor, "team_member.deactivated", "team_access_token", teamMemberMatch[1]);
    return json({ ok: true, teamMembers: await listTeamMembers(env.DB) });
  }
  if (request.method === "POST" && url.pathname === "/api/services") {
    const input = safeServiceInput(await readJson(request));
    const id = `service_${crypto.randomUUID().replaceAll("-", "")}`;
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO sales_services
      (id, name, seller_name, purpose, description, script, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`)
      .bind(id, input.name, input.sellerName, input.purpose, input.description, input.script, now, now).run();
    await writeAudit(env.DB, actor, "service.created", "service", id, { name: input.name });
    return json({ ok: true, service: { id, ...input }, salesServices: await listSalesServices(env.DB) }, 201);
  }
  const serviceMatch = url.pathname.match(/^\/api\/services\/([a-z0-9_]+)$/);
  if (request.method === "PUT" && serviceMatch) {
    const input = safeServiceInput(await readJson(request));
    const result = await env.DB.prepare(`UPDATE sales_services SET name = ?, seller_name = ?, purpose = ?,
      description = ?, script = ?, active = 1, updated_at = ? WHERE id = ?`)
      .bind(input.name, input.sellerName, input.purpose, input.description, input.script, new Date().toISOString(), serviceMatch[1]).run();
    if (!result.meta.changes) throw new HttpError("営業サービスが見つかりません", 404);
    await writeAudit(env.DB, actor, "service.updated", "service", serviceMatch[1], { name: input.name });
    return json({ ok: true, salesServices: await listSalesServices(env.DB) });
  }
  if (request.method === "DELETE" && serviceMatch) {
    if (serviceMatch[1] === "high_school_recruiting_support") throw new HttpError("標準サービスは停止できません", 400);
    const result = await env.DB.prepare("UPDATE sales_services SET active = 0, updated_at = ? WHERE id = ?")
      .bind(new Date().toISOString(), serviceMatch[1]).run();
    if (!result.meta.changes) throw new HttpError("営業サービスが見つかりません", 404);
    await writeAudit(env.DB, actor, "service.deactivated", "service", serviceMatch[1]);
    return json({ ok: true, salesServices: await listSalesServices(env.DB) });
  }
  const followupSmsMatch = url.pathname.match(/^\/api\/calls\/(call_[A-Za-z0-9_-]+)\/followup-sms$/);
  if (request.method === "POST" && followupSmsMatch) {
    const call = await getCall(env.DB, followupSmsMatch[1]);
    if (!call) throw new HttpError("通話履歴が見つかりません", 404);
    const input = await readJson(request);
    const message = String(input.message || `${call.sellerName || (await getSettings(env.DB)).businessName}です。先ほどはお電話のお時間をいただき、ありがとうございました。ご不明点がございましたらご連絡ください。`)
      .trim().slice(0, 600);
    if (!message) throw new HttpError("SMS本文を入力してください", 400);
    const integrations = await getIntegrationSettings(env.DB);
    if (!integrations.followupSmsEnabled) throw new HttpError("SMS追客が無効です", 409);
    const from = env.TWILIO_SMS_NUMBER || env.TWILIO_PHONE_NUMBER;
    if (!from) throw new HttpError("SMS送信元番号が未設定です", 503);
    const payload = await postTwilio(env, "Messages.json", new URLSearchParams({
      To: normalizeJapanesePhone(call.phone) || call.phone,
      From: from,
      Body: message
    }));
    await writeAudit(env.DB, actor, "followup_sms.sent", "call", call.id, { messageSid: payload.sid || "" });
    return json({ ok: true, sid: payload.sid || "" });
  }
  const voicePhraseMatch = url.pathname.match(/^\/api\/services\/([a-z0-9_]+)\/voice-phrases\/([a-z0-9_]+)$/);
  if (voicePhraseMatch) {
    const [, serviceId, clipId] = voicePhraseMatch;
    const definition = salesVoiceClip(serviceId, clipId);
    if (!definition) throw new HttpError("編集できるフレーズが見つかりません", 404);
    const service = await env.DB.prepare("SELECT id FROM sales_services WHERE id = ? AND active = 1 LIMIT 1")
      .bind(serviceId).first();
    if (!service) throw new HttpError("営業サービスが見つかりません", 404);
    if (request.method === "PUT") {
      const input = await readJson(request);
      const text = String(input.text || "").trim().slice(0, 500);
      if (!text) throw new HttpError("フレーズ内容を入力してください", 400);
      const now = new Date().toISOString();
      await env.DB.prepare(`INSERT INTO sales_voice_phrase_overrides (service_id, clip_id, text, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(service_id, clip_id) DO UPDATE SET
        text = excluded.text, updated_at = excluded.updated_at`)
        .bind(serviceId, clipId, text, now).run();
      await writeAudit(env.DB, actor, "service_phrase.updated", "service", serviceId, { clipId });
      return json({ ok: true, serviceId, clipId, text, updatedAt: now });
    }
    if (request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM sales_voice_phrase_overrides WHERE service_id = ? AND clip_id = ?")
        .bind(serviceId, clipId).run();
      await writeAudit(env.DB, actor, "service_phrase.reset", "service", serviceId, { clipId });
      return json({ ok: true, serviceId, clipId, text: definition.text });
    }
  }
  const voiceClipMatch = url.pathname.match(/^\/api\/services\/([a-z0-9_]+)\/voice-clips\/([a-z0-9_]+)$/);
  if (voiceClipMatch) {
    const [, serviceId, clipId] = voiceClipMatch;
    const definition = salesVoiceClip(serviceId, clipId);
    if (!definition) throw new HttpError("録音フレーズが見つかりません", 404);
    const service = await env.DB.prepare("SELECT id FROM sales_services WHERE id = ? AND active = 1 LIMIT 1")
      .bind(serviceId).first();
    if (!service) throw new HttpError("営業サービスが見つかりません", 404);
    if (request.method === "POST") {
      const raw = await readGreetingAudio(request);
      const version = crypto.randomUUID().replaceAll("-", "");
      const previous = await env.DB.prepare(`SELECT version FROM sales_voice_clips
        WHERE service_id = ? AND clip_id = ? LIMIT 1`).bind(serviceId, clipId).first<{ version: string }>();
      await env.GREETING_MEDIA.put(salesVoiceClipKey(serviceId, clipId, version), raw, { metadata: { contentType: "audio/wav" } });
      await env.DB.prepare(`INSERT INTO sales_voice_clips (service_id, clip_id, version, updated_at)
        VALUES (?, ?, ?, ?) ON CONFLICT(service_id, clip_id) DO UPDATE SET
        version = excluded.version, updated_at = excluded.updated_at`)
        .bind(serviceId, clipId, version, new Date().toISOString()).run();
      if (previous?.version && previous.version !== version) {
        const oldKey = salesVoiceClipKey(serviceId, clipId, previous.version);
        const oldRaw = await env.GREETING_MEDIA.get(oldKey, "arrayBuffer");
        if (oldRaw) await env.GREETING_MEDIA.put(oldKey, oldRaw, { expirationTtl: 86400, metadata: { contentType: "audio/wav" } });
      }
      return json({ ok: true, serviceId, clipId, version }, 201);
    }
    if (request.method === "DELETE") {
      const current = await env.DB.prepare(`SELECT version FROM sales_voice_clips
        WHERE service_id = ? AND clip_id = ? LIMIT 1`).bind(serviceId, clipId).first<{ version: string }>();
      await env.DB.prepare("DELETE FROM sales_voice_clips WHERE service_id = ? AND clip_id = ?")
        .bind(serviceId, clipId).run();
      if (current?.version) {
        const currentKey = salesVoiceClipKey(serviceId, clipId, current.version);
        const currentRaw = await env.GREETING_MEDIA.get(currentKey, "arrayBuffer");
        if (currentRaw) await env.GREETING_MEDIA.put(currentKey, currentRaw, { expirationTtl: 86400, metadata: { contentType: "audio/wav" } });
      }
      return json({ ok: true, serviceId, clipId });
    }
  }
  if (request.method === "POST" && url.pathname === "/api/notifications/test") {
    const now = new Date().toISOString();
    const result = await sendCallNotification(env, {
      id: `test_${crypto.randomUUID()}`,
      direction: "inbound",
      phone: "050-1722-8999",
      contactName: "通知テスト",
      purpose: "着信通知の動作確認",
      summary: "Koe AI電話受付からのテスト通知です。",
      status: "completed",
      duration: 12,
      createdAt: now,
      endedAt: now,
      urgency: "normal"
    });
    return json({ ok: true, messageId: result.messageId });
  }
  if (request.method === "POST" && url.pathname === "/api/notifications/resend") {
    const input = await readJson(request);
    const callId = String(input.callId || "");
    if (!/^call_[A-Za-z0-9_-]+$/.test(callId)) throw new HttpError("通話IDが不正です", 400);
    let call = await getCall(env.DB, callId);
    if (!call) throw new HttpError("通話履歴が見つかりません", 404);
    if (input.regenerateSummary === true || callNeedsSummary(call)) {
      const source = input.regenerateSummary === true
        ? { ...call, purpose: "受付中", summary: "通話中" }
        : call;
      call = await summarizeCallTranscript(env, source);
      await saveCall(env.DB, call);
    }
    const result = await sendCallNotification(env, call);
    await patchCall(env.DB, call.id, {
      finalNotificationStatus: "sent",
      finalNotificationSentAt: new Date().toISOString(),
      finalNotificationError: undefined
    });
    return json({ ok: true, messageId: result.messageId, callId: call.id });
  }
  if (request.method === "POST" && url.pathname === "/api/greeting-audio") {
    const raw = await readGreetingAudio(request);
    await env.GREETING_MEDIA.put(GREETING_KEY, raw, { metadata: { contentType: "audio/wav" } });
    const settings = await getSettings(env.DB);
    const voice = await getVoice(env.DB);
    settings.greetingRecordingEnabled = true;
    settings.greetingRecordingVersion = crypto.randomUUID().replaceAll("-", "");
    await saveAppState(env.DB, settings, voice);
    return json({ ok: true, version: settings.greetingRecordingVersion }, 201);
  }
  if (request.method === "DELETE" && url.pathname === "/api/greeting-audio") {
    await env.GREETING_MEDIA.delete(GREETING_KEY);
    const settings = await getSettings(env.DB);
    const voice = await getVoice(env.DB);
    settings.greetingRecordingEnabled = false;
    settings.greetingRecordingVersion = "";
    await saveAppState(env.DB, settings, voice);
    return json({ ok: true });
  }
  if (request.method === "POST" && url.pathname === "/api/voice/consent") return createConsent(request, env);
  if (request.method === "POST" && url.pathname === "/api/voice/create") return createVoice(request, env);
  return json({ error: "not_found" }, 404);
}

function sipHeaders(entries: unknown): Record<string, string> {
  if (Array.isArray(entries)) {
    return Object.fromEntries(entries.map((entry) => {
      const item = entry && typeof entry === "object" ? entry as { name?: string; value?: string } : {};
      return [String(item.name || "").toLowerCase(), String(item.value || "")];
    }));
  }
  if (entries && typeof entries === "object") {
    return Object.fromEntries(Object.entries(entries as Record<string, unknown>).map(([name, value]) => [name.toLowerCase(), String(value || "")]));
  }
  return {};
}

async function contextFromSip(headers: Record<string, string>, env: WorkerEnv): Promise<{ context: Omit<CallContext, "localId">; existing: CallRecord | null }> {
  const from = headers.from || "";
  const phone = from.match(/sip:([^@;>]+)/i)?.[1] || "不明";
  const callRef = headers["x-call-ref"] || "";
  const existing = callRef ? await getCall(env.DB, callRef) : null;
  return {
    context: {
      direction: existing?.direction || (headers["x-call-mode"] === "outbound" ? "outbound" : "inbound"),
      phone: existing?.phone || phone,
      contactName: existing?.contactName || safeDecodeURIComponent(headers["x-contact-name"], 100),
      purpose: existing?.purpose || safeDecodeURIComponent(headers["x-call-purpose"], 200),
      script: existing?.script || "",
      prerecordedGreeting: Boolean(existing?.prerecordedGreeting) || headers["x-prerecorded-greeting"] === "true",
      companyName: existing?.companyName || "",
      sellerName: existing?.sellerName || "",
      serviceId: existing?.serviceId || "",
      serviceName: existing?.serviceName || "",
      salesCampaign: Boolean(existing?.salesCampaign)
    },
    existing
  };
}

async function markWebhookProcessed(env: WorkerEnv, webhookId: string): Promise<void> {
  if (!webhookId) return;
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO webhook_events (id, created_at) VALUES (?, ?)").bind(webhookId, new Date().toISOString()),
    env.DB.prepare("DELETE FROM webhook_events WHERE id NOT IN (SELECT id FROM webhook_events ORDER BY created_at DESC LIMIT 200)")
  ]);
}

async function handleOpenAIWebhook(request: Request, env: WorkerEnv): Promise<Response> {
  const raw = await readBoundedText(request, MAX_JSON);
  const valid = await verifyOpenAIWebhook(raw, request.headers, env.OPENAI_WEBHOOK_SECRET);
  if (shouldRejectWebhook(valid, env.OPENAI_WEBHOOK_SECRET, isDemo(env))) return json({ error: "invalid_signature" }, 401);
  let event: Record<string, unknown>;
  try { event = JSON.parse(raw) as Record<string, unknown>; }
  catch { return json({ error: "invalid_json" }, 400); }

  const webhookId = event.id ? String(event.id) : "";
  if (webhookId) {
    const seen = await env.DB.prepare("SELECT id FROM webhook_events WHERE id = ?").bind(webhookId).first();
    if (seen) return json({ ok: true, duplicate: true });
  }
  const isLiveEvent = ["live.transport.incoming", "live.call.incoming"].includes(String(event.type || ""));
  const isRealtimeEvent = event.type === "realtime.call.incoming";
  if (!isLiveEvent && !isRealtimeEvent) {
    await markWebhookProcessed(env, webhookId);
    return json({ ok: true, ignored: true });
  }
  const data = (event.data || {}) as Record<string, unknown>;
  if (isLiveEvent && data.type && data.type !== "sip") {
    await markWebhookProcessed(env, webhookId);
    return json({ ok: true, ignored: true });
  }
  const realtimeId = String(isLiveEvent ? data.session_id || "" : data.call_id || "");
  if (!/^[-_A-Za-z0-9]+$/.test(realtimeId)) {
    // The OpenAI dashboard sends a signed sample payload without a usable call ID.
    // Acknowledge it so webhook connectivity can be tested without starting a call.
    if (valid) {
      await markWebhookProcessed(env, webhookId);
      return json({ ok: true, test: true });
    }
    return json({ error: "invalid_call_id" }, 400);
  }
  const settings = await getSettings(env.DB);
  if (!settings.enabled) {
    const rejectPath = isLiveEvent
      ? `/v1/live/sessions/${encodeURIComponent(realtimeId)}/reject`
      : `/v1/realtime/calls/${encodeURIComponent(realtimeId)}/reject`;
    if (!isDemo(env)) await openAI(env, rejectPath, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status_code: 486 })
    });
    await markWebhookProcessed(env, webhookId);
    return json({ ok: true, rejected: true });
  }

  const { context: baseContext, existing } = await contextFromSip(sipHeaders(data.sip_headers), env);
  const localId = existing?.id || `call_${crypto.randomUUID()}`;
  const context: CallContext = { ...baseContext, localId };
  const call: CallRecord = existing || {
    id: localId,
    direction: context.direction,
    phone: context.phone,
    contactName: context.contactName || "未確認",
    purpose: context.purpose || "受付中",
    summary: "通話中",
    status: "in-progress",
    duration: 0,
    createdAt: new Date().toISOString()
  };
  Object.assign(call, { realtimeId, status: "in-progress" });
  await saveCall(env.DB, call);

  if (!isDemo(env)) {
    const acceptPath = isLiveEvent
      ? `/v1/live/sessions/${encodeURIComponent(realtimeId)}/accept`
      : `/v1/realtime/calls/${encodeURIComponent(realtimeId)}/accept`;
    const acceptBody = isLiveEvent
      ? { session: buildLiveSession(settings, context) }
      : buildRealtimeSession(settings, context);
    try {
      await openAI(env, acceptPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(acceptBody)
      });
    } catch (error) {
      // The OpenAI dashboard's signed test event uses a placeholder session ID.
      // Acknowledge only that specific missing-session response; real API errors still retry.
      if (valid && isLiveEvent && error instanceof HttpError && error.status === 404 && /No session found/i.test(error.message)) {
        await markWebhookProcessed(env, webhookId);
        return json({ ok: true, test: true });
      }
      throw error;
    }
    const session = env.CALL_SESSION.getByName(realtimeId) as DurableObjectStub & {
      start(input: { realtimeId: string; context: CallContext; openingInstruction: string; protocol: "live" | "realtime" }): Promise<{ connected: boolean }>;
    };
    await session.start({ realtimeId, context, openingInstruction: buildOpeningInstruction(settings, context), protocol: isLiveEvent ? "live" : "realtime" });
  }
  await markWebhookProcessed(env, webhookId);
  return json({ ok: true, callId: localId, demo: isDemo(env) });
}

async function handleTwilioWebhook(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const params: Record<string, string> = {};
  new URLSearchParams(await readBoundedText(request, MAX_JSON)).forEach((value, key) => { params[key] = value; });
  const signatureUrl = `${(env.PUBLIC_BASE_URL || url.origin).replace(/\/$/, "")}${url.pathname}`;
  const valid = await verifyTwilioWebhook(signatureUrl, params, request.headers.get("x-twilio-signature"), env.TWILIO_AUTH_TOKEN);
  if (shouldRejectWebhook(valid, env.TWILIO_AUTH_TOKEN, isDemo(env))) {
    return json({ error: "invalid_signature" }, 401);
  }
  if (params.CallSid) {
    const row = await env.DB.prepare("SELECT data_json FROM calls WHERE json_extract(data_json, '$.twilioSid') = ? LIMIT 1")
      .bind(params.CallSid).first<{ data_json: string }>();
    if (row) {
      const call = JSON.parse(row.data_json) as CallRecord;
      call.status = params.CallStatus || call.status;
      call.duration = Number(params.CallDuration || call.duration || 0);
      if (params.AnsweredBy) call.answeredBy = params.AnsweredBy;
      await saveCall(env.DB, call);
      if (call.campaignLeadId && call.campaignId) {
        const terminal = ["completed", "failed", "no-answer", "busy", "canceled"].includes(call.status);
        const lead = await env.DB.prepare(`SELECT disposition, callback_at FROM outbound_campaign_leads
          WHERE id = ? LIMIT 1`)
          .bind(call.campaignLeadId).first<{ disposition: string; callback_at: string | null }>();
        let disposition = lead?.disposition || "";
        if (!disposition && params.AnsweredBy?.startsWith("machine")) disposition = "voicemail";
        if (!disposition && ["no-answer", "busy", "failed"].includes(call.status)) {
          disposition = call.status === "no-answer" ? "no_answer" : call.status;
        }
        if (terminal) {
          let retryScheduled = false;
          if (disposition === "callback" && lead?.callback_at && new Date(lead.callback_at).getTime() > Date.now()) {
            await env.DB.prepare(`UPDATE outbound_campaign_leads SET status = 'queued',
              next_attempt_at = ?, last_call_status = ?, updated_at = ? WHERE id = ?`)
              .bind(lead.callback_at, call.status, new Date().toISOString(), call.campaignLeadId).run();
            retryScheduled = true;
          } else {
            retryScheduled = await scheduleCampaignLeadRetry(
              env.DB,
              call.campaignLeadId,
              call.campaignId,
              call.status,
              disposition
            );
          }
          if (!retryScheduled) {
            const outcome = classifyCallOutcome(call.status, disposition);
            const leadStatus = disposition === "do_not_call"
              ? "blocked"
              : (call.status === "completed" || outcome === "terminal" ? "completed" : "failed");
            await env.DB.prepare(`UPDATE outbound_campaign_leads SET status = ?, last_call_status = ?,
              disposition = CASE WHEN disposition = '' AND ? != '' THEN ? ELSE disposition END,
              updated_at = ? WHERE id = ?`)
              .bind(leadStatus, call.status, disposition, disposition, new Date().toISOString(), call.campaignLeadId).run();
          }
          await refreshCampaignStatus(env.DB, call.campaignId);
        } else {
          await env.DB.prepare("UPDATE outbound_campaign_leads SET status = 'calling', last_call_status = ?, updated_at = ? WHERE id = ?")
            .bind(call.status, new Date().toISOString(), call.campaignLeadId).run();
        }
      }
    }
  }
  return json({ ok: true });
}

async function handleTwilioAmdWebhook(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const params: Record<string, string> = {};
  new URLSearchParams(await readBoundedText(request, MAX_JSON)).forEach((value, key) => { params[key] = value; });
  const signatureUrl = `${(env.PUBLIC_BASE_URL || url.origin).replace(/\/$/, "")}${url.pathname}`;
  const valid = await verifyTwilioWebhook(signatureUrl, params, request.headers.get("x-twilio-signature"), env.TWILIO_AUTH_TOKEN);
  if (shouldRejectWebhook(valid, env.TWILIO_AUTH_TOKEN, isDemo(env))) return json({ error: "invalid_signature" }, 401);
  if (!params.CallSid) return json({ ok: true, ignored: true });
  const row = await env.DB.prepare("SELECT data_json FROM calls WHERE json_extract(data_json, '$.twilioSid') = ? LIMIT 1")
    .bind(params.CallSid).first<{ data_json: string }>();
  if (!row) return json({ ok: true, ignored: true });
  const call = JSON.parse(row.data_json) as CallRecord;
  call.answeredBy = params.AnsweredBy || "unknown";
  await saveCall(env.DB, call);
  const machine = /^(machine|fax)/.test(call.answeredBy);
  if (!machine || !call.campaignLeadId || !call.campaignId) return json({ ok: true, answeredBy: call.answeredBy });
  const lead = await env.DB.prepare(`SELECT c.voicemail_action, c.retry_minutes
    FROM outbound_campaign_leads l JOIN outbound_campaigns c ON c.id = l.campaign_id
    WHERE l.id = ? LIMIT 1`).bind(call.campaignLeadId).first<{ voicemail_action: string; retry_minutes: number }>();
  const action = lead?.voicemail_action || "retry";
  await env.DB.prepare(`UPDATE outbound_campaign_leads SET disposition = 'voicemail',
    disposition_note = ?, last_call_status = 'voicemail', updated_at = ? WHERE id = ?`)
    .bind(`Twilio判定: ${call.answeredBy}`, new Date().toISOString(), call.campaignLeadId).run();
  if (action === "retry") {
    await scheduleCampaignLeadRetry(env.DB, call.campaignLeadId, call.campaignId, "voicemail", "voicemail");
    await postTwilio(env, `Calls/${encodeURIComponent(params.CallSid)}.json`, new URLSearchParams({ Status: "completed" }));
  } else if (action === "leave_message") {
    const seller = call.sellerName || (await getSettings(env.DB)).businessName;
    const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Say language="ja-JP">${escapeXml(seller)}です。お電話いたしました。改めてご連絡いたします。失礼いたします。</Say><Hangup/></Response>`;
    await postTwilio(env, `Calls/${encodeURIComponent(params.CallSid)}.json`, new URLSearchParams({ Twiml: twiml }));
  } else {
    await postTwilio(env, `Calls/${encodeURIComponent(params.CallSid)}.json`, new URLSearchParams({ Status: "completed" }));
  }
  return json({ ok: true, answeredBy: call.answeredBy, action });
}

async function handleTwilioIncoming(request: Request, env: WorkerEnv, url: URL): Promise<Response> {
  const params: Record<string, string> = {};
  new URLSearchParams(await readBoundedText(request, MAX_JSON)).forEach((value, key) => { params[key] = value; });
  const publicUrl = (env.PUBLIC_BASE_URL || url.origin).replace(/\/$/, "");
  const signatureUrl = `${publicUrl}${url.pathname}`;
  const valid = await verifyTwilioWebhook(signatureUrl, params, request.headers.get("x-twilio-signature"), env.TWILIO_AUTH_TOKEN);
  if (shouldRejectWebhook(valid, env.TWILIO_AUTH_TOKEN, isDemo(env))) {
    return json({ error: "invalid_signature" }, 401);
  }
  if (!env.OPENAI_PROJECT_ID) return json({ error: "OPENAI_PROJECT_ID が未設定です" }, 503);

  const twilioSid = String(params.CallSid || "").slice(0, 100);
  const localId = twilioSid && /^[A-Za-z0-9_-]+$/.test(twilioSid)
    ? `call_twilio_${twilioSid}`
    : `call_${crypto.randomUUID()}`;
  const existing = await getCall(env.DB, localId);
  const call: CallRecord = existing || {
    id: localId,
    direction: "inbound",
    phone: normalizeJapaneseDomestic(params.From) || String(params.From || "不明").slice(0, 50),
    contactName: "未確認",
    purpose: "受付中",
    summary: "着信を検知しました。相手情報はまだ未確認です。",
    status: "initiated",
    duration: 0,
    createdAt: new Date().toISOString(),
    twilioSid
  };
  if (!existing) {
    await saveCall(env.DB, call);
  }
  const settings = await getSettings(env.DB);
  const rules = await listInboundRules(env.DB);
  const jst = new Date(Date.now() + 9 * 60 * 60_000);
  const weekday = jst.getUTCDay();
  const hour = jst.getUTCHours();
  const inBusinessHours = weekday >= 1 && weekday <= 5 && hour >= 10 && hour < 19;
  const caller = normalizeJapaneseDomestic(params.From) || String(params.From || "");
  const matchedRule = rules.find((rule) => {
    if (!rule.enabled) return false;
    if (rule.conditionType === "always") return true;
    if (rule.conditionType === "business_hours") return inBusinessHours;
    if (rule.conditionType === "outside_hours") return !inBusinessHours;
    if (rule.conditionType === "caller_prefix") return caller.startsWith(String(rule.conditionValue || "").replace(/\D/g, ""));
    return false;
  });
  if (matchedRule?.actionType === "reject") {
    await patchCall(env.DB, call.id, { purpose: "受電ルールにより受付終了", summary: `受電ルール「${matchedRule.name}」を適用しました。`, status: "completed" });
    return new Response('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>', { headers: { "content-type": "text/xml; charset=utf-8" } });
  }
  if (matchedRule?.actionType === "transfer") {
    const destination = normalizeJapanesePhone(matchedRule.actionValue || settings.escalationNumber);
    if (destination) {
      await patchCall(env.DB, call.id, { purpose: "有人転送", summary: `受電ルール「${matchedRule.name}」により担当者へ転送しました。` });
      return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response><Dial>${escapeXml(destination)}</Dial></Response>`, { headers: { "content-type": "text/xml; charset=utf-8" } });
    }
  }
  if (matchedRule?.actionType === "take_message") {
    await patchCall(env.DB, call.id, { purpose: "時間外の伝言受付", summary: `受電ルール「${matchedRule.name}」を適用し、AIが伝言を受け付けています。` });
  }
  const greetingUrl = settings.greetingRecordingEnabled
    ? `${publicUrl}/media/greeting.wav?v=${encodeURIComponent(settings.greetingRecordingVersion)}`
    : "";
  return new Response(makeInboundTwiml(env.OPENAI_PROJECT_ID, localId, greetingUrl), {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/xml; charset=utf-8",
      "x-content-type-options": "nosniff"
    }
  });
}

async function route(request: Request, env: WorkerEnv): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/webhooks/")) {
    await ensureSchema(env.DB);
    await ensureCampaignOperationsSchema(env.DB);
  }
  if (url.pathname.startsWith("/api/")) return handleApi(request, env, url);
  if (request.method === "POST" && url.pathname === "/webhooks/openai") return handleOpenAIWebhook(request, env);
  if (request.method === "POST" && url.pathname === "/webhooks/twilio/incoming") return handleTwilioIncoming(request, env, url);
  if (request.method === "POST" && url.pathname === "/webhooks/twilio/status") return handleTwilioWebhook(request, env, url);
  if (request.method === "POST" && url.pathname === "/webhooks/twilio/amd") return handleTwilioAmdWebhook(request, env, url);
  if (url.pathname.startsWith("/webhooks/")) return json({ error: "not_found" }, 404);
  if (request.method === "GET" && url.pathname === "/media/greeting.wav") {
    const settings = await getSettings(env.DB);
    if (!settings.greetingRecordingEnabled || !settings.greetingRecordingVersion || url.searchParams.get("v") !== settings.greetingRecordingVersion) {
      return new Response("not_found", { status: 404, headers: { "cache-control": "no-store" } });
    }
    const raw = await env.GREETING_MEDIA.get(GREETING_KEY, "arrayBuffer");
    if (!raw) return new Response("not_found", { status: 404, headers: { "cache-control": "no-store" } });
    return new Response(raw, {
      headers: {
        "cache-control": "public, max-age=3600",
        "content-type": "audio/wav",
        "content-disposition": "inline; filename=\"greeting.wav\"",
        "x-content-type-options": "nosniff"
      }
    });
  }
  const voiceMediaMatch = url.pathname.match(/^\/media\/service-voice\/([a-z0-9_]+)\/([a-z0-9_]+)\.wav$/);
  if (request.method === "GET" && voiceMediaMatch) {
    const [, serviceId, clipId] = voiceMediaMatch;
    if (!salesVoiceClip(serviceId, clipId)) return new Response("not_found", { status: 404 });
    const version = url.searchParams.get("v") || "";
    if (!/^[a-f0-9]{32}$/.test(version)) {
      return new Response("not_found", { status: 404, headers: { "cache-control": "no-store" } });
    }
    const raw = await env.GREETING_MEDIA.get(salesVoiceClipKey(serviceId, clipId, version), "arrayBuffer");
    if (!raw) return new Response("not_found", { status: 404, headers: { "cache-control": "no-store" } });
    return new Response(raw, {
      headers: {
        "cache-control": "public, max-age=31536000, immutable",
        "content-type": "audio/wav",
        "content-disposition": `inline; filename="${clipId}.wav"`,
        "x-content-type-options": "nosniff"
      }
    });
  }
  const response = await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  if (url.pathname === "/" || /\.(?:html|js|css)$/.test(url.pathname)) headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "same-origin");
  headers.set("x-frame-options", "DENY");
  headers.set("content-security-policy", "default-src 'self'; style-src 'self'; script-src 'self'; media-src 'self' blob:; connect-src 'self'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const requestId = crypto.randomUUID();
    const startedAt = Date.now();
    try {
      const response = await route(request, env);
      console.log(JSON.stringify({ level: "info", event: "request", requestId, method: request.method, path: new URL(request.url).pathname, status: response.status, durationMs: Date.now() - startedAt }));
      return response;
    } catch (error) {
      const problem = error instanceof HttpError ? error : new HttpError(error instanceof Error ? error.message : "internal_error");
      console.error(JSON.stringify({ level: "error", event: "request", requestId, method: request.method, path: new URL(request.url).pathname, status: problem.status, durationMs: Date.now() - startedAt, error: problem.message }));
      return json({ error: problem.message, details: problem.details }, problem.status);
    }
  },
  async scheduled(_controller: ScheduledController, env: WorkerEnv): Promise<void> {
    await ensureSchema(env.DB);
    await ensureCampaignOperationsSchema(env.DB);
    const settings = await getSettings(env.DB);
    const retentionDays = Math.max(30, Math.min(365, Number(settings.dataRetentionDays || 180)));
    const callCutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60_000).toISOString();
    const auditCutoff = new Date(Date.now() - 730 * 24 * 60 * 60_000).toISOString();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM calls WHERE created_at < ?").bind(callCutoff),
      env.DB.prepare("DELETE FROM audit_log WHERE created_at < ?").bind(auditCutoff),
      env.DB.prepare("UPDATE team_access_tokens SET active = 0, updated_at = ? WHERE active = 1 AND expires_at IS NOT NULL AND expires_at <= ?")
        .bind(new Date().toISOString(), new Date().toISOString())
    ]);
    await processNextCampaignLead(env);
  }
} satisfies ExportedHandler<WorkerEnv>;
