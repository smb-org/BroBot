CREATE TABLE sun_locations (
  channel_id TEXT PRIMARY KEY REFERENCES channels(channel_id) ON DELETE CASCADE,
  name TEXT,
  latitude REAL,
  longitude REAL,
  location_time_zone TEXT,
  error_text_de TEXT NOT NULL DEFAULT 'Sonnendaten sind derzeit nicht verfügbar.',
  error_text_en TEXT NOT NULL DEFAULT 'Sun data is currently unavailable.',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((name IS NULL AND latitude IS NULL AND longitude IS NULL AND location_time_zone IS NULL) OR
         (name IS NOT NULL AND length(name) BETWEEN 1 AND 160 AND
          latitude IS NOT NULL AND latitude BETWEEN -90 AND 90 AND
          longitude IS NOT NULL AND longitude BETWEEN -180 AND 180 AND
          location_time_zone IS NOT NULL AND length(location_time_zone) BETWEEN 1 AND 80))
);

INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
SELECT channel_id, 'sun', 1, '{}'
  FROM channels
 WHERE NOT EXISTS (
   SELECT 1 FROM channel_modules
    WHERE channel_modules.channel_id = channels.channel_id
      AND channel_modules.module_id = 'sun'
 );
