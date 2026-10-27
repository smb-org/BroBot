import type { ModuleAlarmContext, ModulePointRoundAnnouncement, ModulePointRoundDeadline, ModulePointRoundResult } from "../contract";
import type { QuizSessionAggregates, QuizSessionRoundData } from "./contracts";
import { endQuizPhase, pauseQuizPhase, resumeQuizPhase, scoreQuizSession, transitionQuizPhase } from "./domain/session";
import { quizCatalog } from "./locale";
import { quizRoundData } from "./service";

const QUESTION_ANNOUNCEMENT_LIMIT = 450;
const ANNOUNCE_RETRY_MS = 5_000;
const SETTLEMENT_RETRY_MS = 5_000;
const OFFLINE_SETTLEMENT_MS = 10 * 60_000;
const OFFLINE_TIMEOUT_PREFIX = "offline-timeout:";
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const truncate = (value: string, maximum: number): string => {
  if (value.length <= maximum) return value;
  if (maximum <= 1) return "…";
  return `${value.slice(0, maximum - 1)}…`;
};

const quizQuestionLine = (data: QuizSessionRoundData, questionIndex = data.questionIndex): string => {
  const question = data.questions[questionIndex];
  if (question === undefined) return "";
  const catalog = quizCatalog[data.language];
  const base = catalog.questionLine(questionIndex + 1, data.questions.length, question.text, []);
  const optionPrefix = base.endsWith(" · ") ? base : `${base} · `;
  const remaining = Math.max(0, QUESTION_ANNOUNCEMENT_LIMIT - optionPrefix.length);
  const separators = Math.max(0, question.options.length - 1) * 3;
  const perOption = Math.max(1, Math.floor((remaining - separators - question.options.length * 4) / question.options.length));
  const options = question.options.map((option) => truncate(option, Math.min(80, perOption)));
  return truncate(catalog.questionLine(questionIndex + 1, data.questions.length, question.text, options), QUESTION_ANNOUNCEMENT_LIMIT);
};

export const quizPhasePayload = (data: QuizSessionRoundData): Record<string, unknown> => {
  const question = data.questions[data.questionIndex];
  return {
    sessionId: data.sessionId,
    questionIndex: data.questionIndex,
    questionCount: data.questions.length,
    question: question?.text ?? "",
    options: question === undefined ? [] : [...question.options],
    phase: data.phase,
    phaseEndsAt: data.phaseEndsAt === null ? null : new Date(data.phaseEndsAt).toISOString(),
    paused: data.paused,
    remainingMs: data.paused ? data.remainingMs : null,
  };
};

const publishQuizPhase = async (context: ModuleAlarmContext, data: QuizSessionRoundData): Promise<void> => {
  const question = data.questions[data.questionIndex];
  const payload = quizPhasePayload(data);
  if (data.phase === "reveal" && question !== undefined && data.aggregates !== undefined) {
    payload.correctIndex = question.correctIndex;
    payload.answerDistribution = data.aggregates.answerDistribution[data.questionIndex] ?? [];
  }
  await context.publishModuleOverlayMessage("phase", "quiz.session", payload);
};

const aggregatesFrom = (
  score: ReturnType<typeof scoreQuizSession>,
): QuizSessionAggregates => ({
  participants: score.participants,
  correctCounts: [...score.correctCounts],
  answerDistribution: score.answerDistribution.map((counts) => [...counts]),
  totalAnswers: score.totalAnswers,
  totalCorrect: score.totalCorrect,
  correctRate: score.correctRate,
  distributed: score.distributed,
  houseRemainder: score.houseRemainder,
});

const currentScore = async (context: ModuleAlarmContext, roundId: string, data: QuizSessionRoundData) => {
  const participants = await context.points.rounds.participantRecords(roundId);
  return scoreQuizSession(data.questions, participants.map(({ accountId, login, data: participantData }) => {
    const stored = record(participantData)?.answers;
    return {
      accountId,
      login,
      answers: Array.isArray(stored) ? stored.map((answer) => Number.isSafeInteger(answer) ? answer as number : null) : [],
    };
  }), data.pot);
};

const activeRoundIs = async (context: ModuleAlarmContext, roundId: string, phase?: string, questionIndex?: number): Promise<boolean> => {
  const active = await context.points.rounds.active();
  const data = quizRoundData(active?.data);
  return active !== null && active.roundId === roundId && active.state === "open" && data !== null &&
    (phase === undefined || data.phase === phase) &&
    (questionIndex === undefined || data.questionIndex === questionIndex);
};

