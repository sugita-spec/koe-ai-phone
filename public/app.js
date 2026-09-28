let appState = null;
let filter = "all";
const recordings = { greeting: null };
let authRequest = null;
let backgroundRefreshActive = false;
let campaignContacts = [];
let callSearch = "";
let leadSearch = "";
let leadStatusFilter = "all";
let selectedLeadId = "";
const pageMeta = {
  dashboard: ["OVERVIEW", greetingForNow()], leads: ["LEAD OPERATIONS", "リード一覧"], calls: ["CALL RESULTS", "通話結果"], campaigns: ["SCENARIOS", "シナリオ・架電"], callbacks: ["CALLBACK QUEUE", "折り返し管理"], rules: ["INBOUND ROUTING", "受電ルール"], tasks: ["TASKS", "営業タスク"], analytics: ["PERFORMANCE", "架電分析"], voice: ["VOICE STUDIO", "音声"], settings: ["INTEGRATIONS", "連携・設定"], setup: ["CONNECTION GUIDE", "接続ガイド"]
};

function greetingForNow() {
  const hour = new Date().getHours();
  return hour < 11 ? "おはようございます" : hour < 17 ? "こんにちは" : "おつかれさまです";
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function isValidAdminToken(value) {
  return /^[\x21-\x7e]+$/.test(value);
}

function requestAdminToken() {
  if (authRequest) return authRequest;
  const dialog = document.querySelector("#auth-dialog");
  const form = document.querySelector("#auth-form");
  const input = document.querySelector("#admin-token");
  const error = document.querySelector("#auth-error");
  error.textContent = "";
  input.value = "";
  dialog.showModal();
  input.focus();
  authRequest = new Promise((resolve) => {
    const submit = (event) => {
      event.preventDefault();
      const supplied = input.value.trim();
      if (!isValidAdminToken(supplied)) {
        error.textContent = supplied ? "半角英数字の社内パスワードを入力してください。" : "社内パスワードを入力してください。";
        return;
      }
      form.removeEventListener("submit", submit);
      dialog.close();
      authRequest = null;
      resolve(supplied);
    };
    form.addEventListener("submit", submit);
  });
  return authRequest;
}

async function api(path, options = {}, retry = true) {
  const headers = new Headers(options.headers || {});
  const token = sessionStorage.getItem("koe_admin_token");
  if (token && isValidAdminToken(token)) headers.set("authorization", `Bearer ${token}`);
  else if (token) sessionStorage.removeItem("koe_admin_token");
  const response = await fetch(path, { ...options, headers });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 && retry) {
    const supplied = await requestAdminToken();
    if (supplied) {
      sessionStorage.setItem("koe_admin_token", supplied);
      try {
        return await api(path, options, false);
      } catch (error) {
        sessionStorage.removeItem("koe_admin_token");
        if (error.status === 401) {
          document.querySelector("#auth-error").textContent = "社内パスワードが正しくありません。もう一度入力してください。";
          return api(path, options, true);
        }
        throw error;
      }
    }
  }
  if (!response.ok) {
    const error = new Error(payload.error || `エラーが発生しました (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function toast(message, error = false) {
  const element = document.querySelector("#toast");
  element.classList.toggle("error", error);
  element.querySelector("span").textContent = error ? "!" : "✓";
  element.querySelector("p").textContent = message;
  element.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove("show"), 3400);
}

function navigate(page) {
  if (!document.querySelector(`#page-${page}`)) page = "dashboard";
  document.querySelectorAll(".page").forEach((element) => element.classList.toggle("active", element.id === `page-${page}`));
  document.querySelectorAll("[data-nav]").forEach((element) => element.classList.toggle("active", element.dataset.nav === page));
  document.querySelector("#page-eyebrow").textContent = pageMeta[page][0];
  document.querySelector("#page-title").textContent = pageMeta[page][1];
  history.replaceState(null, "", page === "dashboard" ? location.pathname : `#${page}`);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function formatDate(iso) {
  const date = new Date(iso);
  const now = new Date();
  const same = date.toDateString() === now.toDateString();
  return same ? `今日 ${date.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}` : date.toLocaleDateString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatDuration(seconds = 0) {
  if (!seconds) return "—";
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function statusLabel(status) {
  return ({ completed: "完了", demo: "デモ", queued: "発信待ち", ringing: "呼出中", "in-progress": "通話中", failed: "失敗", "no-answer": "応答なし", busy: "話中", voicemail: "留守番電話", canceled: "取消済み" })[status] || status || "受付中";
}

function callMarkup(call) {
  const outgoing = call.direction === "outbound";
  return `<article class="call-row call-row-open" data-call-id="${escapeHtml(call.id || "")}" tabindex="0" role="button" aria-label="${escapeHtml(call.contactName || call.phone || "通話")}の詳細を開く">
    <span class="direction-icon ${outgoing ? "outbound" : ""}">${outgoing ? "↗" : "↙"}</span>
    <div class="call-person"><b>${escapeHtml(call.contactName || "未確認")}</b><small>${escapeHtml(call.phone || "番号非通知")}</small></div>
    <div class="call-purpose"><b>${escapeHtml(call.purpose || "受付")}</b><small>${outgoing ? "こちらから架電" : "着信受付"} · ${formatDuration(call.duration)}</small></div>
    <div class="call-summary">${escapeHtml(call.summary || "要約を作成中です")} ${call.urgency === "high" ? "<small>・至急</small>" : ""}</div>
    <div class="call-meta"><time>${formatDate(call.createdAt)}</time><span class="call-status ${escapeHtml(call.status)}">${statusLabel(call.status)}</span></div>
  </article>`;
}

function callTranscriptText(call) {
  if (typeof call.transcript === "string") return call.transcript;
  const transcript = Array.isArray(call.transcript) ? call.transcript : Array.isArray(call.messages) ? call.messages : [];
  return transcript.map((entry) => {
    if (typeof entry === "string") return entry;
    const speaker = entry.speaker || entry.role || entry.name || "会話";
    return `${speaker === "assistant" ? "AI" : speaker === "user" ? "お相手" : speaker}：${entry.text || entry.content || entry.message || ""}`;
  }).filter(Boolean).join("\n");
}

function normalizedSearchText(value) {
  return String(value || "").normalize("NFKC").toLowerCase().replace(/\s/g, "");
}

function callMatchesSearch(call) {
  if (!callSearch) return true;
  return normalizedSearchText([
    call.contactName, call.companyName, call.phone, call.purpose, call.summary,
    call.memo, call.disposition, callTranscriptText(call)
  ].join(" ")).includes(normalizedSearchText(callSearch));
}

function openCallDetail(call) {
  if (!call) return;
  const transcript = callTranscriptText(call);
  const body = document.querySelector("#call-detail-body");
  const smsReady = Boolean(appState.system?.sms && appState.integrations?.followupSmsEnabled);
  body.innerHTML = `<div class="detail-summary-grid">
    <div><small>日時</small><b>${escapeHtml(formatDate(call.createdAt))}</b></div>
    <div><small>種別</small><b>${call.direction === "outbound" ? "架電" : "着信"}</b></div>
    <div><small>お相手</small><b>${escapeHtml(call.contactName || "未確認")}</b></div>
    <div><small>電話番号</small><b>${escapeHtml(call.phone || "番号非通知")}</b></div>
    <div><small>結果</small><b>${escapeHtml(statusLabel(call.status))}</b></div>
    <div><small>通話時間</small><b>${escapeHtml(formatDuration(call.duration))}</b></div>
  </div>
  <section class="detail-section"><h3>用件・要約</h3><p>${escapeHtml(call.purpose || "受付")}</p><p>${escapeHtml(call.summary || "要約はありません。")}</p></section>
  <section class="detail-section"><h3>会話内容（文字起こし）</h3><pre>${escapeHtml(transcript || "文字起こしはありません。")}</pre></section>
  <div class="detail-actions">
    <button class="secondary resend-notification" type="button" data-call-id="${escapeHtml(call.id || "")}" ${call.direction === "inbound" ? "" : "disabled"}>通知メールを再送</button>
    <button class="primary send-followup-sms" type="button" data-call-id="${escapeHtml(call.id || "")}" ${smsReady ? "" : "disabled"}>${smsReady ? "フォローSMSを送信" : "SMS追客が未設定"}</button>
  </div>`;
  document.querySelector("#call-detail-dialog").showModal();
}

function renderCalls() {
  const calls = appState.calls || [];
  document.querySelector("#recent-calls").innerHTML = calls.slice(0, 4).map(callMarkup).join("") || "<p>通話履歴はまだありません。</p>";
  const shown = (filter === "all" ? calls : calls.filter((call) => call.direction === filter)).filter(callMatchesSearch);
  document.querySelector("#all-calls").innerHTML = shown.map(callMarkup).join("") || "<p>該当する通話はありません。</p>";

  const today = calls.filter((call) => new Date(call.createdAt).toDateString() === new Date().toDateString());
  const completed = today.filter((call) => ["completed", "demo"].includes(call.status));
  const average = completed.length ? completed.reduce((sum, call) => sum + Number(call.duration || 0), 0) / completed.length / 60 : 0;
  const values = [today.length, today.length ? Math.round(completed.length / today.length * 100) : 100, calls.filter((call) => call.summary && call.summary !== "通話中").length, average.toFixed(1)];
  document.querySelectorAll("#metrics strong").forEach((element, index) => { element.textContent = values[index]; });
}

function campaignStatusLabel(status) {
  return ({ running: "実行中", paused: "一時停止", completed: "完了", canceled: "取消済み" })[status] || status;
}

function selectedSalesService() {
  const id = document.querySelector("#campaign-service")?.value;
  return (appState?.salesServices || []).find((service) => service.id === id) || null;
}

function applyCampaignService(force = false) {
  const form = document.querySelector("#campaign-form");
  const summary = document.querySelector("#campaign-service-summary");
  const service = selectedSalesService();
  if (!service) {
    summary.innerHTML = "<p>利用できる営業サービスがありません。</p>";
    return;
  }
  summary.innerHTML = `<b>${escapeHtml(service.name)}</b><p>${escapeHtml(service.description)}</p><small>発信時の会社名：${escapeHtml(service.sellerName)}</small>`;
  if (force || !form.elements.purpose.value.trim()) form.elements.purpose.value = service.purpose;
  if (force || !form.elements.script.value.trim()) form.elements.script.value = service.script;
}

function selectedSingleCallService(form) {
  const id = form?.elements?.serviceId?.value;
  return (appState?.salesServices || []).find((service) => service.id === id) || null;
}

function applySingleCallService(form, force = false) {
  if (!form) return;
  const service = selectedSingleCallService(form);
  const summary = form.querySelector(".single-call-service-summary");
  const previous = (appState?.salesServices || []).find((item) => item.id === form.dataset.appliedServiceId) || null;
  const purpose = form.elements.purpose;
  const script = form.elements.script;
  if (!service) {
    if (force && previous) {
      if (purpose?.value === previous.purpose) purpose.value = "";
      if (script?.value === previous.script) script.value = "";
    }
    form.dataset.appliedServiceId = "";
    if (summary) summary.innerHTML = "<b>通常の単発架電</b><p>予約確認や折り返し連絡など、入力した目的と台本で電話します。</p>";
    return;
  }
  if (force || !purpose?.value.trim()) purpose.value = service.purpose;
  if (script && (force || !script.value.trim())) script.value = service.script;
  form.dataset.appliedServiceId = service.id;
  if (summary) summary.innerHTML = `<b>${escapeHtml(service.name)}</b>
    <p>${escapeHtml(service.description)}</p>
    <small>発信時の会社名：${escapeHtml(service.sellerName)}</small>
    <ol class="service-flow"><li>AIによる営業電話であることと会社名を明示</li><li>採用担当者・代表者への取次ぎを依頼</li><li>現在の高卒採用状況と課題を確認</li><li>支援内容を説明し、オンライン相談の日程を確認</li></ol>
    <p class="service-safety">不要と言われた場合は会話を終了し、今後の電話停止希望は架電停止リストへ反映します。</p>`;
}

function renderSingleCallServices() {
  const services = appState.salesServices || [];
  document.querySelectorAll(".single-call-service").forEach((select) => {
    const form = select.form;
    const current = select.value;
    select.innerHTML = `<option value="">通常の単発架電</option>${services.map((service) => `<option value="${escapeHtml(service.id)}">${escapeHtml(service.name)}</option>`).join("")}`;
    if (!current || services.some((service) => service.id === current)) select.value = current;
    applySingleCallService(form, false);
  });
}

function renderSalesServices() {
  const select = document.querySelector("#campaign-service");
  const services = appState.salesServices || [];
  const current = select.value;
  select.innerHTML = services.map((service) => `<option value="${escapeHtml(service.id)}">${escapeHtml(service.name)}</option>`).join("");
  if (services.some((service) => service.id === current)) select.value = current;
  applyCampaignService(false);
  renderSingleCallServices();
  renderSalesVoiceClips();
}

function renderSalesVoiceClips() {
  const container = document.querySelector("#sales-voice-clips");
  const service = selectedSalesService();
  const definitions = (appState.salesVoiceClipDefinitions || []).filter((clip) => clip.serviceId === service?.id);
  const saved = new Map((appState.salesVoiceClips || []).filter((clip) => clip.serviceId === service?.id).map((clip) => [clip.clipId, clip]));
  const ready = definitions.filter((clip) => saved.has(clip.id)).length;
  document.querySelector("#voice-clip-progress").textContent = `${ready} / ${definitions.length} 保存済み`;
  if (!service || !definitions.length) {
    container.innerHTML = "<p>このサービスの録音フレーズはまだありません。</p>";
    return;
  }
  container.innerHTML = definitions.map((clip) => {
    const stored = saved.get(clip.id);
    const recordingOutdated = Boolean(stored && clip.updatedAt && stored.updatedAt && new Date(stored.updatedAt) < new Date(clip.updatedAt));
    const kind = `sales_${service.id}_${clip.id}`;
    const source = stored ? `/media/service-voice/${encodeURIComponent(service.id)}/${encodeURIComponent(clip.id)}.wav?v=${encodeURIComponent(stored.version)}` : "";
    return `<article class="voice-clip-card" data-service-id="${escapeHtml(service.id)}" data-clip-id="${escapeHtml(clip.id)}">
      <div class="voice-clip-head"><div><small>${escapeHtml(clip.phase)}${clip.automatic ? "・冒頭で自動再生" : "・AI応対用フレーズ"}</small><b>${escapeHtml(clip.title)}</b></div><span class="voice-clip-state ${stored && !recordingOutdated ? "ready" : recordingOutdated ? "outdated" : ""}">${recordingOutdated ? "再録音推奨" : stored ? "保存済み" : "未保存"}</span></div>
      <label class="voice-clip-script-editor"><span>フレーズ内容</span><textarea rows="4" maxlength="500">${escapeHtml(clip.text)}</textarea><small>自由に変更できます。保存後はAIの営業台本にも反映されます。</small></label>
      <div class="voice-phrase-actions"><button class="secondary save-voice-phrase" type="button">文章を保存</button><button class="text-button reset-voice-phrase" type="button" ${clip.customized ? "" : "disabled"}>初期文に戻す</button></div>
      <div class="recorder" data-recorder="${escapeHtml(kind)}" data-max-seconds="${Number(clip.maxSeconds || 20)}">
        <button class="record-button" type="button" aria-label="録音開始・停止"><span></span></button><div><b>タップして録音</b><small>${Number(clip.maxSeconds || 20)}秒以内</small></div><time>00:00</time>
      </div>
      <label class="file-drop">録音済みファイルを選択<input id="${escapeHtml(kind)}-file" type="file" accept="audio/*"></label>
      <div class="voice-clip-actions"><button class="primary upload-sales-voice" type="button" data-kind="${escapeHtml(kind)}">このフレーズを保存</button>${stored ? '<button class="text-button delete-sales-voice" type="button">削除</button>' : ""}</div>
      <audio class="audio-preview" controls ${stored ? `src="${escapeHtml(source)}"` : "hidden"}></audio>
    </article>`;
  }).join("");
  container.querySelectorAll(".recorder").forEach(setupRecorder);
}

function renderCampaigns() {
  const campaigns = appState.campaigns || [];
  document.querySelector("#campaign-list").innerHTML = campaigns.map((campaign) => {
    const done = Number(campaign.completed || 0) + Number(campaign.failed || 0) + Number(campaign.canceled || 0) + Number(campaign.blocked || 0);
    const percent = campaign.total ? Math.round(done / campaign.total * 100) : 0;
    const finished = ["completed", "canceled"].includes(campaign.status);
    const action = finished ? "" : `<div class="campaign-actions"><button class="secondary campaign-toggle" type="button" data-campaign-id="${escapeHtml(campaign.id)}" data-next-status="${campaign.status === "paused" ? "running" : "paused"}">${campaign.status === "paused" ? "再開" : "一時停止"}</button><button class="text-button campaign-cancel" type="button" data-campaign-id="${escapeHtml(campaign.id)}">残りの架電を取消</button></div>`;
    return `<article class="campaign-card">
      <div class="campaign-card-head"><div><b>${escapeHtml(campaign.name)}</b><small>${campaign.serviceName ? `${escapeHtml(campaign.serviceName)} · ` : ""}${escapeHtml(campaign.purpose)}</small></div><span class="call-status ${escapeHtml(campaign.status)}">${campaignStatusLabel(campaign.status)}</span></div>
      <div class="campaign-progress"><i style="width:${percent}%"></i></div>
      <div class="campaign-numbers"><span><b>${campaign.total}</b>登録</span><span><b>${campaign.queued}</b>待機</span><span><b>${campaign.calling}</b>通話中</span><span><b>${campaign.completed}</b>完了</span><span><b>${campaign.failed}</b>未接続</span>${Number(campaign.blocked || 0) ? `<span><b>${campaign.blocked}</b>架電停止</span>` : ""}${Number(campaign.canceled || 0) ? `<span><b>${campaign.canceled}</b>取消</span>` : ""}${action}</div>
    </article>`;
  }).join("") || "<p>架電リストはまだありません。</p>";
}

function numberFrom(source, keys, fallback = 0) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && value !== "") return Number(value) || 0;
  }
  return fallback;
}

function renderCampaignAnalytics() {
  const analytics = appState.analytics || {};
  const outbound = (appState.calls || []).filter((call) => call.direction === "outbound");
  const total = numberFrom(analytics, ["total", "totalCalls", "attempted", "attempts"], outbound.length);
  const connectedFallback = outbound.filter((call) => ["completed", "demo", "in-progress"].includes(call.status)).length;
  const connected = numberFrom(analytics, ["connected", "answered", "completed"], connectedFallback);
  const qualified = numberFrom(analytics, ["qualified", "interested", "leads"], 0);
  const appointments = numberFrom(analytics, ["appointments", "booked"], (appState.appointments || []).length);
  const optOuts = numberFrom(analytics, ["optOuts", "dnc", "doNotCall"], (appState.dnc || []).length);
  const values = [
    ["架電", total, total ? "100%" : "—"],
    ["接続", connected, total ? `${Math.round(connected / total * 100)}%` : "—"],
    ["見込みあり", qualified, connected ? `${Math.round(qualified / connected * 100)}%` : "—"],
    ["アポイント", appointments, connected ? `${Math.round(appointments / connected * 100)}%` : "—"],
    ["架電停止", optOuts, total ? `${Math.round(optOuts / total * 100)}%` : "—"]
  ];
  document.querySelector("#campaign-kpis").innerHTML = values.map(([label, value, rate], index) => `<article class="campaign-kpi"><small>STEP ${index + 1}</small><span>${escapeHtml(label)}</span><strong>${Number(value).toLocaleString("ja-JP")}</strong><em>${escapeHtml(rate)}</em></article>`).join("");
}

function renderDnc() {
  const entries = Array.isArray(appState.dnc) ? appState.dnc : [];
  document.querySelector("#dnc-count").textContent = `${entries.length}件`;
  document.querySelector("#dnc-list").innerHTML = entries.map((entry) => `<article class="simple-list-row">
    <div><b>${escapeHtml(entry.phone || "番号不明")}</b><small>${escapeHtml(entry.reason || "架電停止")}${entry.createdAt ? ` · ${escapeHtml(formatDate(entry.createdAt))}` : ""}</small></div>
    <button class="text-button dnc-remove" type="button" data-phone="${escapeHtml(entry.phone || "")}">解除</button>
  </article>`).join("") || '<p class="empty-message">架電停止中の番号はありません。</p>';
}

function appointmentStatusLabel(status) {
  return ({ pending: "確認待ち", requested: "確認待ち", confirmed: "確定", completed: "完了", canceled: "取消", "no-show": "不参加" })[status] || status || "確認待ち";
}

function renderAppointments() {
  const appointments = Array.isArray(appState.appointments) ? appState.appointments : [];
  document.querySelector("#appointment-count").textContent = `${appointments.length}件`;
  document.querySelector("#appointment-list").innerHTML = appointments.map((appointment) => {
    const startsAt = appointment.startsAt || appointment.scheduledAt || appointment.requestedAt;
    const schedule = startsAt ? formatDate(startsAt) : "希望日時を確認してください";
    const notes = appointment.notes || appointment.note || "";
    const calendarState = appointment.externalId ? " · Googleカレンダー登録済み" : "";
    return `<article class="appointment-row">
      <div class="appointment-copy"><b>${escapeHtml(appointment.contactName || appointment.companyName || "お名前未確認")}</b><small>${escapeHtml(appointment.companyName || appointment.phone || "連絡先未確認")}${escapeHtml(calendarState)}</small><p>${escapeHtml(schedule)}${notes ? ` · ${escapeHtml(notes)}` : ""}</p></div>
      <label>状況<select class="appointment-status" data-appointment-id="${escapeHtml(appointment.id || "")}">
        ${[["requested", "確認待ち"], ["confirmed", "確定"], ["completed", "完了"], ["canceled", "取消"], ["no-show", "不参加"]].map(([value, label]) => `<option value="${value}" ${value === appointment.status ? "selected" : ""}>${label}</option>`).join("")}
      </select></label>
    </article>`;
  }).join("") || '<p class="empty-message">アポイントはまだありません。</p>';
}

function renderIntegrations() {
  const form = document.querySelector("#integrations-form");
  const integrations = appState.integrations || {};
  form.elements.crmWebhookUrl.value = integrations.crmWebhookUrl || "";
  form.elements.calendarWebhookUrl.value = integrations.calendarWebhookUrl || "";
  form.elements.teamChatWebhookUrl.value = integrations.teamChatWebhookUrl || "";
  form.elements.sheetsWebhookUrl.value = integrations.sheetsWebhookUrl || "";
  form.elements.followupSmsEnabled.checked = Boolean(integrations.followupSmsEnabled);
  const status = document.querySelector("#calendar-connection-status");
  status.classList.toggle("ready", Boolean(integrations.calendarEnabled));
  status.querySelector("span").textContent = integrations.calendarEnabled ? "✓" : "○";
  status.querySelector("small").textContent = integrations.calendarEnabled
    ? "空き確認 → 候補案内 → 予定登録が有効です"
    : "未接続です。連携URLを設定してください";
}

function teamRoleLabel(role) {
  return ({ admin: "管理者", operator: "通話・架電担当", viewer: "閲覧のみ" })[role] || role || "通話・架電担当";
}

function renderTeamMembers() {
  const members = Array.isArray(appState.teamMembers) ? appState.teamMembers : [];
  document.querySelector("#team-count").textContent = `${members.length}人`;
  document.querySelector("#team-member-list").innerHTML = members.map((member) => `<article class="simple-list-row">
    <div><b>${escapeHtml(member.name || "名称未設定")}</b><small>${escapeHtml(teamRoleLabel(member.role))}${member.createdAt ? ` · ${escapeHtml(formatDate(member.createdAt))}` : ""}</small></div>
    <button class="text-button team-member-remove" type="button" data-member-id="${escapeHtml(member.id || "")}">削除</button>
  </article>`).join("") || '<p class="empty-message">追加されたメンバーはいません。</p>';
}

function renderServiceManager() {
  const services = Array.isArray(appState.salesServices) ? appState.salesServices : [];
  document.querySelector("#service-admin-list").innerHTML = services.map((service) => `<article class="service-admin-row">
    <div><b>${escapeHtml(service.name || "名称未設定")}</b><small>${escapeHtml(service.sellerName || "会社名未設定")}</small><p>${escapeHtml(service.description || service.purpose || "説明未設定")}</p></div>
    <div class="service-admin-actions"><button class="secondary service-edit" type="button" data-service-id="${escapeHtml(service.id || "")}">編集</button>${service.id === "high_school_recruiting_support" ? "" : `<button class="text-button service-delete" type="button" data-service-id="${escapeHtml(service.id || "")}">利用停止</button>`}</div>
  </article>`).join("") || '<p class="empty-message">営業サービスはまだありません。</p>';
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted && char === '"' && text[index + 1] === '"') { field += '"'; index += 1; continue; }
    if (char === '"') { quoted = !quoted; continue; }
    if (!quoted && char === ",") { row.push(field); field = ""; continue; }
    if (!quoted && (char === "\n" || char === "\r")) {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      row.push(field); field = "";
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      continue;
    }
    field += char;
  }
  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  return rows;
}

