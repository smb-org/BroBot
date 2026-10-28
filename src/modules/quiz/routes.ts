import { Hono, type Context } from "hono";

import { canManage, hasRequiredChannelRole, type AuditAction } from "../../contracts/values";
import type { ModuleRouteEnvironment } from "../contract";
import {
  QUIZ_MODULE_ID,
  QUIZ_SET_MAXIMUM_COUNT,
  type QuizSet,
  type QuizSetInput,
} from "./contracts";
import { createQuizSetRepository } from "./adapters/d1";
import { validateQuizSet } from "./domain/sets";
import { loadEnabledQuizSettings, openQuizSession, quizRoundData } from "./service";
import { quizPhasePayload, quizSessionControlAlarm } from "./lifecycle";
import { QUIZ_RESULTS_DISPLAY_MS } from "./overlay/state";

type QuizRouteContext = Context<ModuleRouteEnvironment>;
const body = async (request: Request): Promise<unknown> => request.json().catch(() => null);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const channelIdFrom = (context: QuizRouteContext): string => context.req.param("channelId") ?? "";
const repository = (context: QuizRouteContext) => createQuizSetRepository(context.env.DB);
const denied = (context: QuizRouteContext): Response => context.json({ error: "quiz_management_denied" }, 403);
const nowIso = (): string => new Date().toISOString();
const auditSnapshot = (set: QuizSet) => ({ setId: set.id, name: set.name, revision: set.revision, questionCount: set.questions.length });
export const quizRoutes = new Hono<ModuleRouteEnvironment>();

const streamIsOnline = async (db: D1Database, channelId: string): Promise<boolean> =>
  (await db.prepare("SELECT state FROM channel_stream_state WHERE channel_id = ?")
    .bind(channelId).first<{ state: string }>())?.state === "online";

const hasEnabledQuestions = async (db: D1Database, channelId: string): Promise<boolean> =>
  (await db.prepare(
    `SELECT EXISTS(
       SELECT 1 FROM quiz_questions AS question
       JOIN quiz_sets AS quiz_set ON quiz_set.set_id = question.set_id
       WHERE quiz_set.channel_id = ? AND question.enabled = 1
     ) AS present`,
  ).bind(channelId).first<{ present: number }>())?.present === 1;

quizRoutes.get("/session/sets", async (context) => {
  const rows = await context.env.DB.prepare(
    `SELECT quiz_set.set_id AS id, quiz_set.name, COUNT(question.position) AS enabledQuestionCount
       FROM quiz_sets AS quiz_set
       JOIN quiz_questions AS question ON question.set_id = quiz_set.set_id AND question.enabled = 1
      WHERE quiz_set.channel_id = ?
      GROUP BY quiz_set.set_id, quiz_set.name
      ORDER BY quiz_set.name COLLATE NOCASE, quiz_set.set_id`,
  ).bind(channelIdFrom(context)).all<{ id: string; name: string; enabledQuestionCount: number }>();
  return context.json({ sets: rows.results });
});

quizRoutes.get("/session/availability", async (context) => {
  const channelId = channelIdFrom(context);
  const [settings, active, live, hasQuestions] = await Promise.all([
    loadEnabledQuizSettings(context.env.DB, channelId),
    context.get("points")(channelId).rounds.active(),
    streamIsOnline(context.env.DB, channelId),
    hasEnabledQuestions(context.env.DB, channelId),
  ]);
  const data = quizRoundData(active?.data);
  const reason = settings === null ? "module_disabled"
    : !live ? "stream_offline"
      : active !== null ? "round_running"
        : !hasQuestions ? "question_pool_empty" : null;
  return context.json({
    reason,
    running: active !== null,
    paused: data?.paused ?? false,
    phase: data?.phase ?? null,
    sessionId: active?.roundId ?? null,
    questionIndex: data?.questionIndex ?? null,
    questionCount: data?.questions.length ?? null,
  });
});

