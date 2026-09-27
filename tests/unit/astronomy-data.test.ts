import { describe, expect, it } from "vitest";

import { panelTemplateOptions } from "../../src/dashboard/ui/template-variable-options";
import { calculateMoonDay, calculateMoonState, localDateInTimeZone as moonLocalDate, nextMoonPhaseChangeAt, resolveMoonTemplateValues } from "../../src/modules/moon/domain";
import { moonModule } from "../../src/modules/moon";
import { calculateSunAltitudeIntervals, calculateSunDay, localDateInTimeZone as sunLocalDate, resolveSunTemplateValues } from "../../src/modules/sun/domain";
import { sunModule } from "../../src/modules/sun";

const localMinute = (value: string | null, timeZone: string): string | null => value === null
  ? null
  : new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));

const withinMinutes = (actual: string | null, expected: string, tolerance: number): boolean => {
  if (actual === null) return false;
  const toMinute = (value: string): number => {
    const [hours, minutes] = value.split(":").map(Number);
    return (hours ?? 0) * 60 + (minutes ?? 0);
  };
  const difference = Math.abs(toMinute(actual) - toMinute(expected));
  return Math.min(difference, 1_440 - difference) <= tolerance;
};

describe("local solar values against published almanac values", () => {
  it("matches Regensburg's civil twilight, solar noon, and day length", () => {
    // Reference: timeanddate, Regensburg, 2026-09-27; solar equations follow NOAA's Meeus-based method.
    const location = { latitude: 49.0134, longitude: 12.1016, timeZone: "Europe/Berlin" };
    const day = calculateSunDay({ ...location, localDate: "2026-09-27" });
    const values = resolveSunTemplateValues({
      location,
      now: Date.parse("2026-09-27T00:00:00.000Z"),
      timeZone: "Europe/Berlin",
      language: "en",
      errorText: "Unavailable",
    });

    expect(withinMinutes(localMinute(day.dawnAt, location.timeZone), "06:34", 2)).toBe(true);
    expect(withinMinutes(localMinute(day.sunriseAt, location.timeZone), "07:05", 2)).toBe(true);
    expect(withinMinutes(localMinute(day.sunsetAt, location.timeZone), "18:59", 2)).toBe(true);
    expect(withinMinutes(localMinute(day.duskAt, location.timeZone), "19:30", 2)).toBe(true);
    expect(withinMinutes(localMinute(day.solarNoonAt, location.timeZone), "13:02", 2)).toBe(true);
    expect(day.dayLengthMinutes).toBe(714);
    expect(values.values["sun.day_length"]).toBe("11:54");
  });

  it("keeps Auckland's UTC+13 daylight-saving transition on the requested local date", () => {
    // Reference: timeanddate, Auckland, 2026-09-27. DST starts at 02:00 and the displayed events use UTC+13.
    const location = { latitude: -36.8485, longitude: 174.7633, timeZone: "Pacific/Auckland" };
    const day = calculateSunDay({ ...location, localDate: "2026-09-27" });
    expect(sunLocalDate(Date.parse(day.sunriseAt ?? ""), location.timeZone)).toBe("2026-09-27");
    expect(withinMinutes(localMinute(day.sunriseAt, location.timeZone), "07:03", 2)).toBe(true);
    expect(withinMinutes(localMinute(day.sunsetAt, location.timeZone), "19:21", 2)).toBe(true);
    expect(withinMinutes(localMinute(day.solarNoonAt, location.timeZone), "13:12", 2)).toBe(true);

    const blue = calculateSunAltitudeIntervals(location, "2026-09-27", 1, "blue")[0];
    const golden = calculateSunAltitudeIntervals(location, "2026-09-27", 1, "golden")[0];
    // The published civil-dawn value is 06:37; −4° and +6° crossings follow NOAA's published solar-position equations.
    expect(withinMinutes(localMinute(blue?.startAt ?? null, location.timeZone), "06:37", 2)).toBe(true);
    expect(withinMinutes(localMinute(golden?.startAt ?? null, location.timeZone), "06:48", 2)).toBe(true);
    expect(withinMinutes(localMinute(golden?.endAt ?? null, location.timeZone), "07:38", 2)).toBe(true);
    expect(valuesForSun("2026-09-26T17:42:00.000Z", location).dataConditions["sun.phase"]).toBe("blue_hour");
  });

  it("anchors Kiritimati UTC+14 values to its date-line-local date", () => {
    // Reference: timeanddate, Kiritimati, 2026-01-13; UTC+14 local date is one day ahead of UTC.
    const location = { latitude: 1.8721, longitude: -157.4278, timeZone: "Pacific/Kiritimati" };
    const day = calculateSunDay({ ...location, localDate: "2026-01-13" });
    expect(sunLocalDate(Date.parse(day.sunriseAt ?? ""), location.timeZone)).toBe("2026-01-13");
    expect(withinMinutes(localMinute(day.sunriseAt, location.timeZone), "06:37", 2)).toBe(true);
    expect(withinMinutes(localMinute(day.sunsetAt, location.timeZone), "18:38", 2)).toBe(true);
    expect(withinMinutes(localMinute(day.solarNoonAt, location.timeZone), "12:37", 2)).toBe(true);
  });

  it("represents Tromsø polar day and polar night without inventing solar crossings", () => {
    const location = { latitude: 69.6492, longitude: 18.9553, timeZone: "Europe/Oslo" };
    const summer = calculateSunDay({ ...location, localDate: "2026-06-21" });
    const winter = calculateSunDay({ ...location, localDate: "2026-12-21" });
    expect(summer.polarState).toBe("day");
    expect(winter.polarState).toBe("night");
    for (const day of [summer]) {
      const values = resolveSunTemplateValues({
        location,
        now: Date.parse(`${day.localDate}T12:00:00.000Z`),
        timeZone: location.timeZone,
        language: "en",
        errorText: "Configured unavailable text",
      });
      expect(values.values["sun.dawn"]).toBe("Configured unavailable text");
      expect(values.values["sun.golden_hour"]).not.toBe("Configured unavailable text");
      expect(values.values["sun.blue_hour"]).toBe("Configured unavailable text");
    }
    expect(winter.dawnAt).not.toBeNull();
  });
});

