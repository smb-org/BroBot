CREATE TABLE chat_vote_term_approvals_backup AS
SELECT channel_id, poll_id, term, approved_at, approved_by
  FROM chat_vote_term_approvals;

CREATE TABLE chat_votes_new (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  poll_id TEXT NOT NULL CHECK (length(poll_id) BETWEEN 1 AND 128),
  kind TEXT CHECK (kind IS NULL OR kind IN ('yes_no', 'options', 'free_text')),
  preset TEXT CHECK (preset IS NULL OR preset IN ('yes_no', 'scale_5', 'options_n', 'digit_01', 'digit_12', 'free_text')),
  legacy_written INTEGER NOT NULL DEFAULT 0 CHECK (legacy_written IN (0, 1)),
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
  title TEXT CHECK (title IS NULL OR (length(title) BETWEEN 1 AND 80 AND trim(title) = title)),
  PRIMARY KEY (channel_id, poll_id),
  CHECK (kind IS NOT NULL OR preset IS NOT NULL),
  CHECK (legacy_written = 0 OR kind IS NOT NULL),
  CHECK (
    (COALESCE(kind, CASE preset
       WHEN 'yes_no' THEN 'yes_no'
       WHEN 'digit_01' THEN 'options'
       WHEN 'digit_12' THEN 'options'
       WHEN 'scale_5' THEN 'options'
       WHEN 'options_n' THEN 'options'
       WHEN 'free_text' THEN 'free_text'
     END) = 'free_text' AND option_count = 0 AND text_mode IN ('first_word', 'whole_message') AND term_filter_ready IS NOT NULL) OR
    (COALESCE(kind, CASE preset
       WHEN 'yes_no' THEN 'yes_no'
       WHEN 'digit_01' THEN 'options'
       WHEN 'digit_12' THEN 'options'
       WHEN 'scale_5' THEN 'options'
       WHEN 'options_n' THEN 'options'
       WHEN 'free_text' THEN 'free_text'
     END) <> 'free_text' AND option_count BETWEEN 2 AND 9 AND text_mode IS NULL AND term_filter_ready IS NULL)
  ),
  CHECK (
    (status = 'open' AND closed_at IS NULL AND counts_json IS NULL AND voter_count IS NULL AND
      text_results_json IS NULL AND more_terms IS NULL) OR
    (status = 'closed' AND closed_at IS NOT NULL AND counts_json IS NOT NULL AND
      json_array_length(counts_json) = option_count AND voter_count IS NOT NULL AND
      ((COALESCE(kind, CASE preset
          WHEN 'yes_no' THEN 'yes_no'
          WHEN 'digit_01' THEN 'options'
          WHEN 'digit_12' THEN 'options'
          WHEN 'scale_5' THEN 'options'
          WHEN 'options_n' THEN 'options'
          WHEN 'free_text' THEN 'free_text'
        END) = 'free_text' AND text_results_json IS NOT NULL AND more_terms IS NOT NULL AND term_filter_ready IS NOT NULL) OR
       (COALESCE(kind, CASE preset
          WHEN 'yes_no' THEN 'yes_no'
          WHEN 'digit_01' THEN 'options'
          WHEN 'digit_12' THEN 'options'
          WHEN 'scale_5' THEN 'options'
          WHEN 'options_n' THEN 'options'
          WHEN 'free_text' THEN 'free_text'
        END) <> 'free_text' AND text_results_json IS NULL AND more_terms IS NULL AND term_filter_ready IS NULL)))
  )
) WITHOUT ROWID;

INSERT INTO chat_votes_new (
  channel_id, poll_id, kind, preset, legacy_written, option_count, labels_json, text_mode, term_filter_ready,
  status, opened_at, closes_at, closed_at, requested_duration_seconds, close_reason, counts_json, voter_count,
  text_results_json, more_terms, title
)
SELECT
  channel_id,
  poll_id,
  CASE preset
    WHEN 'yes_no' THEN 'yes_no'
    WHEN 'digit_01' THEN 'options'
    WHEN 'digit_12' THEN 'options'
    WHEN 'scale_5' THEN 'options'
    WHEN 'options_n' THEN 'options'
    WHEN 'free_text' THEN 'free_text'
  END,
  preset,
  1,
  option_count,
  labels_json,
  text_mode,
  term_filter_ready,
  status,
  opened_at,
  closes_at,
  closed_at,
  requested_duration_seconds,
  close_reason,
  counts_json,
  voter_count,
  text_results_json,
  more_terms,
  title
FROM chat_votes;

DROP TABLE chat_votes;
ALTER TABLE chat_votes_new RENAME TO chat_votes;

CREATE UNIQUE INDEX chat_votes_one_open_per_channel
  ON chat_votes(channel_id)
  WHERE status = 'open';

CREATE INDEX chat_votes_channel_opened_idx
  ON chat_votes(channel_id, opened_at DESC);

INSERT INTO chat_vote_term_approvals (channel_id, poll_id, term, approved_at, approved_by)
SELECT channel_id, poll_id, term, approved_at, approved_by
  FROM chat_vote_term_approvals_backup;
DROP TABLE chat_vote_term_approvals_backup;

CREATE TRIGGER chat_votes_fill_legacy_kind_after_insert
AFTER INSERT ON chat_votes
WHEN NEW.kind IS NULL
BEGIN
  UPDATE chat_votes
     SET kind = CASE NEW.preset
       WHEN 'yes_no' THEN 'yes_no'
       WHEN 'digit_01' THEN 'options'
       WHEN 'digit_12' THEN 'options'
       WHEN 'scale_5' THEN 'options'
       WHEN 'options_n' THEN 'options'
       WHEN 'free_text' THEN 'free_text'
     END,
     legacy_written = 1
   WHERE channel_id = NEW.channel_id AND poll_id = NEW.poll_id;
END;
