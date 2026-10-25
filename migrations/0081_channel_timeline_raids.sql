CREATE TABLE channel_timeline_events_new (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  event_key TEXT NOT NULL,
  stream_id TEXT,
  occurred_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'stream_online', 'stream_offline', 'channel_metadata',
    'clip_created', 'ad_break', 'emote_spike', 'raid_incoming', 'raid_outgoing'
  )),
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
  PRIMARY KEY (channel_id, event_key)
);

INSERT INTO channel_timeline_events_new (channel_id, event_key, stream_id, occurred_at, kind, detail_json)
SELECT channel_id, event_key, stream_id, occurred_at, kind, detail_json
FROM channel_timeline_events;

DROP TABLE channel_timeline_events;
ALTER TABLE channel_timeline_events_new RENAME TO channel_timeline_events;

CREATE INDEX channel_timeline_events_channel_occurred_idx
  ON channel_timeline_events(channel_id, occurred_at DESC);

CREATE INDEX channel_timeline_events_channel_kind_occurred_idx
  ON channel_timeline_events(channel_id, kind, occurred_at);
