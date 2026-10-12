CREATE TABLE text_block_token_migration_names (
  channel_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  block_name TEXT NOT NULL,
  PRIMARY KEY (channel_id, position)
) WITHOUT ROWID;

INSERT INTO text_block_token_migration_names (channel_id, position, block_name)
SELECT channel_id, row_number() OVER (PARTITION BY channel_id ORDER BY block_name) - 1, block_name
  FROM text_blocks;

-- Namespaced block references count like their former bare-name tokens. The
-- five added characters in `{text.name}` must not make valid stored templates
-- fail the field's existing 500-character limit.
ALTER TABLE timers ADD COLUMN message_text TEXT NOT NULL DEFAULT '' CHECK (
  length(message_text) - 5 * ((length(message_text) - length(replace(message_text, '{text.', ''))) / 6) <= 500
);
UPDATE timers
   SET message_text = '{text.' || block_name || '}', revision = revision + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
ALTER TABLE timers DROP COLUMN block_name;

ALTER TABLE faq_entries ADD COLUMN answer_text TEXT NOT NULL DEFAULT '' CHECK (
  length(answer_text) - 5 * ((length(answer_text) - length(replace(answer_text, '{text.', ''))) / 6) <= 500
);
UPDATE faq_entries
   SET answer_text = '{text.' || answer_block || '}', revision = revision + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
ALTER TABLE faq_entries DROP COLUMN answer_block;

CREATE TABLE text_block_token_migration_commands AS
WITH RECURSIVE rewritten(row_id, content, position) AS (
  SELECT rowid, json_array(response_text, template_fields_json, timeout_fallback_text, timeout_reason), 0
    FROM text_commands
  UNION ALL
  SELECT rewritten.row_id,
         replace(rewritten.content, '{' || names.block_name || '}', '{text.' || names.block_name || '}'),
         rewritten.position + 1
    FROM rewritten
    JOIN text_commands AS command ON command.rowid = rewritten.row_id
    JOIN text_block_token_migration_names AS names
      ON names.channel_id = command.channel_id AND names.position = rewritten.position
)
SELECT row_id,
       json_extract(content, '$[0]') AS response_text,
       json_extract(content, '$[1]') AS template_fields_json,
       json_extract(content, '$[2]') AS timeout_fallback_text,
       json_extract(content, '$[3]') AS timeout_reason
  FROM rewritten
 WHERE position = (SELECT COUNT(*) FROM text_block_token_migration_names AS names
                    JOIN text_commands AS command ON command.rowid = rewritten.row_id
                   WHERE names.channel_id = command.channel_id);

CREATE TABLE text_block_token_migration_changed_commands AS
SELECT command.channel_id
  FROM text_commands AS command
  JOIN text_block_token_migration_commands AS rewritten ON rewritten.row_id = command.rowid
 WHERE command.response_text IS NOT rewritten.response_text
    OR command.template_fields_json IS NOT rewritten.template_fields_json
    OR command.timeout_fallback_text IS NOT rewritten.timeout_fallback_text
    OR command.timeout_reason IS NOT rewritten.timeout_reason;

UPDATE text_commands
   SET response_text = (SELECT response_text FROM text_block_token_migration_commands WHERE row_id = text_commands.rowid),
       template_fields_json = (SELECT template_fields_json FROM text_block_token_migration_commands WHERE row_id = text_commands.rowid),
       timeout_fallback_text = (SELECT timeout_fallback_text FROM text_block_token_migration_commands WHERE row_id = text_commands.rowid),
       timeout_reason = (SELECT timeout_reason FROM text_block_token_migration_commands WHERE row_id = text_commands.rowid),
       revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE rowid IN (SELECT row_id FROM text_block_token_migration_commands AS rewritten
                  WHERE response_text IS NOT text_commands.response_text
                     OR template_fields_json IS NOT text_commands.template_fields_json
                     OR timeout_fallback_text IS NOT text_commands.timeout_fallback_text
                     OR timeout_reason IS NOT text_commands.timeout_reason);

