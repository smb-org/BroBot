ALTER TABLE chat_votes
  ADD COLUMN result_delivery_pending INTEGER NOT NULL DEFAULT 0 CHECK (result_delivery_pending IN (0, 1));
