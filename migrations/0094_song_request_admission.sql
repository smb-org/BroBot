ALTER TABLE song_requests ADD COLUMN round_id TEXT;
ALTER TABLE song_requests ADD COLUMN request_type TEXT NOT NULL DEFAULT 'vote'
  CHECK (request_type IN ('vote', 'bot_points', 'free', 'channel_points'));
ALTER TABLE song_requests ADD COLUMN charged_amount INTEGER NOT NULL DEFAULT 0 CHECK (charged_amount >= 0);
ALTER TABLE song_requests ADD COLUMN charged_at TEXT;
ALTER TABLE song_requests ADD COLUMN refund_due INTEGER NOT NULL DEFAULT 0 CHECK (refund_due IN (0, 1));
UPDATE song_requests
   SET round_id = stream_id,
       request_type = CASE WHEN source = 'mod_vote' THEN 'vote' ELSE 'bot_points' END;

ALTER TABLE song_requests_votes ADD COLUMN round_id TEXT;
UPDATE song_requests_votes SET round_id = stream_id;

CREATE TABLE song_requests_offline_rounds (
  channel_id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

DROP TRIGGER panel_rev_song_requests_insert;
DROP TRIGGER panel_rev_song_requests_update;
DROP TRIGGER panel_rev_song_requests_delete;

CREATE TABLE song_requests_next (
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
    'charging', 'pending_review', 'approved', 'submitting', 'submitted', 'observed_playing',
    'not_observed', 'outcome_unknown', 'rejected', 'removed', 'failed'
  )),
  operation_id TEXT NOT NULL UNIQUE,
  failure_reason TEXT,
  stream_id TEXT,
  created_at TEXT NOT NULL,
  charging_since TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL,
  submitted_at TEXT,
  observed_at TEXT,
  round_id TEXT,
  request_type TEXT NOT NULL DEFAULT 'vote'
    CHECK (request_type IN ('vote', 'bot_points', 'free', 'channel_points')),
  charged_amount INTEGER NOT NULL DEFAULT 0 CHECK (charged_amount >= 0),
  charged_at TEXT,
  refund_due INTEGER NOT NULL DEFAULT 0 CHECK (refund_due IN (0, 1)),
  FOREIGN KEY (channel_id) REFERENCES channels(channel_id) ON DELETE CASCADE
);

INSERT INTO song_requests_next (
  id, channel_id, source, track_id, track_uri, title, artists_json, duration_ms, explicit, cover_url, spotify_url,
  requester_user_id, requester_login, requester_display_name, state, operation_id, failure_reason, stream_id,
  created_at, updated_at, submitted_at, observed_at, round_id, request_type, charged_amount, charged_at, refund_due
)
SELECT
  id, channel_id, source, track_id, track_uri, title, artists_json, duration_ms, explicit, cover_url, spotify_url,
  requester_user_id, requester_login, requester_display_name, state, operation_id, failure_reason, stream_id,
  created_at, updated_at, submitted_at, observed_at, round_id, request_type, charged_amount, charged_at, refund_due
FROM song_requests;

DROP TABLE song_requests;
ALTER TABLE song_requests_next RENAME TO song_requests;

CREATE INDEX song_requests_channel_state_created_idx
  ON song_requests(channel_id, state, created_at, id);
CREATE INDEX song_requests_charging_age_idx
  ON song_requests(channel_id, state, charging_since, id);
CREATE INDEX song_requests_stream_track_state_idx
  ON song_requests(channel_id, stream_id, track_id, state, created_at);
CREATE INDEX song_requests_round_state_idx ON song_requests(channel_id, round_id, state, created_at, id);
CREATE INDEX song_requests_round_track_idx ON song_requests(channel_id, round_id, track_id, state, submitted_at);
CREATE INDEX song_requests_round_requester_idx ON song_requests(channel_id, round_id, requester_user_id, state, created_at);
CREATE INDEX song_requests_refund_due_idx ON song_requests(channel_id, refund_due, state, created_at);

CREATE TRIGGER panel_rev_song_requests_insert AFTER INSERT ON song_requests BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'song_requests'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_song_requests_update
AFTER UPDATE OF id, channel_id, source, track_id, track_uri, title, artists_json, duration_ms, explicit,
  cover_url, spotify_url, requester_user_id, requester_login, requester_display_name, state, operation_id,
  failure_reason, stream_id, round_id, request_type, charged_amount, created_at, updated_at, submitted_at, observed_at ON song_requests
WHEN OLD.id IS NOT NEW.id OR OLD.channel_id IS NOT NEW.channel_id OR OLD.source IS NOT NEW.source
  OR OLD.track_id IS NOT NEW.track_id OR OLD.track_uri IS NOT NEW.track_uri OR OLD.title IS NOT NEW.title
  OR OLD.artists_json IS NOT NEW.artists_json OR OLD.duration_ms IS NOT NEW.duration_ms
  OR OLD.explicit IS NOT NEW.explicit OR OLD.cover_url IS NOT NEW.cover_url
  OR OLD.spotify_url IS NOT NEW.spotify_url OR OLD.requester_user_id IS NOT NEW.requester_user_id
  OR OLD.requester_login IS NOT NEW.requester_login OR OLD.requester_display_name IS NOT NEW.requester_display_name
  OR OLD.state IS NOT NEW.state OR OLD.operation_id IS NOT NEW.operation_id
  OR OLD.failure_reason IS NOT NEW.failure_reason OR OLD.stream_id IS NOT NEW.stream_id
  OR OLD.round_id IS NOT NEW.round_id OR OLD.request_type IS NOT NEW.request_type
  OR OLD.charged_amount IS NOT NEW.charged_amount OR OLD.created_at IS NOT NEW.created_at
  OR OLD.updated_at IS NOT NEW.updated_at OR OLD.submitted_at IS NOT NEW.submitted_at
  OR OLD.observed_at IS NOT NEW.observed_at
BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'song_requests'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions
  SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'song_requests' AND OLD.channel_id IS NOT NEW.channel_id
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_song_requests_delete AFTER DELETE ON song_requests BEGIN
  INSERT INTO panel_resource_revisions
  SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'song_requests'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

DROP TRIGGER panel_rev_song_requests_votes_update;
CREATE TRIGGER panel_rev_song_requests_votes_update
AFTER UPDATE OF ballot_id, channel_id, stream_id, round_id, candidate_tracks_json, moderator_user_id, state,
  request_id, created_at, completed_at ON song_requests_votes
WHEN OLD.ballot_id IS NOT NEW.ballot_id OR OLD.channel_id IS NOT NEW.channel_id
  OR OLD.stream_id IS NOT NEW.stream_id OR OLD.round_id IS NOT NEW.round_id
  OR OLD.candidate_tracks_json IS NOT NEW.candidate_tracks_json
  OR OLD.moderator_user_id IS NOT NEW.moderator_user_id OR OLD.state IS NOT NEW.state
  OR OLD.request_id IS NOT NEW.request_id OR OLD.created_at IS NOT NEW.created_at
  OR OLD.completed_at IS NOT NEW.completed_at
BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'song_requests_votes'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions
  SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'song_requests_votes' AND OLD.channel_id IS NOT NEW.channel_id
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
