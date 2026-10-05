import type { BotModule } from "../contract";
import { belaboxRoutes } from "./routes";
import {
  BELABOX_DEFAULT_SETTINGS,
  BELABOX_MODULE_ID,
  BELABOX_POLL_ALARM_KEY,
  BELABOX_RECONCILE_ALARM_HANDLER,
  belaboxSettingsSchema,
} from "./contracts";
import { handleBelaboxPollAlarm, reconcileBelaboxPollSchedule, reconcileBelaboxPolling } from "./service";

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
  settingsChangedAlarm: { handlerKey: BELABOX_RECONCILE_ALARM_HANDLER, alarmKey: BELABOX_POLL_ALARM_KEY },
  alarms: [{
    key: BELABOX_POLL_ALARM_KEY,
    handle: handleBelaboxPollAlarm,
    onScheduleInputsChanged: reconcileBelaboxPollSchedule,
  }, {
    key: BELABOX_RECONCILE_ALARM_HANDLER,
    handle: async (context, alarmKey) => {
      if (alarmKey === BELABOX_POLL_ALARM_KEY) await reconcileBelaboxPolling(context);
    },
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
      await reconcileBelaboxPolling({
        DB: context.DB,
        channelId: event.channelId,
        streamState: context.streamState,
        ...(context.getAlarmDeadline === undefined ? {} : { getAlarmDeadline: context.getAlarmDeadline }),
        schedule: (key, deadline) => context.scheduleAlarm(BELABOX_POLL_ALARM_KEY, key, deadline),
        clear: (key) => context.clearAlarm(key),
      });
    } catch {
      return { actions: [], diagnostics: [{ code: "belabox.polling_reconcile_failed" }] };
    }
    return { actions: [], diagnostics: [] };
  },
};
