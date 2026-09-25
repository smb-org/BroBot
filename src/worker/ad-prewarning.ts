import type { EventCode } from "../contracts/values";
import type { ModuleDiagnostic } from "../modules/contract";
import { adsModule } from "../modules/ads";
import { decideAdPrewarning, type AdPrewarningDecision } from "../modules/ads/domain";
import {
  getChannelModuleForChannel,
  type ChannelModuleRecord,
} from "./db/channel-modules";
import { moduleBroadcasterScopeState } from "./module-scopes";
import { sendChatMessage } from "./chat";
import { writeModuleDiagnostics } from "./event-log";
import { getAppAccessToken } from "./app-token";
import { getAdSchedule, type AdSchedule, type AdScheduleResult } from "../modules/ads/adapters/ad-schedule";
import { helixRequest } from "./twitch/helix";

const MODULE_ID = "ads";
const WARNING_SCOPE = "channel:read:ads";
const SCHEDULE_TRIGGER_TYPES = new Set(["stream.online", "channel.ad_break.begin"]);

export interface AdPrewarningEnvironment {
  DB: D1Database;
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEYS?: string;
  SESSION_ENCRYPTION_KEYS?: string;
  CHANNEL?: Env["CHANNEL"];
}

/**
 * Alarm access to the channel object.
 *
 * When this flow runs **inside** the Durable Object (from within `alarm()`),
 * its own scheduler must be passed in. A stub to the object's own self would
 * be a self-call: the input gate would queue the request behind the running
 * alarm that is waiting for it — the alarm would never return.
 */
export interface AdScheduler {
  schedule: (dueAtMs: number) => Promise<void>;
  clear: () => Promise<void>;
  /** Store a freshly fetched schedule through the channel object's generation guard. */
  storeSchedule?: (
    schedule: AdSchedule,
    asOf: string,
    options?: { expectedGeneration?: number; reconcileAlarm?: boolean },
  ) => Promise<unknown>;
  readScheduleGeneration?: () => Promise<number>;
  readSchedule?: () => Promise<AdSchedule | null>;
}

const nowMsFrom = (now: string): number => {
  const parsed = Date.parse(now);
  return Number.isFinite(parsed) ? parsed : Date.now();
};

const moduleSettings = (record: ChannelModuleRecord | null) => {
  if (record === null || !record.enabled) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(record.settings);
  } catch {
    return null;
  }
  const parsed = adsModule.settingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

const channelObject = (
  environment: AdPrewarningEnvironment,
  channelId: string,
): {
  scheduleAdPrewarning: (dueAtMs: number) => Promise<void>;
  clearAdPrewarning: () => Promise<void>;
  storeAdSchedule: (
    schedule: AdSchedule,
    asOf: string,
    grantedScopes?: readonly string[],
    expectedGeneration?: number,
    reconcileAlarm?: boolean,
  ) => Promise<unknown>;
  getAdScheduleGeneration: () => Promise<number>;
  getCachedAdSchedule: () => Promise<{ schedule: AdSchedule } | null>;
} | null => {
  if (environment.CHANNEL === undefined) return null;
  return environment.CHANNEL.get(environment.CHANNEL.idFromName(channelId));
};

const schedulerFor = (
  environment: AdPrewarningEnvironment,
  channelId: string,
  own?: AdScheduler,
): AdScheduler | null => {
  if (own !== undefined) return own;
  const stub = channelObject(environment, channelId);
  if (stub === null) return null;
  return {
    schedule: async (dueAtMs) => { await stub.scheduleAdPrewarning(dueAtMs); },
    clear: async () => { await stub.clearAdPrewarning(); },
    readScheduleGeneration: () => stub.getAdScheduleGeneration(),
    readSchedule: async () => (await stub.getCachedAdSchedule())?.schedule ?? null,
    storeSchedule: async (schedule, asOf, options) => {
      if (options === undefined) return await stub.storeAdSchedule(schedule, asOf);
      return await stub.storeAdSchedule(
        schedule,
        asOf,
        undefined,
        options.expectedGeneration,
        options.reconcileAlarm,
      );
    },
  };
};

