ALTER TABLE channels ADD COLUMN vollzustimmung INTEGER NOT NULL DEFAULT 0
  CHECK (vollzustimmung IN (0, 1));
ALTER TABLE audit_log ADD COLUMN actor_kind TEXT NOT NULL DEFAULT 'mitglied'
  CHECK (actor_kind IN ('mitglied', 'betreiber'));
CREATE INDEX audit_log_actor_kind_created_idx ON audit_log(actor_kind, created_at);
