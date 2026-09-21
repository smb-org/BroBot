import { Hono } from "hono";
import { z } from "zod";

import type { ModuleRouteEnvironment } from "./contract";
import { createTextbefehlRepository } from "./adapters/d1";
import { TEXTBEFEHL_MINDESTSTUFEN } from "./contracts";
import { gueltigerBefehlsname } from "./domain";

const bodySchema = z.object({
  name: z.string(),
  art: z.enum(["text", "liste"]).default("text"),
  mindeststufe: z.enum(TEXTBEFEHL_MINDESTSTUFEN).default("alle"),
  text: z.string().optional(),
  cooldownSekunden: z.number().int().min(0).max(86400),
});
const editBodySchema = z.object({
  name: z.string().optional(),
  text: z.string().optional(),
  art: z.enum(["text", "liste"]).optional(),
  cooldownSekunden: z.number().int().min(0).max(86400).optional(),
  mindeststufe: z.enum(TEXTBEFEHL_MINDESTSTUFEN).optional(),
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
  if (!parsed.success || !gueltigerBefehlsname(parsed.data.name)) return null;
  if (parsed.data.art === "text" && (parsed.data.text === undefined || parsed.data.text.trim().length === 0)) return null;
  return { ...parsed.data, text: parsed.data.art === "liste" ? "" : parsed.data.text ?? "" };
};

const validEditBody = async (request: Request): Promise<z.infer<typeof editBodySchema> | null> => {
  const parsed = editBodySchema.safeParse(await readBody(request));
  if (!parsed.success || Object.keys(parsed.data).length === 0) return null;
  return parsed.data;
};

const managementDenied = (context: { json: (body: { error: string }, status: 403) => Response }): Response =>
  context.json({ error: "Nur Broadcaster und Verwalter dürfen Befehle anlegen, ändern oder löschen." }, 403);

export const textbefehlRoutes = new Hono<ModuleRouteEnvironment>();

const param = (context: { req: { param: (name: string) => string | undefined } }, name: string): string =>
  context.req.param(name) ?? "";

textbefehlRoutes.get("/befehle", async (context) => {
  const repository = createTextbefehlRepository(context.env.DB, context.get("authorizeMutation"));
  return context.json({ befehle: await repository.auflisten(param(context, "channelId")) });
});

textbefehlRoutes.post("/befehle", async (context) => {
  const body = await validBody(context.req.raw);
  if (body === null) return context.json({ error: "Befehlsdaten sind ungültig." }, 400);
  if (context.get("channelRole") === "bediener") return managementDenied(context);
  const repository = createTextbefehlRepository(
    context.env.DB,
    context.get("authorizeManagementMutation"),
    context.get("prepareModuleAudit"),
  );
  const channelId = param(context, "channelId");
  const angelegt = await repository.anlegen({ channelId, ...body, text: body.text ?? "", now: nowIso() }, context.get("actor"));
  if (angelegt.ok) return context.json({ befehl: { ...body, channelId, zuletztVerwendetAt: null } }, 201);
  return angelegt.grund === "existiert"
    ? context.json({ error: "Der Befehl existiert bereits." }, 409)
    : context.json({ error: "Der Befehl darf nicht angelegt werden." }, 403);
});

textbefehlRoutes.patch("/befehle/:name", async (context) => {
  const body = await validEditBody(context.req.raw);
  if (body === null) return context.json({ error: "Befehlsdaten sind ungültig." }, 400);
  const repository = createTextbefehlRepository(
    context.env.DB,
    context.get("authorizeMutation"),
    context.get("prepareModuleAudit"),
  );
  const channelId = param(context, "channelId");
  const oldName = param(context, "name");
  const before = await repository.finden(channelId, oldName);
  if (before === null) return context.json({ error: "Der Befehl wurde nicht gefunden." }, 404);
  const newName = body.name ?? before.name;
  if (!gueltigerBefehlsname(newName)) return context.json({ error: "Befehlsdaten sind ungültig." }, 400);
  const contentChanged = Object.keys(body).some((key) => key !== "enabled");
  if (contentChanged && context.get("channelRole") === "bediener") return managementDenied(context);
  const art = body.art ?? before.art;
  const text = art === "liste" ? "" : body.text ?? before.text;
  if (art === "text" && text.trim().length === 0) {
    return context.json({ error: "Befehlsdaten sind ungültig." }, 400);
  }
  const cooldownSekunden = body.cooldownSekunden ?? before.cooldownSekunden;
  const mindeststufe = body.mindeststufe ?? before.mindeststufe;
  const authorizeMutation = contentChanged
    ? context.get("authorizeManagementMutation")
    : context.get("authorizeMutation");
  const geaendert = await createTextbefehlRepository(
    context.env.DB,
    authorizeMutation,
    context.get("prepareModuleAudit"),
  ).aendern({
    channelId,
    name: oldName,
    neuerName: newName,
    text,
    art,
    cooldownSekunden,
    mindeststufe,
    enabled: body.enabled ?? before.enabled,
    nurSchalter: !contentChanged,
    now: nowIso(),
  }, context.get("actor"));
  if (geaendert.ok) return context.json({ befehl: { ...before, ...body, channelId, name: newName, text, art, cooldownSekunden, mindeststufe, enabled: body.enabled ?? before.enabled } });
  if (geaendert.grund === "nicht_gefunden") return context.json({ error: "Der Befehl wurde nicht gefunden." }, 404);
  if (geaendert.grund === "nicht_berechtigt") return context.json({ error: "Der Befehl darf nicht geändert werden." }, 403);
  return context.json({ error: "Der Befehl wurde inzwischen geändert." }, 409);
});

textbefehlRoutes.delete("/befehle/:name", async (context) => {
  const repository = createTextbefehlRepository(
    context.env.DB,
    context.get("authorizeManagementMutation"),
    context.get("prepareModuleAudit"),
  );
  const channelId = param(context, "channelId");
  const name = param(context, "name");
  if (await repository.finden(channelId, name) === null) return context.json({ error: "Der Befehl wurde nicht gefunden." }, 404);
  if (context.get("channelRole") === "bediener") return managementDenied(context);
  const geloescht = await repository.loeschen(channelId, name, context.get("actor"), nowIso());
  if (geloescht.ok) return new Response(null, { status: 204 });
  if (geloescht.grund === "nicht_gefunden") return context.json({ error: "Der Befehl wurde nicht gefunden." }, 404);
  if (geloescht.grund === "nicht_berechtigt") return context.json({ error: "Der Befehl darf nicht gelöscht werden." }, 403);
  return context.json({ error: "Der Befehl wurde inzwischen geändert." }, 409);
});
