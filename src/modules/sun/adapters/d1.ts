import type { SunStoredDay, SunSettings, SunLocation } from "../contracts";
import type { SunDay } from "../domain";
import { sunModuleCatalog } from "../contracts/catalog";

interface SunLocationRow {
  name: string | null;
  latitude: number | null;
  longitude: number | null;
  location_time_zone: string | null;
  error_text_de: string;
  error_text_en: string;
  revision: number;
  next_refresh_at: string | null;
}

interface SunDayRow {
  local_date: string;
  sunrise_at: string | null;
  sunset_at: string | null;
  dusk_at: string | null;
  polar_state: "normal" | "day" | "night";
  fetched_at: string;
  expires_at: string;
  channel_time_zone: string;
  location_revision: number;
}

export const DEFAULT_SUN_ERROR_TEXTS = {
  de: sunModuleCatalog.de.unavailableText,
  en: sunModuleCatalog.en.unavailableText,
} as const;

export const readSunSettings = async (db: D1Database, channelId: string): Promise<SunSettings> => {
  const row = await db.prepare(
    `SELECT name, latitude, longitude, location_time_zone, error_text_de, error_text_en, revision, next_refresh_at
       FROM sun_locations WHERE channel_id = ?`,
  ).bind(channelId).first<SunLocationRow>();
  const location: SunLocation | null = row !== null && row.name !== null &&
    row.latitude !== null && row.longitude !== null && row.location_time_zone !== null
    ? { name: row.name, latitude: row.latitude, longitude: row.longitude, timeZone: row.location_time_zone }
    : null;
  return {
    location,
    errorTexts: {
      de: row === null ? DEFAULT_SUN_ERROR_TEXTS.de : row.error_text_de.trim() || DEFAULT_SUN_ERROR_TEXTS.de,
      en: row === null ? DEFAULT_SUN_ERROR_TEXTS.en : row.error_text_en.trim() || DEFAULT_SUN_ERROR_TEXTS.en,
    },
    revision: row?.revision ?? 1,
    nextRefreshAt: row?.next_refresh_at ?? null,
  };
};

export const readSunDays = async (
  db: D1Database,
  channelId: string,
  channelTimeZone: string,
  now: number,
): Promise<SunStoredDay[]> => {
  const result = await db.prepare(
    `SELECT local_date, sunrise_at, sunset_at, dusk_at, polar_state, fetched_at, expires_at, channel_time_zone, location_revision
       FROM sun_times
      WHERE channel_id = ? AND channel_time_zone = ? AND expires_at > ?
      ORDER BY local_date`,
  ).bind(channelId, channelTimeZone, new Date(now).toISOString()).all<SunDayRow>();
  return result.results.map((row) => ({
    localDate: row.local_date,
    sunriseAt: row.sunrise_at,
    sunsetAt: row.sunset_at,
    duskAt: row.dusk_at,
    polarState: row.polar_state,
    fetchedAt: row.fetched_at,
    expiresAt: row.expires_at,
    channelTimeZone: row.channel_time_zone,
    locationRevision: row.location_revision,
  }));
};

export const sunDayInsert = (
  db: D1Database,
  channelId: string,
  day: SunDay,
  values: { fetchedAt: string; expiresAt: string; channelTimeZone: string; locationRevision: number },
): D1PreparedStatement => db.prepare(
  `INSERT INTO sun_times
    (channel_id, local_date, sunrise_at, sunset_at, dusk_at, polar_state, fetched_at, expires_at, channel_time_zone, location_revision)
   SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM sun_locations
       WHERE channel_id = ? AND revision = ? AND name IS NOT NULL
    )`,
).bind(
  channelId, day.localDate, day.sunriseAt, day.sunsetAt, day.duskAt, day.polarState,
  values.fetchedAt, values.expiresAt, values.channelTimeZone, values.locationRevision,
  channelId, values.locationRevision,
);
