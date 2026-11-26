CREATE TABLE discord_bot_token_lock (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  locked_at TEXT NOT NULL,
  last_probe_at TEXT NOT NULL,
  probe_token TEXT,
  probe_until TEXT
);
