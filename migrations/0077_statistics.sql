CREATE TABLE channel_statistics (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  stream_id TEXT,
  window_start TEXT NOT NULL,
  window_seconds INTEGER NOT NULL CHECK (window_seconds BETWEEN 1 AND 300),
  messages INTEGER NOT NULL CHECK (messages >= 0),
  emotes INTEGER NOT NULL CHECK (emotes >= 0),
  viewer_count INTEGER CHECK (viewer_count IS NULL OR viewer_count >= 0),
  chatters INTEGER CHECK (chatters IS NULL OR chatters >= 0),
  active_chatters INTEGER CHECK (active_chatters IS NULL OR active_chatters >= 0),
  PRIMARY KEY (channel_id, window_start)
);
