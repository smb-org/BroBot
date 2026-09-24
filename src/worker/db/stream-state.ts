import type { ModuleStreamState } from "../../modules/contract";
import {
  LEGACY_CURRENT_LIVE_SESSION,
  prepareAdoptLegacyLiveSessionControls,
  prepareBindPendingStreamControls,
} from "./channel-controls";

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

const timestampOrderBindings = (value: string | null): [number | null, string | null] => {
  const order = timestampOrder(value);
  return order === null ? [null, null] : [order.seconds, order.fraction];
};

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
    startedAt: row.started_at === LEGACY_CURRENT_LIVE_SESSION ? null : row.started_at,
    checkedAt: row.checked_at,
  };
};

export const writeEventSubStreamState = async (
  db: D1Database,
  channelId: string,
  state: StoredStreamState,
  changedAt: string,
  startedAt: string | null,
): Promise<EventSubStreamWriteResult> => {
  const eventOrder = timestampOrder(changedAt);
  if (eventOrder === null) return "invalid_timestamp";
  const [startedAtSeconds, startedAtFraction] = timestampOrderBindings(startedAt);
  const current = await readChannelStreamState(db, channelId);
  if (state === "offline" && current?.state === "online") {
    const sessionOrder = timestampOrder(current.startedAt);
    if (sessionOrder === null) return "ambiguous_offline";
    const order = compareTimestampOrders(eventOrder, sessionOrder);
    if (order < 0) return "stale_offline";
    // An offline event at the exact start instant cannot be ordered against
    // the session boundary. Let a forced Helix observation settle it.
    if (order === 0) return "ambiguous_offline";
  }
  const [eventSeconds, eventFraction] = timestampOrderBindings(changedAt);
  const statements = [db.prepare(
    `INSERT INTO channel_stream_state
       (channel_id, state, changed_at, source, started_at, checked_at, eventsub_changed_at,
        started_at_seconds, started_at_fraction, eventsub_changed_at_seconds, eventsub_changed_at_fraction)
     VALUES (?, ?, ?, 'eventsub', ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (channel_id) DO UPDATE
       SET state = excluded.state,
           changed_at = excluded.changed_at,
           source = 'eventsub',
           started_at = excluded.started_at,
           checked_at = excluded.checked_at,
           eventsub_changed_at = excluded.eventsub_changed_at,
           started_at_seconds = excluded.started_at_seconds,
           started_at_fraction = excluded.started_at_fraction,
           eventsub_changed_at_seconds = excluded.eventsub_changed_at_seconds,
           eventsub_changed_at_fraction = excluded.eventsub_changed_at_fraction
     WHERE (channel_stream_state.eventsub_changed_at_seconds IS NULL
         OR excluded.eventsub_changed_at_seconds > channel_stream_state.eventsub_changed_at_seconds
         OR (excluded.eventsub_changed_at_seconds = channel_stream_state.eventsub_changed_at_seconds
          AND excluded.eventsub_changed_at_fraction > channel_stream_state.eventsub_changed_at_fraction))
       AND (excluded.state <> 'offline' OR channel_stream_state.state <> 'online'
         OR (channel_stream_state.started_at_seconds IS NOT NULL
          AND (excluded.eventsub_changed_at_seconds > channel_stream_state.started_at_seconds
            OR (excluded.eventsub_changed_at_seconds = channel_stream_state.started_at_seconds
             AND excluded.eventsub_changed_at_fraction > channel_stream_state.started_at_fraction))))`,
  ).bind(
    channelId, state, changedAt, startedAt, changedAt, changedAt,
    startedAtSeconds, startedAtFraction, eventSeconds, eventFraction,
  )];
  if (state === "online" && startedAt !== null) {
    statements.push(prepareBindPendingStreamControls(db, channelId, startedAt));
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
): Promise<boolean> => {
  const [startedAtSeconds, startedAtFraction] = timestampOrderBindings(startedAt);
  const statements = [db.prepare(
    `INSERT INTO channel_stream_state
       (channel_id, state, changed_at, source, started_at, checked_at, eventsub_changed_at,
        started_at_seconds, started_at_fraction)
     VALUES (?, ?, ?, 'helix', ?, ?, NULL, ?, ?)
     ON CONFLICT (channel_id) DO NOTHING`,
  ).bind(channelId, state, changedAt, startedAt, changedAt, startedAtSeconds, startedAtFraction)];
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
): D1PreparedStatement => {
  const [startedAtSeconds, startedAtFraction] = timestampOrderBindings(startedAt);
  return db.prepare(
  `UPDATE channel_stream_state
        SET state = ?, changed_at = ?, source = 'helix', started_at = ?, checked_at = ?,
            started_at_seconds = ?, started_at_fraction = ?
      WHERE channel_id = ?
        AND julianday(?) >= julianday(changed_at)`,
  ).bind(state, changedAt, startedAt, changedAt, startedAtSeconds, startedAtFraction, channelId, changedAt);
};

export const refreshHelixStreamState = async (
  db: D1Database,
  channelId: string,
  state: StoredStreamState,
  changedAt: string,
  startedAt: string | null,
): Promise<boolean> => {
  const statements: D1PreparedStatement[] = [];
  if (state === "online" && startedAt !== null) {
    statements.push(prepareAdoptLegacyLiveSessionControls(db, channelId, startedAt, changedAt));
  }
  statements.push(prepareRefreshHelixStreamState(db, channelId, state, changedAt, startedAt));
  if (state === "online" && startedAt !== null) {
    statements.push(prepareBindPendingStreamControls(db, channelId, startedAt));
  }
  const results = await db.batch(statements);
  const refreshIndex = state === "online" && startedAt !== null ? 1 : 0;
  return (results[refreshIndex]?.meta.changes ?? 0) > 0;
};
