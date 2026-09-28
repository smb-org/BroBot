ALTER TABLE text_commands ADD COLUMN chat_target TEXT NOT NULL DEFAULT 'source_only'
  CHECK (chat_target IN ('all_chats', 'source_only', 'where_asked'));

ALTER TABLE timers ADD COLUMN chat_target TEXT NOT NULL DEFAULT 'source_only'
  CHECK (chat_target IN ('all_chats', 'source_only'));