CREATE TABLE text_block_token_migration_variants AS
WITH RECURSIVE rewritten(row_id, content, position) AS (
  SELECT rowid, texts_json, 0 FROM text_block_variants
  UNION ALL
  SELECT rewritten.row_id,
         replace(rewritten.content, '{' || names.block_name || '}', '{text.' || names.block_name || '}'),
         rewritten.position + 1
    FROM rewritten
    JOIN text_block_variants AS variant ON variant.rowid = rewritten.row_id
    JOIN text_block_token_migration_names AS names
      ON names.channel_id = variant.channel_id AND names.position = rewritten.position
)
SELECT row_id, content
  FROM rewritten
 WHERE position = (SELECT COUNT(*) FROM text_block_token_migration_names AS names
                    JOIN text_block_variants AS variant ON variant.rowid = rewritten.row_id
                   WHERE names.channel_id = variant.channel_id);

CREATE TABLE text_block_token_migration_changed_blocks AS
SELECT DISTINCT variant.channel_id, variant.block_name
  FROM text_block_variants AS variant
  JOIN text_block_token_migration_variants AS rewritten ON rewritten.row_id = variant.rowid
 WHERE variant.texts_json IS NOT rewritten.content;

UPDATE text_block_variants
   SET texts_json = (SELECT content FROM text_block_token_migration_variants WHERE row_id = text_block_variants.rowid)
 WHERE rowid IN (SELECT row_id FROM text_block_token_migration_variants AS rewritten
                  JOIN text_block_variants AS variant ON variant.rowid = rewritten.row_id
                 WHERE variant.texts_json IS NOT rewritten.content);

UPDATE text_blocks
   SET revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE EXISTS (SELECT 1 FROM text_block_token_migration_changed_blocks AS changed
                WHERE changed.channel_id = text_blocks.channel_id AND changed.block_name = text_blocks.block_name);

CREATE TABLE text_block_token_migration_settings AS
WITH RECURSIVE rewritten(row_id, content, position) AS (
  SELECT rowid, settings, 0 FROM channel_modules
  UNION ALL
  SELECT rewritten.row_id,
         replace(rewritten.content, '{' || names.block_name || '}', '{text.' || names.block_name || '}'),
         rewritten.position + 1
    FROM rewritten
    JOIN channel_modules AS module ON module.rowid = rewritten.row_id
    JOIN text_block_token_migration_names AS names
      ON names.channel_id = module.channel_id AND names.position = rewritten.position
)
SELECT row_id, content
  FROM rewritten
 WHERE position = (SELECT COUNT(*) FROM text_block_token_migration_names AS names
                    JOIN channel_modules AS module ON module.rowid = rewritten.row_id
                   WHERE names.channel_id = module.channel_id);

CREATE TABLE text_block_token_migration_changed_settings AS
SELECT module.channel_id
  FROM channel_modules AS module
  JOIN text_block_token_migration_settings AS rewritten ON rewritten.row_id = module.rowid
 WHERE module.settings IS NOT rewritten.content;

UPDATE channel_modules
   SET settings = (SELECT content FROM text_block_token_migration_settings WHERE row_id = channel_modules.rowid),
       revision = revision + 1
 WHERE rowid IN (SELECT row_id FROM text_block_token_migration_settings AS rewritten
                  WHERE channel_modules.settings IS NOT rewritten.content);

CREATE TABLE text_block_token_migration_overlays AS
WITH RECURSIVE rewritten(row_id, content, position) AS (
  SELECT rowid, text, 0 FROM overlay_elements
  UNION ALL
  SELECT rewritten.row_id,
         replace(rewritten.content, '{' || names.block_name || '}', '{text.' || names.block_name || '}'),
         rewritten.position + 1
    FROM rewritten
    JOIN overlay_elements AS element ON element.rowid = rewritten.row_id
    JOIN text_block_token_migration_names AS names
      ON names.channel_id = element.channel_id AND names.position = rewritten.position
)
SELECT row_id, content
  FROM rewritten
 WHERE position = (SELECT COUNT(*) FROM text_block_token_migration_names AS names
                    JOIN overlay_elements AS element ON element.rowid = rewritten.row_id
                   WHERE names.channel_id = element.channel_id);

