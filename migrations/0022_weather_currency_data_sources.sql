CREATE TABLE weather_settings (
  channel_id TEXT PRIMARY KEY REFERENCES channels(channel_id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'met_norway' CHECK (provider IN ('met_norway', 'open_meteo')),
  show_fahrenheit INTEGER NOT NULL DEFAULT 0 CHECK (show_fahrenheit IN (0, 1)),
  error_text_de TEXT NOT NULL DEFAULT 'Wetterdaten sind derzeit nicht verfügbar.',
  error_text_en TEXT NOT NULL DEFAULT 'Weather data is currently unavailable.',
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE weather_cache (
  provider TEXT NOT NULL CHECK (provider IN ('met_norway', 'open_meteo')),
  location_key TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  payload_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  etag TEXT,
  last_modified TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (provider, location_key)
);

CREATE TABLE currency_rate_cache (
  base_currency TEXT NOT NULL CHECK (length(base_currency) = 3),
  target_currency TEXT NOT NULL CHECK (length(target_currency) = 3),
  rate REAL NOT NULL CHECK (rate > 0),
  expires_at TEXT NOT NULL,
  etag TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (base_currency, target_currency)
);

INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
SELECT channel_id, 'weather', 1, '{}'
  FROM channels
 WHERE NOT EXISTS (
   SELECT 1 FROM channel_modules
    WHERE channel_modules.channel_id = channels.channel_id
      AND channel_modules.module_id = 'weather'
 );

INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
SELECT channel_id, 'currency', 1, '{}'
  FROM channels
 WHERE NOT EXISTS (
   SELECT 1 FROM channel_modules
    WHERE channel_modules.channel_id = channels.channel_id
      AND channel_modules.module_id = 'currency'
 );
