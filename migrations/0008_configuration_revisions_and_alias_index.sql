ALTER TABLE channel_modules ADD COLUMN revision INTEGER NOT NULL DEFAULT 1
  CHECK (revision >= 1);

ALTER TABLE text_commands ADD COLUMN revision INTEGER NOT NULL DEFAULT 1
  CHECK (revision >= 1);

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

INSERT OR IGNORE INTO text_command_aliases (channel_id, alias, command_name)
SELECT text_commands.channel_id, aliases.value, text_commands.command_name
  FROM text_commands, json_each(text_commands.aliases_json) AS aliases
 WHERE aliases.type = 'text'
 ORDER BY text_commands.channel_id, aliases.value, text_commands.command_name;
