CREATE TABLE overlay_tokens (
  token_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_reason TEXT,
  last_used_at TEXT,
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE INDEX overlay_tokens_channel_idx ON overlay_tokens(channel_id);
