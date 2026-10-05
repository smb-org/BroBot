ALTER TABLE belabox_status RENAME TO belabox_status_legacy_0035;

CREATE TABLE belabox_status (
  channel_id TEXT PRIMARY KEY REFERENCES channels(channel_id) ON DELETE CASCADE,
  sampled_at TEXT,
  sample_json TEXT CHECK (sample_json IS NULL OR json_valid(sample_json)),
  error_code TEXT,
  polling INTEGER NOT NULL DEFAULT 0 CHECK (polling IN (0, 1)),
  stream_id TEXT,
  belabox_stream_id TEXT,
  fetch_phase_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(fetch_phase_json)),
  recent_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(recent_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
);

INSERT INTO belabox_status
  (channel_id, sampled_at, sample_json, error_code, polling, stream_id,
   belabox_stream_id, fetch_phase_json, recent_json, revision)
SELECT channel_id,
       sampled_at,
       json_object(
         'at', sampled_at,
         'connected', CASE connected WHEN 1 THEN json('true') ELSE json('false') END,
         'bitrateKbps', bitrate_kbps,
         'rttMs', rtt_ms,
         'latencyMs', latency_ms,
         'network', network,
         'droppedPackets', dropped_packets
       ),
       NULL,
       0,
       NULL,
       NULL,
       '{}',
       '[]',
       1
  FROM belabox_status_legacy_0035;

DROP TABLE belabox_status_legacy_0035;