const schedule = async (scheduler: AdScheduler | null, dueAtMs: number): Promise<void> => {
  if (!Number.isFinite(dueAtMs)) return;
  await scheduler?.schedule(dueAtMs);
};

const clear = async (scheduler: AdScheduler | null): Promise<void> => {
  await scheduler?.clear();
};

/**
 * A rejected generation means this fetch lost to a newer schedule save. Some
 * adapters historically returned void after awaiting the guarded save, so
 * treat an ambiguous result the same way: only use the fetched value when a
 * successful save is explicit. Otherwise use the object cache or skip.
 */
const storeScheduleAndResolveCurrent = async (
  scheduler: AdScheduler | null,
  schedule: AdSchedule,
  asOf: string,
  options?: { expectedGeneration?: number; reconcileAlarm?: boolean },
): Promise<AdSchedule | null> => {
  if (scheduler?.storeSchedule === undefined) return schedule;
  const stored = await scheduler.storeSchedule(schedule, asOf, options);
  if (stored !== null && stored !== undefined) return schedule;
  return await scheduler.readSchedule?.() ?? null;
};

const writeDiagnostics = async (
  environment: AdPrewarningEnvironment,
  channelId: string,
  triggerId: string,
  now: string,
  diagnostics: readonly ModuleDiagnostic[],
): Promise<void> => {
  await writeModuleDiagnostics(environment.DB, channelId, MODULE_ID, triggerId, null, diagnostics, now);
};

const writeOne = async (
  environment: AdPrewarningEnvironment,
  channelId: string,
  triggerId: string,
  now: string,
  code: EventCode,
  detail: Readonly<Record<string, string | number | boolean | null>> = {},
): Promise<void> => writeDiagnostics(environment, channelId, triggerId, now, [{ code, detail }]);

const scopeMissing = async (
  environment: AdPrewarningEnvironment,
  channelId: string,
  triggerId: string,
  now: string,
  scheduler: AdScheduler | null,
  shouldWriteDiagnostics = true,
): Promise<void> => {
  await clear(scheduler);
  if (shouldWriteDiagnostics) {
    await writeOne(environment, channelId, triggerId, now, "ads.prewarning.scope_missing", { scope: WARNING_SCOPE });
  }
};

const scheduleFailureDiagnostic = (result: AdScheduleResult): ModuleDiagnostic => ({
  code: (result.reason === "unauthorized"
    ? "ads.prewarning.scope_missing"
    : "ads.prewarning.schedule_error") satisfies EventCode,
  detail: { reason: result.reason, ...result.detail },
});

const settingRecord = async (
  environment: AdPrewarningEnvironment,
  channelId: string,
  triggerId: string,
  now: string,
  scheduler: AdScheduler | null,
  shouldWriteDiagnostics = true,
): Promise<{ record: ChannelModuleRecord; settings: NonNullable<ReturnType<typeof moduleSettings>> } | null> => {
  const record = await getChannelModuleForChannel(environment.DB, channelId, MODULE_ID);
  const settings = moduleSettings(record);
  if (record === null || !record.enabled || settings === null) return null;
  const scopeState = await moduleBroadcasterScopeState(environment.DB, channelId, adsModule);
  if (scopeState.missing.length > 0) {
    await scopeMissing(environment, channelId, triggerId, now, scheduler, shouldWriteDiagnostics);
    return null;
  }
  return { record, settings };
};

// Not typed `EventCode`: `decision.reason` includes `"disabled"`, which the
// caller always guards against before `decideAdPrewarning` runs (see
// `settingRecord`'s `!configured.settings.prewarning` checks below), so
// `ads.prewarning.disabled` is unreachable and was never a real code. The
// five reachable suffixes are each in `EVENT_CODES`, checked by
// `tests/unit/event-codes.test.ts` matching this function's real outputs.
const decisionCode = (decision: AdPrewarningDecision): string =>
  decision.kind === "announce" ? ("ads.prewarning.announced" satisfies EventCode) : `ads.prewarning.${decision.reason}`;

