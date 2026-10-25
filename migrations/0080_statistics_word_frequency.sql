CREATE TABLE channel_word_frequency_baseline (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  word TEXT NOT NULL,
  total_count INTEGER NOT NULL CHECK (total_count > 0),
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, word)
) WITHOUT ROWID;

CREATE INDEX channel_word_frequency_baseline_top_idx
  ON channel_word_frequency_baseline (channel_id, total_count DESC, word ASC);

CREATE TABLE channel_word_frequency_streams (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  stream_id TEXT NOT NULL,
  batch INTEGER NOT NULL CHECK (batch > 0),
  merged_at TEXT,
  PRIMARY KEY (channel_id, stream_id, batch)
) WITHOUT ROWID;
