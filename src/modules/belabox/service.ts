import type {
  ModuleAlarmContext,
  ModuleDiagnostic,
  ModuleEnableContext,
  ModuleSecretAccess,
} from "../contract";
import {
  BELABOX_ON_DEMAND_CACHE_MS,
  BELABOX_POLL_ALARM_KEY,
  BELABOX_PROBE_INTERVAL_MS,
  BELABOX_SECRET_UNAVAILABLE_STATUS_CODE,
  BELABOX_STATS_URL_SECRET,
  belaboxDefaultAlertTexts,
  belaboxSettingsSchema,
  type BelaboxFetchResult,
  type BelaboxSample,
  type BelaboxSettings,
  type BelaboxStatsUrlError,
} from "./contracts";
import type { ModuleLanguage } from "../contract";
import {
  belaboxStreamExists,
  belaboxStatusMatchesSession,
  belaboxStreamSessionKey,
  clearBelaboxSampleForPoll,
  clearBelaboxHistoryBaseline,
  finalizeAndResetBelaboxHistory,
  getBelaboxStreamStateSnapshot,
  getBelaboxStreamSession,
  getBelaboxStatus,
  markBelaboxPollingStarted,
  prepareBelaboxHistoryFinalizers,
  reopenCurrentBelaboxStream,
  sameBelaboxStreamSession,
  writeBelaboxAlertState,
  writeBelaboxFetch,
  type BelaboxFetchPhase,
  type BelaboxRecentPoint,
  type BelaboxStreamSession,
  type BelaboxStreamStateSnapshot,
  sameBelaboxStreamStateSnapshot,
} from "./adapters/d1";
import { fetchRelaySample } from "./adapters/stats-client";
import {
  droppedPacketDelta,
  elapsedSampleSeconds,
  minuteAtForSample,
} from "./domain/history";
import {
  advanceAlert,
  createInitialAlertState,
  settleAlertChat,
  type BelaboxAlertChatOutput,
  type BelaboxAlertDiagnostic,
  type BelaboxAlertState,
} from "./domain/alert";
import { validateBelaboxStatsUrl } from "./domain/stats-url";
import { enrichBelaboxSample, resolvedBelaboxPhase } from "./domain/presentation";

const LIVE_BUFFER_MS = 10 * 60_000;
const LIVE_BUFFER_MAX_POINTS = 120;
const FETCH_FAILURE_THRESHOLD = 3;
const INFRASTRUCTURE_RETRY_MAX_MS = 60_000;

/** Sets fresh chat templates to the channel language whenever BELABOX is enabled. */
export const belaboxAlertDefaultsOnEnable = async (
  context: ModuleEnableContext,
  channelId: string,
): Promise<readonly D1PreparedStatement[]> => {
  const channel = await context.DB.prepare("SELECT language FROM channels WHERE channel_id = ?")
    .bind(channelId).first<{ language: string }>();
  const language: ModuleLanguage = channel?.language === "en" ? "en" : "de";
  const defaults = belaboxDefaultAlertTexts(language);
  const authorization = context.authorizeMutation(channelId, context.actor, context.now);
  return [context.DB.prepare(
    `UPDATE channel_modules
        SET settings = json_set(settings, '$.lowText', ?, '$.disconnectText', ?, '$.recoveryText', ?),
            revision = revision + 1
      WHERE channel_id = ? AND module_id = 'belabox' AND enabled = 1 ${authorization.sql}`,
  ).bind(defaults.lowText, defaults.disconnectText, defaults.recoveryText, channelId, ...authorization.values)];
};

interface StoredModuleSettings {
  enabled: number;
  settings: string;
  revision: number;
}

interface BelaboxPollScheduleContext {
  schedule: (key: string, deadline: number) => Promise<void>;
}

interface PollingPrerequisites {
  settings: BelaboxSettings | null;
  enabled: boolean;
  mode: BelaboxSettings["mode"] | null;
  moduleRevision: number | null;
  streamState: "online" | "offline" | "unknown";
  streamId: string | null;
  startedAt: string | null;
  streamSnapshot: BelaboxStreamStateSnapshot | null;
  historyIntervalSeconds: number | null;
  secretStored: boolean;
}

export const belaboxSettingsForChannel = async (
  db: D1Database,
  channelId: string,
): Promise<{ enabled: boolean; settings: BelaboxSettings; revision: number } | null> => {
  const row = await db.prepare(
    "SELECT enabled, settings, revision FROM channel_modules WHERE channel_id = ? AND module_id = 'belabox'",
  ).bind(channelId).first<StoredModuleSettings>();
  if (row === null) return null;
  try {
    const settings = belaboxSettingsSchema.safeParse(JSON.parse(row.settings) as unknown);
    return settings.success ? { enabled: row.enabled === 1, settings: settings.data, revision: row.revision } : null;
  } catch {
    return null;
  }
};

