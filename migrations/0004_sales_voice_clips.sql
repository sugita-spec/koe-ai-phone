CREATE TABLE IF NOT EXISTS sales_voice_clips (
  service_id TEXT NOT NULL,
  clip_id TEXT NOT NULL,
  version TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(service_id, clip_id)
);
