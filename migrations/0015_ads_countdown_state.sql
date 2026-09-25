CREATE TABLE ads_countdown_state (
  channel_id TEXT PRIMARY KEY REFERENCES channels(channel_id) ON DELETE CASCADE,
  next_ad_at TEXT,
  duration INTEGER CHECK (duration IS NULL OR (typeof(duration) = 'integer' AND duration > 0)),
  snooze_count INTEGER CHECK (snooze_count IS NULL OR (typeof(snooze_count) = 'integer' AND snooze_count >= 0)),
  snooze_refresh_at TEXT,
  updated_at TEXT NOT NULL,
  CHECK (next_ad_at IS NOT NULL OR duration IS NULL)
);
