ALTER TABLE song_requests_votes ADD COLUMN vote_kind TEXT NOT NULL DEFAULT 'song'
  CHECK (vote_kind IN ('song', 'skip'));
ALTER TABLE song_requests_votes ADD COLUMN start_track_id TEXT;
ALTER TABLE song_requests_votes ADD COLUMN skip_threshold INTEGER
  CHECK (skip_threshold IS NULL OR skip_threshold BETWEEN 1 AND 100);
ALTER TABLE song_requests_votes ADD COLUMN skip_cooldown_seconds INTEGER
  CHECK (skip_cooldown_seconds IS NULL OR skip_cooldown_seconds BETWEEN 0 AND 3600);
ALTER TABLE song_requests_votes ADD COLUMN skip_result TEXT
  CHECK (skip_result IS NULL OR skip_result IN (
    'pending', 'skipped', 'threshold_not_met', 'no_majority', 'track_changed',
    'not_connected', 'nothing_playing', 'no_active_device', 'spotify_unavailable'
  ));
ALTER TABLE song_requests_votes ADD COLUMN drawn_by_lot INTEGER NOT NULL DEFAULT 0
  CHECK (drawn_by_lot IN (0, 1));

ALTER TABLE song_requests ADD COLUMN album_name TEXT;
ALTER TABLE song_requests ADD COLUMN chat_message_id TEXT;
ALTER TABLE song_requests ADD COLUMN channel_points_resolution_completed TEXT
  CHECK (channel_points_resolution_completed IS NULL OR channel_points_resolution_completed IN ('FULFILLED', 'CANCELED'));

CREATE INDEX song_requests_statistics_idx
  ON song_requests(channel_id, stream_id, state, request_type, requester_user_id, track_id)
  WHERE state IN ('approved', 'submitting', 'submitted', 'observed_playing', 'not_observed', 'outcome_unknown');
