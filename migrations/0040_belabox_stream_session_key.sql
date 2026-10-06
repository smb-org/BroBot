ALTER TABLE belabox_status ADD COLUMN stream_session_key TEXT;

UPDATE belabox_status
   SET stream_session_key = 'stream:' || stream_id
 WHERE stream_id IS NOT NULL;
