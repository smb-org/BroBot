import { z } from "zod";

import type {
  BotModule,
  ModuleChannelLocation,
  ModuleTemplateConditionContext,
  ModuleTemplateConditionTimelineContext,
  ModuleTemplateConditionTransition,
  ModuleTemplateValueContext,
} from "../contract";
import { validChannelTimeZone, type TemplateVariable } from "../contract";
import { DEFAULT_SUN_ERROR_TEXTS, readSunSettings } from "./adapters/d1";
import { SUN_ERROR_TEXT_MAX_LENGTH } from "./contracts";
import {
  calculateSunAltitudeIntervals,
  calculateSunPhaseTransitions,
  resolveSunTemplateValues,
} from "./domain";
import { sunRoutes } from "./routes";
import { sunModuleCatalog } from "./contracts/catalog";
import { calculateSunDay, localDateInTimeZone, localMidnightInTimeZone, shiftLocalDate } from "./domain";

const settingsSchema = z.object({});
const SUN_TEMPLATE_VARIABLE_SAMPLES: Readonly<Record<string, string>> = {
  "sun.set": "18:42",
  "sun.rise": "06:18",
  "sun.dusk": "19:24",
  "sun.dawn": "05:10",
  "sun.noon": "12:31",
  "sun.day_length": "12:34",
  "sun.golden_hour": "06:00",
  "sun.golden_hour_in": "2 Std. 15 Min.",
  "sun.golden_hour_end": "06:48",
  "sun.blue_hour": "05:45",
  "sun.blue_hour_in": "8 Std. 30 Min.",
  "sun.set_in": "2 Std. 15 Min.",
  "sun.rise_in": "8 Std. 30 Min.",
  "sun.dawn_in": "7 Std. 30 Min.",
};
const SUN_TEMPLATE_VARIABLES: readonly TemplateVariable[] = Object.entries(SUN_TEMPLATE_VARIABLE_SAMPLES).map(([name, sample]) => ({
  name,
  localizedDescription: { de: sunModuleCatalog.de.variableDescriptions[name] ?? name, en: sunModuleCatalog.en.variableDescriptions[name] ?? name },
  group: "time_random",
  maxLength: SUN_ERROR_TEXT_MAX_LENGTH,
  sample,
  source: "module",
}));

type SunSettings = Awaited<ReturnType<typeof readSunSettings>>;

