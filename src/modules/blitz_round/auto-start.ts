import type { ModuleAlarmContext, ModulePointRoundResult, ModuleScheduleInputChangeReason } from "../contract";
import { BLITZ_AUTO_START_ALARM } from "./contracts";
import { createBlitzQuestionRepository } from "./adapters/d1";
import { openBlitzRound, loadEnabledBlitzSettings } from "./service";

const AUTO_START_STATE_KEY = "auto-start-state";
const MINUTE_MS = 60_000;

interface AutoStartState {
  intervalMinutes: number;
  deadlineAt: number | null;
  remainingMs: number;
  paused: boolean;
  waitingRoundId: string | null;
  moduleActivationRevision: number | null;
  lastResolvedRoundId: string | null;
  lastResolvedAt: string | null;
}

const readState = async (context: ModuleAlarmContext): Promise<AutoStartState | null> => {
  const value: unknown = await context.storage.get(AUTO_START_STATE_KEY);
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const state = value as Partial<AutoStartState>;
  if (!Number.isSafeInteger(state.intervalMinutes) || !Number.isSafeInteger(state.remainingMs) ||
      typeof state.paused !== "boolean" ||
      !(state.deadlineAt === null || typeof state.deadlineAt === "number") ||
      !(state.waitingRoundId === null || typeof state.waitingRoundId === "string") ||
      (state.moduleActivationRevision !== undefined && !(state.moduleActivationRevision === null || Number.isSafeInteger(state.moduleActivationRevision))) ||
      !(state.lastResolvedRoundId === null || typeof state.lastResolvedRoundId === "string") ||
      !(state.lastResolvedAt === null || typeof state.lastResolvedAt === "string")) return null;
  return { ...state, moduleActivationRevision: state.moduleActivationRevision ?? null } as AutoStartState;
};

const storeState = async (context: ModuleAlarmContext, state: AutoStartState): Promise<void> => {
  await context.storage.put(AUTO_START_STATE_KEY, state);
  if (state.deadlineAt === null && state.waitingRoundId !== null) {
    // One durable watchdog also recovers a cancelled or interrupted round.
    await context.schedule(BLITZ_AUTO_START_ALARM, Date.now() + MINUTE_MS, undefined, null);
  } else if (state.deadlineAt === null) await context.clear(BLITZ_AUTO_START_ALARM);
  else await context.schedule(BLITZ_AUTO_START_ALARM, state.deadlineAt, undefined, null);
};

const clearState = async (context: ModuleAlarmContext): Promise<void> => {
  await context.storage.delete(AUTO_START_STATE_KEY);
  await context.clear(BLITZ_AUTO_START_ALARM);
};

const emptyState = (intervalMinutes: number): AutoStartState => ({
  intervalMinutes,
  deadlineAt: null,
  remainingMs: intervalMinutes * MINUTE_MS,
  paused: false,
  waitingRoundId: null,
  moduleActivationRevision: null,
  lastResolvedRoundId: null,
  lastResolvedAt: null,
});

const scheduleFromBaseline = async (
  context: ModuleAlarmContext,
  intervalMinutes: number,
  baselineAt: number,
  previous: AutoStartState | null,
  moduleActivationRevision = previous?.moduleActivationRevision ?? null,
): Promise<void> => {
  const remainingMs = Math.max(0, baselineAt + intervalMinutes * MINUTE_MS - Date.now());
  const online = await context.streamState() === "online";
  const state: AutoStartState = {
    intervalMinutes,
    deadlineAt: online ? Date.now() + remainingMs : null,
    remainingMs,
    paused: !online,
    waitingRoundId: null,
    moduleActivationRevision,
    lastResolvedRoundId: previous?.lastResolvedRoundId ?? null,
    lastResolvedAt: previous?.lastResolvedAt ?? null,
  };
  await storeState(context, state);
};

