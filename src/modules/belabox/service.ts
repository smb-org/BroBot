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
  BELABOX_STATS_URL_SECRET,
  belaboxSettingsSchema,
  type BelaboxFetchResult,
  type BelaboxSettings,
} from "./contracts";
import {
  getBelaboxStatus,
  startBelaboxStream,
  stopBelaboxPollingIfCurrent,
  writeBelaboxFetch,
  type BelaboxFetchPhase,
  type BelaboxRecentPoint,
  type BelaboxStatus,
} from "./adapters/d1";
import { fetchRelaySample } from "./adapters/stats-client";
import { validateBelaboxStatsUrl } from "./domain/stats-url";

const LIVE_BUFFER_MS = 10 * 60_000;
const LIVE_BUFFER_MAX_POINTS = 120;
const FETCH_FAILURE_THRESHOLD = 3;

interface StoredModuleSettings {
  enabled: number;
  settings: string;
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

const appendRecent = (
  recent: readonly BelaboxRecentPoint[],
  sample: { at: string; bitrateKbps: number; rttMs: number; connected: boolean },
): readonly BelaboxRecentPoint[] => {
  const sampledAt = Date.parse(sample.at);
  const cutoff = sampledAt - LIVE_BUFFER_MS;
  return [...recent.filter(({ at }) => Date.parse(at) >= cutoff), {
    at: sample.at,
    bitrateKbps: sample.bitrateKbps,
    rttMs: sample.rttMs,
    connected: sample.connected,
  }].slice(-LIVE_BUFFER_MAX_POINTS);
};

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

const safeStop = async (
  context: ModuleAlarmContext,
  expectedPollRevision: number | null,
  resetStream = false,
): Promise<void> => {
  let revision: number | null = null;
  try {
    revision = await stopBelaboxPollingIfCurrent(
      context.DB,
      context.channelId,
      resetStream,
      expectedPollRevision,
    );
  } catch { /* The alarm handler never exposes storage failures. */ }
  if (revision === null) return;
  try { await context.clear(BELABOX_POLL_ALARM_KEY, revision); } catch { /* The alarm handler never exposes scheduling failures. */ }
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

const pollOnce = async (
  context: ModuleAlarmContext,
  status: BelaboxStatus | null,
  streamId: string | null,
  secret: { url: URL; publisherKey: string; version: string },
  fetcher: typeof fetch,
): Promise<{ classified: boolean; ownerRevision: number } | null> => {
  const result = await fetchRelaySample(
    secret.url,
    secret.publisherKey,
    context.externalFetchBudget ?? { claim: () => true },
    fetcher,
  );
  let currentStatus = status;
  const ownerRevision = status?.pollRevision;
  if (ownerRevision === undefined) return null;
  for (;;) {
    const alreadyClassified = streamId !== null && currentStatus?.belaboxStreamId === streamId;
    const previousPhase = currentStatus?.fetchPhase ?? { consecutiveFailures: 0, failing: false };
    const phase = result.ok ? { consecutiveFailures: 0, failing: false } : failedPhase(previousPhase);
    const classified = alreadyClassified || result.ok && result.sample.connected && streamId !== null;
    const recent = result.ok && alreadyClassified
      ? appendRecent(currentStatus?.recent ?? [], result.sample)
      : currentStatus?.recent ?? [];
    const written = await writeBelaboxFetch(context.DB, {
      channelId: context.channelId,
      sample: result.ok ? result.sample : null,
      errorCode: result.ok ? null : result.reason,
      polling: true,
      streamId,
      belaboxStreamId: classified ? streamId : null,
      fetchPhase: phase,
      recent,
      expectedSecretVersion: secret.version,
      expectedStatusRevision: currentStatus?.revision ?? null,
      expectedPollRevision: ownerRevision,
    });
    if (written !== null) {
      await writePhaseDiagnostic(
        context.writeDiagnostics,
        `belabox:poll:${streamId ?? "unknown"}`,
        result,
        previousPhase,
        phase,
      );
      return { classified, ownerRevision: written.pollRevision };
    }
    const [moduleState, streamState, latestStatus, currentSecret] = await Promise.all([
      belaboxSettingsForChannel(context.DB, context.channelId),
      context.streamState(),
      getBelaboxStatus(context.DB, context.channelId),
      context.secrets.readWithVersion(BELABOX_STATS_URL_SECRET),
    ]);
    if (moduleState?.enabled !== true || moduleState.settings.mode !== "interval" || streamState === "offline" ||
        latestStatus?.polling !== true || latestStatus.streamId !== streamId ||
        latestStatus.pollRevision !== ownerRevision || currentSecret?.version !== secret.version) return null;
    currentStatus = latestStatus;
  }
};

const reconcileScheduledPoll = async (
  context: ModuleAlarmContext,
  ownerRevision: number,
  streamId: string | null,
): Promise<BelaboxSettings | null> => {
  const [moduleState, streamState, status] = await Promise.all([
    belaboxSettingsForChannel(context.DB, context.channelId),
    context.streamState(),
    getBelaboxStatus(context.DB, context.channelId),
  ]);
  if (moduleState?.enabled !== true || moduleState.settings.mode !== "interval" ||
      streamState === "offline" || status?.polling !== true) {
    await safeStop(context, status?.pollRevision ?? null, streamState === "offline");
    return null;
  }
  if (status.pollRevision !== ownerRevision || status.streamId !== streamId) {
    try { await context.clear(BELABOX_POLL_ALARM_KEY, ownerRevision); } catch { /* A newer owner keeps its alarm. */ }
    return null;
  }
  return moduleState.settings;
};

/** Runs one background poll. Provider, storage, and scheduling failures never escape to the host alarm retry path. */
export const handleBelaboxPollAlarm = async (
  context: ModuleAlarmContext,
  alarmKey: string,
  deadline: number,
  ownerRevision?: number,
  fetcher: typeof fetch = fetch,
): Promise<void> => {
  if (alarmKey !== BELABOX_POLL_ALARM_KEY) return;
  let observedPollRevision: number | null | undefined;
  try {
    const [moduleState, streamState, status] = await Promise.all([
      belaboxSettingsForChannel(context.DB, context.channelId),
      context.streamState(),
      getBelaboxStatus(context.DB, context.channelId),
    ]);
    observedPollRevision = status?.pollRevision ?? null;
    if (ownerRevision !== undefined && ownerRevision !== status?.pollRevision) return;
    if (moduleState?.enabled !== true || moduleState.settings.mode !== "interval" || streamState === "offline" ||
        streamState === "unknown" && status?.polling !== true) {
      await safeStop(context, observedPollRevision, streamState === "offline");
      return;
    }

    const secret = await usableSecret(context.secrets);
    if (secret === null) {
      await safeStop(context, observedPollRevision);
      return;
    }

    const live = streamState === "online" ? await context.streamStartedAt() : null;
    const streamId = live?.streamId ?? status?.streamId ?? null;
    let currentStatus = status;
    if (streamState === "online" && status?.streamId !== streamId) {
      await startBelaboxStream(context.DB, context.channelId, streamId);
      currentStatus = await getBelaboxStatus(context.DB, context.channelId);
      observedPollRevision = currentStatus?.pollRevision ?? observedPollRevision;
    }

    const polled = await pollOnce(context, currentStatus, streamId, secret, fetcher);
    if (polled === null) return;
    observedPollRevision = polled.ownerRevision;
    const latestSettings = await reconcileScheduledPoll(context, polled.ownerRevision, streamId);
    if (latestSettings === null) return;
    const interval = polled.classified ? latestSettings.intervalSeconds * 1_000 : BELABOX_PROBE_INTERVAL_MS;
    await context.schedule(BELABOX_POLL_ALARM_KEY, Math.max(Date.now(), deadline) + interval, polled.ownerRevision);
    await reconcileScheduledPoll(context, polled.ownerRevision, streamId);
  } catch {
    if (observedPollRevision !== undefined) await safeStop(context, observedPollRevision);
  }
};

/** Arms a missed live-session poll after module activation or a channel pause is lifted. */
export const reconcileBelaboxPollSchedule = async (
  context: ModuleAlarmContext,
  reason: "event_times" | "channel_time_zone" | "activation",
): Promise<void> => {
  if (reason !== "activation") return;
  try {
    const [moduleState, streamState, secretStatus] = await Promise.all([
      belaboxSettingsForChannel(context.DB, context.channelId),
      context.streamState(),
      context.secrets.status(BELABOX_STATS_URL_SECRET),
    ]);
    if (moduleState?.enabled !== true || moduleState.settings.mode !== "interval" ||
        streamState !== "online" || !secretStatus.configured) return;
    const { streamId } = await context.streamStartedAt();
    const revision = await startBelaboxStream(context.DB, context.channelId, streamId);
    await context.schedule(BELABOX_POLL_ALARM_KEY, Date.now(), revision);
  } catch {
    // Reconciliation is opportunistic; the next accepted stream event or route change retries it.
  }
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
      polling: false,
      streamId: currentStatus?.streamId ?? null,
      belaboxStreamId: currentStatus?.belaboxStreamId ?? null,
      fetchPhase: phase,
      recent: currentStatus?.recent ?? [],
      expectedSecretVersion: secret.version,
      expectedStatusRevision: currentStatus?.revision ?? null,
      expectedPollRevision: currentStatus?.pollRevision ?? null,
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