function normalizedHeader(value) {
  return String(value || "").replace(/^\uFEFF/, "").normalize("NFKC").trim().toLowerCase().replace(/[ _-]/g, "");
}

function domesticPhone(value) {
  const digits = String(value || "").normalize("NFKC").replace(/[\s\-‐‑‒–—―ー−()（）.]/g, "");
  return /^0\d{9,10}$/.test(digits) ? digits : "";
}

async function readCampaignCsv(file) {
  if (!file || file.size > 2 * 1024 * 1024) throw new Error("CSVは2MB以下にしてください");
  const buffer = await file.arrayBuffer();
  let text = new TextDecoder("utf-8").decode(buffer);
  if (text.includes("�")) text = new TextDecoder("shift-jis").decode(buffer);
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error("見出し行と1件以上の連絡先が必要です");
  const headers = rows[0].map(normalizedHeader);
  const find = (...names) => headers.findIndex((header) => names.includes(header));
  const phoneIndex = find("電話番号", "電話", "tel", "phone", "phonenumber");
  const nameIndex = find("氏名", "名前", "担当者名", "contactname", "name");
  const companyIndex = find("会社名", "企業名", "法人名", "company", "companyname");
  const noteIndex = find("個別メモ", "メモ", "備考", "note", "notes");
  const industryIndex = find("業種", "業界", "industry");
  const companySizeIndex = find("従業員数", "企業規模", "companysize", "employees");
  const sourceIndex = find("取得元", "流入元", "source");
  const allowedIndex = find("架電可否", "架電", "call", "callallowed");
  if (phoneIndex < 0) throw new Error("『電話番号』列が見つかりません");
  const seen = new Set();
  let invalid = 0;
  let blocked = 0;
  let duplicates = 0;
  const contacts = [];
  rows.slice(1).forEach((values) => {
    const allowed = allowedIndex >= 0 ? String(values[allowedIndex] || "").normalize("NFKC").trim().toLowerCase() : "";
    if (/^(不可|停止|拒否|ng|no|false|0)$/.test(allowed)) { blocked += 1; return; }
    const phone = domesticPhone(values[phoneIndex]);
    if (!phone) { invalid += 1; return; }
    if (seen.has(phone)) { duplicates += 1; return; }
    seen.add(phone);
    contacts.push({
      companyName: companyIndex >= 0 ? String(values[companyIndex] || "").trim() : "",
      contactName: nameIndex >= 0 ? String(values[nameIndex] || "").trim() : "",
      phone,
      note: noteIndex >= 0 ? String(values[noteIndex] || "").trim() : "",
      industry: industryIndex >= 0 ? String(values[industryIndex] || "").trim() : "",
      companySize: companySizeIndex >= 0 ? String(values[companySizeIndex] || "").trim() : "",
      source: sourceIndex >= 0 ? String(values[sourceIndex] || "").trim() : "CSV"
    });
  });
  if (contacts.length > 500) throw new Error("1回の登録は500件までです");
  if (!contacts.length) throw new Error("架電可能な日本の電話番号がありません");
  return { contacts, invalid, blocked, duplicates };
}

