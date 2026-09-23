CREATE TABLE channel_controls (
  channel_id TEXT PRIMARY KEY,
  muted INTEGER NOT NULL DEFAULT 0 CHECK (muted IN (0, 1)),
  muted_until TEXT,
  mute_until_stream_end INTEGER NOT NULL DEFAULT 0 CHECK (mute_until_stream_end IN (0, 1)),
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  paused_until TEXT,
  pause_until_stream_end INTEGER NOT NULL DEFAULT 0 CHECK (pause_until_stream_end IN (0, 1)),
  updated_at TEXT NOT NULL,
  CHECK (muted = 1 OR (muted_until IS NULL AND mute_until_stream_end = 0)),
  CHECK (muted_until IS NULL OR (muted = 1 AND mute_until_stream_end = 0)),
  CHECK (paused = 1 OR (paused_until IS NULL AND pause_until_stream_end = 0)),
  CHECK (paused_until IS NULL OR (paused = 1 AND pause_until_stream_end = 0)),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);
