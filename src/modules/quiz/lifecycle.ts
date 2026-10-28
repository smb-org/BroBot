import type { ModuleAlarmContext, ModulePointRoundAnnouncement, ModulePointRoundDeadline, ModulePointRoundResult, ModuleScheduleInputChangeReason, ModuleStreamState } from "../contract";
import type { QuizSessionAggregates, QuizSessionRoundData } from "./contracts";
import { endQuizPhase, pauseQuizPhase, resumeQuizPhase, scoreQuizSession, transitionQuizPhase } from "./domain/session";
import { quizCatalog } from "./locale";
import { quizRoundData } from "./service";
import { quizPhasePayload } from "./overlay/payload";

const QUESTION_ANNOUNCEMENT_LIMIT = 450;
const ANNOUNCE_RETRY_MS = 5_000;
const SETTLEMENT_RETRY_MS = 5_000;
const OFFLINE_SETTLEMENT_MS = 10 * 60_000;
const OFFLINE_TIMEOUT_PREFIX = "offline-timeout:";
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

const nextOverlayPhase = (data: QuizSessionRoundData, now = Date.now()): QuizSessionRoundData => ({
  ...data,
  phaseSequence: Number.isSafeInteger(data.phaseSequence) && (data.phaseSequence ?? -1) >= 0
    ? (data.phaseSequence as number) + 1
    : 1,
  sessionStartedAt: typeof data.sessionStartedAt === "string" && Number.isFinite(Date.parse(data.sessionStartedAt))
    ? data.sessionStartedAt
    : new Date(now).toISOString(),
});

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

const quizPhaseOverlayPayload = (data: QuizSessionRoundData): Record<string, unknown> => {
  const question = data.questions[data.questionIndex];
  const payload = quizPhasePayload(data);
  if (data.phase === "reveal" && question !== undefined && data.aggregates !== undefined) {
    payload.correctIndex = question.correctIndex;
    payload.answerDistribution = data.aggregates.answerDistribution[data.questionIndex] ?? [];
  }
  if (data.phase === "results") payload.ranking = [];
  return payload;
};

const quizCancellationPayload = (data: QuizSessionRoundData): Record<string, unknown> => ({
  sessionId: data.sessionId,
  phase: "idle",
  phaseSequence: data.phaseSequence ?? 0,
  sessionStartedAt: data.sessionStartedAt ?? new Date().toISOString(),
  });

const publishQuizOverlaySnapshot = async (context: ModuleAlarmContext): Promise<void> =>
  context.quizOverlaySnapshot.deliverPending();

const retryPendingQuizOverlayBroadcast = async (context: ModuleAlarmContext): Promise<void> => {
  const snapshot = await context.quizOverlaySnapshot.read();
  if (snapshot !== null && snapshot.lastBroadcastSequence < snapshot.sequence) {
    await publishQuizOverlaySnapshot(context);
  }
};

const persistAndPublishQuizPhase = async (
  context: ModuleAlarmContext,
  roundId: string,
  data: QuizSessionRoundData,
  deadlineAt: number | null,
): Promise<QuizSessionRoundData> => {
  const snapshot = await context.points.rounds.update(roundId, data, deadlineAt, quizPhaseOverlayPayload(data));
  const persisted = snapshot ?? await context.quizOverlaySnapshot.read();
  if (persisted === null) throw new Error("quiz_overlay_snapshot_missing");
  await publishQuizOverlaySnapshot(context);
  return { ...data, phaseSequence: persisted.sequence };
};

