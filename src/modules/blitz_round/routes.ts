import { Hono, type Context } from "hono";

import { canManage } from "../../contracts/values";
import type { ModuleRouteEnvironment } from "../contract";
import { BLITZ_QUESTION_MAXIMUM_COUNT, BLITZ_ROUND_MODULE_ID } from "./contracts";
import { validateBlitzQuestion } from "./domain/questions";
import { blitzQuestionColumns, blitzQuestionSearchText, createBlitzQuestionRepository, mapBlitzQuestionRow, type BlitzQuestionRow } from "./adapters/d1";
import { loadEnabledBlitzSettings, openBlitzRound } from "./service";

type BlitzRouteContext = Context<ModuleRouteEnvironment>;

const body = async (request: Request): Promise<unknown> => request.json().catch(() => null);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const channelIdFrom = (context: BlitzRouteContext): string => context.req.param("channelId") ?? "";
const repository = (context: BlitzRouteContext) => createBlitzQuestionRepository(context.env.DB);
const denied = (context: BlitzRouteContext): Response => context.json({ error: "blitz_management_denied" }, 403);

export const blitzRoundRoutes = new Hono<ModuleRouteEnvironment>();

blitzRoundRoutes.get("/questions", async (context) => {
  const rawPage = Number(context.req.query("page") ?? "1");
  const page = Number.isSafeInteger(rawPage) && rawPage > 0 ? rawPage : 1;
  const search = context.req.query("q") ?? "";
  return context.json(await repository(context).list(channelIdFrom(context), page, search));
});

blitzRoundRoutes.get("/questions/:questionId", async (context) => {
  const question = await repository(context).get(channelIdFrom(context), context.req.param("questionId"));
  return question === null ? context.json({ error: "question_not_found" }, 404) : context.json({ question });
});

blitzRoundRoutes.get("/availability", async (context) => {
  const channelId = channelIdFrom(context);
  const active = await context.get("points")(channelId).rounds.active();
  if (active !== null) return context.json({ reason: "round_running" as const });
  if (await repository(context).enabledCount(channelId) === 0) return context.json({ reason: "question_pool_empty" as const });
  return context.json({ reason: null });
});

blitzRoundRoutes.post("/questions", async (context) => {
  if (!canManage(context.get("channelRole"))) return denied(context);
  const parsed = validateBlitzQuestion(await body(context.req.raw));
  if (!parsed.ok) return context.json({ error: parsed.code }, 400);
  const now = new Date().toISOString();
  const channelId = channelIdFrom(context);
  const questionId = crypto.randomUUID();
  const input = parsed.value;
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
  const mutation = context.env.DB.prepare(
    `INSERT INTO blitz_questions (channel_id, question_id, kind, prompt, answers_json, search_text, enabled, last_used_at, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?
      WHERE (SELECT COUNT(*) FROM blitz_questions WHERE channel_id = ?) < ? ${authorization.sql}`,
  ).bind(channelId, questionId, input.kind, input.prompt, JSON.stringify(input.answers), blitzQuestionSearchText(input.prompt, input.answers), input.enabled ? 1 : 0,
    now, now, channelId, BLITZ_QUESTION_MAXIMUM_COUNT, ...authorization.values);
  const auditStatement = context.get("prepareModuleAudit")({
    channelId, moduleId: BLITZ_ROUND_MODULE_ID, action: "blitz_round.question.created",
    before: null, after: { questionId, ...input },
  }, now);
  const [result] = await context.env.DB.batch([mutation, auditStatement]);
  if ((result?.meta.changes ?? 0) === 0) {
    const pool = await repository(context).list(channelId, 1);
    return pool.total >= BLITZ_QUESTION_MAXIMUM_COUNT
      ? context.json({ error: "question_limit_reached" }, 409) : denied(context);
  }
  return context.json({ question: await repository(context).get(channelId, questionId) }, 201);
});

