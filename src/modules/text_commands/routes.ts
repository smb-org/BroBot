import { Hono } from "hono";
import { z } from "zod";

import { canManage } from "../../contracts/values";
import type { TextCommand, TextCommandVariableAction } from "./contracts";
import type { TextCommandAliasConflict } from "./repository";
import {
  TEXT_COMMAND_MAX_ALIASES,
  TEXT_COMMAND_KINDS,
  TEXT_COMMAND_MINIMUM_TIERS,
  TEXT_COMMAND_RESPONSE_TYPES,
  TEXT_COMMAND_STREAM_CONDITIONS,
} from "./contracts";
import { SYSTEM_TEMPLATE_VARIABLE_LIST, effectiveTemplateVariables, templateWarnings, type ModuleChannelVariable, type ModuleRouteEnvironment, type TemplateVariable } from "../contract";
import { createTextCommandRepository } from "./adapters/d1";
import { COMMAND_NAME_PATTERN, initialTextCommandRevision, validCommandName } from "./domain";
import { textCommandDefaultsFor } from "./contracts/chat-defaults";

const aliasesSchema = z.array(z.string().regex(COMMAND_NAME_PATTERN))
  .max(TEXT_COMMAND_MAX_ALIASES)
  .refine((aliases) => new Set(aliases).size === aliases.length);

const bodySchema = z.object({
  name: z.string(),
  kind: z.enum(TEXT_COMMAND_KINDS).default("text"),
  minimumTier: z.enum(TEXT_COMMAND_MINIMUM_TIERS).optional(),
  text: z.string().max(500).optional(),
  offlineText: z.string().max(500).optional(),
  notFollowingText: z.string().max(500).optional(),
  unavailableText: z.string().max(500).optional(),
  usageText: z.string().max(500).optional(),
  cooldownSeconds: z.number().int().min(0).max(86400),
  aliases: aliasesSchema.default([]),
  userCooldownSeconds: z.number().int().min(0).max(86400).default(0),
  streamCondition: z.enum(TEXT_COMMAND_STREAM_CONDITIONS).default("any"),
  responseType: z.enum(TEXT_COMMAND_RESPONSE_TYPES).default("say"),
  variableAction: z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u),
    operation: z.enum(["add", "subtract", "set", "set_argument"]),
    amount: z.number().int().min(-999999999).max(999999999),
  }).nullable().default(null),
});

const editBodySchema = z.object({
  revision: z.number().int().min(1).optional(),
  name: z.string().optional(),
  text: z.string().max(500).optional(),
  kind: z.enum(TEXT_COMMAND_KINDS).optional(),
  offlineText: z.string().max(500).optional(),
  notFollowingText: z.string().max(500).optional(),
  unavailableText: z.string().max(500).optional(),
  usageText: z.string().max(500).optional(),
  cooldownSeconds: z.number().int().min(0).max(86400).optional(),
  minimumTier: z.enum(TEXT_COMMAND_MINIMUM_TIERS).optional(),
  enabled: z.boolean().optional(),
  aliases: aliasesSchema.optional(),
  userCooldownSeconds: z.number().int().min(0).max(86400).optional(),
  streamCondition: z.enum(TEXT_COMMAND_STREAM_CONDITIONS).optional(),
  responseType: z.enum(TEXT_COMMAND_RESPONSE_TYPES).optional(),
  variableAction: z.object({
    name: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u),
    operation: z.enum(["add", "subtract", "set", "set_argument"]),
    amount: z.number().int().min(-999999999).max(999999999),
  }).nullable().optional(),
});

const nowIso = (): string => new Date().toISOString();

const validVariableAction = (action: TextCommandVariableAction | null): boolean => action === null || (
  action.operation === "add" || action.operation === "subtract"
    ? action.amount !== null && action.amount >= 1 && action.amount <= 1000
    : action.operation === "set_argument"
      ? action.amount === 0
      : action.amount !== null && action.amount >= -999999999 && action.amount <= 999999999
);

type TemplateInput = Pick<TextCommand, "offlineText" | "notFollowingText" | "unavailableText" | "usageText"> & { text: string };

const defaultsForKind = (kind: TextCommand["kind"]): Partial<TemplateInput> =>
  kind === "shoutout" ? textCommandDefaultsFor(kind) : {};

const readBody = async (request: Request): Promise<unknown> => {
  try {
    return await request.json();
  } catch {
    return null;
  }
};

type ValidTextCommandBody = Omit<z.infer<typeof bodySchema>, "text" | "offlineText" | "notFollowingText" | "unavailableText" | "usageText" | "minimumTier"> &
  { minimumTier: TextCommand["minimumTier"] } & TemplateInput;

