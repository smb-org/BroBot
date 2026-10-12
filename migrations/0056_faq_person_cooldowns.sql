ALTER TABLE faq_entries ADD COLUMN user_cooldown_seconds INTEGER NOT NULL DEFAULT 0
  CHECK (user_cooldown_seconds BETWEEN 0 AND 86400);

CREATE TABLE faq_entry_user_cooldowns (
  channel_id TEXT NOT NULL,
  faq_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, faq_id, user_id),
  FOREIGN KEY (channel_id, faq_id) REFERENCES faq_entries(channel_id, faq_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX faq_entry_user_cooldowns_last_used_idx ON faq_entry_user_cooldowns(last_used_at);
