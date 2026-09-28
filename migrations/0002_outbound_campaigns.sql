CREATE TABLE IF NOT EXISTS outbound_campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  script TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbound_campaign_leads (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL,
  row_number INTEGER NOT NULL,
  company_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  note TEXT NOT NULL,
  status TEXT NOT NULL,
  call_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(campaign_id, phone)
);

CREATE INDEX IF NOT EXISTS idx_campaign_leads_queue
  ON outbound_campaign_leads(status, created_at);

CREATE INDEX IF NOT EXISTS idx_campaign_leads_campaign
  ON outbound_campaign_leads(campaign_id, row_number);