function renderCampaignPreview(result) {
  const rows = result.contacts.slice(0, 5).map((contact) => `<tr><td>${escapeHtml(contact.companyName || "—")}</td><td>${escapeHtml(contact.contactName || "ご担当者")}</td><td>${escapeHtml(contact.phone)}</td><td>${escapeHtml(contact.note || "—")}</td></tr>`).join("");
  document.querySelector("#campaign-preview").innerHTML = `<div class="campaign-import-summary"><b>${result.contacts.length}件を架電対象として読み込みました</b><small>番号不正 ${result.invalid}件・重複 ${result.duplicates}件・架電停止 ${result.blocked}件を除外</small></div><div class="campaign-table-wrap"><table><thead><tr><th>会社名</th><th>氏名</th><th>電話番号</th><th>個別メモ</th></tr></thead><tbody>${rows}</tbody></table></div>${result.contacts.length > 5 ? `<p>ほか ${result.contacts.length - 5}件</p>` : ""}`;
}

function fillSettings() {
  const form = document.querySelector("#settings-form");
  for (const [key, value] of Object.entries(appState.settings)) {
    const field = form.elements[key];
    if (!field) continue;
    if (field.type === "checkbox") field.checked = Boolean(value);
    else field.value = value ?? "";
  }
  document.querySelector("#reception-enabled").checked = appState.settings.enabled;
  document.querySelector("#hero-greeting").textContent = appState.settings.greeting;
  document.querySelector("#agent-name").textContent = `${appState.settings.agentName} · ${appState.settings.businessName}`;
  document.querySelector("#business-hours").textContent = appState.settings.businessHours;
}

