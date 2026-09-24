-- Stream-end controls belong to a concrete stream session. A null session
-- remains pending until the next online session is recorded.
ALTER TABLE channel_controls ADD COLUMN mute_stream_started_at TEXT;
ALTER TABLE channel_controls ADD COLUMN pause_stream_started_at TEXT;

-- Preserve existing stream-end controls. Rows with no recorded live session
-- stay pending, including channels currently recorded offline.
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
