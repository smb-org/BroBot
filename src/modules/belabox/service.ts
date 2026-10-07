import type {
  ModuleAlarmContext,
  ModuleDiagnostic,
  ModuleExternalFetchBudget,
  ModuleSecretAccess,
} from "../contract";
import {
  BELABOX_ON_DEMAND_CACHE_MS,
  BELABOX_POLL_ALARM_KEY,
  BELABOX_PROBE_INTERVAL_MS,
  BELABOX_SECRET_UNAVAILABLE_STATUS_CODE,
  BELABOX_STATS_URL_SECRET,
  belaboxSettingsSchema,
  type BelaboxFetchResult,
  type BelaboxSettings,
} from "./contracts";
import {
  belaboxStreamExists,
  clearBelaboxHistoryBaseline,
  finalizeAndResetBelaboxHistory,
  getBelaboxStreamStateSnapshot,
  getBelaboxStatus,
  reopenCurrentBelaboxStream,
  markBelaboxPollingStarted,
  writeBelaboxFetch,
  type BelaboxFetchPhase,
  type BelaboxRecentPoint,
  type BelaboxStreamStateSnapshot,
  sameBelaboxStreamStateSnapshot,
} from "./adapters/d1";
import { fetchRelaySample } from "./adapters/stats-client";
import {
  BELABOX_LOW_BITRATE_KBPS,
  droppedPacketDelta,
  elapsedSampleSeconds,
  minuteAtForSample,
} from "./domain/history";
import { validateBelaboxStatsUrl } from "./domain/stats-url";

const LIVE_BUFFER_MS = 10 * 60_000;
const LIVE_BUFFER_MAX_POINTS = 120;
const FETCH_FAILURE_THRESHOLD = 3;
const INFRASTRUCTURE_RETRY_MAX_MS = 60_000;

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
  prerequisites.settings !== null && prerequisites.secretStored && prerequisites.streamState === "online";

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

