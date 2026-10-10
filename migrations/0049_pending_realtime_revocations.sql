-- Keep revoked login sockets on a durable retry queue until every current
-- channel Durable Object confirms that it closed the user's panel sockets.
CREATE TABLE pending_realtime_user_revocations (
  user_id TEXT PRIMARY KEY,
  requested_at TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1
);
