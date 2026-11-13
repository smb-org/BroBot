CREATE TABLE channel_word_spellings (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  word TEXT NOT NULL,
  spelling TEXT NOT NULL,
  count INTEGER NOT NULL CHECK (count > 0),
  PRIMARY KEY (channel_id, word, spelling)
) WITHOUT ROWID;

CREATE INDEX channel_word_spellings_top_idx
  ON channel_word_spellings (channel_id, word, count DESC, spelling ASC);

CREATE TABLE channel_word_frequency_baseline_folded (
  channel_id TEXT PRIMARY KEY REFERENCES channels(channel_id) ON DELETE CASCADE,
  folded_at TEXT
) WITHOUT ROWID;
