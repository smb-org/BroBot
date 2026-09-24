import { Hono } from "hono";
import { z } from "zod";

import {
  CHANNEL_VARIABLE_MAXIMUM_COUNT,
  CHANNEL_VARIABLE_MAXIMUM_VALUE,
  CHANNEL_VARIABLE_MINIMUM_VALUE,
  canManage,
} from "../../contracts/values";
import type { ModuleVariableReferenceUsage } from "../../modules/contract";
import { MODULES } from "../../modules/registry";
import { prepareAudit } from "../db/audit";
import { requireChannelAuthorization, type ChannelAuthorizationVariables } from "../auth/guards";
import { overlayChangedMessage, publishVariablesChanged } from "../realtime";
import {
  findChannelVariable,
  listChannelVariables,
  type ChannelVariableRecord,
} from "../db/channel-variables";

interface VariableRouteEnvironment {
  Bindings: Env;
  Variables: ChannelAuthorizationVariables;
}

const NAME_PATTERN = /^[a-z][a-z0-9_]{0,31}$/u;
const MINIMUM_VALUE_SQL = String(CHANNEL_VARIABLE_MINIMUM_VALUE);
const MAXIMUM_VALUE_SQL = String(CHANNEL_VARIABLE_MAXIMUM_VALUE);
const nowIso = (): string => new Date().toISOString();
const bodyObject = z.object({
  name: z.string().regex(NAME_PATTERN),
  value: z.number().int().min(CHANNEL_VARIABLE_MINIMUM_VALUE).max(CHANNEL_VARIABLE_MAXIMUM_VALUE).default(0),
  description: z.string().max(80).default(""),
  resetOnStreamStart: z.boolean().default(false),
});
const patchObject = z.object({
  newName: z.string().regex(NAME_PATTERN).optional(),
  description: z.string().max(80).optional(),
  resetOnStreamStart: z.boolean().optional(),
}).refine((value) => Object.keys(value).length > 0);
const valueObject = z.object({
  operation: z.enum(["add", "subtract", "set"]),
  amount: z.number().int().min(CHANNEL_VARIABLE_MINIMUM_VALUE).max(CHANNEL_VARIABLE_MAXIMUM_VALUE),
});

const recordSnapshot = (variable: ChannelVariableRecord) => ({
  name: variable.name,
  value: variable.value,
  description: variable.description,
});

const referencesFor = async (
  db: D1Database,
  channelId: string,
  name: string,
): Promise<ModuleVariableReferenceUsage[]> => {
  const result: ModuleVariableReferenceUsage[] = [];
  for (const module of MODULES) {
    if (module.variableReferences !== undefined) {
      result.push(...await module.variableReferences.usages(db, channelId, name));
    }
  }
  const overlays = await db.prepare(
    `SELECT overlay.name AS overlay_name, element.label AS element_label, element.element_id
       FROM overlay_elements AS element
       JOIN overlays AS overlay
         ON overlay.channel_id = element.channel_id AND overlay.overlay_id = element.overlay_id
      WHERE element.channel_id = ? AND element.variable_name = ?
      ORDER BY overlay.name, element.z, element.element_id`,
  ).bind(channelId, name).all<{ overlay_name: string; element_label: string; element_id: string }>();
  result.push(...overlays.results.map((row) => ({
    moduleId: "overlays",
    itemName: `${row.overlay_name} → ${row.element_label || row.element_id}`,
    kind: "display" as const,
  })));
  return result;
};

export const variableRouter = new Hono<VariableRouteEnvironment>();
variableRouter.use("/api/channels/:channelId/variables", requireChannelAuthorization());
variableRouter.use("/api/channels/:channelId/variables/*", requireChannelAuthorization());

variableRouter.get("/api/channels/:channelId/variables", async (context) => {
  const channelId = context.req.param("channelId");
  const variables = await listChannelVariables(context.env.DB, channelId);
  const withUsages = await Promise.all(variables.map(async (variable) => ({
    ...variable,
    usages: await referencesFor(context.env.DB, channelId, variable.name),
  })));
  return context.json({ variables: withUsages, count: variables.length, maximum: CHANNEL_VARIABLE_MAXIMUM_COUNT });
});

