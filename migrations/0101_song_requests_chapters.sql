CREATE TABLE song_requests_chapters (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK (length(id) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  tracks_json TEXT NOT NULL DEFAULT '[]' CHECK (
    json_valid(tracks_json) AND json_type(tracks_json) = 'array' AND json_array_length(tracks_json) <= 20
  ),
  offer_in_cockpit INTEGER NOT NULL DEFAULT 0 CHECK (offer_in_cockpit IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (typeof(revision) = 'integer' AND revision > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, id)
) WITHOUT ROWID;

CREATE INDEX song_requests_chapters_channel_offer_idx
  ON song_requests_chapters(channel_id, offer_in_cockpit, updated_at DESC, id);

ALTER TABLE song_requests_votes ADD COLUMN chapter_id TEXT;
ALTER TABLE song_requests_votes ADD COLUMN chapter_name_snapshot TEXT
  CHECK (chapter_name_snapshot IS NULL OR length(chapter_name_snapshot) BETWEEN 1 AND 40);

CREATE INDEX song_requests_votes_request_idx
  ON song_requests_votes(channel_id, request_id);

CREATE INDEX song_requests_recap_idx
  ON song_requests(channel_id, stream_id, state, observed_at);

INSERT INTO panel_resource_dependencies (source_table, resource) VALUES
  ('song_requests_chapters', 'module:song_requests:chapters'),
  ('song_requests', 'module:song_requests:recap');

CREATE TRIGGER panel_rev_song_requests_chapters_insert AFTER INSERT ON song_requests_chapters BEGIN
  INSERT INTO panel_resource_revisions
    SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'song_requests_chapters'
    ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_song_requests_chapters_update AFTER UPDATE ON song_requests_chapters BEGIN
  INSERT INTO panel_resource_revisions
    SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'song_requests_chapters'
    ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER panel_rev_song_requests_chapters_delete AFTER DELETE ON song_requests_chapters BEGIN
  INSERT INTO panel_resource_revisions
    SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'song_requests_chapters'
    ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