const persistAndPublishQuizCancellation = async (
  context: ModuleAlarmContext,
  roundId: string,
  data: QuizSessionRoundData,
): Promise<void> => {
  await context.points.rounds.cancel(roundId, quizCancellationPayload(data));
  const snapshot = await context.quizOverlaySnapshot.read();
  if (snapshot === null || snapshot.payload.sessionId !== data.sessionId || snapshot.payload.phase !== "idle") {
    throw new Error("quiz_cancellation_snapshot_missing");
  }
  await publishQuizOverlaySnapshot(context);
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
    const storedData = record(participantData);
    const stored = storedData?.answers;
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

interface QuizStreamSnapshot {
  state: ModuleStreamState;
}

const streamSnapshotFromInvocation = (invocation: unknown): QuizStreamSnapshot | null => {
  const snapshot = record(record(invocation)?.streamSnapshot);
  if (snapshot === null || (snapshot.state !== "online" && snapshot.state !== "offline" && snapshot.state !== "unknown")) return null;
  return { state: snapshot.state };
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
  return result.delivery !== "not_attempted";
};

const announceCurrentQuestion = async (
  context: ModuleAlarmContext,
  roundId: string,
  current: QuizSessionRoundData,
): Promise<void> => {
  const proposedAnnounce = nextOverlayPhase({
    ...current,
    phase: "announce",
    phaseEndsAt: null,
    paused: false,
    remainingMs: null,
  });
  const announced = await persistAndPublishQuizPhase(context, roundId, proposedAnnounce, Date.now() + ANNOUNCE_RETRY_MS);
  const delivered = await sendQuestionLine(context, roundId, announced);
  if (!delivered) return;
  const phaseOpenedAt = Date.now();
  const phaseEndsAt = phaseOpenedAt + announced.answerSeconds * 1_000;
  const proposedOpen = nextOverlayPhase({
    ...announced,
    phase: "open",
    phaseOpenedAt,
    phaseEndsAt,
  }, phaseOpenedAt);
  await persistAndPublishQuizPhase(context, roundId, proposedOpen, phaseEndsAt);
};

const showReveal = async (
  context: ModuleAlarmContext,
  roundId: string,
  current: QuizSessionRoundData,
  now: number,
): Promise<void> => {
  const score = await currentScore(context, roundId, current);
  const phase = transitionQuizPhase(current, current.questions.length, now, current.answerSeconds, current.revealSeconds);
  const proposed = nextOverlayPhase({
    ...current,
    ...phase,
    aggregates: aggregatesFrom(score),
  }, now);
  await persistAndPublishQuizPhase(context, roundId, proposed, proposed.phaseEndsAt);
};

const finishQuizSession = async (context: ModuleAlarmContext, roundId: string, current: QuizSessionRoundData): Promise<void> => {
  const score = await currentScore(context, roundId, current);
  const proposed = nextOverlayPhase({
    ...current,
    ...endQuizPhase(current),
    aggregates: aggregatesFrom(score),
    offlineSince: null,
  });
  const existingSnapshot = await context.quizOverlaySnapshot.read();
  const alreadyProvisional = existingSnapshot !== null && existingSnapshot.payload.sessionId === current.sessionId &&
    existingSnapshot.payload.phase === "results" && Array.isArray(existingSnapshot.payload.ranking) &&
    existingSnapshot.payload.ranking.length === 0 && existingSnapshot.payload.resultAt === undefined;
  if (alreadyProvisional) {
    await retryPendingQuizOverlayBroadcast(context);
  } else {
    await persistAndPublishQuizPhase(context, roundId, proposed, Date.now() + SETTLEMENT_RETRY_MS);
  }
  await context.points.rounds.resolve(roundId, { kind: "quiz", params: {} });
};

const readStoredStreamState = async (context: ModuleAlarmContext): Promise<QuizStreamSnapshot> => {
  const row = await context.DB.prepare(
    "SELECT state FROM channel_stream_state WHERE channel_id = ?",
  ).bind(context.channelId).first<{ state: ModuleStreamState }>();
  return { state: row?.state ?? "unknown" };
};

const reconcileQuizStream = async (
  context: ModuleAlarmContext,
  streamSnapshot: QuizStreamSnapshot,
): Promise<void> => {
  const active = await context.points.rounds.active();
  if (active === null) return;
  const data = quizRoundData(active.data);
  if (data === null) return;
  if (data.phase === "results") return;
  if (streamSnapshot.state === "offline") {
    const offlineSince = data.offlineSince ?? Date.now();
    const effectiveOfflinePause = data.paused
      ? data
      : { ...data, ...pauseQuizPhase(data, offlineSince) };
    const updated = nextOverlayPhase({ ...effectiveOfflinePause, offlineSince });
    const changed = !data.paused || data.offlineSince !== offlineSince || data.remainingMs !== updated.remainingMs;
    await context.schedule(`${OFFLINE_TIMEOUT_PREFIX}${active.roundId}`, offlineSince + OFFLINE_SETTLEMENT_MS, undefined, null);
    if (changed) await persistAndPublishQuizPhase(context, active.roundId, updated, null);
    return;
  }
  if (streamSnapshot.state === "online" && data.offlineSince !== null) {
    const resumedStream = nextOverlayPhase({ ...data, paused: true, phaseEndsAt: null, offlineSince: null });
    await persistAndPublishQuizPhase(context, active.roundId, resumedStream, null);
    await context.clear(`${OFFLINE_TIMEOUT_PREFIX}${active.roundId}`, undefined, null);
  }
};

const handleOfflineTimeout = async (context: ModuleAlarmContext, alarmKey: string): Promise<void> => {
  const roundId = alarmKey.slice(OFFLINE_TIMEOUT_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(roundId)) throw new Error("invalid_quiz_session");
  const active = await context.points.rounds.active();
  if (active === null || active.roundId !== roundId) {
    await context.clear(alarmKey, undefined, null);
    return;
  }
  const data = quizRoundData(active.data);
  if (data === null) return;
  const streamSnapshot = await readStoredStreamState(context);
  await reconcileQuizStream(context, streamSnapshot);
  const reconciledActive = await context.points.rounds.active();
  const reconciledData = quizRoundData(reconciledActive?.data);
  if (streamSnapshot.state !== "offline" || reconciledActive === null || reconciledActive.roundId !== roundId ||
      reconciledData === null || reconciledData.offlineSince === null) return;
  const settleAt = reconciledData.offlineSince + OFFLINE_SETTLEMENT_MS;
  if (Date.now() < settleAt) {
    await context.schedule(alarmKey, settleAt, undefined, null);
    return;
  }
  if (reconciledActive.state === "announcing") {
    await persistAndPublishQuizCancellation(context, roundId, reconciledData);
    await context.clear(alarmKey, undefined, null);
    return;
  }
  await finishQuizSession(context, roundId, reconciledData);
  await context.clear(alarmKey, undefined, null);
};

export const onQuizRoundAnnounced = async (
  context: ModuleAlarmContext,
  round: ModulePointRoundAnnouncement,
): Promise<void> => {
  await retryPendingQuizOverlayBroadcast(context);
  await reconcileQuizStream(context, await readStoredStreamState(context));
  const active = await context.points.rounds.active();
  const data = quizRoundData(active?.data);
  if (data === null || data.phase !== "announce" || active === null || active.roundId !== round.roundId || active.state !== "open" || data.paused) return;
  await announceCurrentQuestion(context, round.roundId, data);
};

export const onQuizScheduleInputsChanged = async (
  context: ModuleAlarmContext,
  reason: ModuleScheduleInputChangeReason,
): Promise<void> => {
  await retryPendingQuizOverlayBroadcast(context);
  if (reason !== "stream_state") return;
  await reconcileQuizStream(context, await readStoredStreamState(context));
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
  await retryPendingQuizOverlayBroadcast(context);
  await reconcileQuizStream(context, await readStoredStreamState(context));
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
    await retryPendingQuizOverlayBroadcast(context);
    if (alarmKey === "stream-state") {
      await reconcileQuizStream(context, streamSnapshotFromInvocation(invocation) ?? await readStoredStreamState(context));
      return;
    }
    if (alarmKey.startsWith(OFFLINE_TIMEOUT_PREFIX)) {
      await handleOfflineTimeout(context, alarmKey);
      return;
    }
    if (alarmKey === "overlay-retry") return;
    if (!/^[A-Za-z0-9_-]{1,64}$/u.test(alarmKey)) throw new Error("invalid_quiz_session");
    const request = typeof invocation === "object" && invocation !== null && !Array.isArray(invocation)
      ? invocation as Record<string, unknown> : null;
    const action = request?.action;
    if (action !== "next" && action !== "pause" && action !== "resume" && action !== "end") throw new Error("invalid_quiz_action");
    const active = await context.points.rounds.active();
    if (typeof request?.sessionId !== "string" || active === null || active.roundId !== alarmKey || active.roundId !== request.sessionId) {
      const snapshot = await context.quizOverlaySnapshot.read();
      if (action === "end" && typeof request?.sessionId === "string" && snapshot?.payload.phase === "idle" &&
          snapshot.payload.sessionId === request.sessionId) return;
      throw new Error("session_changed");
    }
    await controlQuizSession(context, action);
  },
};

