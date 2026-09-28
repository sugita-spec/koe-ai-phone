CREATE TABLE IF NOT EXISTS sales_services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  seller_name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  description TEXT NOT NULL,
  script TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS outbound_campaign_metadata (
  campaign_id TEXT PRIMARY KEY,
  service_id TEXT NOT NULL,
  service_name TEXT NOT NULL,
  seller_name TEXT NOT NULL
);

