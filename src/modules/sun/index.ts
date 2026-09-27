import { z } from "zod";

import type { BotModule, ModuleTemplateConditionContext, ModuleTemplateConditionTimelineContext, ModuleTemplateValueContext, ModuleTemplateConditionTransition } from "../contract";
import { validChannelTimeZone, type TemplateVariable } from "../contract";
import { DEFAULT_SUN_ERROR_TEXTS, readSunSettings } from "./adapters/d1";
import { SUN_ERROR_TEXT_MAX_LENGTH } from "./contracts";
import { resolveSunTemplateValues } from "./domain";
import { sunRoutes } from "./routes";
import { sunModuleCatalog } from "./contracts/catalog";
import { calculateSunDay, localDateInTimeZone, shiftLocalDate } from "./domain";

const settingsSchema = z.object({});
const SUN_TEMPLATE_VARIABLES: readonly TemplateVariable[] = [
  { name: "sun.set", group: "time_random", maxLength: SUN_ERROR_TEXT_MAX_LENGTH, sample: "18:42", source: "module" },
  { name: "sun.rise", group: "time_random", maxLength: SUN_ERROR_TEXT_MAX_LENGTH, sample: "06:18", source: "module" },
  { name: "sun.dusk", group: "time_random", maxLength: SUN_ERROR_TEXT_MAX_LENGTH, sample: "19:24", source: "module" },
  { name: "sun.set_in", group: "time_random", maxLength: SUN_ERROR_TEXT_MAX_LENGTH, sample: "2 Std. 15 Min.", source: "module" },
  { name: "sun.rise_in", group: "time_random", maxLength: SUN_ERROR_TEXT_MAX_LENGTH, sample: "8 Std. 30 Min.", source: "module" },
];

type SunSettings = Awaited<ReturnType<typeof readSunSettings>>;

const resolveSettings = (
  settings: SunSettings,
  now: number,
  timeZone: string,
  language: "de" | "en",
) => {
  const location = validChannelTimeZone(timeZone) && settings.location !== null && validChannelTimeZone(settings.location.timeZone)
    ? settings.location
    : null;
  try {
    return resolveSunTemplateValues({
      location,
      now,
      timeZone: validChannelTimeZone(timeZone) ? timeZone : "Europe/Berlin",
      language,
      errorText: settings.errorTexts[language],
    });
  } catch {
    return resolveSunTemplateValues({
      location: null,
      now,
      timeZone: validChannelTimeZone(timeZone) ? timeZone : "Europe/Berlin",
      language,
      errorText: settings.errorTexts[language],
    });
  }
};

const currentSunValues = async (
  context: Pick<ModuleTemplateValueContext, "DB" | "channelId" | "channelTimeZone" | "channelLanguage" | "now">,
) => {
  const [settings, timeZone, language] = await Promise.all([
    readSunSettings(context.DB, context.channelId),
    context.channelTimeZone(),
    context.channelLanguage(),
  ]);
  return resolveSettings(settings, context.now, timeZone, language);
};

const resolveConditionValues = async (
  ids: readonly string[],
  context: ModuleTemplateConditionContext,
): Promise<Readonly<Record<string, string>>> => {
  if (!ids.includes("sun.phase")) return {};
  try {
    const [settings, timeZone] = await Promise.all([
      readSunSettings(context.DB, context.channelId),
      context.channelTimeZone(),
    ]);
    const phase = resolveSettings(settings, context.now, timeZone, "en").dataConditions["sun.phase"];
    return phase === undefined ? {} : { "sun.phase": phase };
  } catch {
    return {};
  }
};

const validLocationFor = (settings: SunSettings, channelTimeZone: string) =>
  validChannelTimeZone(channelTimeZone) && settings.location !== null && validChannelTimeZone(settings.location.timeZone)
    ? settings.location
    : null;

