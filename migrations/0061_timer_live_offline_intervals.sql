-- Migration 0060 is reserved for PR #411. Keep pending timer deadlines intact:
-- existing interval alarms remain live alarms with the same revision and deadline.
ALTER TABLE timers ADD COLUMN next_run_state TEXT CHECK (next_run_state IS NULL OR next_run_state IN ('live', 'offline'));

ALTER TABLE channel_stream_state ADD COLUMN transition_generation INTEGER NOT NULL DEFAULT 1
  CHECK (transition_generation >= 1);

UPDATE timers
   SET next_run_state = CASE WHEN next_run_at IS NULL THEN NULL ELSE 'live' END
 WHERE trigger_type = 'interval';
