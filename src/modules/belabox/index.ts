import type { BotModule, ModuleLanguage, ModuleTemplateValueContext } from "../contract";
import { belaboxRoutes } from "./routes";
import {
  BELABOX_DEFAULT_SETTINGS,
  BELABOX_ENSURE_POLL_HANDLER,
  BELABOX_MODULE_ID,
  BELABOX_POLL_ALARM_KEY,
  belaboxSettingsSchema,
  type BelaboxSample,
} from "./contracts";
import { BELABOX_TEMPLATE_VARIABLES, belaboxCatalog } from "./contracts/catalog";
import { getBelaboxStatus } from "./adapters/d1";
import { belaboxDownMilliseconds, resolvedBelaboxPhase } from "./domain/presentation";
import {
  belaboxSettingsForChannel,
  currentBelaboxSample,
  ensureBelaboxPoll,
  ensureBelaboxPollSchedule,
  handleBelaboxPollAlarm,
} from "./service";
import { belaboxOverlayElements } from "./overlay/element";

const unavailableText = { de: belaboxCatalog.de.unavailable, en: belaboxCatalog.en.unavailable } as const;

const numberFormatter = (language: ModuleLanguage, maximumFractionDigits = 0): Intl.NumberFormat =>
  new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US", { maximumFractionDigits });

const formatDuration = (milliseconds: number, language: ModuleLanguage): string => {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  if (totalSeconds < 60) {
    return language === "de"
      ? `${String(totalSeconds)} ${totalSeconds === 1 ? "Sekunde" : "Sekunden"}`
      : `${String(totalSeconds)} ${totalSeconds === 1 ? "second" : "seconds"}`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return language === "de"
      ? `${String(totalMinutes)} ${totalMinutes === 1 ? "Minute" : "Minuten"}`
      : `${String(totalMinutes)} ${totalMinutes === 1 ? "minute" : "minutes"}`;
  }
  const hours = Math.floor(totalMinutes / 60);
  return language === "de"
    ? `${String(hours)} ${hours === 1 ? "Stunde" : "Stunden"}`
    : `${String(hours)} ${hours === 1 ? "hour" : "hours"}`;
};

const formatTemplateValues = (
  sample: BelaboxSample,
  names: readonly string[],
  language: ModuleLanguage,
  now: number,
  classified: boolean,
): Readonly<Record<string, string>> => {
  const requested = new Set(names);
  const integer = numberFormatter(language);
  const decimal = numberFormatter(language, 1);
  const phase = resolvedBelaboxPhase(sample, classified);
  const catalog = belaboxCatalog[language];
  const values: Readonly<Record<string, string>> = {
    "belabox.bitrate": `${integer.format(sample.bitrateKbps)} kbps`,
    "belabox.bitrate_mbps": `${decimal.format(sample.bitrateKbps / 1_000)} Mbit/s`,
    "belabox.rtt": `${integer.format(sample.rttMs)} ms`,
    "belabox.latency": `${integer.format(sample.latencyMs)} ms`,
    "belabox.network": integer.format(sample.network),
    "belabox.dropped": integer.format(sample.droppedTotal ?? 0),
    "belabox.connected": sample.connected ? catalog.connected : catalog.disconnected,
    "belabox.status": catalog.phases[phase],
    "belabox.down_for": formatDuration(belaboxDownMilliseconds({ ...sample, phase }, now), language),
  };
  return Object.fromEntries(Object.entries(values).filter(([name]) => requested.has(name)));
};

const freshSample = (
  sample: BelaboxSample | null,
  errorCode: string | null,
  now: number,
  maximumAgeMilliseconds: number,
): sample is BelaboxSample => {
  if (sample === null || errorCode !== null) return false;
  const sampledAt = Date.parse(sample.at);
  const age = now - sampledAt;
  return Number.isFinite(age) && age >= 0 && age <= maximumAgeMilliseconds;
};

const resolveValues = async (
  names: readonly string[],
  context: ModuleTemplateValueContext,
): Promise<Readonly<Record<string, string>>> => {
  try {
    const moduleState = await belaboxSettingsForChannel(context.DB, context.channelId);
    if (moduleState?.enabled !== true) throw new Error("BELABOX_SAMPLE_UNAVAILABLE");
    const language = await context.channelLanguage();
    if (moduleState.settings.mode === "interval") {
      const status = await getBelaboxStatus(context.DB, context.channelId);
      if (status === null || !freshSample(
        status.sample,
        status.errorCode,
        context.now,
        moduleState.settings.intervalSeconds * 3_000,
      )) throw new Error("BELABOX_SAMPLE_UNAVAILABLE");
      return formatTemplateValues(status.sample, names, language, context.now, status.belaboxStreamId !== null);
    }
    const current = await currentBelaboxSample({
      DB: context.DB,
      channelId: context.channelId,
      secrets: context.secrets,
      externalFetchBudget: context.externalFetchBudget ?? { claim: () => true },
    }, context.now);
    if (!current.ok || !freshSample(current.sample, null, context.now, 30_000)) {
      throw new Error("BELABOX_SAMPLE_UNAVAILABLE");
    }
    return formatTemplateValues(current.sample, names, language, context.now, true);
  } catch {
    throw new Error("BELABOX_SAMPLE_UNAVAILABLE");
  }
};

