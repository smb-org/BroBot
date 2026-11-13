import type { BotModule } from "../contract";
import { statisticsModuleCatalog } from "./catalog";
import { wordCommandTexts } from "./locale";
import { statisticsRoutes } from "./routes";
import { handleStatisticsWindowAlarm, processStatisticsEvent, reconcileStatisticsSchedule } from "./service";
import { statisticsSettingsSchema } from "./contracts";

const settingsSchema = statisticsSettingsSchema;

const wordCountChatCommand = [{
  name: "!wort",
  syntax: "!wort <Wort>",
  syntaxByLanguage: { de: "!wort <Wort>", en: "!wort <word>" },
  description: wordCommandTexts.description,
  arguments: [{
    name: "Wort",
    nameByLanguage: { de: "Wort", en: "word" },
    hint: wordCommandTexts.argumentHint,
  }],
  minimumChatStatus: "everyone",
  minimumChatStatusSetting: "wordCommand.minimumChatStatus",
}] as const;

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
  panelManagesSettings: true,
  navigationEntries: [
    {
      id: "streams",
      label: { de: statisticsModuleCatalog.de.streamsLabel, en: statisticsModuleCatalog.en.streamsLabel },
      description: { de: statisticsModuleCatalog.de.streamsDescription, en: statisticsModuleCatalog.en.streamsDescription },
      showMainSwitch: false,
      iconKind: "data",
      keywords: ["stream", "streams", "verlauf", "history", "statistik", "statistics"],
    },
    {
      id: "trends",
      label: { de: statisticsModuleCatalog.de.trendsLabel, en: statisticsModuleCatalog.en.trendsLabel },
      description: { de: statisticsModuleCatalog.de.trendsDescription, en: statisticsModuleCatalog.en.trendsDescription },
      showMainSwitch: false,
      iconKind: "data",
      keywords: ["trends", "wochenverlauf", "heatmap", "kategorien", "categories"],
    },
    {
      id: "words",
      label: { de: statisticsModuleCatalog.de.wordsLabel, en: statisticsModuleCatalog.en.wordsLabel },
      description: { de: statisticsModuleCatalog.de.wordsDescription, en: statisticsModuleCatalog.en.wordsDescription },
      showMainSwitch: false,
      iconKind: "data",
      keywords: ["word", "words", "woerter", "chat", "haeufigste", "frequent"],
    },
  ],
  settingsSchema,
  defaultSettings: statisticsSettingsSchema.parse({}),
  chatCommands: wordCountChatCommand,
  chatCommandNames: (settings) => {
    const parsed = statisticsSettingsSchema.safeParse(settings);
    return parsed.success ? [parsed.data.wordCommand.command] : [];
  },
  chatCommandSettingsFields: ["wordCommand.command"],
  routes: statisticsRoutes,
  panel: () => import("./panel").then((panel) => ({ default: panel.StatisticsPanel })),
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
