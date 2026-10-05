import type { BotModule } from "../contract";
import { belaboxRoutes } from "./routes";
import {
  BELABOX_DEFAULT_SETTINGS,
  BELABOX_ENSURE_POLL_HANDLER,
  BELABOX_MODULE_ID,
  BELABOX_POLL_ALARM_KEY,
  belaboxSettingsSchema,
} from "./contracts";
import { ensureBelaboxPoll, ensureBelaboxPollSchedule, handleBelaboxPollAlarm } from "./service";

export const belaboxModule: BotModule<typeof belaboxSettingsSchema> = {
  id: BELABOX_MODULE_ID,
  navigationCategory: "data",
  panelIcon: { paths: ["M4 7h16v10H4z", "M8 11h3", "M14 11h2", "M8 14h8"] },
  mandatory: false,
  defaultEnabled: false,
  settingsSchema: belaboxSettingsSchema,
  defaultSettings: BELABOX_DEFAULT_SETTINGS,
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