variableRouter.post("/api/channels/:channelId/variables", async (context) => {
  const parsed = bodyObject.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) return context.json({ error: "variable_data_invalid" }, 400);
  if (!canManage(context.get("channelRole"))) return context.json({ error: "variable_management_denied" }, 403);
  const channelId = context.req.param("channelId");
  const now = nowIso();
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
  const mutation = context.env.DB.prepare(
    `INSERT INTO channel_variables
      (channel_id, name, value, description, reset_on_stream_start, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM channel_variables WHERE channel_id = ? AND name = ?)
        AND (SELECT COUNT(*) FROM channel_variables WHERE channel_id = ?) < ?
        ${authorization.sql}`,
  ).bind(channelId, parsed.data.name, parsed.data.value, parsed.data.description, parsed.data.resetOnStreamStart ? 1 : 0,
    now, now, channelId, parsed.data.name, channelId, CHANNEL_VARIABLE_MAXIMUM_COUNT, ...authorization.values);
  const audit = prepareAudit(context.env.DB, context.get("actor").userId, now, channelId, null,
    "channel.variable.created", null,
    { name: parsed.data.name, value: parsed.data.value, description: parsed.data.description });
  const results = await context.env.DB.batch([mutation, audit]);
  if ((results[0]?.meta.changes ?? 0) > 0) {
    const variable = await findChannelVariable(context.env.DB, channelId, parsed.data.name);
    if (variable !== null) {
      await publishVariablesChanged(context.env.CHANNEL, channelId,
        [{ name: variable.name, value: variable.value }], []);
    }
    return context.json({ variable, usages: [] }, 201);
  }
  if (await findChannelVariable(context.env.DB, channelId, parsed.data.name) !== null) {
    return context.json({ error: "variable_already_exists" }, 409);
  }
  const count = await context.env.DB.prepare("SELECT COUNT(*) AS count FROM channel_variables WHERE channel_id = ?")
    .bind(channelId).first<{ count: number }>();
  if ((count?.count ?? 0) >= CHANNEL_VARIABLE_MAXIMUM_COUNT) return context.json({ error: "variable_limit_reached" }, 409);
  return context.json({ error: "variable_management_denied" }, 403);
});

variableRouter.patch("/api/channels/:channelId/variables/:name", async (context) => {
  const parsed = patchObject.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) return context.json({ error: "variable_data_invalid" }, 400);
  if (!canManage(context.get("channelRole"))) return context.json({ error: "variable_management_denied" }, 403);
  const channelId = context.req.param("channelId");
  const name = context.req.param("name");
  const before = await findChannelVariable(context.env.DB, channelId, name);
  if (before === null) return context.json({ error: "variable_not_found" }, 404);
  const newName = parsed.data.newName ?? name;
  const description = parsed.data.description ?? before.description;
  const resetOnStreamStart = parsed.data.resetOnStreamStart ?? before.resetOnStreamStart;
  if (newName === name && description === before.description && resetOnStreamStart === before.resetOnStreamStart) {
    return context.json({ variable: before, usages: await referencesFor(context.env.DB, channelId, name) });
  }
  const now = nowIso();
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
  const mutation = context.env.DB.prepare(
    `UPDATE channel_variables
        SET name = ?, description = ?, reset_on_stream_start = ?, updated_at = ?
      WHERE channel_id = ? AND name = ?
        AND value = ? AND description = ? AND reset_on_stream_start = ? AND created_at = ? AND updated_at = ?
        AND (name = ? OR NOT EXISTS (SELECT 1 FROM channel_variables WHERE channel_id = ? AND name = ?))
        ${authorization.sql}`,
  ).bind(newName, description, resetOnStreamStart ? 1 : 0, now, channelId, name,
    before.value, before.description, before.resetOnStreamStart ? 1 : 0, before.createdAt, before.updatedAt,
    name, channelId, newName, ...authorization.values);
  const audit = prepareAudit(context.env.DB, context.get("actor").userId, now, channelId, null, "channel.variable.renamed",
    recordSnapshot(before), { name: newName, value: before.value, description });
  const overlayRevisionUpdates = newName === name ? [] : [context.env.DB.prepare(
    `UPDATE overlays
        SET revision = revision + 1, updated_at = ?
      WHERE channel_id = ?
        AND NOT EXISTS (SELECT 1 FROM channel_variables WHERE channel_id = ? AND name = ?)
        AND EXISTS (
          SELECT 1 FROM channel_variables
           WHERE channel_id = ? AND name = ? AND value = ? AND created_at = ? AND updated_at = ?
        )
        AND EXISTS (
          SELECT 1 FROM overlay_elements AS element
           WHERE element.channel_id = overlays.channel_id
             AND element.overlay_id = overlays.overlay_id
             AND element.variable_name = ?
        )
        ${authorization.sql}
      RETURNING overlay_id, revision`,
  ).bind(now, channelId, channelId, name, channelId, newName, before.value, before.createdAt, now, newName,
    ...authorization.values)];
  const referenceUpdates = newName === name ? [] : MODULES.flatMap((module) =>
    module.variableReferences?.rename(context.env.DB, channelId, name, newName) ?? []);
  const results = await context.env.DB.batch([mutation, audit, ...overlayRevisionUpdates, ...referenceUpdates]);
  if ((results[0]?.meta.changes ?? 0) === 0) {
    if (await findChannelVariable(context.env.DB, channelId, newName) !== null) {
      return context.json({ error: "variable_already_exists" }, 409);
    }
    return context.json({ error: "variable_changed_concurrently" }, 409);
  }
  const variable = await findChannelVariable(context.env.DB, channelId, newName);
  const overlayRows = newName === name ? [] : (results[2]?.results ?? []) as Array<{ overlay_id: string; revision: number }>;
  const overlayMessages = overlayRows.map((row) => overlayChangedMessage(channelId, row.overlay_id, row.revision));
  await publishVariablesChanged(context.env.CHANNEL, channelId,
    [{ name: newName, value: before.value }], newName === name ? [] : [name], overlayMessages);
  return context.json({ variable, usages: await referencesFor(context.env.DB, channelId, newName) });
});

