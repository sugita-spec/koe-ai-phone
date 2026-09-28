import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  DEFAULT_SETTINGS,
  buildCallSummaryRequest,
  buildCallNotification,
  buildInstructions,
  buildLiveGreetingCommands,
  buildLiveFrontendInstructions,
  buildLiveSession,
  buildOpeningInstruction,
  buildRealtimeSession,
  callNeedsSummary,
  isJapanesePhone,
  isOutboundSalesWindow,
  LIVE_GREETING_DELAY_MS,
  makeInboundTwiml,
  makeOutboundTwiml,
  normalizeJapaneseDomestic,
  normalizeJapanesePhone,
  parseCallSummaryResponse,
  SALES_SERVICE_PRESETS,
  SALES_VOICE_CLIP_DEFINITIONS,
  safeDecodeURIComponent,
  sanitizeSettings,
  shouldRejectWebhook,
  verifyOpenAIWebhook,
  verifyTwilioWebhook
} from "../src/lib.mjs";

test("GPT-Live greets before the caller speaks", () => {
  const commands = buildLiveGreetingCommands(
    "お電話ありがとうございます。日本語をご希望の方は、そのままご用件をお話しください。For service in English, please say English.",
    "evt123"
  );
  assert.equal(LIVE_GREETING_DELAY_MS, 1000);
  assert.deepEqual(commands.map((command) => command.type), [
    "session.instructions.append",
    "session.commentary.append"
  ]);
  assert.equal(commands[0].delegation_id, null);
  assert.equal(commands[1].delegation_id, null);
  assert.match(commands[0].content, /相手がまだ何も話していなくても/);
  assert.match(commands[0].content, /開始指示を受け取るまでは発話せず待機/);
  assert.match(commands[0].content, /お電話ありがとうございます/);
  assert.match(commands[0].content, /日本語部分は自然な日本語/);
  assert.match(commands[0].content, /英語部分は自然な英語/);
  assert.match(commands[0].content, /For service in English, please say English/);
  assert.match(commands[1].content, /今すぐ/);
  assert.match(commands[1].content, /英語部分は英語/);
});

test("settings are sanitized and unknown fields are ignored", () => {
  const result = sanitizeSettings({ businessName: "  テスト社  ", builtinVoice: "invalid", secret: "leak", enabled: false, greetingRecordingEnabled: true });
  assert.equal(result.businessName, "テスト社");
  assert.equal(result.builtinVoice, DEFAULT_SETTINGS.builtinVoice);
  assert.equal(result.enabled, false);
  assert.equal(result.greetingRecordingEnabled, true);
  assert.equal("secret" in result, false);
});

test("custom voice is placed in realtime audio output", () => {
  const session = buildRealtimeSession({ ...DEFAULT_SETTINGS, customVoiceId: "voice_123" }, { direction: "inbound" });
  assert.deepEqual(session.audio.output.voice, { id: "voice_123" });
  assert.equal(session.model, "gpt-realtime-2.1");
  assert.equal(session.tools[0].name, "take_message");
});

test("latest GPT-Live voice session uses the recommended Responses backend", () => {
  const session = buildLiveSession(DEFAULT_SETTINGS, { direction: "inbound" });
  assert.equal(session.type, "live");
  assert.equal(session.model, "gpt-live-1");
  assert.equal(session.audio.output.voice, "marin");
  assert.equal(session.delegation.type, "responses");
  assert.equal(session.delegation.responses.model, "gpt-5.6-terra");
  assert.equal(session.delegation.responses.tools[0].name, "take_message");
  assert.equal(session.delegation.responses.parallel_tool_calls, false);
  assert.match(session.instructions, /英語対応を明示的に希望/);
  assert.match(session.instructions, /自然で丁寧な英語へ切り替え/);
  assert.match(session.instructions, /周囲の会話だけで言語を変更しない/);
  assert.match(session.instructions, /10桁または11桁/);
  assert.match(session.instructions, /先頭から最後まで全桁/);
  assert.match(session.instructions, /一度に質問するのは一つだけ/);
  assert.match(session.instructions, /登録済みの会社情報を尋ねられたとき/);
  assert.doesNotMatch(session.instructions, /営業時間:/);
  assert.doesNotMatch(session.delegation.responses.instructions, /会話開始:/);
  assert.match(session.delegation.responses.instructions, /質問へ直接1〜2文で答えて/);
  assert.match(session.delegation.responses.instructions, /案内可能な情報にない内容は推測せず/);
  assert.match(session.delegation.responses.instructions, /現在の会話言語に忠実に翻訳/);
  assert.match(session.delegation.responses.instructions, /zero, nine, zero/);
});

