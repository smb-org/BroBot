import type { SunSettings } from "../contracts";
import { sunModuleCatalog } from "../contracts/catalog";

interface SunSettingsRow {
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
    `SELECT error_text_de, error_text_en, revision
       FROM sun_settings WHERE channel_id = ?`,
  ).bind(channelId).first<SunSettingsRow>();
  return {
    errorTexts: {
      de: row === null ? DEFAULT_SUN_ERROR_TEXTS.de : row.error_text_de.trim() || DEFAULT_SUN_ERROR_TEXTS.de,
      en: row === null ? DEFAULT_SUN_ERROR_TEXTS.en : row.error_text_en.trim() || DEFAULT_SUN_ERROR_TEXTS.en,
    },
    revision: row?.revision ?? 1,
  };
};