function renderStatus() {
  const { system, settings } = appState;
  const live = !system.demo && system.openai && system.project;
  const pill = document.querySelector("#mode-pill");
  pill.className = `mode-pill ${live ? "live" : "demo"}`;
  pill.querySelector("b").textContent = live ? "本番接続" : "デモモード";
  const dot = document.querySelector(".status-dot");
  dot.classList.toggle("live", appState.settings.enabled);
  document.querySelector("#sidebar-status").textContent = appState.settings.enabled ? "受付中" : "停止中";

  const ready = Boolean(settings.greetingRecordingEnabled);
  const badge = document.querySelector("#voice-ready");
  badge.classList.toggle("ready", ready);
  badge.querySelector("span").textContent = ready ? "✓" : "○";
  badge.querySelector("b").textContent = ready ? "本人の挨拶を利用中" : "未登録";
  badge.querySelector("small").textContent = ready ? "着信の冒頭で再生します" : "約10秒で完了";
  document.querySelector("#greeting-status").textContent = ready ? "登録済み・着信時に利用中です" : "まだ登録されていません";
  const preview = document.querySelector("#greeting-preview");
  const deleteButton = document.querySelector("#delete-greeting");
  preview.hidden = !ready;
  deleteButton.hidden = !ready;
  if (ready) {
    const source = `/media/greeting.wav?v=${encodeURIComponent(settings.greetingRecordingVersion || "current")}`;
    if (preview.getAttribute("src") !== source) preview.setAttribute("src", source);
  } else {
    preview.removeAttribute("src");
  }

  const items = [
    [system.openai, "OpenAI API", "APIキーを .env に設定"],
    [system.webhookSecret, "着信Webhook", "署名シークレットを設定"],
    [system.project, "SIP接続", "OpenAI Project IDを設定"],
    [system.twilio, "電話回線", "Twilio番号と認証情報を設定"]
  ];
  document.querySelector("#setup-grid").innerHTML = items.map(([done, title, text], index) => `<article class="setup-item ${done ? "done" : ""}"><span class="setup-check">${done ? "✓" : index + 1}</span><b>${title}</b><p>${done ? "設定済みです。" : text}</p></article>`).join("");
}

function leadOutcomeLabel(value) {
  return ({ connected: "接続", interested: "興味あり", callback: "折り返し", appointment: "アポイント", do_not_call: "架電停止", voicemail: "留守電", no_answer: "不在" })[value] || statusLabel(value);
}

function renderLeadDetail(lead) {
  const target = document.querySelector("#lead-detail");
  if (!lead) { target.className = "lead-detail-empty"; target.textContent = "リードを選択すると詳細が表示されます。"; return; }
  target.className = "lead-detail-content";
  const call = (appState.calls || []).find((item) => item.id === lead.callId || domesticPhone(item.phone) === domesticPhone(lead.phone));
  target.innerHTML = `<div class="lead-identity"><span class="lead-avatar">${escapeHtml((lead.companyName || lead.contactName || "?").slice(0, 1))}</span><div><h3>${escapeHtml(lead.companyName || "会社名未登録")}</h3><p>${escapeHtml(lead.contactName || "担当者未確認")} · ${escapeHtml(lead.phone)}</p></div><span class="call-status ${escapeHtml(lead.status)}">${escapeHtml(leadOutcomeLabel(lead.disposition || lead.status))}</span></div>
    <div class="lead-facts"><div><small>キャンペーン</small><b>${escapeHtml(lead.campaignName || "—")}</b></div><div><small>架電回数</small><b>${Number(lead.attemptCount || 0)} / ${Number(lead.maxAttempts || 0)}</b></div><div><small>台本</small><b>パターン ${escapeHtml(lead.variant || "A")}</b></div><div><small>次回対応</small><b>${lead.callbackAt || lead.nextAttemptAt ? escapeHtml(formatDate(lead.callbackAt || lead.nextAttemptAt)) : "未設定"}</b></div></div>
    <div class="timeline"><article><i></i><small>${escapeHtml(formatDate(lead.createdAt))}</small><b>リストへ登録</b><p>${escapeHtml(lead.source || "CSV")} · ${escapeHtml(lead.note || "個別メモなし")}</p></article>${call ? `<article><i></i><small>${escapeHtml(formatDate(call.createdAt))}</small><b>${escapeHtml(leadOutcomeLabel(lead.disposition || call.status))}</b><p>${escapeHtml(call.summary || "通話内容を処理中です")}</p><button class="text-button lead-open-call" data-call-id="${escapeHtml(call.id)}">録音・文字起こしを確認 →</button></article>` : ""}</div>`;
}