describe("Meeus low-precision lunar values against published almanac values", () => {
  it("matches Regensburg moonrise and moonset within five minutes", () => {
    // Reference: timeanddate, Regensburg, 2026-09-27; USNO documents rise/set data and event definitions.
    const location = { latitude: 49.0134, longitude: 12.1016, timeZone: "Europe/Berlin" };
    const day = calculateMoonDay(location, "2026-09-27");
    expect(withinMinutes(localMinute(day.riseAt, location.timeZone), "18:55", 5)).toBe(true);
    expect(withinMinutes(localMinute(day.setAt, location.timeZone), "07:56", 5)).toBe(true);
    expect(day.state).toBe("normal");
  });

  it("matches Auckland UTC+13 moon events and waxing-state values", () => {
    // Reference: timeanddate, Auckland, 2026-01-15; Auckland is on daylight time (UTC+13).
    const location = { latitude: -36.8485, longitude: 174.7633, timeZone: "Pacific/Auckland" };
    const day = calculateMoonDay(location, "2026-01-15");
    expect(withinMinutes(localMinute(day.riseAt, location.timeZone), "02:34", 5)).toBe(true);
    expect(withinMinutes(localMinute(day.setAt, location.timeZone), "18:04", 5)).toBe(true);
    const phase = calculateMoonState(Date.parse("2026-01-14T21:16:00.000Z"));
    expect(phase.phase).toBe("waning_crescent");
    expect(Math.abs(phase.illumination - 14)).toBeLessThanOrEqual(2);
  });

  it("matches Kiritimati moon events across the international date line", () => {
    // Reference: timeanddate, Kiritimati, 2026-01-13; coordinates use UTC+14.
    const location = { latitude: 1.8721, longitude: -157.4278, timeZone: "Pacific/Kiritimati" };
    const day = calculateMoonDay(location, "2026-01-13");
    expect(moonLocalDate(Date.parse(day.riseAt ?? ""), location.timeZone)).toBe("2026-01-13");
    expect(withinMinutes(localMinute(day.riseAt, location.timeZone), "01:37", 5)).toBe(true);
    expect(withinMinutes(localMinute(day.setAt, location.timeZone), "13:53", 5)).toBe(true);
  });

  it("marks Tromsø days without crossings as continuously below or above the horizon", () => {
    const location = { latitude: 69.6492, longitude: 18.9553, timeZone: "Europe/Oslo" };
    expect(calculateMoonDay(location, "2026-06-27").state).toBe("always_down");
    expect(calculateMoonDay(location, "2026-06-15").state).toBe("always_up");
  });

  it("declares bilingual autocomplete descriptions and overlay countdown targets", async () => {
    const moonVariables = await moonModule.templateVariables?.({} as D1Database, "moon-channel") ?? [];
    const sunVariables = await sunModule.templateVariables?.({} as D1Database, "sun-channel") ?? [];
    const moonEnglish = panelTemplateOptions("event", moonVariables, [], "en");
    const moonGerman = panelTemplateOptions("event", moonVariables, [], "de");
    const sunEnglish = panelTemplateOptions("event", sunVariables, [], "en");
    const sunGerman = panelTemplateOptions("event", sunVariables, [], "de");
    expect(moonEnglish.find(({ name }) => name === "moon.phase")?.description).toBe("Current lunar phase.");
    expect(moonGerman.find(({ name }) => name === "moon.phase")?.description).toBe("Aktuelle Mondphase.");
    expect(sunEnglish.find(({ name }) => name === "sun.dawn")?.description).toContain("civil dawn");
    expect(sunGerman.find(({ name }) => name === "sun.dawn")?.description).toContain("Morgendämmerung");

    const location = { latitude: 49.0134, longitude: 12.1016, timeZone: "Europe/Berlin" };
    const now = Date.parse("2026-09-27T00:00:00.000Z");
    const moonValues = resolveMoonTemplateValues({
      location,
      now,
      timeZone: location.timeZone,
      language: "en",
      errorText: "Unavailable",
      names: ["moon.rise_in", "moon.set_in"],
    });
    expect(moonValues.values["moon.phase"]).toBe("Full moon");
    expect(moonValues.values["moon.illumination"]).toBe("100");
    const overlayValues = await moonModule.resolveOverlayTemplateValues?.(["moon.rise_in", "moon.set_in"], {
      DB: {} as D1Database,
      channelId: "moon-channel",
      now,
      channelTimeZone: () => Promise.resolve("Europe/Berlin"),
      channelLocation: () => Promise.resolve({ name: "Regensburg", ...location }),
      language: "en",
    });
    expect(overlayValues?.["moon.rise_in"]?.targetAts?.length).toBeGreaterThan(1);
    expect(overlayValues?.["moon.set_in"]?.targetAt).toBeDefined();

    const valueRefreshes = await moonModule.resolveOverlayTemplateValues?.(["moon.phase", "moon.illumination"], {
      DB: {} as D1Database,
      channelId: "moon-channel",
      now,
      channelTimeZone: () => Promise.resolve("Europe/Berlin"),
      channelLocation: () => Promise.resolve(null),
      language: "en",
    });
    const nextHour = new Date((Math.floor(now / (60 * 60 * 1_000)) + 1) * 60 * 60 * 1_000).toISOString();
    const nextPhaseChange = nextMoonPhaseChangeAt(now);
    expect(valueRefreshes).toEqual({
      "moon.phase": { available: true, nextChangeAt: nextPhaseChange },
      "moon.illumination": { available: true, nextChangeAt: nextHour },
    });
    expect(calculateMoonState(Date.parse(nextPhaseChange) - 1_000).phase).toBe(calculateMoonState(now).phase);
    expect(calculateMoonState(Date.parse(nextPhaseChange) + 1_000).phase).not.toBe(calculateMoonState(now).phase);
  });
});

const valuesForSun = (
  now: string,
  location: { latitude: number; longitude: number; timeZone: string },
) => resolveSunTemplateValues({
  location,
  now: Date.parse(now),
  timeZone: location.timeZone,
  language: "en",
  errorText: "Unavailable",
});
