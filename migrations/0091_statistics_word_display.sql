ALTER TABLE channel_word_frequency_baseline
  ADD COLUMN display_word TEXT NOT NULL DEFAULT '';

ALTER TABLE channel_word_frequency_baseline
  ADD COLUMN display_count INTEGER NOT NULL DEFAULT 0;

UPDATE channel_word_frequency_baseline
   SET display_word = word
 WHERE display_word = '';

UPDATE channel_word_frequency_baseline
   SET display_count = total_count;

CREATE TABLE channel_word_frequency_baseline_folded (
  channel_id TEXT PRIMARY KEY REFERENCES channels(channel_id) ON DELETE CASCADE,
  folded_at TEXT
) WITHOUT ROWID;
