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
  /** Twitch's stable id for this live session. Older rows can be null until refreshed. */
  streamId: string | null;
  /** Most recent successful state observation, used for freshness independently of EventSub ordering. */
  checkedAt: string | null;
}

interface StreamStateRow {
  state: StoredStreamState;
  source: StreamStateSource;
  changed_at: string;
  started_at: string | null;
  stream_id: string | null;
  checked_at: string | null;
}

interface TimestampOrder {
  seconds: number;
  fraction: string;
}

export type EventSubStreamWriteResult =
  | "written"
  | "superseded"
  | "stale_offline"
  | "ambiguous_offline"
  | "invalid_timestamp";

const timestampOrder = (value: string | null): TimestampOrder | null => {
  if (value === null) return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/iu.exec(value);
  if (match === null) return null;
  const [date, time, fraction, sourceZone] = match.slice(1);
  if (date === undefined || time === undefined || sourceZone === undefined) return null;
  const zone = sourceZone.toUpperCase() === "Z" ? "Z" : sourceZone;
  const wholeSeconds = Date.parse(`${date}T${time}${zone}`);
  if (!Number.isFinite(wholeSeconds)) return null;
  return {
    seconds: Math.floor(wholeSeconds / 1000),
    fraction: (fraction ?? "").replace(/0+$/u, ""),
  };
};

const compareFractions = (left: string, right: string): number => {
  const width = Math.max(left.length, right.length);
  const paddedLeft = left.padEnd(width, "0");
  const paddedRight = right.padEnd(width, "0");
  return paddedLeft < paddedRight ? -1 : paddedLeft > paddedRight ? 1 : 0;
};

const compareTimestampOrders = (left: TimestampOrder, right: TimestampOrder): number =>
  left.seconds < right.seconds ? -1
    : left.seconds > right.seconds ? 1
      : compareFractions(left.fraction, right.fraction);

/** Timestamp identity fallback for rows written before Twitch stream ids were stored. */
export const timestampEpochMilliseconds = (value: string | null): number | null => {
  if (value === null) return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
};

const timestampOrderBindings = (value: string | null): [number | null, string | null] => {
  const order = timestampOrder(value);
  return order === null ? [null, null] : [order.seconds, order.fraction];
};

export const isOlderOnlineEventThanHelixOfflineObservation = (
  current: StoredStreamStateRecord | null,
  startedAt: string | null,
): boolean => {
  if (current?.state !== "offline" || current.source !== "helix") return false;
  const onlineStartMs = timestampEpochMilliseconds(startedAt);
  const offlineObservedMs = timestampEpochMilliseconds(current.changedAt);
  return onlineStartMs !== null && offlineObservedMs !== null && onlineStartMs < offlineObservedMs;
};

export const readChannelStreamState = async (
  db: D1Database,
  channelId: string,
): Promise<StoredStreamStateRecord | null> => {
  const row = await db.prepare(
    `SELECT state, source, changed_at, started_at, stream_id, checked_at
       FROM channel_stream_state
      WHERE channel_id = ?`,
  ).bind(channelId).first<StreamStateRow>();
  return row === null ? null : {
    state: row.state,
    source: row.source,
    changedAt: row.changed_at,
    startedAt: row.started_at,
    streamId: row.stream_id,
    checkedAt: row.checked_at,
  };
};

