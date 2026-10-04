CREATE TABLE chat_votes (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  poll_id TEXT NOT NULL CHECK (length(poll_id) BETWEEN 1 AND 128),
  preset TEXT NOT NULL CHECK (preset IN ('yes_no', 'scale_5', 'options_n')),
  option_count INTEGER NOT NULL CHECK (option_count BETWEEN 2 AND 9),
  labels_json TEXT NOT NULL CHECK (
    json_valid(labels_json) AND json_type(labels_json) = 'array' AND json_array_length(labels_json) = option_count
  ),
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  opened_at TEXT NOT NULL,
  closes_at TEXT NOT NULL,
  closed_at TEXT,
  close_reason TEXT NOT NULL CHECK (close_reason IN ('manual', 'timer', 'limit')),
  counts_json TEXT CHECK (counts_json IS NULL OR (json_valid(counts_json) AND json_type(counts_json) = 'array')),
  voter_count INTEGER CHECK (voter_count IS NULL OR voter_count >= 0),
  PRIMARY KEY (channel_id, poll_id),
  CHECK (
    (status = 'open' AND closed_at IS NULL AND counts_json IS NULL AND voter_count IS NULL) OR
    (status = 'closed' AND closed_at IS NOT NULL AND counts_json IS NOT NULL AND
      json_array_length(counts_json) = option_count AND voter_count IS NOT NULL)
  )
) WITHOUT ROWID;

CREATE UNIQUE INDEX chat_votes_one_open_per_channel
  ON chat_votes(channel_id)
  WHERE status = 'open';

CREATE INDEX chat_votes_channel_opened_idx
  ON chat_votes(channel_id, opened_at DESC);

INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
SELECT channel_id, 'chat_voting', 1,
       '{"yesNoLabels":"","scaleLabels":"","optionLabels":"","autoCloseSeconds":0,"announceResult":true,"resultText":"{vote.result}","resultTarget":"source_only"}'
  FROM channels
 WHERE NOT EXISTS (
   SELECT 1 FROM channel_modules
    WHERE channel_modules.channel_id = channels.channel_id
      AND channel_modules.module_id = 'chat_voting'
 );