const isDesired = (prerequisites: PollingPrerequisites): boolean =>
  prerequisites.settings !== null && prerequisites.secretStored &&
  (prerequisites.settings.mode === "on_demand" || prerequisites.streamState === "online");

const pruneRecent = (recent: readonly BelaboxRecentPoint[], now: number): readonly BelaboxRecentPoint[] => {
  const cutoff = now - LIVE_BUFFER_MS;
  return recent.filter(({ at }) => {
    const timestamp = Date.parse(at);
    return Number.isFinite(timestamp) && timestamp >= cutoff;
  }).slice(-LIVE_BUFFER_MAX_POINTS);
};

const appendRecent = (
  recent: readonly BelaboxRecentPoint[],
  sample: { at: string; bitrateKbps: number; rttMs: number; connected: boolean },
  now: number,
): readonly BelaboxRecentPoint[] => [...pruneRecent(recent, now), {
  at: sample.at,
  bitrateKbps: sample.bitrateKbps,
  rttMs: sample.rttMs,
  connected: sample.connected,
}].slice(-LIVE_BUFFER_MAX_POINTS);

const failedPhase = (current: BelaboxFetchPhase): BelaboxFetchPhase => {
  const consecutiveFailures = current.consecutiveFailures + 1;
  return { consecutiveFailures, failing: current.failing || consecutiveFailures >= FETCH_FAILURE_THRESHOLD };
};

const phaseDiagnostic = (
  result: BelaboxFetchResult,
  previous: BelaboxFetchPhase,
  next: BelaboxFetchPhase,
): ModuleDiagnostic | null => !result.ok && !previous.failing && next.failing
  ? { code: "belabox.fetch_failing", detail: { reason: result.reason } }
  : result.ok && previous.failing
    ? { code: "belabox.fetch_recovered", detail: { reason: "fetch_succeeded" } }
    : null;

const writePollDiagnostics = async (
  writer: ModuleAlarmContext["writeDiagnostics"],
  triggerId: string,
  result: BelaboxFetchResult,
  previous: BelaboxFetchPhase,
  next: BelaboxFetchPhase,
  classified: boolean,
  alertDiagnostic: BelaboxAlertDiagnostic | null,
): Promise<void> => {
  const diagnostics = [
    ...(classified ? [phaseDiagnostic(result, previous, next)].filter((item) => item !== null) : []),
    ...(alertDiagnostic === null ? [] : [alertDiagnostic]),
  ];
  if (writer === undefined || diagnostics.length === 0) return;
  try {
    await writer(triggerId, diagnostics, new Date().toISOString());
  } catch {
    // Event-log failures do not turn provider failures into request or alarm failures.
  }
};

const retryDelay = (settings: BelaboxSettings | null): number =>
  settings === null ? INFRASTRUCTURE_RETRY_MAX_MS : Math.min(settings.intervalSeconds * 1_000, INFRASTRUCTURE_RETRY_MAX_MS);

/** Moves the poll alarm to now without making a stop decision from a stale caller context. */
export const ensureBelaboxPoll = async (context: BelaboxPollScheduleContext): Promise<void> => {
  await context.schedule(BELABOX_POLL_ALARM_KEY, Date.now());
};

const usableSecret = async (secrets: Pick<ModuleSecretAccess, "readWithVersion">): Promise<{
  url: URL;
  publisherKey: string;
  version: string;
} | null> => {
  const stored = await secrets.readWithVersion(BELABOX_STATS_URL_SECRET);
  if (stored === null) return null;
  const validated = validateBelaboxStatsUrl(stored.value);
  return validated.ok ? { ...validated, version: stored.version } : null;
};

interface AlarmPrerequisites extends PollingPrerequisites {
  secret: Awaited<ReturnType<typeof usableSecret>>;
  secretUnavailable: boolean;
  secretReadFailed: boolean;
}

