ALTER TABLE channels ADD COLUMN default_chat_target TEXT NOT NULL DEFAULT 'source_only'
  CHECK (default_chat_target IN ('all_chats', 'source_only', 'where_asked'));
ALTER TABLE channels ADD COLUMN default_chat_target_revision INTEGER NOT NULL DEFAULT 1
  CHECK (default_chat_target_revision >= 1);

ALTER TABLE text_commands ADD COLUMN use_channel_default_target INTEGER NOT NULL DEFAULT 0
  CHECK (use_channel_default_target IN (0, 1));
ALTER TABLE faq_entries ADD COLUMN use_channel_default_target INTEGER NOT NULL DEFAULT 0
  CHECK (use_channel_default_target IN (0, 1));
ALTER TABLE timers ADD COLUMN use_channel_default_target INTEGER NOT NULL DEFAULT 0
  CHECK (use_channel_default_target IN (0, 1));
