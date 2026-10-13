import { Hono } from "hono";
import { z } from "zod";

import { canManage } from "../../contracts/values";
import { templateVariableNames } from "../contract";
import type { ModuleRouteEnvironment, ModuleTemplateUsageSource } from "../contract";
import { API_SOURCE_MAXIMUMS, API_SOURCE_NAME_PATTERN } from "./contracts";
import { getApiSource, listApiSources } from "./adapters/d1";
import { inspectApiSourceExpression } from "./domain";
import { isValidApiSourceUrl } from "./domain/url";
import { testApiSource } from "./test-source";

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
  kind: ModuleTemplateUsageSource["kind"] | "text_block" | "text_block_condition";
  label: string;
};

const stringArrayFromJson = (serialized: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(serialized);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
};

const hasConditionReference = (serialized: string, conditionId: string): boolean => {
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const data: unknown = Reflect.get(parsed, "data");
    return typeof data === "object" && data !== null && !Array.isArray(data) && Object.hasOwn(data, conditionId);
  } catch {
    return false;
  }
};

const apiSourceUsages = async (
  db: D1Database,
  channelId: string,
  name: string,
  templateSources: readonly ModuleTemplateUsageSource[],
): Promise<readonly ApiSourceUsage[]> => {
  const variableName = `api.${name}`;
  const conditionId = `api_source.${name}`;
  const usages = new Map<string, ApiSourceUsage>();
  const addUsage = (usage: ApiSourceUsage): void => {
    usages.set(`${usage.kind}\u0000${usage.label}`, usage);
  };
  for (const source of templateSources) {
    if (templateVariableNames(source.text).includes(variableName)) {
      addUsage({ kind: source.kind, label: source.label });
    }
  }

  const variants = await db.prepare(
    `SELECT block_name, conditions_json, texts_json
       FROM text_block_variants
      WHERE channel_id = ? ORDER BY block_name, position`,
  ).bind(channelId).all<{ block_name: string; conditions_json: string; texts_json: string }>();
  for (const variant of variants.results) {
    const label = variant.block_name;
    if (stringArrayFromJson(variant.texts_json).some((text) => templateVariableNames(text).includes(variableName))) {
      addUsage({ kind: "text_block", label });
    }
    if (hasConditionReference(variant.conditions_json, conditionId)) {
      addUsage({ kind: "text_block_condition", label });
    }
  }

  const [moduleSettings, chatVoteTemplates] = await Promise.all([
    db.prepare("SELECT module_id, settings FROM channel_modules WHERE channel_id = ? ORDER BY module_id")
      .bind(channelId).all<{ module_id: string; settings: string }>(),
    db.prepare("SELECT id, title, labels FROM chat_vote_templates WHERE channel_id = ? ORDER BY id")
      .bind(channelId).all<{ id: string; title: string; labels: string }>(),
  ]);
  for (const module of moduleSettings.results) {
    if (templateVariableNames(module.settings).includes(variableName)) {
      addUsage({ kind: "event", label: module.module_id });
    }
  }
  for (const template of chatVoteTemplates.results) {
    if (templateVariableNames(`${template.title} ${template.labels}`).includes(variableName)) {
      addUsage({ kind: "event", label: `chat_vote_templates.${template.id}` });
    }
  }
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
  const usages = await apiSourceUsages(
    context.env.DB,
    channelId,
    name,
    await context.get("templateUsageSources")(channelId),
  );
  if (usages.length > 0) return context.json({ error: "api_source_in_use", usages }, 409);
  const now = new Date().toISOString();
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
  const mutation = context.env.DB.prepare(
    `DELETE FROM api_sources WHERE channel_id = ? AND source_name = ? AND revision = ? ${authorization.sql}`,
  ).bind(channelId, name, before.revision, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: "api_source",
    action: "api_source.source_deleted",
    before: { name, host: safeHost(before.url) },
    after: null,
  }, now);
  const result = await context.env.DB.batch([mutation, audit]);
  if ((result[0]?.meta.changes ?? 0) === 0) return context.json({ error: "api_source_conflict" }, 409);
  await context.get("publishOverlayHostEvent")(channelId, "template.data.changed");
  return context.json({ ok: true });
});
