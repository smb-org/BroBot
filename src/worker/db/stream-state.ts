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

/** A stored EventSub state is authoritative only while both transition subscriptions are active. */
export const hasActiveStreamEventSubCoverage = async (
  db: D1Database,
  channelId: string,
): Promise<boolean> => {
  const row = await db.prepare(
    `SELECT CASE WHEN
       EXISTS (
         SELECT 1 FROM eventsub_subscriptions
          WHERE channel_id = ? AND subscription_type = 'stream.online'
            AND status = 'enabled' AND subscription_id IS NOT NULL
       )
       AND EXISTS (
         SELECT 1 FROM eventsub_subscriptions
          WHERE channel_id = ? AND subscription_type = 'stream.offline'
            AND status = 'enabled' AND subscription_id IS NOT NULL
       )
       THEN 1 ELSE 0 END AS covered`,
  ).bind(channelId, channelId).first<{ covered: number }>();
  return row?.covered === 1;
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
 * Refreshes a Helix-sourced row after its TTL expired, or takes over an
 * EventSub row when either stream transition subscription is no longer active.
 * The SQL coverage guard closes the race where subscriptions return while a
 * fallback Helix request is in flight. Timestamp ordering also rejects a
 * newer stream transition.
 */
export const refreshHelixStreamState = async (
  db: D1Database,
  channelId: string,
  state: StoredStreamState,
  changedAt: string,
  startedAt: string | null,
): Promise<boolean> => {
  const result = await db.prepare(
    `UPDATE channel_stream_state
        SET state = ?, changed_at = ?, source = 'helix', started_at = ?
      WHERE channel_id = ?
        AND (
          source = 'helix'
          OR (source = 'eventsub' AND (
            NOT EXISTS (
              SELECT 1 FROM eventsub_subscriptions
               WHERE channel_id = ? AND subscription_type = 'stream.online'
                 AND status = 'enabled' AND subscription_id IS NOT NULL
            )
            OR NOT EXISTS (
              SELECT 1 FROM eventsub_subscriptions
               WHERE channel_id = ? AND subscription_type = 'stream.offline'
                 AND status = 'enabled' AND subscription_id IS NOT NULL
            )
          ))
        )
        AND julianday(?) >= julianday(changed_at)`,
  ).bind(state, changedAt, startedAt, channelId, channelId, channelId, changedAt).run();
  return result.meta.changes > 0;
};