test("GPT-Live Japanese receptionist supports 10- and 11-digit phone numbers", () => {
  const instructions = buildLiveFrontendInstructions(DEFAULT_SETTINGS, { direction: "inbound" });
  assert.match(instructions, /一度に一項目ずつ/);
  assert.match(instructions, /10桁または11桁/);
  assert.match(instructions, /区切り方を決めつけず/);
  assert.match(instructions, /訂正後の全番号/);
  assert.doesNotMatch(instructions, /3桁・4桁・4桁/);
  assert.match(instructions, /承知しました/);
});

test("receptionist creates a natural Japanese memo instead of transcript fragments", () => {
  const session = buildLiveSession(DEFAULT_SETTINGS, { direction: "inbound" });
  assert.match(session.delegation.responses.instructions, /音声認識の断片や相づちを並べず/);
  assert.match(session.delegation.responses.tools[0].parameters.properties.summary.description, /自然な日本語2〜3文/);
});

test("English calls are summarized into structured Japanese before notification", () => {
  const call = {
    id: "call_english",
    direction: "inbound",
    phone: "+819099906502",
    contactName: "未確認",
    purpose: "受付中",
    summary: "着信を検知しました。相手情報はまだ未確認です。",
    status: "completed",
    duration: 264,
    createdAt: "2026-09-22T16:07:55.809Z",
    transcript: [
      { role: "caller", text: "My name is Alex. I would like to ask about your AI services.", at: "2026-09-22T16:08:00.000Z" },
      { role: "agent", text: "We offer AI and business automation services.", at: "2026-09-22T16:08:05.000Z" },
      { role: "caller", text: "Please call me tomorrow at 1 p.m.", at: "2026-09-22T16:08:10.000Z" }
    ]
  };
  assert.equal(callNeedsSummary(call), true);
  const request = buildCallSummaryRequest(call);
  assert.equal(request.model, "gpt-5.6-terra");
  assert.match(request.instructions, /会話が英語でも/);
  assert.match(request.instructions, /英字で認識された氏名を漢字へ変換せず/);
  assert.equal(request.text.format.type, "json_schema");
  assert.equal(request.text.format.strict, true);
  const parsed = parseCallSummaryResponse({
    output: [{ content: [{ type: "output_text", text: JSON.stringify({
      contact_name: "Alex",
      callback_number: "",
      purpose: "AIサービスについての問い合わせ",
      summary: "Alex様からAIサービスについて問い合わせがありました。明日13時の折り返しを希望されています。",
      urgency: "normal"
    }) }] }]
  });
  assert.equal(parsed.contactName, "Alex");
  assert.match(parsed.summary, /AIサービス/);
  assert.match(parsed.summary, /明日13時/);
});

test("realtime audio rejects background noise without clipping speech", () => {
  const session = buildRealtimeSession(DEFAULT_SETTINGS, { direction: "inbound" });
  assert.deepEqual(session.audio.input.noise_reduction, { type: "near_field" });
  assert.deepEqual(session.audio.input.turn_detection, {
    type: "server_vad",
    threshold: 0.7,
    prefix_padding_ms: 400,
    silence_duration_ms: 700,
    create_response: true,
    interrupt_response: true
  });
  assert.match(session.instructions, /周囲の会話、雑音には応答しない/);
  assert.match(session.instructions, /もう一度ゆっくりお願いします/);
  assert.match(session.instructions, /氏名、電話番号、日時、金額は必ず一項目ずつ復唱/);
});

test("outbound context is added to receptionist instructions", () => {
  const text = buildInstructions(DEFAULT_SETTINGS, { direction: "outbound", contactName: "田中さま", purpose: "予約確認" });
  assert.match(text, /田中さま/);
  assert.match(text, /予約確認/);
  assert.match(text, /AI受付/);
  assert.match(text, /着信受付のように相手へ用件を尋ねず/);
  assert.doesNotMatch(text, /本日はどのようなご用件でしょうか/);
  const opening = buildOpeningInstruction(DEFAULT_SETTINGS, { direction: "outbound", contactName: "田中", purpose: "予約確認" });
  assert.match(opening, /突然のお電話失礼します/);
  assert.match(opening, /田中様でいらっしゃいますか/);
  assert.match(opening, /予約確認の件でお電話しました/);
});

