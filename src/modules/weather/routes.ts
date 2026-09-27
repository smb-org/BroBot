import { Hono } from "hono";
import { z } from "zod";

import { canManage } from "../../contracts/values";
import type { ModuleRouteEnvironment } from "../contract";
import { DEFAULT_WEATHER_ERROR_TEXTS, readWeatherSettings } from "./adapters/d1";
import { WEATHER_ERROR_TEXT_MAX_LENGTH, WEATHER_PROVIDERS } from "./contracts";

const updateSchema = z.object({
  revision: z.number().int().min(1),
  provider: z.enum(WEATHER_PROVIDERS),
  showFahrenheit: z.boolean(),
  errorTexts: z.object({ de: z.string().max(WEATHER_ERROR_TEXT_MAX_LENGTH), en: z.string().max(WEATHER_ERROR_TEXT_MAX_LENGTH) }),
});

const channelIdOf = (context: { req: { param: (name: string) => string | undefined } }): string =>
  context.req.param("channelId") ?? "";

const normalizedError = (value: string, fallback: string): string => value.trim().length === 0 ? fallback : value.trim();

export const weatherRoutes = new Hono<ModuleRouteEnvironment>();

weatherRoutes.get("/provider-settings", async (context) => context.json(await readWeatherSettings(context.env.DB, channelIdOf(context))));

weatherRoutes.patch("/provider-settings", async (context) => {
  if (!canManage(context.get("channelRole"))) return context.json({ error: "weather_settings_denied" }, 403);
  const raw: unknown = await context.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success) return context.json({ error: "weather_settings_invalid" }, 400);
  const channelId = channelIdOf(context);
  const current = await readWeatherSettings(context.env.DB, channelId);
  if (parsed.data.revision !== current.revision) return context.json({ error: "weather_settings_conflict" }, 409);
  const changedAt = new Date().toISOString();
  const values = {
    provider: parsed.data.provider,
    showFahrenheit: parsed.data.showFahrenheit,
    errorTexts: {
      de: normalizedError(parsed.data.errorTexts.de, DEFAULT_WEATHER_ERROR_TEXTS.de),
      en: normalizedError(parsed.data.errorTexts.en, DEFAULT_WEATHER_ERROR_TEXTS.en),
    },
  };
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), changedAt);
  const mutation = current.revision === 1
    ? context.env.DB.prepare(
      `INSERT INTO weather_settings (channel_id, provider, show_fahrenheit, error_text_de, error_text_en, revision, updated_at)
       SELECT ?, ?, ?, ?, ?, 2, ? WHERE 1 = 1 ${authorization.sql}
       ON CONFLICT(channel_id) DO UPDATE SET provider = excluded.provider,
         show_fahrenheit = excluded.show_fahrenheit, error_text_de = excluded.error_text_de,
         error_text_en = excluded.error_text_en, revision = weather_settings.revision + 1,
         updated_at = excluded.updated_at
       WHERE weather_settings.revision = 1 ${authorization.sql}`,
    ).bind(channelId, values.provider, Number(values.showFahrenheit), values.errorTexts.de, values.errorTexts.en,
      changedAt, ...authorization.values, ...authorization.values)
    : context.env.DB.prepare(
      `UPDATE weather_settings SET provider = ?, show_fahrenheit = ?, error_text_de = ?, error_text_en = ?,
         revision = revision + 1, updated_at = ? WHERE channel_id = ? AND revision = ? ${authorization.sql}`,
    ).bind(values.provider, Number(values.showFahrenheit), values.errorTexts.de, values.errorTexts.en,
      changedAt, channelId, current.revision, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: "weather",
    action: "weather.settings_changed",
    before: { provider: current.provider, showFahrenheit: current.showFahrenheit, errorTextDe: current.errorTexts.de, errorTextEn: current.errorTexts.en },
    after: { provider: values.provider, showFahrenheit: values.showFahrenheit, errorTextDe: values.errorTexts.de, errorTextEn: values.errorTexts.en },
  }, changedAt);
  const result = await context.env.DB.batch([mutation, audit]);
  if ((result[0]?.meta.changes ?? 0) === 0) return context.json({ error: "weather_settings_conflict" }, 409);
  const updated = await readWeatherSettings(context.env.DB, channelId);
  await context.get("publishOverlayHostEvent")(channelId, "template.data.changed");
  return context.json(updated);
});
