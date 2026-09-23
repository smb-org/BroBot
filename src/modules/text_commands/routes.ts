import { Hono } from "hono";
import { z } from "zod";

import type { ModuleRouteEnvironment } from "./contract";
import { createTextCommandRepository } from "./adapters/d1";
import { TEXT_COMMAND_MINIMUM_TIERS, TEXT_COMMAND_TEMPLATE_FIELDS } from "./contracts";
import { validCommandName } from "./domain";
import { templateFieldsWarnings } from "./contract";

const bodySchema = z.object({
  name: z.string(),
  kind: z.enum(["text", "list"]).default("text"),
  minimumTier: z.enum(TEXT_COMMAND_MINIMUM_TIERS).default("everyone"),
  text: z.string().max(500).optional(),
  cooldownSeconds: z.number().int().min(0).max(86400),
});
const editBodySchema = z.object({
  name: z.string().optional(),
  text: z.string().max(500).optional(),
  kind: z.enum(["text", "list"]).optional(),
  cooldownSeconds: z.number().int().min(0).max(86400).optional(),
  minimumTier: z.enum(TEXT_COMMAND_MINIMUM_TIERS).optional(),
  enabled: z.boolean().optional(),
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
  if (!parsed.success || !validCommandName(parsed.data.name)) return null;
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
  if (context.get("channelRole") === "operator") return managementDenied(context);
  const repository = createTextCommandRepository(
    context.env.DB,
    context.get("authorizeManagementMutation"),
    context.get("prepareModuleAudit"),
  );
  const channelId = param(context, "channelId");
  const warnings = body.kind === "list"
    ? []
    : templateFieldsWarnings({ text: body.text ?? "" }, TEXT_COMMAND_TEMPLATE_FIELDS);
  const created = await repository.create({ channelId, ...body, text: body.text ?? "", now: nowIso() }, context.get("actor"));
  if (created.ok) return context.json({ command: { ...body, channelId, lastUsedAt: null }, warnings }, 201);
  return created.reason === "existiert"
    ? context.json({ error: "command_already_exists" }, 409)
    : context.json({ error: "command_creation_denied" }, 403);
});

textCommandRoutes.patch("/commands/:name", async (context) => {
  const body = await validEditBody(context.req.raw);
  if (body === null) return context.json({ error: "command_data_invalid" }, 400);
  const repository = createTextCommandRepository(
    context.env.DB,
    context.get("authorizeMutation"),
    context.get("prepareModuleAudit"),
  );
  const channelId = param(context, "channelId");
  const oldName = param(context, "name");
  const before = await repository.find(channelId, oldName);
  if (before === null) return context.json({ error: "command_not_found" }, 404);
  const newName = body.name ?? before.name;
  if (!validCommandName(newName)) return context.json({ error: "command_data_invalid" }, 400);
  const contentChanged = Object.keys(body).some((key) => key !== "enabled");
  if (contentChanged && context.get("channelRole") === "operator") return managementDenied(context);
  const kind = body.kind ?? before.kind;
  const text = kind === "list" ? "" : body.text ?? before.text;
  if (kind === "text" && text.trim().length === 0) {
    return context.json({ error: "command_data_invalid" }, 400);
  }
  const cooldownSeconds = body.cooldownSeconds ?? before.cooldownSeconds;
  const minimumTier = body.minimumTier ?? before.minimumTier;
  const warnings = kind === "list"
    ? []
    : templateFieldsWarnings({ text }, TEXT_COMMAND_TEMPLATE_FIELDS);
  const authorizeMutation = contentChanged
    ? context.get("authorizeManagementMutation")
    : context.get("authorizeMutation");
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
    minimumTier: minimumTier,
    enabled: body.enabled ?? before.enabled,
    onlyToggle: !contentChanged,
    now: nowIso(),
  }, context.get("actor"));
  if (changed.ok) return context.json({ command: { ...before, ...body, channelId, name: newName, text, kind, cooldownSeconds, minimumTier: minimumTier, enabled: body.enabled ?? before.enabled }, warnings });
  if (changed.reason === "nicht_gefunden") return context.json({ error: "command_not_found" }, 404);
  if (changed.reason === "nicht_berechtigt") return context.json({ error: "command_update_denied" }, 403);
  if (changed.reason === "konflikt") return context.json({ error: "command_changed_concurrently" }, 409);
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
  if (context.get("channelRole") === "operator") return managementDenied(context);
  const deleted = await repository.delete(channelId, name, context.get("actor"), nowIso());
  if (deleted.ok) return new Response(null, { status: 204 });
  if (deleted.reason === "nicht_gefunden") return context.json({ error: "command_not_found" }, 404);
  if (deleted.reason === "nicht_berechtigt") return context.json({ error: "command_delete_denied" }, 403);
  if (deleted.reason === "konflikt") return context.json({ error: "command_changed_concurrently" }, 409);
  return context.json({ error: "command_changed_concurrently" }, 409);
});
