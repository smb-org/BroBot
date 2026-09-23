import { Hono } from "hono";
import { z } from "zod";

import { canManage } from "../../contracts/values";
import type { TextCommand } from "./contracts";
import type { TextCommandAliasConflict } from "./repository";
import {
  TEXT_COMMAND_MAX_ALIASES,
  TEXT_COMMAND_MINIMUM_TIERS,
  TEXT_COMMAND_RESPONSE_TYPES,
  TEXT_COMMAND_STREAM_CONDITIONS,
  TEXT_COMMAND_TEMPLATE_FIELDS,
} from "./contracts";
import type { ModuleRouteEnvironment } from "../contract";
import { createTextCommandRepository } from "./adapters/d1";
import { COMMAND_NAME_PATTERN, validCommandName } from "./domain";
import { templateFieldsWarnings } from "../contract";

const aliasesSchema = z.array(z.string().regex(COMMAND_NAME_PATTERN))
  .max(TEXT_COMMAND_MAX_ALIASES)
  .refine((aliases) => new Set(aliases).size === aliases.length);

const bodySchema = z.object({
  name: z.string(),
  kind: z.enum(["text", "list"]).default("text"),
  minimumTier: z.enum(TEXT_COMMAND_MINIMUM_TIERS).default("everyone"),
  text: z.string().max(500).optional(),
  cooldownSeconds: z.number().int().min(0).max(86400),
  aliases: aliasesSchema.default([]),
  userCooldownSeconds: z.number().int().min(0).max(86400).default(0),
  streamCondition: z.enum(TEXT_COMMAND_STREAM_CONDITIONS).default("any"),
  responseType: z.enum(TEXT_COMMAND_RESPONSE_TYPES).default("say"),
});

const editBodySchema = z.object({
  name: z.string().optional(),
  text: z.string().max(500).optional(),
  kind: z.enum(["text", "list"]).optional(),
  cooldownSeconds: z.number().int().min(0).max(86400).optional(),
  minimumTier: z.enum(TEXT_COMMAND_MINIMUM_TIERS).optional(),
  enabled: z.boolean().optional(),
  aliases: aliasesSchema.optional(),
  userCooldownSeconds: z.number().int().min(0).max(86400).optional(),
  streamCondition: z.enum(TEXT_COMMAND_STREAM_CONDITIONS).optional(),
  responseType: z.enum(TEXT_COMMAND_RESPONSE_TYPES).optional(),
});

const nowIso = (): string => new Date().toISOString();

const readBody = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    return null;
  }
};

const validBody = async (request: Request): Promise<z.infer<typeof bodySchema> | null> => {
  const parsed = bodySchema.safeParse(await readBody(request));
  if (!parsed.success || !validCommandName(parsed.data.name) || parsed.data.aliases.includes(parsed.data.name)) return null;
  if (parsed.data.kind === "text" && (parsed.data.text === undefined || parsed.data.text.trim().length === 0)) return null;
  return { ...parsed.data, text: parsed.data.kind === "list" ? "" : parsed.data.text ?? "" };
};

const validEditBody = async (request: Request): Promise<z.infer<typeof editBodySchema> | null> => {
  const parsed = editBodySchema.safeParse(await readBody(request));
  if (!parsed.success || Object.keys(parsed.data).length === 0) return null;
  return parsed.data;
};

const managementDenied = (context: { json: (body: { error: string }, status: 403) => Response }): Response =>
  context.json({ error: "command_management_denied" }, 403);

const aliasConflictResponse = (
  context: { json: (body: { error: string; conflict: TextCommandAliasConflict }, status: 409) => Response },
  conflict: TextCommandAliasConflict,
): Response => context.json({ error: "command_alias_conflict", conflict }, 409);

export const textCommandRoutes = new Hono<ModuleRouteEnvironment>();

const param = (context: { req: { param: (name: string) => string | undefined } }, name: string): string =>
  context.req.param(name) ?? "";

textCommandRoutes.get("/commands", async (context) => {
  const repository = createTextCommandRepository(context.env.DB, context.get("authorizeMutation"));
  return context.json({ commands: await repository.list(param(context, "channelId")) });
});

