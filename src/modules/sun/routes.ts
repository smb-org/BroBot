import { Hono } from "hono";
import { z } from "zod";

import { canManage } from "../../contracts/values";
import type { ModuleRouteEnvironment } from "../contract";
import { DEFAULT_SUN_ERROR_TEXTS, readSunSettings } from "./adapters/d1";
import { SUN_ERROR_TEXT_MAX_LENGTH } from "./contracts";

const updateSchema = z.object({
  revision: z.number().int().min(1),
  errorTexts: z.object({ de: z.string().max(SUN_ERROR_TEXT_MAX_LENGTH), en: z.string().max(SUN_ERROR_TEXT_MAX_LENGTH) }),
});

const channelIdOf = (context: { req: { param: (name: string) => string | undefined } }): string =>
  context.req.param("channelId") ?? "";

const errorText = (value: string, fallback: string): string => value.trim().length === 0 ? fallback : value.trim();

export const sunRoutes = new Hono<ModuleRouteEnvironment>();

sunRoutes.get("/error-texts", async (context) => {
  return context.json(await readSunSettings(context.env.DB, channelIdOf(context)));
});

sunRoutes.patch("/error-texts", async (context) => {
  if (!canManage(context.get("channelRole"))) return context.json({ error: "sun_settings_denied" }, 403);
  const raw: unknown = await context.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) return context.json({ error: "sun_settings_invalid" }, 400);
  const channelId = channelIdOf(context);
  const current = await readSunSettings(context.env.DB, channelId);
  if (parsed.data.revision !== current.revision) return context.json({ error: "sun_settings_conflict" }, 409);
  const changedAt = new Date().toISOString();
  const revision = current.revision + 1;
  const normalizedErrors = {
    de: errorText(parsed.data.errorTexts.de, DEFAULT_SUN_ERROR_TEXTS.de),
    en: errorText(parsed.data.errorTexts.en, DEFAULT_SUN_ERROR_TEXTS.en),
  };
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), changedAt);
  const mutation = current.revision === 1
    ? context.env.DB.prepare(
      `INSERT INTO sun_settings (channel_id, error_text_de, error_text_en, revision, updated_at)
       SELECT ?, ?, ?, ?, ? WHERE 1 = 1 ${authorization.sql}
       ON CONFLICT(channel_id) DO UPDATE
         SET error_text_de = excluded.error_text_de,
             error_text_en = excluded.error_text_en,
             revision = sun_settings.revision + 1,
             updated_at = excluded.updated_at
       WHERE sun_settings.revision = ? ${authorization.sql}`,
    ).bind(channelId, normalizedErrors.de, normalizedErrors.en, revision, changedAt,
      ...authorization.values, current.revision, ...authorization.values)
    : context.env.DB.prepare(
      `UPDATE sun_settings
          SET error_text_de = ?, error_text_en = ?, revision = revision + 1, updated_at = ?
        WHERE channel_id = ? AND revision = ? ${authorization.sql}`,
    ).bind(normalizedErrors.de, normalizedErrors.en, changedAt, channelId, current.revision, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: "sun",
    action: "sun.settings_changed",
    before: { errorTextDe: current.errorTexts.de, errorTextEn: current.errorTexts.en },
    after: { errorTextDe: normalizedErrors.de, errorTextEn: normalizedErrors.en },
  }, changedAt);
  const result = await context.env.DB.batch([mutation, audit]);
  if ((result[0]?.meta.changes ?? 0) === 0) return context.json({ error: "sun_settings_conflict" }, 409);
  return context.json(await readSunSettings(context.env.DB, channelId));
});
