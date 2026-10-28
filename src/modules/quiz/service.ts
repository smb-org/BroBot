import type { ModuleEvent, ModuleExecutionContext, ModuleLanguage, ModulePointsAccess, ModuleResult } from "../contract";
import type { QuizSet, QuizSettings, QuizSessionQuestion, QuizSessionRoundData } from "./contracts";
import { quizSettingsSchema } from "./contracts";

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

export const quizRoundData = (value: unknown): QuizSessionRoundData | null => {
  const data = record(value);
  if (data === null || typeof data.sessionId !== "string" || typeof data.setId !== "string" || typeof data.setName !== "string" ||
      (data.language !== "de" && data.language !== "en") || typeof data.chatQuestions !== "boolean" ||
      !Number.isSafeInteger(data.pot) || (data.pot as number) < 0 || !Number.isSafeInteger(data.answerSeconds) ||
      !Number.isSafeInteger(data.revealSeconds) || !Array.isArray(data.questions) || data.questions.length === 0 ||
      !Number.isSafeInteger(data.questionIndex) || typeof data.paused !== "boolean" ||
      !(data.phaseEndsAt === null || Number.isSafeInteger(data.phaseEndsAt)) ||
      !(data.phaseOpenedAt === null || Number.isSafeInteger(data.phaseOpenedAt)) ||
      !(data.remainingMs === null || Number.isSafeInteger(data.remainingMs)) ||
      !(data.offlineSince === undefined || data.offlineSince === null || Number.isSafeInteger(data.offlineSince)) ||
      !["announce", "open", "reveal", "results"].includes(String(data.phase))) return null;
  if (!data.questions.every((value) => {
    const question = record(value);
    return question !== null && typeof question.text === "string" && Array.isArray(question.options) &&
      question.options.length >= 2 && question.options.length <= 4 && question.options.every((option) => typeof option === "string") &&
      Number.isSafeInteger(question.correctIndex) && (question.correctIndex as number) >= 0 &&
      (question.correctIndex as number) < question.options.length;
  })) return null;
  if ((data.questionIndex as number) < 0 || (data.questionIndex as number) >= data.questions.length) return null;
  return {
    ...data,
    offlineSince: Number.isSafeInteger(data.offlineSince) ? data.offlineSince as number : null,
  } as unknown as QuizSessionRoundData;
};

export const loadEnabledQuizSettings = async (db: D1Database, channelId: string): Promise<QuizSettings | null> => {
  const row = await db.prepare(
    "SELECT settings FROM channel_modules WHERE channel_id = ? AND module_id = ? AND enabled = 1",
  ).bind(channelId, "quiz").first<{ settings: string }>();
  if (row === null) return null;
  try {
    const parsed: unknown = JSON.parse(row.settings);
    const settings = quizSettingsSchema.safeParse(parsed);
    return settings.success ? settings.data : null;
  } catch {
    return null;
  }
};

export interface OpenQuizSessionInput {
  set: Pick<QuizSet, "id" | "name" | "questions">;
  questionCount?: number | null;
  settings: QuizSettings;
  language: ModuleLanguage;
  points: ModulePointsAccess;
}

export interface OpenQuizSessionResult {
  sessionId: string;
  data: QuizSessionRoundData;
}

export const openQuizSession = async (input: OpenQuizSessionInput): Promise<OpenQuizSessionResult> => {
  const enabledQuestions = input.set.questions.filter(({ enabled }) => enabled);
  if (enabledQuestions.length === 0) throw new Error("question_pool_empty");
  const requestedCount = input.questionCount ?? enabledQuestions.length;
  if (!Number.isSafeInteger(requestedCount) || requestedCount < 1 || requestedCount > enabledQuestions.length) {
    throw new Error("question_count_invalid");
  }
  const questions: QuizSessionQuestion[] = enabledQuestions.slice(0, requestedCount).map(({ text, options, correctIndex }) => ({
    text,
    options: [...options],
    correctIndex,
  }));
  const sessionId = crypto.randomUUID();
  const data: QuizSessionRoundData = {
    sessionId,
    setId: input.set.id,
    setName: input.set.name,
    language: input.language,
    chatQuestions: input.settings.chatQuestions,
    pot: input.settings.pot,
    answerSeconds: input.settings.answerSeconds,
    revealSeconds: input.settings.revealSeconds,
    questions,
    phase: "announce",
    questionIndex: 0,
    phaseEndsAt: null,
    paused: false,
    remainingMs: null,
    phaseOpenedAt: null,
    offlineSince: null,
  };
  await input.points.rounds.open(sessionId, {
    ...data,
    resolveOperationId: `quiz:${sessionId}:resolve`,
    durationS: input.settings.answerSeconds,
    announceText: input.settings.chatQuestions ? "quiz" : "",
    silentAnnouncement: !input.settings.chatQuestions,
    settlement: { kind: "quiz", params: {} },
  });
  return { sessionId, data };
};

export const processQuizMessage = async (
  event: ModuleEvent<QuizSettings>,
  context: Pick<ModuleExecutionContext, "points" | "botUserId">,
): Promise<ModuleResult> => {
  if (event.subscriptionType !== "channel.chat.message") return { actions: [], diagnostics: [] };
  const payload = event.payload;
  const accountId = payload.chatter_user_id;
  const login = payload.chatter_user_login;
  const messageId = payload.message_id;
  const message = record(payload.message)?.text;
  if (typeof accountId !== "string" || typeof login !== "string" || typeof messageId !== "string" || messageId.length === 0 ||
      typeof message !== "string" || !/^[1-4]$/u.test(message)) return { actions: [], diagnostics: [] };
  if (await context.botUserId?.() === accountId) return { actions: [], diagnostics: [] };
  const sourceBroadcasterId = payload.source_broadcaster_user_id;
  if (typeof sourceBroadcasterId === "string" && sourceBroadcasterId !== event.channelId) return { actions: [], diagnostics: [] };

  const active = await context.points.rounds.active();
  const data = quizRoundData(active?.data);
  if (active === null || active.state !== "open" || active.deadlineAt === null || data === null || data.paused || data.phase !== "open") {
    return { actions: [], diagnostics: [] };
  }
  const question = data.questions[data.questionIndex];
  if (question === undefined) return { actions: [], diagnostics: [] };
  const choice = Number(message) - 1;
  if (choice < 0 || choice >= question.options.length) return { actions: [], diagnostics: [] };
  const messageAt = Date.parse(event.eventSubTimestamp ?? event.receivedAt);
  if (!Number.isSafeInteger(messageAt) || messageAt < 0 || messageAt > Date.now() + 5_000 || messageAt >= active.deadlineAt) {
    return { actions: [], diagnostics: [] };
  }
  await context.points.rounds.answerChoice(
    active.roundId,
    `quiz:${active.roundId}:q${String(data.questionIndex)}:message:${messageId}`,
    accountId,
    login,
    data.questionIndex,
    choice,
    messageAt,
  );
  return { actions: [], diagnostics: [] };
};

