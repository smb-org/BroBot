CREATE TABLE IF NOT EXISTS bot_channel_status_check_locks (
  channel_id TEXT PRIMARY KEY,
  locked_until TEXT NOT NULL
);

ALTER TABLE bot_channel_status_check_locks
  ADD COLUMN owner_id TEXT NOT NULL DEFAULT '';
