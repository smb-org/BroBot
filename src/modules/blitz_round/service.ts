import { blitzRoundSettingsSchema, BLITZ_GRACE_SECONDS, BLITZ_ROUND_MODULE_ID } from "./contracts";
import type { BlitzQuestion, BlitzRoundData, BlitzRoundSettings } from "./contracts";
import type { BlitzQuestionRepository } from "./repository";
import type { ModuleEvent, ModuleExecutionContext, ModuleLanguage, ModulePointsAccess, ModuleResult } from "../contract";
import { scrambleBlitzWord } from "./domain/round";
import { blitzAnswerMatches } from "./domain/chat";

export const loadEnabledBlitzSettings = async (db: D1Database, channelId: string): Promise<BlitzRoundSettings | null> => {
  const row = await db.prepare(
    "SELECT settings FROM channel_modules WHERE channel_id = ? AND module_id = ? AND enabled = 1",
  ).bind(channelId, BLITZ_ROUND_MODULE_ID).first<{ settings: string }>();
  if (row === null) return null;
  try {
    const parsed: unknown = JSON.parse(row.settings);
    const settings = blitzRoundSettingsSchema.safeParse(parsed);
    return settings.success ? settings.data : null;
  } catch {
    return null;
  }
};

export interface OpenBlitzRoundInput {
  channelId: string;
  startedBy?: string;
  settings: BlitzRoundSettings;
  language: ModuleLanguage;
  points: ModulePointsAccess;
  repository: BlitzQuestionRepository;
}

export interface OpenedBlitzRound {
  roundId: string;
  question: BlitzQuestion;
  data: BlitzRoundData;
}

export const openBlitzRound = async (input: OpenBlitzRoundInput): Promise<OpenedBlitzRound> => {
  const question = await input.repository.pick(input.channelId);
  if (question === null) throw new Error("question_pool_empty");
  const answer = question.kind === "scramble" ? question.prompt : question.answers[0];
  if (answer === undefined) throw new Error("question_invalid");
  const prompt = question.kind === "scramble" ? scrambleBlitzWord(question.prompt) : question.prompt;
  const openedAt = new Date().toISOString();
  const data: BlitzRoundData = {
    questionId: question.id,
    openedAt,
    ...(input.startedBy === undefined ? {} : { startedBy: input.startedBy }),
    kind: question.kind,
    prompt,
    answer,
    answers: [...question.answers],
    prize: input.settings.prize,
    seconds: input.settings.answerTimeSeconds,
    texts: { solvedText: input.settings.solvedText, timeoutText: input.settings.timeoutText },
    language: input.language,
    chatTarget: input.settings.chatTarget,
    startText: input.settings.startText,
  };
  const roundId = crypto.randomUUID();
  await input.points.rounds.open(roundId, {
    ...data,
    durationS: input.settings.answerTimeSeconds,
    announceText: input.settings.startText,
    settlement: { kind: "blitz", params: { prize: input.settings.prize } },
  });
  // The persisted announcement also reconciles this write after interruption.
  try {
    await input.repository.markUsed(input.channelId, question.id, openedAt);
  } catch {
    console.warn("Blitz question use will be reconciled by the round announcement.");
  }
  return { roundId, question, data };
};

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

export const processBlitzMessage = async (
  event: ModuleEvent<BlitzRoundSettings>,
  context: Pick<ModuleExecutionContext, "points" | "botUserId">,
): Promise<ModuleResult> => {
  if (event.subscriptionType !== "channel.chat.message") return { actions: [], diagnostics: [] };
  const payload = event.payload;
  const userId = payload.chatter_user_id;
  const login = payload.chatter_user_login;
  const message = record(payload.message)?.text;
  const messageId = payload.message_id;
  if (typeof userId !== "string" || typeof login !== "string" || typeof message !== "string" ||
      typeof messageId !== "string" || messageId.length === 0) return { actions: [], diagnostics: [] };
  if (await context.botUserId?.() === userId) return { actions: [], diagnostics: [] };
  const sourceBroadcasterId = payload.source_broadcaster_user_id;
  if (typeof sourceBroadcasterId === "string" && sourceBroadcasterId !== event.channelId) return { actions: [], diagnostics: [] };
  const active = await context.points.rounds.active();
  if (active === null || active.state !== "open") return { actions: [], diagnostics: [] };
  const data = record(active.data) as Partial<BlitzRoundData> | null;
  if (data === null || !Array.isArray(data.answers) || !data.answers.every((answer) => typeof answer === "string") ||
      !blitzAnswerMatches(message, data.answers)) return { actions: [], diagnostics: [] };
  await context.points.rounds.answer(active.roundId, `msg:${messageId}`, userId, login, BLITZ_GRACE_SECONDS);
  return { actions: [], diagnostics: [] };
};
