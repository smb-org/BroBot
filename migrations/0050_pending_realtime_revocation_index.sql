CREATE INDEX pending_realtime_user_revocations_ordered_idx
  ON pending_realtime_user_revocations (requested_at, user_id);
