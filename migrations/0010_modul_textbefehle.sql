-- Kanalgebundene Textbefehle mit eigener Abkühlzeit und atomarem Nutzungszeitpunkt.
CREATE TABLE IF NOT EXISTS textbefehle_commands (
  channel_id TEXT NOT NULL,
  command_name TEXT NOT NULL,
  response_text TEXT NOT NULL,
  cooldown_seconds INTEGER NOT NULL DEFAULT 5 CHECK (cooldown_seconds >= 0 AND cooldown_seconds <= 86400),
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, command_name),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS textbefehle_commands_channel_idx
  ON textbefehle_commands(channel_id, command_name);
