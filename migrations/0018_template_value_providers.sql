ALTER TABLE channels ADD COLUMN time_zone TEXT NOT NULL DEFAULT 'Europe/Berlin';
ALTER TABLE channels ADD COLUMN time_zone_revision INTEGER NOT NULL DEFAULT 1 CHECK (time_zone_revision >= 1);

UPDATE channels
   SET time_zone = COALESCE(
     (SELECT text_library_settings.time_zone
        FROM text_library_settings
       WHERE text_library_settings.channel_id = channels.channel_id),
     'Europe/Berlin'
   );

ALTER TABLE text_library_settings DROP COLUMN time_zone;

UPDATE channel_modules
   SET settings = replace(replace(settings, '{duration}', '{ads.duration}'), '{seconds}', '{ads.seconds}')
 WHERE module_id = 'ads';
