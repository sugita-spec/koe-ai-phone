export const CAMPAIGN_DISPOSITIONS = [
  "unknown",
  "appointment",
  "callback",
  "interested",
  "information_requested",
  "gatekeeper",
  "connected",
  "completed",
  "declined",
  "do_not_call",
  "wrong_number",
  "disconnected",
  "no_answer",
  "busy",
  "voicemail",
  "failed"
] as const;

export type CampaignDisposition = typeof CAMPAIGN_DISPOSITIONS[number];
export type CallOutcomeClass = "terminal" | "retry" | "callback" | "in_progress";
export type CampaignVariant = "A" | "B";
export type TeamRole = "viewer" | "operator" | "admin";
export type VoicemailAction = "retry" | "leave_message" | "end" | "complete";

const DISPOSITION_ALIASES: Readonly<Record<string, CampaignDisposition>> = {
  "": "unknown",
  unknown: "unknown",
  未確認: "unknown",
  appointment: "appointment",
  appointment_booked: "appointment",
  booked: "appointment",
  アポ: "appointment",
  アポ獲得: "appointment",
  予約: "appointment",
  予約済み: "appointment",
  callback: "callback",
  callback_requested: "callback",
  call_back: "callback",
  折り返し: "callback",
  再連絡: "callback",
  再架電希望: "callback",
  interested: "interested",
  qualified: "interested",
  興味あり: "interested",
  関心あり: "interested",
  information_requested: "information_requested",
  info_requested: "information_requested",
  send_information: "information_requested",
  資料希望: "information_requested",
  資料送付: "information_requested",
  gatekeeper: "gatekeeper",
  receptionist: "gatekeeper",
  受付: "gatekeeper",
  担当者不在: "gatekeeper",
  connected: "connected",
  answered: "connected",
  接続: "connected",
  通話成立: "connected",
  completed: "completed",
  complete: "completed",
  対応完了: "completed",
  declined: "declined",
  not_interested: "declined",
  rejected: "declined",
  不要: "declined",
  興味なし: "declined",
  お断り: "declined",
  do_not_call: "do_not_call",
  dnc: "do_not_call",
  opt_out: "do_not_call",
  架電拒否: "do_not_call",
  今後電話不要: "do_not_call",
  wrong_number: "wrong_number",
  wrong: "wrong_number",
  間違い電話: "wrong_number",
  番号違い: "wrong_number",
  disconnected: "disconnected",
  invalid_number: "disconnected",
  not_in_service: "disconnected",
  欠番: "disconnected",
  no_answer: "no_answer",
  noanswer: "no_answer",
  不在: "no_answer",
  応答なし: "no_answer",
  busy: "busy",
  話中: "busy",
  voicemail: "voicemail",
  answering_machine: "voicemail",
  留守電: "voicemail",
  failed: "failed",
  error: "failed",
  失敗: "failed"
};

const TERMINAL_DISPOSITIONS = new Set<CampaignDisposition>([
  "appointment",
  "interested",
  "information_requested",
  "connected",
  "completed",
  "declined",
  "do_not_call",
  "wrong_number",
  "disconnected"
]);

const RETRYABLE_STATUSES = new Set([
  "busy",
  "canceled",
  "cancelled",
  "failed",
  "no-answer",
  "no_answer",
  "unanswered",
  "voicemail",
  "answering-machine",
  "answering_machine"
]);

const ROLE_RANK: Readonly<Record<TeamRole, number>> = { viewer: 0, operator: 1, admin: 2 };
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const CAMPAIGN_TABLE_COLUMNS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  outbound_campaign_leads: {
    attempt_count: "INTEGER NOT NULL DEFAULT 0",
    max_attempts: "INTEGER NOT NULL DEFAULT 3",
    next_attempt_at: "TEXT",
    last_call_status: "TEXT NOT NULL DEFAULT ''",
    disposition: "TEXT NOT NULL DEFAULT ''",
    disposition_note: "TEXT NOT NULL DEFAULT ''",
    callback_at: "TEXT",
    variant: "TEXT NOT NULL DEFAULT 'A'"
  },
  outbound_campaigns: {
    max_attempts: "INTEGER NOT NULL DEFAULT 3",
    retry_minutes: "INTEGER NOT NULL DEFAULT 60",
    voicemail_action: "TEXT NOT NULL DEFAULT 'retry'",
    variant_b_script: "TEXT NOT NULL DEFAULT ''",
    canceled_at: "TEXT"
  }
};

