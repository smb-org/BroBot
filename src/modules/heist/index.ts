import type { BotModule, ModuleAlarmContext, ModulePointRoundAnnouncement, ModulePointRoundResult } from "../contract";
import { isMessageEnabled } from "../../contracts/message-enabled";
import { HEIST_TEMPLATE_FIELDS, HEIST_TEMPLATE_VARIABLES, heistTemplateVariableGroup } from "./contracts/template-variables";
import { HEIST_COMMAND, HEIST_MODULE_ID, heistSettingsForLanguage, heistSettingsReadSchema, heistSettingsSchema, type HeistRoundData } from "./contracts";
import { formatHeistNames, heistCatalog } from "./locale";
import { processHeistMessage } from "./service";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const roundData = (value: unknown): HeistRoundData | null => {
  const data = record(value);
  return data !== null && (data.language === "de" || data.language === "en") &&
    Number.isSafeInteger(data.joinWindowSeconds) && (data.joinWindowSeconds as number) > 0 &&
    typeof data.startMessageId === "string" && typeof data.startText === "string" && typeof data.resultText === "string" &&
    (data.startTextEnabled === undefined || typeof data.startTextEnabled === "boolean") &&
    (data.resultTextEnabled === undefined || typeof data.resultTextEnabled === "boolean")
    ? data as unknown as HeistRoundData
    : null;
};

const oneLine = (value: string): string => {
  const compact = value.replace(/[\r\n]+/gu, " ").trim();
  const characters = Array.from(compact);
  return characters.length > 500 ? `${characters.slice(0, 499).join("")}…` : compact;
};

const formatAnnouncement = async (context: ModuleAlarmContext, round: ModulePointRoundAnnouncement) => {
  const data = roundData(round.data);
  if (data === null) return null;
  if (!isMessageEnabled(data, "startText", "startTextEnabled")) return { kind: "silent" as const };
  const rendered = await context.renderTemplate(round.text, { "heist.seconds": data.joinWindowSeconds });
  return {
    text: oneLine(rendered.text),
    ...(rendered.attributions === undefined ? {} : { attributions: rendered.attributions }),
    replyToMessageId: data.startMessageId,
    automated: false,
  };
};

const formatResult = async (context: ModuleAlarmContext, round: ModulePointRoundResult) => {
  const data = roundData(round.data);
  const result = record(round.result);
  if (data === null || result === null || !Number.isSafeInteger(result.chancePercent) || !Array.isArray(result.winners) ||
      !Array.isArray(result.losers) || !result.winners.every((value) => typeof record(value)?.login === "string") ||
      !result.losers.every((value) => typeof record(value)?.login === "string")) return null;
  if (!isMessageEnabled(data, "resultText", "resultTextEnabled")) return null;
  const winners = result.winners.flatMap((value) => {
    const login = record(value)?.login;
    return typeof login === "string" ? [login] : [];
  });
  const losers = result.losers.flatMap((value) => {
    const login = record(value)?.login;
    return typeof login === "string" ? [login] : [];
  });
  const rendered = await context.renderTemplate(data.resultText, {
    "heist.chance": result.chancePercent as number,
    "heist.winners": formatHeistNames(winners, data.language),
    "heist.losers": formatHeistNames(losers, data.language),
  });
  return {
    text: oneLine(rendered.text),
    ...(rendered.attributions === undefined ? {} : { attributions: rendered.attributions }),
    replyToMessageId: data.startMessageId,
    automated: false,
  };
};

export const heistModule: BotModule<typeof heistSettingsSchema> = {
  id: HEIST_MODULE_ID,
  navigationCategory: "games",
  requiresModules: ["points"],
  panelIcon: { paths: ["M3 10h18M5 10V5l7-3 7 3v5M5 10v10h14V10M9 20v-6h6v6"] },
  navigationEntries: [{
    id: "heist",
    label: { de: heistCatalog.de.title, en: heistCatalog.en.title },
    description: { de: heistCatalog.de.description, en: heistCatalog.en.description },
    iconKind: "heist",
    keywords: ["heist", "ueberfall", "robbery", "game", "points"],
  }],
  defaultEnabled: false,
  settingsSchema: heistSettingsSchema,
  settingsReadSchema: heistSettingsReadSchema,
  defaultSettings: heistSettingsForLanguage("de"),
  defaultSettingsForLanguage: heistSettingsForLanguage,
  settingsEditor: () => import("./panel/settings-editor"),
  settingsEditorPlacement: "page",
  templateFields: HEIST_TEMPLATE_FIELDS,
  templateContext: "event",
  templateVariableCatalog: HEIST_TEMPLATE_VARIABLES,
  templateVariableGroup: heistTemplateVariableGroup,
  eventSubTypes: ["channel.chat.message"],
  dryRunSilentReason: "round_answers",
  pointRoundCancellationNotice: false,
  retryPointRoundRateLimitedResults: true,
  chatCommandNames: () => [HEIST_COMMAND],
  formatPointRoundAnnouncement: formatAnnouncement,
  formatPointRoundResult: formatResult,
  handleEvent: processHeistMessage,
};
