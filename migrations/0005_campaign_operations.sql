-- Campaign safety, retry, appointment, access-control, audit and integration data.

CREATE TABLE IF NOT EXISTS do_not_call_entries (
  phone TEXT PRIMARY KEY,
  reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  campaign_id TEXT,
  lead_id TEXT,
  created_by_token_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_do_not_call_created_at
  ON do_not_call_entries(created_at DESC);

CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  call_id TEXT,
  campaign_id TEXT,
  lead_id TEXT,
  phone TEXT NOT NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
  duration_minutes INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'requested',
  external_id TEXT,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_appointments_starts_at
  ON appointments(starts_at);
CREATE INDEX IF NOT EXISTS idx_appointments_campaign
  ON appointments(campaign_id, created_at DESC);

CREATE TABLE IF NOT EXISTS team_access_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  expires_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_team_access_tokens_active
  ON team_access_tokens(active, expires_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  actor_token_id TEXT,
  actor_label TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created_at
  ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity
  ON audit_log(entity_type, entity_id, created_at DESC);

CREATE TABLE IF NOT EXISTS integration_settings (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  endpoint_url TEXT NOT NULL DEFAULT '',
  config_json TEXT NOT NULL DEFAULT '{}',
  credential_ref TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

ALTER TABLE outbound_campaign_leads ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE outbound_campaign_leads ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;
ALTER TABLE outbound_campaign_leads ADD COLUMN next_attempt_at TEXT;
ALTER TABLE outbound_campaign_leads ADD COLUMN last_call_status TEXT NOT NULL DEFAULT '';
ALTER TABLE outbound_campaign_leads ADD COLUMN disposition TEXT NOT NULL DEFAULT '';
ALTER TABLE outbound_campaign_leads ADD COLUMN disposition_note TEXT NOT NULL DEFAULT '';
ALTER TABLE outbound_campaign_leads ADD COLUMN callback_at TEXT;
ALTER TABLE outbound_campaign_leads ADD COLUMN variant TEXT NOT NULL DEFAULT 'A';

ALTER TABLE outbound_campaigns ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3;
ALTER TABLE outbound_campaigns ADD COLUMN retry_minutes INTEGER NOT NULL DEFAULT 60;
ALTER TABLE outbound_campaigns ADD COLUMN voicemail_action TEXT NOT NULL DEFAULT 'retry';
ALTER TABLE outbound_campaigns ADD COLUMN variant_b_script TEXT NOT NULL DEFAULT '';
ALTER TABLE outbound_campaigns ADD COLUMN canceled_at TEXT;

CREATE INDEX IF NOT EXISTS idx_campaign_leads_retry
  ON outbound_campaign_leads(status, next_attempt_at, created_at);
CREATE INDEX IF NOT EXISTS idx_campaign_leads_disposition
  ON outbound_campaign_leads(campaign_id, disposition);

