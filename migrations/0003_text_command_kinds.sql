-- CREATE TABLE text_commands is rebuilt with the expanded closed kind set.
CREATE TABLE text_commands_new (
  channel_id TEXT NOT NULL,
  command_name TEXT NOT NULL,
  response_text TEXT NOT NULL,
  cooldown_seconds INTEGER NOT NULL DEFAULT 5 CHECK (cooldown_seconds >= 0 AND cooldown_seconds <= 86400),
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text'
  CHECK (kind IN ('text', 'list', 'uptime', 'followage', 'game', 'shoutout')),
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
  PRIMARY KEY (channel_id, command_name),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE,
  CHECK (kind = 'list' OR length(trim(response_text)) > 0)
);

INSERT INTO text_commands_new (
  channel_id, command_name, response_text, cooldown_seconds, last_used_at, created_at, updated_at,
  kind, enabled, minimum_level, aliases_json, user_cooldown_seconds, stream_condition, response_type,
  template_fields_json
)
SELECT channel_id, command_name, response_text, cooldown_seconds, last_used_at, created_at, updated_at,
       kind, enabled, minimum_level, aliases_json, user_cooldown_seconds, stream_condition, response_type, '{}'
  FROM text_commands;

DROP TABLE text_commands;
ALTER TABLE text_commands_new RENAME TO text_commands;

CREATE INDEX text_commands_channel_idx ON text_commands(channel_id, command_name);