const alarmPrerequisites = async (
  context: ModuleAlarmContext,
  requiredMode: BelaboxSettings["mode"] | null = "interval",
): Promise<AlarmPrerequisites> => {
  const [moduleState, streamSnapshot] = await Promise.all([
    belaboxSettingsForChannel(context.DB, context.channelId),
    getBelaboxStreamStateSnapshot(context.DB, context.channelId),
  ]);
  const streamState: PollingPrerequisites["streamState"] = streamSnapshot?.state === "online" || streamSnapshot?.state === "offline"
    ? streamSnapshot.state
    : "unknown";
  const settings = moduleState?.enabled === true && (requiredMode === null || moduleState.settings.mode === requiredMode)
    ? moduleState.settings
    : null;
  const moduleRevision: number | null = moduleState?.revision ?? await context.DB.prepare(
    "SELECT revision FROM channel_modules WHERE channel_id = ? AND module_id = 'belabox'",
  ).bind(context.channelId).first<{ revision: number }>().then((row) => row?.revision ?? null);
  const state = {
    settings,
    enabled: moduleState?.enabled === true,
    mode: moduleState?.settings.mode ?? null,
    moduleRevision,
    streamState,
    streamId: streamSnapshot?.streamId ?? null,
    startedAt: streamSnapshot?.startedAt ?? null,
    streamSnapshot,
    historyIntervalSeconds: moduleState?.settings.intervalSeconds ?? null,
  };
  if (settings === null || settings.mode === "interval" && streamState !== "online") {
    return { ...state, secretStored: false, secret: null, secretUnavailable: false, secretReadFailed: false };
  }
  let secret: Awaited<ReturnType<typeof usableSecret>>;
  try {
    secret = await usableSecret(context.secrets);
  } catch {
    return { ...state, secretStored: false, secret: null, secretUnavailable: false, secretReadFailed: true };
  }
  return {
    ...state,
    secretStored: secret !== null,
    secret,
    secretUnavailable: secret === null,
    secretReadFailed: false,
  };
};

const streamSessionFromSnapshot = (snapshot: BelaboxStreamStateSnapshot | null): BelaboxStreamSession | null =>
  snapshot !== null && (snapshot.state === "online" || snapshot.state === "offline")
    ? { state: snapshot.state, changedAt: snapshot.changedAt, startedAt: snapshot.startedAt, streamId: snapshot.streamId }
    : null;

const streamChanged = (status: Awaited<ReturnType<typeof getBelaboxStatus>>, prerequisites: AlarmPrerequisites): boolean => {
  if (status === null) return false;
  const session = streamSessionFromSnapshot(prerequisites.streamSnapshot);
  return status.streamId !== null && status.streamId !== prerequisites.streamId ||
    status.belaboxStreamId !== null && status.belaboxStreamId !== prerequisites.streamId ||
    session !== null && !belaboxStatusMatchesSession(status, session);
};

const stopPolling = async (
  context: ModuleAlarmContext,
  prerequisites: AlarmPrerequisites,
  status: Awaited<ReturnType<typeof getBelaboxStatus>>,
): Promise<boolean> => {
  const resetStream = prerequisites.streamState === "offline" || streamChanged(status, prerequisites);
  const hadVisibleState = status !== null && (status.polling || status.sample !== null || status.streamId !== null ||
    status.belaboxStreamId !== null || status.recent.length > 0 || status.alertState.phase !== "ok" || status.fetchPhase.failing);
  const current = await finalizeAndResetBelaboxHistory(
    context.DB,
    context.channelId,
    // An offline stream ended when it went offline, not when this (possibly delayed) alarm runs.
    prerequisites.streamState === "offline" && prerequisites.streamSnapshot !== null &&
      Number.isFinite(Date.parse(prerequisites.streamSnapshot.changedAt))
      ? prerequisites.streamSnapshot.changedAt
      : new Date().toISOString(),
    prerequisites.moduleRevision,
    prerequisites.streamSnapshot,
    {
      finalizeOpen: !prerequisites.enabled || prerequisites.mode !== "interval" ||
        prerequisites.streamState === "offline" || streamChanged(status, prerequisites),
      resetStream,
      stopPolling: true,
      maxBaselineAgeMs: (prerequisites.historyIntervalSeconds ?? 0) * 2_000,
      ...(prerequisites.settings === null ? {} : { lowBitrateKbps: prerequisites.settings.lowBitrateKbps }),
      ...(prerequisites.secretUnavailable ? { errorCode: BELABOX_SECRET_UNAVAILABLE_STATUS_CODE } : {}),
    },
  );
  if (current && hadVisibleState && prerequisites.streamState === "offline") {
    try {
      await context.publishModuleOverlayMessage("state_changed", "belabox.status", {
        reason: "stream.state.changed",
      });
    } catch {
      // Overlay reloads are hints; the status row remains authoritative.
    }
  }
  return current;
};

const ensureLifecycleRevision = async (context: ModuleAlarmContext, current: boolean): Promise<void> => {
  if (!current) await context.schedule(BELABOX_POLL_ALARM_KEY, Date.now());
};

const clearHistoryBaselineForAlarm = async (
  context: ModuleAlarmContext,
  prerequisites: AlarmPrerequisites,
  status: Awaited<ReturnType<typeof getBelaboxStatus>>,
): Promise<void> => {
  if (status === null) return;
  await clearBelaboxHistoryBaseline(
    context.DB,
    context.channelId,
    status.revision,
    prerequisites.moduleRevision,
    prerequisites.streamSnapshot,
  );
};

