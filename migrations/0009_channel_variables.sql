CREATE TABLE channel_variables (
  channel_id TEXT NOT NULL,
  name TEXT NOT NULL
    CHECK (length(name) BETWEEN 1 AND 32 AND name GLOB '[a-z]*' AND name NOT GLOB '*[^a-z0-9_]*'),
  value INTEGER NOT NULL DEFAULT 0
    CHECK (typeof(value) = 'integer' AND value BETWEEN -999999999 AND 999999999),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 80),
  reset_on_stream_start INTEGER NOT NULL DEFAULT 0 CHECK (reset_on_stream_start IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, name),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE text_command_aliases_migration_backup AS
SELECT channel_id, alias, command_name FROM text_command_aliases;

DROP TABLE text_command_aliases;

CREATE TABLE text_command_user_cooldowns_migration_backup AS
SELECT channel_id, command_name, user_id, last_used_at FROM text_command_user_cooldowns;

DROP TABLE text_command_user_cooldowns;

ALTER TABLE text_commands RENAME TO text_commands_migration_old;

CREATE TABLE text_commands_migration_new (
  channel_id TEXT NOT NULL,
  command_name TEXT NOT NULL,
  response_text TEXT NOT NULL,
  cooldown_seconds INTEGER NOT NULL DEFAULT 5 CHECK (cooldown_seconds >= 0 AND cooldown_seconds <= 86400),
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text'
    CHECK (kind IN ('text', 'list', 'shoutout')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  minimum_level TEXT NOT NULL DEFAULT 'everyone'
    CHECK (minimum_level IN ('everyone', 'subscriber', 'vip', 'moderator', 'broadcaster')),
  aliases_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(aliases_json) AND json_type(aliases_json) = 'array' AND json_array_length(aliases_json) <= 10),
  user_cooldown_seconds INTEGER NOT NULL DEFAULT 0
    CHECK (user_cooldown_seconds >= 0 AND user_cooldown_seconds <= 86400),
  stream_condition TEXT NOT NULL DEFAULT 'any'
    CHECK (stream_condition IN ('any', 'online', 'offline')),
  response_type TEXT NOT NULL DEFAULT 'say'
    CHECK (response_type IN ('say', 'reply', 'announcement')),
  template_fields_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(template_fields_json) AND json_type(template_fields_json) = 'object'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  variable_name TEXT,
  variable_operation TEXT CHECK (variable_operation IN ('add', 'subtract', 'set', 'set_argument')),
  variable_amount INTEGER,
  PRIMARY KEY (channel_id, command_name),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id, variable_name) REFERENCES channel_variables(channel_id, name) ON UPDATE CASCADE,
  CHECK ((variable_name IS NULL) = (variable_operation IS NULL) AND (variable_name IS NULL) = (variable_amount IS NULL)),
  CHECK (variable_operation IS NULL
    OR (variable_operation IN ('add', 'subtract') AND variable_amount BETWEEN 1 AND 1000)
    OR (variable_operation = 'set' AND variable_amount BETWEEN -999999999 AND 999999999)
    OR (variable_operation = 'set_argument' AND variable_amount = 0)),
  CHECK (kind = 'list' OR length(trim(response_text)) > 0 OR (kind = 'text' AND variable_name IS NOT NULL))
);

INSERT INTO text_commands_migration_new (
  channel_id, command_name, response_text, cooldown_seconds, last_used_at, created_at, updated_at,
  kind, enabled, minimum_level, aliases_json, user_cooldown_seconds, stream_condition, response_type,
  template_fields_json, revision, use_count, variable_name, variable_operation, variable_amount
)
SELECT channel_id, command_name, response_text, cooldown_seconds, last_used_at, created_at, updated_at,
       CASE WHEN kind IN ('uptime', 'followage', 'game') THEN 'text' ELSE kind END,
       enabled, minimum_level, aliases_json, user_cooldown_seconds, stream_condition, response_type,
       template_fields_json, revision, 0, NULL, NULL, NULL
  FROM text_commands_migration_old;

DROP TABLE text_commands_migration_old;
ALTER TABLE text_commands_migration_new RENAME TO text_commands;

CREATE INDEX text_commands_channel_idx ON text_commands(channel_id, command_name);

CREATE TABLE text_command_aliases (
  channel_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  command_name TEXT NOT NULL,
  PRIMARY KEY (channel_id, alias),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id, command_name) REFERENCES text_commands(channel_id, command_name)
    ON UPDATE CASCADE ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX text_command_aliases_command_idx
  ON text_command_aliases(channel_id, command_name);

CREATE TABLE text_command_user_cooldowns (
  channel_id TEXT NOT NULL,
  command_name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, command_name, user_id),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
) WITHOUT ROWID;

INSERT INTO text_command_user_cooldowns (channel_id, command_name, user_id, last_used_at)
SELECT channel_id, command_name, user_id, last_used_at FROM text_command_user_cooldowns_migration_backup;

INSERT INTO text_command_aliases (channel_id, alias, command_name)
SELECT channel_id, alias, command_name FROM text_command_aliases_migration_backup;

DROP TABLE text_command_aliases_migration_backup;
DROP TABLE text_command_user_cooldowns_migration_backup;
