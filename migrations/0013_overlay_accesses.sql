ALTER TABLE overlay_tokens ADD COLUMN overlay_id TEXT REFERENCES overlays(overlay_id) ON DELETE SET NULL;
ALTER TABLE overlay_tokens ADD COLUMN label TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 40);
ALTER TABLE overlay_tokens ADD COLUMN secret_envelope TEXT;

CREATE INDEX overlay_tokens_overlay_idx
  ON overlay_tokens(channel_id, overlay_id, revoked_at, created_at);
