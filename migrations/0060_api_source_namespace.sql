ALTER TABLE api_sources ADD COLUMN last_fetched_at TEXT;
ALTER TABLE api_sources ADD COLUMN last_status TEXT CHECK (last_status IS NULL OR last_status IN ('ok', 'error'));
ALTER TABLE api_sources ADD COLUMN last_error TEXT CHECK (
  last_error IS NULL OR last_error IN (
    'unreachable', 'timeout', 'http_error', 'invalid_json', 'invalid_expression',
    'unsupported_expression', 'missing_value', 'invalid_url', 'response_too_large',
    'redirect_error', 'quota_exceeded'
  )
);

CREATE TABLE api_source_token_migration_names (
  channel_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  source_name TEXT NOT NULL,
  PRIMARY KEY (channel_id, position)
) WITHOUT ROWID;

INSERT INTO api_source_token_migration_names (channel_id, position, source_name)
SELECT channel_id, row_number() OVER (PARTITION BY channel_id ORDER BY source_name) - 1, source_name
  FROM api_sources;

CREATE TABLE api_source_token_migration_timers AS
WITH RECURSIVE rewritten(row_id, content, position) AS (
  SELECT rowid, message_text, 0 FROM timers
  UNION ALL
  SELECT rewritten.row_id,
         replace(rewritten.content, '{api_source.value ' || names.source_name || '}', '{api.' || names.source_name || '}'),
         rewritten.position + 1
    FROM rewritten
    JOIN timers AS timer ON timer.rowid = rewritten.row_id
    JOIN api_source_token_migration_names AS names
      ON names.channel_id = timer.channel_id AND names.position = rewritten.position
)
SELECT row_id, content
  FROM rewritten
 WHERE position = (SELECT COUNT(*) FROM api_source_token_migration_names AS names
                    JOIN timers AS timer ON timer.rowid = rewritten.row_id
                   WHERE names.channel_id = timer.channel_id);

CREATE TABLE api_source_token_migration_changed_timers AS
SELECT DISTINCT timer.channel_id
  FROM timers AS timer
  JOIN api_source_token_migration_timers AS rewritten ON rewritten.row_id = timer.rowid
 WHERE timer.message_text IS NOT rewritten.content;

UPDATE timers
   SET message_text = (SELECT content FROM api_source_token_migration_timers WHERE row_id = timers.rowid),
       revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE rowid IN (SELECT row_id FROM api_source_token_migration_timers AS rewritten
                  WHERE rewritten.content IS NOT timers.message_text);

CREATE TABLE api_source_token_migration_faq AS
WITH RECURSIVE rewritten(channel_id, faq_id, content, position) AS (
  SELECT channel_id, faq_id, answer_text, 0 FROM faq_entries
  UNION ALL
  SELECT rewritten.channel_id, rewritten.faq_id,
         replace(rewritten.content, '{api_source.value ' || names.source_name || '}', '{api.' || names.source_name || '}'),
         rewritten.position + 1
    FROM rewritten
    JOIN faq_entries AS entry ON entry.channel_id = rewritten.channel_id AND entry.faq_id = rewritten.faq_id
    JOIN api_source_token_migration_names AS names
      ON names.channel_id = entry.channel_id AND names.position = rewritten.position
)
SELECT channel_id, faq_id, content
  FROM rewritten
 WHERE position = (SELECT COUNT(*) FROM api_source_token_migration_names AS names
                    WHERE names.channel_id = rewritten.channel_id);

CREATE TABLE api_source_token_migration_changed_faq AS
SELECT DISTINCT entry.channel_id
  FROM faq_entries AS entry
  JOIN api_source_token_migration_faq AS rewritten
    ON rewritten.channel_id = entry.channel_id AND rewritten.faq_id = entry.faq_id
 WHERE entry.answer_text IS NOT rewritten.content;

UPDATE faq_entries
   SET answer_text = (SELECT content FROM api_source_token_migration_faq
                       WHERE channel_id = faq_entries.channel_id AND faq_id = faq_entries.faq_id),
       revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE EXISTS (SELECT 1 FROM api_source_token_migration_faq AS rewritten
                WHERE rewritten.channel_id = faq_entries.channel_id AND rewritten.faq_id = faq_entries.faq_id
                  AND rewritten.content IS NOT faq_entries.answer_text);

