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
CREATE TRIGGER panel_rev_song_requests_update AFTER UPDATE ON song_requests BEGIN
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
CREATE TRIGGER panel_rev_song_requests_votes_update AFTER UPDATE ON song_requests_votes BEGIN
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
CREATE TRIGGER panel_rev_song_requests_now_playing_update AFTER UPDATE ON song_requests_now_playing BEGIN
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
CREATE TRIGGER panel_rev_song_requests_connections_update AFTER UPDATE ON song_requests_connections BEGIN
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
CREATE TRIGGER panel_rev_spotify_channel_access_update AFTER UPDATE ON spotify_channel_access BEGIN
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
CREATE TRIGGER panel_rev_spotify_oauth_transactions_update AFTER UPDATE ON spotify_oauth_transactions BEGIN
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
