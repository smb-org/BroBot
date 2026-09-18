CREATE TABLE bot_identity (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  user_id TEXT NOT NULL,
  login TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE twitch_login_identity (
  user_id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  access_token_ciphertext TEXT NOT NULL,
  refresh_token_ciphertext TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('connected', 'revoked', 'error')),
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE auth_sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  login TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_reason TEXT
);

CREATE TABLE oauth_transactions (
  transaction_id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'bot')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  used_at TEXT,
  failure_reason TEXT
);

CREATE TABLE bot_identity_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL CHECK (status IN ('connected', 'revoked', 'error')),
  reason TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE bot_channel_status (
  channel_id TEXT PRIMARY KEY,
  is_moderator INTEGER NOT NULL CHECK (is_moderator IN (0, 1)),
  checked_at TEXT NOT NULL,
  reason TEXT,
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE INDEX auth_sessions_user_idx ON auth_sessions(user_id);
CREATE INDEX auth_sessions_expiry_idx ON auth_sessions(expires_at);
CREATE INDEX oauth_transactions_expiry_idx ON oauth_transactions(expires_at);
CREATE INDEX oauth_transactions_used_idx ON oauth_transactions(used_at);
CREATE INDEX twitch_login_identity_status_idx ON twitch_login_identity(status);
CREATE INDEX bot_channel_status_moderator_idx ON bot_channel_status(is_moderator);