test("sales campaign identifies the seller and stops when the recipient declines", () => {
  const context = {
    direction: "outbound",
    companyName: "テスト商事",
    contactName: "田中",
    purpose: "AI業務自動化サービス",
    script: "無料相談をご案内する",
    salesCampaign: true
  };
  const instructions = buildInstructions(DEFAULT_SETTINGS, context);
  const opening = buildOpeningInstruction(DEFAULT_SETTINGS, context);
  const frontend = buildLiveFrontendInstructions(DEFAULT_SETTINGS, context);
  assert.match(instructions, /会社名、担当者名、サービスの種類、営業目的/);
  assert.match(instructions, /勧誘を継続せず/);
  assert.match(opening, /営業のお電話です/);
  assert.match(opening, /1分ほどお時間よろしいでしょうか/);
  assert.match(frontend, /断られたら勧誘を続けず/);
});

test("high school recruiting preset follows the supplied appointment script", () => {
  const service = SALES_SERVICE_PRESETS.find((item) => item.id === "high_school_recruiting_support");
  assert.ok(service);
  assert.equal(service.sellerName, "株式会社KAMEYA Holdings");
  assert.match(service.script, /地域の高校への直接アプローチ/);
  assert.match(service.script, /年間60〜80万円/);
  assert.match(service.script, /オンライン相談/);
  assert.match(service.script, /実在しない実績や人数を作らない/);
  assert.match(service.script, /直ちに終了/);
  const opening = buildOpeningInstruction(DEFAULT_SETTINGS, {
    direction: "outbound",
    companyName: "採用テスト株式会社",
    contactName: "採用ご担当者",
    purpose: service.purpose,
    serviceName: service.name,
    sellerName: service.sellerName,
    salesCampaign: true
  });
  assert.match(opening, /株式会社KAMEYA Holdings/);
  assert.match(opening, /高卒採用支援についての営業のお電話/);
  assert.doesNotMatch(opening, /BrightLink/);
});

test("recorded sales opening is followed by mandatory AI and sales disclosure", () => {
  const clip = SALES_VOICE_CLIP_DEFINITIONS.find((item) => item.id === "transparent_opening");
  assert.ok(clip);
  assert.equal(clip.automatic, true);
  assert.match(clip.text, /私の録音/);
  assert.match(clip.text, /AI電話担当がご案内/);
  assert.match(clip.text, /営業のお電話/);
  const context = {
    direction: "outbound",
    purpose: "高校生新卒採用支援のオンライン提案",
    salesCampaign: true,
    prerecordedGreeting: true
  };
  const opening = buildOpeningInstruction(DEFAULT_SETTINGS, context);
  assert.match(opening, /本人録音の内容にかかわらず/);
  assert.match(opening, /お待たせしました/);
  assert.match(opening, /AI電話担当/);
  assert.match(opening, /営業のお電話/);
  const twiml = makeOutboundTwiml("proj_123", { id: "call_1", contactName: "田中", purpose: "高卒採用" }, "https://example.com/opening.wav?v=123");
  assert.match(twiml, /<Play>https:\/\/example.com\/opening.wav\?v=123<\/Play>/);
  assert.match(twiml, /x-prerecorded-greeting=true/);
  assert.ok(twiml.indexOf("<Play>") < twiml.indexOf("<Dial"));
});

test("list sales calls run only on weekdays from 10:00 to 19:00 JST", () => {
  assert.equal(isOutboundSalesWindow(new Date("2026-09-24T01:00:00.000Z")), true);
  assert.equal(isOutboundSalesWindow(new Date("2026-09-24T09:59:59.000Z")), true);
  assert.equal(isOutboundSalesWindow(new Date("2026-09-24T10:00:00.000Z")), false);
  assert.equal(isOutboundSalesWindow(new Date("2026-09-26T03:00:00.000Z")), false);
});

test("prerecorded inbound greeting is followed by mandatory AI disclosure", () => {
  const context = { direction: "inbound", prerecordedGreeting: true };
  const opening = buildOpeningInstruction(DEFAULT_SETTINGS, context);
  const instructions = buildInstructions(DEFAULT_SETTINGS, context);
  assert.match(opening, /本日はどのようなご用件でしょうか/);
  assert.match(opening, /AI受付/);
  assert.match(instructions, /本人録音/);
  assert.match(instructions, /録音内容にかかわらず/);
  assert.doesNotMatch(instructions, /案内は完了しています/);
});