const reconcileResolvedRound = async (
  context: ModuleAlarmContext,
  roundId: string,
  baselineAt: number,
  intervalMinutes: number,
  existing: AutoStartState | null,
  activationRevision = existing?.moduleActivationRevision ?? null,
): Promise<void> => {
  if (existing?.lastResolvedRoundId === roundId && existing.moduleActivationRevision === activationRevision) {
    // A crash can persist state before scheduling its alarm. Replay repairs it.
    await storeState(context, existing);
    return;
  }
  if (existing !== null && ((existing.lastResolvedAt !== null && Date.parse(existing.lastResolvedAt) >= baselineAt) ||
      (existing.waitingRoundId !== null && existing.waitingRoundId !== roundId))) return;
  const online = await context.streamState() === "online";
  const remainingMs = online
    ? Math.max(0, baselineAt + intervalMinutes * MINUTE_MS - Date.now())
    : intervalMinutes * MINUTE_MS;
  await storeState(context, {
    intervalMinutes,
    deadlineAt: online ? Date.now() + remainingMs : null,
    remainingMs,
    paused: !online,
    waitingRoundId: null,
    moduleActivationRevision: activationRevision,
    lastResolvedRoundId: roundId,
    lastResolvedAt: new Date(baselineAt).toISOString(),
  });
};

const moduleActivationRevision = async (context: ModuleAlarmContext): Promise<number | null> => {
  const row = await context.DB.prepare(
    "SELECT revision FROM channel_modules WHERE channel_id = ? AND module_id = 'blitz_round'",
  ).bind(context.channelId).first<{ revision: number }>();
  return row !== null && Number.isSafeInteger(row.revision) ? row.revision : null;
};

export const configureBlitzAutoStart = async (
  context: ModuleAlarmContext,
  reason: ModuleScheduleInputChangeReason | "settings",
): Promise<void> => {
  const settings = await loadEnabledBlitzSettings(context.DB, context.channelId);
  if (settings === null || !settings.autoStart) {
    await clearState(context);
    return;
  }
  const existing = await readState(context);
  const currentActivationRevision = reason === "activation"
    ? await moduleActivationRevision(context)
    : existing?.moduleActivationRevision ?? null;
  const active = await context.points.rounds.active();
  if (active !== null) {
    const intervalMinutes = settings.autoStartIntervalMinutes;
    await storeState(context, {
      intervalMinutes,
      deadlineAt: null,
      remainingMs: intervalMinutes * MINUTE_MS,
      paused: false,
      waitingRoundId: active.roundId,
      moduleActivationRevision: currentActivationRevision,
      lastResolvedRoundId: existing?.lastResolvedRoundId ?? null,
      lastResolvedAt: existing?.lastResolvedAt ?? null,
    });
    return;
  }
  if (existing?.waitingRoundId != null) {
    // A recovered round gets the same identity and baseline treatment as a delivered resolution.
    await reconcileResolvedRound(context, existing.waitingRoundId, Date.now(), settings.autoStartIntervalMinutes, existing,
      reason === "activation" ? currentActivationRevision : existing.moduleActivationRevision);
    return;
  }
  if (reason === "activation" && existing?.moduleActivationRevision !== currentActivationRevision) {
    await scheduleFromBaseline(context, settings.autoStartIntervalMinutes, Date.now(), existing, currentActivationRevision);
    return;
  }
  if (reason === "stream_state" && existing !== null) {
    const online = await context.streamState() === "online";
    if (!online) {
      const remainingMs = existing.paused
        ? existing.remainingMs
        : Math.max(0, (existing.deadlineAt ?? Date.now()) - Date.now());
      await storeState(context, { ...existing, intervalMinutes: settings.autoStartIntervalMinutes,
        deadlineAt: null, remainingMs, paused: true });
      return;
    }
    if (existing.paused) {
      const deadlineAt = Date.now() + existing.remainingMs;
      await storeState(context, { ...existing, intervalMinutes: settings.autoStartIntervalMinutes,
        deadlineAt, paused: false });
      return;
    }
  }
  if (existing !== null && reason !== "settings") return;
  if (existing !== null && existing.lastResolvedAt !== null) {
    const remainingMs = Math.max(0, (existing.paused ? existing.remainingMs
      : Math.max(0, (existing.deadlineAt ?? Date.now()) - Date.now())) +
      (settings.autoStartIntervalMinutes - existing.intervalMinutes) * MINUTE_MS);
    const online = await context.streamState() === "online";
    await storeState(context, { ...existing, intervalMinutes: settings.autoStartIntervalMinutes,
      remainingMs, deadlineAt: online ? Date.now() + remainingMs : null, paused: !online });
    return;
  }
  await scheduleFromBaseline(context, settings.autoStartIntervalMinutes, Date.now(), existing);
};

