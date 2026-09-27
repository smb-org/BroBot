-- A polar-night day may still cross the civil-twilight threshold at dusk.
-- Keep sunrise and sunset absent while allowing dusk on that state.
CREATE TABLE sun_times_rebuilt (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  local_date TEXT NOT NULL CHECK (local_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  sunrise_at TEXT,
  sunset_at TEXT,
  dusk_at TEXT,
  polar_state TEXT NOT NULL CHECK (polar_state IN ('normal','day','night')),
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  channel_time_zone TEXT NOT NULL,
  location_revision INTEGER NOT NULL CHECK (location_revision >= 1),
  PRIMARY KEY (channel_id, local_date),
  CHECK (
    (polar_state = 'normal' AND sunrise_at IS NOT NULL AND sunset_at IS NOT NULL) OR
    (polar_state = 'day' AND sunrise_at IS NULL AND sunset_at IS NULL AND dusk_at IS NULL) OR
    (polar_state = 'night' AND sunrise_at IS NULL AND sunset_at IS NULL)
  )
);

INSERT INTO sun_times_rebuilt
  (channel_id, local_date, sunrise_at, sunset_at, dusk_at, polar_state, fetched_at, expires_at, channel_time_zone, location_revision)
SELECT channel_id, local_date, sunrise_at, sunset_at, dusk_at, polar_state, fetched_at, expires_at, channel_time_zone, location_revision
  FROM sun_times;

DROP TABLE sun_times;
ALTER TABLE sun_times_rebuilt RENAME TO sun_times;
CREATE INDEX sun_times_channel_expiry_idx ON sun_times(channel_id, expires_at, local_date);
