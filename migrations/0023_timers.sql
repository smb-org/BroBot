CREATE TABLE timers (
  timer_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  block_name TEXT NOT NULL CHECK (length(block_name) BETWEEN 1 AND 32),
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('interval', 'stream_start', 'time_of_day', 'before_event')),
  trigger_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  next_run_at TEXT,
  last_run_at TEXT,
  last_chat_activity_count INTEGER CHECK (last_chat_activity_count IS NULL OR last_chat_activity_count >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX timers_channel_enabled ON timers(channel_id, enabled, next_run_at);

INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
SELECT channel_id, 'timers', 1, '{}'
  FROM channels
 WHERE NOT EXISTS (
   SELECT 1 FROM channel_modules
    WHERE channel_modules.channel_id = channels.channel_id
      AND channel_modules.module_id = 'timers'
 );
