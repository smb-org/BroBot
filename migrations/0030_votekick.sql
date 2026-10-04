CREATE TABLE votekicks (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  votekick_id TEXT NOT NULL,
  target_user_id TEXT,
  target_login TEXT,
  initiator_user_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('running', 'passed', 'expired', 'cancelled', 'failed')),
  threshold INTEGER NOT NULL CHECK (threshold >= 1),
  yes_votes INTEGER NOT NULL DEFAULT 1 CHECK (yes_votes >= 0),
  no_votes INTEGER NOT NULL DEFAULT 0 CHECK (no_votes >= 0),
  ballot_revision INTEGER NOT NULL DEFAULT 0 CHECK (ballot_revision >= 0),
  duration_seconds INTEGER CHECK (duration_seconds BETWEEN 1 AND 3600),
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ended_at TEXT,
  lifted_at TEXT,
  PRIMARY KEY (channel_id, votekick_id)
) WITHOUT ROWID;

CREATE UNIQUE INDEX votekicks_one_running
  ON votekicks(channel_id)
  WHERE status = 'running';

CREATE INDEX votekicks_target_cooldown
  ON votekicks(channel_id, target_user_id, started_at DESC);

CREATE INDEX votekicks_channel_ended
  ON votekicks(channel_id, ended_at DESC)
  WHERE ended_at IS NOT NULL;

CREATE INDEX votekicks_channel_history
  ON votekicks(channel_id, started_at, votekick_id);
