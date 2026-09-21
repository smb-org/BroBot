-- Art und Schalter je Textbefehl. Der Tabellenumbau trägt die bedingte
-- Antworttext-Regel in das SQLite-Schema ein.
ALTER TABLE textbefehle_commands RENAME TO textbefehle_commands_v1;
DROP INDEX IF EXISTS textbefehle_commands_channel_idx;

CREATE TABLE textbefehle_commands (
  channel_id TEXT NOT NULL,
  command_name TEXT NOT NULL,
  response_text TEXT NOT NULL,
  cooldown_seconds INTEGER NOT NULL DEFAULT 5 CHECK (cooldown_seconds >= 0 AND cooldown_seconds <= 86400),
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  art TEXT NOT NULL DEFAULT 'text' CHECK (art IN ('text', 'liste')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  PRIMARY KEY (channel_id, command_name),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE,
  CHECK (art = 'liste' OR length(trim(response_text)) > 0)
);

INSERT INTO textbefehle_commands
  (channel_id, command_name, response_text, cooldown_seconds, last_used_at, created_at, updated_at, art, enabled)
SELECT channel_id, command_name, response_text, cooldown_seconds, last_used_at, created_at, updated_at, 'text', 1
  FROM textbefehle_commands_v1;

DROP TABLE textbefehle_commands_v1;

CREATE INDEX textbefehle_commands_channel_idx
  ON textbefehle_commands(channel_id, command_name);
