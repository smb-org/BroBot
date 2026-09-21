import type { ModuleDiagnostic } from "../modules/contract";
import { werbungModul } from "../modules/werbung";
import { entscheideWerbevorwarnung, type WerbevorwarnungsEntscheidung } from "../modules/werbung/domain";
import { getChannelModuleForChannel, type ChannelModuleRecord } from "./auth/repository";
import { moduleBroadcasterScopeState } from "./module-scopes";
import { sendChatMessage } from "./chat";
import { writeModuleDiagnostics } from "./event-log";
import { getAppAccessToken } from "./app-token";
import { getAdSchedule, type AdScheduleResult } from "../modules/werbung/adapters/ad-schedule";

const MODULE_ID = "werbung";
const WARNING_SCOPE = "channel:read:ads";
const SCHEDULE_TRIGGER_TYPES = new Set(["stream.online", "channel.ad_break.begin"]);

export interface WerbeVorwarnungEnvironment {
  DB: D1Database;
  TWITCH_CLIENT_ID: string;
  TWITCH_CLIENT_SECRET: string;
  TOKEN_ENCRYPTION_KEYS?: string;
  SESSION_ENCRYPTION_KEYS?: string;
  CHANNEL?: Env["CHANNEL"];
}

/**
 * Wecker-Zugriff auf das Kanalobjekt.
 *
 * Läuft dieser Ablauf **im** Durable Object (aus `alarm()` heraus), muss der
 * eigene Planer übergeben werden. Ein Stub auf das eigene Objekt wäre ein
 * Selbstaufruf: Das Input-Gate stellt die Anfrage hinter den laufenden Alarm,
 * der auf sie wartet — der Alarm käme nie zurück.
 */
export interface Werbeplaner {
  plane: (faelligAmMs: number) => Promise<void>;
  loesche: () => Promise<void>;
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
  const parsed = werbungModul.settingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
};

const channelObject = (
  environment: WerbeVorwarnungEnvironment,
  channelId: string,
): { planeWerbevorwarnung: (faelligAmMs: number) => Promise<void>; loescheWerbevorwarnung: () => Promise<void> } | null => {
  if (environment.CHANNEL === undefined) return null;
  return environment.CHANNEL.get(environment.CHANNEL.idFromName(channelId));
};

const planerFuer = (
  environment: WerbeVorwarnungEnvironment,
  channelId: string,
  eigener?: Werbeplaner,
): Werbeplaner | null => {
  if (eigener !== undefined) return eigener;
  const stub = channelObject(environment, channelId);
  if (stub === null) return null;
  return {
    plane: async (faelligAmMs) => { await stub.planeWerbevorwarnung(faelligAmMs); },
    loesche: async () => { await stub.loescheWerbevorwarnung(); },
  };
};

const plane = async (planer: Werbeplaner | null, faelligAmMs: number): Promise<void> => {
  if (!Number.isFinite(faelligAmMs)) return;
  await planer?.plane(faelligAmMs);
};

const clear = async (planer: Werbeplaner | null): Promise<void> => {
  await planer?.loesche();
};

const writeDiagnostics = async (
  environment: WerbeVorwarnungEnvironment,
  channelId: string,
  triggerId: string,
  now: string,
  diagnostics: readonly ModuleDiagnostic[],
): Promise<void> => {
  await writeModuleDiagnostics(environment.DB, channelId, MODULE_ID, triggerId, null, diagnostics, now);
};

const writeOne = async (
  environment: WerbeVorwarnungEnvironment,
  channelId: string,
  triggerId: string,
  now: string,
  code: string,
  detail: Readonly<Record<string, string | number | boolean | null>> = {},
): Promise<void> => writeDiagnostics(environment, channelId, triggerId, now, [{ code, detail }]);

const scopeMissing = async (
  environment: WerbeVorwarnungEnvironment,
  channelId: string,
  triggerId: string,
  now: string,
  planer: Werbeplaner | null,
  diagnosenSchreiben = true,
): Promise<void> => {
  await clear(planer);
  if (diagnosenSchreiben) {
    await writeOne(environment, channelId, triggerId, now, "werbung.vorwarnung.scope_fehlt", { scope: WARNING_SCOPE });
  }
};

const scheduleFailureDiagnostic = (result: AdScheduleResult): ModuleDiagnostic => ({
  code: result.reason === "unauthorized"
    ? "werbung.vorwarnung.scope_fehlt"
    : "werbung.vorwarnung.zeitplan_fehler",
  detail: { grund: result.reason, ...result.detail },
});

const settingRecord = async (
  environment: WerbeVorwarnungEnvironment,
  channelId: string,
  triggerId: string,
  now: string,
  planer: Werbeplaner | null,
  diagnosenSchreiben = true,
): Promise<{ record: ChannelModuleRecord; settings: NonNullable<ReturnType<typeof moduleSettings>> } | null> => {
  const record = await getChannelModuleForChannel(environment.DB, channelId, MODULE_ID);
  const settings = moduleSettings(record);
  if (record === null || !record.enabled || settings === null) return null;
  const scopeState = await moduleBroadcasterScopeState(environment.DB, channelId, werbungModul);
  if (scopeState.missing.length > 0) {
    await scopeMissing(environment, channelId, triggerId, now, planer, diagnosenSchreiben);
    return null;
  }
  return { record, settings };
};