const resolveOverlayValues: NonNullable<BotModule<typeof belaboxSettingsSchema>["resolveOverlayTemplateValues"]> = async (
  names,
  context,
) => {
  const requested = new Set(names);
  const known = BELABOX_TEMPLATE_VARIABLES.map(({ name }) => name).filter((name) => requested.has(name));
  if (known.length === 0) return {};
  const [moduleState, status] = await Promise.all([
    belaboxSettingsForChannel(context.DB, context.channelId),
    getBelaboxStatus(context.DB, context.channelId),
  ]);
  if (moduleState?.enabled !== true) {
    return Object.fromEntries(known.map((name) => [name, { available: false }]));
  }
  const refreshMilliseconds = Math.max(moduleState.settings.intervalSeconds * 1_000, 30_000);
  const persistedSample = status?.sample ?? null;
  const availablePersistedSample = persistedSample !== null && freshSample(
    persistedSample,
    status?.errorCode ?? null,
    context.now,
    moduleState.settings.mode === "on_demand" ? 30_000 : moduleState.settings.intervalSeconds * 3_000,
  );
  const sampledAt = availablePersistedSample ? Date.parse(persistedSample.at) : context.now;
  const nextChangeAt = new Date(sampledAt + refreshMilliseconds).toISOString();
  // On-demand values are fetched through the read-only template path. Their fresh
  // sample is intentionally not persisted, so retry at the next render boundary.
  return Object.fromEntries(known.map((name) => [name, { available: availablePersistedSample, nextChangeAt }]));
};

export const belaboxModule: BotModule<typeof belaboxSettingsSchema> = {
  id: BELABOX_MODULE_ID,
  navigationCategory: "data",
  panelIcon: { paths: ["M4 7h16v10H4z", "M8 11h3", "M14 11h2", "M8 14h8"] },
  mandatory: false,
  defaultEnabled: false,
  settingsSchema: belaboxSettingsSchema,
  defaultSettings: BELABOX_DEFAULT_SETTINGS,
  templateVariableGroup: {
    label: { de: "BELABOX", en: "BELABOX" },
    icon: { paths: ["M4 7h16v10H4z", "M8 11h3", "M14 11h2", "M8 14h8"] },
    order: 40,
  },
  templateVariableCatalog: BELABOX_TEMPLATE_VARIABLES,
  templateUnavailableText: unavailableText,
  resolveTemplateValues: resolveValues,
  resolveOverlayTemplateValues: resolveOverlayValues,
  overlayElements: belaboxOverlayElements.map((element) => ({
    ...element,
    initialState: async (db, channelId) => {
      const [moduleState, status] = await Promise.all([
        belaboxSettingsForChannel(db, channelId),
        getBelaboxStatus(db, channelId),
      ]);
      if (moduleState === null) return null;
      const sample = status?.sample;
      return {
        sample: sample === null || sample === undefined ? null : {
          at: sample.at,
          connected: sample.connected,
          bitrateKbps: sample.bitrateKbps,
          rttMs: sample.rttMs,
          latencyMs: sample.latencyMs,
          network: sample.network,
          droppedPackets: sample.droppedPackets,
          droppedTotal: sample.droppedTotal ?? 0,
          phase: sample.phase ?? resolvedBelaboxPhase(sample, status?.belaboxStreamId !== null),
          alertStartedAt: sample.alertStartedAt ?? null,
        },
        intervalSeconds: moduleState.settings.intervalSeconds,
        mode: moduleState.settings.mode,
      };
    },
  })),
  eventSubTypes: ["stream.online", "stream.offline"],
  pauseSafeEventSubTypes: ["stream.online", "stream.offline"],
  settingsChangedAlarm: { handlerKey: BELABOX_ENSURE_POLL_HANDLER, alarmKey: BELABOX_POLL_ALARM_KEY },
  alarms: [{
    key: BELABOX_POLL_ALARM_KEY,
    handle: handleBelaboxPollAlarm,
  }, {
    key: BELABOX_ENSURE_POLL_HANDLER,
    handle: async (context, alarmKey) => {
      if (alarmKey === BELABOX_POLL_ALARM_KEY) await ensureBelaboxPoll(context);
    },
    onScheduleInputsChanged: ensureBelaboxPollSchedule,
  }],
  routes: belaboxRoutes,
  panel: () => import("./panel/index"),
  settingsEditor: () => import("./panel/settings-editor"),
  handleEvent: async (event, context) => {
    if (context.streamStateTransitionAccepted !== true ||
        (event.subscriptionType !== "stream.online" && event.subscriptionType !== "stream.offline")) {
      return { actions: [], diagnostics: [] };
    }
    try {
      await ensureBelaboxPoll({
        schedule: (key, deadline) => context.scheduleAlarm(BELABOX_POLL_ALARM_KEY, key, deadline),
      });
    } catch {
      return { actions: [], diagnostics: [{ code: "belabox.polling_ensure_failed" }] };
    }
    return { actions: [], diagnostics: [] };
  },
};
