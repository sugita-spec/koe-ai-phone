CREATE TABLE IF NOT EXISTS sales_voice_phrase_overrides (
  service_id TEXT NOT NULL,
  clip_id TEXT NOT NULL,
  text TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(service_id, clip_id)
);

CREATE INDEX IF NOT EXISTS idx_sales_voice_phrase_overrides_service
  ON sales_voice_phrase_overrides(service_id, updated_at DESC);
