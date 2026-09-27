import { z } from "zod";

import type { BotModule, ModuleTemplateConditionContext, ModuleTemplateValueContext } from "../contract";
import { validChannelTimeZone, type TemplateVariable } from "../contract";
import { DEFAULT_SUN_ERROR_TEXTS, readSunDays, readSunSettings } from "./adapters/d1";
import { resolveSunTemplateValues } from "./domain";
import { handleSunAlarm } from "./service";
import { sunRoutes } from "./routes";
import { sunModuleCatalog } from "./contracts/catalog";

const settingsSchema = z.object({});
const SUN_TEMPLATE_VARIABLES: readonly TemplateVariable[] = [
  { name: "sun.set", group: "time_random", maxLength: 8, sample: "18:42", source: "module" },
  { name: "sun.rise", group: "time_random", maxLength: 8, sample: "06:18", source: "module" },
  { name: "sun.dusk", group: "time_random", maxLength: 8, sample: "19:24", source: "module" },
  { name: "sun.set_in", group: "time_random", maxLength: 40, sample: "2 Std. 15 Min.", source: "module" },
  { name: "sun.rise_in", group: "time_random", maxLength: 40, sample: "8 Std. 30 Min.", source: "module" },
];

interface SunAlarmRow {
  next_refresh_at: string | null;
  has_location: number;
}

const currentSunValues = async (
  context: Pick<ModuleTemplateValueContext, "DB" | "channelId" | "channelTimeZone" | "channelLanguage" | "now">,
) => {
  const [settings, timeZone, language] = await Promise.all([
    readSunSettings(context.DB, context.channelId),
    context.channelTimeZone(),
    context.channelLanguage(),
  ]);
  if (!validChannelTimeZone(timeZone) || settings.location === null) {
    return resolveSunTemplateValues({
      days: [], now: context.now, timeZone: validChannelTimeZone(timeZone) ? timeZone : "Europe/Berlin",
      language, errorText: settings.errorTexts[language], expiresAt: null,
    });
  }
  let storedDays;
  try {
    storedDays = await readSunDays(context.DB, context.channelId, timeZone, context.now);
  } catch {
    return resolveSunTemplateValues({
      days: [], now: context.now, timeZone, language,
      errorText: settings.errorTexts[language], expiresAt: null,
    });
  }
  const days = storedDays.filter((day) => day.locationRevision === settings.revision);
  return resolveSunTemplateValues({
    days,
    now: context.now,
    timeZone,
    language,
    errorText: settings.errorTexts[language],
    expiresAt: days[0]?.expiresAt ?? null,
  });
};

const resolveConditionValues = async (
  ids: readonly string[],
  context: ModuleTemplateConditionContext,
): Promise<Readonly<Record<string, string>>> => {
  if (!ids.includes("sun.phase")) return {};
  try {
    const settings = await readSunSettings(context.DB, context.channelId);
    if (settings.location === null || !validChannelTimeZone(await context.channelTimeZone())) return {};
    const timeZone = await context.channelTimeZone();
    const days = (await readSunDays(context.DB, context.channelId, timeZone, context.now))
      .filter((day) => day.locationRevision === settings.revision);
    const phase = resolveSunTemplateValues({
      days,
      now: context.now,
      timeZone,
      language: "en",
      errorText: settings.errorTexts.en,
      expiresAt: days[0]?.expiresAt ?? null,
    }).dataConditions["sun.phase"];
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
  alarmHandler: {
    async nextDeadline(db, channelId, now) {
      const row = await db.prepare(
        `SELECT location.next_refresh_at,
                CASE WHEN location.name IS NULL THEN 0 ELSE 1 END AS has_location
           FROM channels AS channel
           LEFT JOIN sun_locations AS location ON location.channel_id = channel.channel_id
          WHERE channel.channel_id = ?`,
      ).bind(channelId).first<SunAlarmRow>();
      if (row === null || row.has_location !== 1) return null;
      if (row.next_refresh_at === null) return now;
      const dueAt = Date.parse(row.next_refresh_at);
      return Number.isFinite(dueAt) ? dueAt : now;
    },
    handle: handleSunAlarm,
  },
  routes: sunRoutes,
  channelSettings: () => import("./panel/location-settings"),
};

export { calculateSunDay, resolveSunTemplateValues } from "./domain";
export type { SunDay } from "./domain";
export type { SunLocation, SunSettings, SunStoredDay } from "./contracts";