function renderLeads() {
  const leads = appState.leads || [];
  const filtered = leads.filter((lead) => (leadStatusFilter === "all" || lead.status === leadStatusFilter) && normalizedSearchText([lead.companyName, lead.contactName, lead.phone, lead.campaignName].join(" ")).includes(normalizedSearchText(leadSearch)));
  document.querySelector("#lead-count").textContent = `${filtered.length}件`;
  document.querySelector("#lead-kpis").innerHTML = [["登録リード", leads.length], ["発信待ち", leads.filter((x) => x.status === "queued").length], ["接続", leads.filter((x) => ["connected", "interested", "callback", "appointment"].includes(x.disposition)).length], ["アポイント", leads.filter((x) => x.disposition === "appointment").length]].map(([label, value]) => `<article><small>${label}</small><strong>${value}</strong><span>件</span></article>`).join("");
  document.querySelector("#lead-list").innerHTML = filtered.map((lead) => `<button class="dense-lead ${lead.id === selectedLeadId ? "active" : ""}" data-lead-id="${escapeHtml(lead.id)}"><span class="lead-avatar">${escapeHtml((lead.companyName || lead.contactName || "?").slice(0, 1))}</span><span><b>${escapeHtml(lead.companyName || "会社名未登録")}</b><small>${escapeHtml(lead.contactName || "担当者未確認")} · ${escapeHtml(lead.phone)}</small></span><em>${escapeHtml(leadOutcomeLabel(lead.disposition || lead.status))}</em></button>`).join("") || '<p class="empty-message">条件に合うリードはありません。</p>';
  const selected = leads.find((lead) => lead.id === selectedLeadId) || filtered[0];
  if (selected && !selectedLeadId) selectedLeadId = selected.id;
  renderLeadDetail(selected);
  const callbacks = leads.filter((x) => x.disposition === "callback" || x.callbackAt).length;
  document.querySelector("#lead-side-summary").innerHTML = `<div class="side-stat"><small>本日の発信対象</small><strong>${leads.filter((x) => x.status === "queued").length}</strong></div><div class="side-stat"><small>折り返し待ち</small><strong>${callbacks}</strong></div><div class="side-stat"><small>架電停止</small><strong>${leads.filter((x) => x.status === "blocked" || x.disposition === "do_not_call").length}</strong></div><button class="secondary wide" data-nav="callbacks">折り返し一覧を開く</button>`;
}

function renderCallbacks() {
  const leads = (appState.leads || []).filter((lead) => lead.disposition === "callback" || lead.callbackAt || lead.nextAttemptAt);
  document.querySelector("#callback-count").textContent = `${leads.length}件`;
  document.querySelector("#callback-list").innerHTML = leads.map((lead) => `<div class="dense-table-row"><div><b>${escapeHtml(lead.companyName || lead.contactName || "未確認")}</b><small>${escapeHtml(lead.phone)} · ${escapeHtml(lead.campaignName || "")}</small></div><span>${escapeHtml(formatDate(lead.callbackAt || lead.nextAttemptAt))}</span><em>${escapeHtml(leadOutcomeLabel(lead.disposition || lead.status))}</em></div>`).join("") || '<p class="empty-message">折り返し・再架電の予定はありません。</p>';
}

function renderTasks() {
  const tasks = appState.tasks || [];
  document.querySelector("#task-count").textContent = `${tasks.filter((task) => task.status === "open").length}件`;
  document.querySelector("#task-list").innerHTML = tasks.map((task) => `<label class="task-row ${task.status === "done" ? "done" : ""}"><input class="task-status" data-task-id="${escapeHtml(task.id)}" type="checkbox" ${task.status === "done" ? "checked" : ""}><span><b>${escapeHtml(task.title)}</b><small>${task.dueAt ? `期限 ${escapeHtml(formatDate(task.dueAt))}` : "期限なし"}${task.assignedTo ? ` · ${escapeHtml(task.assignedTo)}` : ""}</small><p>${escapeHtml(task.notes || "")}</p></span><em>${escapeHtml(({ followup: "フォロー", callback: "折り返し", review: "確認", appointment: "商談" })[task.kind] || "タスク")}</em></label>`).join("") || '<p class="empty-message">タスクはありません。</p>';
}

function renderInboundRules() {
  const rules = appState.inboundRules || [];
  const condition = { always: "すべての着信", business_hours: "営業時間内", outside_hours: "営業時間外", caller_prefix: "番号条件" };
  const action = { ai_reception: "AI受付", take_message: "伝言受付", transfer: "有人転送", reject: "受付しない" };
  document.querySelector("#inbound-rule-list").innerHTML = rules.map((rule) => `<article class="rule-row"><span class="rule-order">${Number(rule.priority || 0)}</span><div><b>${escapeHtml(rule.name)}</b><small>${escapeHtml(condition[rule.conditionType] || rule.conditionType)} → ${escapeHtml(action[rule.actionType] || rule.actionType)}</small></div><label class="mini-toggle"><input class="rule-toggle" data-rule-id="${escapeHtml(rule.id)}" type="checkbox" ${rule.enabled ? "checked" : ""}><span></span></label></article>`).join("") || '<p class="empty-message">受電ルールはありません。</p>';
}

function renderAdvancedAnalytics() {
  const leads = appState.leads || [];
  const calls = (appState.calls || []).filter((call) => call.direction === "outbound");
  const attempted = leads.filter((x) => Number(x.attemptCount) > 0).length;
  const connected = leads.filter((x) => ["connected", "interested", "callback", "appointment"].includes(x.disposition)).length;
  const interested = leads.filter((x) => ["interested", "appointment"].includes(x.disposition)).length;
  const appointments = leads.filter((x) => x.disposition === "appointment").length;
  document.querySelector("#analytics-kpis").innerHTML = [["総発信", attempted], ["接続率", attempted ? `${Math.round(connected / attempted * 100)}%` : "—"], ["受付突破", interested], ["アポイント", appointments]].map(([label, value]) => `<article><small>${label}</small><strong>${value}</strong></article>`).join("");
  const funnel = [["発信", attempted], ["接続", connected], ["興味", interested], ["アポイント", appointments]];
  const max = Math.max(1, ...funnel.map(([, value]) => Number(value)));
  document.querySelector("#conversion-funnel").innerHTML = funnel.map(([label, value]) => `<div class="funnel-row"><span>${label}</span><i><b style="width:${Math.max(3, Number(value) / max * 100)}%"></b></i><strong>${value}</strong></div>`).join("");
  const cells = Array.from({ length: 7 }, () => Array(12).fill(0));
  calls.forEach((call) => { const date = new Date(call.createdAt); const hour = date.getHours(); if (hour >= 8 && hour < 20) cells[date.getDay()][hour - 8] += 1; });
  const heatMax = Math.max(1, ...cells.flat());
  document.querySelector("#activity-heatmap").innerHTML = `<div></div>${Array.from({length:12},(_,i)=>`<small>${i+8}</small>`).join("")}${["日","月","火","水","木","金","土"].map((day, d) => `<b>${day}</b>${cells[d].map((value) => `<i title="${day}曜 ${value}件" style="--heat:${value / heatMax}"></i>`).join("")}`).join("")}`;
  const variants = appState.analytics?.variants || [];
  document.querySelector("#variant-ranking").innerHTML = variants.map((variant) => `<div class="variant-row"><b>台本 ${escapeHtml(variant.variant)}</b><span>接続 ${Number(variant.connected || 0)}件</span><span>アポ ${Number(variant.appointments || 0)}件</span></div>`).join("") || '<p class="empty-message">A/Bテストを開始すると比較できます。</p>';
  const suggestions = [];
  if (!attempted) suggestions.push("まず架電リストを登録し、母数を集めましょう。");
  else if (connected / attempted < .25) suggestions.push("接続率が25%未満です。時間帯別の結果を見て発信枠を調整してください。");
  if (connected && appointments / connected < .1) suggestions.push("接続後のアポイント率が低めです。冒頭30秒の台本A/Bテストをおすすめします。");
  if ((appState.dnc || []).length) suggestions.push("架電停止リストは全キャンペーンに自動適用されています。");
  if (!suggestions.length) suggestions.push("大きな異常はありません。業種・企業規模別に勝ちパターンを保存しましょう。");
  document.querySelector("#improvement-list").innerHTML = suggestions.map((text, index) => `<article><span>${index + 1}</span><p>${escapeHtml(text)}</p></article>`).join("");
}