CREATE TABLE text_block_token_migration_changed_overlays AS
SELECT DISTINCT element.channel_id, element.overlay_id
  FROM overlay_elements AS element
  JOIN text_block_token_migration_overlays AS rewritten ON rewritten.row_id = element.rowid
 WHERE element.text IS NOT rewritten.content;

-- Preserve the 100-character semantic limit while allowing the five-character
-- namespace prefix for each stored block reference.
CREATE TABLE overlay_elements_migrated (
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

INSERT INTO overlay_elements_migrated
  (element_id, channel_id, overlay_id, kind, label, variable_name, text, config_json, x, y, scale_percent, z, in_composition, missing_variable_name)
SELECT element.element_id, element.channel_id, element.overlay_id, element.kind, element.label, element.variable_name,
       COALESCE((SELECT content FROM text_block_token_migration_overlays WHERE row_id = element.rowid), element.text),
       element.config_json, element.x, element.y, element.scale_percent, element.z, element.in_composition, element.missing_variable_name
  FROM overlay_elements AS element;

DROP TABLE overlay_elements;
ALTER TABLE overlay_elements_migrated RENAME TO overlay_elements;
CREATE INDEX overlay_elements_overlay_idx ON overlay_elements(channel_id, overlay_id);
CREATE INDEX overlay_elements_variable_idx ON overlay_elements(channel_id, variable_name);

CREATE TRIGGER panel_rev_overlay_elements_insert AFTER INSERT ON overlay_elements BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'overlay_elements' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_overlay_elements_update AFTER UPDATE ON overlay_elements BEGIN
  INSERT INTO panel_resource_revisions SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'overlay_elements' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_overlay_elements_delete AFTER DELETE ON overlay_elements BEGIN
  INSERT INTO panel_resource_revisions SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'overlay_elements' ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

UPDATE overlays
   SET revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE EXISTS (SELECT 1 FROM text_block_token_migration_changed_overlays AS changed
                WHERE changed.channel_id = overlays.channel_id AND changed.overlay_id = overlays.overlay_id);

CREATE TABLE text_block_token_migration_changed_channels (channel_id TEXT PRIMARY KEY);
INSERT OR IGNORE INTO text_block_token_migration_changed_channels SELECT channel_id FROM timers;
INSERT OR IGNORE INTO text_block_token_migration_changed_channels SELECT channel_id FROM faq_entries;
INSERT OR IGNORE INTO text_block_token_migration_changed_channels SELECT channel_id FROM text_block_token_migration_changed_commands;
INSERT OR IGNORE INTO text_block_token_migration_changed_channels SELECT channel_id FROM text_block_token_migration_changed_blocks;
INSERT OR IGNORE INTO text_block_token_migration_changed_channels SELECT channel_id FROM text_block_token_migration_changed_settings;
INSERT OR IGNORE INTO text_block_token_migration_changed_channels SELECT channel_id FROM text_block_token_migration_changed_overlays;

UPDATE text_library_settings
   SET graph_revision = graph_revision + 1
 WHERE channel_id IN (SELECT channel_id FROM text_block_token_migration_changed_channels);

DROP TABLE text_block_token_migration_names;
DROP TABLE text_block_token_migration_commands;
DROP TABLE text_block_token_migration_changed_commands;
DROP TABLE text_block_token_migration_variants;
DROP TABLE text_block_token_migration_changed_blocks;
DROP TABLE text_block_token_migration_settings;
DROP TABLE text_block_token_migration_changed_settings;
DROP TABLE text_block_token_migration_overlays;
DROP TABLE text_block_token_migration_changed_overlays;
DROP TABLE text_block_token_migration_changed_channels;
