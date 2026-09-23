ALTER TABLE text_commands ADD COLUMN aliases_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(aliases_json) AND json_type(aliases_json) = 'array'
         AND json_array_length(aliases_json) <= 10);
ALTER TABLE text_commands ADD COLUMN user_cooldown_seconds INTEGER NOT NULL DEFAULT 0
  CHECK (user_cooldown_seconds >= 0 AND user_cooldown_seconds <= 86400);
ALTER TABLE text_commands ADD COLUMN stream_condition TEXT NOT NULL DEFAULT 'any'
  CHECK (stream_condition IN ('any', 'online', 'offline'));
ALTER TABLE text_commands ADD COLUMN response_type TEXT NOT NULL DEFAULT 'say'
  CHECK (response_type IN ('say', 'reply', 'announcement'));

UPDATE text_commands SET response_type = 'reply';

CREATE TABLE text_command_user_cooldowns (
  channel_id TEXT NOT NULL,
  command_name TEXT NOT NULL,
  user_id TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, command_name, user_id),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE channel_stream_state (
  channel_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('online', 'offline')),
  changed_at TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('eventsub', 'helix')),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);