export const writeEventSubStreamState = async (
  db: D1Database,
  channelId: string,
  state: StoredStreamState,
  changedAt: string,
  startedAt: string | null,
  streamId: string | null = null,
): Promise<EventSubStreamWriteResult> => {
  const eventOrder = timestampOrder(changedAt);
  if (eventOrder === null) return "invalid_timestamp";
  const [startedAtSeconds, startedAtFraction] = timestampOrderBindings(startedAt);
  const startedAtEpochMs = timestampEpochMilliseconds(startedAt);
  const changedAtEpochMs = timestampEpochMilliseconds(changedAt);
  const current = await readChannelStreamState(db, channelId);

  if (state === "online" && current?.state === "online" && current.startedAt !== null && startedAt !== null) {
    const incomingSessionMs = timestampEpochMilliseconds(startedAt);
    const currentSessionMs = timestampEpochMilliseconds(current.startedAt);
    if (incomingSessionMs !== null && currentSessionMs !== null) {
      const idsKnown = streamId !== null && current.streamId !== null;
      const sameSessionId = idsKnown && streamId === current.streamId;
      if (!sameSessionId && (idsKnown ? incomingSessionMs <= currentSessionMs : incomingSessionMs < currentSessionMs)) {
        return "superseded";
      }
    }
  }

  if (state === "offline" && current?.state === "online") {
    const sessionOrder = timestampOrder(current.startedAt);
    const boundaryOrder = sessionOrder ?? timestampOrder(current.changedAt);
    if (boundaryOrder === null) return "ambiguous_offline";
    const order = compareTimestampOrders(eventOrder, boundaryOrder);
    if (order < 0) return "stale_offline";
    // An event at the exact known boundary cannot be ordered safely. Let a
    // forced Helix observation settle it.
    if (order === 0) return "ambiguous_offline";
  }

  const [eventSeconds, eventFraction] = timestampOrderBindings(changedAt);
  const statement = db.prepare(
    `INSERT INTO channel_stream_state
       (channel_id, state, changed_at, source, started_at, checked_at, eventsub_changed_at,
        started_at_seconds, started_at_fraction, eventsub_changed_at_seconds, eventsub_changed_at_fraction,
        stream_id, started_at_epoch_ms, changed_at_epoch_ms)
     VALUES (?, ?, ?, 'eventsub', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (channel_id) DO UPDATE
       SET state = excluded.state,
           changed_at = excluded.changed_at,
           source = 'eventsub',
           started_at = CASE WHEN excluded.state = 'online'
                                  AND excluded.started_at IS NULL
                                  AND channel_stream_state.state = 'online'
                                  AND excluded.stream_id IS NOT NULL
                                  AND excluded.stream_id = channel_stream_state.stream_id
                             THEN channel_stream_state.started_at ELSE excluded.started_at END,
           checked_at = excluded.checked_at,
           eventsub_changed_at = excluded.eventsub_changed_at,
           started_at_seconds = CASE WHEN excluded.state = 'online'
                                          AND excluded.started_at IS NULL
                                          AND channel_stream_state.state = 'online'
                                          AND excluded.stream_id IS NOT NULL
                                          AND excluded.stream_id = channel_stream_state.stream_id
                                     THEN channel_stream_state.started_at_seconds ELSE excluded.started_at_seconds END,
           started_at_fraction = CASE WHEN excluded.state = 'online'
                                           AND excluded.started_at IS NULL
                                           AND channel_stream_state.state = 'online'
                                           AND excluded.stream_id IS NOT NULL
                                           AND excluded.stream_id = channel_stream_state.stream_id
                                      THEN channel_stream_state.started_at_fraction ELSE excluded.started_at_fraction END,
           eventsub_changed_at_seconds = excluded.eventsub_changed_at_seconds,
           eventsub_changed_at_fraction = excluded.eventsub_changed_at_fraction,
           stream_id = CASE
             WHEN excluded.state <> 'online' THEN NULL
             WHEN excluded.stream_id IS NOT NULL THEN excluded.stream_id
             WHEN channel_stream_state.state = 'online'
              AND COALESCE(excluded.started_at_epoch_ms,
                   CAST(round((julianday(excluded.started_at) - 2440587.5) * 86400000.0) AS INTEGER))
                  = COALESCE(channel_stream_state.started_at_epoch_ms,
                   CAST(round((julianday(channel_stream_state.started_at) - 2440587.5) * 86400000.0) AS INTEGER))
             THEN channel_stream_state.stream_id ELSE NULL END,
           started_at_epoch_ms = CASE WHEN excluded.state = 'online'
                                           AND excluded.started_at IS NULL
                                           AND channel_stream_state.state = 'online'
                                           AND excluded.stream_id IS NOT NULL
                                           AND excluded.stream_id = channel_stream_state.stream_id
                                      THEN channel_stream_state.started_at_epoch_ms ELSE excluded.started_at_epoch_ms END,
           changed_at_epoch_ms = excluded.changed_at_epoch_ms
     WHERE (channel_stream_state.eventsub_changed_at_seconds IS NULL
         OR excluded.eventsub_changed_at_seconds > channel_stream_state.eventsub_changed_at_seconds
         OR (excluded.eventsub_changed_at_seconds = channel_stream_state.eventsub_changed_at_seconds
          AND excluded.eventsub_changed_at_fraction > channel_stream_state.eventsub_changed_at_fraction))
       AND (excluded.state <> 'offline' OR channel_stream_state.state <> 'online'
         OR (channel_stream_state.started_at_seconds IS NULL
          AND channel_stream_state.started_at IS NULL
          AND channel_stream_state.changed_at = ?)
         OR (channel_stream_state.started_at_seconds IS NOT NULL
          AND (excluded.eventsub_changed_at_seconds > channel_stream_state.started_at_seconds
            OR (excluded.eventsub_changed_at_seconds = channel_stream_state.started_at_seconds
             AND excluded.eventsub_changed_at_fraction > channel_stream_state.started_at_fraction))))
       AND (excluded.state <> 'online' OR channel_stream_state.state <> 'offline'
         OR channel_stream_state.source <> 'helix'
         OR (excluded.started_at_epoch_ms IS NOT NULL
          AND excluded.started_at_epoch_ms >= COALESCE(channel_stream_state.changed_at_epoch_ms,
               CAST(round((julianday(channel_stream_state.changed_at) - 2440587.5) * 86400000.0) AS INTEGER)))
         OR (excluded.started_at_epoch_ms IS NULL
          AND julianday(excluded.changed_at) >= julianday(channel_stream_state.changed_at)))
       AND (excluded.state <> 'online' OR channel_stream_state.state <> 'online'
         OR (excluded.stream_id IS NOT NULL AND channel_stream_state.stream_id IS NOT NULL
          AND excluded.stream_id = channel_stream_state.stream_id)
         OR ((excluded.stream_id IS NULL OR channel_stream_state.stream_id IS NULL)
          AND COALESCE(excluded.started_at_epoch_ms,
               CAST(round((julianday(excluded.started_at) - 2440587.5) * 86400000.0) AS INTEGER))
             >= COALESCE(channel_stream_state.started_at_epoch_ms,
               CAST(round((julianday(channel_stream_state.started_at) - 2440587.5) * 86400000.0) AS INTEGER)))
         OR (excluded.stream_id IS NOT NULL AND channel_stream_state.stream_id IS NOT NULL
          AND excluded.stream_id <> channel_stream_state.stream_id
          AND excluded.started_at_epoch_ms > COALESCE(channel_stream_state.started_at_epoch_ms,
               CAST(round((julianday(channel_stream_state.started_at) - 2440587.5) * 86400000.0) AS INTEGER))))`,
  ).bind(
    channelId, state, changedAt, startedAt, changedAt, changedAt,
    startedAtSeconds, startedAtFraction, eventSeconds, eventFraction,
    streamId, startedAtEpochMs, changedAtEpochMs, current?.changedAt ?? null,
  );
  const statements = [statement];
  if (state === "online" && startedAt !== null) {
    statements.push(prepareBindPendingStreamControls(db, channelId, startedAt, streamId));
  }
  const results = await db.batch(statements);
  return (results[0]?.meta.changes ?? 0) > 0 ? "written" : "superseded";
};

