import { createBlitzQuestionRepository } from "./adapters/d1";
import type { BotModule, ModuleAlarmContext, ModulePointRoundAnnouncement, ModulePointRoundResult } from "../contract";
import { BLITZ_TEMPLATE_FIELDS, BLITZ_TEMPLATE_VARIABLES, blitzTemplateVariableGroup } from "./contracts/template-variables";
import { BLITZ_ROUND_MODULE_ID, blitzRoundSettingsSchema } from "./contracts";
import { blitzActionTexts, blitzRoundDefaultsForLanguage, blitzRoundTypeLabel, blitzTexts, formatBlitzResolutionLine } from "./locale";
import { blitzRoundRoutes } from "./routes";
import { processBlitzMessage } from "./service";
import { blitzStarterSeedStatement } from "./seed-words";
import type { BlitzRoundData } from "./contracts";
import { type BlitzWinner } from "./domain/round";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const roundData = (value: unknown): BlitzRoundData | null => {
  const data = record(value);
  return data !== null && (data.kind === "scramble" || data.kind === "quiz") &&
    typeof data.prompt === "string" && typeof data.answer === "string" &&
    Array.isArray(data.answers) && data.answers.every((answer) => typeof answer === "string") &&
    typeof data.startText === "string" && Number.isSafeInteger(data.prize) && Number.isSafeInteger(data.seconds) &&
    record(data.texts) !== null && typeof record(data.texts)?.solvedText === "string" &&
    typeof record(data.texts)?.timeoutText === "string" && (data.language === "de" || data.language === "en")
    ? data as unknown as BlitzRoundData
    : null;
};

const roundVariables = (data: BlitzRoundData, winners = "", share = 0): Record<string, string | number> => ({
  "blitz.type": blitzRoundTypeLabel(data.kind, data.language),
  "blitz.prompt": data.prompt,
  "blitz.answer": data.answer,
  "blitz.prize": data.prize,
  "blitz.seconds": data.seconds,
  "blitz.winners": winners,
  "blitz.share": share,
});

const announcementText = async (
  context: ModuleAlarmContext,
  round: ModulePointRoundAnnouncement,
): Promise<{ text: string; attributions?: readonly string[]; target?: Exclude<BlitzRoundData["chatTarget"], null> } | null> => {
  const data = roundData(round.data);
  if (data === null) return null;
  const rendered = await context.renderTemplate(round.text, roundVariables(data));
  return { text: rendered.text, ...(rendered.attributions === undefined ? {} : { attributions: rendered.attributions }), ...(data.chatTarget === null ? {} : { target: data.chatTarget }) };
};

const reconcileOpenedRound = async (context: ModuleAlarmContext, round: ModulePointRoundAnnouncement): Promise<void> => {
  const data = roundData(round.data);
  if (data === null) return;
  if (data.questionId !== undefined && data.openedAt !== undefined) {
    await createBlitzQuestionRepository(context.DB).markUsed(context.channelId, data.questionId, data.openedAt);
    await context.writeModuleAudit?.({
      channelId: context.channelId, moduleId: BLITZ_ROUND_MODULE_ID, action: "blitz_round.started",
      before: null, after: { roundId: round.roundId, questionId: data.questionId },
    }, data.openedAt, { operationId: `round:${round.roundId}:started`,
      ...(data.startedBy === undefined ? {} : { actorUserId: data.startedBy }) });
  }
};

