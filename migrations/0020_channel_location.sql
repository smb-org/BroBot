ALTER TABLE channels ADD COLUMN location_name TEXT;
ALTER TABLE channels ADD COLUMN location_latitude REAL;
ALTER TABLE channels ADD COLUMN location_longitude REAL;
ALTER TABLE channels ADD COLUMN location_time_zone TEXT;
ALTER TABLE channels ADD COLUMN location_revision INTEGER NOT NULL DEFAULT 1 CHECK (location_revision >= 1);

UPDATE channels
   SET location_name = (SELECT name FROM sun_locations WHERE sun_locations.channel_id = channels.channel_id),
       location_latitude = (SELECT latitude FROM sun_locations WHERE sun_locations.channel_id = channels.channel_id),
       location_longitude = (SELECT longitude FROM sun_locations WHERE sun_locations.channel_id = channels.channel_id),
       location_time_zone = (SELECT location_time_zone FROM sun_locations WHERE sun_locations.channel_id = channels.channel_id),
       location_revision = COALESCE(
         (SELECT revision FROM sun_locations WHERE sun_locations.channel_id = channels.channel_id),
         1
       );

CREATE TABLE sun_settings (
  channel_id TEXT PRIMARY KEY REFERENCES channels(channel_id) ON DELETE CASCADE,
  error_text_de TEXT NOT NULL DEFAULT 'Sonnendaten sind derzeit nicht verfügbar.',
  error_text_en TEXT NOT NULL DEFAULT 'Sun data is currently unavailable.',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO sun_settings (channel_id, error_text_de, error_text_en, revision, created_at, updated_at)
SELECT channel_id, error_text_de, error_text_en, revision, created_at, updated_at
  FROM sun_locations;

DROP TABLE sun_locations;
