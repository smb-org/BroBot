import { Hono, type Context } from "hono";

import { canManage, type AuditAction } from "../../contracts/values";
import type { ModuleRouteEnvironment } from "../contract";
import {
  QUIZ_MODULE_ID,
  QUIZ_SET_MAXIMUM_COUNT,
  type QuizSet,
  type QuizSetInput,
} from "./contracts";
import { createQuizSetRepository } from "./adapters/d1";
import { validateQuizSet } from "./domain/sets";

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
