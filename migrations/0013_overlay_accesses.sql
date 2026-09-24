-- Keep the immutable binding ID when an overlay is deleted. Its accesses are
-- revoked in the same transaction, while legacy tokens remain NULL-bound.
ALTER TABLE overlay_tokens ADD COLUMN overlay_id TEXT;
ALTER TABLE overlay_tokens ADD COLUMN label TEXT NOT NULL DEFAULT '' CHECK (length(label) <= 40);
ALTER TABLE overlay_tokens ADD COLUMN secret_envelope TEXT;

CREATE INDEX overlay_tokens_overlay_idx
  ON overlay_tokens(channel_id, overlay_id, revoked_at, created_at);