function render() {
  fillSettings();
  renderCalls();
  renderSalesServices();
  renderCampaigns();
  renderCampaignAnalytics();
  renderDnc();
  renderAppointments();
  renderIntegrations();
  renderTeamMembers();
  renderServiceManager();
  renderLeads();
  renderCallbacks();
  renderTasks();
  renderInboundRules();
  renderAdvancedAnalytics();
  renderStatus();
}

async function refresh() {
  appState = await api("/api/state");
  render();
}

async function refreshCallsSilently() {
  if (!appState || backgroundRefreshActive || document.hidden || authRequest) return;
  backgroundRefreshActive = true;
  try {
    const next = await api("/api/state");
    appState.calls = next.calls;
    appState.campaigns = next.campaigns;
    appState.analytics = next.analytics;
    appState.dnc = next.dnc;
    appState.appointments = next.appointments;
    appState.integrations = next.integrations;
    appState.teamMembers = next.teamMembers;
    appState.leads = next.leads;
    appState.tasks = next.tasks;
    appState.inboundRules = next.inboundRules;
    appState.salesServices = next.salesServices || appState.salesServices;
    appState.system = next.system;
    appState.settings.enabled = next.settings.enabled;
    renderCalls();
    renderCampaigns();
    renderCampaignAnalytics();
    renderDnc();
    renderAppointments();
    renderIntegrations();
    renderTeamMembers();
    renderServiceManager();
    renderLeads();
    renderCallbacks();
    renderTasks();
    renderInboundRules();
    renderAdvancedAnalytics();
    renderStatus();
  } catch (error) {
    if (error.status !== 401) console.warn("通話履歴の自動更新に失敗しました", error);
  } finally {
    backgroundRefreshActive = false;
  }
}

async function submitCall(form) {
  const button = form.querySelector("button[type=submit]");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "発信を準備中…";
  try {
    const body = Object.fromEntries(new FormData(form));
    const result = await api("/api/outbound", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    await refresh();
    toast(result.demo ? "デモ架電を通話履歴に追加しました" : "架電を開始しました");
    form.reset();
    applySingleCallService(form, true);
    const dialog = document.querySelector("#dialer-dialog");
    if (dialog.open) dialog.close();
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; button.textContent = original; }
}

async function submitCampaign(form) {
  if (!campaignContacts.length) throw new Error("電話リストのCSVを選択してください");
  const button = form.querySelector("button[type=submit]");
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "リストを登録中…";
  try {
    const data = Object.fromEntries(new FormData(form));
    const payload = {
      name: data.name,
      serviceId: data.serviceId,
      purpose: data.purpose,
      script: data.script,
      variantBScript: data.variantBScript || "",
      maxAttempts: Number(data.maxAttempts || 1),
      retryMinutes: Number(data.retryMinutes || 60),
      voicemailAction: data.voicemailAction || "retry",
      dailyLimit: Number(data.dailyLimit || 200),
      maxConcurrency: Number(data.maxConcurrency || 1),
      paceSeconds: Number(data.paceSeconds || 60),
      startHour: Number(data.startHour || 10),
      endHour: Number(data.endHour || 19),
      allowedWeekdays: data.allowedWeekdays || "1,2,3,4,5",
      transferNumber: data.transferNumber || "",
      confirmed: form.elements.confirmed.checked,
      contacts: campaignContacts
    };
    const result = await api("/api/campaigns", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    appState.campaigns = result.campaigns;
    renderCampaigns();
    const waiting = !result.campaign.process?.started;
    toast(waiting ? `${result.campaign.total}件を登録しました。設定した時間帯に順次発信します` : `${result.campaign.total}件を登録し、架電を開始しました`);
    form.reset();
    renderSalesServices();
    applyCampaignService(true);
    campaignContacts = [];
    document.querySelector("#campaign-preview").innerHTML = "<p>CSVを選ぶと、ここに確認結果が表示されます。</p>";
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

function formSettings(form) {
  const data = Object.fromEntries(new FormData(form));
  data.recordingNotice = form.elements.recordingNotice.checked;
  data.dataRetentionDays = Number(form.elements.dataRetentionDays.value || 90);
  data.enabled = appState.settings.enabled;
  return data;
}

async function saveSettings(patch = {}) {
  const body = { ...formSettings(document.querySelector("#settings-form")), ...patch };
  appState = await api("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  render();
}

function selectedAudio(kind) {
  if (recordings[kind]) return recordings[kind];
  return document.querySelector(`#${kind}-file`).files[0] || null;
}

function writeAscii(view, offset, value) {
  for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
}

async function toPhoneWav(file, maxSeconds = 20) {
  if (file.size > 20 * 1024 * 1024) throw new Error("音声ファイルは20MB以下にしてください");
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) throw new Error("このブラウザーでは音声変換を利用できません");
  const context = new AudioContextClass();
  try {
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    if (!decoded.duration || decoded.duration > maxSeconds) throw new Error(`このフレーズは${maxSeconds}秒以内にしてください`);
    const sourceRate = decoded.sampleRate;
    const targetRate = 8000;
    const mono = new Float32Array(decoded.length);
    for (let channel = 0; channel < decoded.numberOfChannels; channel += 1) {
      const samples = decoded.getChannelData(channel);
      for (let index = 0; index < mono.length; index += 1) mono[index] += samples[index] / decoded.numberOfChannels;
    }
    const outputLength = Math.max(1, Math.round(mono.length * targetRate / sourceRate));
    const output = new Float32Array(outputLength);
    for (let index = 0; index < outputLength; index += 1) {
      const sourcePosition = index * sourceRate / targetRate;
      const left = Math.floor(sourcePosition);
      const right = Math.min(left + 1, mono.length - 1);
      const fraction = sourcePosition - left;
      output[index] = mono[left] * (1 - fraction) + mono[right] * fraction;
    }
    const buffer = new ArrayBuffer(44 + output.length * 2);
    const view = new DataView(buffer);
    writeAscii(view, 0, "RIFF");
    view.setUint32(4, 36 + output.length * 2, true);
    writeAscii(view, 8, "WAVE");
    writeAscii(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, targetRate, true);
    view.setUint32(28, targetRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, "data");
    view.setUint32(40, output.length * 2, true);
    for (let index = 0; index < output.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, output[index]));
      view.setInt16(44 + index * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }
    return new File([buffer], "greeting.wav", { type: "audio/wav" });
  } catch (error) {
    if (error.message?.includes("秒以内")) throw error;
    throw new Error("音声を読み込めませんでした。サイトで録音し直してください");
  } finally {
    await context.close().catch(() => {});
  }
}

function setupRecorder(container) {
  if (container.dataset.recorderReady === "true") return;
  container.dataset.recorderReady = "true";
  const kind = container.dataset.recorder;
  const button = container.querySelector(".record-button");
  const title = container.querySelector("b");
  const time = container.querySelector("time");
  let recorder;
  let stream;
  let timer;
  let started;
  let chunks = [];
  const maxSeconds = Number(container.dataset.maxSeconds || 30);

  button.addEventListener("click", async () => {
    if (recorder?.state === "recording") return recorder.stop();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      chunks = [];
      const preferred = ["audio/webm;codecs=opus", "audio/mp4"].find((type) => MediaRecorder.isTypeSupported?.(type));
      recorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream);
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = () => {
        clearInterval(timer);
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        recordings[kind] = new File([blob], `${kind}-${Date.now()}`, { type: blob.type });
        const preview = container.closest(".voice-clip-card")?.querySelector("audio");
        if (preview) {
          const previous = preview.dataset.localUrl;
          if (previous) URL.revokeObjectURL(previous);
          const localUrl = URL.createObjectURL(blob);
          preview.dataset.localUrl = localUrl;
          preview.src = localUrl;
          preview.hidden = false;
        }
        container.classList.remove("recording");
        title.textContent = "録音できました";
        toast("音声を録音しました");
      };
      recorder.start();
      started = Date.now();
      container.classList.add("recording");
      title.textContent = "録音中… タップで停止";
      timer = setInterval(() => {
        const seconds = Math.floor((Date.now() - started) / 1000);
        time.textContent = `00:${String(seconds).padStart(2, "0")}`;
        if (seconds >= maxSeconds) recorder.stop();
      }, 250);
    } catch (error) { toast(`マイクを使えません: ${error.message}`, true); }
  });
}

async function downloadProtectedFile(path, filename, retry = true) {
  const headers = new Headers();
  const token = sessionStorage.getItem("koe_admin_token");
  if (token && isValidAdminToken(token)) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(path, { headers });
  if (response.status === 401 && retry) {
    const supplied = await requestAdminToken();
    if (supplied) {
      sessionStorage.setItem("koe_admin_token", supplied);
      return downloadProtectedFile(path, filename, false);
    }
  }
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `CSVを出力できませんでした (${response.status})`);
  }
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function openServiceEditor(service = null) {
  const form = document.querySelector("#service-form");
  form.hidden = false;
  form.reset();
  form.elements.id.value = service?.id || "";
  ["name", "sellerName", "purpose", "description", "script"].forEach((key) => {
    form.elements[key].value = service?.[key] || "";
  });
  form.querySelector("button[type=submit]").textContent = service ? "変更を保存" : "サービスを追加";
  form.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

document.querySelectorAll("[data-nav]").forEach((button) => button.addEventListener("click", (event) => { event.preventDefault(); navigate(button.dataset.nav); }));
document.querySelector("#lead-search").addEventListener("input", (event) => { leadSearch = event.currentTarget.value; renderLeads(); });
document.querySelector("#lead-status-filter").addEventListener("change", (event) => { leadStatusFilter = event.currentTarget.value; renderLeads(); });
document.querySelector("#lead-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-lead-id]");
  if (!button) return;
  selectedLeadId = button.dataset.leadId;
  renderLeads();
});
document.querySelector("#lead-detail").addEventListener("click", (event) => {
  const button = event.target.closest(".lead-open-call");
  if (button) openCallDetail((appState.calls || []).find((call) => call.id === button.dataset.callId));
});
document.querySelector("#lead-side-summary").addEventListener("click", (event) => {
  const button = event.target.closest("[data-nav]");
  if (button) navigate(button.dataset.nav);
});
document.querySelector("#task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const result = await api("/api/tasks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    appState.tasks = result.tasks; form.reset(); renderTasks(); toast("タスクを追加しました");
  } catch (error) { toast(error.message, true); }
});
document.querySelector("#task-list").addEventListener("change", async (event) => {
  const input = event.target.closest(".task-status");
  if (!input) return;
  try {
    const result = await api(`/api/tasks/${encodeURIComponent(input.dataset.taskId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: input.checked ? "done" : "open" }) });
    appState.tasks = result.tasks; renderTasks();
  } catch (error) { input.checked = !input.checked; toast(error.message, true); }
});
document.querySelector("#inbound-rule-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const result = await api("/api/inbound-rules", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(new FormData(form))) });
    appState.inboundRules = result.inboundRules; form.reset(); renderInboundRules(); toast("受電ルールを追加しました");
  } catch (error) { toast(error.message, true); }
});
document.querySelector("#inbound-rule-list").addEventListener("change", async (event) => {
  const input = event.target.closest(".rule-toggle");
  if (!input) return;
  try {
    const result = await api(`/api/inbound-rules/${encodeURIComponent(input.dataset.ruleId)}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: input.checked }) });
    appState.inboundRules = result.inboundRules; renderInboundRules();
  } catch (error) { input.checked = !input.checked; toast(error.message, true); }
});
document.querySelector("#download-monthly-report").addEventListener("click", () => {
  const leads = appState.leads || [];
  const rows = [["会社名","担当者","電話番号","キャンペーン","状態","結果","架電回数","折り返し日時","業種","企業規模"], ...leads.map((lead) => [lead.companyName, lead.contactName, lead.phone, lead.campaignName, lead.status, leadOutcomeLabel(lead.disposition), lead.attemptCount, lead.callbackAt || "", lead.industry, lead.companySize])];
  const csv = `\uFEFF${rows.map((row) => row.map((value) => `"${String(value ?? "").replaceAll('"','""')}"`).join(",")).join("\r\n")}`;
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a"); link.href = url; link.download = `Koe月次レポート-${new Date().toISOString().slice(0,7)}.csv`; link.click(); URL.revokeObjectURL(url);
});
document.querySelectorAll("[data-open-dialer]").forEach((button) => button.addEventListener("click", () => {
  applySingleCallService(document.querySelector("#dialer-form"), false);
  document.querySelector("#dialer-dialog").showModal();
}));
document.querySelector("[data-close-dialog]").addEventListener("click", () => document.querySelector("#dialer-dialog").close());
document.querySelector("#quick-dial-form").addEventListener("submit", (event) => { event.preventDefault(); submitCall(event.currentTarget); });
document.querySelector("#dialer-form").addEventListener("submit", (event) => { event.preventDefault(); submitCall(event.currentTarget); });
document.querySelectorAll(".single-call-service").forEach((select) => select.addEventListener("change", (event) => {
  applySingleCallService(event.currentTarget.form, true);
}));
document.querySelector("#campaign-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try { await submitCampaign(event.currentTarget); }
  catch (error) { toast(error.message, true); }
});
document.querySelector("#campaign-service").addEventListener("change", () => {
  applyCampaignService(true);
  renderSalesVoiceClips();
});
document.querySelector("#campaign-file").addEventListener("change", async (event) => {
  try {
    const result = await readCampaignCsv(event.currentTarget.files[0]);
    campaignContacts = result.contacts;
    renderCampaignPreview(result);
  } catch (error) {
    campaignContacts = [];
    document.querySelector("#campaign-preview").innerHTML = `<p class="form-error">${escapeHtml(error.message)}</p>`;
  }
});
document.querySelector("#download-campaign-template").addEventListener("click", () => {
  const csv = "\uFEFF会社名,氏名,電話番号,個別メモ,業種,従業員数,取得元,架電可否\n株式会社サンプル,田中太郎,03-1234-5678,高卒採用を実施,製造業,120,展示会,可\nサンプル商店,,090-1234-5678,担当者様宛,小売,12,問い合わせ,可\n";
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "電話リスト見本.csv";
  link.click();
  URL.revokeObjectURL(url);
});
document.querySelector("#campaign-list").addEventListener("click", async (event) => {
  const button = event.target.closest(".campaign-toggle, .campaign-cancel");
  if (!button) return;
  const canceling = button.classList.contains("campaign-cancel");
  if (canceling && !window.confirm("待機中の架電をすべて取り消します。取り消したリストは再開できません。よろしいですか？")) return;
  button.disabled = true;
  try {
    const result = await api(`/api/campaigns/${encodeURIComponent(button.dataset.campaignId)}/status`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: canceling ? "canceled" : button.dataset.nextStatus })
    });
    appState.campaigns = result.campaigns;
    renderCampaigns();
    toast(canceling ? "待機中の架電を取り消しました" : result.status === "paused" ? "架電リストを一時停止しました" : "架電リストを再開しました");
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});

