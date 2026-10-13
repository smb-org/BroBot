-- Migration 0060 is reserved for PR #411. Keep pending timer alarms intact:
-- the channel Durable Object imports their existing alarm-table deadlines.
-- Deploy the compatible worker with this migration. It accepts old live-interval
-- payloads, but pre-change workers cannot read offline-only intervals; do not
-- roll back to a pre-change worker after one is saved.
ALTER TABLE timers ADD COLUMN next_run_state TEXT CHECK (next_run_state IS NULL OR next_run_state IN ('live', 'offline'));
ALTER TABLE timers ADD COLUMN schedule_mirror_sequence INTEGER NOT NULL DEFAULT 0
  CHECK (schedule_mirror_sequence >= 0);

ALTER TABLE channel_stream_state ADD COLUMN transition_generation INTEGER NOT NULL DEFAULT 1
  CHECK (transition_generation >= 1);

UPDATE timers
   SET next_run_state = CASE WHEN next_run_at IS NULL THEN NULL ELSE 'live' END
 WHERE trigger_type = 'interval';

-- D1 commits timer edits before the channel Durable Object can receive them.
-- This small outbox makes those edits recoverable if the DO is unavailable.
CREATE TABLE timer_schedule_reconciliation (
  channel_id TEXT PRIMARY KEY REFERENCES channels(channel_id) ON DELETE CASCADE,
  mutation_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'activation'
    CHECK (reason IN ('event_times', 'channel_time_zone', 'activation', 'stream_state'))
);
