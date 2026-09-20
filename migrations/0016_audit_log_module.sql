-- Modulspezifische Panel-Mutationen werden im Audit neben Kanal und Aktion
-- ausdrücklich gekennzeichnet. Alte Einträge stammen aus Host- und
-- Mitgliederänderungen und bleiben deshalb ohne Modul-ID lesbar.
ALTER TABLE audit_log ADD COLUMN module_id TEXT;

CREATE INDEX audit_log_channel_module_created_idx
  ON audit_log(channel_id, module_id, created_at);
