CREATE TABLE twitch_game_search_cache (
  cache_key TEXT PRIMARY KEY CHECK (length(cache_key) BETWEEN 1 AND 120),
  games_json TEXT NOT NULL CHECK (json_valid(games_json)),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
) WITHOUT ROWID;

CREATE INDEX twitch_game_search_cache_expiry_idx ON twitch_game_search_cache(expires_at_ms);

CREATE TABLE channel_game_history (
  channel_id TEXT NOT NULL,
  game_id TEXT NOT NULL CHECK (length(game_id) BETWEEN 1 AND 20),
  game_name TEXT NOT NULL CHECK (length(game_name) BETWEEN 1 AND 100),
  last_seen_at_ms INTEGER NOT NULL CHECK (last_seen_at_ms >= 0),
  PRIMARY KEY (channel_id, game_id),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX channel_game_history_recent_idx ON channel_game_history(channel_id, last_seen_at_ms DESC);
