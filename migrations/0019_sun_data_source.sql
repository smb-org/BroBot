CREATE TABLE sun_locations (
  channel_id TEXT PRIMARY KEY REFERENCES channels(channel_id) ON DELETE CASCADE,
  name TEXT,
  latitude REAL,
  longitude REAL,
  location_time_zone TEXT,
  error_text_de TEXT NOT NULL DEFAULT 'Sonnendaten sind derzeit nicht verfügbar.',
  error_text_en TEXT NOT NULL DEFAULT 'Sun data is currently unavailable.',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  next_refresh_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((name IS NULL AND latitude IS NULL AND longitude IS NULL AND location_time_zone IS NULL) OR
         (name IS NOT NULL AND length(name) BETWEEN 1 AND 160 AND
          latitude IS NOT NULL AND latitude BETWEEN -90 AND 90 AND
          longitude IS NOT NULL AND longitude BETWEEN -180 AND 180 AND
          location_time_zone IS NOT NULL AND length(location_time_zone) BETWEEN 1 AND 80))
);

CREATE TABLE sun_times (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  local_date TEXT NOT NULL CHECK (local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  sunrise_at TEXT,
  sunset_at TEXT,
  dusk_at TEXT,
  polar_state TEXT NOT NULL CHECK (polar_state IN ('normal', 'day', 'night')),
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  channel_time_zone TEXT NOT NULL,
  location_revision INTEGER NOT NULL CHECK (location_revision >= 1),
  PRIMARY KEY (channel_id, local_date),
  CHECK ((polar_state = 'normal' AND sunrise_at IS NOT NULL AND sunset_at IS NOT NULL) OR
         (polar_state IN ('day', 'night') AND sunrise_at IS NULL AND sunset_at IS NULL AND dusk_at IS NULL))
);

CREATE INDEX sun_times_channel_expiry_idx ON sun_times(channel_id, expires_at, local_date);

INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
SELECT channel_id, 'sun', 1, '{}'
  FROM channels
 WHERE NOT EXISTS (
   SELECT 1 FROM channel_modules
    WHERE channel_modules.channel_id = channels.channel_id
      AND channel_modules.module_id = 'sun'
 );