const decisionDetail = (decision: AdPrewarningDecision): Readonly<Record<string, string | number | boolean | null>> => {
  if (decision.kind === "announce") return { seconds: decision.seconds, scheduledAt: decision.scheduledAt };
  return decision.detail;
};

const shouldReplan = (decision: AdPrewarningDecision): boolean =>
  decision.kind === "skip" && (decision.reason === "rescheduled" || decision.reason === "break_started");

const replanFromSchedule = async (
  scheduler: AdScheduler | null,
  settings: { leadSeconds: number },
  nextAdAt: string | null,
): Promise<void> => {
  if (nextAdAt === null) return;
  const nextAdAtMs = Date.parse(nextAdAt);
  if (!Number.isFinite(nextAdAtMs)) return;
  await schedule(scheduler, nextAdAtMs - settings.leadSeconds * 1000);
};

/** Fetches the schedule on an EventSub occasion and sets the prewarning alarm. */
export const refreshAdPrewarning = async (
  environment: AdPrewarningEnvironment,
  channelId: string,
  triggerId: string,
  now: string,
  fetcher: typeof fetch = fetch,
  alreadyFetchedSchedule?: AdScheduleResult,
  shouldWriteDiagnostics = true,
): Promise<void> => {
  const scheduler = schedulerFor(environment, channelId);
  const configured = await settingRecord(environment, channelId, triggerId, now, scheduler, shouldWriteDiagnostics);
  if (configured === null) {
    await clear(scheduler);
    return;
  }
  if (!configured.settings.prewarning) await clear(scheduler);

  const scheduleGeneration = await scheduler?.readScheduleGeneration?.();
  const result = alreadyFetchedSchedule ?? await getAdSchedule(
    environment as unknown as Env,
    channelId,
    now,
    getAppAccessToken,
    helixRequest,
    fetcher,
  );
  if (!result.fetched || result.schedule === null) {
    if (configured.settings.prewarning && result.reason === "unauthorized") {
      await scopeMissing(environment, channelId, triggerId, now, scheduler, shouldWriteDiagnostics);
    } else if (configured.settings.prewarning) {
      if (shouldWriteDiagnostics) {
        await writeDiagnostics(environment, channelId, triggerId, now, [scheduleFailureDiagnostic(result)]);
      }
    }
    return;
  }
  // EventSub fetches happen outside the ChannelObject's schedule refresh path.
  // Persist the fetched value there before touching its alarm so a subsequent
  // panel read cannot reconcile an older cached schedule over this one.
  const storedByChannelObject = scheduler?.storeSchedule !== undefined;
  const currentSchedule = storedByChannelObject
    ? await storeScheduleAndResolveCurrent(scheduler, result.schedule, now, {
      ...(scheduleGeneration === undefined ? {} : { expectedGeneration: scheduleGeneration }),
    })
    : result.schedule;
  if (currentSchedule === null) return;
  if (currentSchedule.nextAdAt === null) {
    if (!storedByChannelObject) await clear(scheduler);
    if (configured.settings.prewarning && shouldWriteDiagnostics) {
      await writeOne(environment, channelId, triggerId, now, "ads.prewarning.no_schedule");
    }
    return;
  }

  if (!configured.settings.prewarning) return;
  if (!storedByChannelObject) await replanFromSchedule(scheduler, configured.settings, currentSchedule.nextAdAt);
};

