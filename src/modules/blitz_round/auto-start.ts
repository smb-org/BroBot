import type { ModuleAlarmContext, ModuleAlarmDefinition, ModuleAlarmIdentity, ModulePointRoundAnnouncement, ModulePointRoundResult, ModuleScheduleInputChangeReason, ModuleStreamState } from "../contract";
import { createBlitzQuestionRepository } from "./adapters/d1";
import {
  BLITZ_AUTO_START_MAX_MINUTES,
  BLITZ_AUTO_START_MINUTES,
  BLITZ_ROUND_MODULE_ID,
  blitzRoundSettingsSchema,
  type BlitzRoundSettings,
} from "./contracts";
import { openBlitzRound } from "./service";

const BLITZ_AUTO_START_ALARM_KEY = "auto-start";
const BLITZ_AUTO_START_STATE_KEY = "auto-start-state";
const BLITZ_AUTO_START_WATCHDOG_MS = 60_000;
const BLITZ_AUTO_START_GRACE_MS = 60_000;

const MINUTE_MS = 60_000;

interface BlitzAutoStartState {
  baseline: string;
  moduleActivationRevision: number;
  settingsRevision: number;
  intervalMinutes: number;
  mode: "live" | "paused";
  deadlineAt: number | null;
  remainingMs: number;
  awaitingRoundId: string | null;
  awaitingRoundBaseline: string | null;
  watchdogAt: number | null;
}

interface BlitzModuleRow {
  enabled: number;
  settings: string;
  revision: number;
  settings_revision: number;
}

interface BlitzAutoStartConfig {
  enabled: boolean;
  settings: BlitzRoundSettings;
  moduleActivationRevision: number;
  settingsRevision: number;
  baseline: string;
}

interface RoundReference {
  roundId: string;
  data: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readState = async (context: ModuleAlarmContext): Promise<BlitzAutoStartState | null> => {
  const value: unknown = await context.storage.get(BLITZ_AUTO_START_STATE_KEY);
  if (!isRecord(value) || typeof value.baseline !== "string" ||
      typeof value.moduleActivationRevision !== "number" || !Number.isSafeInteger(value.moduleActivationRevision) ||
      typeof value.settingsRevision !== "number" || !Number.isSafeInteger(value.settingsRevision) ||
      typeof value.intervalMinutes !== "number" || !Number.isSafeInteger(value.intervalMinutes) ||
      value.intervalMinutes < BLITZ_AUTO_START_MINUTES ||
      value.intervalMinutes > BLITZ_AUTO_START_MAX_MINUTES ||
      (value.mode !== "live" && value.mode !== "paused") ||
      !(value.deadlineAt === null || typeof value.deadlineAt === "number" && Number.isFinite(value.deadlineAt)) ||
      typeof value.remainingMs !== "number" || !Number.isFinite(value.remainingMs) || value.remainingMs < 0 ||
      !(value.awaitingRoundId === null || typeof value.awaitingRoundId === "string") ||
      !(value.awaitingRoundBaseline === null || typeof value.awaitingRoundBaseline === "string") ||
      !(value.watchdogAt === null || typeof value.watchdogAt === "number" && Number.isFinite(value.watchdogAt))) return null;
  return value as unknown as BlitzAutoStartState;
};

const readConfig = async (context: ModuleAlarmContext): Promise<BlitzAutoStartConfig | null> => {
  const row = await context.DB.prepare(
    "SELECT enabled, settings, revision, settings_revision FROM channel_modules WHERE channel_id = ? AND module_id = ?",
  ).bind(context.channelId, BLITZ_ROUND_MODULE_ID).first<BlitzModuleRow>();
  if (row === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.settings);
  } catch {
    return null;
  }
  const settings = blitzRoundSettingsSchema.safeParse(parsed);
  if (!settings.success || !Number.isSafeInteger(row.revision) || !Number.isSafeInteger(row.settings_revision) ||
      row.revision < row.settings_revision) return null;
  return {
    enabled: row.enabled === 1,
    settings: settings.data,
    moduleActivationRevision: row.revision - row.settings_revision,
    settingsRevision: row.settings_revision,
    baseline: `${String(row.revision - row.settings_revision)}:${String(row.settings_revision)}`,
  };
};

const baselineFromRoundData = (data: unknown): string | null =>
  isRecord(data) && typeof data.autoStartBaseline === "string" ? data.autoStartBaseline : null;

const intervalFor = (minutes: number): number => Math.max(BLITZ_AUTO_START_MINUTES,
  Math.min(BLITZ_AUTO_START_MAX_MINUTES, minutes)) * MINUTE_MS;

