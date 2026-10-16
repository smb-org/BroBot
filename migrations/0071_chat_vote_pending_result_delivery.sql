ALTER TABLE chat_votes
  ADD COLUMN result_delivery_pending INTEGER NOT NULL DEFAULT 0 CHECK (result_delivery_pending IN (0, 1));

CREATE TABLE chat_vote_result_delivery_reconciliation (
  channel_id TEXT NOT NULL,
  poll_id TEXT NOT NULL,
  PRIMARY KEY (channel_id, poll_id),
  FOREIGN KEY (channel_id, poll_id) REFERENCES chat_votes(channel_id, poll_id) ON DELETE CASCADE
) WITHOUT ROWID;

INSERT INTO chat_vote_result_delivery_reconciliation (channel_id, poll_id)
SELECT channel_id, poll_id
  FROM chat_votes
 WHERE status = 'closed'
   AND result_text IS NOT NULL
   AND trim(result_text) <> '';

UPDATE chat_votes
   SET result_delivery_pending = 1
 WHERE EXISTS (
   SELECT 1
     FROM chat_vote_result_delivery_reconciliation AS candidate
    WHERE candidate.channel_id = chat_votes.channel_id
      AND candidate.poll_id = chat_votes.poll_id
 );

INSERT OR IGNORE INTO panel_resource_dependencies (source_table, resource) VALUES
  ('chat_vote_templates', 'channel.library'),
  ('chat_votes', 'channel.library');
