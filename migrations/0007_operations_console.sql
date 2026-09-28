-- Operations console: campaign pacing, lead segments, follow-up tasks and inbound routing rules.

ALTER TABLE outbound_campaigns ADD COLUMN daily_limit INTEGER NOT NULL DEFAULT 200;
ALTER TABLE outbound_campaigns ADD COLUMN max_concurrency INTEGER NOT NULL DEFAULT 1;
ALTER TABLE outbound_campaigns ADD COLUMN pace_seconds INTEGER NOT NULL DEFAULT 60;
ALTER TABLE outbound_campaigns ADD COLUMN start_hour INTEGER NOT NULL DEFAULT 10;
ALTER TABLE outbound_campaigns ADD COLUMN end_hour INTEGER NOT NULL DEFAULT 19;
ALTER TABLE outbound_campaigns ADD COLUMN allowed_weekdays TEXT NOT NULL DEFAULT '1,2,3,4,5';
ALTER TABLE outbound_campaigns ADD COLUMN transfer_number TEXT NOT NULL DEFAULT '';

ALTER TABLE outbound_campaign_leads ADD COLUMN industry TEXT NOT NULL DEFAULT '';
ALTER TABLE outbound_campaign_leads ADD COLUMN company_size TEXT NOT NULL DEFAULT '';
ALTER TABLE outbound_campaign_leads ADD COLUMN source TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS operation_tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'followup',
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
  related_call_id TEXT,
  related_lead_id TEXT,
  assigned_to TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_operation_tasks_status_due
  ON operation_tasks(status, due_at, created_at DESC);

CREATE TABLE IF NOT EXISTS inbound_rules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  priority INTEGER NOT NULL DEFAULT 100,
  condition_type TEXT NOT NULL DEFAULT 'always',
  condition_value TEXT NOT NULL DEFAULT '',
  action_type TEXT NOT NULL DEFAULT 'ai_reception',
  action_value TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO inbound_rules
  (id, name, enabled, priority, condition_type, condition_value, action_type, action_value, created_at, updated_at)
VALUES
  ('rule_business_hours', '営業時間内のAI受付', 1, 10, 'business_hours', '', 'ai_reception', '', datetime('now'), datetime('now')),
  ('rule_after_hours', '時間外・あふれ呼の受付', 1, 20, 'outside_hours', '', 'take_message', '', datetime('now'), datetime('now'));
