import type { BotModule, ModuleTemplateValueContext } from "../contract";
import { belaboxRoutes } from "./routes";
import {
  BELABOX_DEFAULT_SETTINGS,
  BELABOX_ALERT_TEMPLATE_FIELDS,
  BELABOX_ENSURE_POLL_HANDLER,
  BELABOX_MODULE_ID,
  BELABOX_POLL_ALARM_KEY,
  belaboxSettingsSchema,
  type BelaboxSample,
} from "./contracts";
import { BELABOX_TEMPLATE_VARIABLES, belaboxCatalog } from "./contracts/catalog";
import { belaboxStatusMatchesSession, belaboxStreamSessionKey, getBelaboxStatus, getBelaboxStreamSession, purgeExpiredBelaboxMinutes } from "./adapters/d1";
import {
  belaboxPresentationAlertStartedAt,
  resolvedBelaboxPhase,
} from "./domain/presentation";
import {
  belaboxAlertDefaultsOnEnable,
  belaboxSettingsForChannel,
  ensureBelaboxPoll,
  ensureBelaboxPollSchedule,
  handleBelaboxPollAlarm,
  isBelaboxPollRunning,
  type BelaboxPollRoutineResult,
} from "./service";
import { formatTemplateValues } from "./template-values";
import { belaboxOverlayElements } from "./overlay/element";

const unavailableText = { de: belaboxCatalog.de.unavailable, en: belaboxCatalog.en.unavailable } as const;

const freshSample = (
  sample: BelaboxSample | null,
  errorCode: string | null,
  now: number,
  maximumAgeMilliseconds: number,
): sample is BelaboxSample => {
  if (sample === null || errorCode !== null) return false;
  const sampledAt = Date.parse(sample.at);
  const age = Math.max(0, now - sampledAt);
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
    // Never queue behind a poll that is already running for this channel: that poll may be
    // awaiting this very provider (alert rendering), so read the stored sample instead.
    const polling = isBelaboxPollRunning(context.channelId);
    if (moduleState.settings.mode === "interval" || polling) {
      const [status, session] = await Promise.all([
        getBelaboxStatus(context.DB, context.channelId),
        getBelaboxStreamSession(context.DB, context.channelId),
      ]);
      if (status === null || !belaboxStatusMatchesSession(status, session) || !freshSample(
        status.sample,
        status.errorCode,
        context.now,
        moduleState.settings.mode === "interval" ? moduleState.settings.intervalSeconds * 3_000 : 30_000,
      )) throw new Error("BELABOX_SAMPLE_UNAVAILABLE");
      return formatTemplateValues(
        status.sample,
        names,
        language,
        context.now,
        status.belaboxStreamId !== null,
        moduleState.settings.lowBitrateKbps,
        status.alertState,
      );
    }
    if (context.runModuleAlarm === undefined) throw new Error("BELABOX_SAMPLE_UNAVAILABLE");
    const result: unknown = await context.runModuleAlarm(
      BELABOX_MODULE_ID,
      BELABOX_POLL_ALARM_KEY,
      BELABOX_POLL_ALARM_KEY,
      { reason: "on_demand" },
    );
    if (typeof result !== "object" || result === null || !("ok" in result)) {
      throw new Error("BELABOX_SAMPLE_UNAVAILABLE");
    }
    const current = result as BelaboxPollRoutineResult;
    const freshAt = Date.now();
    if (!current.ok || !freshSample(current.sample, null, freshAt, 30_000)) {
      throw new Error("BELABOX_SAMPLE_UNAVAILABLE");
    }
    return formatTemplateValues(current.sample, names, language, freshAt, true, moduleState.settings.lowBitrateKbps);
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
  const [moduleState, status, session] = await Promise.all([
    belaboxSettingsForChannel(context.DB, context.channelId),
    getBelaboxStatus(context.DB, context.channelId),
    getBelaboxStreamSession(context.DB, context.channelId),
  ]);
  if (moduleState?.enabled !== true) {
    return Object.fromEntries(known.map((name) => [name, { available: false }]));
  }
  const refreshMilliseconds = Math.max(moduleState.settings.intervalSeconds * 1_000, 30_000);
  const maximumAgeMilliseconds = moduleState.settings.mode === "on_demand"
    ? 30_000
    : moduleState.settings.intervalSeconds * 3_000;
  const persistedSample = status?.sample ?? null;
  const availablePersistedSample = persistedSample !== null && status !== null &&
    belaboxStatusMatchesSession(status, session) && freshSample(
      persistedSample,
      status.errorCode,
      context.now,
      maximumAgeMilliseconds,
    );
  const sampledAt = availablePersistedSample ? Date.parse(persistedSample.at) : context.now;
  const refreshAt = sampledAt + refreshMilliseconds;
  const refreshDeadline = refreshAt > context.now ? refreshAt : context.now + refreshMilliseconds;
  const unavailabilityAt = sampledAt + maximumAgeMilliseconds + 1;
  const nextChangeAt = new Date(availablePersistedSample
    ? Math.min(refreshDeadline, unavailabilityAt)
    : context.now + refreshMilliseconds).toISOString();
  return Object.fromEntries(known.map((name) => [name, { available: availablePersistedSample, nextChangeAt }]));
};
const belaboxPanelIcon = { paths: ["M4 7h16v10H4z", "M8 11h3", "M14 11h2", "M8 14h8"] } as const;

