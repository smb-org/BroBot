-- The clips module ships default-enabled, but channels released before its
-- introduction have no channel_modules row for it. Backfill one enabled row
-- per existing channel that doesn't already have one, so every reader of
-- channel_modules (not just the module list API's fallback) sees clips as on.
INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
SELECT channel_id, 'clips', 1, '{}'
  FROM channels
 WHERE NOT EXISTS (
   SELECT 1 FROM channel_modules
    WHERE channel_modules.channel_id = channels.channel_id
      AND channel_modules.module_id = 'clips'
 );
