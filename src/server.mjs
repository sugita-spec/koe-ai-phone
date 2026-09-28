import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import WebSocket from "ws";
import {
  ROOT_DIR,
  buildOpeningInstruction,
  buildRealtimeSession,
  isDemo,
  isJapanesePhone,
  loadEnv,
  makeInboundTwiml,
  makeOutboundTwiml,
  normalizeJapaneseDomestic,
  normalizeJapanesePhone,
  publicState,
  readState,
  safeDecodeURIComponent,
  sanitizeSettings,
  shouldRejectWebhook,
  verifyOpenAIWebhook,
  verifyTwilioWebhook,
  writeState
} from "./lib.mjs";

loadEnv();

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const MAX_JSON = 1_000_000;
const MAX_AUDIO = 11 * 1024 * 1024;
let state = readState();
const activeCalls = new Map();

const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function send(res, status, payload, headers = {}) {
  const body = typeof payload === "string" || Buffer.isBuffer(payload) ? payload : JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": typeof payload === "object" && !Buffer.isBuffer(payload) ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, payload);
}

async function readBody(req, limit = MAX_JSON) {
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw Object.assign(new Error("request_too_large"), { status: 413 });
    parts.push(part);
  }
  return Buffer.concat(parts);
}

async function readJson(req) {
  const raw = await readBody(req);
  try { return JSON.parse(raw.toString("utf8") || "{}"); }
  catch { throw Object.assign(new Error("invalid_json"), { status: 400 }); }
}

function persist() {
  writeState(state);
}

function getCall(id) {
  return state.calls.find((call) => call.id === id);
}

function updateCall(id, patch) {
  const call = getCall(id);
  if (call) Object.assign(call, patch);
  persist();
  return call;
}

function parseSipHeaders(list = []) {
  if (Array.isArray(list)) return Object.fromEntries(list.map((entry) => [String(entry?.name || "").toLowerCase(), String(entry?.value || "")]));
  if (list && typeof list === "object") return Object.fromEntries(Object.entries(list).map(([name, value]) => [name.toLowerCase(), String(value || "")]));
  return {};
}

function contextFromSip(headers) {
  const from = headers.from || "";
  const phone = from.match(/sip:([^@;>]+)/i)?.[1] || "不明";
  const callRef = headers["x-call-ref"] || "";
  const existing = callRef ? getCall(callRef) : null;
  return {
    direction: existing?.direction || (headers["x-call-mode"] === "outbound" ? "outbound" : "inbound"),
    phone: existing?.phone || phone,
    contactName: existing?.contactName || safeDecodeURIComponent(headers["x-contact-name"], 100),
    purpose: existing?.purpose || safeDecodeURIComponent(headers["x-call-purpose"], 200),
    script: existing?.script || "",
    existing
  };
}

async function openAI(pathname, options = {}) {
  if (!process.env.OPENAI_API_KEY) throw Object.assign(new Error("OPENAI_API_KEY が未設定です"), { status: 503 });
  const response = await fetch(`https://api.openai.com${pathname}`, {
    ...options,
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...(options.headers || {}) }
  });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); } catch { payload = { message: text }; }
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `OpenAI API error (${response.status})`;
    throw Object.assign(new Error(message), { status: response.status, details: payload });
  }
  return payload;
}

async function createConsent(raw, meta) {
  const form = new FormData();
  form.append("name", meta.name || "koe_consent");
  form.append("language", meta.language || "ja");
  form.append("recording", new Blob([raw], { type: meta.type }), meta.filename);
  return openAI("/v1/audio/voice_consents", { method: "POST", body: form });
}

async function createVoice(raw, meta) {
  const form = new FormData();
  form.append("name", meta.name || "my_phone_voice");
  form.append("consent", meta.consentId);
  form.append("audio_sample", new Blob([raw], { type: meta.type }), meta.filename);
  return openAI("/v1/audio/voices", { method: "POST", body: form });
}

async function acceptRealtimeCall(callId, context) {
  const session = buildRealtimeSession(state.settings, context);
  await openAI(`/v1/realtime/calls/${encodeURIComponent(callId)}/accept`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(session)
  });
  monitorRealtimeCall(callId, context).catch((error) => {
    console.error("realtime monitor", error.message);
    if (context.localId) updateCall(context.localId, { monitorError: error.message });
  });
}

