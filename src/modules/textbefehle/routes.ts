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
  const repository = createTextbefehlRepository(context.env.DB, context.get("authorizeMutation"));
  const channelId = param(context, "channelId");
  const angelegt = await repository.anlegen({ channelId, ...body, now: nowIso() }, context.get("actor"));
  return angelegt
    ? context.json({ befehl: { ...body, channelId, zuletztVerwendetAt: null } }, 201)
    : context.json({ error: "Der Befehl existiert bereits." }, 409);
});

textbefehlRoutes.patch("/befehle/:name", async (context) => {
  const body = await validEditBody(context.req.raw);
  if (body === null) return context.json({ error: "Befehlsdaten sind ungültig." }, 400);
  const repository = createTextbefehlRepository(context.env.DB, context.get("authorizeMutation"));
  const channelId = param(context, "channelId");
  const name = param(context, "name");
  const geaendert = await repository.aendern({ channelId, name, ...body, now: nowIso() }, context.get("actor"));
  return geaendert
    ? context.json({ befehl: { channelId, name, ...body } })
    : context.json({ error: "Der Befehl wurde nicht gefunden." }, 404);
});

textbefehlRoutes.delete("/befehle/:name", async (context) => {
  const repository = createTextbefehlRepository(context.env.DB, context.get("authorizeMutation"));
  const geloescht = await repository.loeschen(
    param(context, "channelId"),
    param(context, "name"),
    context.get("actor"),
    nowIso(),
  );
  return geloescht ? new Response(null, { status: 204 }) : context.json({ error: "Der Befehl wurde nicht gefunden." }, 404);
});
