CREATE TABLE media_assets (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('image', 'sound')),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/gif', 'image/webp', 'audio/mpeg', 'audio/ogg', 'audio/wav')),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 1048576),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  file_name TEXT NOT NULL,
  data BLOB NOT NULL CHECK (length(data) = byte_size),
  created_at TEXT NOT NULL,
  PRIMARY KEY (channel_id, id)
);

CREATE UNIQUE INDEX media_assets_channel_sha256_idx
  ON media_assets (channel_id, sha256);

CREATE INDEX media_assets_channel_created_idx
  ON media_assets (channel_id, created_at DESC, id);

INSERT INTO panel_resource_dependencies (source_table, resource)
VALUES ('media_assets', 'module:overlay_alerts:data');

CREATE TRIGGER panel_rev_media_assets_insert AFTER INSERT ON media_assets BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'media_assets'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_media_assets_update AFTER UPDATE ON media_assets
WHEN OLD.channel_id IS NOT NEW.channel_id OR OLD.id IS NOT NEW.id OR OLD.kind IS NOT NEW.kind
  OR OLD.mime_type IS NOT NEW.mime_type OR OLD.byte_size IS NOT NEW.byte_size OR OLD.sha256 IS NOT NEW.sha256
  OR OLD.file_name IS NOT NEW.file_name OR OLD.data IS NOT NEW.data OR OLD.created_at IS NOT NEW.created_at
BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'media_assets'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_media_assets_delete AFTER DELETE ON media_assets BEGIN
  INSERT INTO panel_resource_revisions
  SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'media_assets'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
