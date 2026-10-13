ALTER TABLE timer_schedule_reconciliation RENAME TO timer_schedule_reconciliation_legacy;

CREATE TABLE timer_schedule_reconciliation (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  timer_id TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  mutation_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT 'activation'
    CHECK (reason IN ('event_times', 'channel_time_zone', 'activation', 'stream_state')),
  PRIMARY KEY (channel_id, timer_id, revision),
  CHECK ((timer_id = '' AND revision = 0) OR (timer_id <> '' AND revision > 0))
);

INSERT INTO timer_schedule_reconciliation (channel_id, timer_id, revision, mutation_id, updated_at, reason)
SELECT channel_id, '', 0, mutation_id, updated_at, reason
  FROM timer_schedule_reconciliation_legacy;

DROP TABLE timer_schedule_reconciliation_legacy;