const resolveSettings = (
  settings: SunSettings,
  location: ModuleChannelLocation | null,
  now: number,
  timeZone: string,
  language: "de" | "en",
) => {
  const resolvedLocation = validChannelTimeZone(timeZone) && location !== null && validChannelTimeZone(location.timeZone)
    ? location
    : null;
  try {
    return resolveSunTemplateValues({
      location: resolvedLocation,
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
  context: Pick<ModuleTemplateValueContext, "DB" | "channelId" | "channelTimeZone" | "channelLocation" | "channelLanguage" | "now">,
) => {
  const [settings, location, timeZone, language] = await Promise.all([
    readSunSettings(context.DB, context.channelId),
    context.channelLocation(),
    context.channelTimeZone(),
    context.channelLanguage(),
  ]);
  return resolveSettings(settings, location, context.now, timeZone, language);
};

const resolveConditionValues = async (
  ids: readonly string[],
  context: ModuleTemplateConditionContext,
): Promise<Readonly<Record<string, string>>> => {
  if (!ids.includes("sun.phase")) return {};
  try {
    const [settings, location, timeZone] = await Promise.all([
      readSunSettings(context.DB, context.channelId),
      context.channelLocation(),
      context.channelTimeZone(),
    ]);
    const phase = resolveSettings(settings, location, context.now, timeZone, "en").dataConditions["sun.phase"];
    return phase === undefined ? {} : { "sun.phase": phase };
  } catch {
    return {};
  }
};

const validLocationFor = (location: ModuleChannelLocation | null, channelTimeZone: string) =>
  validChannelTimeZone(channelTimeZone) && location !== null && validChannelTimeZone(location.timeZone)
    ? location
    : null;

const resolveConditionTransitions = async (
  ids: readonly string[],
  context: ModuleTemplateConditionTimelineContext,
): Promise<readonly ModuleTemplateConditionTransition[]> => {
  if (!ids.includes("sun.phase")) return [];
  const [locationSetting, channelTimeZone] = await Promise.all([context.channelLocation(), context.channelTimeZone()]);
  const location = validLocationFor(locationSetting, channelTimeZone);
  if (location === null) return [];
  return calculateSunPhaseTransitions({
    ...location,
    localDate: localDateInTimeZone(context.now, location.timeZone),
  }, context.now, context.until).map(({ at, phase }): ModuleTemplateConditionTransition => ({
    at,
    values: { "sun.phase": phase },
  }));
};

const resolveOverlayValues = async (
  names: readonly string[],
  context: {
    DB: D1Database;
    channelId: string;
    now: number;
    channelTimeZone: () => Promise<string>;
    channelLocation: () => Promise<ModuleChannelLocation | null>;
  },
) => {
  const requested = new Set(names);
  const needed = Object.keys(SUN_TEMPLATE_VARIABLE_SAMPLES).filter((name) => requested.has(name));
  if (needed.length === 0) return {};
  // No location configured is an expected, stable state (long refresh is fine).
  // A thrown error is a transient lookup failure and must propagate so the
  // caller's lookup-failure retry applies (see element-context.ts), instead of
  // being masked here as the same "unavailable" result.
  const [locationSetting, channelTimeZone] = await Promise.all([context.channelLocation(), context.channelTimeZone()]);
  const location = validLocationFor(locationSetting, channelTimeZone);
  if (location === null) return Object.fromEntries(needed.map((name) => [name, { available: false }]));
  const today = localDateInTimeZone(context.now, location.timeZone);
  const days = Array.from({ length: 12 }, (_, index) => index - 1).map((offset) => calculateSunDay({
    ...location,
    localDate: shiftLocalDate(today, offset),
  }));
  const future = (pick: (day: ReturnType<typeof calculateSunDay>) => string | null): string[] => days
    .map(pick).filter((value): value is string => value !== null && Number.isFinite(Date.parse(value)) && Date.parse(value) > context.now);
  const futureAts = (events: readonly string[]): string[] => events
    .filter((value) => Number.isFinite(Date.parse(value)) && Date.parse(value) > context.now)
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  const goldenIntervals = calculateSunAltitudeIntervals(location, shiftLocalDate(today, -1), 12, "golden");
  const blueIntervals = calculateSunAltitudeIntervals(location, shiftLocalDate(today, -1), 12, "blue");
  const chooseInterval = (intervals: typeof goldenIntervals) =>
    intervals.find(({ startAt, endAt }) => Date.parse(startAt) <= context.now && context.now < Date.parse(endAt)) ??
    intervals.find(({ startAt }) => Date.parse(startAt) > context.now);
  const golden = chooseInterval(goldenIntervals);
  const blue = chooseInterval(blueIntervals);
  const nextMidnight = localMidnightInTimeZone(shiftLocalDate(today, 1), location.timeZone);
  const events = {
    "sun.set": future((day) => day.sunsetAt),
    "sun.set_in": future((day) => day.sunsetAt),
    "sun.rise": future((day) => day.sunriseAt),
    "sun.rise_in": future((day) => day.sunriseAt),
    "sun.dusk": future((day) => day.duskAt),
    "sun.dawn": future((day) => day.dawnAt),
    "sun.dawn_in": future((day) => day.dawnAt),
    "sun.noon": future((day) => day.solarNoonAt),
    "sun.day_length": [nextMidnight],
    "sun.golden_hour": golden === undefined ? [] : [golden.startAt <= new Date(context.now).toISOString() ? golden.endAt : golden.startAt],
    "sun.golden_hour_in": futureAts(goldenIntervals.flatMap(({ startAt, endAt }) => [startAt, endAt])),
    "sun.golden_hour_end": golden === undefined ? [] : [golden.endAt],
    "sun.blue_hour": blue === undefined ? [] : [blue.startAt <= new Date(context.now).toISOString() ? blue.endAt : blue.startAt],
    "sun.blue_hour_in": futureAts(blueIntervals.flatMap(({ startAt, endAt }) => [startAt, endAt])),
  };
  return Object.fromEntries(needed.map((name) => {
    const targets = events[name as keyof typeof events];
    return [name, {
      available: targets.length > 0,
      ...(targets[0] === undefined ? {} : { targetAt: targets[0] }),
      ...(name.endsWith("_in") && targets.length > 0 ? { targetAts: targets } : {}),
    }];
  }));
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
      day: { de: sunModuleCatalog.de.phases.day, en: sunModuleCatalog.en.phases.day },
      night: { de: sunModuleCatalog.de.phases.night, en: sunModuleCatalog.en.phases.night },
      golden_hour: { de: sunModuleCatalog.de.phases.golden_hour, en: sunModuleCatalog.en.phases.golden_hour },
      blue_hour: { de: sunModuleCatalog.de.phases.blue_hour, en: sunModuleCatalog.en.phases.blue_hour },
    },
  }],
  resolveTemplateConditions: resolveConditionValues,
  resolveTemplateConditionTransitions: resolveConditionTransitions,
  dynamicTemplateVariableNames: ["sun.set_in", "sun.rise_in", "sun.dawn_in", "sun.golden_hour_in", "sun.blue_hour_in"],
  resolveOverlayTemplateValues: resolveOverlayValues,
  routes: sunRoutes,
  panel: () => import("./panel/settings"),
};

export { calculateSunDay, resolveSunTemplateValues } from "./domain";
export type { SunDay } from "./domain";
export type { SunSettings } from "./contracts";
