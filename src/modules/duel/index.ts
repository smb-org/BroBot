import type { BotModule, ModuleAlarmContext, ModulePointRoundAnnouncement, ModulePointRoundResult } from "../contract";
import { DUEL_MODULE_ID, duelSettingsForLanguage, duelSettingsSchema, type DuelRoundData } from "./contracts";
import { duelCatalog } from "./locale";
import { duelAnnouncementTemplate, duelFightLine, duelResultTemplate, duelTextVariables, processDuelMessage } from "./service";
import { duelRoutes } from "./routes";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const roundData = (value: unknown): DuelRoundData | null => {
  const data = record(value);
  if (data === null || typeof data.challengerId !== "string" || typeof data.challengerLogin !== "string" ||
      !(data.targetId === null || typeof data.targetId === "string") ||
      !(data.targetLogin === null || typeof data.targetLogin === "string") || !Number.isSafeInteger(data.stake) ||
      typeof data.acceptCommand !== "string" || (data.language !== "de" && data.language !== "en") ||
      typeof data.challengeMessageId !== "string" || typeof data.fightText !== "string" || typeof data.botFightText !== "string" ||
      typeof data.botEnabled !== "boolean" || record(data.texts) === null) return null;
  return data as unknown as DuelRoundData;
};

const formatAnnouncement = async (
  context: ModuleAlarmContext,
  round: ModulePointRoundAnnouncement,
) => {
  const data = roundData(round.data);
  if (data === null) return null;
  const rendered = await context.renderTemplate(duelAnnouncementTemplate(data), duelTextVariables(data));
  return {
    text: rendered.text,
    ...(rendered.attributions === undefined ? {} : { attributions: rendered.attributions }),
    ...(data.chatTarget === null ? {} : { target: data.chatTarget }),
    replyToMessageId: data.challengeMessageId,
    ...(data.sourceBroadcasterUserId === null ? {} : { sourceBroadcasterUserId: data.sourceBroadcasterUserId }),
  };
};

const formatResult = async (context: ModuleAlarmContext, round: ModulePointRoundResult) => {
  const data = roundData(round.data);
  const result = record(round.result);
  if (data === null || result === null || result.expired === true || typeof result.winnerLogin !== "string" ||
      typeof result.loserLogin !== "string" || typeof result.bot !== "boolean") return null;
  const rendered = await context.renderTemplate(duelResultTemplate(data, result.bot), duelTextVariables(data, {
    fight: duelFightLine(data, result.bot),
    winner: result.winnerLogin,
    loser: result.loserLogin,
    net: `+${String(data.stake)}`,
    loss: `−${String(data.stake)}`,
  }));
  return {
    text: rendered.text,
    ...(rendered.attributions === undefined ? {} : { attributions: rendered.attributions }),
    ...(data.chatTarget === null ? {} : { target: data.chatTarget }),
    replyToMessageId: data.challengeMessageId,
    ...(data.sourceBroadcasterUserId === null ? {} : { sourceBroadcasterUserId: data.sourceBroadcasterUserId }),
  };
};

export const duelModule: BotModule<typeof duelSettingsSchema> = {
  id: DUEL_MODULE_ID,
  navigationCategory: "games",
  requiresModules: ["points"],
  panelIcon: { paths: ["M14.5 17.5 3 6V3h3l11.5 11.5", "m13 19 6-6", "m16 16 4 4", "m2 22 6-6", "m3 21 6 6", "M8 8l8-5 5 5-5 8"] },
  navigationEntries: [{
    id: "duel",
    label: { de: duelCatalog.de.title, en: duelCatalog.en.title },
    description: { de: duelCatalog.de.description, en: duelCatalog.en.description },
    iconKind: "duel",
    keywords: ["duel", "duell", "fight", "game", "points"],
  }],
  defaultEnabled: false,
  settingsSchema: duelSettingsSchema,
  defaultSettings: duelSettingsForLanguage("de"),
  defaultSettingsForLanguage: duelSettingsForLanguage,
  settingsEditor: () => import("./panel/settings-editor"),
  settingsEditorPlacement: "page",
  routes: duelRoutes,
  eventSubTypes: ["channel.chat.message"],
  dryRunSilentReason: "round_answers",
  pointRoundCancellationNotice: false,
  chatCommandNames: (settings) => {
    const parsed = duelSettingsSchema.safeParse(settings);
    return parsed.success ? [parsed.data.challengeCommand, parsed.data.acceptCommand] : [];
  },
  formatPointRoundAnnouncement: formatAnnouncement,
  formatPointRoundResult: formatResult,
  handleEvent: processDuelMessage,
  liveTile: {
    load: async (channelId, signal) => {
      const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/modules/duel/rounds`, { signal });
      if (!response.ok) throw new Error("duel_rounds_unavailable");
      const value: unknown = await response.json();
      return Array.isArray(value) ? value.filter((item) => {
        const row = record(item);
        return row !== null && row.kind === "duel" && typeof row.id === "string" && typeof row.challenger === "string" &&
          (row.target === null || typeof row.target === "string") && Number.isSafeInteger(row.stake) && typeof row.closesAt === "string";
      }) as never : [];
    },
  },
};