variableRouter.post("/api/channels/:channelId/variables/:name/value", async (context) => {
  const parsed = valueObject.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) {
    return context.json({ error: "variable_data_invalid" }, 400);
  }
  const channelId = context.req.param("channelId");
  const name = context.req.param("name");
  const before = await findChannelVariable(context.env.DB, channelId, name);
  if (before === null) return context.json({ error: "variable_not_found" }, 404);
  const now = nowIso();
  const authorization = context.get("authorizeMutation")(channelId, context.get("actor"), now);
  const mutation = context.env.DB.prepare(
    `UPDATE channel_variables
        SET value = CASE ?
              WHEN 'set' THEN ?
              WHEN 'add' THEN max(${MINIMUM_VALUE_SQL}, min(${MAXIMUM_VALUE_SQL}, value + ?))
              ELSE max(${MINIMUM_VALUE_SQL}, min(${MAXIMUM_VALUE_SQL}, value - ?))
            END,
            updated_at = ?
      WHERE channel_id = ? AND name = ?
        AND value = ? AND description = ? AND reset_on_stream_start = ? AND created_at = ? AND updated_at = ?
        AND value <> CASE ?
              WHEN 'set' THEN ?
              WHEN 'add' THEN max(${MINIMUM_VALUE_SQL}, min(${MAXIMUM_VALUE_SQL}, value + ?))
              ELSE max(${MINIMUM_VALUE_SQL}, min(${MAXIMUM_VALUE_SQL}, value - ?))
            END
        ${authorization.sql}
      RETURNING channel_id, name, value, description, reset_on_stream_start, created_at, updated_at`,
  ).bind(parsed.data.operation, parsed.data.amount, parsed.data.amount, parsed.data.amount, now, channelId, name,
    before.value, before.description, before.resetOnStreamStart ? 1 : 0, before.createdAt, before.updatedAt,
    parsed.data.operation, parsed.data.amount, parsed.data.amount, parsed.data.amount, ...authorization.values);
  const nextValue = parsed.data.operation === "set"
    ? parsed.data.amount
    : Math.max(CHANNEL_VARIABLE_MINIMUM_VALUE, Math.min(CHANNEL_VARIABLE_MAXIMUM_VALUE,
      before.value + (parsed.data.operation === "add" ? parsed.data.amount : -parsed.data.amount)));
  const audit = prepareAudit(context.env.DB, context.get("actor").userId, now, channelId, null,
    "channel.variable.value_changed", recordSnapshot(before), { name, value: nextValue, description: before.description });
  const results = await context.env.DB.batch([mutation, audit]);
  const mutationResult = results[0];
  if (mutationResult === undefined) throw new Error("Channel variable change returned no result.");
  if (mutationResult.meta.changes === 0) {
    const current = await findChannelVariable(context.env.DB, channelId, name);
    if (current === null) return context.json({ error: "variable_not_found" }, 404);
    if (current.value !== before.value || current.description !== before.description ||
      current.resetOnStreamStart !== before.resetOnStreamStart || current.createdAt !== before.createdAt ||
      current.updatedAt !== before.updatedAt) {
      return context.json({ error: "variable_changed_concurrently" }, 409);
    }
    const stillAuthorized = await context.env.DB.prepare(
      `SELECT 1 AS allowed FROM channels WHERE channel_id = ? ${authorization.sql}`,
    ).bind(channelId, ...authorization.values).first<{ allowed: number }>();
    if (stillAuthorized === null) return context.json({ error: "variable_value_change_denied" }, 403);
    return context.json({ variable: current });
  }
  const row = mutationResult.results[0] as Record<string, unknown> | undefined;
  const variable = row === undefined ? await findChannelVariable(context.env.DB, channelId, name) : {
    channelId: row.channel_id as string,
    name: row.name as string,
    value: row.value as number,
    description: row.description as string,
    resetOnStreamStart: row.reset_on_stream_start === 1,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
  if (variable !== null) {
    await publishVariablesChanged(context.env.CHANNEL, channelId,
      [{ name: variable.name, value: variable.value }], []);
  }
  return context.json({ variable });
});