const modeFor = (stream: ModuleStreamState): "live" | "paused" => stream === "online" ? "live" : "paused";

const deadlineFor = (stream: ModuleStreamState, now: number, remainingMs: number): number | null =>
  stream === "online" ? now + remainingMs : null;

const remainingFor = (state: BlitzAutoStartState, now: number): number => state.mode === "live"
  ? Math.max(0, (state.deadlineAt ?? now) - now)
  : state.remainingMs;

const stateForBaseline = (
  config: BlitzAutoStartConfig,
  stream: ModuleStreamState,
  now: number,
  active: RoundReference | null,
  roundBaseline?: string | null,
): BlitzAutoStartState => {
  const remainingMs = intervalFor(config.settings.autoStartIntervalMinutes);
  const awaitingRoundId = active?.roundId ?? null;
  return {
    baseline: config.baseline,
    moduleActivationRevision: config.moduleActivationRevision,
    settingsRevision: config.settingsRevision,
    intervalMinutes: config.settings.autoStartIntervalMinutes,
    mode: modeFor(stream),
    deadlineAt: awaitingRoundId === null ? deadlineFor(stream, now, remainingMs) : null,
    remainingMs,
    awaitingRoundId,
    awaitingRoundBaseline: awaitingRoundId === null ? null : roundBaseline ?? baselineFromRoundData(active?.data) ?? null,
    watchdogAt: awaitingRoundId === null ? null : now + BLITZ_AUTO_START_WATCHDOG_MS,
  };
};

const expectedAlarmIdentity = (state: BlitzAutoStartState): ModuleAlarmIdentity | null => {
  const deadline = state.awaitingRoundId === null ? state.deadlineAt : state.watchdogAt;
  if (deadline === null) return null;
  return {
    timerId: "blitz-auto-start",
    revision: state.settingsRevision,
    triggerType: state.awaitingRoundId === null ? "interval" : "watchdog",
    state: state.mode,
    streamId: null,
    generation: state.moduleActivationRevision,
    deadline,
  };
};

const sameAlarmIdentity = (left: ModuleAlarmIdentity | null | undefined, right: ModuleAlarmIdentity): boolean =>
  left?.timerId === right.timerId && left.revision === right.revision && left.triggerType === right.triggerType &&
  left.state === right.state && left.streamId === right.streamId && left.generation === right.generation &&
  left.deadline === right.deadline;

const persistAndArm = async (context: ModuleAlarmContext, state: BlitzAutoStartState): Promise<void> => {
  const current = await readState(context);
  if (current === null || JSON.stringify(current) !== JSON.stringify(state)) {
    await context.storage.put(BLITZ_AUTO_START_STATE_KEY, state);
  }
  const identity = expectedAlarmIdentity(state);
  if (identity === null) {
    await context.clear(BLITZ_AUTO_START_ALARM_KEY);
    return;
  }
  await context.schedule(
    BLITZ_AUTO_START_ALARM_KEY,
    identity.deadline,
    identity.revision,
    identity.generation,
    identity,
  );
};

const clearState = async (context: ModuleAlarmContext): Promise<void> => {
  await context.storage.delete(BLITZ_AUTO_START_STATE_KEY);
  await context.clear(BLITZ_AUTO_START_ALARM_KEY);
};

const enabledConfig = (config: BlitzAutoStartConfig | null): config is BlitzAutoStartConfig =>
  config !== null && config.enabled && config.settings.autoStart;

const prepareCurrentState = (
  config: BlitzAutoStartConfig,
  state: BlitzAutoStartState | null,
  active: RoundReference | null,
  stream: ModuleStreamState,
  now: number,
): BlitzAutoStartState => {
  if (state === null || state.baseline !== config.baseline) {
    const waitingRoundId = active?.roundId ?? state?.awaitingRoundId ?? null;
    const waitingBaseline = active === null ? state?.awaitingRoundBaseline ?? null : baselineFromRoundData(active.data);
    return stateForBaseline(config, stream, now,
      waitingRoundId === null ? null : { roundId: waitingRoundId, data: active?.data }, waitingBaseline);
  }

  if (active !== null) {
    if (state.awaitingRoundId === active.roundId) {
      return state.mode === modeFor(stream) ? state : { ...state, mode: modeFor(stream) };
    }
    return {
      ...state,
      mode: modeFor(stream),
      deadlineAt: null,
      remainingMs: intervalFor(config.settings.autoStartIntervalMinutes),
      awaitingRoundId: active.roundId,
      awaitingRoundBaseline: baselineFromRoundData(active.data) ?? state.baseline,
      watchdogAt: now + BLITZ_AUTO_START_WATCHDOG_MS,
    };
  }

  if (state.awaitingRoundId !== null) return finishAwaitedRound(state, config, stream, now, state.awaitingRoundBaseline);
  if (state.intervalMinutes !== config.settings.autoStartIntervalMinutes) {
    const remainingMs = Math.max(0, remainingFor(state, now) +
      (config.settings.autoStartIntervalMinutes - state.intervalMinutes) * MINUTE_MS);
    return {
      ...state,
      intervalMinutes: config.settings.autoStartIntervalMinutes,
      remainingMs,
      mode: modeFor(stream),
      deadlineAt: deadlineFor(stream, now, remainingMs),
      watchdogAt: null,
    };
  }
  return applyStreamState(state, stream, now);
};

