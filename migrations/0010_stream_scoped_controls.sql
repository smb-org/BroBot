-- Stream-end controls belong to a concrete stream session. A null session
-- remains pending until the next online session is recorded.
ALTER TABLE channel_controls ADD COLUMN mute_stream_started_at TEXT;
ALTER TABLE channel_controls ADD COLUMN pause_stream_started_at TEXT;
ALTER TABLE channel_stream_state ADD COLUMN started_at_seconds INTEGER;
ALTER TABLE channel_stream_state ADD COLUMN started_at_fraction TEXT;
ALTER TABLE channel_stream_state ADD COLUMN eventsub_changed_at_seconds INTEGER;
ALTER TABLE channel_stream_state ADD COLUMN eventsub_changed_at_fraction TEXT;

-- Preserve existing stream-end controls for a recorded live session. Rows
-- without a known live start remain pending for the next recorded session.
UPDATE channel_controls
   SET mute_stream_started_at = (
         SELECT stream_state.started_at
           FROM channel_stream_state AS stream_state
          WHERE stream_state.channel_id = channel_controls.channel_id
            AND stream_state.state = 'online'
            AND stream_state.started_at IS NOT NULL
       )
 WHERE mute_until_stream_end = 1;

UPDATE channel_controls
   SET pause_stream_started_at = (
         SELECT stream_state.started_at
           FROM channel_stream_state AS stream_state
          WHERE stream_state.channel_id = channel_controls.channel_id
            AND stream_state.state = 'online'
            AND stream_state.started_at IS NOT NULL
       )
 WHERE pause_until_stream_end = 1;

-- `checked_at` tracks how fresh the stored observation is. EventSub has its
-- own monotonic watermark so a Helix refresh cannot reject a delayed event.
ALTER TABLE channel_stream_state ADD COLUMN checked_at TEXT;
ALTER TABLE channel_stream_state ADD COLUMN eventsub_changed_at TEXT;

UPDATE channel_stream_state
   SET checked_at = changed_at,
       eventsub_changed_at = CASE WHEN source = 'eventsub' THEN changed_at ELSE NULL END;

-- Keep sub-second timestamp ordering independent of SQLite's millisecond
-- date functions. Store whole UTC seconds and the exact supplied decimal
-- fraction separately; trailing zeroes are immaterial and removed so equal
-- instants compare equal.
WITH started_times AS (
  SELECT channel_id,
         CAST(strftime('%s', started_at) AS INTEGER) AS seconds,
         CASE WHEN substr(started_at, 20, 1) = '.' THEN rtrim(
           substr(started_at, 21, CASE
             WHEN instr(substr(started_at, 21), 'Z') > 0 THEN instr(substr(started_at, 21), 'Z') - 1
             WHEN instr(substr(started_at, 21), '+') > 0 THEN instr(substr(started_at, 21), '+') - 1
             WHEN instr(substr(started_at, 21), '-') > 0 THEN instr(substr(started_at, 21), '-') - 1
             ELSE length(substr(started_at, 21))
           END), '0') ELSE '' END AS fraction
    FROM channel_stream_state
   WHERE started_at IS NOT NULL
)
UPDATE channel_stream_state
   SET started_at_seconds = (SELECT seconds FROM started_times WHERE started_times.channel_id = channel_stream_state.channel_id),
       started_at_fraction = (SELECT fraction FROM started_times WHERE started_times.channel_id = channel_stream_state.channel_id)
 WHERE started_at IS NOT NULL;

WITH eventsub_times AS (
  SELECT channel_id,
         CAST(strftime('%s', eventsub_changed_at) AS INTEGER) AS seconds,
         CASE WHEN substr(eventsub_changed_at, 20, 1) = '.' THEN rtrim(
           substr(eventsub_changed_at, 21, CASE
             WHEN instr(substr(eventsub_changed_at, 21), 'Z') > 0 THEN instr(substr(eventsub_changed_at, 21), 'Z') - 1
             WHEN instr(substr(eventsub_changed_at, 21), '+') > 0 THEN instr(substr(eventsub_changed_at, 21), '+') - 1
             WHEN instr(substr(eventsub_changed_at, 21), '-') > 0 THEN instr(substr(eventsub_changed_at, 21), '-') - 1
             ELSE length(substr(eventsub_changed_at, 21))
           END), '0') ELSE '' END AS fraction
    FROM channel_stream_state
   WHERE eventsub_changed_at IS NOT NULL
)
UPDATE channel_stream_state
   SET eventsub_changed_at_seconds = (SELECT seconds FROM eventsub_times WHERE eventsub_times.channel_id = channel_stream_state.channel_id),
       eventsub_changed_at_fraction = (SELECT fraction FROM eventsub_times WHERE eventsub_times.channel_id = channel_stream_state.channel_id)
 WHERE eventsub_changed_at IS NOT NULL;