document.querySelector("#dnc-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(form));
    await api("/api/dnc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    form.reset();
    await refresh();
    toast("架電停止リストへ追加しました");
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});

document.querySelector("#dnc-list").addEventListener("click", async (event) => {
  const button = event.target.closest(".dnc-remove");
  if (!button || !window.confirm(`${button.dataset.phone} の架電停止を解除しますか？`)) return;
  button.disabled = true;
  try {
    await api(`/api/dnc/${encodeURIComponent(button.dataset.phone)}`, { method: "DELETE" });
    await refresh();
    toast("架電停止を解除しました");
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});

document.querySelector("#appointment-list").addEventListener("change", async (event) => {
  const select = event.target.closest(".appointment-status");
  if (!select) return;
  const previous = (appState.appointments || []).find((item) => item.id === select.dataset.appointmentId)?.status || "requested";
  select.disabled = true;
  try {
    await api(`/api/appointments/${encodeURIComponent(select.dataset.appointmentId)}/status`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: select.value }) });
    await refresh();
    toast(`アポイントを「${appointmentStatusLabel(select.value)}」に変更しました`);
  } catch (error) {
    select.value = previous;
    toast(error.message, true);
  } finally { select.disabled = false; }
});

document.querySelector("#integrations-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(form));
    data.followupSmsEnabled = form.elements.followupSmsEnabled.checked;
    await api("/api/integrations", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    await refresh();
    toast("外部サービスの連携設定を保存しました");
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});

document.querySelector("#check-calendar-availability").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = "Googleカレンダーを確認中…";
  try {
    const result = await api("/api/calendar/availability", { method: "POST" });
    const labels = (result.slots || []).slice(0, 3).map((slot) => new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit"
    }).format(new Date(slot)));
    toast(labels.length ? `空き時間：${labels.join("、")}` : "14日以内に空き時間がありません");
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; button.textContent = original; }
});

document.querySelector("#team-member-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    const data = Object.fromEntries(new FormData(form));
    const result = await api("/api/team-members", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    form.reset();
    await refresh();
    const token = result.token || result.accessToken || result.member?.token || "";
    if (token) {
      document.querySelector("#issued-team-token").textContent = token;
      document.querySelector("#team-token-dialog").showModal();
    }
    toast("社内メンバーを追加しました");
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});