const applyStreamState = (
  state: BlitzAutoStartState,
  stream: ModuleStreamState,
  now: number,
): BlitzAutoStartState => {
  if (stream === "offline" || stream === "unknown") {
    const preserved = state.mode === "live" ? remainingFor(state, now) : state.remainingMs;
    return {
      ...state,
      mode: "paused",
      deadlineAt: null,
      remainingMs: preserved,
      watchdogAt: state.awaitingRoundId === null ? null : state.watchdogAt ?? now + BLITZ_AUTO_START_WATCHDOG_MS,
    };
  }
  if (state.mode === "paused") {
    return { ...state, mode: "live", deadlineAt: now + state.remainingMs };
  }
  return state;
};

const finishAwaitedRound = (
  state: BlitzAutoStartState,
  config: BlitzAutoStartConfig,
  stream: ModuleStreamState,
  now: number,
  resolvedBaseline: string | null,
): BlitzAutoStartState => {
  const sameBaseline = resolvedBaseline !== null && resolvedBaseline === state.baseline &&
    state.awaitingRoundBaseline === state.baseline;
  const remainingMs = sameBaseline ? intervalFor(config.settings.autoStartIntervalMinutes) : state.remainingMs;
  return {
    ...state,
    intervalMinutes: config.settings.autoStartIntervalMinutes,
    mode: modeFor(stream),
    deadlineAt: deadlineFor(stream, now, remainingMs),
    remainingMs,
    awaitingRoundId: null,
    awaitingRoundBaseline: null,
    watchdogAt: null,
  };
};

const handleOpenedRound = async (
  context: ModuleAlarmContext,
  config: BlitzAutoStartConfig,
  round: RoundReference,
): Promise<void> => {
  const now = Date.now();
  const [state, stream] = await Promise.all([readState(context), context.streamState()]);
  if (state?.awaitingRoundId === round.roundId) {
    const next = prepareCurrentState(config, state, round, stream, now);
    const identity = expectedAlarmIdentity(next);
    const plan = await context.getAlarmPlan?.(BLITZ_AUTO_START_ALARM_KEY);
    if (next !== state || identity === null || plan === null || plan === undefined || !sameAlarmIdentity(plan.identity, identity)) {
      await persistAndArm(context, next);
    }
    return;
  }
  const capturedBaseline = baselineFromRoundData(round.data);
  const currentBaseline = config.baseline;
  const remainingMs = state === null || capturedBaseline === currentBaseline
    ? intervalFor(config.settings.autoStartIntervalMinutes)
    : Math.max(0, remainingFor(state, now));
  const next: BlitzAutoStartState = {
    ...(state ?? stateForBaseline(config, stream, now, null)),
    baseline: currentBaseline,
    moduleActivationRevision: config.moduleActivationRevision,
    settingsRevision: config.settingsRevision,
    intervalMinutes: config.settings.autoStartIntervalMinutes,
    mode: modeFor(stream),
    deadlineAt: null,
    remainingMs,
    awaitingRoundId: round.roundId,
    awaitingRoundBaseline: capturedBaseline,
    watchdogAt: now + BLITZ_AUTO_START_WATCHDOG_MS,
  };
  await persistAndArm(context, next);
};

export const reconcileBlitzAutoStart = async (
  context: ModuleAlarmContext,
  reason: ModuleScheduleInputChangeReason | "settings" | "reconcile",
): Promise<void> => {
  void reason;
  const config = await readConfig(context);
  if (!enabledConfig(config)) {
    await clearState(context);
    return;
  }
  const [state, active, stream] = await Promise.all([
    readState(context),
    context.points.rounds.active(),
    context.streamState(),
  ]);
  const now = Date.now();
  const next = prepareCurrentState(config, state, active, stream, now);
  await persistAndArm(context, next);
};

export const onBlitzPointRoundOpened = async (
  context: ModuleAlarmContext,
  round: ModulePointRoundAnnouncement,
): Promise<void> => {
  const config = await readConfig(context);
  if (!enabledConfig(config)) {
    await clearState(context);
    return;
  }
  await handleOpenedRound(context, config, round);
};

