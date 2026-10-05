import { z } from "zod";

import type { BotModule, ModuleChannelLocation, ModuleOverlayTemplateValue, ModuleTemplateValueContext } from "../contract";
import { validChannelTimeZone, type TemplateVariable } from "../contract";
import { DEFAULT_MOON_ERROR_TEXTS, readMoonSettings } from "./adapters/d1";
import { MOON_ERROR_TEXT_MAX_LENGTH } from "./contracts";
import { moonModuleCatalog, MOON_TEMPLATE_VARIABLE_NAMES } from "./contracts/catalog";
import { nextMoonEvents, nextMoonPhaseChangeAt, resolveMoonTemplateValues, type MoonLocation } from "./domain";
import { moonRoutes } from "./routes";

const settingsSchema = z.object({});

const MOON_TEMPLATE_VARIABLES: readonly TemplateVariable[] = MOON_TEMPLATE_VARIABLE_NAMES.map((name) => ({
  name,
  localizedDescription: {
    de: moonModuleCatalog.de.templateVariables[name].description,
    en: moonModuleCatalog.en.templateVariables[name].description,
  },
  group: "time_random",
  maxLength: MOON_ERROR_TEXT_MAX_LENGTH,
  sample: moonModuleCatalog.de.templateVariables[name].sample,
  source: "module",
  picker: {
    de: moonModuleCatalog.de.templateVariables[name],
    en: moonModuleCatalog.en.templateVariables[name],
  },
}));

const moonPanelIcon = { paths: ["M20.9 13.1A8.5 8.5 0 0 1 10.9 3.1 8.5 8.5 0 1 0 20.9 13.1z"] } as const;

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
  const nextHour = new Date((Math.floor(context.now / (60 * 60 * 1_000)) + 1) * 60 * 60 * 1_000).toISOString();
  const nextPhaseChange = requested.has("moon.phase") ? nextMoonPhaseChangeAt(context.now) : undefined;
  const values: Record<string, ModuleOverlayTemplateValue> = Object.fromEntries(
    ["moon.phase", "moon.illumination"].filter((name) => requested.has(name))
      .map((name) => [name, {
        available: true,
        nextChangeAt: name === "moon.phase" ? nextPhaseChange ?? nextHour : nextHour,
      }]),
  );
  const eventNames = ["moon.rise", "moon.rise_in", "moon.set", "moon.set_in"].filter((name) => requested.has(name));
  if (eventNames.length === 0) return values;
  const [locationSetting, channelTimeZone] = await Promise.all([context.channelLocation(), context.channelTimeZone()]);
  const location = validLocationFor(locationSetting, channelTimeZone);
  if (location === null) {
    return {
      ...values,
      ...Object.fromEntries(eventNames.map((name) => [name, { available: false }])),
    };
  }
  const events = nextMoonEvents(location, context.now);
  return {
    ...values,
    ...Object.fromEntries(eventNames.map((name) => {
      const targets = name.startsWith("moon.rise") ? events.riseAts : events.setAts;
      return [name, {
        available: targets.length > 0,
        ...(targets[0] === undefined ? {} : { targetAt: targets[0] }),
        ...(name.endsWith("_in") && targets.length > 0 ? { targetAts: targets } : {}),
        ...(targets[0] === undefined ? {} : { nextChangeAt: targets[0] }),
      }];
    })),
  };
};

export const moonModule: BotModule<typeof settingsSchema> = {
  id: "moon",
  navigationCategory: "data",
  panelIcon: moonPanelIcon,
  templateVariableGroup: {
    label: { de: moonModuleCatalog.de.variableGroup, en: moonModuleCatalog.en.variableGroup },
    icon: moonPanelIcon,
    order: 20,
  },
  templateVariableCatalog: MOON_TEMPLATE_VARIABLES,
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
