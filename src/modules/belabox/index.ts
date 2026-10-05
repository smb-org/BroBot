import type { BotModule } from "../contract";
import { belaboxRoutes } from "./routes";
import {
  BELABOX_DEFAULT_SETTINGS,
  BELABOX_MODULE_ID,
  BELABOX_POLL_ALARM_KEY,
  belaboxSettingsSchema,
} from "./contracts";
import { startBelaboxStream, stopBelaboxPolling } from "./adapters/d1";
import { handleBelaboxPollAlarm, reconcileBelaboxPollSchedule } from "./service";

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
  settingsChangedAlarm: { handlerKey: BELABOX_POLL_ALARM_KEY, alarmKey: BELABOX_POLL_ALARM_KEY },
  alarms: [{
    key: BELABOX_POLL_ALARM_KEY,
    handle: handleBelaboxPollAlarm,
    onScheduleInputsChanged: reconcileBelaboxPollSchedule,
  }],
  routes: belaboxRoutes,
  panel: () => import("./panel/index"),
  settingsEditor: () => import("./panel/settings-editor"),
  handleEvent: async (event, context) => {
    if (context.streamStateTransitionAccepted !== true) return { actions: [], diagnostics: [] };
    if (event.subscriptionType === "stream.offline") {
      const revision = await stopBelaboxPolling(context.DB, event.channelId, true);
      await context.clearAlarm(BELABOX_POLL_ALARM_KEY, revision);
      return { actions: [], diagnostics: [] };
    }
    if (event.subscriptionType === "stream.online" && event.settings.mode === "interval") {
      const payloadStreamId: unknown = event.payload.id;
      const streamId = typeof payloadStreamId === "string" && payloadStreamId.length > 0 ? payloadStreamId : null;
      const revision = await startBelaboxStream(context.DB, event.channelId, streamId);
      await context.scheduleAlarm(BELABOX_POLL_ALARM_KEY, BELABOX_POLL_ALARM_KEY, Date.now(), revision);
    }
    return { actions: [], diagnostics: [] };
  },
};