quizRoutes.get("/session/state", async (context) => {
  const rounds = context.get("points")(channelIdFrom(context)).rounds;
  const active = await rounds.active();
  const resolved = active === null ? await rounds.recentlyResolved(QUIZ_RESULTS_DISPLAY_MS) : null;
  const data = quizRoundData(active?.data ?? resolved?.data);
  if (data === null || (active === null && resolved === null)) return context.json({ session: null });
  const result = resolved !== null && isRecord(resolved.result) ? resolved.result : null;
  const ranking = result !== null && Array.isArray(result.ranking)
    ? result.ranking.filter(isRecord).slice(0, 10).map(({ login, correct, rank, payout }) => ({ login, correct, rank, payout }))
    : undefined;
  return context.json({
    session: {
      sessionId: data.sessionId,
      setName: data.setName,
      phase: data.phase,
      questionIndex: data.questionIndex,
      questionCount: data.questions.length,
      paused: data.paused,
      phaseEndsAt: data.phaseEndsAt === null ? null : new Date(data.phaseEndsAt).toISOString(),
      remainingMs: data.paused ? data.remainingMs : null,
      ...(resolved === null ? {} : {
        ranking,
        participants: result !== null && Number.isSafeInteger(result.participants) ? result.participants : 0,
        correctRate: typeof result?.correctRate === "number" ? result.correctRate : 0,
        distributed: result !== null && Number.isSafeInteger(result.distributed) ? result.distributed : 0,
      }),
    },
  });
});

quizRoutes.post("/session/start", async (context) => {
  if (!hasRequiredChannelRole(context.get("channelRole"), "operator")) {
    return context.json({ error: "quiz_operation_denied" }, 403);
  }
  const channelId = channelIdFrom(context);
  if (!await streamIsOnline(context.env.DB, channelId)) return context.json({ error: "stream_offline" }, 409);
  const settings = await loadEnabledQuizSettings(context.env.DB, channelId);
  if (settings === null) return context.json({ error: "module_disabled" }, 409);
  const points = context.get("points")(channelId);
  if (await points.rounds.active() !== null) return context.json({ error: "round_running" }, 409);
  const requestBody = await body(context.req.raw);
  if (!isRecord(requestBody) || typeof requestBody.setId !== "string" || requestBody.setId.length === 0) {
    return context.json({ error: "quiz_set_required" }, 400);
  }
  const set = await repository(context).get(channelId, requestBody.setId);
  if (set === null) return context.json({ error: "quiz_set_not_found" }, 404);
  const questionCount = requestBody.questionCount === undefined || requestBody.questionCount === null
    ? null : requestBody.questionCount;
  if (questionCount !== null && (!Number.isSafeInteger(questionCount) || (questionCount as number) < 1)) {
    return context.json({ error: "question_count_invalid" }, 400);
  }
  const language = (await context.env.DB.prepare("SELECT language FROM channels WHERE channel_id = ?")
    .bind(channelId).first<{ language: "de" | "en" }>())?.language ?? "de";
  try {
    const opened = await openQuizSession({
      set,
      questionCount: questionCount as number | null,
      settings,
      language,
      points,
    });
    await context.get("publishModuleOverlayMessage")(
      channelId,
      QUIZ_MODULE_ID,
      "phase",
      "quiz.session",
      quizPhasePayload(opened.data),
    );
    return context.json({ sessionId: opened.sessionId }, 201);
  } catch (failure: unknown) {
    const reason = failure instanceof Error ? failure.message : "quiz_start_failed";
    if (reason === "round_active" || reason === "module_closed") return context.json({ error: "round_running" }, 409);
    if (reason === "question_pool_empty" || reason === "question_count_invalid") return context.json({ error: reason }, 400);
    return context.json({ error: "quiz_start_failed" }, 500);
  }
});

