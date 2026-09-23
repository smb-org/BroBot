import type { ModuleStreamState } from "../../modules/contract";

export type StoredStreamState = Exclude<ModuleStreamState, "unknown">;
export type StreamStateSource = "eventsub" | "helix";

export interface StoredStreamStateRecord {
  state: StoredStreamState;
  source: StreamStateSource;
  changedAt: string;
  /** The real stream start, independent of `changedAt` (see migration 0006). Null when unknown or offline. */
  startedAt: string | null;
}

interface StreamStateRow {
  state: StoredStreamState;
  source: StreamStateSource;
  changed_at: string;
  started_at: string | null;
}

export const readChannelStreamState = async (
  db: D1Database,
  channelId: string,
): Promise<StoredStreamStateRecord | null> => {
  const row = await db.prepare(
    `SELECT state, source, changed_at, started_at
       FROM channel_stream_state
      WHERE channel_id = ?`,
  ).bind(channelId).first<StreamStateRow>();
  return row === null ? null : { state: row.state, source: row.source, changedAt: row.changed_at, startedAt: row.started_at };
};

export const writeEventSubStreamState = async (
  db: D1Database,
  channelId: string,
  state: StoredStreamState,
  changedAt: string,
  startedAt: string | null,
): Promise<boolean> => {
  const result = await db.prepare(
    `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, started_at)
     VALUES (?, ?, ?, 'eventsub', ?)
     ON CONFLICT (channel_id) DO UPDATE
       SET state = excluded.state, changed_at = excluded.changed_at, source = 'eventsub', started_at = excluded.started_at
     WHERE julianday(excluded.changed_at) >= julianday(channel_stream_state.changed_at)`,
  ).bind(channelId, state, changedAt, startedAt).run();
  return result.meta.changes > 0;
};

export const writeHelixStreamStateIfUnknown = async (
  db: D1Database,
  channelId: string,
  state: StoredStreamState,
  changedAt: string,
  startedAt: string | null,
): Promise<boolean> => {
  const result = await db.prepare(
    `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, started_at)
     VALUES (?, ?, ?, 'helix', ?)
     ON CONFLICT (channel_id) DO NOTHING`,
  ).bind(channelId, state, changedAt, startedAt).run();
  return result.meta.changes > 0;
};

/**
 * Prepares a Helix refresh for any existing state row. `changed_at` records
 * the last successful Helix check as well as the EventSub transition
 * watermark; timestamp ordering prevents an in-flight poll from replacing a
 * newer transition.
 */
export const prepareRefreshHelixStreamState = (
  db: D1Database,
  channelId: string,
  state: StoredStreamState,
  changedAt: string,
  startedAt: string | null,
): D1PreparedStatement => db.prepare(
    `UPDATE channel_stream_state
        SET state = ?, changed_at = ?, source = 'helix', started_at = ?
      WHERE channel_id = ?
        AND julianday(?) >= julianday(changed_at)`,
  ).bind(state, changedAt, startedAt, channelId, changedAt);

export const refreshHelixStreamState = async (
  db: D1Database,
  channelId: string,
  state: StoredStreamState,
  changedAt: string,
  startedAt: string | null,
): Promise<boolean> => {
  const result = await prepareRefreshHelixStreamState(db, channelId, state, changedAt, startedAt).run();
  return result.meta.changes > 0;
};