async function rejectRealtimeCall(callId, statusCode = 486) {
  return openAI(`/v1/realtime/calls/${encodeURIComponent(callId)}/reject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status_code: statusCode })
  });
}

function monitorRealtimeCall(callId, context) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`, {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
    });
    const startedAt = Date.now();
    const transcript = [];
    const handledTools = new Set();
    activeCalls.set(callId, ws);

    const saveTranscript = () => {
      if (process.env.STORE_TRANSCRIPTS === "false") return;
      updateCall(context.localId, { transcript: transcript.slice(-100) });
    };

    const handleTool = (id, name, rawArgs) => {
      if (!id || handledTools.has(id) || name !== "take_message") return;
      handledTools.add(id);
      let args = {};
      try { args = JSON.parse(rawArgs || "{}"); } catch {}
      updateCall(context.localId, {
        contactName: args.contact_name || context.contactName || "未確認",
        phone: args.callback_number || context.phone,
        purpose: args.purpose || context.purpose || "受付",
        summary: args.summary || "伝言を受け付けました",
        urgency: args.urgency || "normal"
      });
      ws.send(JSON.stringify({
        type: "conversation.item.create",
        item: { type: "function_call_output", call_id: id, output: JSON.stringify({ ok: true, message: "伝言を保存しました" }) }
      }));
      ws.send(JSON.stringify({ type: "response.create", response: { instructions: "伝言を確かに承ったことを伝え、ほかに用件がなければ丁寧に通話を終了してください。" } }));
    };

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "response.create", response: { instructions: buildOpeningInstruction(state.settings, context) } }));
    });
    ws.on("message", (data) => {
      let event;
      try { event = JSON.parse(data.toString()); } catch { return; }
      if (event.type === "conversation.item.input_audio_transcription.completed") {
        transcript.push({ role: "caller", text: event.transcript || "", at: new Date().toISOString() });
        saveTranscript();
      }
      if (["response.output_audio_transcript.done", "response.audio_transcript.done"].includes(event.type)) {
        transcript.push({ role: "agent", text: event.transcript || "", at: new Date().toISOString() });
        saveTranscript();
      }
      if (event.type === "response.function_call_arguments.done") {
        handleTool(event.call_id, event.name, event.arguments);
      }
      if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
        handleTool(event.item.call_id, event.item.name, event.item.arguments);
      }
    });
    ws.on("error", reject);
    ws.on("close", () => {
      activeCalls.delete(callId);
      updateCall(context.localId, {
        status: "completed",
        duration: Math.max(1, Math.round((Date.now() - startedAt) / 1000)),
        endedAt: new Date().toISOString()
      });
      resolve();
    });
  });
}

