CREATE TABLE api_sources (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  source_name TEXT NOT NULL CHECK (length(source_name) BETWEEN 1 AND 32),
  url TEXT NOT NULL CHECK (length(url) BETWEEN 1 AND 2048),
  expression TEXT NOT NULL DEFAULT '' CHECK (length(expression) <= 512),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (channel_id, source_name)
);

CREATE TABLE api_source_cache (
  url_hash TEXT PRIMARY KEY CHECK (length(url_hash) = 64),
  payload_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE api_source_quota (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  window_start TEXT NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 1),
  PRIMARY KEY (channel_id, window_start)
);

INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
SELECT channel_id, 'api_source', 1, '{}'
  FROM channels
 WHERE NOT EXISTS (
   SELECT 1 FROM channel_modules
    WHERE channel_modules.channel_id = channels.channel_id
      AND channel_modules.module_id = 'api_source'
 );
