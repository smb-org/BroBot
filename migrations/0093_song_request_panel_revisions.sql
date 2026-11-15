INSERT INTO panel_resource_dependencies (source_table, resource) VALUES
  ('song_requests', 'module:song_requests:requests'),
  ('song_requests_votes', 'module:song_requests:requests'),
  ('song_requests_now_playing', 'module:song_requests:requests'),
  ('song_requests_connections', 'module:song_requests:connection'),
  ('spotify_channel_access', 'module:song_requests:connection'),
  ('spotify_oauth_transactions', 'module:song_requests:connection'),
  ('channel_stream_state', 'module:song_requests:connection'),
  ('channel_stream_state', 'module:song_requests:requests'),
  ('module_secrets', 'module:song_requests:connection');

CREATE TRIGGER panel_rev_song_requests_insert AFTER INSERT ON song_requests BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'song_requests'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_song_requests_update
AFTER UPDATE OF id, channel_id, source, track_id, track_uri, title, artists_json, duration_ms, explicit,
  cover_url, spotify_url, requester_user_id, requester_login, requester_display_name, state, operation_id,
  failure_reason, stream_id, created_at, updated_at, submitted_at, observed_at ON song_requests
WHEN OLD.id IS NOT NEW.id OR OLD.channel_id IS NOT NEW.channel_id OR OLD.source IS NOT NEW.source
  OR OLD.track_id IS NOT NEW.track_id OR OLD.track_uri IS NOT NEW.track_uri OR OLD.title IS NOT NEW.title
  OR OLD.artists_json IS NOT NEW.artists_json OR OLD.duration_ms IS NOT NEW.duration_ms
  OR OLD.explicit IS NOT NEW.explicit OR OLD.cover_url IS NOT NEW.cover_url
  OR OLD.spotify_url IS NOT NEW.spotify_url OR OLD.requester_user_id IS NOT NEW.requester_user_id
  OR OLD.requester_login IS NOT NEW.requester_login OR OLD.requester_display_name IS NOT NEW.requester_display_name
  OR OLD.state IS NOT NEW.state OR OLD.operation_id IS NOT NEW.operation_id
  OR OLD.failure_reason IS NOT NEW.failure_reason OR OLD.stream_id IS NOT NEW.stream_id
  OR OLD.created_at IS NOT NEW.created_at OR OLD.updated_at IS NOT NEW.updated_at
  OR OLD.submitted_at IS NOT NEW.submitted_at OR OLD.observed_at IS NOT NEW.observed_at
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

CREATE TRIGGER panel_rev_song_requests_votes_insert AFTER INSERT ON song_requests_votes BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'song_requests_votes'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_song_requests_votes_update
AFTER UPDATE OF ballot_id, channel_id, stream_id, candidate_tracks_json, moderator_user_id, state,
  request_id, created_at, completed_at ON song_requests_votes
WHEN OLD.ballot_id IS NOT NEW.ballot_id OR OLD.channel_id IS NOT NEW.channel_id
  OR OLD.stream_id IS NOT NEW.stream_id OR OLD.candidate_tracks_json IS NOT NEW.candidate_tracks_json
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
CREATE TRIGGER panel_rev_song_requests_votes_delete AFTER DELETE ON song_requests_votes BEGIN
  INSERT INTO panel_resource_revisions
  SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'song_requests_votes'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_song_requests_now_playing_insert AFTER INSERT ON song_requests_now_playing BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'song_requests_now_playing'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_song_requests_now_playing_update
AFTER UPDATE OF channel_id, revision, track_json, request_id, progress_ms, observed_at ON song_requests_now_playing
WHEN OLD.channel_id IS NOT NEW.channel_id OR OLD.revision IS NOT NEW.revision
  OR OLD.track_json IS NOT NEW.track_json OR OLD.request_id IS NOT NEW.request_id
  OR OLD.progress_ms IS NOT NEW.progress_ms OR OLD.observed_at IS NOT NEW.observed_at
BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'song_requests_now_playing'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions
  SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'song_requests_now_playing' AND OLD.channel_id IS NOT NEW.channel_id
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_song_requests_now_playing_delete AFTER DELETE ON song_requests_now_playing BEGIN
  INSERT INTO panel_resource_revisions
  SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'song_requests_now_playing'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_song_requests_connections_insert AFTER INSERT ON song_requests_connections BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'song_requests_connections'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_song_requests_connections_update
AFTER UPDATE OF channel_id, state, error_message ON song_requests_connections
WHEN OLD.channel_id IS NOT NEW.channel_id OR OLD.state IS NOT NEW.state
  OR OLD.error_message IS NOT NEW.error_message
BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'song_requests_connections'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions
  SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'song_requests_connections' AND OLD.channel_id IS NOT NEW.channel_id
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_song_requests_connections_delete AFTER DELETE ON song_requests_connections BEGIN
  INSERT INTO panel_resource_revisions
  SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'song_requests_connections'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_spotify_channel_access_insert AFTER INSERT ON spotify_channel_access BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'spotify_channel_access'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_spotify_channel_access_update
AFTER UPDATE OF slot, channel_id ON spotify_channel_access
WHEN OLD.slot IS NOT NEW.slot OR OLD.channel_id IS NOT NEW.channel_id
BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'spotify_channel_access'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions
  SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'spotify_channel_access' AND OLD.channel_id IS NOT NEW.channel_id
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_spotify_channel_access_delete AFTER DELETE ON spotify_channel_access BEGIN
  INSERT INTO panel_resource_revisions
  SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'spotify_channel_access'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_spotify_oauth_transactions_insert AFTER INSERT ON spotify_oauth_transactions BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'spotify_oauth_transactions'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_spotify_oauth_transactions_update
AFTER UPDATE OF channel_id, expires_at, used_at ON spotify_oauth_transactions
WHEN OLD.channel_id IS NOT NEW.channel_id OR OLD.expires_at IS NOT NEW.expires_at
  OR OLD.used_at IS NOT NEW.used_at
BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'spotify_oauth_transactions'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
  INSERT INTO panel_resource_revisions
  SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'spotify_oauth_transactions' AND OLD.channel_id IS NOT NEW.channel_id
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_spotify_oauth_transactions_delete AFTER DELETE ON spotify_oauth_transactions BEGIN
  INSERT INTO panel_resource_revisions
  SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'spotify_oauth_transactions'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