variableRouter.delete("/api/channels/:channelId/variables/:name", async (context) => {
  if (!canManage(context.get("channelRole"))) return context.json({ error: "variable_management_denied" }, 403);
  const channelId = context.req.param("channelId");
  const name = context.req.param("name");
  const before = await findChannelVariable(context.env.DB, channelId, name);
  if (before === null) return context.json({ error: "variable_not_found" }, 404);
  const usages = await referencesFor(context.env.DB, channelId, name);
  const actionUsages = usages.filter((usage) => usage.kind === "action");
  if (actionUsages.length > 0) return context.json({ error: "variable_in_use", usages }, 409);
  const now = nowIso();
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), now);
  const bumpOverlayRevisions = context.env.DB.prepare(
    `UPDATE overlays
        SET revision = revision + 1, updated_at = ?
      WHERE channel_id = ?
        AND EXISTS (
          SELECT 1 FROM overlay_elements AS element
           WHERE element.channel_id = overlays.channel_id
             AND element.overlay_id = overlays.overlay_id
             AND element.variable_name = ?
        )
        AND EXISTS (
          SELECT 1 FROM channel_variables
           WHERE channel_id = ? AND name = ? AND value = ? AND description = ?
             AND reset_on_stream_start = ? AND created_at = ? AND updated_at = ?
        )
        ${authorization.sql}
      RETURNING overlay_id, revision`,
  ).bind(now, channelId, name, channelId, name, before.value, before.description,
    before.resetOnStreamStart ? 1 : 0, before.createdAt, before.updatedAt, ...authorization.values);
  const detachOverlayElements = context.env.DB.prepare(
    `UPDATE overlay_elements
        SET variable_name = NULL
      WHERE channel_id = ? AND variable_name = ?
        AND EXISTS (
          SELECT 1 FROM channel_variables
           WHERE channel_id = ? AND name = ? AND value = ? AND description = ?
             AND reset_on_stream_start = ? AND created_at = ? AND updated_at = ?
        )
        ${authorization.sql}`,
  ).bind(channelId, name, channelId, name, before.value, before.description, before.resetOnStreamStart ? 1 : 0,
    before.createdAt, before.updatedAt, ...authorization.values);
  const mutation = context.env.DB.prepare(
    `DELETE FROM channel_variables
      WHERE channel_id = ? AND name = ? AND value = ? AND description = ? AND reset_on_stream_start = ?
        AND created_at = ? AND updated_at = ? ${authorization.sql}`,
  ).bind(channelId, name, before.value, before.description, before.resetOnStreamStart ? 1 : 0,
    before.createdAt, before.updatedAt, ...authorization.values);
  const audit = prepareAudit(context.env.DB, context.get("actor").userId, now, channelId, null,
    "channel.variable.removed", recordSnapshot(before), null);
  try {
    const results = await context.env.DB.batch([bumpOverlayRevisions, detachOverlayElements, mutation, audit]);
    if ((results[2]?.meta.changes ?? 0) > 0) {
      const overlayRows = (results[0]?.results ?? []) as Array<{ overlay_id: string; revision: number }>;
      const overlayMessages = overlayRows.map((row) => overlayChangedMessage(channelId, row.overlay_id, row.revision));
      await publishVariablesChanged(context.env.CHANNEL, channelId, [], [name], overlayMessages);
      return new Response(null, { status: 204 });
    }
  } catch {
    const latestUsages = await referencesFor(context.env.DB, channelId, name);
    if (latestUsages.some((usage) => usage.kind === "action")) {
      return context.json({ error: "variable_in_use", usages: latestUsages }, 409);
    }
    throw new Error("Channel variable deletion failed.");
  }
  return context.json({ error: "variable_changed_concurrently" }, 409);
});
