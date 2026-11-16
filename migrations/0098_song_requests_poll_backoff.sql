ALTER TABLE song_requests_connections
  ADD COLUMN poll_backoff_until INTEGER CHECK (poll_backoff_until IS NULL OR poll_backoff_until >= 0);