const reschedulePollAfterFailure = async (
  context: ModuleAlarmContext,
  deadline: number,
  delay: number,
): Promise<void> => {
  try {
    await context.schedule(BELABOX_POLL_ALARM_KEY, Math.max(Date.now(), deadline) + delay);
  } catch {
    throw new Error("BELABOX_POLL_RESCHEDULE_FAILED");
  }
};

type StoredPollOutcome =
  | {
      kind: "stored";
      classified: boolean;
      streamId: string;
      sample: BelaboxSample | null;
      alertState: BelaboxAlertState;
      alertChat: BelaboxAlertChatOutput | null;
      realtimeSample: BelaboxSample | null;
    }
  | { kind: "not_desired" }
  | { kind: "secret_unavailable" }
  | { kind: "stream_changed" }
  | { kind: "secret_changed" }
  | { kind: "conflict" };

export type BelaboxPollInvocation = {
  reason: "check_now" | "on_demand" | "connection_test" | "configuration_changed";
  statsUrl?: string;
};

export type BelaboxPollRoutineResult = BelaboxFetchResult | {
  ok: false;
  reason: "not_configured" | "stream_changed" | BelaboxStatsUrlError;
};

const pollInvocation = (value: unknown): BelaboxPollInvocation | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (record.reason !== "check_now" && record.reason !== "on_demand" &&
      record.reason !== "connection_test" && record.reason !== "configuration_changed") return null;
  return {
    reason: record.reason,
    ...(typeof record.statsUrl === "string" ? { statsUrl: record.statsUrl } : {}),
  };
};

