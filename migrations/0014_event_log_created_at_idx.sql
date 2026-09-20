-- Aufräumen nach created_at braucht einen Index, der nicht mit channel_id beginnt.
CREATE INDEX event_log_created_at_idx ON event_log(created_at);

-- Der Kurzcode bleibt in reason; Twitch-Meldung und HTTP-Status werden separat
-- aufbewahrt, damit das Panel beides anzeigen kann.
ALTER TABLE eventsub_subscriptions ADD COLUMN error_message TEXT;
ALTER TABLE eventsub_subscriptions ADD COLUMN error_status INTEGER;
