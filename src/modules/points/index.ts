import type { BotModule } from "../contract";
import { DEFAULT_POINTS_SETTINGS, POINTS_MODULE_ID, pointsDefaultSettingsForLanguage, pointsSettingsSchema } from "./contracts";
import { pointsCatalog } from "./locale";
import { pointsRoutes } from "./routes";
import { processPointsMessage } from "./service";

export const pointsModule: BotModule<typeof pointsSettingsSchema> = {
  id: POINTS_MODULE_ID,
  navigationCategory: "games",
  panelIcon: { paths: [
    "M12 7c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3Z",
    "M4 4v5c0 1.7 3.6 3 8 3s8-1.3 8-3V4",
    "M4 9v5c0 1.7 3.6 3 8 3",
    "M20 9v3",
    "M7 14v5c0 1.7 2.2 3 5 3 2.8 0 5-1.3 5-3s-2.2-3-5-3",
  ] },
  navigationEntries: [{
    id: "points",
    label: { de: pointsCatalog.de.name, en: pointsCatalog.en.name },
    description: { de: pointsCatalog.de.description, en: pointsCatalog.en.description },
    iconKind: "coins",
    keywords: ["points", "punkte", "balance", "konto", "games", "spiele"],
  }],
  chatCommands: [
    { name: "!punkte", syntax: "!punkte", description: { de: pointsCatalog.de.commands.balance, en: pointsCatalog.en.commands.balance }, minimumChatStatus: "everyone" },
    { name: "!top", syntax: "!top", description: { de: pointsCatalog.de.commands.top, en: pointsCatalog.en.commands.top }, minimumChatStatus: "everyone" },
    { name: "!spiele", syntax: "!spiele", description: { de: pointsCatalog.de.commands.games, en: pointsCatalog.en.commands.games }, minimumChatStatus: "everyone" },
  ],
  defaultEnabled: false,
  settingsSchema: pointsSettingsSchema,
  defaultSettings: DEFAULT_POINTS_SETTINGS,
  defaultSettingsForLanguage: pointsDefaultSettingsForLanguage,
  panel: () => import("./panel"),
  panelManagesSettings: true,
  routes: pointsRoutes,
  eventSubTypes: ["channel.chat.message"],
  dryRunSilentReason: "activity_tracking",
  handleEvent: processPointsMessage,
};
