CREATE TABLE overlays (
  overlay_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  width INTEGER NOT NULL DEFAULT 1920 CHECK (width BETWEEN 64 AND 3840),
  height INTEGER NOT NULL DEFAULT 1080 CHECK (height BETWEEN 64 AND 2160),
  css TEXT NOT NULL DEFAULT '' CHECK (length(css) <= 16000),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (channel_id, overlay_id)
);
CREATE INDEX overlays_channel_idx ON overlays(channel_id);

CREATE TABLE overlay_elements (
  element_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  overlay_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 40),
  variable_name TEXT,
  text TEXT NOT NULL DEFAULT '' CHECK (length(text) <= 100),
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  x INTEGER NOT NULL DEFAULT 0,
  y INTEGER NOT NULL DEFAULT 0,
  scale_percent INTEGER NOT NULL DEFAULT 100 CHECK (scale_percent BETWEEN 25 AND 400),
  z INTEGER NOT NULL DEFAULT 0,
  in_composition INTEGER NOT NULL DEFAULT 1 CHECK (in_composition IN (0, 1)),
  FOREIGN KEY (channel_id, overlay_id) REFERENCES overlays(channel_id, overlay_id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id, variable_name) REFERENCES channel_variables(channel_id, name) ON UPDATE CASCADE
);
CREATE INDEX overlay_elements_overlay_idx ON overlay_elements(channel_id, overlay_id);
CREATE INDEX overlay_elements_variable_idx ON overlay_elements(channel_id, variable_name);
