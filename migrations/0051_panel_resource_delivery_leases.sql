ALTER TABLE panel_resource_pending ADD COLUMN claimed_until INTEGER;
ALTER TABLE panel_resource_pending ADD COLUMN claim_token TEXT;

CREATE INDEX panel_resource_pending_claim_idx
  ON panel_resource_pending(claimed_until, channel_id);
