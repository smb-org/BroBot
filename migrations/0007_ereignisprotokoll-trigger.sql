-- Korrelation aller Diagnosen, Aktionen und Aktionsausgänge eines Auslösers.
-- Bestehende Ereignisse aus 0006 erhalten die leere Rückwärtskompatibilitätskennung;
-- neue Host-Aufrufe liefern immer ihre konkrete trigger_id.
ALTER TABLE event_log
  ADD COLUMN trigger_id TEXT NOT NULL DEFAULT '';

CREATE INDEX event_log_channel_trigger_idx ON event_log(channel_id, trigger_id);
