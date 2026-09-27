import type { MoonSettings } from "../contracts";
import { moonModuleCatalog } from "../contracts/catalog";

interface MoonSettingsRow {
  error_text_de: string;
  error_text_en: string;
  revision: number;
}

export const DEFAULT_MOON_ERROR_TEXTS = {
  de: moonModuleCatalog.de.unavailableText,
  en: moonModuleCatalog.en.unavailableText,
} as const;

export const readMoonSettings = async (db: D1Database, channelId: string): Promise<MoonSettings> => {
  const row = await db.prepare(
    `SELECT error_text_de, error_text_en, revision
       FROM moon_settings WHERE channel_id = ?`,
  ).bind(channelId).first<MoonSettingsRow>();
  return {
    errorTexts: {
      de: row === null ? DEFAULT_MOON_ERROR_TEXTS.de : row.error_text_de.trim() || DEFAULT_MOON_ERROR_TEXTS.de,
      en: row === null ? DEFAULT_MOON_ERROR_TEXTS.en : row.error_text_en.trim() || DEFAULT_MOON_ERROR_TEXTS.en,
    },
    revision: row?.revision ?? 1,
  };
};
