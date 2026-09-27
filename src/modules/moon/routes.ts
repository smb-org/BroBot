import { Hono } from "hono";
import { z } from "zod";

import { canManage } from "../../contracts/values";
import type { ModuleRouteEnvironment } from "../contract";
import { DEFAULT_MOON_ERROR_TEXTS, readMoonSettings } from "./adapters/d1";
import { MOON_ERROR_TEXT_MAX_LENGTH } from "./contracts";

const updateSchema = z.object({
  revision: z.number().int().min(1),
  errorTexts: z.object({ de: z.string().max(MOON_ERROR_TEXT_MAX_LENGTH), en: z.string().max(MOON_ERROR_TEXT_MAX_LENGTH) }),
});

const channelIdOf = (context: { req: { param: (name: string) => string | undefined } }): string =>
  context.req.param("channelId") ?? "";

const errorText = (value: string, fallback: string): string => value.trim().length === 0 ? fallback : value.trim();

export const moonRoutes = new Hono<ModuleRouteEnvironment>();

moonRoutes.get("/unavailable-texts", async (context) => {
  return context.json(await readMoonSettings(context.env.DB, channelIdOf(context)));
});

moonRoutes.patch("/unavailable-texts", async (context) => {
  if (!canManage(context.get("channelRole"))) return context.json({ error: "moon_settings_denied" }, 403);
  const raw: unknown = await context.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) return context.json({ error: "moon_settings_invalid" }, 400);
  const channelId = channelIdOf(context);
  const current = await readMoonSettings(context.env.DB, channelId);
  if (parsed.data.revision !== current.revision) return context.json({ error: "moon_settings_conflict" }, 409);
  const changedAt = new Date().toISOString();
  const revision = current.revision + 1;
  const normalizedErrors = {
    de: errorText(parsed.data.errorTexts.de, DEFAULT_MOON_ERROR_TEXTS.de),
    en: errorText(parsed.data.errorTexts.en, DEFAULT_MOON_ERROR_TEXTS.en),
  };
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), changedAt);
  const mutation = current.revision === 1
    ? context.env.DB.prepare(
      `INSERT INTO moon_settings (channel_id, error_text_de, error_text_en, revision, updated_at)
       SELECT ?, ?, ?, ?, ? WHERE 1 = 1 ${authorization.sql}
       ON CONFLICT(channel_id) DO UPDATE
         SET error_text_de = excluded.error_text_de,
             error_text_en = excluded.error_text_en,
             revision = moon_settings.revision + 1,
             updated_at = excluded.updated_at
       WHERE moon_settings.revision = ? ${authorization.sql}`,
    ).bind(channelId, normalizedErrors.de, normalizedErrors.en, revision, changedAt,
      ...authorization.values, current.revision, ...authorization.values)
    : context.env.DB.prepare(
      `UPDATE moon_settings
          SET error_text_de = ?, error_text_en = ?, revision = revision + 1, updated_at = ?
        WHERE channel_id = ? AND revision = ? ${authorization.sql}`,
    ).bind(normalizedErrors.de, normalizedErrors.en, changedAt, channelId, current.revision, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: "moon",
    action: "moon.settings_changed",
    before: { errorTextDe: current.errorTexts.de, errorTextEn: current.errorTexts.en },
    after: { errorTextDe: normalizedErrors.de, errorTextEn: normalizedErrors.en },
  }, changedAt);
  const result = await context.env.DB.batch([mutation, audit]);
  if ((result[0]?.meta.changes ?? 0) === 0) return context.json({ error: "moon_settings_conflict" }, 409);
  const updated = await readMoonSettings(context.env.DB, channelId);
  await context.get("publishOverlayHostEvent")(channelId, "template.data.changed");
  return context.json(updated);
});