const resultText = async (
  context: ModuleAlarmContext,
  round: ModulePointRoundResult,
): Promise<{ text: string; attributions?: readonly string[]; target?: Exclude<BlitzRoundData["chatTarget"], null> } | null> => {
  const data = roundData(round.data);
  const result = record(round.result);
  if (data === null || result === null || typeof result.answer !== "string" || !Array.isArray(result.winners) ||
      !result.winners.every((winner) => record(winner) !== null && typeof record(winner)?.accountId === "string" &&
        typeof record(winner)?.login === "string") || !Number.isSafeInteger(result.share)) return null;
  const winners = result.winners as BlitzWinner[];
  const defaultLine = formatBlitzResolutionLine({ language: data.language, answer: result.answer, winners, share: result.share as number });
  const template = winners.length === 0 ? data.texts.timeoutText : data.texts.solvedText;
  const rendered = await context.renderTemplate(template || defaultLine, roundVariables(
    { ...data, answer: result.answer },
    blitzTexts(data.language).winnerNames(winners),
    result.share as number,
  ));
  return { text: rendered.text, ...(rendered.attributions === undefined ? {} : { attributions: rendered.attributions }), ...(data.chatTarget === null ? {} : { target: data.chatTarget }) };
};

export const blitzRoundModule: BotModule<typeof blitzRoundSettingsSchema> = {
  id: BLITZ_ROUND_MODULE_ID,
  navigationCategory: "games",
  requiresModules: ["points"],
  panelIcon: { paths: ["M13 2 4 14h7l-1 8 10-13h-7l1-7Z"] },
  navigationEntries: [{
    id: "blitz_round",
    label: { de: blitzTexts("de").title, en: blitzTexts("en").title },
    description: { de: blitzTexts("de").description, en: blitzTexts("en").description },
    iconKind: "blitz",
    keywords: ["blitz", blitzTexts("de").title.toLocaleLowerCase("de-DE"), "round", "game", "word scramble", "quiz"],
  }],
  defaultEnabled: false,
  dryRunSilentReason: "round_answers",
  settingsSchema: blitzRoundSettingsSchema,
  defaultSettings: blitzRoundDefaultsForLanguage("de"),
  defaultSettingsForLanguage: blitzRoundDefaultsForLanguage,
  templateFields: BLITZ_TEMPLATE_FIELDS,
  templateContext: "event",
  templateVariableCatalog: BLITZ_TEMPLATE_VARIABLES,
  templateVariableGroup: blitzTemplateVariableGroup,
  panel: () => import("./panel"),
  panelManagesSettings: true,
  routes: blitzRoundRoutes,
  eventSubTypes: ["channel.chat.message"],
  onEnable: ({ DB, now, actor, authorizeMutation }, channelId) => [
    blitzStarterSeedStatement(DB, channelId, now, authorizeMutation(channelId, actor, now)),
  ],
  onPointRoundOpened: reconcileOpenedRound,
  formatPointRoundAnnouncement: announcementText,
  formatPointRoundResult: resultText,
  handleEvent: (event, context) => processBlitzMessage(event, context),
  actions: [{
    id: "start-blitz-round",
    name: blitzActionTexts.name,
    icon: "blitz",
    conditions: [{
      check: async ({ channelId, signal }) => {
        const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/modules/${BLITZ_ROUND_MODULE_ID}/availability`, { signal });
        if (!response.ok) throw new Error("availability_unavailable");
        const value: unknown = await response.json();
        const reason = record(value)?.reason;
        return reason === "round_running"
          ? { reason: blitzActionTexts.roundRunning }
          : reason === "question_pool_empty"
            ? { reason: blitzActionTexts.questionPoolEmpty }
            : { reason: null };
      },
    }],
    requiredRole: "operator",
    errorMessage: blitzActionTexts.error,
    execute: async ({ channelId }) => {
      const tokenResponse = await fetch("/api/csrf");
      const tokenBody: unknown = await tokenResponse.json().catch(() => null);
      const token = record(tokenBody)?.token;
      if (typeof token !== "string") throw new Error("csrf_unavailable");
      const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/modules/${BLITZ_ROUND_MODULE_ID}/start`, {
        method: "POST",
        headers: { "X-CSRF-Token": token },
      });
      const result: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof record(result)?.error === "string" ? record(result)?.error as string : "round_start_failed");
      return { message: { de: blitzActionTexts.started.de, en: blitzActionTexts.started.en } };
    },
  }],
};
