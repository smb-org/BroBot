import { Hono } from "hono";
import { z } from "zod";

import { canManage } from "../../contracts/values";
import type { ModuleRouteEnvironment } from "../contract";
import { API_SOURCE_MAXIMUMS, API_SOURCE_NAME_PATTERN } from "./contracts";
import { getApiSource, listApiSources } from "./adapters/d1";
import { validateJsonataExpression } from "./domain";
import { isValidApiSourceUrl } from "./domain/url";

const createSchema = z.object({
  name: z.string().regex(API_SOURCE_NAME_PATTERN),
  url: z.string().min(1).max(API_SOURCE_MAXIMUMS.urlLength),
  expression: z.string().max(API_SOURCE_MAXIMUMS.expressionLength),
});

const updateSchema = createSchema.omit({ name: true }).extend({ revision: z.number().int().min(1) });
const deleteSchema = z.object({ revision: z.number().int().min(1) });

const channelIdOf = (context: { req: { param: (name: string) => string | undefined } }): string =>
  context.req.param("channelId") ?? "";

const safeHost = (url: string): string | null => {
  try { return new URL(url).hostname; } catch { return null; }
};

export const apiSourceRoutes = new Hono<ModuleRouteEnvironment>();

apiSourceRoutes.get("/sources", async (context) => {
  return context.json({ sources: await listApiSources(context.env.DB, channelIdOf(context)) });
});

apiSourceRoutes.post("/sources", async (context) => {
  if (!canManage(context.get("channelRole"))) return context.json({ error: "api_source_management_denied" }, 403);
  const parsed = createSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success || !isValidApiSourceUrl(parsed.data.url, context.env.PUBLIC_ORIGIN) ||
      !validateJsonataExpression(parsed.data.expression)) {
    return context.json({ error: "api_source_invalid" }, 400);
  }
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
  if (!parsed.success || !isValidApiSourceUrl(parsed.data.url, context.env.PUBLIC_ORIGIN) ||
      !validateJsonataExpression(parsed.data.expression)) {
    return context.json({ error: "api_source_invalid" }, 400);
  }
  const channelId = channelIdOf(context);
  const name = context.req.param("name");
  const before = await getApiSource(context.env.DB, channelId, name);
  if (before === null) return context.json({ error: "api_source_not_found" }, 404);
  if (parsed.data.revision !== before.revision) return context.json({ error: "api_source_conflict" }, 409);
  const now = new Date().toISOString();
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
  const mutation = context.env.DB.prepare(
    `UPDATE api_sources SET url = ?, expression = ?, revision = revision + 1, updated_at = ?
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
