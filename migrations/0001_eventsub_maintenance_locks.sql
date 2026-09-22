CREATE TABLE eventsub_maintenance_locks (
  channel_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  rerun_needed INTEGER NOT NULL DEFAULT 0 CHECK (rerun_needed IN (0, 1)),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);