async function makeOutboundCall(input) {
  if (!isJapanesePhone(input.to)) {
    throw Object.assign(new Error("日本の電話番号を 090-1234-5678 や 03-1234-5678 の形式で入力してください"), { status: 400 });
  }
  const phone = normalizeJapaneseDomestic(input.to);
  const twilioPhone = normalizeJapanesePhone(input.to);
  const id = `call_${crypto.randomUUID()}`;
  const call = {
    id,
    direction: "outbound",
    phone,
    contactName: String(input.contactName || "未登録").trim().slice(0, 100),
    purpose: String(input.purpose || "ご連絡").trim().slice(0, 200),
    script: String(input.script || "").trim().slice(0, 3000),
    summary: "架電を受け付けました",
    status: isDemo() ? "demo" : "queued",
    duration: 0,
    createdAt: new Date().toISOString(),
    demo: isDemo()
  };
  state.calls.unshift(call);
  persist();

  if (isDemo()) return call;
  const required = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_PHONE_NUMBER", "OPENAI_PROJECT_ID"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) throw Object.assign(new Error(`未設定: ${missing.join(", ")}`), { status: 503 });
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const baseUrl = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
  const body = new URLSearchParams({
    To: twilioPhone,
    From: process.env.TWILIO_PHONE_NUMBER,
    Twiml: makeOutboundTwiml(process.env.OPENAI_PROJECT_ID, call)
  });
  if (baseUrl) {
    body.set("StatusCallback", `${baseUrl}/webhooks/twilio/status`);
    body.set("StatusCallbackMethod", "POST");
    body.set("StatusCallbackEvent", "initiated ringing answered completed");
  }
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });
  const payload = await response.json();
  if (!response.ok) {
    updateCall(id, { status: "failed", summary: payload.message || "Twilioで架電に失敗しました" });
    throw Object.assign(new Error(payload.message || `Twilio API error (${response.status})`), { status: response.status });
  }
  return updateCall(id, { twilioSid: payload.sid, status: payload.status || "queued" });
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/state") return sendJson(res, 200, publicState(state));
  if (req.method === "GET" && url.pathname === "/api/health") return sendJson(res, 200, { ok: true, mode: isDemo() ? "demo" : "live", activeCalls: activeCalls.size });

  if (req.method === "PUT" && url.pathname === "/api/settings") {
    state.settings = sanitizeSettings(await readJson(req), state.settings);
    if (state.settings.customVoiceId) {
      state.voice.voiceId = state.settings.customVoiceId;
      state.voice.status = "ready";
    }
    persist();
    return sendJson(res, 200, publicState(state));
  }

  if (req.method === "POST" && url.pathname === "/api/outbound") {
    const call = await makeOutboundCall(await readJson(req));
    return sendJson(res, 201, { call, demo: isDemo() });
  }

  if (req.method === "POST" && url.pathname === "/api/voice/consent") {
    const raw = await readBody(req, MAX_AUDIO);
    if (!raw.length) throw Object.assign(new Error("同意音声を録音または選択してください"), { status: 400 });
    const meta = {
      filename: req.headers["x-filename"] || "consent.webm",
      name: req.headers["x-name"] || "koe_consent",
      language: req.headers["x-language"] || "ja",
      type: req.headers["content-type"] || "audio/webm"
    };
    const payload = isDemo() ? { id: `cons_demo_${Date.now()}` } : await createConsent(raw, meta);
    state.voice = { ...state.voice, consentId: payload.id, status: "consent_ready" };
    persist();
    return sendJson(res, 201, { id: payload.id, demo: isDemo() });
  }

  if (req.method === "POST" && url.pathname === "/api/voice/create") {
    const raw = await readBody(req, MAX_AUDIO);
    const consentId = req.headers["x-consent-id"] || state.voice.consentId;
    if (!raw.length || !consentId) throw Object.assign(new Error("同意音声とサンプル音声の両方が必要です"), { status: 400 });
    const meta = {
      filename: req.headers["x-filename"] || "sample.webm",
      name: req.headers["x-name"] || "my_phone_voice",
      consentId,
      type: req.headers["content-type"] || "audio/webm"
    };
    const payload = isDemo() ? { id: `voice_demo_${Date.now()}`, name: meta.name } : await createVoice(raw, meta);
    state.voice = { consentId, voiceId: payload.id, name: payload.name || meta.name, status: "ready" };
    state.settings.customVoiceId = payload.id;
    persist();
    return sendJson(res, 201, { id: payload.id, name: state.voice.name, demo: isDemo() });
  }

  return false;
}

