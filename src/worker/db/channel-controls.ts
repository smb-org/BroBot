import {
  CHANNEL_CONTROL_DURATIONS,
  type AuditWriteAction,
  type ChannelControlDuration,
} from "../../contracts/values";
import type { PanelChannelControl, PanelChannelControls } from "../../panel-contract";
import { ANY_MEMBER_ROLES, actorGuard, bindActorGuard, type ActorContext } from "./guards";
import { prepareAudit } from "./audit";

export type ChannelControlKind = "mute" | "pause";

export interface ChannelControlFields {
  muted: number | null;
  muted_until: string | null;
  mute_until_stream_end: number | null;
  mute_stream_started_at: string | null;
  paused: number | null;
  paused_until: string | null;
  pause_until_stream_end: number | null;
  pause_stream_started_at: string | null;
}

interface DispatchChannelStateRow extends ChannelControlFields {
  module_id: string | null;
  enabled: number | null;
  settings: string | null;
  stream_state: string | null;
  stream_started_at: string | null;
}

interface CurrentStreamFields {
  stream_state: string | null;
  stream_started_at: string | null;
}

export interface DispatchChannelState {
  controls: PanelChannelControls;
  activations: { moduleId: string; enabled: boolean; settings: string }[];
}

const offControl = (): PanelChannelControl => ({ active: false, until: null, mode: null });

const mapControl = (
  active: number | null,
  until: string | null,
  untilStreamEnd: number | null,
  streamStartedAt: string | null,
  currentStream: CurrentStreamFields,
  now: string,
  showPending: boolean,
): PanelChannelControl => {
  if (active !== 1) return offControl();
  if (untilStreamEnd === 1) {
    const pending = streamStartedAt === null;
    const belongsToCurrentStream = currentStream.stream_state === "online" &&
      currentStream.stream_started_at !== null && streamStartedAt === currentStream.stream_started_at;
    if (belongsToCurrentStream) return { active: true, until: null, mode: "until_stream_end" };
    if (pending && showPending) return { active: false, pending: true, until: null, mode: "until_stream_end" };
    return offControl();
  }
  if (until !== null) {
    const expiration = Date.parse(until);
    if (!Number.isFinite(expiration) || expiration <= Date.parse(now)) return offControl();
    return { active: true, until, mode: "timed" };
  }
  return { active: true, until: null, mode: "unlimited" };
};

const mapRow = (
  row: (ChannelControlFields & CurrentStreamFields) | null,
  now: string,
  showPending: boolean,
): PanelChannelControls => row === null
  ? { mute: offControl(), pause: offControl() }
  : {
    mute: mapControl(row.muted, row.muted_until, row.mute_until_stream_end,
      row.mute_stream_started_at, row, now, showPending),
    pause: mapControl(row.paused, row.paused_until, row.pause_until_stream_end,
      row.pause_stream_started_at, row, now, showPending),
  };

export const mapChannelControls = (row: ChannelControlFields & CurrentStreamFields, now: string): PanelChannelControls =>
  row.muted === null
    ? { mute: offControl(), pause: offControl() }
    : mapRow(row, now, true);

const controlRowFor = async (
  db: D1Database,
  channelId: string,
): Promise<(ChannelControlFields & CurrentStreamFields) | null> =>
  db.prepare(
    `SELECT controls.muted, controls.muted_until, controls.mute_until_stream_end,
            controls.mute_stream_started_at,
            controls.paused, controls.paused_until, controls.pause_until_stream_end,
            controls.pause_stream_started_at,
            stream_state.state AS stream_state, stream_state.started_at AS stream_started_at
       FROM channel_controls AS controls
       LEFT JOIN channel_stream_state AS stream_state ON stream_state.channel_id = controls.channel_id
      WHERE controls.channel_id = ?`,
  ).bind(channelId).first<ChannelControlFields & CurrentStreamFields>();

export const readChannelControls = async (
  db: D1Database,
  channelId: string,
  now: string,
): Promise<PanelChannelControls> => mapRow(await controlRowFor(db, channelId), now, true);

