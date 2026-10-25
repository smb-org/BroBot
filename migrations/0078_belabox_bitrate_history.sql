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

-- Roll-up bookkeeping is not a panel-visible Belabox minute change.
DROP TRIGGER panel_rev_belabox_minutes_update;
CREATE TRIGGER panel_rev_belabox_minutes_update AFTER UPDATE ON belabox_minutes
WHEN OLD.channel_id IS NOT NEW.channel_id
  OR OLD.minute_at IS NOT NEW.minute_at
  OR OLD.stream_id IS NOT NEW.stream_id
  OR OLD.samples IS NOT NEW.samples
  OR OLD.connected_samples IS NOT NEW.connected_samples
  OR OLD.bitrate_min IS NOT NEW.bitrate_min
  OR OLD.bitrate_max IS NOT NEW.bitrate_max
  OR OLD.bitrate_sum IS NOT NEW.bitrate_sum
  OR OLD.rtt_max IS NOT NEW.rtt_max
  OR OLD.rtt_sum IS NOT NEW.rtt_sum
  OR OLD.dropped_delta IS NOT NEW.dropped_delta
BEGIN
  INSERT INTO panel_resource_revisions
    SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies
     WHERE source_table = 'belabox_minutes'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
