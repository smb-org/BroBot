import type {
  ModuleAlarmContext,
  ModuleDiagnostic,
  ModuleExternalFetchBudget,
  ModuleSecretAccess,
  ModuleSecretReadAccess,
} from "../contract";
import {
  BELABOX_ON_DEMAND_CACHE_MS,
  BELABOX_POLL_ALARM_KEY,
  BELABOX_PROBE_INTERVAL_MS,
  BELABOX_SECRET_UNAVAILABLE_STATUS_CODE,
  BELABOX_STATS_URL_SECRET,
  belaboxSettingsSchema,
  type BelaboxFetchResult,
  type BelaboxSample,
  type BelaboxSettings,
} from "./contracts";
import {
  getBelaboxStatus,
  setBelaboxPollingState,
  writeBelaboxFetch,
  type BelaboxFetchPhase,
  type BelaboxRecentPoint,
} from "./adapters/d1";
import { fetchRelaySample } from "./adapters/stats-client";
import { validateBelaboxStatsUrl } from "./domain/stats-url";
import { enrichBelaboxSample } from "./domain/presentation";

const LIVE_BUFFER_MS = 10 * 60_000;
const LIVE_BUFFER_MAX_POINTS = 120;
const FETCH_FAILURE_THRESHOLD = 3;
const INFRASTRUCTURE_RETRY_MAX_MS = 60_000;

interface StoredModuleSettings {
  enabled: number;
  settings: string;
}

interface BelaboxPollScheduleContext {
  schedule: (key: string, deadline: number) => Promise<void>;
}

interface PollingPrerequisites {
  settings: BelaboxSettings | null;
  streamState: "online" | "offline" | "unknown";
  secretStored: boolean;
}