CREATE TABLE api_source_token_migration_commands AS
WITH RECURSIVE rewritten(row_id, content, position) AS (
  SELECT rowid, json_array(response_text, template_fields_json, timeout_fallback_text, timeout_reason), 0
    FROM text_commands
  UNION ALL
  SELECT rewritten.row_id,
         replace(rewritten.content, '{api_source.value ' || names.source_name || '}', '{api.' || names.source_name || '}'),
         rewritten.position + 1
    FROM rewritten
    JOIN text_commands AS command ON command.rowid = rewritten.row_id
    JOIN api_source_token_migration_names AS names
      ON names.channel_id = command.channel_id AND names.position = rewritten.position
)
SELECT row_id,
       json_extract(content, '$[0]') AS response_text,
       json_extract(content, '$[1]') AS template_fields_json,
       json_extract(content, '$[2]') AS timeout_fallback_text,
       json_extract(content, '$[3]') AS timeout_reason
  FROM rewritten
 WHERE position = (SELECT COUNT(*) FROM api_source_token_migration_names AS names
                    JOIN text_commands AS command ON command.rowid = rewritten.row_id
                   WHERE names.channel_id = command.channel_id);

CREATE TABLE api_source_token_migration_changed_commands AS
SELECT command.channel_id
  FROM text_commands AS command
  JOIN api_source_token_migration_commands AS rewritten ON rewritten.row_id = command.rowid
 WHERE command.response_text IS NOT rewritten.response_text
    OR command.template_fields_json IS NOT rewritten.template_fields_json
    OR command.timeout_fallback_text IS NOT rewritten.timeout_fallback_text
    OR command.timeout_reason IS NOT rewritten.timeout_reason;

UPDATE text_commands
   SET response_text = (SELECT response_text FROM api_source_token_migration_commands WHERE row_id = text_commands.rowid),
       template_fields_json = (SELECT template_fields_json FROM api_source_token_migration_commands WHERE row_id = text_commands.rowid),
       timeout_fallback_text = (SELECT timeout_fallback_text FROM api_source_token_migration_commands WHERE row_id = text_commands.rowid),
       timeout_reason = (SELECT timeout_reason FROM api_source_token_migration_commands WHERE row_id = text_commands.rowid),
       revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE rowid IN (SELECT row_id FROM api_source_token_migration_commands AS rewritten
                  WHERE response_text IS NOT text_commands.response_text
                     OR template_fields_json IS NOT text_commands.template_fields_json
                     OR timeout_fallback_text IS NOT text_commands.timeout_fallback_text
                     OR timeout_reason IS NOT text_commands.timeout_reason);

CREATE TABLE api_source_token_migration_variants AS
WITH RECURSIVE rewritten(row_id, content, position) AS (
  SELECT rowid, texts_json, 0 FROM text_block_variants
  UNION ALL
  SELECT rewritten.row_id,
         replace(rewritten.content, '{api_source.value ' || names.source_name || '}', '{api.' || names.source_name || '}'),
         rewritten.position + 1
    FROM rewritten
    JOIN text_block_variants AS variant ON variant.rowid = rewritten.row_id
    JOIN api_source_token_migration_names AS names
      ON names.channel_id = variant.channel_id AND names.position = rewritten.position
)
SELECT row_id, content
  FROM rewritten
 WHERE position = (SELECT COUNT(*) FROM api_source_token_migration_names AS names
                    JOIN text_block_variants AS variant ON variant.rowid = rewritten.row_id
                   WHERE names.channel_id = variant.channel_id);

CREATE TABLE api_source_token_migration_changed_blocks AS
SELECT DISTINCT variant.channel_id, variant.block_name
  FROM text_block_variants AS variant
  JOIN api_source_token_migration_variants AS rewritten ON rewritten.row_id = variant.rowid
 WHERE variant.texts_json IS NOT rewritten.content;

