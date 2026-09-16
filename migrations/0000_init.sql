-- Grundschema für kanalgebundene Zustände. Fachliche Tabellen kommen mit dem
-- jeweiligen Modul und gehören nicht in diese Initialmigration.

CREATE TABLE channels (
  channel_id TEXT PRIMARY KEY,
  login TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE channel_members (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, user_id),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE TABLE twitch_connections (
  connection_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('broadcaster', 'bot')),
  scopes_json TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (channel_id, purpose),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE TABLE channel_modules (
  channel_id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  settings TEXT NOT NULL DEFAULT '{}',
  UNIQUE (channel_id, module_id),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE INDEX channel_members_channel_idx ON channel_members(channel_id);
CREATE INDEX channel_members_channel_role_idx ON channel_members(channel_id, role);
CREATE INDEX twitch_connections_channel_idx ON twitch_connections(channel_id);
CREATE INDEX twitch_connections_expiry_idx ON twitch_connections(channel_id, expires_at);
CREATE INDEX channel_modules_channel_idx ON channel_modules(channel_id);