export const belaboxSettingsForChannel = async (
  db: D1Database,
  channelId: string,
): Promise<{ enabled: boolean; settings: BelaboxSettings } | null> => {
  const row = await db.prepare(
    "SELECT enabled, settings FROM channel_modules WHERE channel_id = ? AND module_id = 'belabox'",
  ).bind(channelId).first<StoredModuleSettings>();
  if (row === null) return null;
  try {
    const settings = belaboxSettingsSchema.safeParse(JSON.parse(row.settings) as unknown);
    return settings.success ? { enabled: row.enabled === 1, settings: settings.data } : null;
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
}

const alarmPrerequisites = async (context: ModuleAlarmContext): Promise<AlarmPrerequisites> => {
  const [moduleState, streamState] = await Promise.all([
    belaboxSettingsForChannel(context.DB, context.channelId),
    context.streamState(),
  ]);
  const settings = moduleState?.enabled === true && moduleState.settings.mode === "interval"
    ? moduleState.settings
    : null;
  if (settings === null || streamState !== "online") {
    return { settings, streamState, secretStored: false, secret: null, secretUnavailable: false };
  }
  let secret: Awaited<ReturnType<typeof usableSecret>>;
  try {
    secret = await usableSecret(context.secrets);
  } catch {
    // Storage failure, not a missing/undecryptable secret (those return null): let the host retry.
    throw new Error("BELABOX_SECRET_READ_FAILED");
  }
  return {
    settings,
    streamState,
    secretStored: secret !== null,
    secret,
    secretUnavailable: secret === null,
  };
};

const stopPolling = async (
  context: ModuleAlarmContext,
  prerequisites: AlarmPrerequisites,
): Promise<void> => {
  await setBelaboxPollingState(
    context.DB,
    context.channelId,
    false,
    prerequisites.streamState === "offline",
    prerequisites.secretUnavailable ? BELABOX_SECRET_UNAVAILABLE_STATUS_CODE : undefined,
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
  | { kind: "stored"; classified: boolean; realtimeSample: BelaboxSample | null }
  | { kind: "not_desired" }
  | { kind: "secret_unavailable" }
  | { kind: "stream_changed" }
  | { kind: "secret_changed" }
  | { kind: "conflict" };

const storePollResult = async (
  context: ModuleAlarmContext,
  result: BelaboxFetchResult,
  secretVersion: string,
  originStreamId: string | null,
): Promise<StoredPollOutcome> => {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const [prerequisites, currentStatus, live] = await Promise.all([
      alarmPrerequisites(context),
      getBelaboxStatus(context.DB, context.channelId),
      context.streamStartedAt(),
    ]);
    if (prerequisites.secretUnavailable) return { kind: "secret_unavailable" };
    if (live.streamId !== originStreamId) return { kind: "stream_changed" };
    if (!isDesired(prerequisites) || prerequisites.settings === null || prerequisites.secret === null) {
      return { kind: "not_desired" };
    }
    if (prerequisites.secret.version !== secretVersion) return { kind: "secret_changed" };

    const streamId = live.streamId;
    const sameStream = currentStatus?.streamId === streamId;
    const previousPhase = sameStream ? currentStatus.fetchPhase
      : { consecutiveFailures: 0, failing: false };
    const phase = result.ok ? { consecutiveFailures: 0, failing: false } : failedPhase(previousPhase);
    const alreadyClassified = sameStream && streamId !== null && currentStatus.belaboxStreamId === streamId;
    const classified = alreadyClassified || result.ok && result.sample.connected && streamId !== null;
    const storedSample = result.ok
      ? enrichBelaboxSample(result.sample, sameStream ? currentStatus.sample : null, sameStream, classified)
      : null;
    const now = Date.now();
    const recent = sameStream ? pruneRecent(currentStatus.recent, now) : [];
    const nextRecent = storedSample !== null && alreadyClassified ? appendRecent(recent, storedSample, now) : recent;
    const written = await writeBelaboxFetch(context.DB, {
      channelId: context.channelId,
      sample: storedSample,
      errorCode: result.ok ? null : result.reason,
      polling: true,
      streamId,
      belaboxStreamId: classified ? streamId : null,
      fetchPhase: phase,
      recent: nextRecent,
      expectedSecretVersion: secretVersion,
      expectedStatusRevision: currentStatus?.revision ?? null,
    });
    if (written !== null) {
      await writePhaseDiagnostic(
        context.writeDiagnostics,
        `belabox:poll:${streamId ?? "unknown"}`,
        result,
        previousPhase,
        phase,
      );
      const previousRealtime = currentStatus?.sample;
      const realtimeSample = storedSample !== null && (
        previousRealtime === null || previousRealtime === undefined ||
        previousRealtime.at !== storedSample.at ||
        previousRealtime.connected !== storedSample.connected ||
        previousRealtime.bitrateKbps !== storedSample.bitrateKbps ||
        previousRealtime.rttMs !== storedSample.rttMs ||
        previousRealtime.phase !== storedSample.phase
      ) ? storedSample : null;
      return { kind: "stored", classified, realtimeSample };
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
    if (!isDesired(prerequisites) || prerequisites.settings === null || prerequisites.secret === null) {
      await stopPolling(context, prerequisites);
      return;
    }
    await setBelaboxPollingState(context.DB, context.channelId, true);
    const originStreamId = (await context.streamStartedAt()).streamId;

    const result = await fetchRelaySample(
      prerequisites.secret.url,
      prerequisites.secret.publisherKey,
      context.externalFetchBudget ?? { claim: () => true },
      fetcher,
    );
    const stored = await storePollResult(context, result, prerequisites.secret.version, originStreamId);

    const latest = await alarmPrerequisites(context);
    if (!isDesired(latest) || latest.settings === null || latest.secret === null) {
      await stopPolling(context, latest);
      return;
    }
    delay = retryDelay(latest.settings);
    if (stored.kind === "secret_unavailable") {
      await setBelaboxPollingState(
        context.DB,
        context.channelId,
        false,
        false,
        BELABOX_SECRET_UNAVAILABLE_STATUS_CODE,
      );
      return;
    }
    if (stored.kind === "not_desired") {
      await context.schedule(BELABOX_POLL_ALARM_KEY, Date.now());
      return;
    }
    if (stored.kind === "stream_changed") {
      await context.schedule(BELABOX_POLL_ALARM_KEY, Date.now());
      return;
    }
    if (stored.kind === "conflict") {
      await context.schedule(BELABOX_POLL_ALARM_KEY, Math.max(Date.now(), deadline) + delay);
      return;
    }
    if (stored.kind === "secret_changed" || latest.secret.version !== prerequisites.secret.version) {
      await context.schedule(BELABOX_POLL_ALARM_KEY, Date.now());
      return;
    }
    if (stored.realtimeSample !== null && typeof context.publishModuleOverlayMessage === "function") {
      const sample = stored.realtimeSample;
      await context.publishModuleOverlayMessage("sample", "belabox.status", {
        at: sample.at,
        connected: sample.connected,
        bitrateKbps: sample.bitrateKbps,
        rttMs: sample.rttMs,
        phase: sample.phase ?? "healthy",
      });
    }
    const interval = stored.classified
      ? latest.settings.intervalSeconds * 1_000
      : BELABOX_PROBE_INTERVAL_MS;
    await context.schedule(BELABOX_POLL_ALARM_KEY, Math.max(Date.now(), deadline) + interval);
  } catch {
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

type CurrentBelaboxSampleContext = {
  DB: D1Database;
  channelId: string;
  secrets: ModuleSecretReadAccess | ModuleSecretAccess;
  externalFetchBudget: ModuleExternalFetchBudget;
  writeDiagnostics?: NonNullable<ModuleAlarmContext["writeDiagnostics"]>;
};

const canWriteCurrentSample = (
  context: CurrentBelaboxSampleContext,
): context is CurrentBelaboxSampleContext & { secrets: ModuleSecretAccess } =>
  "readWithVersion" in context.secrets && typeof context.secrets.readWithVersion === "function";

const readOnlySecret = async (secrets: ModuleSecretReadAccess): Promise<{ url: URL; publisherKey: string } | null> => {
  const stored = await secrets.read(BELABOX_STATS_URL_SECRET);
  if (stored === null) return null;
  const validated = validateBelaboxStatsUrl(stored);
  return validated.ok ? validated : null;
};

/** Returns a fresh on-demand sample, reusing only successful samples younger than ten seconds. */
export const currentBelaboxSample = async (
  context: CurrentBelaboxSampleContext,
  now = Date.now(),
  fetcher: typeof fetch = fetch,
): Promise<CurrentBelaboxSampleResult> => {
  const status = await getBelaboxStatus(context.DB, context.channelId);
  const sampledAt = status?.sample === null || status?.sample === undefined ? Number.NaN : Date.parse(status.sample.at);
  const age = now - sampledAt;
  if (status?.sample !== null && status?.sample !== undefined && status.errorCode === null &&
      Number.isFinite(age) && age >= 0 && age < BELABOX_ON_DEMAND_CACHE_MS) {
    return { ok: true, sample: status.sample };
  }

  if (!canWriteCurrentSample(context)) {
    const secret = await readOnlySecret(context.secrets);
    if (secret === null) return { ok: false, reason: "not_configured" };
    const result = await fetchRelaySample(secret.url, secret.publisherKey, context.externalFetchBudget, fetcher);
    return result.ok
      ? { ok: true, sample: enrichBelaboxSample(result.sample, status?.sample ?? null, true, true) }
      : result;
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
    const storedSample = result.ok
      ? enrichBelaboxSample(result.sample, currentStatus?.sample ?? null, true, true)
      : null;
    const revision = await writeBelaboxFetch(context.DB, {
      channelId: context.channelId,
      sample: storedSample,
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
      return storedSample === null ? result : { ok: true, sample: storedSample };
    }
    const currentSecret = await context.secrets.readWithVersion(BELABOX_STATS_URL_SECRET);
    if (currentSecret?.version !== secret.version) return result;
    currentStatus = await getBelaboxStatus(context.DB, context.channelId);
  }
};
