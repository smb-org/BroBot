import type { SunSettings, SunLocation } from "../contracts";
import { sunModuleCatalog } from "../contracts/catalog";

interface SunLocationRow {
  name: string | null;
  latitude: number | null;
  longitude: number | null;
  location_time_zone: string | null;
  error_text_de: string;
  error_text_en: string;
  revision: number;
}

export const DEFAULT_SUN_ERROR_TEXTS = {
  de: sunModuleCatalog.de.unavailableText,
  en: sunModuleCatalog.en.unavailableText,
} as const;

export const readSunSettings = async (db: D1Database, channelId: string): Promise<SunSettings> => {
  const row = await db.prepare(
    `SELECT name, latitude, longitude, location_time_zone, error_text_de, error_text_en, revision
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
  };
};