export const writeHelixStreamStateIfUnknown = async (
  db: D1Database,
  channelId: string,
  state: StoredStreamState,
  changedAt: string,
  startedAt: string | null,
  streamId: string | null = null,
): Promise<boolean> => {
  const [startedAtSeconds, startedAtFraction] = timestampOrderBindings(startedAt);
  const statement = db.prepare(
    `INSERT INTO channel_stream_state
       (channel_id, state, changed_at, source, started_at, checked_at, eventsub_changed_at,
        started_at_seconds, started_at_fraction, stream_id, started_at_epoch_ms, changed_at_epoch_ms)
     VALUES (?, ?, ?, 'helix', ?, ?, NULL, ?, ?, ?, ?, ?)
     ON CONFLICT (channel_id) DO NOTHING`,
  ).bind(channelId, state, changedAt, startedAt, changedAt, startedAtSeconds, startedAtFraction,
    streamId, timestampEpochMilliseconds(startedAt), timestampEpochMilliseconds(changedAt));
  const statements = [statement];
  if (state === "online" && startedAt !== null) {
    statements.push(prepareBindPendingStreamControls(db, channelId, startedAt, streamId));
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
  streamId: string | null = null,
): D1PreparedStatement => {
  const [startedAtSeconds, startedAtFraction] = timestampOrderBindings(startedAt);
  return db.prepare(
    `UPDATE channel_stream_state
        SET state = ?, changed_at = ?, source = 'helix', started_at = ?, checked_at = ?,
            started_at_seconds = ?, started_at_fraction = ?, stream_id = ?,
            started_at_epoch_ms = ?, changed_at_epoch_ms = ?
      WHERE channel_id = ?
        AND julianday(?) >= julianday(changed_at)`,
  ).bind(state, changedAt, startedAt, changedAt, startedAtSeconds, startedAtFraction,
    state === "online" ? streamId : null, timestampEpochMilliseconds(startedAt),
    timestampEpochMilliseconds(changedAt), channelId, changedAt);
};

export const refreshHelixStreamState = async (
  db: D1Database,
  channelId: string,
  state: StoredStreamState,
  changedAt: string,
  startedAt: string | null,
  streamId: string | null = null,
): Promise<boolean> => {
  const statements: D1PreparedStatement[] = [prepareRefreshHelixStreamState(db, channelId, state, changedAt, startedAt, streamId)];
  if (state === "online" && startedAt !== null) {
    statements.push(prepareBindPendingStreamControls(db, channelId, startedAt, streamId));
  }
  const results = await db.batch(statements);
  return (results[0]?.meta.changes ?? 0) > 0;
};