document.querySelector("#team-member-list").addEventListener("click", async (event) => {
  const button = event.target.closest(".team-member-remove");
  if (!button || !window.confirm("このメンバーの専用トークンを無効にしますか？")) return;
  button.disabled = true;
  try {
    await api(`/api/team-members/${encodeURIComponent(button.dataset.memberId)}`, { method: "DELETE" });
    await refresh();
    toast("メンバーのアクセスを削除しました");
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});

document.querySelector("#copy-team-token").addEventListener("click", async () => {
  await navigator.clipboard.writeText(document.querySelector("#issued-team-token").textContent);
  toast("専用トークンをコピーしました");
});

document.querySelector("#new-service").addEventListener("click", () => openServiceEditor());
document.querySelector("#cancel-service-edit").addEventListener("click", () => { document.querySelector("#service-form").hidden = true; });
document.querySelector("#service-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  const data = Object.fromEntries(new FormData(form));
  const id = data.id;
  delete data.id;
  button.disabled = true;
  try {
    await api(id ? `/api/services/${encodeURIComponent(id)}` : "/api/services", { method: id ? "PUT" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
    form.hidden = true;
    await refresh();
    toast(id ? "営業サービスを更新しました" : "営業サービスを追加しました");
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});

document.querySelector("#service-admin-list").addEventListener("click", async (event) => {
  const edit = event.target.closest(".service-edit");
  const remove = event.target.closest(".service-delete");
  const button = edit || remove;
  if (!button) return;
  const service = (appState.salesServices || []).find((item) => item.id === button.dataset.serviceId);
  if (edit) return openServiceEditor(service);
  if (!window.confirm(`「${service?.name || "このサービス"}」を利用停止にしますか？過去の通話履歴は残ります。`)) return;
  button.disabled = true;
  try {
    await api(`/api/services/${encodeURIComponent(button.dataset.serviceId)}`, { method: "DELETE" });
    await refresh();
    toast("営業サービスを利用停止にしました");
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});
document.querySelector("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  try { await saveSettings(); toast("受付設定を保存しました"); }
  catch (error) { toast(error.message, true); }
});
document.querySelector("#reception-enabled").addEventListener("change", async (event) => {
  try { await saveSettings({ enabled: event.currentTarget.checked }); toast(event.currentTarget.checked ? "AI受付を開始しました" : "AI受付を停止しました"); }
  catch (error) { event.currentTarget.checked = !event.currentTarget.checked; toast(error.message, true); }
});
document.querySelector("#call-filter").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-filter]");
  if (!button) return;
  filter = button.dataset.filter;
  document.querySelectorAll("#call-filter button").forEach((item) => item.classList.toggle("active", item === button));
  renderCalls();
});

document.querySelector("#call-search").addEventListener("input", (event) => {
  callSearch = event.currentTarget.value;
  renderCalls();
});

function openCallFromEvent(event) {
  const row = event.target.closest(".call-row-open");
  if (!row || (event.type === "keydown" && !["Enter", " "].includes(event.key))) return;
  if (event.type === "keydown") event.preventDefault();
  openCallDetail((appState.calls || []).find((call) => String(call.id || "") === row.dataset.callId));
}
document.querySelector("#all-calls").addEventListener("click", openCallFromEvent);
document.querySelector("#all-calls").addEventListener("keydown", openCallFromEvent);
document.querySelector("#recent-calls").addEventListener("click", openCallFromEvent);
document.querySelector("#recent-calls").addEventListener("keydown", openCallFromEvent);

document.querySelector("#export-calls").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await downloadProtectedFile("/api/calls/export", `通話履歴_${new Date().toISOString().slice(0, 10)}.csv`);
    toast("通話履歴のCSVを出力しました");
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});

document.querySelector("#call-detail-body").addEventListener("click", async (event) => {
  const resend = event.target.closest(".resend-notification");
  const sms = event.target.closest(".send-followup-sms");
  const button = resend || sms;
  if (!button) return;
  const original = button.textContent;
  button.disabled = true;
  button.textContent = resend ? "メールを送信中…" : "SMSを送信中…";
  try {
    if (resend) {
      await api("/api/notifications/resend", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ callId: button.dataset.callId }) });
      toast("通知メールを再送しました");
    } else {
      await api(`/api/calls/${encodeURIComponent(button.dataset.callId)}/followup-sms`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      toast("フォローSMSを送信しました");
    }
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; button.textContent = original; }
});

document.querySelectorAll(".recorder").forEach(setupRecorder);
document.querySelectorAll(".file-drop input[type=file]").forEach((input) => input.addEventListener("change", () => {
  if (input.files[0]) input.parentElement.firstChild.textContent = `選択済み: ${input.files[0].name}`;
}));

document.querySelector("#upload-greeting").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true; button.textContent = "音声を準備中…";
  try {
    const selected = selectedAudio("greeting");
    if (!selected) throw new Error("録音するか、音声ファイルを選択してください");
    const wav = await toPhoneWav(selected);
    await api("/api/greeting-audio", { method: "POST", headers: { "content-type": "audio/wav" }, body: wav });
    recordings.greeting = null;
    document.querySelector("#greeting-file").value = "";
    await refresh();
    toast("本人の挨拶音声を登録しました");
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; button.textContent = "この音声を着信の挨拶にする"; }
});

document.querySelector("#delete-greeting").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true; button.textContent = "削除中…";
  try {
    await api("/api/greeting-audio", { method: "DELETE" });
    await refresh();
    toast("本人の挨拶音声を削除しました");
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; button.textContent = "登録した音声を削除"; }
});

document.querySelector("#sales-voice-clips").addEventListener("change", (event) => {
  const input = event.target.closest('input[type="file"]');
  if (input?.files[0]) input.parentElement.firstChild.textContent = `選択済み: ${input.files[0].name}`;
});

document.querySelector("#sales-voice-clips").addEventListener("click", async (event) => {
  const card = event.target.closest(".voice-clip-card");
  if (!card) return;
  const serviceId = card.dataset.serviceId;
  const clipId = card.dataset.clipId;
  const upload = event.target.closest(".upload-sales-voice");
  const remove = event.target.closest(".delete-sales-voice");
  const savePhrase = event.target.closest(".save-voice-phrase");
  const resetPhrase = event.target.closest(".reset-voice-phrase");
  if (!upload && !remove && !savePhrase && !resetPhrase) return;
  const button = upload || remove || savePhrase || resetPhrase;
  const original = button.textContent;
  button.disabled = true;
  try {
    if (savePhrase) {
      button.textContent = "保存中…";
      const text = card.querySelector(".voice-clip-script-editor textarea")?.value.trim() || "";
      if (!text) throw new Error("フレーズ内容を入力してください");
      await api(`/api/services/${encodeURIComponent(serviceId)}/voice-phrases/${encodeURIComponent(clipId)}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ text })
      });
      toast("フレーズ内容を保存しました。録音済みの場合は新しい文章で録音し直してください");
    } else if (resetPhrase) {
      button.textContent = "戻しています…";
      await api(`/api/services/${encodeURIComponent(serviceId)}/voice-phrases/${encodeURIComponent(clipId)}`, { method: "DELETE" });
      toast("フレーズを初期文に戻しました");
    } else if (upload) {
      button.textContent = "音声を準備中…";
      const kind = upload.dataset.kind;
      const selected = selectedAudio(kind);
      if (!selected) throw new Error("録音するか、音声ファイルを選択してください");
      const maxSeconds = Number(card.querySelector(".recorder")?.dataset.maxSeconds || 20);
      const wav = await toPhoneWav(selected, maxSeconds);
      await api(`/api/services/${encodeURIComponent(serviceId)}/voice-clips/${encodeURIComponent(clipId)}`, {
        method: "POST", headers: { "content-type": "audio/wav" }, body: wav
      });
      recordings[kind] = null;
      toast(clipId === "transparent_opening" ? "本人の冒頭音声を登録しました。次回のリスト架電から自動再生します" : "台本確認用の音声を保存しました");
    } else {
      button.textContent = "削除中…";
      await api(`/api/services/${encodeURIComponent(serviceId)}/voice-clips/${encodeURIComponent(clipId)}`, { method: "DELETE" });
      toast("営業フレーズを削除しました");
    }
    await refresh();
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; button.textContent = original; }
});

document.querySelectorAll("[data-copy]").forEach((button) => button.addEventListener("click", async () => {
  const text = document.querySelector(button.dataset.copy).textContent;
  await navigator.clipboard.writeText(text);
  toast("クリップボードにコピーしました");
}));

window.addEventListener("hashchange", () => navigate(location.hash.slice(1) || "dashboard"));
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refreshCallsSilently();
});
setInterval(() => void refreshCallsSilently(), 10_000);

refresh().then(() => navigate(location.hash.slice(1) || "dashboard")).catch((error) => toast(`起動に失敗しました: ${error.message}`, true));