const sendQuestionLine = async (
  context: ModuleAlarmContext,
  roundId: string,
  data: QuizSessionRoundData,
): Promise<boolean> => {
  if (!data.chatQuestions) return true;
  const text = quizQuestionLine(data);
  if (text.length === 0) return false;
  const result = await context.sendChat(
    text,
    `quiz:${data.sessionId}:question:${String(data.questionIndex)}`,
    [],
    () => activeRoundIs(context, roundId, "announce", data.questionIndex),
  );
  if (result.reason === "stale_before_send") return false;
  if (result.retryable || result.delivery === "failed" || result.delivery === "rate_limited") {
    throw new Error("quiz_question_waiting_for_chat");
  }
  return true;
};

const announceCurrentQuestion = async (
  context: ModuleAlarmContext,
  roundId: string,
  current: QuizSessionRoundData,
): Promise<void> => {
  const announced: QuizSessionRoundData = {
    ...current,
    phase: "announce",
    phaseEndsAt: null,
    paused: false,
    remainingMs: null,
  };
  await context.points.rounds.update(roundId, announced, Date.now() + ANNOUNCE_RETRY_MS);
  await publishQuizPhase(context, announced);
  const delivered = await sendQuestionLine(context, roundId, announced);
  if (!delivered) return;
  const phaseOpenedAt = Date.now();
  const phaseEndsAt = phaseOpenedAt + announced.answerSeconds * 1_000;
  const opened: QuizSessionRoundData = {
    ...announced,
    phase: "open",
    phaseOpenedAt,
    phaseEndsAt,
  };
  await context.points.rounds.update(roundId, opened, phaseEndsAt);
  await publishQuizPhase(context, opened);
};

const showReveal = async (
  context: ModuleAlarmContext,
  roundId: string,
  current: QuizSessionRoundData,
  now: number,
): Promise<void> => {
  const score = await currentScore(context, roundId, current);
  const phase = transitionQuizPhase(current, current.questions.length, now, current.answerSeconds, current.revealSeconds);
  const data: QuizSessionRoundData = {
    ...current,
    ...phase,
    aggregates: aggregatesFrom(score),
  };
  await context.points.rounds.update(roundId, data, data.phaseEndsAt);
  await publishQuizPhase(context, data);
};

const finishQuizSession = async (context: ModuleAlarmContext, roundId: string, current: QuizSessionRoundData): Promise<void> => {
  const score = await currentScore(context, roundId, current);
  const data: QuizSessionRoundData = {
    ...current,
    ...endQuizPhase(current),
    aggregates: aggregatesFrom(score),
    offlineSince: null,
  };
  await context.points.rounds.update(roundId, data, Date.now() + SETTLEMENT_RETRY_MS);
  await context.points.rounds.resolve(roundId, { kind: "quiz", params: {} });
};

const readStoredStreamState = async (context: ModuleAlarmContext): Promise<{ state: string; changedAt: string | null }> => {
  const row = await context.DB.prepare(
    "SELECT state, changed_at FROM channel_stream_state WHERE channel_id = ?",
  ).bind(context.channelId).first<{ state: string; changed_at: string }>();
  return { state: row?.state ?? "unknown", changedAt: row?.changed_at ?? null };
};

const applyOfflinePause = async (
  context: ModuleAlarmContext,
  active: NonNullable<Awaited<ReturnType<typeof context.points.rounds.active>>>,
  data: QuizSessionRoundData,
  offlineSince: number,
): Promise<void> => {
  if (active.state !== "open") {
    await context.schedule("stream-state", Date.now() + ANNOUNCE_RETRY_MS, undefined, null);
    return;
  }
  const paused = data.paused ? data : { ...data, ...pauseQuizPhase(data, Date.now()) };
  const updated = { ...paused, offlineSince };
  if (!data.paused || data.offlineSince !== offlineSince) {
    await context.points.rounds.update(active.roundId, updated, null);
    await publishQuizPhase(context, updated);
  }
  await context.schedule(`${OFFLINE_TIMEOUT_PREFIX}${active.roundId}`, offlineSince + OFFLINE_SETTLEMENT_MS, undefined, null);
};

