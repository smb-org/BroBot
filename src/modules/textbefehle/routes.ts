import { Hono } from "hono";
import { z } from "zod";

import type { ModuleRouteEnvironment } from "./contract";
import { createTextbefehlRepository } from "./adapters/d1";
import { gueltigerBefehlsname } from "./domain";

const bodySchema = z.object({
  name: z.string(),
  text: z.string(),
  cooldownSekunden: z.number().int().min(0).max(86400),
});
const editBodySchema = bodySchema.omit({ name: true });

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
  if (!parsed.success || !gueltigerBefehlsname(parsed.data.name) || parsed.data.text.trim().length === 0) return null;
  return parsed.data;
};

const validEditBody = async (request: Request): Promise<z.infer<typeof editBodySchema> | null> => {
  const parsed = editBodySchema.safeParse(await readBody(request));
  return parsed.success && parsed.data.text.trim().length > 0 ? parsed.data : null;
};

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
  const repository = createTextbefehlRepository(
    context.env.DB,
    context.get("authorizeMutation"),
    context.get("prepareModuleAudit"),
  );
  const channelId = param(context, "channelId");
  const angelegt = await repository.anlegen({ channelId, ...body, now: nowIso() }, context.get("actor"));
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
  const name = param(context, "name");
  const geaendert = await repository.aendern({ channelId, name, ...body, now: nowIso() }, context.get("actor"));
  if (geaendert.ok) return context.json({ befehl: { channelId, name, ...body } });
  if (geaendert.grund === "nicht_gefunden") return context.json({ error: "Der Befehl wurde nicht gefunden." }, 404);
  if (geaendert.grund === "nicht_berechtigt") return context.json({ error: "Der Befehl darf nicht geändert werden." }, 403);
  return context.json({ error: "Der Befehl wurde inzwischen geändert." }, 409);
});

textbefehlRoutes.delete("/befehle/:name", async (context) => {
  const repository = createTextbefehlRepository(
    context.env.DB,
    context.get("authorizeMutation"),
    context.get("prepareModuleAudit"),
  );
  const geloescht = await repository.loeschen(
    param(context, "channelId"),
    param(context, "name"),
    context.get("actor"),
    nowIso(),
  );
  if (geloescht.ok) return new Response(null, { status: 204 });
  if (geloescht.grund === "nicht_gefunden") return context.json({ error: "Der Befehl wurde nicht gefunden." }, 404);
  if (geloescht.grund === "nicht_berechtigt") return context.json({ error: "Der Befehl darf nicht gelöscht werden." }, 403);
  return context.json({ error: "Der Befehl wurde inzwischen geändert." }, 409);
});
