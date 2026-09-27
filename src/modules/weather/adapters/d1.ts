import type { WeatherSettings } from "../contracts";
import { WEATHER_PROVIDERS } from "../contracts";
import { weatherModuleCatalog } from "../contracts/catalog";

interface WeatherSettingsRow {
  provider: string;
  show_fahrenheit: number;
  error_text_de: string;
  error_text_en: string;
  revision: number;
}

export const DEFAULT_WEATHER_ERROR_TEXTS = {
  de: weatherModuleCatalog.de.unavailableText,
  en: weatherModuleCatalog.en.unavailableText,
} as const;

export const readWeatherSettings = async (db: D1Database, channelId: string): Promise<WeatherSettings> => {
  const row = await db.prepare(
    `SELECT provider, show_fahrenheit, error_text_de, error_text_en, revision
       FROM weather_settings WHERE channel_id = ?`,
  ).bind(channelId).first<WeatherSettingsRow>();
  const provider = WEATHER_PROVIDERS.find((candidate) => candidate === row?.provider) ?? "met_norway";
  return {
    provider,
    showFahrenheit: row?.show_fahrenheit === 1,
    errorTexts: {
      de: row === null ? DEFAULT_WEATHER_ERROR_TEXTS.de : row.error_text_de.trim() || DEFAULT_WEATHER_ERROR_TEXTS.de,
      en: row === null ? DEFAULT_WEATHER_ERROR_TEXTS.en : row.error_text_en.trim() || DEFAULT_WEATHER_ERROR_TEXTS.en,
    },
    revision: row?.revision ?? 1,
  };
};