const reconcileQuizStreamState = async (context: ModuleAlarmContext): Promise<void> => {
  const [stream, active] = await Promise.all([
    readStoredStreamState(context),
    context.points.rounds.active(),
  ]);
  if (active === null) return;
  const data = quizRoundData(active.data);
  if (data === null) return;
  if (stream.state === "offline") {
    const changedAt = stream.changedAt === null ? Number.NaN : Date.parse(stream.changedAt);
    const offlineSince = Number.isSafeInteger(changedAt) ? changedAt : Date.now();
    await applyOfflinePause(context, active, data, offlineSince);
    return;
  }
  if (stream.state === "online" && data.offlineSince !== null && active.state === "open") {
    const resumedStream: QuizSessionRoundData = { ...data, paused: true, phaseEndsAt: null, offlineSince: null };
    await context.points.rounds.update(active.roundId, resumedStream, null);
    await context.clear(`${OFFLINE_TIMEOUT_PREFIX}${active.roundId}`, undefined, null);
    await publishQuizPhase(context, resumedStream);
  }
};

const handleOfflineTimeout = async (context: ModuleAlarmContext, alarmKey: string): Promise<void> => {
  const roundId = alarmKey.slice(OFFLINE_TIMEOUT_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(roundId)) throw new Error("invalid_quiz_session");
  const active = await context.points.rounds.active();
  if (active === null || active.roundId !== roundId) return;
  const data = quizRoundData(active.data);
  if (data === null) return;
  const stream = await readStoredStreamState(context);
  if (stream.state !== "offline" || data.offlineSince === null) {
    if (stream.state === "online" && data.offlineSince !== null && active.state === "open") {
      await reconcileQuizStreamState(context);
    }
    return;
  }
  const settleAt = data.offlineSince + OFFLINE_SETTLEMENT_MS;
  if (Date.now() < settleAt) {
    await context.schedule(alarmKey, settleAt, undefined, null);
    return;
  }
  if (active.state !== "open") {
    await context.schedule("stream-state", Date.now() + ANNOUNCE_RETRY_MS, undefined, null);
    return;
  }
  await finishQuizSession(context, roundId, data);
};

export const onQuizRoundAnnounced = async (
  context: ModuleAlarmContext,
  round: ModulePointRoundAnnouncement,
): Promise<void> => {
  const active = await context.points.rounds.active();
  const data = quizRoundData(active?.data);
  if (data === null || data.phase !== "announce" || active === null || active.roundId !== round.roundId || active.state !== "open" || data.paused) return;
  const stream = await readStoredStreamState(context);
  if (stream.state === "offline") {
    const changedAt = stream.changedAt === null ? Number.NaN : Date.parse(stream.changedAt);
    await applyOfflinePause(context, active, data, Number.isSafeInteger(changedAt) ? changedAt : Date.now());
    return;
  }
  await announceCurrentQuestion(context, round.roundId, data);
};

export const formatQuizPointRoundAnnouncement = (
  _context: ModuleAlarmContext,
  round: ModulePointRoundAnnouncement,
): Promise<{ kind: "silent" } | { text: string } | null> => {
  const data = quizRoundData(round.data);
  return Promise.resolve(data === null ? null : data.chatQuestions
    ? { text: quizCatalog[data.language].startLine(data.setName, data.questions.length) }
    : { kind: "silent" });
};

export const onQuizRoundDeadline = async (
  context: ModuleAlarmContext,
  round: ModulePointRoundDeadline,
): Promise<void> => {
  const active = await context.points.rounds.active();
  const data = quizRoundData(active?.data);
  if (data === null || active === null || active.roundId !== round.roundId || active.state !== "open" || data.paused) return;
  const now = Date.now();
  if (active.deadlineAt !== null && active.deadlineAt > now) return;
  if (data.phase === "open") {
    await showReveal(context, round.roundId, data, now);
    return;
  }
  if (data.phase === "reveal") {
    const next = transitionQuizPhase(data, data.questions.length, now, data.answerSeconds, data.revealSeconds);
    if (next.phase === "results") await finishQuizSession(context, round.roundId, { ...data, ...next });
    else await announceCurrentQuestion(context, round.roundId, { ...data, ...next });
    return;
  }
  if (data.phase === "announce") {
    await announceCurrentQuestion(context, round.roundId, data);
    return;
  }
  await finishQuizSession(context, round.roundId, data);
};

type QuizSessionAction = "next" | "pause" | "resume" | "end";