UPDATE text_block_variants
   SET texts_json = (SELECT content FROM api_source_token_migration_variants WHERE row_id = text_block_variants.rowid)
 WHERE rowid IN (SELECT row_id FROM api_source_token_migration_variants AS rewritten
                  JOIN text_block_variants AS variant ON variant.rowid = rewritten.row_id
                 WHERE variant.texts_json IS NOT rewritten.content);

UPDATE text_blocks
   SET revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE EXISTS (SELECT 1 FROM api_source_token_migration_changed_blocks AS changed
                WHERE changed.channel_id = text_blocks.channel_id AND changed.block_name = text_blocks.block_name);

CREATE TABLE api_source_token_migration_settings AS
WITH RECURSIVE rewritten(row_id, content, position) AS (
  SELECT rowid, settings, 0 FROM channel_modules
  UNION ALL
  SELECT rewritten.row_id,
         replace(rewritten.content, '{api_source.value ' || names.source_name || '}', '{api.' || names.source_name || '}'),
         rewritten.position + 1
    FROM rewritten
    JOIN channel_modules AS module ON module.rowid = rewritten.row_id
    JOIN api_source_token_migration_names AS names
      ON names.channel_id = module.channel_id AND names.position = rewritten.position
)
SELECT row_id, content
  FROM rewritten
 WHERE position = (SELECT COUNT(*) FROM api_source_token_migration_names AS names
                    JOIN channel_modules AS module ON module.rowid = rewritten.row_id
                   WHERE names.channel_id = module.channel_id);

CREATE TABLE api_source_token_migration_changed_settings AS
SELECT module.channel_id
  FROM channel_modules AS module
  JOIN api_source_token_migration_settings AS rewritten ON rewritten.row_id = module.rowid
 WHERE module.settings IS NOT rewritten.content;

UPDATE channel_modules
   SET settings = (SELECT content FROM api_source_token_migration_settings WHERE row_id = channel_modules.rowid),
       revision = revision + 1
 WHERE rowid IN (SELECT row_id FROM api_source_token_migration_settings AS rewritten
                  WHERE channel_modules.settings IS NOT rewritten.content);

CREATE TABLE api_source_token_migration_overlays AS
WITH RECURSIVE rewritten(row_id, content, position) AS (
  SELECT rowid, text, 0 FROM overlay_elements
  UNION ALL
  SELECT rewritten.row_id,
         replace(rewritten.content, '{api_source.value ' || names.source_name || '}', '{api.' || names.source_name || '}'),
         rewritten.position + 1
    FROM rewritten
    JOIN overlay_elements AS element ON element.rowid = rewritten.row_id
    JOIN api_source_token_migration_names AS names
      ON names.channel_id = element.channel_id AND names.position = rewritten.position
)
SELECT row_id, content
  FROM rewritten
 WHERE position = (SELECT COUNT(*) FROM api_source_token_migration_names AS names
                    JOIN overlay_elements AS element ON element.rowid = rewritten.row_id
                   WHERE names.channel_id = element.channel_id);

CREATE TABLE api_source_token_migration_changed_overlays AS
SELECT DISTINCT element.channel_id, element.overlay_id
  FROM overlay_elements AS element
  JOIN api_source_token_migration_overlays AS rewritten ON rewritten.row_id = element.rowid
 WHERE element.text IS NOT rewritten.content;

UPDATE overlay_elements
   SET text = (SELECT content FROM api_source_token_migration_overlays WHERE row_id = overlay_elements.rowid)
 WHERE rowid IN (SELECT row_id FROM api_source_token_migration_overlays AS rewritten
                  JOIN overlay_elements AS element ON element.rowid = rewritten.row_id
                 WHERE element.text IS NOT rewritten.content);