const storePollResult = async (
  context: ModuleAlarmContext,
  result: BelaboxFetchResult,
  secretVersion: string,
  originStreamSnapshot: BelaboxStreamStateSnapshot | null,
  originSession: BelaboxStreamSession | null,
  mode: BelaboxSettings["mode"],
): Promise<StoredPollOutcome> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [prerequisites, currentStatus, currentSession] = await Promise.all([
      alarmPrerequisites(context, mode),
      getBelaboxStatus(context.DB, context.channelId),
      getBelaboxStreamSession(context.DB, context.channelId),
    ]);
    if (prerequisites.secretUnavailable) return { kind: "secret_unavailable" };
    if (!sameBelaboxStreamStateSnapshot(prerequisites.streamSnapshot, originStreamSnapshot) ||
        !sameBelaboxStreamSession(originSession, currentSession)) {
      return { kind: "stream_changed" };
    }
    if (!isDesired(prerequisites) || prerequisites.settings === null || prerequisites.secret === null) {
      return { kind: "not_desired" };
    }
    if (prerequisites.secret.version !== secretVersion) return { kind: "secret_changed" };

    const streamId = prerequisites.streamId;
    const sameStream = originSession === null
      ? currentStatus?.streamId === streamId && currentStatus.streamSessionKey === null
      : belaboxStatusMatchesSession(currentStatus, originSession);
    const previousPhase = sameStream ? currentStatus?.fetchPhase ?? { consecutiveFailures: 0, failing: false }
      : { consecutiveFailures: 0, failing: false };
    const phase = result.ok ? { consecutiveFailures: 0, failing: false } : failedPhase(previousPhase);
    const alreadyClassified = sameStream && streamId !== null && currentStatus?.belaboxStreamId === streamId;
    const classified = mode === "on_demand" || alreadyClassified || result.ok && result.sample.connected && streamId !== null;
    const storedSample = result.ok
      ? enrichBelaboxSample(
        result.sample,
        sameStream ? currentStatus?.sample ?? null : null,
        sameStream,
        classified,
        prerequisites.settings.lowBitrateKbps,
      )
      : null;
    const now = Date.now();
    const recent = sameStream ? pruneRecent(currentStatus?.recent ?? [], now) : [];
    const nextRecent = mode === "interval" && result.ok && classified
      ? appendRecent(recent, result.sample, now)
      : recent;
    const priorSample = currentStatus !== null && alreadyClassified &&
      currentStatus.historyModuleRevision === prerequisites.moduleRevision
      ? currentStatus.historySample
      : null;
    const priorSampleAt = priorSample === null ? Number.NaN : Date.parse(priorSample.at);
    const historyAge = Date.now() - priorSampleAt;
    const historyGap = priorSample === null || !Number.isFinite(priorSampleAt) || historyAge < 0 ||
      historyAge > prerequisites.settings.intervalSeconds * 2_000;
    const previousSample = historyGap ? null : priorSample;
    const minuteAt = result.ok && classified ? minuteAtForSample(result.sample.at) : null;
    const elapsedSeconds = result.ok ? elapsedSampleSeconds(previousSample, result.sample) : 0;
    let droppedDelta = 0;
    if (result.ok && result.sample.connected && streamId !== null) {
      if (previousSample?.connected === true) {
        droppedDelta = droppedPacketDelta(result.sample, previousSample);
      } else if (previousSample === null) {
        const summaryExists = await belaboxStreamExists(context.DB, context.channelId, streamId);
        if (!summaryExists) {
          droppedDelta = result.sample.droppedPackets;
        }
      }
    }
    const history = result.ok && classified && minuteAt !== null && streamId !== null
      ? {
        streamId,
        startedAt: prerequisites.startedAt ?? result.sample.at,
        minuteAt,
        droppedDelta,
        lowSeconds: previousSample?.connected === true && previousSample.bitrateKbps < prerequisites.settings.lowBitrateKbps
          ? elapsedSeconds
          : 0,
        disconnectedSeconds: previousSample?.connected === false ? elapsedSeconds : 0,
        disconnectCount: previousSample?.connected === true && !result.sample.connected ? 1 : 0,
      }
      : undefined;
    const historySample = result.ok ? result.sample : null;
    const previousAlert = sameStream ? currentStatus?.alertState ?? createInitialAlertState() : createInitialAlertState();
    const alert = mode === "interval" && classified && prerequisites.settings.alertsEnabled
      ? advanceAlert(previousAlert, result.ok ? result.sample : {
        kind: "fetch_error",
        at: new Date(now).toISOString(),
        reason: result.reason,
      }, prerequisites.settings, now)
      : {
        state: mode === "on_demand" && sameStream ? previousAlert : createInitialAlertState(),
        outputs: { phaseChange: null, chat: null },
      };
    const previousStreamFinalizers = mode === "interval" && streamId !== null
      ? await prepareBelaboxHistoryFinalizers(
        context.DB,
        context.channelId,
        result.ok ? result.sample.at : new Date(now).toISOString(),
        prerequisites.moduleRevision,
        prerequisites.streamSnapshot,
        {
          maxBaselineAgeMs: prerequisites.settings.intervalSeconds * 2_000,
          lowBitrateKbps: prerequisites.settings.lowBitrateKbps,
          excludeStreamId: streamId,
          expectedStatusRevision: currentStatus?.revision ?? null,
          expectedStatusStreamId: currentStatus?.streamId ?? null,
          expectedStatusSessionKey: currentStatus?.streamSessionKey ?? null,
          expectedSecretVersion: secretVersion,
          expectedModuleMode: mode,
        },
      )
      : [];
    const written = await writeBelaboxFetch(context.DB, {
      channelId: context.channelId,
      sample: storedSample,
      errorCode: result.ok ? null : result.reason,
      polling: mode === "interval" || currentStatus?.polling === true,
      streamId,
      streamSessionKey: belaboxStreamSessionKey(originSession),
      belaboxStreamId: classified ? streamId : null,
      fetchPhase: phase,
      alertState: alert.state,
      recent: nextRecent,
      expectedSecretVersion: secretVersion,
      expectedStatusRevision: currentStatus?.revision ?? null,
      expectedStreamSession: originSession,
      expectedModuleRevision: prerequisites.moduleRevision,
      expectedModuleMode: mode,
      expectedStreamSnapshot: prerequisites.streamSnapshot,
      beforeSampleWrites: previousStreamFinalizers,
      resetHistoryBaseline: history === undefined,
      historyModuleRevision: prerequisites.moduleRevision,
      ...(history === undefined ? {} : { history, historySample }),
    });
    if (written !== null) {
      await writePollDiagnostics(
        context.writeDiagnostics,
        `belabox:poll:${streamId ?? "unknown"}`,
        result,
        previousPhase,
        phase,
        classified,
        classified ? alert.outputs.phaseChange : null,
      );
      const storedAttempt = storedSample !== null && written.sample !== null &&
        JSON.stringify(written.sample) === JSON.stringify(storedSample) ? written.sample : null;
      const previousRealtime = currentStatus?.sample;
      const realtimeSample = storedAttempt !== null && (
        previousRealtime === null || previousRealtime === undefined ||
        previousRealtime.at !== storedAttempt.at ||
        previousRealtime.connected !== storedAttempt.connected ||
        previousRealtime.bitrateKbps !== storedAttempt.bitrateKbps ||
        previousRealtime.rttMs !== storedAttempt.rttMs ||
        previousRealtime.phase !== storedAttempt.phase
      ) ? storedAttempt : null;
      return {
        kind: "stored",
        classified,
        streamId: streamId ?? "",
        sample: written.sample,
        alertState: alert.state,
        alertChat: alert.outputs.chat,
        realtimeSample,
      };
    }
  }
  return { kind: "conflict" };
};

