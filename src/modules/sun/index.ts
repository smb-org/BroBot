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
import { resolveSunTemplateValues } from "./domain";
import { sunRoutes } from "./routes";
import { sunModuleCatalog, SUN_TEMPLATE_VARIABLE_NAMES } from "./contracts/catalog";
import { calculateSunDay, localDateInTimeZone, shiftLocalDate } from "./domain";

const settingsSchema = z.object({});
const SUN_TEMPLATE_VARIABLES: readonly TemplateVariable[] = SUN_TEMPLATE_VARIABLE_NAMES.map((name) => ({
  name,
  group: "time_random",
  maxLength: SUN_ERROR_TEXT_MAX_LENGTH,
  sample: sunModuleCatalog.de.templateVariables[name].sample,
  source: "module",
  picker: {
    de: sunModuleCatalog.de.templateVariables[name],
    en: sunModuleCatalog.en.templateVariables[name],
  },
}));

const sunPanelIcon = { paths: ["M12 3v2", "M12 19v2", "M3 12h2", "M19 12h2", "M5.6 5.6l1.4 1.4", "M17 17l1.4 1.4", "M18.4 5.6 17 7", "M7 17l-1.4 1.4", "M17 12a5 5 0 1 1-10 0 5 5 0 0 1 10 0"] } as const;

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
  context: {
    DB: D1Database;
    channelId: string;
    now: number;
    channelTimeZone: () => Promise<string>;
    channelLocation: () => Promise<ModuleChannelLocation | null>;
  },
) => {
  const requested = new Set(names);
  const needed = ["sun.set", "sun.rise", "sun.dusk", "sun.set_in", "sun.rise_in"].filter((name) => requested.has(name));
  if (needed.length === 0) return {};
  // No location configured is an expected, stable state (long refresh is fine).
  // A thrown error is a transient lookup failure and must propagate so the
  // caller's lookup-failure retry applies (see element-context.ts), instead of
  // being masked here as the same "unavailable" result.
  const [locationSetting, channelTimeZone] = await Promise.all([context.channelLocation(), context.channelTimeZone()]);
  const location = validLocationFor(locationSetting, channelTimeZone);
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
    return [name, {
      available: targets.length > 0,
      ...(targets[0] === undefined ? {} : { targetAt: targets[0] }),
      ...(name.endsWith("_in") && targets.length > 0 ? { targetAts: targets } : {}),
    }];
  }));
};

export const sunModule: BotModule<typeof settingsSchema> = {
  id: "sun",
  panelIcon: sunPanelIcon,
  templateVariableGroup: {
    label: { de: sunModuleCatalog.de.variableGroup, en: sunModuleCatalog.en.variableGroup },
    icon: sunPanelIcon,
    order: 10,
  },
  templateVariableCatalog: SUN_TEMPLATE_VARIABLES,
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
  panel: () => import("./panel/settings"),
};

export { calculateSunDay, resolveSunTemplateValues } from "./domain";
export type { SunDay } from "./domain";
export type { SunSettings } from "./contracts";