test("OpenAI standard webhook signature is verified", () => {
  const key = crypto.randomBytes(32);
  const secret = `whsec_${key.toString("base64")}`;
  const body = JSON.stringify({ type: "realtime.call.incoming" });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const id = "wh_test";
  const signature = crypto.createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  assert.equal(verifyOpenAIWebhook(body, { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` }, secret), true);
  assert.equal(verifyOpenAIWebhook(`${body}x`, { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` }, secret), false);
});

test("Twilio signature is verified", () => {
  const url = "https://example.com/webhooks/twilio/status";
  const params = { CallSid: "CA123", CallStatus: "completed" };
  const payload = url + "CallSidCA123CallStatuscompleted";
  const signature = crypto.createHmac("sha1", "token").update(payload).digest("base64");
  assert.equal(verifyTwilioWebhook(url, params, signature, "token"), true);
});

test("configured webhook secrets are enforced even in demo mode", () => {
  assert.equal(shouldRejectWebhook(false, "configured", true), true);
  assert.equal(shouldRejectWebhook(false, undefined, true), false);
  assert.equal(shouldRejectWebhook(false, undefined, false), true);
  assert.equal(shouldRejectWebhook(true, "configured", false), false);
});

test("malformed percent encoding in SIP metadata does not crash", () => {
  assert.equal(safeDecodeURIComponent("%E3%81%82", 10), "あ");
  assert.equal(safeDecodeURIComponent("broken%ZZ", 10), "broken%ZZ");
});

test("Japanese phone validation, conversion and TwiML generation", () => {
  assert.equal(isJapanesePhone("090-1234-5678"), true);
  assert.equal(isJapanesePhone("０３−１２３４−５６７８"), true);
  assert.equal(isJapanesePhone("+819012345678"), false);
  assert.equal(isJapanesePhone("+14155552671"), false);
  assert.equal(isJapanesePhone("110"), false);
  assert.equal(normalizeJapanesePhone("090-1234-5678"), "+819012345678");
  assert.equal(normalizeJapanesePhone("03 (1234) 5678"), "+81312345678");
  assert.equal(normalizeJapaneseDomestic("０９０−１２３４−５６７８"), "09012345678");
  const xml = makeOutboundTwiml("proj_123", { id: "call_1", contactName: "A&B", purpose: "確認" });
  assert.match(xml, /sip:proj_123@sip\.api\.openai\.com;transport=tls;secure=true/);
  assert.match(xml, /x-call-mode=outbound/);
  assert.match(xml, /&amp;/);
  const inbound = makeInboundTwiml("proj_123", "call_abc");
  assert.match(inbound, /sip:proj_123@sip\.api\.openai\.com;transport=tls;secure=true/);
  assert.match(inbound, /x-call-mode=inbound/);
  assert.match(inbound, /x-call-ref=call_abc/);
  assert.doesNotMatch(inbound, /<Play>/);
  const withGreeting = makeInboundTwiml("proj_123", "call_abc", "https://example.com/media/greeting.wav?v=1&lang=ja");
  assert.match(withGreeting, /<Play>https:\/\/example\.com\/media\/greeting\.wav\?v=1&amp;lang=ja<\/Play>/);
  assert.match(withGreeting, /x-prerecorded-greeting=true/);
});

test("call notification contains the inbound call summary and history link", () => {
  const message = buildCallNotification({
    id: "call_123",
    direction: "inbound",
    phone: "09012345678",
    contactName: "山田さま",
    purpose: "見積もり依頼",
    summary: "来週までの折り返しをご希望です。",
    status: "completed",
    duration: 95,
    createdAt: "2026-09-21T03:00:00.000Z",
    urgency: "high",
    transcript: [
      { role: "agent", text: "ご用件をお聞かせください。", at: "2026-09-21T03:00:01.000Z" },
      { role: "caller", text: "システム開発について相談したいです。", at: "2026-09-21T03:00:05.000Z" }
    ]
  }, "https://example.com/");
  assert.match(message.subject, /通話完了/);
  assert.match(message.subject, /山田さま/);
  assert.match(message.text, /09012345678/);
  assert.match(message.text, /来週までの折り返し/);
  assert.match(message.text, /1分35秒/);
  assert.match(message.text, /お問い合わせ内容（要約）/);
  assert.doesNotMatch(message.text, /会話内容（お相手の発話）/);
  assert.doesNotMatch(message.text, /システム開発について相談したい/);
  assert.match(message.text, /https:\/\/example.com\/#calls/);
  assert.match(message.html, /通話履歴を開く/);
});
