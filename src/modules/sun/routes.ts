import { Hono } from "hono";
import { z } from "zod";

import { canManage } from "../../contracts/values";
import type { ModuleRouteEnvironment } from "../contract";
import { validChannelTimeZone } from "../contract";
import { DEFAULT_SUN_ERROR_TEXTS, readSunSettings } from "./adapters/d1";
import { SUN_ERROR_TEXT_MAX_LENGTH } from "./contracts";

const locationSchema = z.object({
  name: z.string().trim().min(1).max(160),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  timeZone: z.string().trim().min(1).max(80),
});
const updateSchema = z.object({
  revision: z.number().int().min(1),
  location: locationSchema.nullable(),
  errorTexts: z.object({ de: z.string().max(SUN_ERROR_TEXT_MAX_LENGTH), en: z.string().max(SUN_ERROR_TEXT_MAX_LENGTH) }),
});

interface GeocodingResponse {
  results?: readonly {
    name?: unknown;
    latitude?: unknown;
    longitude?: unknown;
    timezone?: unknown;
    country?: unknown;
    admin1?: unknown;
  }[];
}

const channelIdOf = (context: { req: { param: (name: string) => string | undefined } }): string =>
  context.req.param("channelId") ?? "";

const errorText = (value: string, fallback: string): string => value.trim().length === 0 ? fallback : value.trim();

export const sunRoutes = new Hono<ModuleRouteEnvironment>();

sunRoutes.get("/settings", async (context) => {
  return context.json(await readSunSettings(context.env.DB, channelIdOf(context)));
});

sunRoutes.get("/geocode", async (context) => {
  const query = (context.req.query("q") ?? "").trim();
  const language = context.req.query("language") === "en" ? "en" : "de";
  if (query.length < 2 || query.length > 100) return context.json({ results: [] });
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", query);
  url.searchParams.set("count", "8");
  url.searchParams.set("language", language);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return context.json({ error: "sun_geocoding_unavailable" }, 503);
    const payload: GeocodingResponse = await response.json();
    const results = (payload.results ?? []).flatMap((entry) => {
      const name = entry.name;
      const latitude = entry.latitude;
      const longitude = entry.longitude;
      const timeZone = entry.timezone;
      const country = entry.country;
      const admin1 = entry.admin1;
      if (typeof name !== "string" || name.length === 0 || typeof latitude !== "number" || !Number.isFinite(latitude) ||
          typeof longitude !== "number" || !Number.isFinite(longitude) || typeof timeZone !== "string" || !validChannelTimeZone(timeZone)) return [];
      return [{
        name,
        latitude,
        longitude,
        timeZone,
        country: typeof country === "string" ? country : "",
        admin1: typeof admin1 === "string" && admin1.length > 0 ? admin1 : null,
      }];
    });
    return context.json({ results });
  } catch {
    return context.json({ error: "sun_geocoding_unavailable" }, 503);
  }
});

sunRoutes.patch("/settings", async (context) => {
  if (!canManage(context.get("channelRole"))) return context.json({ error: "sun_settings_denied" }, 403);
  const raw: unknown = await context.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(raw);
  if (!parsed.success || parsed.data.location !== null && !validChannelTimeZone(parsed.data.location.timeZone)) {
    return context.json({ error: "sun_settings_invalid" }, 400);
  }
  const channelId = channelIdOf(context);
  const current = await readSunSettings(context.env.DB, channelId);
  if (parsed.data.revision !== current.revision) return context.json({ error: "sun_settings_conflict" }, 409);
  const location = parsed.data.location;
  const changedAt = new Date().toISOString();
  const revision = current.revision + 1;
  const normalizedErrors = {
    de: errorText(parsed.data.errorTexts.de, DEFAULT_SUN_ERROR_TEXTS.de),
    en: errorText(parsed.data.errorTexts.en, DEFAULT_SUN_ERROR_TEXTS.en),
  };
  const authorization = context.get("authorizeManagementMutation")(channelId, context.get("actor"), changedAt);
  const locationValues = location === null
    ? [null, null, null, null]
    : [location.name, location.latitude, location.longitude, location.timeZone];
  const mutation = current.revision === 1 && current.location === null
    ? context.env.DB.prepare(
      `INSERT INTO sun_locations
        (channel_id, name, latitude, longitude, location_time_zone, error_text_de, error_text_en, revision, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM sun_locations WHERE channel_id = ?)
        ${authorization.sql}`,
    ).bind(channelId, ...locationValues, normalizedErrors.de, normalizedErrors.en, revision, changedAt, channelId, ...authorization.values)
    : context.env.DB.prepare(
      `UPDATE sun_locations
          SET name = ?, latitude = ?, longitude = ?, location_time_zone = ?, error_text_de = ?, error_text_en = ?,
              revision = revision + 1, updated_at = ?
        WHERE channel_id = ? AND revision = ? ${authorization.sql}`,
    ).bind(...locationValues, normalizedErrors.de, normalizedErrors.en, changedAt, channelId, current.revision, ...authorization.values);
  const audit = context.get("prepareModuleAudit")({
    channelId,
    moduleId: "sun",
    action: "sun.settings_changed",
    before: {
      locationName: current.location?.name ?? null,
      latitude: current.location?.latitude ?? null,
      longitude: current.location?.longitude ?? null,
      locationTimeZone: current.location?.timeZone ?? null,
      errorTextDe: current.errorTexts.de,
      errorTextEn: current.errorTexts.en,
    },
    after: {
      locationName: location?.name ?? null,
      latitude: location?.latitude ?? null,
      longitude: location?.longitude ?? null,
      locationTimeZone: location?.timeZone ?? null,
      errorTextDe: normalizedErrors.de,
      errorTextEn: normalizedErrors.en,
    },
  }, changedAt);
  const result = await context.env.DB.batch([mutation, audit]);
  if ((result[0]?.meta.changes ?? 0) === 0) return context.json({ error: "sun_settings_conflict" }, 409);
  const updated = await readSunSettings(context.env.DB, channelId);
  return context.json(updated);
});
