import { z } from "zod";

import type { BotModule, ModuleChannelLocation, ModuleTemplateConditionContext, ModuleTemplateValueContext } from "../contract";
import { validChannelTimeZone, type TemplateVariable } from "../contract";
import { DEFAULT_WEATHER_ERROR_TEXTS, readWeatherSettings } from "./adapters/d1";
import { fetchCachedWeather } from "./adapters/cache";
import { geocodeWeatherPlace } from "./adapters/geocoding";
import { weatherModuleCatalog, WEATHER_CONDITION_LABELS, WEATHER_TEMPLATE_VARIABLE_NAMES } from "./contracts/catalog";
import type { WeatherCondition, WeatherSettings } from "./contracts";
import { resolveWeatherValues } from "./domain";
import { weatherRoutes } from "./routes";

const settingsSchema = z.object({});
const weatherIcon = { paths: ["M5 15a4 4 0 0 1 .8-7.92A6 6 0 0 1 17.5 9H18a3 3 0 1 1 0 6H5Z", "M8 18l-1 2", "M13 18l-1 2", "M18 18l-1 2"] } as const;
const WEATHER_VARIABLES: readonly TemplateVariable[] = WEATHER_TEMPLATE_VARIABLE_NAMES.map((name) => ({
  name,
  localizedDescription: { de: weatherModuleCatalog.de.templateVariables[name].description, en: weatherModuleCatalog.en.templateVariables[name].description },
  group: "time_random",
  maxLength: name === "weather.forecast" ? 120 : 60,
  sample: weatherModuleCatalog.de.templateVariables[name].sample,
  source: "module",
  external: true,
  picker: {
    de: weatherModuleCatalog.de.templateVariables[name],
    en: weatherModuleCatalog.en.templateVariables[name],
  },
}));
const unavailableText = {
  de: weatherModuleCatalog.de.unavailableText,
  en: weatherModuleCatalog.en.unavailableText,
} as const;
/** Retry delay after a provider failure, so a recovered overlay stops showing a stale error. */
const LOOKUP_FAILURE_RETRY_MS = 30_000;

const errorTextsFor = (settings: WeatherSettings) => settings.errorTexts;

const placeFor = async (
  context: Pick<ModuleTemplateValueContext, "channelLocation" | "channelLanguage" | "commandInput">,
): Promise<{ location: ModuleChannelLocation | null; unknownPlace: boolean }> => {
  const requestedPlace = context.commandInput?.arguments.trim() ?? "";
  if (requestedPlace.length === 0) return { location: await context.channelLocation(), unknownPlace: false };
  const lookup = await geocodeWeatherPlace(requestedPlace, await context.channelLanguage());
  return lookup.kind === "found" ? { location: lookup.location, unknownPlace: false } : { location: null, unknownPlace: true };
};

const valuesFor = async (
  names: readonly string[],
  context: ModuleTemplateValueContext,
  settings: WeatherSettings,
): Promise<Readonly<Record<string, string>>> => {
  const language = await context.channelLanguage();
  try {
    const place = await placeFor(context);
    if (place.unknownPlace) {
      const text = weatherModuleCatalog[language].unknownPlace;
      return Object.fromEntries(names.map((name) => [name, text]));
    }
    const location = place.location;
    if (location === null || !validChannelTimeZone(location.timeZone)) throw new Error("Weather location is unavailable.");
    const cached = await fetchCachedWeather(context.DB, settings.provider, location.latitude, location.longitude, context.now);
    const result = resolveWeatherValues({
      names,
      locationName: location.name,
      weather: cached.weather,
      language,
      timeZone: location.timeZone,
      showFahrenheit: settings.showFahrenheit,
    });
    context.addTemplateValueAttribution?.(settings.provider === "met_norway" ? "MET Norway" : "Open-Meteo");
    return result;
  } catch {
    const message = errorTextsFor(settings)[language];
    return Object.fromEntries(names.map((name) => [name, message]));
  }
};

