CREATE TABLE discord_links (
  discord_user_id TEXT NOT NULL UNIQUE,
  twitch_user_id TEXT NOT NULL UNIQUE,
  discord_username TEXT NOT NULL,
  twitch_login TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  verified_at TEXT NOT NULL
);

CREATE TABLE discord_oauth_transactions (
  state_id TEXT PRIMARY KEY,
  nonce_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE INDEX discord_oauth_transactions_expiry_idx
  ON discord_oauth_transactions(expires_at);
