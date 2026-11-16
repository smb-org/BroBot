CREATE TABLE overlays_css_length_next (
  overlay_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  width INTEGER NOT NULL DEFAULT 1920 CHECK (width BETWEEN 64 AND 3840),
  height INTEGER NOT NULL DEFAULT 1080 CHECK (height BETWEEN 64 AND 2160),
  css TEXT NOT NULL DEFAULT '' CHECK (length(css) <= 48000),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (channel_id, overlay_id)
);

INSERT INTO overlays_css_length_next
  (overlay_id, channel_id, name, width, height, css, revision, created_at, updated_at)
SELECT overlay_id, channel_id, name, width, height, css, revision, created_at, updated_at
  FROM overlays;

CREATE TABLE overlay_elements_css_length_backup AS
SELECT element_id, channel_id, overlay_id, kind, label, variable_name, text, config_json, x, y,
       scale_percent, z, in_composition, missing_variable_name
  FROM overlay_elements;

DROP TABLE overlay_elements;
DROP TABLE overlays;
ALTER TABLE overlays_css_length_next RENAME TO overlays;
CREATE INDEX overlays_channel_idx ON overlays(channel_id);

CREATE TABLE overlay_elements (
  element_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  overlay_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 40),
  variable_name TEXT,
  text TEXT NOT NULL DEFAULT '' CHECK (
    length(text) - 5 * ((length(text) - length(replace(text, '{text.', ''))) / 6) <= 100
  ),
  config_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(config_json)),
  x INTEGER NOT NULL DEFAULT 0,
  y INTEGER NOT NULL DEFAULT 0,
  scale_percent INTEGER NOT NULL DEFAULT 100 CHECK (scale_percent BETWEEN 25 AND 400),
  z INTEGER NOT NULL DEFAULT 0,
  in_composition INTEGER NOT NULL DEFAULT 1 CHECK (in_composition IN (0, 1)),
  missing_variable_name TEXT,
  FOREIGN KEY (channel_id, overlay_id) REFERENCES overlays(channel_id, overlay_id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id, variable_name) REFERENCES channel_variables(channel_id, name) ON UPDATE CASCADE
);

INSERT INTO overlay_elements
  (element_id, channel_id, overlay_id, kind, label, variable_name, text, config_json, x, y,
   scale_percent, z, in_composition, missing_variable_name)
SELECT element_id, channel_id, overlay_id, kind, label, variable_name, text, config_json, x, y,
       scale_percent, z, in_composition, missing_variable_name
  FROM overlay_elements_css_length_backup;

DROP TABLE overlay_elements_css_length_backup;
CREATE INDEX overlay_elements_overlay_idx ON overlay_elements(channel_id, overlay_id);
CREATE INDEX overlay_elements_variable_idx ON overlay_elements(channel_id, variable_name);

CREATE TRIGGER panel_rev_overlays_insert AFTER INSERT ON overlays BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'overlays' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_overlays_update AFTER UPDATE ON overlays BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'overlays' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_overlays_delete AFTER DELETE ON overlays BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'overlays' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_overlay_elements_insert AFTER INSERT ON overlay_elements BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'overlay_elements' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_overlay_elements_update AFTER UPDATE ON overlay_elements BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'overlay_elements' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_overlay_elements_delete AFTER DELETE ON overlay_elements BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'overlay_elements' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
