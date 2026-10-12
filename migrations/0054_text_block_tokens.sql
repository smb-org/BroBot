CREATE TABLE text_block_token_migration_names (
  channel_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  block_name TEXT NOT NULL,
  PRIMARY KEY (channel_id, position)
) WITHOUT ROWID;

INSERT INTO text_block_token_migration_names (channel_id, position, block_name)
SELECT channel_id, row_number() OVER (PARTITION BY channel_id ORDER BY block_name) - 1, block_name
  FROM text_blocks;

ALTER TABLE timers ADD COLUMN message_text TEXT NOT NULL DEFAULT '' CHECK (length(message_text) <= 500);
UPDATE timers SET message_text = '{text.' || block_name || '}';
ALTER TABLE timers DROP COLUMN block_name;

ALTER TABLE faq_entries ADD COLUMN answer_text TEXT NOT NULL DEFAULT '' CHECK (length(answer_text) <= 500);
UPDATE faq_entries SET answer_text = '{text.' || answer_block || '}';
ALTER TABLE faq_entries DROP COLUMN answer_block;

WITH RECURSIVE rewritten(row_id, content, position) AS (
  SELECT rowid, response_text, 0 FROM text_commands
  UNION ALL
  SELECT rewritten.row_id,
         replace(rewritten.content, '{' || names.block_name || '}', '{text.' || names.block_name || '}'),
         rewritten.position + 1
    FROM rewritten
    JOIN text_commands AS command ON command.rowid = rewritten.row_id
    JOIN text_block_token_migration_names AS names
      ON names.channel_id = command.channel_id AND names.position = rewritten.position
)
UPDATE text_commands
   SET response_text = (SELECT content FROM rewritten WHERE row_id = text_commands.rowid ORDER BY position DESC LIMIT 1);

WITH RECURSIVE rewritten(row_id, content, position) AS (
  SELECT rowid, json_array(timeout_fallback_text, template_fields_json, timeout_reason), 0 FROM text_commands
  UNION ALL
  SELECT rewritten.row_id,
         replace(rewritten.content, '{' || names.block_name || '}', '{text.' || names.block_name || '}'),
         rewritten.position + 1
    FROM rewritten
    JOIN text_commands AS command ON command.rowid = rewritten.row_id
    JOIN text_block_token_migration_names AS names
      ON names.channel_id = command.channel_id AND names.position = rewritten.position
)
UPDATE text_commands
   SET timeout_fallback_text = json_extract((
         SELECT content FROM rewritten WHERE row_id = text_commands.rowid ORDER BY position DESC LIMIT 1
       ), '$[0]'),
       template_fields_json = json_extract((
         SELECT content FROM rewritten WHERE row_id = text_commands.rowid ORDER BY position DESC LIMIT 1
       ), '$[1]'),
       timeout_reason = json_extract((
         SELECT content FROM rewritten WHERE row_id = text_commands.rowid ORDER BY position DESC LIMIT 1
       ), '$[2]');

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
UPDATE text_block_variants
   SET texts_json = (SELECT content FROM rewritten WHERE row_id = text_block_variants.rowid ORDER BY position DESC LIMIT 1);

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
UPDATE channel_modules
   SET settings = (SELECT content FROM rewritten WHERE row_id = channel_modules.rowid ORDER BY position DESC LIMIT 1);

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
UPDATE overlay_elements
   SET text = (SELECT content FROM rewritten WHERE row_id = overlay_elements.rowid ORDER BY position DESC LIMIT 1);

DROP TABLE text_block_token_migration_names;