blitzRoundRoutes.patch("/questions/:questionId", async (context) => {
  if (!canManage(context.get("channelRole"))) return denied(context);
  const channelId = channelIdFrom(context);
  const questionId = context.req.param("questionId");
  const questionRepository = repository(context);
  const existing = await questionRepository.get(channelId, questionId);
  if (existing === null) return context.json({ error: "question_deleted" }, 409);
  const requestBody = await body(context.req.raw);
  if (!isRecord(requestBody) || !Number.isSafeInteger(requestBody.revision) || (requestBody.revision as number) < 1) {
    return context.json({ error: "question_invalid" }, 400);
  }
  const expectedRevision = requestBody.revision as number;
  const parsed = validateBlitzQuestion(requestBody);
  if (!parsed.ok) return context.json({ error: parsed.code }, 400);
  const now = new Date().toISOString();
  const input = parsed.value;
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
  const mutation = context.env.DB.prepare(
    `UPDATE blitz_questions SET kind = ?, prompt = ?, answers_json = ?, search_text = ?, enabled = ?, revision = revision + 1, updated_at = ?
      WHERE channel_id = ? AND question_id = ? AND revision = ? ${authorization.sql}
      RETURNING ${blitzQuestionColumns}`,
  ).bind(input.kind, input.prompt, JSON.stringify(input.answers), blitzQuestionSearchText(input.prompt, input.answers), input.enabled ? 1 : 0, now,
    channelId, questionId, expectedRevision, ...authorization.values);
  const auditStatement = context.get("prepareModuleAudit")({
    channelId, moduleId: BLITZ_ROUND_MODULE_ID, action: "blitz_round.question.updated",
    before: { questionId, kind: existing.kind, prompt: existing.prompt, answers: existing.answers, enabled: existing.enabled },
    after: { questionId, ...input },
  }, now);
  const [result] = await context.env.DB.batch([mutation, auditStatement]);
  if ((result?.meta.changes ?? 0) === 0) {
    const current = await questionRepository.get(channelId, questionId);
    if (current === null) return context.json({ error: "question_deleted" }, 409);
    if (current.revision !== expectedRevision) return context.json({ error: "question_conflict", current }, 409);
    return denied(context);
  }
  const saved = result?.results[0] as BlitzQuestionRow | undefined;
  if (saved === undefined) return context.json({ error: "question_save_failed" }, 500);
  return context.json({ question: mapBlitzQuestionRow(saved) });
});

blitzRoundRoutes.delete("/questions/:questionId", async (context) => {
  if (!canManage(context.get("channelRole"))) return denied(context);
  const channelId = channelIdFrom(context);
  const questionId = context.req.param("questionId");
  const questionRepository = repository(context);
  const existing = await questionRepository.get(channelId, questionId);
  if (existing === null) return context.json({ error: "question_deleted" }, 409);
  const revision = Number(context.req.query("revision"));
  if (!Number.isSafeInteger(revision) || revision < 1) return context.json({ error: "question_invalid" }, 400);
  const now = new Date().toISOString();
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
  const mutation = context.env.DB.prepare(
    `DELETE FROM blitz_questions WHERE channel_id = ? AND question_id = ? AND revision = ? ${authorization.sql}
      RETURNING ${blitzQuestionColumns}`,
  ).bind(channelId, questionId, revision, ...authorization.values);
  const auditStatement = context.get("prepareModuleAudit")({
    channelId, moduleId: BLITZ_ROUND_MODULE_ID, action: "blitz_round.question.deleted",
    before: { questionId, kind: existing.kind, prompt: existing.prompt, answers: existing.answers, enabled: existing.enabled }, after: null,
  }, now);
  const [result] = await context.env.DB.batch([mutation, auditStatement]);
  if ((result?.meta.changes ?? 0) === 0) {
    const current = await questionRepository.get(channelId, questionId);
    if (current === null) return context.json({ error: "question_deleted" }, 409);
    if (current.revision !== revision) return context.json({ error: "question_conflict", current }, 409);
    return denied(context);
  }
  const removed = result?.results[0] as BlitzQuestionRow | undefined;
  if (removed === undefined) return context.json({ error: "question_delete_failed" }, 500);
  return context.json({ removed: true, question: mapBlitzQuestionRow(removed) });
});

blitzRoundRoutes.post("/start", async (context) => {
  const channelId = channelIdFrom(context);
  const settings = await loadEnabledBlitzSettings(context.env.DB, channelId);
  if (settings === null) return context.json({ error: "module_disabled" }, 409);
  const language = (await context.env.DB.prepare("SELECT language FROM channels WHERE channel_id = ?")
    .bind(channelId).first<{ language: "de" | "en" }>())?.language ?? "de";
  try {
    const opened = await openBlitzRound({
      channelId,
      startedBy: context.get("actor").userId,
      settings,
      language,
      points: context.get("points")(channelId),
      repository: repository(context),
    });
    return context.json({ roundId: opened.roundId });
  } catch (failure: unknown) {
    const message = failure instanceof Error ? failure.message : "round_start_failed";
    if (message === "round_active") return context.json({ error: message }, 409);
    if (message === "question_pool_empty") return context.json({ error: message }, 409);
    return context.json({ error: "round_start_failed" }, 500);
  }
});