export const onBlitzPointRoundResolved = async (
  context: ModuleAlarmContext,
  round: ModulePointRoundResult,
): Promise<void> => {
  const config = await readConfig(context);
  if (!enabledConfig(config)) {
    await clearState(context);
    return;
  }
  const state = await readState(context);
  if (state === null || state.awaitingRoundId !== round.roundId) return;
  const openedBaseline = baselineFromRoundData(round.data) ?? state.awaitingRoundBaseline;
  const stream = await context.streamState();
  const now = Date.now();
  const current = state.baseline === config.baseline ? state : {
    ...stateForBaseline(config, stream, now, { roundId: state.awaitingRoundId, data: round.data },
      state.awaitingRoundBaseline),
    remainingMs: intervalFor(config.settings.autoStartIntervalMinutes),
    deadlineAt: null,
  };
  await persistAndArm(context, finishAwaitedRound(current, config, stream, now, openedBaseline));
};

const dueIdentityMatches = (context: ModuleAlarmContext, state: BlitzAutoStartState): boolean => {
  const identity = expectedAlarmIdentity(state);
  return identity !== null && sameAlarmIdentity(context.alarmIdentity, identity);
};

const recoverAwaitedRound = async (
  context: ModuleAlarmContext,
  config: BlitzAutoStartConfig,
  state: BlitzAutoStartState,
  active: RoundReference | null,
  stream: ModuleStreamState,
  now: number,
): Promise<void> => {
  if (active !== null) {
    await persistAndArm(context, {
      ...state,
      mode: modeFor(stream),
      watchdogAt: now + BLITZ_AUTO_START_WATCHDOG_MS,
    });
    return;
  }
  await persistAndArm(context, finishAwaitedRound(state, config, stream, now, state.awaitingRoundBaseline));
};

export const handleBlitzAutoStartAlarm = async (
  context: ModuleAlarmContext,
  alarmKey: string,
  deadline: number,
): Promise<void> => {
  if (alarmKey === "settings-changed") {
    await reconcileBlitzAutoStart(context, "settings");
    return;
  }
  const config = await readConfig(context);
  if (!enabledConfig(config)) {
    await clearState(context);
    return;
  }
  const state = await readState(context);
  if (state === null || state.baseline !== config.baseline) {
    await reconcileBlitzAutoStart(context, "reconcile");
    return;
  }
  if (!dueIdentityMatches(context, state)) {
    const expected = expectedAlarmIdentity(state);
    const plan = await context.getAlarmPlan?.(BLITZ_AUTO_START_ALARM_KEY);
    if (expected !== null && (plan === null || plan === undefined || !sameAlarmIdentity(plan.identity, expected))) {
      await persistAndArm(context, state);
    }
    return;
  }

  const now = Date.now();
  const [active, stream] = await Promise.all([context.points.rounds.active(), context.streamState()]);
  if (state.awaitingRoundId !== null) {
    if (state.watchdogAt === null || deadline !== state.watchdogAt) return;
    await recoverAwaitedRound(context, config, state, active, stream, now);
    return;
  }
  if (state.deadlineAt === null || deadline !== state.deadlineAt || state.deadlineAt > now) {
    await persistAndArm(context, state);
    return;
  }
  if (active !== null) {
    await handleOpenedRound(context, config, active);
    return;
  }
  if (stream !== "online") {
    await persistAndArm(context, applyStreamState(state, stream, now));
    return;
  }
  if (now - state.deadlineAt > BLITZ_AUTO_START_GRACE_MS) {
    await persistAndArm(context, stateForBaseline(config, stream, now, null));
    return;
  }

  try {
    const opened = await openBlitzRound({
      channelId: context.channelId,
      autoStartBaseline: config.baseline,
      settings: config.settings,
      language: await context.channelLanguage(),
      points: context.points,
      repository: createBlitzQuestionRepository(context.DB),
    });
    await handleOpenedRound(context, config, { roundId: opened.roundId, data: opened.data });
  } catch {
    const current = await context.points.rounds.active();
    if (current !== null) await handleOpenedRound(context, config, current);
    else await persistAndArm(context, stateForBaseline(config, stream, Date.now(), null));
  }
};

export const blitzAutoStartAlarm: ModuleAlarmDefinition = {
  key: BLITZ_AUTO_START_ALARM_KEY,
  retryDelaysMs: [5_000, 15_000, 60_000],
  handle: handleBlitzAutoStartAlarm,
  onScheduleInputsChanged: async (context, reason) => reconcileBlitzAutoStart(context, reason),
};