const decisionCode = (decision: WerbevorwarnungsEntscheidung): string =>
  decision.kind === "announce" ? "werbung.vorwarnung.angekuendigt" : `werbung.vorwarnung.${decision.reason}`;

const decisionDetail = (decision: WerbevorwarnungsEntscheidung): Readonly<Record<string, string | number | boolean | null>> => {
  if (decision.kind === "announce") return { sekunden: decision.sekunden, termin: decision.terminAm };
  return decision.detail;
};

const shouldReplan = (decision: WerbevorwarnungsEntscheidung): boolean =>
  decision.kind === "skip" && (decision.reason === "termin_verschoben" || decision.reason === "pause_begonnen");

const replanFromSchedule = async (
  planer: Werbeplaner | null,
  settings: { vorlaufSekunden: number },
  nextAdAt: string | null,
): Promise<void> => {
  if (nextAdAt === null) return;
  const nextAdAtMs = Date.parse(nextAdAt);
  if (!Number.isFinite(nextAdAtMs)) return;
  await plane(planer, nextAdAtMs - settings.vorlaufSekunden * 1000);
};

/** Holt den Zeitplan bei einem EventSub-Anlass und stellt den Vorwarnungswecker. */
export const aktualisiereWerbevorwarnung = async (
  environment: WerbeVorwarnungEnvironment,
  channelId: string,
  triggerId: string,
  now: string,
  fetcher: typeof fetch = fetch,
  bereitsGelesenerZeitplan?: AdScheduleResult,
  diagnosenSchreiben = true,
): Promise<void> => {
  const planer = planerFuer(environment, channelId);
  const configured = await settingRecord(environment, channelId, triggerId, now, planer, diagnosenSchreiben);
  if (configured === null || !configured.settings.vorwarnung) {
    await clear(planer);
    return;
  }

  const result = bereitsGelesenerZeitplan ?? await getAdSchedule(
    environment as unknown as Env,
    channelId,
    now,
    getAppAccessToken,
    fetcher,
  );
  if (!result.fetched || result.schedule === null) {
    if (result.reason === "unauthorized") {
      await scopeMissing(environment, channelId, triggerId, now, planer, diagnosenSchreiben);
    } else {
      if (diagnosenSchreiben) {
        await writeDiagnostics(environment, channelId, triggerId, now, [scheduleFailureDiagnostic(result)]);
      }
    }
    return;
  }
  if (result.schedule.nextAdAt === null) {
    await clear(planer);
    if (diagnosenSchreiben) {
      await writeOne(environment, channelId, triggerId, now, "werbung.vorwarnung.kein_termin");
    }
    return;
  }

  await replanFromSchedule(planer, configured.settings, result.schedule.nextAdAt);
};

/** Führt die fällige Vorwarnung nach einem frischen Zeitplan-Abruf aus. */
export const verarbeiteWerbevorwarnung = async (
  environment: WerbeVorwarnungEnvironment,
  channelId: string,
  geplantFaelligAmMs: number,
  triggerId = `werbung-vorwarnung:${crypto.randomUUID()}`,
  now = new Date().toISOString(),
  fetcher: typeof fetch = fetch,
  eigenerPlaner?: Werbeplaner,
): Promise<void> => {
  const planer = planerFuer(environment, channelId, eigenerPlaner);
  const configured = await settingRecord(environment, channelId, triggerId, now, planer);
  if (configured === null || !configured.settings.vorwarnung) return;

  const result = await getAdSchedule(
    environment as unknown as Env,
    channelId,
    now,
    getAppAccessToken,
    fetcher,
  );
  if (!result.fetched || result.schedule === null) {
    if (result.reason === "unauthorized") {
      await scopeMissing(environment, channelId, triggerId, now, planer);
    } else {
      await writeDiagnostics(environment, channelId, triggerId, now, [scheduleFailureDiagnostic(result)]);
    }
    return;
  }

  const entscheidung = entscheideWerbevorwarnung({
    settings: configured.settings,
    scopeVorhanden: true,
    jetztAmMs: nowMsFrom(now),
    geplantAmMs: geplantFaelligAmMs + configured.settings.vorlaufSekunden * 1000,
    schedule: {
      nextAdAt: result.schedule.nextAdAt,
      lastAdAt: result.schedule.lastAdAt,
    },
  });

  const diagnostics: ModuleDiagnostic[] = [{
    code: decisionCode(entscheidung),
    detail: decisionDetail(entscheidung),
  }];
  if (entscheidung.kind === "announce") {
    const sent = await sendChatMessage(environment, channelId, entscheidung.text, undefined, fetcher);
    diagnostics.push(sent.sent
      ? { code: "host.chat.gesendet", detail: sent.detail }
      : { code: "host.chat.fehlgeschlagen", detail: { grund: sent.reason, ...sent.detail } });
  }
  await writeDiagnostics(environment, channelId, triggerId, now, diagnostics);

  if (shouldReplan(entscheidung)) {
    await replanFromSchedule(planer, configured.settings, result.schedule.nextAdAt);
  }
};

export const isWerbevorwarnungsAnlass = (subscriptionType: string): boolean =>
  SCHEDULE_TRIGGER_TYPES.has(subscriptionType);
