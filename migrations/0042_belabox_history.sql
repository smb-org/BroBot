CREATE TABLE belabox_minutes (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  minute_at TEXT NOT NULL,
  stream_id TEXT NOT NULL,
  samples INTEGER NOT NULL CHECK (samples >= 1),
  connected_samples INTEGER NOT NULL CHECK (connected_samples >= 0 AND connected_samples <= samples),
  bitrate_min REAL NOT NULL CHECK (bitrate_min >= 0),
  bitrate_max REAL NOT NULL CHECK (bitrate_max >= bitrate_min),
  bitrate_sum REAL NOT NULL CHECK (bitrate_sum >= 0),
  rtt_max REAL NOT NULL CHECK (rtt_max >= 0),
  rtt_sum REAL NOT NULL CHECK (rtt_sum >= 0),
  dropped_delta REAL NOT NULL CHECK (dropped_delta >= 0),
  PRIMARY KEY (channel_id, minute_at, stream_id)
);
CREATE INDEX belabox_minutes_stream
  ON belabox_minutes (channel_id, stream_id, minute_at);

CREATE TABLE belabox_streams (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  stream_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  samples INTEGER NOT NULL CHECK (samples >= 1),
  bitrate_avg REAL NOT NULL CHECK (bitrate_avg >= 0),
  bitrate_p10 REAL CHECK (bitrate_p10 IS NULL OR bitrate_p10 >= 0),
  low_seconds REAL NOT NULL DEFAULT 0 CHECK (low_seconds >= 0),
  disconnected_seconds REAL NOT NULL DEFAULT 0 CHECK (disconnected_seconds >= 0),
  disconnect_count INTEGER NOT NULL DEFAULT 0 CHECK (disconnect_count >= 0),
  dropped_total REAL NOT NULL DEFAULT 0 CHECK (dropped_total >= 0),
  PRIMARY KEY (channel_id, stream_id)
);
CREATE INDEX belabox_streams_started
  ON belabox_streams (channel_id, started_at DESC);
