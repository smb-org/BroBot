import type { ModuleStreamState } from "../../modules/contract";
import { prepareBindPendingStreamControls } from "./channel-controls";

export type StoredStreamState = Exclude<ModuleStreamState, "unknown">;
export type StreamStateSource = "eventsub" | "helix";

export interface StoredStreamStateRecord {
  state: StoredStreamState;
  source: StreamStateSource;
  changedAt: string;
  /** The real stream start, independent of `changedAt` (see migration 0006). Null when unknown or offline. */
  startedAt: string | null;
  /** Most recent successful state observation, used for freshness independently of EventSub ordering. */
  checkedAt: string | null;
}

interface StreamStateRow {
  state: StoredStreamState;
  source: StreamStateSource;
  changed_at: string;
  started_at: string | null;
  checked_at: string | null;
}

export const readChannelStreamState = async (
  db: D1Database,
  channelId: string,
): Promise<StoredStreamStateRecord | null> => {
  const row = await db.prepare(
    `SELECT state, source, changed_at, started_at, checked_at
       FROM channel_stream_state
      WHERE channel_id = ?`,
  ).bind(channelId).first<StreamStateRow>();
  return row === null ? null : {
    state: row.state,
    source: row.source,
    changedAt: row.changed_at,
    startedAt: row.started_at,
    checkedAt: row.checked_at,
  };
};

export const writeEventSubStreamState = async (
  db: D1Database,
  channelId: string,
  state: StoredStreamState,
  changedAt: string,
  startedAt: string | null,
): Promise<boolean> => {
  const statements = [db.prepare(
    `INSERT INTO channel_stream_state
       (channel_id, state, changed_at, source, started_at, checked_at, eventsub_changed_at)
     VALUES (?, ?, ?, 'eventsub', ?, ?, ?)
     ON CONFLICT (channel_id) DO UPDATE
       SET state = excluded.state,
           changed_at = excluded.changed_at,
           source = 'eventsub',
           started_at = excluded.started_at,
           checked_at = excluded.checked_at,
           eventsub_changed_at = excluded.eventsub_changed_at
     WHERE channel_stream_state.eventsub_changed_at IS NULL
        OR julianday(excluded.eventsub_changed_at) >= julianday(channel_stream_state.eventsub_changed_at)`,
  ).bind(channelId, state, changedAt, startedAt, changedAt, changedAt)];
  if (state === "online" && startedAt !== null) {
    statements.push(prepareBindPendingStreamControls(db, channelId, startedAt));
  }
  const results = await db.batch(statements);
  return (results[0]?.meta.changes ?? 0) > 0;
};

export const writeHelixStreamStateIfUnknown = async (
  db: D1Database,
  channelId: string,
  state: StoredStreamState,
  changedAt: string,
  startedAt: string | null,
): Promise<boolean> => {
  const statements = [db.prepare(
    `INSERT INTO channel_stream_state
       (channel_id, state, changed_at, source, started_at, checked_at, eventsub_changed_at)
     VALUES (?, ?, ?, 'helix', ?, ?, NULL)
     ON CONFLICT (channel_id) DO NOTHING`,
  ).bind(channelId, state, changedAt, startedAt, changedAt)];
  if (state === "online" && startedAt !== null) {
    statements.push(prepareBindPendingStreamControls(db, channelId, startedAt));
  }
  const results = await db.batch(statements);
  return (results[0]?.meta.changes ?? 0) > 0;
};

/**
 * Prepares a Helix refresh for any existing state row. `checked_at` tracks
 * freshness; `eventsub_changed_at` orders EventSub deliveries independently
 * from Helix observations. The `changed_at` guard prevents a poll from
 * replacing a transition whose timestamp is later than the poll time.
 */
export const prepareRefreshHelixStreamState = (
  db: D1Database,
  channelId: string,
  state: StoredStreamState,
  changedAt: string,
  startedAt: string | null,
): D1PreparedStatement => db.prepare(
  `UPDATE channel_stream_state
        SET state = ?, changed_at = ?, source = 'helix', started_at = ?, checked_at = ?
      WHERE channel_id = ?
        AND julianday(?) >= julianday(changed_at)`,
  ).bind(state, changedAt, startedAt, changedAt, channelId, changedAt);

export const refreshHelixStreamState = async (
  db: D1Database,
  channelId: string,
  state: StoredStreamState,
  changedAt: string,
  startedAt: string | null,
): Promise<boolean> => {
  const statements = [prepareRefreshHelixStreamState(db, channelId, state, changedAt, startedAt)];
  if (state === "online" && startedAt !== null) {
    statements.push(prepareBindPendingStreamControls(db, channelId, startedAt));
  }
  const results = await db.batch(statements);
  return (results[0]?.meta.changes ?? 0) > 0;
};