async function handleWebhook(req, res, url) {
  if (req.method === "POST" && url.pathname === "/webhooks/twilio/incoming") {
    const raw = (await readBody(req, MAX_JSON)).toString("utf8");
    const params = Object.fromEntries(new URLSearchParams(raw));
    const publicUrl = String(process.env.PUBLIC_BASE_URL || `${url.protocol}//${url.host}`).replace(/\/$/, "");
    const signatureUrl = `${publicUrl}${url.pathname}`;
    const valid = verifyTwilioWebhook(signatureUrl, params, req.headers["x-twilio-signature"], process.env.TWILIO_AUTH_TOKEN);
    if (shouldRejectWebhook(valid, process.env.TWILIO_AUTH_TOKEN, isDemo())) {
      return sendJson(res, 401, { error: "invalid_signature" });
    }
    if (!process.env.OPENAI_PROJECT_ID) return sendJson(res, 503, { error: "OPENAI_PROJECT_ID が未設定です" });
    const localId = `call_${crypto.randomUUID()}`;
    state.calls.unshift({
      id: localId,
      direction: "inbound",
      phone: normalizeJapaneseDomestic(params.From) || String(params.From || "不明").slice(0, 50),
      contactName: "未確認",
      purpose: "受付中",
      summary: "OpenAIへ接続中",
      status: "initiated",
      duration: 0,
      createdAt: new Date().toISOString(),
      twilioSid: String(params.CallSid || "").slice(0, 100)
    });
    persist();
    return send(res, 200, makeInboundTwiml(process.env.OPENAI_PROJECT_ID, localId), { "content-type": "text/xml; charset=utf-8" });
  }

  if (req.method === "POST" && url.pathname === "/webhooks/openai") {
    const raw = await readBody(req, MAX_JSON);
    const valid = verifyOpenAIWebhook(raw.toString("utf8"), req.headers, process.env.OPENAI_WEBHOOK_SECRET);
    if (shouldRejectWebhook(valid, process.env.OPENAI_WEBHOOK_SECRET, isDemo())) return sendJson(res, 401, { error: "invalid_signature" });
    let event;
    try { event = JSON.parse(raw.toString("utf8")); } catch { return sendJson(res, 400, { error: "invalid_json" }); }
    if (event.id && state.webhookIds.includes(event.id)) return sendJson(res, 200, { ok: true, duplicate: true });
    if (event.id) state.webhookIds.push(event.id);
    persist();
    if (event.type !== "realtime.call.incoming") return sendJson(res, 200, { ok: true, ignored: true });
    const realtimeId = event.data?.call_id;
    if (!realtimeId || !/^[-_A-Za-z0-9]+$/.test(realtimeId)) return sendJson(res, 400, { error: "invalid_call_id" });
    if (!state.settings.enabled) {
      if (!isDemo()) await rejectRealtimeCall(realtimeId, 486);
      return sendJson(res, 200, { ok: true, rejected: true });
    }
    const sip = parseSipHeaders(event.data?.sip_headers);
    const context = contextFromSip(sip);
    const localId = context.existing?.id || `call_${crypto.randomUUID()}`;
    if (!context.existing) {
      state.calls.unshift({
        id: localId,
        realtimeId,
        direction: context.direction,
        phone: context.phone,
        contactName: context.contactName || "未確認",
        purpose: context.purpose || "受付中",
        summary: "通話中",
        status: "in-progress",
        duration: 0,
        createdAt: new Date().toISOString()
      });
      persist();
    } else updateCall(localId, { realtimeId, status: "in-progress" });
    if (!isDemo()) await acceptRealtimeCall(realtimeId, { ...context, localId });
    return sendJson(res, 200, { ok: true, callId: localId, demo: isDemo() });
  }

  if (req.method === "POST" && url.pathname === "/webhooks/twilio/status") {
    const raw = (await readBody(req, MAX_JSON)).toString("utf8");
    const params = Object.fromEntries(new URLSearchParams(raw));
    const publicUrl = String(process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
    const signatureUrl = `${publicUrl}${url.pathname}`;
    const valid = verifyTwilioWebhook(signatureUrl, params, req.headers["x-twilio-signature"], process.env.TWILIO_AUTH_TOKEN);
    if (shouldRejectWebhook(valid, process.env.TWILIO_AUTH_TOKEN, isDemo())) {
      return sendJson(res, 401, { error: "invalid_signature" });
    }
    const call = state.calls.find((item) => item.twilioSid === params.CallSid);
    if (call) updateCall(call.id, { status: params.CallStatus || call.status, duration: Number(params.CallDuration || call.duration || 0) });
    return sendJson(res, 200, { ok: true });
  }
  return false;
}

function serveStatic(res, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const file = path.resolve(PUBLIC_DIR, `.${requested}`);
  if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`)) return send(res, 403, "Forbidden");
  try {
    const data = fs.readFileSync(file);
    res.writeHead(200, {
      "content-type": mime[path.extname(file)] || "application/octet-stream",
      "content-length": data.length,
      "cache-control": path.extname(file) === ".html" ? "no-cache" : "public, max-age=3600",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'self'; style-src 'self'; script-src 'self'; media-src 'self' blob:; connect-src 'self'"
    });
    res.end(data);
  } catch (error) {
    if (error.code === "ENOENT") return send(res, 404, "Not found");
    throw error;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      const handled = await handleApi(req, res, url);
      if (handled === false) return sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (url.pathname.startsWith("/webhooks/")) {
      const handled = await handleWebhook(req, res, url);
      if (handled === false) return sendJson(res, 404, { error: "not_found" });
      return;
    }
    serveStatic(res, url.pathname);
  } catch (error) {
    console.error(req.method, url.pathname, error);
    sendJson(res, error.status || 500, { error: error.message || "internal_error", details: error.details });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Koe AI Phone: http://127.0.0.1:${PORT}`);
  console.log(`mode: ${isDemo() ? "demo" : "live"}`);
});

function shutdown() {
  for (const socket of activeCalls.values()) socket.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