CREATE TABLE api_source_token_migration_chat_votes AS
WITH RECURSIVE rewritten(channel_id, template_id, content, position) AS (
  SELECT channel_id, id, json_array(title, labels), 0 FROM chat_vote_templates
  UNION ALL
  SELECT rewritten.channel_id, rewritten.template_id,
         replace(rewritten.content, '{api_source.value ' || names.source_name || '}', '{api.' || names.source_name || '}'),
         rewritten.position + 1
    FROM rewritten
    JOIN chat_vote_templates AS template ON template.channel_id = rewritten.channel_id AND template.id = rewritten.template_id
    JOIN api_source_token_migration_names AS names
      ON names.channel_id = template.channel_id AND names.position = rewritten.position
)
SELECT channel_id, template_id,
       json_extract(content, '$[0]') AS title,
       json_extract(content, '$[1]') AS labels
  FROM rewritten
 WHERE position = (SELECT COUNT(*) FROM api_source_token_migration_names AS names
                    WHERE names.channel_id = rewritten.channel_id);

CREATE TABLE api_source_token_migration_changed_chat_votes AS
SELECT DISTINCT template.channel_id
  FROM chat_vote_templates AS template
  JOIN api_source_token_migration_chat_votes AS rewritten
    ON rewritten.channel_id = template.channel_id AND rewritten.template_id = template.id
 WHERE template.title IS NOT rewritten.title OR template.labels IS NOT rewritten.labels;

UPDATE chat_vote_templates
   SET title = (SELECT title FROM api_source_token_migration_chat_votes
                 WHERE channel_id = chat_vote_templates.channel_id AND template_id = chat_vote_templates.id),
       labels = (SELECT labels FROM api_source_token_migration_chat_votes
                  WHERE channel_id = chat_vote_templates.channel_id AND template_id = chat_vote_templates.id),
       revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE EXISTS (SELECT 1 FROM api_source_token_migration_chat_votes AS rewritten
                WHERE rewritten.channel_id = chat_vote_templates.channel_id AND rewritten.template_id = chat_vote_templates.id
                  AND (rewritten.title IS NOT chat_vote_templates.title OR rewritten.labels IS NOT chat_vote_templates.labels));

UPDATE overlays
   SET revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE EXISTS (SELECT 1 FROM api_source_token_migration_changed_overlays AS changed
                WHERE changed.channel_id = overlays.channel_id AND changed.overlay_id = overlays.overlay_id);

CREATE TABLE api_source_token_migration_changed_channels (channel_id TEXT PRIMARY KEY);
INSERT OR IGNORE INTO api_source_token_migration_changed_channels SELECT channel_id FROM api_source_token_migration_changed_timers;
INSERT OR IGNORE INTO api_source_token_migration_changed_channels SELECT channel_id FROM api_source_token_migration_changed_faq;
INSERT OR IGNORE INTO api_source_token_migration_changed_channels SELECT channel_id FROM api_source_token_migration_changed_commands;
INSERT OR IGNORE INTO api_source_token_migration_changed_channels SELECT channel_id FROM api_source_token_migration_changed_blocks;
INSERT OR IGNORE INTO api_source_token_migration_changed_channels SELECT channel_id FROM api_source_token_migration_changed_settings;
INSERT OR IGNORE INTO api_source_token_migration_changed_channels SELECT channel_id FROM api_source_token_migration_changed_overlays;
INSERT OR IGNORE INTO api_source_token_migration_changed_channels SELECT channel_id FROM api_source_token_migration_changed_chat_votes;

UPDATE text_library_settings
   SET graph_revision = graph_revision + 1
 WHERE channel_id IN (SELECT channel_id FROM api_source_token_migration_changed_channels);

DROP TABLE api_source_token_migration_names;
DROP TABLE api_source_token_migration_timers;
DROP TABLE api_source_token_migration_changed_timers;
DROP TABLE api_source_token_migration_faq;
DROP TABLE api_source_token_migration_changed_faq;
DROP TABLE api_source_token_migration_commands;
DROP TABLE api_source_token_migration_changed_commands;
DROP TABLE api_source_token_migration_variants;
DROP TABLE api_source_token_migration_changed_blocks;
DROP TABLE api_source_token_migration_settings;
DROP TABLE api_source_token_migration_changed_settings;
DROP TABLE api_source_token_migration_overlays;
DROP TABLE api_source_token_migration_changed_overlays;
DROP TABLE api_source_token_migration_chat_votes;
DROP TABLE api_source_token_migration_changed_chat_votes;
DROP TABLE api_source_token_migration_changed_channels;
