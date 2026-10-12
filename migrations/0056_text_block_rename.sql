CREATE TABLE text_block_variants_rename_migration (
  channel_id TEXT NOT NULL,
  block_name TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9),
  conditions_json TEXT NOT NULL CHECK (json_valid(conditions_json) AND json_type(conditions_json) = 'object'),
  texts_json TEXT NOT NULL CHECK (json_valid(texts_json) AND json_type(texts_json) = 'array'),
  last_chosen_index INTEGER NOT NULL DEFAULT -1 CHECK (last_chosen_index >= -1),
  PRIMARY KEY (channel_id, block_name, variant_id),
  UNIQUE (channel_id, block_name, position),
  FOREIGN KEY (channel_id, block_name) REFERENCES text_blocks(channel_id, block_name) ON UPDATE CASCADE ON DELETE CASCADE
);

INSERT INTO text_block_variants_rename_migration (
  channel_id, block_name, variant_id, position, conditions_json, texts_json, last_chosen_index
)
SELECT channel_id, block_name, variant_id, position, conditions_json, texts_json, last_chosen_index
  FROM text_block_variants;

DROP TABLE text_block_variants;
ALTER TABLE text_block_variants_rename_migration RENAME TO text_block_variants;

CREATE TRIGGER panel_rev_text_block_variants_insert AFTER INSERT ON text_block_variants BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'text_block_variants'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_text_block_variants_update AFTER UPDATE ON text_block_variants BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'text_block_variants'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_text_block_variants_delete AFTER DELETE ON text_block_variants BEGIN
  INSERT INTO panel_resource_revisions
  SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'text_block_variants'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
