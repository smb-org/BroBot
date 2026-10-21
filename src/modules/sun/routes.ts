import { Hono } from "hono";
import { z } from "zod";

import { canManage } from "../../contracts/values";
import type { ModuleRouteEnvironment } from "../contract";
import { DEFAULT_SUN_ERROR_TEXTS, readSunSettings } from "./adapters/d1";
import { SUN_ERROR_TEXT_MAX_LENGTH } from "./contracts";
import {
  calculateSunAltitudeIntervals,
  calculateSunDay,
  localDateInTimeZone,
  localMidnightInTimeZone,
  shiftLocalDate,
} from "./domain";

const updateSchema = z.object({
  revision: z.number().int().min(1),
  errorTexts: z.object({ de: z.string().max(SUN_ERROR_TEXT_MAX_LENGTH), en: z.string().max(SUN_ERROR_TEXT_MAX_LENGTH) }),
});

const channelIdOf = (context: { req: { param: (name: string) => string | undefined } }): string =>
  context.req.param("channelId") ?? "";

const errorText = (value: string, fallback: string): string => value.trim().length === 0 ? fallback : value.trim();
const MAX_INTERVAL_SEARCH_RADIUS_DAYS = 32;

const intervalsOverlappingLocalDate = (
  coordinates: { latitude: number; longitude: number; timeZone: string },
  localDate: string,
  kind: "golden" | "blue",
): ReturnType<typeof calculateSunAltitudeIntervals> => {
  const nextLocalDate = shiftLocalDate(localDate, 1);
  const dayStart = Date.parse(localMidnightInTimeZone(localDate, coordinates.timeZone));
  const dayEnd = Date.parse(localMidnightInTimeZone(nextLocalDate, coordinates.timeZone));
  let radius = 1;

  while (radius <= MAX_INTERVAL_SEARCH_RADIUS_DAYS) {
    const firstDate = shiftLocalDate(localDate, -radius);
    const afterLastDate = shiftLocalDate(localDate, radius + 1);
    const scanStart = Date.parse(localMidnightInTimeZone(firstDate, coordinates.timeZone));
    const scanEnd = Date.parse(localMidnightInTimeZone(afterLastDate, coordinates.timeZone));
    const intervals = calculateSunAltitudeIntervals(coordinates, firstDate, radius * 2 + 1, kind);
    const overlapping = intervals.filter(({ startAt, endAt }) => Date.parse(startAt) < dayEnd && Date.parse(endAt) > dayStart);
    const fullyScanned = overlapping.length > 0 && overlapping.every(({ startAt, endAt }) =>
      Date.parse(startAt) > scanStart && Date.parse(endAt) < scanEnd);

    if (fullyScanned || radius === MAX_INTERVAL_SEARCH_RADIUS_DAYS) return overlapping;
    radius = Math.min(radius * 2, MAX_INTERVAL_SEARCH_RADIUS_DAYS);
  }

  return [];
};

export const sunRoutes = new Hono<ModuleRouteEnvironment>();

sunRoutes.get("/today", async (context) => {
  const location = await context.get("channelLocation")(channelIdOf(context));
  if (location === null) return context.json({ status: "location_missing" as const });
  const localDate = localDateInTimeZone(Date.now(), location.timeZone);
  const coordinates = { latitude: location.latitude, longitude: location.longitude, timeZone: location.timeZone };
  const nextLocalDate = shiftLocalDate(localDate, 1);
  return context.json({
    status: "ok" as const,
    day: calculateSunDay({ ...coordinates, localDate }),
    goldenHourIntervals: intervalsOverlappingLocalDate(coordinates, localDate, "golden"),
    blueHourIntervals: intervalsOverlappingLocalDate(coordinates, localDate, "blue"),
    nextDawnAt: calculateSunDay({ ...coordinates, localDate: nextLocalDate }).dawnAt,
  });
});

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
  const updated = await readSunSettings(context.env.DB, channelId);
  await context.get("publishOverlayHostEvent")(channelId, "template.data.changed");
  return context.json(updated);
});
