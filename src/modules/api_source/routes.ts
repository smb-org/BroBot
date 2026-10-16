import { Hono } from "hono";
import { z } from "zod";

import { canManage } from "../../contracts/values";
import type { ModuleRouteEnvironment } from "../contract";
import { API_SOURCE_MAXIMUMS, API_SOURCE_NAME_PATTERN } from "./contracts";
import { getApiSource, listApiSources } from "./adapters/d1";
import { inspectApiSourceExpression } from "./domain";
import { isValidApiSourceUrl } from "./domain/url";
import { testApiSource } from "./test-source";
import { CHAT_VOTE_RESULT_TEXT_REFERENCE_SOURCE_SQL } from "../contracts/chat-vote-result-text-references";

const createSchema = z.object({
  name: z.string().regex(API_SOURCE_NAME_PATTERN),
  url: z.string().min(1).max(API_SOURCE_MAXIMUMS.urlLength),
  expression: z.string().max(API_SOURCE_MAXIMUMS.expressionLength),
});

const updateSchema = createSchema.omit({ name: true }).extend({ revision: z.number().int().min(1) });
const deleteSchema = z.object({ revision: z.number().int().min(1) });
const testSchema = z.object({
  url: z.string().min(1).max(API_SOURCE_MAXIMUMS.urlLength),
  expression: z.string().max(API_SOURCE_MAXIMUMS.expressionLength),
});

const channelIdOf = (context: { req: { param: (name: string) => string | undefined } }): string =>
  context.req.param("channelId") ?? "";

const safeHost = (url: string): string | null => {
  try { return new URL(url).hostname; } catch { return null; }
};

type ApiSourceUsage = {
  kind: "command" | "faq" | "timer" | "overlay" | "event" | "text_block" | "text_block_condition";
  label: string;
};

type ApiSourceReferenceRow = { kind: ApiSourceUsage["kind"]; label: string };

const apiVariableReferencePredicate = (column: string): string =>
  `(instr(${column}, ?) > 0 OR instr(${column}, ?) > 0)`;

export const apiSourceReferenceQuery = (channelId: string, name: string): { sql: string; values: readonly string[] } => {
  const token = `{api.${name}}`;
  const tokenWithArguments = `{api.${name} `;
  const conditionId = `api_source.${name}`;
  const textPredicate = (column: string): string => apiVariableReferencePredicate(column);
  const textValues = (): string[] => [token, tokenWithArguments];
  const sites: { sql: string; values: string[] }[] = [
    {
      sql: `SELECT 1 AS site_order, 'timer' AS kind, COALESCE(timer.name, timer.timer_id) AS label
              FROM timers AS timer
             WHERE timer.channel_id = ? AND ${textPredicate("timer.message_text")}`,
      values: [channelId, ...textValues()],
    },
    {
      sql: `SELECT 2 AS site_order, 'faq' AS kind, COALESCE(faq.name, faq.faq_id) AS label
              FROM faq_entries AS faq
             WHERE faq.channel_id = ? AND ${textPredicate("faq.answer_text")}`,
      values: [channelId, ...textValues()],
    },
    {
      sql: `SELECT 3 AS site_order, 'command' AS kind, '!' || command.command_name AS label
              FROM text_commands AS command
             WHERE command.channel_id = ? AND (
               ${textPredicate("command.response_text")} OR ${textPredicate("command.template_fields_json")} OR
               ${textPredicate("command.timeout_fallback_text")} OR ${textPredicate("command.timeout_reason")})`,
      values: [channelId, ...textValues(), ...textValues(), ...textValues(), ...textValues()],
    },
    {
      sql: `SELECT 4 AS site_order, 'overlay' AS kind, COALESCE(NULLIF(element.label, ''), overlay.name) AS label
              FROM overlay_elements AS element
              JOIN overlays AS overlay ON overlay.channel_id = element.channel_id AND overlay.overlay_id = element.overlay_id
             WHERE element.channel_id = ? AND (${textPredicate("element.text")} OR ${textPredicate("element.config_json")})`,
      values: [channelId, ...textValues(), ...textValues()],
    },
    {
      sql: `SELECT 5 AS site_order, 'text_block' AS kind, variant.block_name AS label
              FROM text_block_variants AS variant
             WHERE variant.channel_id = ? AND ${textPredicate("variant.texts_json")}`,
      values: [channelId, ...textValues()],
    },
    {
      sql: `SELECT 6 AS site_order, 'text_block_condition' AS kind, variant.block_name AS label
              FROM text_block_variants AS variant
             WHERE variant.channel_id = ? AND EXISTS (
               SELECT 1 FROM json_each(
                 CASE WHEN json_valid(variant.conditions_json) THEN variant.conditions_json ELSE '{}' END,
                 '$.data'
               ) AS condition
               WHERE condition.key = ?
             )`,
      values: [channelId, conditionId],
    },
    {
      sql: `SELECT 7 AS site_order, 'event' AS kind, module.module_id AS label
              FROM channel_modules AS module
             WHERE module.channel_id = ? AND ${textPredicate("module.settings")}`,
      values: [channelId, ...textValues()],
    },
    {
      sql: `SELECT 8 AS site_order, 'event' AS kind, 'chat_vote_templates.' || template.id AS label
              FROM chat_vote_templates AS template
             WHERE template.channel_id = ? AND (${textPredicate("template.title")} OR ${textPredicate("template.labels")})`,
      values: [channelId, ...textValues(), ...textValues()],
    },
    {
      sql: `SELECT 9 AS site_order, 'event' AS kind,
                   'chat_voting.' || COALESCE(NULLIF(result.item_name, ''), result.source_id) AS label
              FROM (${CHAT_VOTE_RESULT_TEXT_REFERENCE_SOURCE_SQL}) AS result
             WHERE result.channel_id = ? AND ${textPredicate("result.result_text")}`,
      values: [channelId, ...textValues()],
    },
  ];

  const sql = sites.map((site) => site.sql).join("\nUNION ALL\n");
  const values = sites.flatMap((site) => site.values);
  return { sql, values };
};