const writePhaseDiagnostic = async (
  writer: ModuleAlarmContext["writeDiagnostics"],
  triggerId: string,
  result: BelaboxFetchResult,
  previous: BelaboxFetchPhase,
  next: BelaboxFetchPhase,
): Promise<void> => {
  const diagnostic = phaseDiagnostic(result, previous, next);
  if (writer === undefined || diagnostic === null) return;
  try {
    await writer(triggerId, [diagnostic], new Date().toISOString());
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

const usableSecret = async (secrets: ModuleSecretAccess): Promise<{
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

const alarmPrerequisites = async (context: ModuleAlarmContext): Promise<AlarmPrerequisites> => {
  const [moduleState, streamSnapshot] = await Promise.all([
    belaboxSettingsForChannel(context.DB, context.channelId),
    getBelaboxStreamStateSnapshot(context.DB, context.channelId),
  ]);
  const streamState: PollingPrerequisites["streamState"] = streamSnapshot?.state === "online" || streamSnapshot?.state === "offline"
    ? streamSnapshot.state
    : "unknown";
  const settings = moduleState?.enabled === true && moduleState.settings.mode === "interval"
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
  if (settings === null || streamState !== "online") {
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

const streamChanged = (status: Awaited<ReturnType<typeof getBelaboxStatus>>, prerequisites: AlarmPrerequisites): boolean =>
  status !== null && (
    status.streamId !== null && status.streamId !== prerequisites.streamId ||
    status.belaboxStreamId !== null && status.belaboxStreamId !== prerequisites.streamId
  );

const stopPolling = async (
  context: ModuleAlarmContext,
  prerequisites: AlarmPrerequisites,
  status: Awaited<ReturnType<typeof getBelaboxStatus>>,
): Promise<boolean> => finalizeAndResetBelaboxHistory(
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
      resetStream: prerequisites.streamState === "offline" || streamChanged(status, prerequisites),
      stopPolling: true,
      maxBaselineAgeMs: (prerequisites.historyIntervalSeconds ?? 0) * 2_000,
      ...(prerequisites.secretUnavailable ? { errorCode: BELABOX_SECRET_UNAVAILABLE_STATUS_CODE } : {}),
    },
  );

const ensureLifecycleRevision = async (context: ModuleAlarmContext, current: boolean): Promise<void> => {
  if (!current) await context.schedule(BELABOX_POLL_ALARM_KEY, Date.now());
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
  | { kind: "stored"; classified: boolean }
  | { kind: "not_desired" }
  | { kind: "secret_unavailable" }
  | { kind: "stream_changed" }
  | { kind: "secret_changed" }
  | { kind: "conflict" };

const storePollResult = async (
  context: ModuleAlarmContext,
  result: BelaboxFetchResult,
  secretVersion: string,
  originStreamSnapshot: BelaboxStreamStateSnapshot | null,
): Promise<StoredPollOutcome> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [prerequisites, currentStatus] = await Promise.all([
      alarmPrerequisites(context),
      getBelaboxStatus(context.DB, context.channelId),
    ]);
    if (prerequisites.secretUnavailable) return { kind: "secret_unavailable" };
    if (!sameBelaboxStreamStateSnapshot(prerequisites.streamSnapshot, originStreamSnapshot)) {
      return { kind: "stream_changed" };
    }
    if (!isDesired(prerequisites) || prerequisites.settings === null || prerequisites.secret === null) {
      return { kind: "not_desired" };
    }
    if (prerequisites.secret.version !== secretVersion) return { kind: "secret_changed" };

    const streamId = prerequisites.streamId;
    const sameStream = currentStatus?.streamId === streamId;
    const previousPhase = sameStream ? currentStatus.fetchPhase
      : { consecutiveFailures: 0, failing: false };
    const phase = result.ok ? { consecutiveFailures: 0, failing: false } : failedPhase(previousPhase);
    const alreadyClassified = sameStream && streamId !== null && currentStatus.belaboxStreamId === streamId;
    const classified = alreadyClassified || result.ok && result.sample.connected && streamId !== null;
    const now = Date.now();
    const recent = sameStream ? pruneRecent(currentStatus.recent, now) : [];
    const nextRecent = result.ok && classified ? appendRecent(recent, result.sample, now) : recent;
    const priorSample = alreadyClassified && currentStatus.historyModuleRevision === prerequisites.moduleRevision
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
    const history = result.ok && classified && minuteAt !== null
      ? {
        streamId,
        startedAt: prerequisites.startedAt ?? result.sample.at,
        minuteAt,
        droppedDelta,
        lowSeconds: previousSample?.connected === true && previousSample.bitrateKbps < BELABOX_LOW_BITRATE_KBPS
          ? elapsedSeconds
          : 0,
        disconnectedSeconds: previousSample?.connected === false ? elapsedSeconds : 0,
        disconnectCount: previousSample?.connected === true && !result.sample.connected ? 1 : 0,
      }
      : undefined;
    const historySample = result.ok ? result.sample : null;
    const written = await writeBelaboxFetch(context.DB, {
      channelId: context.channelId,
      sample: result.ok ? result.sample : null,
      errorCode: result.ok ? null : result.reason,
      polling: true,
      streamId,
      belaboxStreamId: classified ? streamId : null,
      fetchPhase: phase,
      recent: nextRecent,
      expectedSecretVersion: secretVersion,
      expectedStatusRevision: currentStatus?.revision ?? null,
      expectedModuleRevision: prerequisites.moduleRevision,
      expectedStreamSnapshot: prerequisites.streamSnapshot,
      resetHistoryBaseline: history === undefined,
      historyModuleRevision: prerequisites.moduleRevision,
      ...(history === undefined ? {} : { history, historySample }),
    });
    if (written !== null) {
      await writePhaseDiagnostic(
        context.writeDiagnostics,
        `belabox:poll:${streamId ?? "unknown"}`,
        result,
        previousPhase,
        phase,
      );
      return { kind: "stored", classified };
    }
  }
  return { kind: "conflict" };
};

/** Runs a poll; infrastructure failures keep a bounded retry alarm and never stop polling. */
export const handleBelaboxPollAlarm = async (
  context: ModuleAlarmContext,
  alarmKey: string,
  deadline: number,
  _ownerRevision?: number,
  fetcher: typeof fetch = fetch,
): Promise<void> => {
  if (alarmKey !== BELABOX_POLL_ALARM_KEY) return;
  let delay = INFRASTRUCTURE_RETRY_MAX_MS;
  try {
    const prerequisites = await alarmPrerequisites(context);
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
      await reschedulePollAfterFailure(context, deadline, delay);
      return;
    }
    const status = await getBelaboxStatus(context.DB, context.channelId);
    if (!isDesired(prerequisites) || prerequisites.settings === null || prerequisites.secret === null) {
      await ensureLifecycleRevision(context, await stopPolling(context, prerequisites, status));
      return;
    }
    if (streamChanged(status, prerequisites)) {
      const current = await finalizeAndResetBelaboxHistory(
        context.DB,
        context.channelId,
        new Date().toISOString(),
        prerequisites.moduleRevision,
        prerequisites.streamSnapshot,
        {
          resetStream: true,
          maxBaselineAgeMs: (prerequisites.historyIntervalSeconds ?? 0) * 2_000,
        },
      );
      if (!current) {
        await context.schedule(BELABOX_POLL_ALARM_KEY, Date.now());
        return;
      }
    }
    if (prerequisites.moduleRevision !== null) {
      await reopenCurrentBelaboxStream(context.DB, context.channelId, prerequisites.moduleRevision);
    }
    await markBelaboxPollingStarted(context.DB, context.channelId);

    const result = await fetchRelaySample(
      prerequisites.secret.url,
      prerequisites.secret.publisherKey,
      context.externalFetchBudget ?? { claim: () => true },
      fetcher,
    );
    const stored = await storePollResult(context, result, prerequisites.secret.version, prerequisites.streamSnapshot);

    const latest = await alarmPrerequisites(context);
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
      await reschedulePollAfterFailure(context, deadline, retryDelay(latest.settings));
      return;
    }
    const latestStatus = await getBelaboxStatus(context.DB, context.channelId);
    if (!isDesired(latest) || latest.settings === null || latest.secret === null) {
      await ensureLifecycleRevision(context, await stopPolling(context, latest, latestStatus));
      return;
    }
    delay = retryDelay(latest.settings);
    if (stored.kind === "stream_changed" || streamChanged(latestStatus, latest)) {
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
      if (current) await context.schedule(BELABOX_POLL_ALARM_KEY, Date.now());
      return;
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
      if (current) await context.schedule(BELABOX_POLL_ALARM_KEY, Date.now());
      return;
    }
    if (stored.kind === "not_desired") {
      await clearBelaboxHistoryBaseline(context.DB, context.channelId);
      await context.schedule(BELABOX_POLL_ALARM_KEY, Date.now());
      return;
    }
    if (stored.kind === "conflict") {
      await clearBelaboxHistoryBaseline(context.DB, context.channelId);
      await context.schedule(BELABOX_POLL_ALARM_KEY, Math.max(Date.now(), deadline) + delay);
      return;
    }
    if (stored.kind === "secret_changed" || latest.secret.version !== prerequisites.secret.version) {
      await clearBelaboxHistoryBaseline(context.DB, context.channelId);
      await context.schedule(BELABOX_POLL_ALARM_KEY, Date.now());
      return;
    }
    const interval = stored.classified
      ? latest.settings.intervalSeconds * 1_000
      : BELABOX_PROBE_INTERVAL_MS;
    await context.schedule(BELABOX_POLL_ALARM_KEY, Math.max(Date.now(), deadline) + interval);
  } catch {
    try {
      await clearBelaboxHistoryBaseline(context.DB, context.channelId);
    } catch {
      // Keep retrying if the status store itself is temporarily unavailable.
    }
    await reschedulePollAfterFailure(context, deadline, delay);
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

export type CurrentBelaboxSampleResult = BelaboxFetchResult | { ok: false; reason: "not_configured" };

/** Returns a fresh on-demand sample, reusing only successful samples younger than ten seconds. */
export const currentBelaboxSample = async (
  context: {
    DB: D1Database;
    channelId: string;
    secrets: ModuleSecretAccess;
    externalFetchBudget: ModuleExternalFetchBudget;
    writeDiagnostics?: NonNullable<ModuleAlarmContext["writeDiagnostics"]>;
  },
  now = Date.now(),
  fetcher: typeof fetch = fetch,
): Promise<CurrentBelaboxSampleResult> => {
  const status = await getBelaboxStatus(context.DB, context.channelId);
  const sampledAt = status?.sample === null || status?.sample === undefined ? Number.NaN : Date.parse(status.sample.at);
  const age = now - sampledAt;
  if (status?.sample !== null && status?.sample !== undefined && Number.isFinite(age) && age >= 0 && age < BELABOX_ON_DEMAND_CACHE_MS) {
    return { ok: true, sample: status.sample };
  }

  const secret = await usableSecret(context.secrets);
  if (secret === null) return { ok: false, reason: "not_configured" };
  const result = await fetchRelaySample(secret.url, secret.publisherKey, context.externalFetchBudget, fetcher);
  let currentStatus = status;
  for (;;) {
    const moduleState = await belaboxSettingsForChannel(context.DB, context.channelId);
    if (moduleState?.enabled !== true || moduleState.settings.mode !== "on_demand") return result;
    const previousPhase = currentStatus?.fetchPhase ?? { consecutiveFailures: 0, failing: false };
    const phase = result.ok ? { consecutiveFailures: 0, failing: false } : failedPhase(previousPhase);
    const revision = await writeBelaboxFetch(context.DB, {
      channelId: context.channelId,
      sample: result.ok ? result.sample : null,
      errorCode: result.ok ? null : result.reason,
      polling: currentStatus?.polling ?? false,
      streamId: currentStatus?.streamId ?? null,
      belaboxStreamId: currentStatus?.belaboxStreamId ?? null,
      fetchPhase: phase,
      recent: currentStatus?.recent ?? [],
      expectedSecretVersion: secret.version,
      expectedStatusRevision: currentStatus?.revision ?? null,
    });
    if (revision !== null) {
      await writePhaseDiagnostic(
        context.writeDiagnostics,
        "belabox:on_demand",
        result,
        previousPhase,
        phase,
      );
      break;
    }
    const currentSecret = await context.secrets.readWithVersion(BELABOX_STATS_URL_SECRET);
    if (currentSecret?.version !== secret.version) return result;
    currentStatus = await getBelaboxStatus(context.DB, context.channelId);
  }
  return result;
};