const resolveConditionTransitions = async (
  ids: readonly string[],
  context: ModuleTemplateConditionTimelineContext,
): Promise<readonly ModuleTemplateConditionTransition[]> => {
  if (!ids.includes("sun.phase")) return [];
  const [settings, channelTimeZone] = await Promise.all([readSunSettings(context.DB, context.channelId), context.channelTimeZone()]);
  const location = validLocationFor(settings, channelTimeZone);
  if (location === null) return [];
  const firstDate = localDateInTimeZone(context.now, location.timeZone);
  const lastDate = localDateInTimeZone(context.until, location.timeZone);
  const transitions: ModuleTemplateConditionTransition[] = [];
  for (let date = firstDate, guard = 0; date <= lastDate && guard < 10; date = shiftLocalDate(date, 1), guard += 1) {
    const day = calculateSunDay({ ...location, localDate: date });
    if (day.sunriseAt !== null && Date.parse(day.sunriseAt) > context.now && Date.parse(day.sunriseAt) <= context.until) {
      transitions.push({ at: day.sunriseAt, values: { "sun.phase": "day" } });
    }
    if (day.sunsetAt !== null && Date.parse(day.sunsetAt) > context.now && Date.parse(day.sunsetAt) <= context.until) {
      transitions.push({ at: day.sunsetAt, values: { "sun.phase": "night" } });
    }
  }
  return transitions.sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
};

const resolveOverlayValues = async (
  names: readonly string[],
  context: { DB: D1Database; channelId: string; now: number; channelTimeZone: () => Promise<string> },
) => {
  const requested = new Set(names);
  const needed = ["sun.set", "sun.rise", "sun.dusk", "sun.set_in", "sun.rise_in"].filter((name) => requested.has(name));
  if (needed.length === 0) return {};
  try {
    const [settings, channelTimeZone] = await Promise.all([readSunSettings(context.DB, context.channelId), context.channelTimeZone()]);
    const location = validLocationFor(settings, channelTimeZone);
    if (location === null) return Object.fromEntries(needed.map((name) => [name, { available: false }]));
    const today = localDateInTimeZone(context.now, location.timeZone);
    const days = [-1, 0, 1, 2, 3, 4, 5, 6, 7].map((offset) => calculateSunDay({
      ...location,
      localDate: shiftLocalDate(today, offset),
    }));
    const future = (pick: (day: ReturnType<typeof calculateSunDay>) => string | null): string[] => days
      .map(pick).filter((value): value is string => value !== null && Number.isFinite(Date.parse(value)) && Date.parse(value) > context.now);
    const events = {
      "sun.set": future((day) => day.sunsetAt),
      "sun.set_in": future((day) => day.sunsetAt),
      "sun.rise": future((day) => day.sunriseAt),
      "sun.rise_in": future((day) => day.sunriseAt),
      "sun.dusk": future((day) => day.duskAt),
    };
    return Object.fromEntries(needed.map((name) => {
      const targets = events[name as keyof typeof events];
      return [name, { available: targets.length > 0, ...(name.endsWith("_in") && targets.length > 0 ? { targetAts: targets } : {}) }];
    }));
  } catch {
    return Object.fromEntries(needed.map((name) => [name, { available: false }]));
  }
};

export const sunModule: BotModule<typeof settingsSchema> = {
  id: "sun",
  panelIcon: { paths: ["M12 3v2", "M12 19v2", "M3 12h2", "M19 12h2", "M5.6 5.6l1.4 1.4", "M17 17l1.4 1.4", "M18.4 5.6 17 7", "M7 17l-1.4 1.4", "M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0"] },
  mandatory: true,
  mandatoryReason: {
    de: sunModuleCatalog.de.mandatoryReason,
    en: sunModuleCatalog.en.mandatoryReason,
  },
  defaultEnabled: true,
  settingsSchema,
  defaultSettings: {},
  templateVariables: () => Promise.resolve(SUN_TEMPLATE_VARIABLES),
  templateUnavailableText: DEFAULT_SUN_ERROR_TEXTS,
  resolveTemplateValues: async (names, context) => {
    const resolved = await currentSunValues(context);
    return Object.fromEntries(names.flatMap((name) => {
      const value = resolved.values[name];
      return value === undefined ? [] : [[name, value]];
    }));
  },
  textBlockConditions: [{
    id: "sun.phase",
    label: { de: "Sonnenphase", en: "Sun phase" },
    timeDependent: true,
    values: {
      day: { de: "Tag", en: "Day" },
      night: { de: "Nacht", en: "Night" },
    },
  }],
  resolveTemplateConditions: resolveConditionValues,
  resolveTemplateConditionTransitions: resolveConditionTransitions,
  dynamicTemplateVariableNames: ["sun.set_in", "sun.rise_in"],
  resolveOverlayTemplateValues: resolveOverlayValues,
  routes: sunRoutes,
  channelSettings: () => import("./panel/location-settings"),
};

export { calculateSunDay, resolveSunTemplateValues } from "./domain";
export type { SunDay } from "./domain";
export type { SunLocation, SunSettings } from "./contracts";
