ALTER TABLE chat_votes
  ADD COLUMN manual_close_previous_reason TEXT
    CHECK (manual_close_previous_reason IS NULL OR manual_close_previous_reason IN ('timer', 'limit'));

ALTER TABLE chat_votes
  ADD COLUMN manual_close_owner_token TEXT
    CHECK (manual_close_owner_token IS NULL OR length(manual_close_owner_token) BETWEEN 1 AND 128);
