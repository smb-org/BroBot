ALTER TABLE channel_word_frequency_baseline
  ADD COLUMN display_word TEXT NOT NULL DEFAULT '';

CREATE TABLE channel_word_frequency_baseline_folded (
  channel_id TEXT PRIMARY KEY REFERENCES channels(channel_id) ON DELETE CASCADE,
  folded_at TEXT
) WITHOUT ROWID;
