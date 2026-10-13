-- Migration 0060 is reserved for PR #411. Keep pending timer deadlines intact:
-- existing interval alarms remain live alarms with the same revision and deadline.
ALTER TABLE timers ADD COLUMN next_run_state TEXT CHECK (next_run_state IS NULL OR next_run_state IN ('live', 'offline'));

UPDATE timers
   SET trigger_json = json_patch(
         json_object('type', 'interval'),
         json_object('live', json_patch(
           json_object('minutes', json_extract(trigger_json, '$.minutes')),
           CASE
             WHEN json_type(trigger_json, '$.minimumMessages') IS NULL THEN '{}'
             ELSE json_object('minimumMessages', json_extract(trigger_json, '$.minimumMessages'))
           END
         ))
       ),
       next_run_state = CASE WHEN next_run_at IS NULL THEN NULL ELSE 'live' END
 WHERE trigger_type = 'interval';
