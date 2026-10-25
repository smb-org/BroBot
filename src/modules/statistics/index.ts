import { z } from "zod";

import type { BotModule } from "../contract";
import { statisticsModuleCatalog } from "./catalog";
import { handleStatisticsWindowAlarm, processStatisticsEvent, reconcileStatisticsSchedule } from "./service";

const settingsSchema = z.object({});

export const statisticsModule: BotModule<typeof settingsSchema> = {
  id: "statistics",
  navigationCategory: "data",
  panelIcon: { paths: ["M4 19h16", "M7 16V9", "M12 16V5", "M17 16v-4"] },
  mandatory: true,
  mandatoryReason: {
    de: statisticsModuleCatalog.de.mandatoryReason,
    en: statisticsModuleCatalog.en.mandatoryReason,
  },
  needsActiveChatters: true,
  settingsSchema,
  defaultSettings: {},
  eventSubTypes: ["channel.chat.message", "stream.online", "stream.offline"],
  handleEvent: processStatisticsEvent,
  dryRunSilentReason: "activity_tracking",
  alarms: [{
    key: "window",
    retryDelaysMs: [5_000, 15_000, 60_000],
    handle: handleStatisticsWindowAlarm,
    onScheduleInputsChanged: reconcileStatisticsSchedule,
  }],
};