const validBody = async (request: Request): Promise<ValidTextCommandBody | null> => {
  const parsed = bodySchema.safeParse(await readBody(request));
  if (!parsed.success || !validCommandName(parsed.data.name) || parsed.data.aliases.includes(parsed.data.name)) return null;
  const variableAction = parsed.data.variableAction;
  if (variableAction !== null && parsed.data.kind !== "text") return null;
  if (!validVariableAction(variableAction)) return null;
  const defaults = defaultsForKind(parsed.data.kind);
  const text = parsed.data.kind === "list" ? "" : parsed.data.text ?? defaults.text ?? "";
  if (parsed.data.kind !== "list" && text.trim().length === 0 && variableAction === null) return null;
  const offlineText = parsed.data.offlineText ?? defaults.offlineText;
  const notFollowingText = parsed.data.notFollowingText ?? defaults.notFollowingText;
  const unavailableText = parsed.data.unavailableText ?? defaults.unavailableText;
  const usageText = parsed.data.usageText ?? defaults.usageText;
  const body: ValidTextCommandBody = {
    name: parsed.data.name,
    kind: parsed.data.kind,
    minimumTier: parsed.data.minimumTier ?? (variableAction?.operation === "set_argument" ? "moderator" : "everyone"),
    cooldownSeconds: parsed.data.cooldownSeconds,
    aliases: parsed.data.aliases,
    userCooldownSeconds: parsed.data.userCooldownSeconds,
    streamCondition: parsed.data.streamCondition,
    responseType: parsed.data.responseType,
    variableAction,
    text,
    ...(offlineText === undefined ? {} : { offlineText }),
    ...(notFollowingText === undefined ? {} : { notFollowingText }),
    ...(unavailableText === undefined ? {} : { unavailableText }),
    ...(usageText === undefined ? {} : { usageText }),
  };
  if (parsed.data.kind === "shoutout" && body.usageText?.trim().length === 0) return null;
  return body;
};

