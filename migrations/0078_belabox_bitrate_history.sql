ALTER TABLE belabox_minutes
  ADD COLUMN rolled_up_at TEXT;

CREATE INDEX belabox_minutes_unrolled_window
  ON belabox_minutes (
    CAST(strftime('%s', minute_at) AS INTEGER) / 300 * 300000,
    channel_id,
    stream_id,
    minute_at
  )
  WHERE rolled_up_at IS NULL;

CREATE TABLE belabox_bitrate_windows (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  stream_id TEXT NOT NULL,
  window_start INTEGER NOT NULL CHECK (window_start >= 0 AND window_start % 300000 = 0),
  bitrate_min REAL NOT NULL CHECK (bitrate_min >= 0),
  bitrate_max REAL NOT NULL CHECK (bitrate_max >= bitrate_min),
  bitrate_avg REAL NOT NULL CHECK (bitrate_avg >= 0),
  bitrate_p10 REAL NOT NULL CHECK (bitrate_p10 >= 0),
  rtt_avg REAL NOT NULL CHECK (rtt_avg >= 0),
  dropped_delta REAL NOT NULL CHECK (dropped_delta >= 0),
  sample_count INTEGER NOT NULL CHECK (sample_count >= 1),
  PRIMARY KEY (channel_id, stream_id, window_start)
);

CREATE INDEX belabox_bitrate_windows_channel_window
  ON belabox_bitrate_windows (channel_id, window_start DESC);
