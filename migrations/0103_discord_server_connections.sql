CREATE TABLE discord_guilds (
  channel_id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL UNIQUE,
  connected_at TEXT NOT NULL,
  connected_by TEXT NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE TABLE discord_role_mappings (
  channel_id TEXT NOT NULL,
  rank_type TEXT NOT NULL CHECK (rank_type IN ('vip', 'moderator')),
  role_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, rank_type),
  FOREIGN KEY (channel_id) REFERENCES discord_guilds(channel_id) ON DELETE CASCADE
);

CREATE TABLE discord_server_oauth_transactions (
  state_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  member_user_id TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE INDEX discord_server_oauth_transactions_expiry_idx
  ON discord_server_oauth_transactions(expires_at);
