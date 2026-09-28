const NOTIFICATION_DESTINATION = "info@kameya-hldgs.com";
const CALENDAR_TIMEZONE = "Asia/Tokyo";
const CALENDAR_OPEN_HOUR = 10;
const CALENDAR_CLOSE_HOUR = 19;
const DEFAULT_APPOINTMENT_MINUTES = 30;
const DEFAULT_LEAD_TIME_HOURS = 24;
const DEFAULT_LOOKAHEAD_DAYS = 14;

function doGet() {
  return jsonResponse({ ok: true, service: "Koe AI phone notifications" });
}

function doPost(event) {
  try {
    const payload = JSON.parse((event.postData && event.postData.contents) || "{}");
    const expectedToken = PropertiesService.getScriptProperties().getProperty("NOTIFICATION_TOKEN") || "";
    if (!expectedToken || !safeEqual(String(payload.token || ""), expectedToken)) {
      return jsonResponse({ ok: false, error: "unauthorized" });
    }
    const action = String(payload.event || payload.action || "");
    if (action === "calendar.availability") return calendarAvailability(payload);
    if (action === "appointment.created" || action === "calendar.create") return calendarCreate(payload);
    if (String(payload.to || "").toLowerCase() !== NOTIFICATION_DESTINATION) return jsonResponse({ ok: false, error: "destination_not_allowed" });

    MailApp.sendEmail({
      to: NOTIFICATION_DESTINATION,
      subject: String(payload.subject || "AI電話受付の着信通知").slice(0, 180),
      body: String(payload.text || "着信がありました。").slice(0, 20000),
      htmlBody: String(payload.html || "").slice(0, 50000),
      name: "Koe AI電話受付",
      // info@ は実行ユーザー自身のエイリアスなので、通常送信では Gmail が
      // 受信トレイへの重複配信を抑止する。Workspace の no-reply 差出人を使う。
      noReply: true
    });

    return jsonResponse({ ok: true, messageId: Utilities.getUuid() });
  } catch (error) {
    console.error(JSON.stringify({ event: "notification_failed", error: String(error) }));
    // The Worker only surfaces this detail to authenticated administrators.
    // It helps distinguish Calendar permission/configuration failures without
    // exposing the webhook token or request payload.
    return jsonResponse({ ok: false, error: "operation_failed", detail: String(error).slice(0, 300) });
  }
}

function calendarAvailability(payload) {
  const durationMinutes = boundedNumber(payload.duration_minutes, 15, 120, DEFAULT_APPOINTMENT_MINUTES);
  const lookaheadDays = boundedNumber(payload.days, 1, 30, DEFAULT_LOOKAHEAD_DAYS);
  const earliest = validDate(payload.from) || new Date(Date.now() + DEFAULT_LEAD_TIME_HOURS * 60 * 60 * 1000);
  const latest = validDate(payload.to) || new Date(earliest.getTime() + lookaheadDays * 24 * 60 * 60 * 1000);
  const maxSlots = boundedNumber(payload.max_slots, 1, 10, 6);
  const slots = availableSlots(earliest, latest, durationMinutes, maxSlots);
  return jsonResponse({ ok: true, timezone: CALENDAR_TIMEZONE, duration_minutes: durationMinutes, slots: slots });
}

function calendarCreate(payload) {
  const startsAt = validDate(payload.starts_at);
  if (!startsAt || startsAt.getTime() <= Date.now()) return jsonResponse({ ok: false, error: "invalid_start_time" });
  const durationMinutes = boundedNumber(payload.duration_minutes, 15, 120, DEFAULT_APPOINTMENT_MINUTES);
  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60 * 1000);
  const calendar = CalendarApp.getDefaultCalendar();
  const marker = "[Koe-ID:" + String(payload.id || "").slice(0, 120) + "]";
  const overlapping = calendar.getEvents(startsAt, endsAt);
  const existing = overlapping.find(function(item) { return String(item.getDescription() || "").indexOf(marker) >= 0; });
  if (existing) return jsonResponse({ ok: true, external_id: existing.getId(), deduplicated: true });
  if (overlapping.length) {
    const alternatives = availableSlots(new Date(Date.now() + DEFAULT_LEAD_TIME_HOURS * 60 * 60 * 1000), new Date(Date.now() + DEFAULT_LOOKAHEAD_DAYS * 24 * 60 * 60 * 1000), durationMinutes, 4);
    return jsonResponse({ ok: false, error: "slot_unavailable", alternatives: alternatives });
  }
  const contactName = String(payload.contact_name || "お名前未確認").slice(0, 100);
  const title = "【AI電話アポ】高卒採用支援 - " + contactName;
  const description = [
    marker,
    "Koe AI電話で受け付けたアポイント",
    "電話番号: " + String(payload.phone || "").slice(0, 50),
    "メール: " + String(payload.email || "").slice(0, 254),
    "内容: " + String(payload.notes || "").slice(0, 1000)
  ].join("\n");
  const created = calendar.createEvent(title, startsAt, endsAt, { description: description });
  return jsonResponse({ ok: true, external_id: created.getId(), starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString() });
}

function availableSlots(earliest, latest, durationMinutes, maxSlots) {
  const calendar = CalendarApp.getDefaultCalendar();
  const slots = [];
  const cursor = new Date(earliest.getTime());
  for (let offset = 0; offset <= 31 && slots.length < maxSlots; offset += 1) {
    const day = new Date(cursor.getTime() + offset * 24 * 60 * 60 * 1000);
    const dateText = Utilities.formatDate(day, CALENDAR_TIMEZONE, "yyyy-MM-dd");
    // Avoid the Java SimpleDateFormat `u` token because its support differs
    // between Apps Script runtimes. Noon JST always maps to the same UTC date.
    const weekday = new Date(dateText + "T12:00:00+09:00").getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    for (let hour = CALENDAR_OPEN_HOUR; hour < CALENDAR_CLOSE_HOUR && slots.length < maxSlots; hour += 1) {
      for (let minute = 0; minute < 60 && slots.length < maxSlots; minute += 30) {
        const start = new Date(dateText + "T" + twoDigits(hour) + ":" + twoDigits(minute) + ":00+09:00");
        const end = new Date(start.getTime() + durationMinutes * 60 * 1000);
        const dayClose = new Date(dateText + "T" + twoDigits(CALENDAR_CLOSE_HOUR) + ":00:00+09:00");
        if (start < earliest || end > latest || end > dayClose) continue;
        if (!calendar.getEvents(start, end).length) slots.push(start.toISOString());
      }
    }
  }
  return slots;
}

function validDate(value) {
  if (!value) return null;
  const parsed = new Date(String(value));
  return isNaN(parsed.getTime()) ? null : parsed;
}

function boundedNumber(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return isFinite(parsed) ? Math.max(minimum, Math.min(maximum, Math.round(parsed))) : fallback;
}

function twoDigits(value) {
  return String(value).padStart(2, "0");
}

function authorizeCalendar() {
  return CalendarApp.getDefaultCalendar().getName();
}

function safeEqual(left, right) {
  const leftHash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, left, Utilities.Charset.UTF_8);
  const rightHash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, right, Utilities.Charset.UTF_8);
  let difference = leftHash.length ^ rightHash.length;
  for (let index = 0; index < Math.min(leftHash.length, rightHash.length); index += 1) {
    difference |= leftHash[index] ^ rightHash[index];
  }
  return difference === 0;
}

function jsonResponse(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}
