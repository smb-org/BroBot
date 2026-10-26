import type { BotModule, ModuleAlarmContext, ModulePointRoundAnnouncement, ModulePointRoundResult } from "../contract";
import { isMessageEnabled } from "../../contracts/message-enabled";
import { BOSS_FIGHT_COMMAND, BOSS_FIGHT_MODULE_ID, bossFightDefaultsForLanguage, bossFightSettingsReadSchema, bossFightSettingsSchema } from "./contracts";
import type { BossFightRoundData } from "./contracts";
import { bossFightCatalog, formatBossOutcomeLine } from "./locale";
import { bossFightRoutes } from "./routes";
import { processBossFightMessage } from "./service";
import { startBossFightNow, loadBossFightRound } from "./panel/service";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const roundData = (value: unknown): BossFightRoundData | null => {
  const data = record(value);
  if (data === null || (data.language !== "de" && data.language !== "en") || !Number.isSafeInteger(data.durationSeconds) ||
      !Number.isSafeInteger(data.baseHp) || !Number.isSafeInteger(data.hpPerAttacker) || !Number.isSafeInteger(data.damageMinimum) ||
      !Number.isSafeInteger(data.damageMaximum) || !Number.isSafeInteger(data.attackCooldownSeconds) || !Number.isSafeInteger(data.lootPool) ||
      typeof data.startText !== "string" || typeof data.defeatedText !== "string" || typeof data.timeoutText !== "string" ||
      !Number.isSafeInteger(data.attackerCount) || !Number.isSafeInteger(data.damageDealt) || !Number.isSafeInteger(data.maxHp) ||
      !Number.isSafeInteger(data.currentHp) || typeof data.defeated !== "boolean") return null;
  return data as unknown as BossFightRoundData;
};

const formatAnnouncement = async (context: ModuleAlarmContext, round: ModulePointRoundAnnouncement) => {
  const data = roundData(round.data);
  if (data === null) return null;
  if (!isMessageEnabled(data, "startText", "startTextEnabled")) return { kind: "silent" as const };
  const rendered = await context.renderTemplate(round.text);
  const copy = bossFightCatalog[data.language];
  const suffix = `${copy.attackHint} (${String(data.durationSeconds)} ${copy.seconds})`;
  const prefix = rendered.text.trim().replace(/\s+/gu, " ").slice(0, Math.max(1, 500 - suffix.length - 1));
  return {
    text: `${prefix} ${suffix}`,
    ...(rendered.attributions === undefined ? {} : { attributions: rendered.attributions }),
    ...(data.chatTarget === null ? {} : { target: data.chatTarget }),
  };
};

const formatResult = async (context: ModuleAlarmContext, round: ModulePointRoundResult) => {
  const data = roundData(round.data);
  const result = record(round.result);
  if (data === null || result === null || typeof result.defeated !== "boolean" || !Number.isSafeInteger(result.distributed) ||
      !Array.isArray(result.topDamageDealers) || !result.topDamageDealers.every((dealer) => record(dealer) !== null &&
        typeof record(dealer)?.login === "string" && Number.isSafeInteger(record(dealer)?.damage) && Number.isSafeInteger(record(dealer)?.amount)) ||
      !Number.isSafeInteger(result.otherCount)) return null;
  const textKey = result.defeated ? "defeatedText" : "timeoutText";
  const enabledKey = `${textKey}Enabled`;
  if (!isMessageEnabled(data, textKey, enabledKey)) return null;
  const rendered = await context.renderTemplate(data[textKey]);
  const topDamageDealers = result.topDamageDealers.map((dealer) => {
    const row = record(dealer);
    return { login: row?.login as string, damage: row?.damage as number, amount: row?.amount as number };
  });
  return {
    text: formatBossOutcomeLine({
      language: data.language,
      summary: rendered.text,
      topDamageDealers,
      otherCount: result.otherCount as number,
    }),
    ...(rendered.attributions === undefined ? {} : { attributions: rendered.attributions }),
    ...(data.chatTarget === null ? {} : { target: data.chatTarget }),
  };
};

const bossActionTexts = {
  name: { de: bossFightCatalog.de.actionName, en: bossFightCatalog.en.actionName },
  error: { de: bossFightCatalog.de.actionError, en: bossFightCatalog.en.actionError },
  started: { de: bossFightCatalog.de.actionStarted, en: bossFightCatalog.en.actionStarted },
  roundRunning: { de: bossFightCatalog.de.roundRunning, en: bossFightCatalog.en.roundRunning },
} as const;

export const bossFightModule: BotModule<typeof bossFightSettingsSchema> = {
  id: BOSS_FIGHT_MODULE_ID,
  navigationCategory: "games",
  requiresModules: ["points"],
  panelIcon: { paths: ["M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z", "M5 21h14"] },
  navigationEntries: [{
    id: BOSS_FIGHT_MODULE_ID,
    label: { de: bossFightCatalog.de.title, en: bossFightCatalog.en.title },
    description: { de: bossFightCatalog.de.description, en: bossFightCatalog.en.description },
    iconKind: "boss",
    keywords: ["boss", "boss fight", "bosskampf", "game", "points", "loot"],
  }],
  chatCommands: [{
    name: BOSS_FIGHT_COMMAND,
    syntax: BOSS_FIGHT_COMMAND,
    description: { de: bossFightCatalog.de.commandDescription, en: bossFightCatalog.en.commandDescription },
    minimumChatStatus: "everyone",
  }],
  defaultEnabled: false,
  settingsSchema: bossFightSettingsSchema,
  settingsReadSchema: bossFightSettingsReadSchema,
  defaultSettings: bossFightDefaultsForLanguage("de"),
  defaultSettingsForLanguage: bossFightDefaultsForLanguage,
  templateFields: { startText: [], defeatedText: [], timeoutText: [] },
  templateContext: "event",
  settingsEditor: () => import("./panel/settings-editor"),
  settingsEditorPlacement: "page",
  routes: bossFightRoutes,
  eventSubTypes: ["channel.chat.message"],
  dryRunSilentReason: "round_answers",
  pointRoundCancellationNotice: false,
  formatPointRoundAnnouncement: formatAnnouncement,
  formatPointRoundResult: formatResult,
  handleEvent: processBossFightMessage,
  actions: [{
    id: "start-boss-fight",
    name: bossActionTexts.name,
    icon: "boss",
    conditions: [{
      check: async ({ channelId, signal }) => {
        const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/modules/${BOSS_FIGHT_MODULE_ID}/availability`, { signal });
        if (!response.ok) throw new Error("availability_unavailable");
        const reason = record(await response.json())?.reason;
        return { reason: reason === "round_running" ? bossActionTexts.roundRunning : null };
      },
    }],
    requiredRole: "operator",
    errorMessage: bossActionTexts.error,
    execute: async ({ channelId }) => {
      await startBossFightNow(channelId);
      return { message: bossActionTexts.started };
    },
  }],
  liveTile: {
    load: async (channelId, signal) => {
      const round = await loadBossFightRound(channelId, signal);
      return round === null ? [] : [{ kind: "boss_fight", ...round }];
    },
  },
};
