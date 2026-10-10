CREATE TABLE chat_vote_templates (
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  shortcut TEXT CHECK (shortcut IS NULL OR (length(shortcut) BETWEEN 1 AND 24)),
  title TEXT NOT NULL DEFAULT '' CHECK (length(title) <= 80),
  labels TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(labels) AND json_type(labels) = 'array' AND json_array_length(labels) BETWEEN 0 AND 9
  ),
  free_text_mode TEXT CHECK (free_text_mode IS NULL OR free_text_mode IN ('first_word', 'whole_message')),
  duration_seconds INTEGER NOT NULL DEFAULT 0 CHECK (
    typeof(duration_seconds) = 'integer' AND duration_seconds BETWEEN 0 AND 14400
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (typeof(revision) = 'integer' AND revision > 0),
  legacy_alias TEXT CHECK (legacy_alias IS NULL OR legacy_alias IN ('yesno', 'zeroOne', 'oneTwo', 'scale', 'options')),
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, id)
) WITHOUT ROWID;

CREATE UNIQUE INDEX chat_vote_templates_channel_shortcut_idx
  ON chat_vote_templates(channel_id, shortcut)
  WHERE shortcut IS NOT NULL;

CREATE INDEX chat_vote_templates_channel_last_used_idx
  ON chat_vote_templates(channel_id, last_used_at DESC);

WITH RECURSIVE legacy_fields(channel_id, legacy_alias, title, shortcut, raw_labels, duration_seconds) AS (
  SELECT channel_id, 'yesno', 'Ja/Nein', 'janein',
         json_extract(settings, '$.yesNoLabels'),
         CASE WHEN json_type(settings, '$.autoCloseSeconds') = 'integer'
                    AND json_extract(settings, '$.autoCloseSeconds') BETWEEN 0 AND 14400
              THEN json_extract(settings, '$.autoCloseSeconds') ELSE 0 END
    FROM channel_modules WHERE module_id = 'chat_voting'
  UNION ALL
  SELECT channel_id, 'zeroOne', 'Ja/Nein',
         CASE WHEN COALESCE(trim(json_extract(settings, '$.yesNoLabels')), '') <> '' THEN 'janein2' ELSE 'janein' END,
         json_extract(settings, '$.zeroOneLabels'),
         CASE WHEN json_type(settings, '$.autoCloseSeconds') = 'integer'
                    AND json_extract(settings, '$.autoCloseSeconds') BETWEEN 0 AND 14400
              THEN json_extract(settings, '$.autoCloseSeconds') ELSE 0 END
    FROM channel_modules WHERE module_id = 'chat_voting'
  UNION ALL
  SELECT channel_id, 'oneTwo', 'Ja/Nein',
         CASE WHEN COALESCE(trim(json_extract(settings, '$.yesNoLabels')), '') <> '' THEN 'janein3'
              WHEN COALESCE(trim(json_extract(settings, '$.zeroOneLabels')), '') <> '' THEN 'janein2'
              ELSE 'janein' END,
         json_extract(settings, '$.oneTwoLabels'),
         CASE WHEN json_type(settings, '$.autoCloseSeconds') = 'integer'
                    AND json_extract(settings, '$.autoCloseSeconds') BETWEEN 0 AND 14400
              THEN json_extract(settings, '$.autoCloseSeconds') ELSE 0 END
    FROM channel_modules WHERE module_id = 'chat_voting'
  UNION ALL
  SELECT channel_id, 'scale', 'Skala', 'skala',
         json_extract(settings, '$.scaleLabels'),
         CASE WHEN json_type(settings, '$.autoCloseSeconds') = 'integer'
                    AND json_extract(settings, '$.autoCloseSeconds') BETWEEN 0 AND 14400
              THEN json_extract(settings, '$.autoCloseSeconds') ELSE 0 END
    FROM channel_modules WHERE module_id = 'chat_voting'
  UNION ALL
  SELECT channel_id, 'options', 'Optionen', 'optionen',
         json_extract(settings, '$.optionLabels'),
         CASE WHEN json_type(settings, '$.autoCloseSeconds') = 'integer'
                    AND json_extract(settings, '$.autoCloseSeconds') BETWEEN 0 AND 14400
              THEN json_extract(settings, '$.autoCloseSeconds') ELSE 0 END
    FROM channel_modules WHERE module_id = 'chat_voting'
), label_parts(channel_id, legacy_alias, title, shortcut, duration_seconds, part_index, remaining) AS (
  SELECT channel_id, legacy_alias, title, shortcut, duration_seconds, 1, raw_labels
    FROM legacy_fields
   WHERE raw_labels IS NOT NULL AND trim(raw_labels) <> ''
  UNION ALL
  SELECT channel_id, legacy_alias, title, shortcut, duration_seconds, part_index + 1,
         substr(remaining, instr(remaining, '|') + 1)
    FROM label_parts
   WHERE instr(remaining, '|') > 0
), template_labels AS (
  SELECT channel_id, legacy_alias, title, shortcut, duration_seconds,
         json_group_array(trim(CASE WHEN instr(remaining, '|') > 0
                                    THEN substr(remaining, 1, instr(remaining, '|') - 1)
                                    ELSE remaining END) ORDER BY part_index) AS labels,
         COUNT(*) AS label_count
    FROM label_parts
   GROUP BY channel_id, legacy_alias, title, shortcut, duration_seconds
)
INSERT INTO chat_vote_templates (
  id, channel_id, shortcut, title, labels, free_text_mode, duration_seconds,
  revision, legacy_alias, last_used_at, created_at, updated_at
)
SELECT lower(hex(randomblob(16))), channel_id, shortcut, title, labels, NULL, duration_seconds,
       1, legacy_alias, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM template_labels
 WHERE label_count <= 9 AND (legacy_alias <> 'options' OR label_count >= 2);
