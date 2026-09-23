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
  paused: number | null;
  paused_until: string | null;
  pause_until_stream_end: number | null;
}

interface DispatchChannelStateRow extends ChannelControlFields {
  module_id: string | null;
  enabled: number | null;
  settings: string | null;
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
  now: string,
): PanelChannelControl => {
  if (active !== 1) return offControl();
  if (untilStreamEnd === 1) return { active: true, until: null, mode: "until_stream_end" };
  if (until !== null) {
    const expiration = Date.parse(until);
    if (!Number.isFinite(expiration) || expiration <= Date.parse(now)) return offControl();
    return { active: true, until, mode: "timed" };
  }
  return { active: true, until: null, mode: "unlimited" };
};

const mapRow = (row: ChannelControlFields | null, now: string): PanelChannelControls => row === null
  ? { mute: offControl(), pause: offControl() }
  : {
    mute: mapControl(row.muted, row.muted_until, row.mute_until_stream_end, now),
    pause: mapControl(row.paused, row.paused_until, row.pause_until_stream_end, now),
  };

export const mapChannelControls = (row: ChannelControlFields, now: string): PanelChannelControls =>
  row.muted === null
    ? { mute: offControl(), pause: offControl() }
    : mapRow(row, now);

const controlRowFor = async (db: D1Database, channelId: string): Promise<ChannelControlFields | null> =>
  db.prepare(
    `SELECT muted, muted_until, mute_until_stream_end,
            paused, paused_until, pause_until_stream_end
       FROM channel_controls
      WHERE channel_id = ?`,
  ).bind(channelId).first<ChannelControlFields>();

export const readChannelControls = async (
  db: D1Database,
  channelId: string,
  now: string,
): Promise<PanelChannelControls> => mapRow(await controlRowFor(db, channelId), now);

export const readDispatchChannelState = async (
  db: D1Database,
  channelId: string,
  now: string,
): Promise<DispatchChannelState> => {
  const rows = await db.prepare(
    `SELECT channel_modules.module_id, channel_modules.enabled, channel_modules.settings,
            channel_controls.muted, channel_controls.muted_until, channel_controls.mute_until_stream_end,
            channel_controls.paused, channel_controls.paused_until, channel_controls.pause_until_stream_end
       FROM channels
       LEFT JOIN channel_modules ON channel_modules.channel_id = channels.channel_id
       LEFT JOIN channel_controls ON channel_controls.channel_id = channels.channel_id
      WHERE channels.channel_id = ?`,
  ).bind(channelId).all<DispatchChannelStateRow>();
  const first = rows.results[0];
  return {
    controls: first === undefined ? mapRow(null, now) : mapRow(first, now),
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
  active: control.active,
  mode: control.mode,
  until: control.until,
});

const isChannelControlDuration = (value: unknown): value is ChannelControlDuration =>
  typeof value === "string" && (CHANNEL_CONTROL_DURATIONS as readonly string[]).includes(value);

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
  const before = await readChannelControls(db, channelId, changedAt);
  const after = {
    ...before,
    [kind]: requestedControl(duration, changedAt),
  };
  if (JSON.stringify(before[kind]) === JSON.stringify(after[kind])) return { outcome: "unchanged", controls: before };

  const mute = storedControl(after.mute);
  const pause = storedControl(after.pause);
  const mutation = db.prepare(
    `INSERT INTO channel_controls (
       channel_id, muted, muted_until, mute_until_stream_end,
       paused, paused_until, pause_until_stream_end, updated_at
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE 1 = 1
      ${actorGuard(ANY_MEMBER_ROLES)}
     ON CONFLICT (channel_id) DO UPDATE SET
       muted = excluded.muted,
       muted_until = excluded.muted_until,
       mute_until_stream_end = excluded.mute_until_stream_end,
       paused = excluded.paused,
       paused_until = excluded.paused_until,
       pause_until_stream_end = excluded.pause_until_stream_end,
       updated_at = excluded.updated_at
     WHERE channel_controls.muted <> excluded.muted
        OR channel_controls.muted_until IS NOT excluded.muted_until
        OR channel_controls.mute_until_stream_end <> excluded.mute_until_stream_end
        OR channel_controls.paused <> excluded.paused
        OR channel_controls.paused_until IS NOT excluded.paused_until
        OR channel_controls.pause_until_stream_end <> excluded.pause_until_stream_end`,
  ).bind(
    channelId,
    mute.active,
    mute.until,
    mute.untilStreamEnd,
    pause.active,
    pause.until,
    pause.untilStreamEnd,
    changedAt,
    ...bindActorGuard(actor, channelId, changedAt),
  );

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
  return { outcome: "changed", controls: after };
};

/**
 * Stream-scoped brakes end with the stream. This is an automatic lifecycle
 * change rather than a member action, so it does not create an audit row.
 */
export const clearStreamEndChannelControls = async (
  db: D1Database,
  channelId: string,
  changedAt: string,
): Promise<void> => {
  await db.prepare(
    `UPDATE channel_controls
        SET muted = CASE WHEN mute_until_stream_end = 1 THEN 0 ELSE muted END,
            muted_until = CASE WHEN mute_until_stream_end = 1 THEN NULL ELSE muted_until END,
            mute_until_stream_end = 0,
            paused = CASE WHEN pause_until_stream_end = 1 THEN 0 ELSE paused END,
            paused_until = CASE WHEN pause_until_stream_end = 1 THEN NULL ELSE paused_until END,
            pause_until_stream_end = 0,
            updated_at = ?
      WHERE channel_id = ?
        AND (mute_until_stream_end = 1 OR pause_until_stream_end = 1)`,
  ).bind(changedAt, channelId).run();
};
