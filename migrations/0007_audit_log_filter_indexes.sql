CREATE INDEX audit_log_channel_actor_created_idx
  ON audit_log(channel_id, actor_user_id, created_at);

CREATE INDEX audit_log_channel_action_created_idx
  ON audit_log(channel_id, action, created_at);
