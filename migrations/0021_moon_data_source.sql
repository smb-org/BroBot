CREATE TABLE moon_settings (
  channel_id TEXT PRIMARY KEY REFERENCES channels(channel_id) ON DELETE CASCADE,
  error_text_de TEXT NOT NULL DEFAULT 'Monddaten sind derzeit nicht verfügbar.',
  error_text_en TEXT NOT NULL DEFAULT 'Moon data is currently unavailable.',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
SELECT channel_id, 'moon', 1, '{}'
  FROM channels
 WHERE NOT EXISTS (
   SELECT 1 FROM channel_modules
    WHERE channel_modules.channel_id = channels.channel_id
      AND channel_modules.module_id = 'moon'
 );