quizRoutes.post("/session/action", async (context) => {
  if (!hasRequiredChannelRole(context.get("channelRole"), "operator")) {
    return context.json({ error: "quiz_operation_denied" }, 403);
  }
  const channelId = channelIdFrom(context);
  if (await loadEnabledQuizSettings(context.env.DB, channelId) === null) return context.json({ error: "module_disabled" }, 409);
  const requestBody = await body(context.req.raw);
  const action = isRecord(requestBody) ? requestBody.action : null;
  if (action !== "next" && action !== "pause" && action !== "resume" && action !== "end") {
    return context.json({ error: "invalid_quiz_action" }, 400);
  }
  const sessionId = isRecord(requestBody) ? requestBody.sessionId : null;
  const active = await context.get("points")(channelId).rounds.active();
  if (typeof sessionId !== "string" || active === null || active.roundId !== sessionId) {
    return context.json({ error: "session_changed" }, 409);
  }
  const canControlPending = active.state === "announcing" && (action === "end" || action === "pause" || action === "resume");
  if ((active.state !== "open" && !canControlPending) || quizRoundData(active.data) === null) {
    return context.json({ error: "round_not_running" }, 409);
  }
  if (action !== "end" && !await streamIsOnline(context.env.DB, channelId)) {
    return context.json({ error: "stream_offline" }, 409);
  }
  try {
    await context.get("runModuleAlarm")(
      channelId,
      QUIZ_MODULE_ID,
      quizSessionControlAlarm.key,
      active.roundId,
      { action, sessionId },
    );
    return context.json({ ok: true });
  } catch (failure: unknown) {
    const reason = failure instanceof Error ? failure.message : "quiz_action_failed";
    const error = reason === "session_changed" || reason === "round_not_running" || reason === "stream_offline" || reason === "quiz_session_paused"
      ? reason
      : "quiz_action_failed";
    return context.json({ error }, 409);
  }
});

quizRoutes.get("/sets", async (context) => {
  const rawPage = Number(context.req.query("page") ?? "1");
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  return context.json(await repository(context).list(channelIdFrom(context), page, context.req.query("q") ?? ""));
});

quizRoutes.get("/sets/:setId", async (context) => {
  const set = await repository(context).get(channelIdFrom(context), context.req.param("setId"));
  return set === null ? context.json({ error: "quiz_set_not_found" }, 404) : context.json({ set });
});

quizRoutes.post("/sets", async (context) => {
  if (!canManage(context.get("channelRole"))) return denied(context);
  const requestBody = await body(context.req.raw);
  const parsed = validateQuizSet({ name: isRecord(requestBody) ? requestBody.name : undefined, questions: [] });
  if (!parsed.ok) return context.json({ error: parsed.code }, 400);
  const channelId = channelIdFrom(context);
  const setId = crypto.randomUUID();
  const now = nowIso();
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
  const mutation = context.env.DB.prepare(
    `INSERT INTO quiz_sets (channel_id, set_id, name, revision, created_at, updated_at)
     SELECT ?, ?, ?, 1, ?, ?
      WHERE (SELECT COUNT(*) FROM quiz_sets WHERE channel_id = ?) < ? ${authorization.sql}
     RETURNING set_id`,
  ).bind(channelId, setId, parsed.value.name, now, now, channelId, QUIZ_SET_MAXIMUM_COUNT, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId, moduleId: QUIZ_MODULE_ID, action: "quiz.set.created" satisfies AuditAction,
    before: null,
    after: { setId, name: parsed.value.name, revision: 1, questionCount: 0 },
  }, now);
  const [result] = await context.env.DB.batch([mutation, audit]);
  if ((result?.meta.changes ?? 0) === 0) {
    const currentCount = await context.env.DB.prepare("SELECT COUNT(*) AS count FROM quiz_sets WHERE channel_id = ?")
      .bind(channelId).first<{ count: number }>();
    return (currentCount?.count ?? 0) >= QUIZ_SET_MAXIMUM_COUNT
      ? context.json({ error: "quiz_set_limit_reached" }, 409) : denied(context);
  }
  return context.json({ set: await repository(context).get(channelId, setId) }, 201);
});

