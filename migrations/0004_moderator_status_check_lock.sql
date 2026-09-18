CREATE TABLE bot_channel_status_check_locks (
  channel_id TEXT PRIMARY KEY,
  locked_until TEXT NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);
