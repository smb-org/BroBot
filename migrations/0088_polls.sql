CREATE TABLE polls_entries (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  entry_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('poll', 'prediction')),
  title TEXT NOT NULL CHECK (length(trim(title)) >= 1),
  choices_json TEXT NOT NULL CHECK (
    json_valid(choices_json)
    AND json_type(choices_json) = 'array'
    AND json_array_length(choices_json) BETWEEN 2 AND 10
  ),
  duration_seconds INTEGER NOT NULL CHECK (duration_seconds BETWEEN 15 AND 1800),
  channel_points_voting_enabled INTEGER NOT NULL CHECK (channel_points_voting_enabled IN (0, 1)),
  channel_points_per_vote INTEGER CHECK (channel_points_per_vote IS NULL OR channel_points_per_vote BETWEEN 1 AND 1000000),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_started_at TEXT,
  CHECK (kind = 'poll' OR (channel_points_voting_enabled = 0 AND channel_points_per_vote IS NULL))
);

CREATE INDEX polls_entries_channel_recency_idx
  ON polls_entries (channel_id, last_started_at DESC, updated_at DESC);

CREATE TABLE polls_runs (
  channel_id TEXT NOT NULL REFERENCES channels(channel_id) ON DELETE CASCADE,
  run_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('poll', 'prediction')),
  twitch_id TEXT NOT NULL,
  entry_id TEXT REFERENCES polls_entries(entry_id) ON DELETE SET NULL,
  source TEXT NOT NULL CHECK (source IN ('brobot', 'twitch')),
  title TEXT NOT NULL,
  choices_json TEXT NOT NULL CHECK (json_valid(choices_json) AND json_type(choices_json) = 'array'),
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'terminated', 'archived', 'locked', 'resolved', 'canceled', 'unknown')),
  started_at TEXT NOT NULL,
  ends_at TEXT,
  locked_at TEXT,
  ended_at TEXT,
  winning_choice_id TEXT,
  last_event_at TEXT NOT NULL,
  terminal_payload_json TEXT CHECK (terminal_payload_json IS NULL OR json_valid(terminal_payload_json)),
  UNIQUE (channel_id, kind, twitch_id)
);

CREATE INDEX polls_runs_channel_history_idx
  ON polls_runs (channel_id, started_at DESC, run_id);

CREATE INDEX polls_runs_channel_open_idx
  ON polls_runs (channel_id, kind, started_at)
  WHERE status IN ('active', 'locked', 'unknown');

CREATE TABLE polls_reconcile_state (
  channel_id TEXT PRIMARY KEY REFERENCES channels(channel_id) ON DELETE CASCADE,
  last_reconciled_at TEXT NOT NULL
);

INSERT INTO panel_resource_dependencies (source_table, resource)
VALUES ('polls_entries', 'module:polls:data'), ('polls_runs', 'module:polls:data');

CREATE TRIGGER panel_rev_polls_entries_insert AFTER INSERT ON polls_entries BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'polls_entries'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_polls_entries_update AFTER UPDATE ON polls_entries
WHEN OLD.channel_id IS NOT NEW.channel_id OR OLD.entry_id IS NOT NEW.entry_id OR OLD.kind IS NOT NEW.kind
  OR OLD.title IS NOT NEW.title OR OLD.choices_json IS NOT NEW.choices_json OR OLD.duration_seconds IS NOT NEW.duration_seconds
  OR OLD.channel_points_voting_enabled IS NOT NEW.channel_points_voting_enabled
  OR OLD.channel_points_per_vote IS NOT NEW.channel_points_per_vote OR OLD.revision IS NOT NEW.revision
  OR OLD.created_at IS NOT NEW.created_at OR OLD.updated_at IS NOT NEW.updated_at
  OR OLD.last_started_at IS NOT NEW.last_started_at
BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'polls_entries'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_polls_entries_delete AFTER DELETE ON polls_entries BEGIN
  INSERT INTO panel_resource_revisions
  SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'polls_entries'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_polls_runs_insert AFTER INSERT ON polls_runs BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'polls_runs'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_polls_runs_update AFTER UPDATE ON polls_runs
WHEN OLD.channel_id IS NOT NEW.channel_id OR OLD.run_id IS NOT NEW.run_id OR OLD.kind IS NOT NEW.kind
  OR OLD.twitch_id IS NOT NEW.twitch_id OR OLD.entry_id IS NOT NEW.entry_id OR OLD.source IS NOT NEW.source
  OR OLD.title IS NOT NEW.title OR OLD.choices_json IS NOT NEW.choices_json OR OLD.status IS NOT NEW.status
  OR OLD.started_at IS NOT NEW.started_at OR OLD.ends_at IS NOT NEW.ends_at OR OLD.locked_at IS NOT NEW.locked_at
  OR OLD.ended_at IS NOT NEW.ended_at OR OLD.winning_choice_id IS NOT NEW.winning_choice_id
  OR OLD.last_event_at IS NOT NEW.last_event_at OR OLD.terminal_payload_json IS NOT NEW.terminal_payload_json
BEGIN
  INSERT INTO panel_resource_revisions
  SELECT NEW.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'polls_runs'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER panel_rev_polls_runs_delete AFTER DELETE ON polls_runs BEGIN
  INSERT INTO panel_resource_revisions
  SELECT OLD.channel_id, resource, 1 FROM panel_resource_dependencies WHERE source_table = 'polls_runs'
  ON CONFLICT(channel_id, resource) DO UPDATE SET revision = revision + 1;
END;
