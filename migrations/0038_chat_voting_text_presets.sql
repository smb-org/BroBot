CREATE TABLE chat_votes_new (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  poll_id TEXT NOT NULL CHECK (length(poll_id) BETWEEN 1 AND 128),
  preset TEXT NOT NULL CHECK (preset IN ('yes_no', 'scale_5', 'options_n', 'digit_01', 'digit_12', 'free_text')),
  option_count INTEGER NOT NULL CHECK (option_count BETWEEN 0 AND 9),
  labels_json TEXT NOT NULL CHECK (
    json_valid(labels_json) AND json_type(labels_json) = 'array' AND json_array_length(labels_json) = option_count
  ),
  text_mode TEXT CHECK (text_mode IS NULL OR text_mode IN ('first_word', 'whole_message')),
  term_filter_ready INTEGER CHECK (term_filter_ready IS NULL OR term_filter_ready IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  opened_at TEXT NOT NULL,
  closes_at TEXT NOT NULL,
  closed_at TEXT,
  requested_duration_seconds INTEGER CHECK (
    requested_duration_seconds IS NULL OR (
      typeof(requested_duration_seconds) = 'integer' AND
      requested_duration_seconds BETWEEN 1 AND 14400
    )
  ),
  close_reason TEXT NOT NULL CHECK (close_reason IN ('manual', 'timer', 'limit')),
  counts_json TEXT CHECK (counts_json IS NULL OR (json_valid(counts_json) AND json_type(counts_json) = 'array')),
  voter_count INTEGER CHECK (voter_count IS NULL OR voter_count >= 0),
  text_results_json TEXT CHECK (
    text_results_json IS NULL OR (json_valid(text_results_json) AND json_type(text_results_json) = 'array')
  ),
  more_terms INTEGER CHECK (more_terms IS NULL OR (typeof(more_terms) = 'integer' AND more_terms >= 0)),
  PRIMARY KEY (channel_id, poll_id),
  CHECK (
    (preset = 'free_text' AND option_count = 0 AND text_mode IN ('first_word', 'whole_message') AND term_filter_ready IS NOT NULL) OR
    (preset <> 'free_text' AND option_count BETWEEN 2 AND 9 AND text_mode IS NULL AND term_filter_ready IS NULL)
  ),
  CHECK (
    (status = 'open' AND closed_at IS NULL AND counts_json IS NULL AND voter_count IS NULL AND
      text_results_json IS NULL AND more_terms IS NULL) OR
    (status = 'closed' AND closed_at IS NOT NULL AND counts_json IS NOT NULL AND
      json_array_length(counts_json) = option_count AND voter_count IS NOT NULL AND
      ((preset = 'free_text' AND text_results_json IS NOT NULL AND more_terms IS NOT NULL AND term_filter_ready IS NOT NULL) OR
       (preset <> 'free_text' AND text_results_json IS NULL AND more_terms IS NULL AND term_filter_ready IS NULL)))
  )
) WITHOUT ROWID;

INSERT INTO chat_votes_new (
  channel_id, poll_id, preset, option_count, labels_json, text_mode, term_filter_ready, status, opened_at, closes_at,
  closed_at, requested_duration_seconds, close_reason, counts_json, voter_count, text_results_json, more_terms
)
SELECT
  channel_id, poll_id, preset, option_count, labels_json, NULL, NULL, status, opened_at, closes_at,
  closed_at, requested_duration_seconds, close_reason, counts_json, voter_count, NULL, NULL
FROM chat_votes;

DROP TABLE chat_votes;
ALTER TABLE chat_votes_new RENAME TO chat_votes;

CREATE UNIQUE INDEX chat_votes_one_open_per_channel
  ON chat_votes(channel_id)
  WHERE status = 'open';

CREATE INDEX chat_votes_channel_opened_idx
  ON chat_votes(channel_id, opened_at DESC);
