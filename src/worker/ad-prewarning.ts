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
import { getAdSchedule, type AdScheduleResult } from "../modules/ads/adapters/ad-schedule";

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
): { scheduleAdPrewarning: (dueAtMs: number) => Promise<void>; clearAdPrewarning: () => Promise<void> } | null => {
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
  };
};

const schedule = async (scheduler: AdScheduler | null, dueAtMs: number): Promise<void> => {
  if (!Number.isFinite(dueAtMs)) return;
  await scheduler?.schedule(dueAtMs);
};

const clear = async (scheduler: AdScheduler | null): Promise<void> => {
  await scheduler?.clear();
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
  code: string,
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
    await writeOne(environment, channelId, triggerId, now, "ads.vorwarnung.scope_fehlt", { scope: WARNING_SCOPE });
  }
};

const scheduleFailureDiagnostic = (result: AdScheduleResult): ModuleDiagnostic => ({
  code: result.reason === "unauthorized"
    ? "ads.vorwarnung.scope_fehlt"
    : "ads.vorwarnung.zeitplan_fehler",
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

const decisionCode = (decision: AdPrewarningDecision): string =>
  decision.kind === "announce" ? "ads.vorwarnung.angekuendigt" : `ads.vorwarnung.${decision.reason}`;

const decisionDetail = (decision: AdPrewarningDecision): Readonly<Record<string, string | number | boolean | null>> => {
  if (decision.kind === "announce") return { sekunden: decision.sekunden, termin: decision.terminAm };
  return decision.detail;
};

const shouldReplan = (decision: AdPrewarningDecision): boolean =>
  decision.kind === "skip" && (decision.reason === "termin_verschoben" || decision.reason === "pause_begonnen");

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
  if (configured === null || !configured.settings.prewarning) {
    await clear(scheduler);
    return;
  }

  const result = alreadyFetchedSchedule ?? await getAdSchedule(
    environment as unknown as Env,
    channelId,
    now,
    getAppAccessToken,
    fetcher,
  );
  if (!result.fetched || result.schedule === null) {
    if (result.reason === "unauthorized") {
      await scopeMissing(environment, channelId, triggerId, now, scheduler, shouldWriteDiagnostics);
    } else {
      if (shouldWriteDiagnostics) {
        await writeDiagnostics(environment, channelId, triggerId, now, [scheduleFailureDiagnostic(result)]);
      }
    }
    return;
  }
  if (result.schedule.nextAdAt === null) {
    await clear(scheduler);
    if (shouldWriteDiagnostics) {
      await writeOne(environment, channelId, triggerId, now, "ads.vorwarnung.kein_termin");
    }
    return;
  }

  await replanFromSchedule(scheduler, configured.settings, result.schedule.nextAdAt);
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

  const result = await getAdSchedule(
    environment as unknown as Env,
    channelId,
    now,
    getAppAccessToken,
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

  const decision = decideAdPrewarning({
    settings: configured.settings,
    scopeAvailable: true,
    nowAtMs: nowMsFrom(now),
    plannedAtMs: scheduledDueAtMs + configured.settings.leadSeconds * 1000,
    schedule: {
      nextAdAt: result.schedule.nextAdAt,
      lastAdAt: result.schedule.lastAdAt,
    },
  });

  const diagnostics: ModuleDiagnostic[] = [{
    code: decisionCode(decision),
    detail: decisionDetail(decision),
  }];
  if (decision.kind === "announce") {
    const sent = await sendChatMessage(environment, channelId, decision.text, undefined, fetcher);
    diagnostics.push(sent.sent
      ? { code: "host.chat.gesendet", detail: sent.detail }
      : { code: "host.chat.fehlgeschlagen", detail: { reason: sent.reason, ...sent.detail } });
  }
  await writeDiagnostics(environment, channelId, triggerId, now, diagnostics);

  if (shouldReplan(decision)) {
    await replanFromSchedule(scheduler, configured.settings, result.schedule.nextAdAt);
  }
};

export const isAdPrewarningTrigger = (subscriptionType: string): boolean =>
  SCHEDULE_TRIGGER_TYPES.has(subscriptionType);
