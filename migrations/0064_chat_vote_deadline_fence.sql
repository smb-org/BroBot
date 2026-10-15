ALTER TABLE chat_votes ADD COLUMN closing_at TEXT;
ALTER TABLE chat_votes ADD COLUMN deadline_revision INTEGER NOT NULL DEFAULT 0
  CHECK (typeof(deadline_revision) = 'integer' AND deadline_revision >= 0);