const resolveConditions = async (
  ids: readonly string[],
  context: ModuleTemplateConditionContext,
): Promise<Readonly<Record<string, string>>> => {
  if (!ids.includes("weather.condition")) return {};
  try {
    const [settings, locationSetting] = await Promise.all([
      readWeatherSettings(context.DB, context.channelId),
      context.commandInput?.arguments.trim()
        ? geocodeWeatherPlace(context.commandInput.arguments, "en").then((result) => result.kind === "found" ? result.location : null)
        : context.channelLocation(),
    ]);
    if (locationSetting === null || !validChannelTimeZone(locationSetting.timeZone)) return {};
    const cached = await fetchCachedWeather(context.DB, settings.provider, locationSetting.latitude, locationSetting.longitude, context.now);
    const condition: WeatherCondition = cached.weather.condition;
    context.addTemplateValueAttribution?.(settings.provider === "met_norway" ? "MET Norway" : "Open-Meteo");
    context.addTemplateConditionNextChangeAt?.(new Date(cached.expiresAt).toISOString());
    return { "weather.condition": condition };
  } catch {
    return {};
  }
};

const resolveOverlayValues: NonNullable<BotModule<typeof settingsSchema>["resolveOverlayTemplateValues"]> = async (names, context) => {
  const requested = new Set(names);
  const relevant = WEATHER_TEMPLATE_VARIABLE_NAMES.filter((name) => requested.has(name));
  if (relevant.length === 0) return {};
  try {
    const [settings, location] = await Promise.all([
      readWeatherSettings(context.DB, context.channelId),
      context.channelLocation(),
    ]);
    if (location === null || !validChannelTimeZone(location.timeZone)) return Object.fromEntries(relevant.map((name) => [name, { available: false }]));
    const cached = await fetchCachedWeather(context.DB, settings.provider, location.latitude, location.longitude, context.now);
    return Object.fromEntries(relevant.map((name) => [name, {
      available: true,
      nextChangeAt: new Date(cached.expiresAt).toISOString(),
    }]));
  } catch {
    return Object.fromEntries(relevant.map((name) => [name, {
      available: false,
      nextChangeAt: new Date(context.now + LOOKUP_FAILURE_RETRY_MS).toISOString(),
    }]));
  }
};

export const weatherModule: BotModule<typeof settingsSchema> = {
  id: "weather",
  navigationCategory: "data",
  panelIcon: weatherIcon,
  templateVariableGroup: {
    label: { de: weatherModuleCatalog.de.variableGroup, en: weatherModuleCatalog.en.variableGroup },
    icon: weatherIcon,
    order: 25,
  },
  templateVariableCatalog: WEATHER_VARIABLES,
  mandatory: true,
  mandatoryReason: {
    de: weatherModuleCatalog.de.mandatoryReason,
    en: weatherModuleCatalog.en.mandatoryReason,
  },
  defaultEnabled: true,
  settingsSchema,
  defaultSettings: {},
  templateUnavailableText: unavailableText,
  templateVariables: () => Promise.resolve(WEATHER_VARIABLES),
  resolveTemplateValues: async (names, context) => {
    const settings = await readWeatherSettings(context.DB, context.channelId).catch(() => ({
      provider: "met_norway" as const,
      showFahrenheit: false,
      errorTexts: DEFAULT_WEATHER_ERROR_TEXTS,
      revision: 1,
    }));
    return valuesFor(names, context, settings);
  },
  resolveTemplateConditions: resolveConditions,
  textBlockConditions: [{
    id: "weather.condition",
    label: { de: weatherModuleCatalog.de.condition, en: weatherModuleCatalog.en.condition },
    values: Object.fromEntries(Object.keys(WEATHER_CONDITION_LABELS.en).map((condition) => [condition, {
      de: WEATHER_CONDITION_LABELS.de[condition as WeatherCondition],
      en: WEATHER_CONDITION_LABELS.en[condition as WeatherCondition],
    }])),
  }],
  resolveOverlayTemplateValues: resolveOverlayValues,
  routes: weatherRoutes,
  navigationEntries: [{
    id: "weather",
    label: { de: weatherModuleCatalog.de.label, en: weatherModuleCatalog.en.label },
    description: { de: weatherModuleCatalog.de.description, en: weatherModuleCatalog.en.description },
    iconKind: "weather",
    keywords: ["weather", "wetter", "forecast", "vorhersage"],
  }],
  panel: () => import("./panel/settings"),
};

export { fetchCachedWeather } from "./adapters/cache";
export { metNorwayWeather, openMeteoWeather } from "./adapters/providers";
export { geocodeWeatherPlace, validWeatherPlaceName } from "./adapters/geocoding";
export { resolveWeatherValues, weatherConditionFromMetSymbol, weatherConditionFromWmoCode } from "./domain";