export const quizSessionControlAlarm = {
  key: "session-control",
  handle: async (context: ModuleAlarmContext, alarmKey: string, _deadline: number, _revision?: number, invocation?: unknown): Promise<void> => {
    if (alarmKey === "stream-state") {
      await reconcileQuizStreamState(context);
      return;
    }
    if (alarmKey.startsWith(OFFLINE_TIMEOUT_PREFIX)) {
      await handleOfflineTimeout(context, alarmKey);
      return;
    }
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(alarmKey)) throw new Error("invalid_quiz_session");
    const request = typeof invocation === "object" && invocation !== null && !Array.isArray(invocation)
      ? invocation as Record<string, unknown> : null;
    const action = request?.action;
    if (action !== "next" && action !== "pause" && action !== "resume" && action !== "end") throw new Error("invalid_quiz_action");
    const active = await context.points.rounds.active();
    if (active === null || active.roundId !== alarmKey) throw new Error("round_not_running");
    await controlQuizSession(context, action);
  },
};

const controlQuizSession = async (
  context: ModuleAlarmContext,
  action: QuizSessionAction,
): Promise<void> => {
  const active = await context.points.rounds.active();
  const data = quizRoundData(active?.data);
  if (active === null || active.state !== "open" || data === null) throw new Error("round_not_running");
  const now = Date.now();
  if (action === "pause") {
    if (data.paused) return;
    const paused = { ...data, ...pauseQuizPhase(data, now) };
    await context.points.rounds.update(active.roundId, paused, null);
    await publishQuizPhase(context, paused);
    return;
  }
  if (action === "resume") {
    if (!data.paused) return;
    const resumed = { ...data, ...resumeQuizPhase(data, now), offlineSince: null };
    await context.points.rounds.update(active.roundId, resumed, resumed.phaseEndsAt);
    await context.clear(`${OFFLINE_TIMEOUT_PREFIX}${active.roundId}`, undefined, null);
    await publishQuizPhase(context, resumed);
    return;
  }
  if (action === "end") {
    await finishQuizSession(context, active.roundId, data);
    return;
  }
  if (data.phase === "open") {
    await showReveal(context, active.roundId, data, now);
  } else if (data.phase === "reveal") {
    const next = transitionQuizPhase(data, data.questions.length, now, data.answerSeconds, data.revealSeconds);
    if (next.phase === "results") await finishQuizSession(context, active.roundId, { ...data, ...next });
    else await announceCurrentQuestion(context, active.roundId, { ...data, ...next });
  } else if (data.phase === "announce") {
    await announceCurrentQuestion(context, active.roundId, data);
  }
};

export const onQuizRoundResolved = async (
  context: ModuleAlarmContext,
  round: ModulePointRoundResult,
): Promise<void> => {
  const data = quizRoundData(round.data);
  const result = typeof round.result === "object" && round.result !== null && !Array.isArray(round.result)
    ? round.result as Record<string, unknown> : null;
  if (data === null || result === null || !Array.isArray(result.ranking)) return;
  const ranking = result.ranking.filter((value) => typeof value === "object" && value !== null && !Array.isArray(value))
    .map((value) => value as Record<string, unknown>);
  await context.publishModuleOverlayMessage("results", "quiz.session", {
    ...quizPhasePayload({ ...data, ...endQuizPhase(data) }),
    phase: "results",
    ranking: ranking.slice(0, 10).map(({ login, correct, rank, payout }) => ({ login, correct, rank, payout })),
    participants: Number.isSafeInteger(result.participants) ? result.participants : 0,
    correctRate: typeof result.correctRate === "number" ? result.correctRate : 0,
    distributed: Number.isSafeInteger(result.distributed) ? result.distributed : 0,
  });
};

export const resultChatLine = (language: "de" | "en", result: unknown): string | null => {
  const value = typeof result === "object" && result !== null && !Array.isArray(result) ? result as Record<string, unknown> : null;
  if (value === null || !Array.isArray(value.ranking) || !Number.isSafeInteger(value.distributed)) return null;
  const ranking = value.ranking.filter((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry))
    .slice(0, 3)
    .map((entry) => entry as Record<string, unknown>)
    .filter((entry) => typeof entry.login === "string" && Number.isSafeInteger(entry.correct) &&
      Number.isSafeInteger(entry.payout) && Number.isSafeInteger(entry.rank))
    .map((entry) => ({ login: entry.login as string, correct: entry.correct as number, payout: entry.payout as number, rank: entry.rank as number }));
  return quizCatalog[language].resultLine(ranking, value.distributed as number);
};

