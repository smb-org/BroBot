CREATE TABLE belabox_status (
  channel_id TEXT PRIMARY KEY REFERENCES channels(channel_id) ON DELETE CASCADE,
  connected INTEGER NOT NULL CHECK (connected IN (0, 1)),
  bitrate_kbps REAL NOT NULL,
  rtt_ms REAL NOT NULL,
  latency_ms REAL NOT NULL,
  network REAL NOT NULL,
  dropped_packets REAL NOT NULL,
  sampled_at TEXT NOT NULL
);
