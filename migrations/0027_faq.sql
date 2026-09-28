CREATE TABLE faq_entries (
  faq_id TEXT NOT NULL,
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  matcher_type TEXT NOT NULL DEFAULT 'keywords' CHECK (matcher_type IN ('keywords', 'regex')),
  matcher_json TEXT NOT NULL CHECK (json_valid(matcher_json) AND json_type(matcher_json) = 'object'),
  answer_block TEXT NOT NULL CHECK (answer_block NOT GLOB '*[^a-z0-9_]*' AND length(answer_block) BETWEEN 1 AND 32),
  cooldown_seconds INTEGER NOT NULL DEFAULT 30 CHECK (cooldown_seconds BETWEEN 30 AND 86400),
  games_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(games_json) AND json_type(games_json) = 'array'),
  chat_target TEXT NOT NULL DEFAULT 'source_only' CHECK (chat_target IN ('all_chats', 'source_only', 'where_asked')),
  sort_order INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, faq_id)
) WITHOUT ROWID;

CREATE INDEX faq_entries_channel_order_idx ON faq_entries(channel_id, sort_order, faq_id);
CREATE INDEX faq_entries_channel_enabled_order_idx ON faq_entries(channel_id, enabled, sort_order, faq_id);

INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
SELECT channel_id, 'faq', 1, '{}'
  FROM channels
 WHERE NOT EXISTS (
   SELECT 1 FROM channel_modules
    WHERE channel_modules.channel_id = channels.channel_id
      AND channel_modules.module_id = 'faq'
 );
