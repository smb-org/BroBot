import { z } from "zod";

import type { BotModule, ModuleChannelLocation, ModuleTemplateValueContext } from "../contract";
import { validChannelTimeZone, type TemplateVariable } from "../contract";
import { DEFAULT_MOON_ERROR_TEXTS, readMoonSettings } from "./adapters/d1";
import { MOON_ERROR_TEXT_MAX_LENGTH } from "./contracts";
import { moonModuleCatalog } from "./contracts/catalog";
import { nextMoonEvents, resolveMoonTemplateValues, type MoonLocation } from "./domain";
import { moonRoutes } from "./routes";

const settingsSchema = z.object({});

const MOON_TEMPLATE_VARIABLE_SAMPLES: Readonly<Record<string, string>> = {
  "moon.phase": "Waxing gibbous",
  "moon.illumination": "74",
  "moon.rise": "20:42",
  "moon.set": "08:15",
  "moon.rise_in": "2 hr 15 min",
  "moon.set_in": "8 hr 30 min",
};

const MOON_TEMPLATE_VARIABLES: readonly TemplateVariable[] = Object.entries(MOON_TEMPLATE_VARIABLE_SAMPLES).map(([name, sample]) => ({
  name,
  localizedDescription: { de: moonModuleCatalog.de.variableDescriptions[name] ?? name, en: moonModuleCatalog.en.variableDescriptions[name] ?? name },
  group: "time_random",
  maxLength: MOON_ERROR_TEXT_MAX_LENGTH,
  sample,
  source: "module",
}));

const validLocationFor = (location: ModuleChannelLocation | null, channelTimeZone: string): MoonLocation | null =>
  validChannelTimeZone(channelTimeZone) && location !== null && validChannelTimeZone(location.timeZone)
    ? { latitude: location.latitude, longitude: location.longitude, timeZone: location.timeZone }
    : null;

const resolveValues = async (names: readonly string[], context: ModuleTemplateValueContext) => {
  const needsEvents = names.some((name) => name === "moon.rise" || name === "moon.set" || name === "moon.rise_in" || name === "moon.set_in");
  const [language, settings, locationSetting, channelTimeZone] = await Promise.all([
    context.channelLanguage(),
    needsEvents ? readMoonSettings(context.DB, context.channelId) : Promise.resolve(null),
    needsEvents ? context.channelLocation() : Promise.resolve(null),
    needsEvents ? context.channelTimeZone() : Promise.resolve("UTC"),
  ]);
  const resolved = resolveMoonTemplateValues({
    location: needsEvents ? validLocationFor(locationSetting, channelTimeZone) : null,
    now: context.now,
    timeZone: validChannelTimeZone(channelTimeZone) ? channelTimeZone : "Europe/Berlin",
    language,
    errorText: settings?.errorTexts[language] ?? DEFAULT_MOON_ERROR_TEXTS[language],
    names,
  });
  return Object.fromEntries(names.flatMap((name) => resolved.values[name] === undefined ? [] : [[name, resolved.values[name]]]));
};

const resolveOverlayValues: NonNullable<BotModule<typeof settingsSchema>["resolveOverlayTemplateValues"]> = async (names, context) => {
  const requested = new Set(names);
  const eventNames = ["moon.rise", "moon.rise_in", "moon.set", "moon.set_in"].filter((name) => requested.has(name));
  if (eventNames.length === 0) return {};
  const [locationSetting, channelTimeZone] = await Promise.all([context.channelLocation(), context.channelTimeZone()]);
  const location = validLocationFor(locationSetting, channelTimeZone);
  if (location === null) return Object.fromEntries(eventNames.map((name) => [name, { available: false }]));
  const events = nextMoonEvents(location, context.now);
  return Object.fromEntries(eventNames.map((name) => {
    const targets = name.startsWith("moon.rise") ? events.riseAts : events.setAts;
    return [name, {
      available: targets.length > 0,
      ...(targets[0] === undefined ? {} : { targetAt: targets[0] }),
      ...(name.endsWith("_in") && targets.length > 0 ? { targetAts: targets } : {}),
    }];
  }));
};

export const moonModule: BotModule<typeof settingsSchema> = {
  id: "moon",
  panelIcon: { paths: ["M20.9 13.1A8.5 8.5 0 0 1 10.9 3.1 8.5 8.5 0 1 0 20.9 13.1z"] },
  mandatory: true,
  mandatoryReason: {
    de: moonModuleCatalog.de.mandatoryReason,
    en: moonModuleCatalog.en.mandatoryReason,
  },
  defaultEnabled: true,
  settingsSchema,
  defaultSettings: {},
  templateVariables: () => Promise.resolve(MOON_TEMPLATE_VARIABLES),
  templateUnavailableText: DEFAULT_MOON_ERROR_TEXTS,
  resolveTemplateValues: resolveValues,
  dynamicTemplateVariableNames: ["moon.rise_in", "moon.set_in"],
  resolveOverlayTemplateValues: resolveOverlayValues,
  routes: moonRoutes,
  panel: () => import("./panel/settings"),
};

export { calculateMoonDay, calculateMoonPosition, calculateMoonState, localDateInTimeZone, nextMoonEvents, resolveMoonTemplateValues, shiftLocalDate } from "./domain";
export type { MoonDay, MoonLocation, MoonPosition, ResolvedMoonTemplateValues } from "./domain";