export const handleBlitzAutoStartAlarm = async (
  context: ModuleAlarmContext,
  alarmKey: string,
  _deadline: number,
  _ownerRevision?: number,
  invocation?: unknown,
): Promise<void> => {
  const settings = await loadEnabledBlitzSettings(context.DB, context.channelId);
  if (settings === null || !settings.autoStart) {
    await clearState(context);
    return;
  }
  if (typeof invocation === "object" && invocation !== null && "kind" in invocation &&
      invocation.kind === "manual_start" && "roundId" in invocation && typeof invocation.roundId === "string") {
    const existing = await readState(context);
    await storeState(context, {
      intervalMinutes: settings.autoStartIntervalMinutes,
      deadlineAt: null,
      remainingMs: settings.autoStartIntervalMinutes * MINUTE_MS,
      paused: false,
      waitingRoundId: invocation.roundId,
      moduleActivationRevision: existing?.moduleActivationRevision ?? null,
      lastResolvedRoundId: existing?.lastResolvedRoundId ?? null,
      lastResolvedAt: existing?.lastResolvedAt ?? null,
    });
    return;
  }
  if (alarmKey === "settings-changed") {
    await configureBlitzAutoStart(context, "settings");
    return;
  }

  const state = await readState(context);
  if (state !== null && state.waitingRoundId !== null) {
    const active = await context.points.rounds.active();
    if (active !== null) await storeState(context, { ...state, waitingRoundId: active.roundId });
    else await reconcileResolvedRound(context, state.waitingRoundId, Date.now(), settings.autoStartIntervalMinutes, state);
    return;
  }
  const streamIsLive = await context.streamState() === "online";
  const current = state ?? emptyState(settings.autoStartIntervalMinutes);
  if (!streamIsLive) {
    const remainingMs = current.paused
      ? current.remainingMs
      : current.deadlineAt === null || current.deadlineAt <= Date.now()
        ? current.intervalMinutes * MINUTE_MS
        : current.deadlineAt - Date.now();
    await storeState(context, { ...current, deadlineAt: null, remainingMs, paused: true,
      intervalMinutes: settings.autoStartIntervalMinutes });
    return;
  }
  if (current.deadlineAt !== null && current.deadlineAt > Date.now()) {
    await storeState(context, { ...current, intervalMinutes: settings.autoStartIntervalMinutes });
    return;
  }
  const active = await context.points.rounds.active();
  if (active !== null) {
    await storeState(context, { ...current, intervalMinutes: settings.autoStartIntervalMinutes,
      deadlineAt: null, waitingRoundId: active.roundId, paused: false });
    return;
  }
  try {
    const opened = await openBlitzRound({
      channelId: context.channelId,
      settings,
      language: await context.channelLanguage(),
      points: context.points,
      repository: createBlitzQuestionRepository(context.DB),
    });
    await storeState(context, { ...current, intervalMinutes: settings.autoStartIntervalMinutes,
      deadlineAt: null, waitingRoundId: opened.roundId, paused: false });
  } catch (error) {
    if (error instanceof Error && error.message === "question_pool_empty") {
      const deadlineAt = Date.now() + settings.autoStartIntervalMinutes * MINUTE_MS;
      await storeState(context, { ...current, intervalMinutes: settings.autoStartIntervalMinutes,
        deadlineAt, remainingMs: settings.autoStartIntervalMinutes * MINUTE_MS, paused: false });
      return;
    }
    if (error instanceof Error && error.message === "round_active") {
      const open = await context.points.rounds.active();
      await storeState(context, { ...current, deadlineAt: null, waitingRoundId: open?.roundId ?? null, paused: false });
      return;
    }
    throw error;
  }
};

export const onBlitzRoundResolved = async (
  context: ModuleAlarmContext,
  round: ModulePointRoundResult,
): Promise<void> => {
  const settings = await loadEnabledBlitzSettings(context.DB, context.channelId);
  if (settings === null || !settings.autoStart) {
    await clearState(context);
    return;
  }
  const existing = await readState(context);
  const resolvedAt = Date.parse(round.resolvedAt);
  const baselineAt = Number.isFinite(resolvedAt) ? resolvedAt : Date.now();
  await reconcileResolvedRound(context, round.roundId, baselineAt, settings.autoStartIntervalMinutes, existing);
};