textCommandRoutes.post("/commands", async (context) => {
  const body = await validBody(context.req.raw);
  if (body === null) return context.json({ error: "command_data_invalid" }, 400);
  if (!canManage(context.get("channelRole"))) return managementDenied(context);
  const repository = createTextCommandRepository(
    context.env.DB,
    context.get("authorizeManagementMutation"),
    context.get("prepareModuleAudit"),
  );
  const channelId = param(context, "channelId");
  const now = nowIso();
  const warnings = body.kind === "list"
    ? []
    : templateFieldsWarnings({ text: body.text ?? "" }, TEXT_COMMAND_TEMPLATE_FIELDS);
  const created = await repository.create({ channelId, ...body, text: body.text ?? "", now }, context.get("actor"));
  if (created.ok) {
    const command: TextCommand = {
      channelId,
      name: body.name,
      text: body.text ?? "",
      kind: body.kind,
      enabled: true,
      minimumTier: body.minimumTier,
      cooldownSeconds: body.cooldownSeconds,
      aliases: body.aliases,
      userCooldownSeconds: body.userCooldownSeconds,
      streamCondition: body.streamCondition,
      responseType: body.responseType,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    return context.json({ command, warnings }, 201);
  }
  if (created.reason === "alias_conflict" && created.conflict !== undefined) {
    return aliasConflictResponse(context, created.conflict);
  }
  if (created.reason === "already_exists") return context.json({ error: "command_already_exists" }, 409);
  return context.json({ error: "command_creation_denied" }, 403);
});

textCommandRoutes.patch("/commands/:name", async (context) => {
  const body = await validEditBody(context.req.raw);
  if (body === null) return context.json({ error: "command_data_invalid" }, 400);
  const channelId = param(context, "channelId");
  const oldName = param(context, "name");
  const repository = createTextCommandRepository(context.env.DB, context.get("authorizeMutation"));
  const before = await repository.find(channelId, oldName);
  if (before === null) return context.json({ error: "command_not_found" }, 404);
  const newName = body.name ?? before.name;
  if (!validCommandName(newName)) return context.json({ error: "command_data_invalid" }, 400);
  const aliases = body.aliases ?? before.aliases;
  if (aliases.includes(newName)) return context.json({ error: "command_data_invalid" }, 400);
  const contentChanged = Object.keys(body).some((key) => key !== "enabled");
  if (contentChanged && !canManage(context.get("channelRole"))) return managementDenied(context);
  const kind = body.kind ?? before.kind;
  const text = kind === "list" ? "" : body.text ?? before.text;
  if (kind === "text" && text.trim().length === 0) {
    return context.json({ error: "command_data_invalid" }, 400);
  }
  const cooldownSeconds = body.cooldownSeconds ?? before.cooldownSeconds;
  const minimumTier = body.minimumTier ?? before.minimumTier;
  const userCooldownSeconds = body.userCooldownSeconds ?? before.userCooldownSeconds;
  const streamCondition = body.streamCondition ?? before.streamCondition;
  const responseType = body.responseType ?? before.responseType;
  const warnings = kind === "list"
    ? []
    : templateFieldsWarnings({ text }, TEXT_COMMAND_TEMPLATE_FIELDS);
  const authorizeMutation = contentChanged
    ? context.get("authorizeManagementMutation")
    : context.get("authorizeMutation");
  const now = nowIso();
  const changed = await createTextCommandRepository(
    context.env.DB,
    authorizeMutation,
    context.get("prepareModuleAudit"),
  ).change({
    channelId,
    name: oldName,
    newName,
    text,
    kind,
    cooldownSeconds,
    minimumTier,
    enabled: body.enabled ?? before.enabled,
    aliases,
    userCooldownSeconds,
    streamCondition,
    responseType,
    onlyToggle: !contentChanged,
    now,
  }, context.get("actor"));
  if (changed.ok) {
    const command: TextCommand = {
      ...before,
      ...body,
      channelId,
      name: newName,
      text,
      kind,
      cooldownSeconds,
      minimumTier,
      aliases: [...aliases],
      userCooldownSeconds,
      streamCondition,
      responseType,
      enabled: body.enabled ?? before.enabled,
      updatedAt: now,
    };
    return context.json({ command, warnings });
  }
  if (changed.reason === "not_found") return context.json({ error: "command_not_found" }, 404);
  if (changed.reason === "not_authorized") return context.json({ error: "command_update_denied" }, 403);
  if (changed.reason === "already_exists") return context.json({ error: "command_already_exists" }, 409);
  if (changed.reason === "alias_conflict" && changed.conflict !== undefined) {
    return aliasConflictResponse(context, changed.conflict);
  }
  return context.json({ error: "command_changed_concurrently" }, 409);
});

textCommandRoutes.delete("/commands/:name", async (context) => {
  const repository = createTextCommandRepository(
    context.env.DB,
    context.get("authorizeManagementMutation"),
    context.get("prepareModuleAudit"),
  );
  const channelId = param(context, "channelId");
  const name = param(context, "name");
  if (await repository.find(channelId, name) === null) return context.json({ error: "command_not_found" }, 404);
  if (!canManage(context.get("channelRole"))) return managementDenied(context);
  const deleted = await repository.delete(channelId, name, context.get("actor"), nowIso());
  if (deleted.ok) return new Response(null, { status: 204 });
  if (deleted.reason === "not_found") return context.json({ error: "command_not_found" }, 404);
  if (deleted.reason === "not_authorized") return context.json({ error: "command_delete_denied" }, 403);
  return context.json({ error: "command_changed_concurrently" }, 409);
});