const apiSourceUsages = async (db: D1Database, channelId: string, name: string): Promise<readonly ApiSourceUsage[]> => {
  const referenceQuery = apiSourceReferenceQuery(channelId, name);
  const rows = await db.prepare(
    `SELECT kind, label FROM (${referenceQuery.sql}) AS api_source_references
      ORDER BY site_order, label`,
  ).bind(...referenceQuery.values).all<ApiSourceReferenceRow>();
  const usages = new Map<string, ApiSourceUsage>();
  for (const row of rows.results) usages.set(`${row.kind}\u0000${row.label}`, row);
  return [...usages.values()];
};

export const apiSourceRoutes = new Hono<ModuleRouteEnvironment>();

apiSourceRoutes.get("/sources", async (context) => {
  return context.json({ sources: await listApiSources(context.env.DB, channelIdOf(context)) });
});

apiSourceRoutes.get("/sources/:name", async (context) => {
  const source = await getApiSource(context.env.DB, channelIdOf(context), context.req.param("name"));
  return source === null
    ? context.json({ error: "api_source_not_found" }, 404)
    : context.json({ source });
});

apiSourceRoutes.post("/sources/test", async (context) => {
  if (!canManage(context.get("channelRole"))) return context.json({ error: "api_source_management_denied" }, 403);
  const parsed = testSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) return context.json({ error: "api_source_invalid" }, 400);
  return context.json(await testApiSource(
    context.env.DB,
    channelIdOf(context),
    context.get("externalFetchBudget"),
    parsed.data.url,
    parsed.data.expression,
    context.env.PUBLIC_ORIGIN,
    Date.now(),
  ));
});

apiSourceRoutes.post("/sources", async (context) => {
  if (!canManage(context.get("channelRole"))) return context.json({ error: "api_source_management_denied" }, 403);
  const parsed = createSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) return context.json({ error: "api_source_invalid" }, 400);
  if (!isValidApiSourceUrl(parsed.data.url, context.env.PUBLIC_ORIGIN)) {
    return context.json({ error: "api_source_invalid" }, 400);
  }
  const expressionError = inspectApiSourceExpression(parsed.data.expression);
  if (expressionError?.kind === "construct_not_allowed") {
    return context.json({ error: "api_source_construct_not_allowed", constructName: expressionError.constructName }, 400);
  }
  if (expressionError !== null) return context.json({ error: "api_source_invalid" }, 400);
  const channelId = channelIdOf(context);
  if (await getApiSource(context.env.DB, channelId, parsed.data.name) !== null) {
    return context.json({ error: "api_source_exists" }, 409);
  }
  const now = new Date().toISOString();
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
  const mutation = context.env.DB.prepare(
    `INSERT INTO api_sources (channel_id, source_name, url, expression, revision, created_at, updated_at)
     SELECT ?, ?, ?, ?, 1, ?, ?
      WHERE (SELECT COUNT(*) FROM api_sources WHERE channel_id = ?) < ? ${authorization.sql}`,
  ).bind(channelId, parsed.data.name, parsed.data.url, parsed.data.expression, now, now,
    channelId, API_SOURCE_MAXIMUMS.sourcesPerChannel, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: "api_source",
    action: "api_source.source_created",
    before: null,
    after: { name: parsed.data.name, host: safeHost(parsed.data.url) },
  }, now);
  const result = await context.env.DB.batch([mutation, audit]);
  if ((result[0]?.meta.changes ?? 0) === 0) {
    return context.json({ error: "api_source_limit_or_conflict" }, 409);
  }
  await context.get("publishOverlayHostEvent")(channelId, "template.data.changed");
  return context.json({ source: await getApiSource(context.env.DB, channelId, parsed.data.name) }, 201);
});

