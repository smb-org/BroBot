CREATE TABLE spotify_channel_access (
  slot INTEGER PRIMARY KEY CHECK (slot BETWEEN 1 AND 5),
  channel_id TEXT NOT NULL UNIQUE,
  enabled_by TEXT NOT NULL,
  enabled_at TEXT NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE TABLE spotify_oauth_transactions (
  state_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  member_user_id TEXT NOT NULL,
  nonce_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE INDEX spotify_oauth_transactions_expiry_idx ON spotify_oauth_transactions(expires_at);

CREATE TABLE song_requests_connections (
  channel_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN (
    'not_connected', 'connected', 'premium_required', 'spotify_error',
    'no_active_device', 'reconnect_required'
  )),
  error_message TEXT,
  updated_at TEXT NOT NULL,
  poll_failures INTEGER NOT NULL DEFAULT 0 CHECK (poll_failures >= 0),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE TABLE song_requests_votes (
  ballot_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  stream_id TEXT,
  candidate_tracks_json TEXT NOT NULL,
  moderator_user_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'queued', 'tie', 'no_votes', 'failed')),
  request_id TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE TABLE song_requests (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('mod_vote', 'channel_points', 'points')),
  track_id TEXT NOT NULL,
  track_uri TEXT NOT NULL,
  title TEXT NOT NULL,
  artists_json TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  explicit INTEGER NOT NULL CHECK (explicit IN (0, 1)),
  cover_url TEXT,
  spotify_url TEXT NOT NULL,
  requester_user_id TEXT,
  requester_login TEXT,
  requester_display_name TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'pending_review', 'approved', 'submitting', 'submitted', 'observed_playing',
    'not_observed', 'outcome_unknown', 'rejected', 'removed', 'failed'
  )),
  operation_id TEXT NOT NULL UNIQUE,
  failure_reason TEXT,
  stream_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  observed_at TEXT,
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

CREATE INDEX song_requests_votes_stream_created_idx
  ON song_requests_votes(channel_id, stream_id, state, created_at);

CREATE INDEX song_requests_channel_state_created_idx
  ON song_requests(channel_id, state, created_at, id);

CREATE INDEX song_requests_stream_track_state_idx
  ON song_requests(channel_id, stream_id, track_id, state, created_at);

CREATE TABLE song_requests_now_playing (
  channel_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  track_json TEXT,
  request_id TEXT,
  progress_ms INTEGER,
  observed_at TEXT,
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);