export const readDispatchChannelState = async (
  db: D1Database,
  channelId: string,
  now: string,
): Promise<DispatchChannelState> => {
  const rows = await db.prepare(
    `SELECT channel_modules.module_id, channel_modules.enabled, channel_modules.settings,
            channel_controls.muted, channel_controls.muted_until, channel_controls.mute_until_stream_end,
            channel_controls.mute_stream_started_at,
            channel_controls.paused, channel_controls.paused_until, channel_controls.pause_until_stream_end,
            channel_controls.pause_stream_started_at,
            channel_stream_state.state AS stream_state,
            channel_stream_state.started_at AS stream_started_at
       FROM channels
       LEFT JOIN channel_modules ON channel_modules.channel_id = channels.channel_id
       LEFT JOIN channel_controls ON channel_controls.channel_id = channels.channel_id
       LEFT JOIN channel_stream_state ON channel_stream_state.channel_id = channels.channel_id
      WHERE channels.channel_id = ?`,
  ).bind(channelId).all<DispatchChannelStateRow>();
  const first = rows.results[0];
  return {
    controls: first === undefined ? mapRow(null, now, false) : mapRow(first, now, false),
    activations: rows.results.flatMap((row) => row.module_id === null || row.enabled === null || row.settings === null
      ? []
      : [{ moduleId: row.module_id, enabled: row.enabled === 1, settings: row.settings }]),
  };
};

interface StoredControl {
  active: number;
  until: string | null;
  untilStreamEnd: number;
}

const storedControl = (control: PanelChannelControl): StoredControl => ({
  active: control.active ? 1 : 0,
  until: control.mode === "timed" ? control.until : null,
  untilStreamEnd: control.mode === "until_stream_end" ? 1 : 0,
});

const requestedControl = (duration: ChannelControlDuration | null, now: string): PanelChannelControl => {
  if (duration === null) return offControl();
  if (duration === "until_stream_end") return { active: true, until: null, mode: duration };
  if (duration === "unlimited") return { active: true, until: null, mode: duration };
  const milliseconds = duration === "15m" ? 15 * 60 * 1000 : 60 * 60 * 1000;
  return { active: true, until: new Date(Date.parse(now) + milliseconds).toISOString(), mode: "timed" };
};

const controlSnapshot = (control: PanelChannelControl): Readonly<Record<string, string | boolean | null>> => ({
  active: control.active || control.pending === true,
  mode: control.mode,
  until: control.until,
});

const isChannelControlDuration = (value: unknown): value is ChannelControlDuration =>
  typeof value === "string" && (CHANNEL_CONTROL_DURATIONS as readonly string[]).includes(value);

const storedControlMatches = (
  row: (ChannelControlFields & CurrentStreamFields) | null,
  kind: ChannelControlKind,
  requested: StoredControl,
): boolean => {
  if (row === null) return !requested.active;
  const active = kind === "mute" ? row.muted : row.paused;
  const until = kind === "mute" ? row.muted_until : row.paused_until;
  const untilStreamEnd = kind === "mute" ? row.mute_until_stream_end : row.pause_until_stream_end;
  const streamStartedAt = kind === "mute" ? row.mute_stream_started_at : row.pause_stream_started_at;
  const requestedStreamStartedAt = requested.untilStreamEnd === 1 && row.stream_state === "online"
    ? row.stream_started_at
    : null;
  return active === requested.active && until === requested.until && untilStreamEnd === requested.untilStreamEnd &&
    streamStartedAt === requestedStreamStartedAt;
};

export const isChannelControlInput = (value: unknown): value is ChannelControlDuration | null =>
  value === null || isChannelControlDuration(value);

export interface SetChannelControlResult {
  outcome: "changed" | "unchanged" | "concurrent";
  controls: PanelChannelControls;
}

/**
 * Control writes carry the all-member threshold in their SQL guard. These are
 * operational brakes: any person already trusted to operate the channel may
 * remove visible behavior, while enabling modules remains a separate,
 * managing action.
 */