const validEditBody = async (request: Request): Promise<z.infer<typeof editBodySchema> | null> => {
  const parsed = editBodySchema.safeParse(await readBody(request));
  if (!parsed.success || Object.keys(parsed.data).every((key) => key === "revision")) return null;
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

const effectiveCommandVariables = (variables: readonly ModuleChannelVariable[]): TemplateVariable[] => {
  const channelVariables: TemplateVariable[] = variables.map((variable) => ({
    name: `var.${variable.name}`,
    group: "channel",
    sample: String(variable.value),
    maxLength: 10,
    source: "channel",
  }));
  return effectiveTemplateVariables("chat_command", [], channelVariables, SYSTEM_TEMPLATE_VARIABLE_LIST);
};

const warningsForText = (text: string, variables: readonly TemplateVariable[]) => templateWarnings("text", text, variables);

textCommandRoutes.get("/commands", async (context) => {
  const channelId = param(context, "channelId");
  const repository = createTextCommandRepository(context.env.DB, context.get("authorizeMutation"));
  const [commands, variables] = await Promise.all([
    repository.list(channelId),
    context.get("listChannelVariables")(channelId),
  ]);
  return context.json({ commands, variables: variables.map(({ name, value, description }) => ({ name, value, description })) });
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
  if (body.variableAction !== null && await context.get("findChannelVariable")(channelId, body.variableAction.name) === null) {
    return context.json({ error: "command_data_invalid" }, 400);
  }
  const now = nowIso();
  const variables = effectiveCommandVariables(await context.get("listChannelVariables")(channelId));
  const warnings = body.kind === "list"
    ? []
    : warningsForText(body.text, variables);
  const created = await repository.create({ channelId, ...body, now }, context.get("actor"));
  if (created.ok) {
    const command: TextCommand = {
      channelId,
      name: body.name,
      text: body.text,
      kind: body.kind,
      ...(body.offlineText === undefined ? {} : { offlineText: body.offlineText }),
      ...(body.notFollowingText === undefined ? {} : { notFollowingText: body.notFollowingText }),
      ...(body.unavailableText === undefined ? {} : { unavailableText: body.unavailableText }),
      ...(body.usageText === undefined ? {} : { usageText: body.usageText }),
      enabled: true,
      minimumTier: body.minimumTier,
      cooldownSeconds: body.cooldownSeconds,
      aliases: body.aliases,
      userCooldownSeconds: body.userCooldownSeconds,
      streamCondition: body.streamCondition,
      responseType: body.responseType,
      variableAction: body.variableAction,
      useCount: 0,
      lastUsedAt: null,
      createdAt: now,
      updatedAt: now,
      revision: initialTextCommandRevision(now),
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
  if (body.revision === undefined) return context.json({ error: "command_data_invalid" }, 400);
  if (body.revision !== before.revision) {
    return context.json({ error: "command_changed_concurrently", current: before }, 409);
  }
  const newName = body.name ?? before.name;
  if (!validCommandName(newName)) return context.json({ error: "command_data_invalid" }, 400);
  const aliases = body.aliases ?? before.aliases;
  if (aliases.includes(newName)) return context.json({ error: "command_data_invalid" }, 400);
  const contentChanged = Object.keys(body).some((key) => key !== "enabled" && key !== "revision");
  if (contentChanged && !canManage(context.get("channelRole"))) return managementDenied(context);
  const kind = body.kind ?? before.kind;
  const defaults = defaultsForKind(kind);
  const kindChanged = kind !== before.kind;
  const variableAction = body.variableAction === undefined ? before.variableAction : body.variableAction;
  if (variableAction !== null && kind !== "text") return context.json({ error: "command_data_invalid" }, 400);
  if (!validVariableAction(variableAction)) return context.json({ error: "command_data_invalid" }, 400);
  const text = kind === "list" ? "" : body.text ?? (kindChanged ? defaults.text ?? before.text : before.text);
  const offlineText = body.offlineText ?? (kindChanged ? defaults.offlineText : before.offlineText);
  const notFollowingText = body.notFollowingText ?? (kindChanged ? defaults.notFollowingText : before.notFollowingText);
  const unavailableText = body.unavailableText ?? (kindChanged ? defaults.unavailableText : before.unavailableText);
  const usageText = body.usageText ?? (kindChanged ? defaults.usageText : before.usageText);
  const templateValues: Pick<TextCommand, "offlineText" | "notFollowingText" | "unavailableText" | "usageText"> = {
    ...(offlineText === undefined ? {} : { offlineText }),
    ...(notFollowingText === undefined ? {} : { notFollowingText }),
    ...(unavailableText === undefined ? {} : { unavailableText }),
    ...(usageText === undefined ? {} : { usageText }),
  };
  if (kind !== "list" && text.trim().length === 0 && variableAction === null) {
    return context.json({ error: "command_data_invalid" }, 400);
  }
  if (kind === "shoutout" && !templateValues.usageText?.trim()) {
    return context.json({ error: "command_data_invalid" }, 400);
  }
  if (variableAction !== null && await context.get("findChannelVariable")(channelId, variableAction.name) === null) {
    return context.json({ error: "command_data_invalid" }, 400);
  }
  const cooldownSeconds = body.cooldownSeconds ?? before.cooldownSeconds;
  const minimumTier = body.minimumTier ?? (variableAction?.operation === "set_argument" && before.variableAction?.operation !== "set_argument"
    ? "moderator"
    : before.minimumTier);
  const userCooldownSeconds = body.userCooldownSeconds ?? before.userCooldownSeconds;
  const streamCondition = body.streamCondition ?? before.streamCondition;
  const responseType = body.responseType ?? before.responseType;
  const warnings = kind === "list"
    ? []
    : warningsForText(text, effectiveCommandVariables(await context.get("listChannelVariables")(channelId)));
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
    ...templateValues,
    cooldownSeconds,
    minimumTier,
    enabled: body.enabled ?? before.enabled,
    aliases,
    userCooldownSeconds,
    streamCondition,
    responseType,
    variableAction,
    ...(before.legacyFallback === undefined ? {} : { legacyFallback: before.legacyFallback }),
    expectedRevision: body.revision,
    onlyToggle: !contentChanged,
    now,
  }, context.get("actor"));
  if (changed.ok) {
    const command: TextCommand = {
      ...before,
      channelId,
      name: newName,
      text,
      kind,
      ...templateValues,
      cooldownSeconds,
      minimumTier,
      aliases: [...aliases],
      userCooldownSeconds,
      streamCondition,
      responseType,
      variableAction,
      useCount: before.useCount,
      enabled: body.enabled ?? before.enabled,
      updatedAt: now,
      revision: before.revision + 1,
    };
    return context.json({ command, warnings });
  }
  if (changed.reason === "not_found") return context.json({ error: "command_not_found" }, 404);
  if (changed.reason === "not_authorized") return context.json({ error: "command_update_denied" }, 403);
  if (changed.reason === "already_exists") return context.json({ error: "command_already_exists" }, 409);
  if (changed.reason === "alias_conflict" && changed.conflict !== undefined) {
    return aliasConflictResponse(context, changed.conflict);
  }
  if (changed.reason === "conflict" && changed.current !== undefined) {
    return context.json({ error: "command_changed_concurrently", current: changed.current }, 409);
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
  const before = await repository.find(channelId, name);
  if (before === null) return context.json({ error: "command_not_found" }, 404);
  if (!canManage(context.get("channelRole"))) return managementDenied(context);
  const revisionValue = context.req.query("revision");
  const expectedRevision = revisionValue === undefined ? Number.NaN : Number(revisionValue);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    return context.json({ error: "command_data_invalid" }, 400);
  }
  if (expectedRevision !== before.revision) {
    return context.json({ error: "command_changed_concurrently", current: before }, 409);
  }
  const deleted = await repository.delete(channelId, name, expectedRevision, context.get("actor"), nowIso());
  if (deleted.ok) return new Response(null, { status: 204 });
  if (deleted.reason === "not_found") return context.json({ error: "command_not_found" }, 404);
  if (deleted.reason === "not_authorized") return context.json({ error: "command_delete_denied" }, 403);
  if (deleted.reason === "conflict" && deleted.current !== undefined) {
    return context.json({ error: "command_changed_concurrently", current: deleted.current }, 409);
  }
  return context.json({ error: "command_changed_concurrently" }, 409);
});
