CREATE TABLE ads_countdown_state (
  channel_id TEXT PRIMARY KEY REFERENCES channels(channel_id) ON DELETE CASCADE,
  next_ad_at TEXT,
  duration INTEGER CHECK (duration IS NULL OR (typeof(duration) = 'integer' AND duration > 0)),
  updated_at TEXT NOT NULL,
  CHECK (next_ad_at IS NOT NULL OR duration IS NULL)
);
