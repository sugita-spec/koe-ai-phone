import assert from "node:assert/strict";
import test from "node:test";
import {
  assignCampaignVariant,
  calculateNextRetryAt,
  classifyCallOutcome,
  ensureCampaignOperationsSchema,
  hashAccessToken,
  hasRolePermission,
  isRetryableCallStatus,
  isTerminalDisposition,
  isValidIntegrationEndpoint,
  normalizeDisposition,
  normalizeIntegrationEndpoint
} from "../src/campaign-operations.ts";

class SchemaTestStatement {
  constructor(database, sql) {
    this.database = database;
    this.sql = sql;
  }

  async all() {
    const table = this.sql.match(/^PRAGMA table_info\(([^)]+)\)$/)?.[1];
    return { results: [...(this.database.columns.get(table) || [])].map((name) => ({ name })) };
  }

  async run() {
    const alter = this.sql.match(/^ALTER TABLE (\w+) ADD COLUMN (\w+)/);
    if (alter) {
      const [, table, column] = alter;
      const columns = this.database.columns.get(table) || new Set();
      if (columns.has(column)) throw new Error(`duplicate column name: ${column}`);
      columns.add(column);
      this.database.columns.set(table, columns);
      this.database.alterCount += 1;
    }
    return { success: true, meta: { changes: 0 } };
  }
}

class SchemaTestDatabase {
  constructor() {
    this.columns = new Map([
      ["outbound_campaign_leads", new Set(["id", "status", "created_at"])],
      ["outbound_campaigns", new Set(["id", "status"])]
    ]);
    this.alterCount = 0;
  }

  prepare(sql) {
    return new SchemaTestStatement(this, sql);
  }

  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

test("normalizes Japanese and provider disposition values", () => {
  assert.equal(normalizeDisposition(" アポ獲得 "), "appointment");
  assert.equal(normalizeDisposition("not-interested"), "declined");
  assert.equal(normalizeDisposition("DNC"), "do_not_call");
  assert.equal(normalizeDisposition("留守電"), "voicemail");
  assert.equal(normalizeDisposition("通話成立"), "connected");
  assert.equal(normalizeDisposition("unsupported-value"), "unknown");
  assert.equal(isTerminalDisposition("架電拒否"), true);
  assert.equal(isTerminalDisposition("再架電希望"), false);
});

test("classifies terminal, retry, callback and active outcomes", () => {
  assert.equal(classifyCallOutcome("completed"), "terminal");
  assert.equal(classifyCallOutcome("completed", "再架電希望"), "callback");
  assert.equal(classifyCallOutcome("no-answer"), "retry");
  assert.equal(classifyCallOutcome("completed", "留守電", "retry"), "retry");
  assert.equal(classifyCallOutcome("completed", "留守電", "leave_message"), "terminal");
  assert.equal(classifyCallOutcome("ringing"), "in_progress");
  assert.equal(isRetryableCallStatus("busy"), true);
  assert.equal(isRetryableCallStatus("completed", "アポ獲得"), false);
});

test("moves retries into the weekday 10:00-19:00 JST window", () => {
  assert.equal(
    calculateNextRetryAt("2026-09-24T01:30:00.000Z", 60).toISOString(),
    "2026-09-24T02:30:00.000Z"
  );
  assert.equal(
    calculateNextRetryAt("2026-09-25T09:30:00.000Z", 60).toISOString(),
    "2026-09-28T01:00:00.000Z"
  );
  assert.equal(
    calculateNextRetryAt("2026-09-26T00:00:00.000Z", 60).toISOString(),
    "2026-09-28T01:00:00.000Z"
  );
  assert.throws(() => calculateNextRetryAt("not-a-date"), /valid date/);
});

test("assigns a stable cryptographic A/B variant", async () => {
  const first = await assignCampaignVariant("campaign_1", "lead_1");
  const second = await assignCampaignVariant("campaign_1", "lead_1");
  assert.equal(first, second);
  assert.ok(first === "A" || first === "B");
  assert.equal(await assignCampaignVariant("campaign_1", "lead_1", false), "A");
  await assert.rejects(assignCampaignVariant("", "lead_1"), /required/);
});

test("accepts only public HTTPS integration endpoints", () => {
  assert.equal(normalizeIntegrationEndpoint("https://hooks.example.com/receive?source=phone"), "https://hooks.example.com/receive?source=phone");
  assert.equal(isValidIntegrationEndpoint("http://hooks.example.com"), false);
  assert.equal(isValidIntegrationEndpoint("https://127.0.0.1/hook"), false);
  assert.equal(isValidIntegrationEndpoint("https://10.0.0.1/hook"), false);
  assert.equal(isValidIntegrationEndpoint("https://localhost/hook"), false);
  assert.equal(isValidIntegrationEndpoint("https://user:pass@hooks.example.com/hook"), false);
  assert.equal(isValidIntegrationEndpoint("https://hooks.example.com/hook#secret"), false);
});

test("enforces the viewer/operator/admin role hierarchy", () => {
  assert.equal(hasRolePermission("viewer", "viewer"), true);
  assert.equal(hasRolePermission("viewer", "operator"), false);
  assert.equal(hasRolePermission("operator", "viewer"), true);
  assert.equal(hasRolePermission("operator", "admin"), false);
  assert.equal(hasRolePermission("admin", "admin"), true);
  assert.equal(hasRolePermission("unknown", "viewer"), false);
});

test("hashes access tokens with deterministic SHA-256 hex", async () => {
  assert.equal(
    await hashAccessToken("kameya-test-token"),
    "08f5302d24e69c5664860c30bddd430537163817fdbac81d1c5d585ad6bee699"
  );
  assert.notEqual(await hashAccessToken("token-a"), await hashAccessToken("token-b"));
  await assert.rejects(hashAccessToken(""), /required/);
});

test("runtime schema upgrade adds missing columns only once", async () => {
  const database = new SchemaTestDatabase();
  await ensureCampaignOperationsSchema(database);
  assert.equal(database.alterCount, 13);
  assert.ok(database.columns.get("outbound_campaign_leads").has("attempt_count"));
  assert.ok(database.columns.get("outbound_campaigns").has("canceled_at"));

  await ensureCampaignOperationsSchema(database);
  assert.equal(database.alterCount, 13);
});
