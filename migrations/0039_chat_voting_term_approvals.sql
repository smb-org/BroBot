CREATE TABLE chat_vote_term_approvals (
  channel_id TEXT NOT NULL,
  poll_id TEXT NOT NULL,
  term TEXT NOT NULL CHECK (length(term) BETWEEN 1 AND 25),
  approved_at TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  PRIMARY KEY (channel_id, poll_id, term),
  FOREIGN KEY (channel_id, poll_id) REFERENCES chat_votes(channel_id, poll_id) ON DELETE CASCADE
) WITHOUT ROWID;