export const setChannelControl = async (
  db: D1Database,
  actor: ActorContext,
  channelId: string,
  kind: ChannelControlKind,
  duration: ChannelControlDuration | null,
  changedAt: string,
): Promise<SetChannelControlResult> => {
  const storedBefore = await controlRowFor(db, channelId);
  const before = mapRow(storedBefore, changedAt, true);
  const after = {
    ...before,
    [kind]: requestedControl(duration, changedAt),
  };
  const requested = storedControl(after[kind]);
  if (storedControlMatches(storedBefore, kind, requested)) return { outcome: "unchanged", controls: before };
  const mutation = kind === "mute"
    ? db.prepare(
      `INSERT INTO channel_controls
         (channel_id, muted, muted_until, mute_until_stream_end, mute_stream_started_at, updated_at)
       SELECT ?, ?, ?, ?,
              CASE WHEN ? = 1 THEN (
                SELECT started_at FROM channel_stream_state
                 WHERE channel_id = ? AND state = 'online'
              ) ELSE NULL END,
              ?
        WHERE 1 = 1
        ${actorGuard(ANY_MEMBER_ROLES)}
       ON CONFLICT (channel_id) DO UPDATE SET
         muted = excluded.muted,
         muted_until = excluded.muted_until,
         mute_until_stream_end = excluded.mute_until_stream_end,
         mute_stream_started_at = excluded.mute_stream_started_at,
         updated_at = excluded.updated_at
       WHERE channel_controls.muted <> excluded.muted
          OR channel_controls.muted_until IS NOT excluded.muted_until
          OR channel_controls.mute_until_stream_end <> excluded.mute_until_stream_end
          OR channel_controls.mute_stream_started_at IS NOT excluded.mute_stream_started_at`,
    ).bind(channelId, requested.active, requested.until, requested.untilStreamEnd,
      requested.untilStreamEnd, channelId, changedAt,
      ...bindActorGuard(actor, channelId, changedAt))
    : db.prepare(
      `INSERT INTO channel_controls
         (channel_id, paused, paused_until, pause_until_stream_end, pause_stream_started_at, updated_at)
       SELECT ?, ?, ?, ?,
              CASE WHEN ? = 1 THEN (
                SELECT started_at FROM channel_stream_state
                 WHERE channel_id = ? AND state = 'online'
              ) ELSE NULL END,
              ?
        WHERE 1 = 1
        ${actorGuard(ANY_MEMBER_ROLES)}
       ON CONFLICT (channel_id) DO UPDATE SET
         paused = excluded.paused,
         paused_until = excluded.paused_until,
         pause_until_stream_end = excluded.pause_until_stream_end,
         pause_stream_started_at = excluded.pause_stream_started_at,
         updated_at = excluded.updated_at
       WHERE channel_controls.paused <> excluded.paused
          OR channel_controls.paused_until IS NOT excluded.paused_until
          OR channel_controls.pause_until_stream_end <> excluded.pause_until_stream_end
          OR channel_controls.pause_stream_started_at IS NOT excluded.pause_stream_started_at`,
    ).bind(channelId, requested.active, requested.until, requested.untilStreamEnd,
      requested.untilStreamEnd, channelId, changedAt,
      ...bindActorGuard(actor, channelId, changedAt));

  const action: AuditWriteAction = kind === "mute"
    ? after.mute.active ? "channel.mute.enabled" : "channel.mute.disabled"
    : after.pause.active ? "channel.pause.enabled" : "channel.pause.disabled";
  const audit = prepareAudit(
    db,
    actor.userId,
    changedAt,
    channelId,
    null,
    action,
    controlSnapshot(before[kind]),
    controlSnapshot(after[kind]),
  );
  const results = await db.batch([mutation, audit]);
  if ((results[0]?.meta.changes ?? 0) === 0) {
    return { outcome: "concurrent", controls: await readChannelControls(db, channelId, changedAt) };
  }
  return { outcome: "changed", controls: await readChannelControls(db, channelId, changedAt) };
};

/**
 * Binds pending stream-scoped controls to the first recorded live session.
 * Stream state writers call this in the same D1 batch as an accepted online
 * observation. A control set while offline therefore survives until a
 * stream is recorded and is then scoped to that session.
 */
export const prepareBindPendingStreamControls = (
  db: D1Database,
  channelId: string,
  startedAt: string,
): D1PreparedStatement => db.prepare(
  `UPDATE channel_controls
      SET mute_stream_started_at = CASE
            WHEN mute_until_stream_end = 1 AND mute_stream_started_at IS NULL THEN ?
            ELSE mute_stream_started_at
          END,
          pause_stream_started_at = CASE
            WHEN pause_until_stream_end = 1 AND pause_stream_started_at IS NULL THEN ?
            ELSE pause_stream_started_at
          END
    WHERE channel_id = ?
      AND ((mute_until_stream_end = 1 AND mute_stream_started_at IS NULL)
        OR (pause_until_stream_end = 1 AND pause_stream_started_at IS NULL))
      AND EXISTS (
        SELECT 1 FROM channel_stream_state
         WHERE channel_id = ? AND state = 'online' AND started_at = ?
      )`,
).bind(startedAt, startedAt, channelId, channelId, startedAt);