export const belaboxModule: BotModule<typeof belaboxSettingsSchema> = {
  id: BELABOX_MODULE_ID,
  navigationCategory: "data",
  panelIcon: belaboxPanelIcon,
  mandatory: false,
  defaultEnabled: false,
  settingsSchema: belaboxSettingsSchema,
  defaultSettings: BELABOX_DEFAULT_SETTINGS,
  templateVariableGroup: {
    label: { de: "BELABOX", en: "BELABOX" },
    icon: belaboxPanelIcon,
    order: 40,
  },
  templateVariableCatalog: BELABOX_TEMPLATE_VARIABLES,
  templateFields: BELABOX_ALERT_TEMPLATE_FIELDS,
  templateUnavailableText: unavailableText,
  resolveTemplateValues: resolveValues,
  resolveOverlayTemplateValues: resolveOverlayValues,
  onEnable: belaboxAlertDefaultsOnEnable,
  overlayElements: belaboxOverlayElements.map((element) => ({
    ...element,
    initialState: async (db, channelId) => {
      const [moduleState, status, session] = await Promise.all([
        belaboxSettingsForChannel(db, channelId),
        getBelaboxStatus(db, channelId),
        getBelaboxStreamSession(db, channelId),
      ]);
      if (moduleState === null) return null;
      const sample = status !== null && belaboxStatusMatchesSession(status, session) ? status.sample : null;
      const phase = sample === null ? null : resolvedBelaboxPhase(
        sample,
        status?.belaboxStreamId !== null,
        moduleState.settings.lowBitrateKbps,
        status?.alertState,
      );
      return {
        sample: sample === null ? null : {
          at: sample.at,
          connected: sample.connected,
          bitrateKbps: sample.bitrateKbps,
          rttMs: sample.rttMs,
          latencyMs: sample.latencyMs,
          network: sample.network,
          droppedPackets: sample.droppedPackets,
          droppedTotal: sample.droppedTotal ?? 0,
          phase: phase ?? "inactive",
          alertStartedAt: belaboxPresentationAlertStartedAt(sample, phase ?? "inactive", status?.alertState),
        },
        intervalSeconds: moduleState.settings.intervalSeconds,
        mode: moduleState.settings.mode,
        streamSessionKey: belaboxStreamSessionKey(session),
      };
    },
  })),
  eventSubTypes: ["stream.online", "stream.offline"],
  pauseSafeEventSubTypes: ["stream.online", "stream.offline"],
  settingsChangedAlarm: { handlerKey: BELABOX_ENSURE_POLL_HANDLER, alarmKey: BELABOX_POLL_ALARM_KEY },
  alarms: [{
    key: BELABOX_POLL_ALARM_KEY,
    handle: (context, alarmKey, deadline, ownerRevision, invocation) =>
      handleBelaboxPollAlarm(context, alarmKey, deadline, ownerRevision, undefined, invocation),
  }, {
    key: BELABOX_ENSURE_POLL_HANDLER,
    handle: async (context, alarmKey) => {
      if (alarmKey === BELABOX_POLL_ALARM_KEY) await ensureBelaboxPoll(context);
    },
    onScheduleInputsChanged: ensureBelaboxPollSchedule,
  }],
  routes: belaboxRoutes,
  scheduledMaintenance: purgeExpiredBelaboxMinutes,
  settingsEditorPlacement: "before-panel",
  panel: () => import("./panel/index"),
  settingsEditor: () => import("./panel/settings-editor"),
  settingsEditorRelatedParts: ["status"],
  immediateActions: { requires: ["streamLive"], load: () => import("./panel/immediate-actions") },
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