const controlQuizSession = async (
  context: ModuleAlarmContext,
  action: QuizSessionAction,
): Promise<void> => {
  const streamSnapshot = await readStoredStreamState(context);
  await reconcileQuizStream(context, streamSnapshot);
  const active = await context.points.rounds.active();
  const data = quizRoundData(active?.data);
  const canControlPending = active?.state === "announcing" && (action === "end" || action === "pause" || action === "resume");
  if (active === null || (active.state !== "open" && !canControlPending) || data === null) throw new Error("round_not_running");
  if (data.phase === "results" && action !== "end") return;
  if (action !== "end" && streamSnapshot.state !== "online") throw new Error("stream_offline");
  if (action === "end" && active.state === "announcing") {
    await persistAndPublishQuizCancellation(context, active.roundId, data);
    await context.clear(`${OFFLINE_TIMEOUT_PREFIX}${active.roundId}`, undefined, null);
    return;
  }
  const now = Date.now();
  if (action === "pause") {
    if (data.paused) return;
    const paused = nextOverlayPhase({
      ...data,
      ...pauseQuizPhase(data, now),
    }, now);
    await persistAndPublishQuizPhase(context, active.roundId, paused, null);
    return;
  }
  if (action === "resume") {
    if (!data.paused) return;
    const resumed = nextOverlayPhase({
      ...data,
      ...resumeQuizPhase(data, now),
      offlineSince: null,
    }, now);
    await persistAndPublishQuizPhase(context, active.roundId, resumed, resumed.phaseEndsAt);
    await context.clear(`${OFFLINE_TIMEOUT_PREFIX}${active.roundId}`, undefined, null);
    return;
  }
  if (action === "end") {
    await finishQuizSession(context, active.roundId, data);
    return;
  }
  if (data.paused) throw new Error("quiz_session_paused");
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
  await retryPendingQuizOverlayBroadcast(context);
  const data = quizRoundData(round.data);
  const result = typeof round.result === "object" && round.result !== null && !Array.isArray(round.result)
    ? round.result as Record<string, unknown> : null;
  if (data === null || result === null || !Array.isArray(result.ranking)) return;
  const ranking = result.ranking.filter((value) => typeof value === "object" && value !== null && !Array.isArray(value))
    .map((value) => value as Record<string, unknown>);
  const sessionStartedAt = typeof data.sessionStartedAt === "string" && Number.isFinite(Date.parse(data.sessionStartedAt))
    ? data.sessionStartedAt
    : round.resolvedAt;
  const payload = {
    ...quizPhasePayload({ ...data, ...endQuizPhase(data) }),
    phase: "results",
    sessionStartedAt,
    resolvedAt: round.resolvedAt,
    resultAt: round.resolvedAt,
    ranking: ranking.slice(0, 10).map(({ login, correct, rank, payout }) => ({ login, correct, rank, payout })),
    participants: Number.isSafeInteger(result.participants) ? result.participants : 0,
    correctRate: typeof result.correctRate === "number" ? result.correctRate : 0,
    distributed: Number.isSafeInteger(result.distributed) ? result.distributed : 0,
  };
  const currentSnapshot = await context.quizOverlaySnapshot.read();
  const sameSettledResult = currentSnapshot !== null && currentSnapshot.payload.sessionId === data.sessionId &&
    currentSnapshot.payload.phase === "results" && currentSnapshot.payload.resultAt === round.resolvedAt &&
    JSON.stringify(currentSnapshot.payload.ranking) === JSON.stringify(payload.ranking);
  if (sameSettledResult) return;
  const snapshot = await context.quizOverlaySnapshot.write(payload, data.sessionId);
  if (snapshot === null) return;
  await publishQuizOverlaySnapshot(context);
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