quizRoutes.put("/sets/:setId", async (context) => {
  if (!canManage(context.get("channelRole"))) return denied(context);
  const channelId = channelIdFrom(context);
  const setId = context.req.param("setId");
  const setRepository = repository(context);
  const existing = await setRepository.get(channelId, setId);
  if (existing === null) return context.json({ error: "quiz_set_not_found" }, 404);
  const requestBody = await body(context.req.raw);
  if (!isRecord(requestBody) || !Number.isSafeInteger(requestBody.revision) || (requestBody.revision as number) < 1) {
    return context.json({ error: "invalid_set" }, 400);
  }
  const expectedRevision = requestBody.revision as number;
  const parsed = validateQuizSet(requestBody);
  if (!parsed.ok) return context.json({ error: parsed.code }, 400);
  const input: QuizSetInput = parsed.value;
  const now = nowIso();
  const saveToken = crypto.randomUUID();
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
  const mutation = context.env.DB.prepare(
    `UPDATE quiz_sets SET name = ?, revision = revision + 1, updated_at = ?
      WHERE channel_id = ? AND set_id = ? AND revision = ? ${authorization.sql}
      RETURNING set_id, revision`,
  ).bind(input.name, now, channelId, setId, expectedRevision, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: QUIZ_MODULE_ID,
    action: "quiz.set.updated" satisfies AuditAction,
    before: auditSnapshot(existing),
    after: { setId, name: input.name, revision: expectedRevision + 1, questionCount: input.questions.length, saveToken },
  }, now);
  const savedQuestions = JSON.stringify(input.questions.map((question, position) => ({ position, ...question })));
  const saveSucceeded = `EXISTS (
    SELECT 1 FROM audit_log
     WHERE channel_id = ? AND module_id = ? AND action = 'quiz.set.updated' AND created_at = ?
       AND json_extract(after_json, '$.saveToken') = ?
  )`;
  const removeQuestions = context.env.DB.prepare(
    `DELETE FROM quiz_questions WHERE set_id = ? AND ${saveSucceeded}`,
  ).bind(setId, channelId, QUIZ_MODULE_ID, now, saveToken);
  const insertQuestions = context.env.DB.prepare(
    `INSERT INTO quiz_questions (set_id, position, text, options_json, correct_index, enabled)
     SELECT ?, CAST(json_extract(value, '$.position') AS INTEGER), json_extract(value, '$.text'),
            json_extract(value, '$.options'), CAST(json_extract(value, '$.correctIndex') AS INTEGER),
            CASE WHEN json_extract(value, '$.enabled') THEN 1 ELSE 0 END
       FROM json_each(?)
      WHERE json_array_length(?) <= 100 AND ${saveSucceeded}`,
  ).bind(setId, savedQuestions, savedQuestions, channelId, QUIZ_MODULE_ID, now, saveToken);
  const [result] = await context.env.DB.batch([mutation, audit, removeQuestions, insertQuestions]);
  if ((result?.meta.changes ?? 0) === 0) {
    const current = await setRepository.get(channelId, setId);
    if (current === null) return context.json({ error: "quiz_set_deleted" }, 409);
    if (current.revision !== expectedRevision) return context.json({ error: "quiz_set_conflict", current }, 409);
    return denied(context);
  }
  const savedSet = result?.results[0] as { set_id: string; revision: number } | undefined;
  if (savedSet === undefined) return context.json({ error: "quiz_set_save_failed" }, 500);
  return context.json({ set: {
    id: savedSet.set_id,
    name: input.name,
    revision: savedSet.revision,
    questions: input.questions.map((question, position) => ({ position, ...question })),
    createdAt: existing.createdAt,
    updatedAt: now,
  } satisfies QuizSet });
});

quizRoutes.delete("/sets/:setId", async (context) => {
  if (!canManage(context.get("channelRole"))) return denied(context);
  const channelId = channelIdFrom(context);
  const setId = context.req.param("setId");
  const setRepository = repository(context);
  const existing = await setRepository.get(channelId, setId);
  if (existing === null) return context.json({ error: "quiz_set_not_found" }, 404);
  const revision = Number(context.req.query("revision"));
  if (!Number.isSafeInteger(revision) || revision < 1) return context.json({ error: "invalid_set" }, 400);
  const now = nowIso();
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
  const mutation = context.env.DB.prepare(
    `DELETE FROM quiz_sets WHERE channel_id = ? AND set_id = ? AND revision = ? ${authorization.sql}
      RETURNING set_id`,
  ).bind(channelId, setId, revision, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: QUIZ_MODULE_ID,
    action: "quiz.set.deleted" satisfies AuditAction,
    before: auditSnapshot(existing),
    after: null,
  }, now);
  const [result] = await context.env.DB.batch([mutation, audit]);
  if ((result?.meta.changes ?? 0) === 0) {
    const current = await setRepository.get(channelId, setId);
    if (current === null) return context.json({ error: "quiz_set_deleted" }, 409);
    if (current.revision !== revision) return context.json({ error: "quiz_set_conflict", current }, 409);
    return denied(context);
  }
  return context.json({ removed: true });
});