/** Runs the due prewarning after a fresh schedule fetch. */
export const processAdPrewarning = async (
  environment: AdPrewarningEnvironment,
  channelId: string,
  scheduledDueAtMs: number,
  triggerId = `werbung-vorwarnung:${crypto.randomUUID()}`,
  now = new Date().toISOString(),
  fetcher: typeof fetch = fetch,
  ownScheduler?: AdScheduler,
): Promise<void> => {
  const scheduler = schedulerFor(environment, channelId, ownScheduler);
  const configured = await settingRecord(environment, channelId, triggerId, now, scheduler);
  if (configured === null || !configured.settings.prewarning) return;

  const scheduleGeneration = await scheduler?.readScheduleGeneration?.();
  const result = await getAdSchedule(
    environment as unknown as Env,
    channelId,
    now,
    getAppAccessToken,
    helixRequest,
    fetcher,
  );
  if (!result.fetched || result.schedule === null) {
    if (result.reason === "unauthorized") {
      await scopeMissing(environment, channelId, triggerId, now, scheduler);
    } else {
      await writeDiagnostics(environment, channelId, triggerId, now, [scheduleFailureDiagnostic(result)]);
    }
    return;
  }

  // The alarm run has already claimed its deadline, so refresh the cached
  // schedule without rearming from the cache before its decision is applied.
  const currentSchedule = await storeScheduleAndResolveCurrent(scheduler, result.schedule, now, {
    ...(scheduleGeneration === undefined ? {} : { expectedGeneration: scheduleGeneration }),
    reconcileAlarm: false,
  });
  if (currentSchedule === null) return;

  const decision = decideAdPrewarning({
    settings: configured.settings,
    scopeAvailable: true,
    nowAtMs: nowMsFrom(now),
    plannedAtMs: scheduledDueAtMs + configured.settings.leadSeconds * 1000,
    schedule: {
      nextAdAt: currentSchedule.nextAdAt,
      lastAdAt: currentSchedule.lastAdAt,
    },
  });

  // A snooze can land after the decision above but before the chat message
  // actually goes out (sendChatMessage awaits a network call). Re-read the
  // same guarded cache immediately before sending and recompute the decision
  // from it, so a schedule change in that window skips/reschedules instead
  // of announcing the now-stale ad time.
  const freshSchedule = decision.kind === "announce" ? await scheduler?.readSchedule?.() ?? null : null;
  const finalDecision = freshSchedule === null || freshSchedule.nextAdAt === currentSchedule.nextAdAt
    ? decision
    : decideAdPrewarning({
      settings: configured.settings,
      scopeAvailable: true,
      nowAtMs: nowMsFrom(now),
      plannedAtMs: scheduledDueAtMs + configured.settings.leadSeconds * 1000,
      schedule: { nextAdAt: freshSchedule.nextAdAt, lastAdAt: freshSchedule.lastAdAt },
    });

  const diagnostics: ModuleDiagnostic[] = [{
    code: decisionCode(finalDecision),
    detail: decisionDetail(finalDecision),
  }];
  if (finalDecision.kind === "announce") {
    // sendChatMessage still awaits bot identity and an access token before
    // its own POST, so a snooze can land after the recheck above but before
    // that call goes out. stillValid re-reads the cache one more time right
    // before the POST -- the smallest remaining window (see the `ponytail:`
    // note on sendChatMessage's `stillValid` parameter).
    const validatedNextAdAt = (freshSchedule ?? currentSchedule).nextAdAt;
    const stillValid = async (): Promise<boolean> => {
      const latestSchedule = await scheduler?.readSchedule?.() ?? null;
      return latestSchedule === null || latestSchedule.nextAdAt === validatedNextAdAt;
    };
    const sent = await sendChatMessage(environment, channelId, finalDecision.text, undefined, fetcher, stillValid);
    if (sent.truncated) {
      diagnostics.push({ code: "template_truncated" satisfies EventCode, detail: { current: finalDecision.text.length } });
    }
    diagnostics.push(sent.sent
      ? { code: "host.chat.sent" satisfies EventCode, detail: sent.detail }
      : sent.reason === "stale_before_send"
        ? { code: "host.chat.skipped" satisfies EventCode, detail: sent.detail }
        : { code: "host.chat.failed" satisfies EventCode, detail: { reason: sent.reason, ...sent.detail } });
  }
  await writeDiagnostics(environment, channelId, triggerId, now, diagnostics);

  if (shouldReplan(finalDecision)) {
    await replanFromSchedule(scheduler, configured.settings, (freshSchedule ?? currentSchedule).nextAdAt);
  }
};

export const isAdPrewarningTrigger = (subscriptionType: string): boolean =>
  SCHEDULE_TRIGGER_TYPES.has(subscriptionType);