const CREATE_TABLE_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS do_not_call_entries (
    phone TEXT PRIMARY KEY, reason TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT 'manual',
    campaign_id TEXT, lead_id TEXT, created_by_token_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY, call_id TEXT, campaign_id TEXT, lead_id TEXT, phone TEXT NOT NULL,
    contact_name TEXT NOT NULL DEFAULT '', email TEXT NOT NULL DEFAULT '', starts_at TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo', duration_minutes INTEGER NOT NULL DEFAULT 30,
    status TEXT NOT NULL DEFAULT 'requested', external_id TEXT, notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS team_access_tokens (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    role TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
    active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)), expires_at TEXT, last_used_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id TEXT PRIMARY KEY, actor_token_id TEXT, actor_label TEXT NOT NULL DEFAULT '', action TEXT NOT NULL,
    entity_type TEXT NOT NULL, entity_id TEXT NOT NULL DEFAULT '', metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS integration_settings (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
    endpoint_url TEXT NOT NULL DEFAULT '', config_json TEXT NOT NULL DEFAULT '{}',
    credential_ref TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`
] as const;

const CREATE_INDEX_STATEMENTS = [
  "CREATE INDEX IF NOT EXISTS idx_do_not_call_created_at ON do_not_call_entries(created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_appointments_starts_at ON appointments(starts_at)",
  "CREATE INDEX IF NOT EXISTS idx_appointments_campaign ON appointments(campaign_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_team_access_tokens_active ON team_access_tokens(active, expires_at)",
  "CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_campaign_leads_retry ON outbound_campaign_leads(status, next_attempt_at, created_at)",
  "CREATE INDEX IF NOT EXISTS idx_campaign_leads_disposition ON outbound_campaign_leads(campaign_id, disposition)"
] as const;

function normalizeKey(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLocaleLowerCase("ja-JP")
    .replace(/[\s\-\/]+/g, "_")
    .replace(/_+/g, "_");
}

export function normalizeDisposition(value: unknown): CampaignDisposition {
  return DISPOSITION_ALIASES[normalizeKey(value)] ?? "unknown";
}

export function isTerminalDisposition(value: unknown): boolean {
  return TERMINAL_DISPOSITIONS.has(normalizeDisposition(value));
}

export function classifyCallOutcome(
  status: unknown,
  disposition: unknown = "unknown",
  voicemailAction: unknown = "retry"
): CallOutcomeClass {
  const normalizedDisposition = normalizeDisposition(disposition);
  if (normalizedDisposition === "callback") return "callback";
  if (isTerminalDisposition(normalizedDisposition)) return "terminal";
  if (normalizedDisposition === "voicemail") return voicemailAction === "retry" ? "retry" : "terminal";
  if (["busy", "no_answer", "failed"].includes(normalizedDisposition)) return "retry";

  const normalizedStatus = normalizeKey(status);
  if (normalizedStatus === "completed") return "terminal";
  if (RETRYABLE_STATUSES.has(normalizedStatus)) {
    const voicemailStatus = normalizedStatus.includes("voicemail") || normalizedStatus.includes("answering_machine");
    return voicemailStatus && voicemailAction !== "retry" ? "terminal" : "retry";
  }
  return "in_progress";
}

export function isRetryableCallStatus(
  status: unknown,
  disposition: unknown = "unknown",
  voicemailAction: unknown = "retry"
): boolean {
  return classifyCallOutcome(status, disposition, voicemailAction) === "retry";
}

function isWeekendJst(date: Date): boolean {
  const day = new Date(date.getTime() + JST_OFFSET_MS).getUTCDay();
  return day === 0 || day === 6;
}

function nextJstBusinessOpening(date: Date): Date {
  const local = new Date(date.getTime() + JST_OFFSET_MS);
  const opening = new Date(Date.UTC(
    local.getUTCFullYear(),
    local.getUTCMonth(),
    local.getUTCDate(),
    10,
    0,
    0,
    0
  ) - JST_OFFSET_MS);
  while (isWeekendJst(opening)) opening.setUTCDate(opening.getUTCDate() + 1);
  return opening;
}

export function calculateNextRetryAt(from: Date | string | number, retryMinutes = 60): Date {
  const start = from instanceof Date ? new Date(from.getTime()) : new Date(from);
  if (!Number.isFinite(start.getTime())) throw new TypeError("from must be a valid date");
  if (!Number.isFinite(retryMinutes) || retryMinutes < 1) throw new RangeError("retryMinutes must be at least 1");

  const target = new Date(start.getTime() + Math.floor(retryMinutes) * 60_000);
  const local = new Date(target.getTime() + JST_OFFSET_MS);
  const hour = local.getUTCHours();

  if (isWeekendJst(target)) return nextJstBusinessOpening(target);
  if (hour < 10) return nextJstBusinessOpening(target);
  if (hour >= 19) {
    const nextDay = new Date(target.getTime() + 24 * 60 * 60 * 1000);
    return nextJstBusinessOpening(nextDay);
  }
  return target;
}

export async function assignCampaignVariant(
  campaignId: string,
  leadKey: string,
  hasVariantB = true
): Promise<CampaignVariant> {
  if (!hasVariantB) return "A";
  const source = `${campaignId.trim()}\u0000${leadKey.trim()}`;
  if (!campaignId.trim() || !leadKey.trim()) throw new TypeError("campaignId and leadKey are required");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source)));
  return (digest[0] & 1) === 0 ? "A" : "B";
}

function isPrivateOrReservedIpv4(hostname: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
  const parts = hostname.split(".").map(Number);
  if (parts.some((part) => part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && c === 0)
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function isPrivateOrReservedIpv6(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host.includes(":")) return false;
  return host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || /^fe[89ab]/.test(host);
}

export function normalizeIntegrationEndpoint(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw || raw.length > 2048) throw new TypeError("integration endpoint is required");

  let endpoint: URL;
  try { endpoint = new URL(raw); }
  catch { throw new TypeError("integration endpoint must be a valid URL"); }

  if (endpoint.protocol !== "https:") throw new TypeError("integration endpoint must use HTTPS");
  if (endpoint.username || endpoint.password) throw new TypeError("integration endpoint must not contain credentials");
  if (endpoint.hash) throw new TypeError("integration endpoint must not contain a fragment");

  const hostname = endpoint.hostname.toLowerCase();
  if (!hostname
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || hostname.endsWith(".lan")
    || isPrivateOrReservedIpv4(hostname)
    || isPrivateOrReservedIpv6(hostname)) {
    throw new TypeError("integration endpoint must use a public hostname");
  }
  return endpoint.toString();
}

export function isValidIntegrationEndpoint(value: unknown): boolean {
  try {
    normalizeIntegrationEndpoint(value);
    return true;
  } catch {
    return false;
  }
}

export function hasRolePermission(role: unknown, requiredRole: TeamRole): boolean {
  const normalizedRole = normalizeKey(role) as TeamRole;
  return Object.hasOwn(ROLE_RANK, normalizedRole) && ROLE_RANK[normalizedRole] >= ROLE_RANK[requiredRole];
}

export async function hashAccessToken(token: string): Promise<string> {
  if (typeof token !== "string" || token.length === 0) throw new TypeError("token is required");
  if (token.length > 4096) throw new RangeError("token is too long");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function tableColumnNames(db: D1Database, table: string): Promise<Set<string>> {
  const result = await db.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return new Set(result.results.map((column) => column.name));
}

async function ensureColumns(db: D1Database, table: string, definitions: Readonly<Record<string, string>>): Promise<void> {
  const existing = await tableColumnNames(db, table);
  for (const [column, definition] of Object.entries(definitions)) {
    if (existing.has(column)) continue;
    try {
      await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
    } catch (error) {
      // Two first requests can race while upgrading an older production database.
      if (!/duplicate column name/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
}

export async function ensureCampaignOperationsSchema(db: D1Database): Promise<void> {
  await db.batch(CREATE_TABLE_STATEMENTS.map((statement) => db.prepare(statement)));
  for (const [table, definitions] of Object.entries(CAMPAIGN_TABLE_COLUMNS)) {
    await ensureColumns(db, table, definitions);
  }
  await db.batch(CREATE_INDEX_STATEMENTS.map((statement) => db.prepare(statement)));
}