apiSourceRoutes.patch("/sources/:name", async (context) => {
  if (!canManage(context.get("channelRole"))) return context.json({ error: "api_source_management_denied" }, 403);
  const parsed = updateSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) return context.json({ error: "api_source_invalid" }, 400);
  if (!isValidApiSourceUrl(parsed.data.url, context.env.PUBLIC_ORIGIN)) {
    return context.json({ error: "api_source_invalid" }, 400);
  }
  const expressionError = inspectApiSourceExpression(parsed.data.expression);
  if (expressionError?.kind === "construct_not_allowed") {
    return context.json({ error: "api_source_construct_not_allowed", constructName: expressionError.constructName }, 400);
  }
  if (expressionError !== null) return context.json({ error: "api_source_invalid" }, 400);
  const channelId = channelIdOf(context);
  const name = context.req.param("name");
  const before = await getApiSource(context.env.DB, channelId, name);
  if (before === null) return context.json({ error: "api_source_not_found" }, 404);
  if (parsed.data.revision !== before.revision) return context.json({ error: "api_source_conflict" }, 409);
  const now = new Date().toISOString();
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
  const mutation = context.env.DB.prepare(
    `UPDATE api_sources
        SET url = ?, expression = ?, revision = revision + 1, updated_at = ?,
            last_fetched_at = NULL, last_status = NULL, last_error = NULL
      WHERE channel_id = ? AND source_name = ? AND revision = ? ${authorization.sql}`,
  ).bind(parsed.data.url, parsed.data.expression, now, channelId, name, before.revision, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: "api_source",
    action: "api_source.source_changed",
    before: { name, host: safeHost(before.url) },
    after: { name, host: safeHost(parsed.data.url) },
  }, now);
  const result = await context.env.DB.batch([mutation, audit]);
  if ((result[0]?.meta.changes ?? 0) === 0) return context.json({ error: "api_source_conflict" }, 409);
  await context.get("publishOverlayHostEvent")(channelId, "template.data.changed");
  return context.json({ source: await getApiSource(context.env.DB, channelId, name) });
});

apiSourceRoutes.delete("/sources/:name", async (context) => {
  if (!canManage(context.get("channelRole"))) return context.json({ error: "api_source_management_denied" }, 403);
  const parsed = deleteSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) return context.json({ error: "api_source_invalid" }, 400);
  const channelId = channelIdOf(context);
  const name = context.req.param("name");
  const before = await getApiSource(context.env.DB, channelId, name);
  if (before === null) return context.json({ error: "api_source_not_found" }, 404);
  if (parsed.data.revision !== before.revision) return context.json({ error: "api_source_conflict" }, 409);
  const usages = await apiSourceUsages(context.env.DB, channelId, name);
  if (usages.length > 0) return context.json({ error: "api_source_in_use", usages }, 409);
  const now = new Date().toISOString();
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
  const referenceQuery = apiSourceReferenceQuery(channelId, name);
  const mutation = context.env.DB.prepare(
    `DELETE FROM api_sources
      WHERE channel_id = ? AND source_name = ? AND revision = ?
        AND NOT EXISTS (SELECT 1 FROM (${referenceQuery.sql}) AS api_source_references)
        ${authorization.sql}`,
  ).bind(channelId, name, before.revision, ...referenceQuery.values, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: "api_source",
    action: "api_source.source_deleted",
    before: { name, host: safeHost(before.url) },
    after: null,
  }, now);
  const result = await context.env.DB.batch([mutation, audit]);
  if ((result[0]?.meta.changes ?? 0) === 0) {
    if (await getApiSource(context.env.DB, channelId, name) === null) {
      return context.json({ error: "api_source_not_found" }, 404);
    }
    const currentUsages = await apiSourceUsages(context.env.DB, channelId, name);
    if (currentUsages.length > 0) return context.json({ error: "api_source_in_use", usages: currentUsages }, 409);
    return context.json({ error: "api_source_conflict" }, 409);
  }
  await context.get("publishOverlayHostEvent")(channelId, "template.data.changed");
  return context.json({ ok: true });
});
