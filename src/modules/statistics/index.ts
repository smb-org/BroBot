import { z } from "zod";

import type { BotModule } from "../contract";
import { statisticsModuleCatalog } from "./catalog";
import { statisticsRoutes } from "./routes";
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
  navigationEntries: [{
    id: "streams",
    label: { de: statisticsModuleCatalog.de.streamsLabel, en: statisticsModuleCatalog.en.streamsLabel },
    description: { de: statisticsModuleCatalog.de.streamsDescription, en: statisticsModuleCatalog.en.streamsDescription },
    showMainSwitch: false,
    iconKind: "data",
    keywords: ["stream", "streams", "verlauf", "history", "statistik", "statistics"],
  }],
  settingsSchema,
  defaultSettings: {},
  routes: statisticsRoutes,
  panel: () => import("./panel").then((panel) => ({ default: panel.StatisticsStreamsPanel })),
  eventSubTypes: ["channel.chat.message", "stream.online", "stream.offline", "channel.update"],
  handleEvent: processStatisticsEvent,
  dryRunSilentReason: "activity_tracking",
  alarms: [{
    key: "window",
    retryDelaysMs: [5_000, 15_000, 60_000],
    handle: handleStatisticsWindowAlarm,
    onScheduleInputsChanged: reconcileStatisticsSchedule,
  }],
};
