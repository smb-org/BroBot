import type {
  ModuleAlarmContext,
  ModuleDiagnostic,
  ModuleExternalFetchBudget,
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
  type BelaboxSettings,
} from "./contracts";
import type { ModuleLanguage } from "../contract";
import {
  getBelaboxStatus,
  setBelaboxPollingState,
  writeBelaboxAlertState,
  writeBelaboxFetch,
  type BelaboxFetchPhase,
  type BelaboxRecentPoint,
} from "./adapters/d1";
import { fetchRelaySample } from "./adapters/stats-client";
import {
  advanceAlert,
  createInitialAlertState,
  settleAlertChat,
  type BelaboxAlertChatOutput,
  type BelaboxAlertDiagnostic,
} from "./domain/alert";
import { validateBelaboxStatsUrl } from "./domain/stats-url";

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
    const stored: unknown = JSON.parse(row.settings);
    const settings = belaboxSettingsSchema.safeParse(stored);
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
  | { kind: "stored"; classified: boolean; streamId: string; alertChat: BelaboxAlertChatOutput | null }
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
    const alreadyClassified = sameStream && streamId !== null && currentStatus.belaboxStreamId === streamId;
    const previousPhase = sameStream ? currentStatus.fetchPhase
      : { consecutiveFailures: 0, failing: false };
    const phase = result.ok ? { consecutiveFailures: 0, failing: false } : failedPhase(previousPhase);
    const classified = alreadyClassified || result.ok && result.sample.connected && streamId !== null;
    const now = Date.now();
    const recent = sameStream ? pruneRecent(currentStatus.recent, now) : [];
    const nextRecent = result.ok && alreadyClassified ? appendRecent(recent, result.sample, now) : recent;
    const previousAlert = sameStream ? currentStatus.alertState : createInitialAlertState();
    const alert = classified && prerequisites.settings.alertsEnabled
      ? advanceAlert(previousAlert, result.ok ? result.sample : {
        kind: "fetch_error",
        at: new Date(now).toISOString(),
        reason: result.reason,
      }, prerequisites.settings, now)
      : { state: createInitialAlertState(), outputs: { phaseChange: null, chat: null } };
    const written = await writeBelaboxFetch(context.DB, {
      channelId: context.channelId,
      sample: result.ok ? result.sample : null,
      errorCode: result.ok ? null : result.reason,
      polling: true,
      streamId,
      belaboxStreamId: classified ? streamId : null,
      fetchPhase: phase,
      alertState: alert.state,
      recent: nextRecent,
      expectedSecretVersion: secretVersion,
      expectedStatusRevision: currentStatus?.revision ?? null,
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
      return { kind: "stored", classified, streamId: streamId ?? "", alertChat: alert.outputs.chat };
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
  output: BelaboxAlertChatOutput | null,
  sample: BelaboxFetchResult,
): Promise<void> => {
  if (output === null || !sample.ok || sample.sample.at.length === 0) return;
  const moduleState = await belaboxSettingsForChannel(context.DB, context.channelId);
  if (moduleState?.enabled !== true || !moduleState.settings.alertsEnabled || !moduleState.settings.chatEnabled) return;
  const status = await getBelaboxStatus(context.DB, context.channelId);
  if (status === null || status.streamId !== streamId || status.belaboxStreamId !== streamId) return;
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
    const [currentModule, currentStatus, live] = await Promise.all([
      belaboxSettingsForChannel(context.DB, context.channelId),
      getBelaboxStatus(context.DB, context.channelId),
      context.streamStartedAt(),
    ]);
    if (currentModule?.enabled !== true || !currentModule.settings.alertsEnabled || !currentModule.settings.chatEnabled ||
        live.streamId !== streamId || currentStatus?.streamId !== streamId || currentStatus.belaboxStreamId !== streamId) return false;
    if (output.validPhase === "alarm") {
      return currentStatus.alertState.phase === "alarm" && currentStatus.alertState.kind === output.alertKind &&
        currentStatus.alertState.episodeStartedAt === output.episodeStartedAt;
    }
    return currentStatus.alertState.phase === "ok" && currentStatus.alertState.completedEpisodeAt === output.episodeStartedAt;
  }, message.target);
  if (result.sent || !result.retryable) {
    const latest = await getBelaboxStatus(context.DB, context.channelId);
    if (latest?.alertState.pendingChat?.idempotencyKind !== output.idempotencyKind ||
        latest.alertState.pendingChat.episodeStartedAt !== output.episodeStartedAt) return;
    const next = settleAlertChat(latest.alertState, { sent: result.sent, retryable: result.retryable }, Date.now());
    await writeBelaboxAlertState(context.DB, context.channelId, next, latest.revision);
  }
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
    if (stored.classified) await sendPendingAlert(context, stored.streamId, stored.alertChat, result);
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
      alertState: currentStatus?.alertState ?? createInitialAlertState(),
      recent: currentStatus?.recent ?? [],
      expectedSecretVersion: secret.version,
      expectedStatusRevision: currentStatus?.revision ?? null,
    });
    if (revision !== null) {
      const classified = currentStatus !== null && currentStatus.streamId !== null &&
        currentStatus.belaboxStreamId === currentStatus.streamId;
      await writePollDiagnostics(
        context.writeDiagnostics,
        "belabox:on_demand",
        result,
        previousPhase,
        phase,
        classified,
        null,
      );
      break;
    }
    const currentSecret = await context.secrets.readWithVersion(BELABOX_STATS_URL_SECRET);
    if (currentSecret?.version !== secret.version) return result;
    currentStatus = await getBelaboxStatus(context.DB, context.channelId);
  }
  return result;
};