const alertTextFor = (settings: BelaboxSettings, output: BelaboxAlertChatOutput): {
  text: string;
  target: BelaboxSettings["lowTarget"];
} => output.kind === "low"
  ? { text: settings.lowText, target: settings.lowTarget }
  : output.kind === "disconnect"
    ? { text: settings.disconnectText, target: settings.disconnectTarget }
    : { text: settings.recoveryText, target: settings.recoveryTarget };

const sendPendingAlert = async (
  context: ModuleAlarmContext,
  streamId: string,
  expectedSession: BelaboxStreamSession | null,
  expectedSnapshot: BelaboxStreamStateSnapshot | null,
  output: BelaboxAlertChatOutput | null,
  sample: BelaboxFetchResult,
): Promise<void> => {
  if (output === null || !sample.ok || sample.sample.at.length === 0) return;
  const moduleState = await belaboxSettingsForChannel(context.DB, context.channelId);
  if (moduleState?.enabled !== true || !moduleState.settings.alertsEnabled || !moduleState.settings.chatEnabled) return;
  const [status, currentSnapshot] = await Promise.all([
    getBelaboxStatus(context.DB, context.channelId),
    getBelaboxStreamStateSnapshot(context.DB, context.channelId),
  ]);
  if (status === null || status.streamId !== streamId || status.belaboxStreamId !== streamId ||
      status.streamSessionKey !== belaboxStreamSessionKey(expectedSession) ||
      !sameBelaboxStreamStateSnapshot(currentSnapshot, expectedSnapshot)) return;
  const settings = moduleState.settings;
  const message = alertTextFor(settings, output);
  const startedAt = Date.parse(output.episodeStartedAt);
  const downForSeconds = Math.max(0, Math.floor((Date.parse(sample.sample.at) - startedAt) / 1_000));
  const rendered = await context.renderTemplate(message.text, {
    "belabox.bitrate": `${Math.round(sample.sample.bitrateKbps).toLocaleString("en-US")} kbps`,
    "belabox.down_for": `${String(downForSeconds)} s`,
  }, Date.parse(sample.sample.at));
  const idempotencyKey = `belabox:${streamId}:${output.episodeStartedAt}:${output.idempotencyKind}`;
  const result = await context.sendChat(rendered.text, idempotencyKey, rendered.attributions, async () => {
    const [currentModule, currentStatus, live, currentSession, currentSnapshot] = await Promise.all([
      belaboxSettingsForChannel(context.DB, context.channelId),
      getBelaboxStatus(context.DB, context.channelId),
      context.streamStartedAt(),
      getBelaboxStreamSession(context.DB, context.channelId),
      getBelaboxStreamStateSnapshot(context.DB, context.channelId),
    ]);
    if (currentModule?.enabled !== true || !currentModule.settings.alertsEnabled || !currentModule.settings.chatEnabled ||
        live.streamId !== streamId || currentStatus?.streamId !== streamId || currentStatus.belaboxStreamId !== streamId ||
        currentStatus.streamSessionKey !== belaboxStreamSessionKey(expectedSession) ||
        !sameBelaboxStreamSession(expectedSession, currentSession) ||
        !sameBelaboxStreamStateSnapshot(currentSnapshot, expectedSnapshot)) return false;
    if (output.validPhase === "alarm") {
      return currentStatus.alertState.phase === "alarm" && currentStatus.alertState.kind === output.alertKind &&
        currentStatus.alertState.episodeStartedAt === output.episodeStartedAt;
    }
    return currentStatus.alertState.phase === "ok" && currentStatus.alertState.completedEpisodeAt === output.episodeStartedAt;
  }, message.target);
  if (result.sent || !result.retryable) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const latest = await getBelaboxStatus(context.DB, context.channelId);
      if (latest?.alertState.pendingChat?.idempotencyKind !== output.idempotencyKind ||
          latest.alertState.pendingChat.episodeStartedAt !== output.episodeStartedAt) return;
      const next = settleAlertChat(latest.alertState, { sent: result.sent, retryable: result.retryable }, Date.now());
      if (await writeBelaboxAlertState(context.DB, context.channelId, next, latest.revision) !== null) return;
    }
  }
};

