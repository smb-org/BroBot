import { z } from "zod";

import type { BotModule, ModuleTemplateConditionContext, ModuleTemplateValueContext } from "../contract";
import { validChannelTimeZone, type TemplateVariable } from "../contract";
import { DEFAULT_SUN_ERROR_TEXTS, readSunSettings } from "./adapters/d1";
import { SUN_ERROR_TEXT_MAX_LENGTH } from "./contracts";
import { resolveSunTemplateValues } from "./domain";
import { sunRoutes } from "./routes";
import { sunModuleCatalog } from "./contracts/catalog";

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
    values: {
      day: { de: "Tag", en: "Day" },
      night: { de: "Nacht", en: "Night" },
    },
  }],
  resolveTemplateConditions: resolveConditionValues,
  routes: sunRoutes,
  channelSettings: () => import("./panel/location-settings"),
};

export { calculateSunDay, resolveSunTemplateValues } from "./domain";
export type { SunDay } from "./domain";
export type { SunLocation, SunSettings } from "./contracts";