/** The single serialized BELABOX fetch and sample-write routine used by alarms and requests. */
export const handleBelaboxPollAlarm = async (
  context: ModuleAlarmContext,
  alarmKey: string,
  deadline: number,
  _ownerRevision?: number,
  fetcher: typeof fetch = fetch,
  rawInvocation?: unknown,
): Promise<BelaboxPollRoutineResult | undefined> => {
  if (alarmKey !== BELABOX_POLL_ALARM_KEY) return;
  const invocation = pollInvocation(rawInvocation);
  const reason = invocation?.reason ?? "alarm";
  if (reason === "connection_test") {
    const statsUrl = invocation?.statsUrl;
    if (statsUrl === undefined) return { ok: false, reason: "not_configured" };
    const validated = validateBelaboxStatsUrl(statsUrl);
    if (!validated.ok) return { ok: false, reason: validated.reason };
    return await fetchRelaySample(
      validated.url,
      validated.publisherKey,
      context.externalFetchBudget ?? { claim: () => true },
      fetcher,
    );
  }

  const requiredMode = reason === "on_demand" ? "on_demand" : reason === "check_now" ? null : "interval";
  if (reason === "on_demand") {
    const [cachedStatus, cachedSession] = await Promise.all([
      getBelaboxStatus(context.DB, context.channelId),
      getBelaboxStreamSession(context.DB, context.channelId),
    ]);
    const sampledAt = cachedStatus?.sample === null || cachedStatus?.sample === undefined
      ? Number.NaN
      : Date.parse(cachedStatus.sample.at);
    const age = Date.now() - sampledAt;
    if (cachedStatus?.sample !== null && cachedStatus?.sample !== undefined && cachedStatus.errorCode === null &&
        belaboxStatusMatchesSession(cachedStatus, cachedSession) && Number.isFinite(age) && age >= 0 &&
        age < BELABOX_ON_DEMAND_CACHE_MS) {
      return { ok: true, sample: cachedStatus.sample };
    }
  }

  let delay = INFRASTRUCTURE_RETRY_MAX_MS;
  let pollMode: BelaboxSettings["mode"] = "interval";
  try {
    if (reason === "configuration_changed") {
      const [prerequisites, currentStatus] = await Promise.all([
        alarmPrerequisites(context, null),
        getBelaboxStatus(context.DB, context.channelId),
      ]);
      if (currentStatus !== null) {
        const cleared = await clearBelaboxSampleForPoll(
          context.DB,
          context.channelId,
          currentStatus.revision,
          prerequisites.streamSnapshot,
        );
        if (!cleared) await context.schedule(BELABOX_POLL_ALARM_KEY, Date.now());
      }
      return;
    }
    const prerequisites = await alarmPrerequisites(context, requiredMode);
    delay = retryDelay(prerequisites.settings);
    if (prerequisites.secretReadFailed) {
      await finalizeAndResetBelaboxHistory(
        context.DB,
        context.channelId,
        new Date().toISOString(),
        prerequisites.moduleRevision,
        prerequisites.streamSnapshot,
        {
          finalizeOpen: false,
          stopPolling: false,
          maxBaselineAgeMs: (prerequisites.historyIntervalSeconds ?? 0) * 2_000,
        },
      );
      if (reason !== "on_demand") await reschedulePollAfterFailure(context, deadline, delay);
      return reason === "alarm" ? undefined : { ok: false, reason: "network" };
    }
    const status = await getBelaboxStatus(context.DB, context.channelId);
    if (!isDesired(prerequisites) || prerequisites.settings === null || prerequisites.secret === null) {
      await ensureLifecycleRevision(context, await stopPolling(context, prerequisites, status));
      return reason === "alarm" ? undefined : { ok: false, reason: "not_configured" };
    }
    pollMode = prerequisites.settings.mode;
    if (pollMode === "interval") {
      if (prerequisites.moduleRevision !== null) {
        await reopenCurrentBelaboxStream(context.DB, context.channelId, prerequisites.moduleRevision);
      }
      await markBelaboxPollingStarted(context.DB, context.channelId);
    }
    const originSession = streamSessionFromSnapshot(prerequisites.streamSnapshot);
    const result = await fetchRelaySample(
      prerequisites.secret.url,
      prerequisites.secret.publisherKey,
      context.externalFetchBudget ?? { claim: () => true },
      fetcher,
    );
    const stored = await storePollResult(
      context,
      result,
      prerequisites.secret.version,
      prerequisites.streamSnapshot,
      originSession,
      pollMode,
    );

    const latest = await alarmPrerequisites(context, requiredMode);
    if (latest.secretReadFailed) {
      await finalizeAndResetBelaboxHistory(
        context.DB,
        context.channelId,
        new Date().toISOString(),
        latest.moduleRevision,
        latest.streamSnapshot,
        {
          finalizeOpen: false,
          stopPolling: false,
          maxBaselineAgeMs: (latest.historyIntervalSeconds ?? 0) * 2_000,
        },
      );
      if (pollMode === "interval") await reschedulePollAfterFailure(context, deadline, retryDelay(latest.settings));
      return reason === "alarm" ? undefined : { ok: false, reason: "network" };
    }
    const latestStatus = await getBelaboxStatus(context.DB, context.channelId);
    if (!isDesired(latest) || latest.settings === null || latest.secret === null) {
      await ensureLifecycleRevision(context, await stopPolling(context, latest, latestStatus));
      return reason === "alarm" ? undefined : { ok: false, reason: "not_configured" };
    }
    delay = retryDelay(latest.settings);
    if (streamChanged(latestStatus, latest)) {
      const current = await finalizeAndResetBelaboxHistory(
        context.DB,
        context.channelId,
        new Date().toISOString(),
        latest.moduleRevision,
        latest.streamSnapshot,
        {
          resetStream: true,
          maxBaselineAgeMs: (latest.historyIntervalSeconds ?? 0) * 2_000,
        },
      );
      await ensureLifecycleRevision(context, current);
      if (current && pollMode === "interval") await context.schedule(BELABOX_POLL_ALARM_KEY, Date.now());
      return reason === "alarm" ? undefined : { ok: false, reason: "stream_changed" };
    }
    if (stored.kind === "stream_changed") {
      if (pollMode === "interval") await context.schedule(BELABOX_POLL_ALARM_KEY, Date.now());
      return reason === "alarm" ? undefined : { ok: false, reason: "stream_changed" };
    }
    if (stored.kind === "secret_unavailable") {
      const current = await finalizeAndResetBelaboxHistory(
        context.DB,
        context.channelId,
        new Date().toISOString(),
        latest.moduleRevision,
        latest.streamSnapshot,
        {
          finalizeOpen: false,
          stopPolling: false,
          maxBaselineAgeMs: (latest.historyIntervalSeconds ?? 0) * 2_000,
        },
      );
      await ensureLifecycleRevision(context, current);
      if (current && pollMode === "interval") await context.schedule(BELABOX_POLL_ALARM_KEY, Date.now());
      return reason === "alarm" ? undefined : { ok: false, reason: "not_configured" };
    }
    if (stored.kind === "not_desired") {
      await clearHistoryBaselineForAlarm(context, latest, latestStatus);
      if (pollMode === "interval") await context.schedule(BELABOX_POLL_ALARM_KEY, Date.now());
      return reason === "alarm" ? undefined : { ok: false, reason: "not_configured" };
    }
    if (stored.kind === "conflict") {
      await clearHistoryBaselineForAlarm(context, latest, latestStatus);
      if (pollMode === "interval") await context.schedule(BELABOX_POLL_ALARM_KEY, Math.max(Date.now(), deadline) + delay);
      return reason === "alarm" ? undefined : { ok: false, reason: "stream_changed" };
    }
    if (stored.kind === "secret_changed" || latest.secret.version !== prerequisites.secret.version) {
      await clearHistoryBaselineForAlarm(context, latest, latestStatus);
      if (pollMode === "interval") await context.schedule(BELABOX_POLL_ALARM_KEY, Date.now());
      return reason === "alarm" ? undefined : { ok: false, reason: "not_configured" };
    }
    if (pollMode === "interval" && stored.realtimeSample !== null &&
        typeof context.publishModuleOverlayMessage === "function") {
      const sample = stored.realtimeSample;
      await context.publishModuleOverlayMessage("sample", "belabox.status", {
        at: sample.at,
        connected: sample.connected,
        bitrateKbps: sample.bitrateKbps,
        rttMs: sample.rttMs,
        phase: resolvedBelaboxPhase(
          sample,
          stored.classified,
          latest.settings.lowBitrateKbps,
          stored.alertState,
        ),
        streamSessionKey: belaboxStreamSessionKey(originSession),
      });
    }
    if (pollMode === "interval" && stored.classified) {
      await sendPendingAlert(
        context,
        stored.streamId,
        originSession,
        prerequisites.streamSnapshot,
        stored.alertChat,
        result,
      );
    }
    if (pollMode === "interval") {
      const interval = stored.classified
        ? latest.settings.intervalSeconds * 1_000
        : BELABOX_PROBE_INTERVAL_MS;
      await context.schedule(BELABOX_POLL_ALARM_KEY, Math.max(Date.now(), deadline) + interval);
    }
    return reason === "alarm"
      ? undefined
      : result.ok && stored.sample !== null
        ? { ok: true, sample: stored.sample }
        : result;
  } catch {
    if (pollMode === "interval") {
      try {
        const [current, currentStatus] = await Promise.all([
          alarmPrerequisites(context, requiredMode),
          getBelaboxStatus(context.DB, context.channelId),
        ]);
        await clearHistoryBaselineForAlarm(context, current, currentStatus);
      } catch {
        // Keep retrying if the status store itself is temporarily unavailable.
      }
      await reschedulePollAfterFailure(context, deadline, delay);
    }
    return reason === "alarm" ? undefined : { ok: false, reason: "network" };
  }
};

/** Ensures the poll alarm after activation or host schedule-input changes. */
export const ensureBelaboxPollSchedule = async (
  context: ModuleAlarmContext,
  reason: "event_times" | "channel_time_zone" | "activation",
): Promise<void> => {
  void reason;
  await ensureBelaboxPoll(context);
};
