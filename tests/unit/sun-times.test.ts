import { describe, expect, it } from "vitest";

import {
  calculateSunAltitudeIntervals,
  calculateSunDay,
  localDateInTimeZone,
  resolveSunTemplateValues,
  shiftLocalDate,
} from "../../src/modules/sun/domain";
import { SUN_ERROR_TEXT_MAX_LENGTH } from "../../src/modules/sun/contracts";
import { sunModule } from "../../src/modules/sun";

const localMinute = (value: string | null, timeZone: string): string | null => value === null
  ? null
  : new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));

const formatChannelTime = (value: string, timeZone: string, language: "de" | "en" = "en"): string =>
  new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-US", {
    timeZone,
    hour: language === "de" ? "2-digit" : "numeric",
    minute: "2-digit",
  }).format(new Date(value));

const withinOneMinute = (actual: string | null, expected: string): boolean => {
  if (actual === null) return false;
  const minuteOfDay = (value: string): number => {
    const [hours, minutes] = value.split(":").map(Number);
    return (hours ?? 0) * 60 + (minutes ?? 0);
  };
  return Math.abs(minuteOfDay(actual) - minuteOfDay(expected)) <= 1;
};

const errorText = "Sun data unavailable.";

const resolveAt = (
  now: string,
  location: { latitude: number; longitude: number; timeZone: string },
  timeZone: string,
  language: "de" | "en" = "en",
) => resolveSunTemplateValues({
  location,
  now: Date.parse(now),
  timeZone,
  language,
  errorText,
});

describe("NOAA sun calculations", () => {
  it("calculates Berlin summer solstice events in location-local time", () => {
    const day = calculateSunDay({ latitude: 52.52, longitude: 13.405, localDate: "2026-06-21", timeZone: "Europe/Berlin" });

    expect(localMinute(day.sunriseAt, "Europe/Berlin")).toBe("04:43");
    expect(localMinute(day.sunsetAt, "Europe/Berlin")).toBe("21:33");
    expect(withinOneMinute(localMinute(day.duskAt, "Europe/Berlin"), "22:23")).toBe(true);
    expect(day.polarState).toBe("normal");
  });

  it("anchors events to the requested local date across the date line", () => {
    const locations = [
      { label: "UTC+13 Auckland", latitude: -36.8485, longitude: 174.7633, timeZone: "Pacific/Auckland" },
      { label: "UTC+14 Kiritimati", latitude: 1.8721, longitude: -157.4278, timeZone: "Pacific/Kiritimati" },
      { label: "date-line west Pago Pago", latitude: -14.2756, longitude: -170.702, timeZone: "Pacific/Pago_Pago" },
      { label: "UTC-10 Honolulu", latitude: 21.3069, longitude: -157.8583, timeZone: "Pacific/Honolulu" },
    ];

    for (const location of locations) {
      const day = calculateSunDay({ ...location, localDate: "2026-01-01" });
      expect(day.sunriseAt === null ? null : localDateInTimeZone(Date.parse(day.sunriseAt), location.timeZone), location.label).toBe("2026-01-01");
      expect(day.sunsetAt === null ? null : localDateInTimeZone(Date.parse(day.sunsetAt), location.timeZone), location.label).toBe("2026-01-01");
    }
  });

  it("uses the post-transition offset on the Berlin daylight-saving switch", () => {
    const day = calculateSunDay({ latitude: 52.52, longitude: 13.405, localDate: "2026-03-29", timeZone: "Europe/Berlin" });

    expect(localMinute(day.sunriseAt, "Europe/Berlin")).toBe("06:48");
    expect(localMinute(day.sunsetAt, "Europe/Berlin")).toBe("19:35");
  });

  it("represents polar day and polar night without inventing sunrise or sunset", () => {
    const polarDay = calculateSunDay({ latitude: 78.22, longitude: 15.65, localDate: "2026-06-21", timeZone: "Arctic/Longyearbyen" });
    const polarNight = calculateSunDay({ latitude: 78.22, longitude: 15.65, localDate: "2026-12-21", timeZone: "Arctic/Longyearbyen" });

    expect(polarDay).toMatchObject({ sunriseAt: null, sunsetAt: null, duskAt: null, polarState: "day" });
    expect(polarNight).toMatchObject({ sunriseAt: null, sunsetAt: null, duskAt: null, polarState: "night" });
  });

  it("calculates evening civil dusk during Tromsø polar night", () => {
    const day = calculateSunDay({ latitude: 69.6492, longitude: 18.9553, localDate: "2026-12-21", timeZone: "Europe/Oslo" });

    expect(day.polarState).toBe("night");
    expect(day.sunriseAt).toBeNull();
    expect(day.sunsetAt).toBeNull();
    expect(day.duskAt).not.toBeNull();
    expect(localMinute(day.duskAt, "Europe/Oslo")).not.toBeNull();
  });
});

describe("on-demand sun template values", () => {
  it("uses location-local solar dates for Honolulu while formatting in Berlin", () => {
    const location = { latitude: 21.3069, longitude: -157.8583, timeZone: "Pacific/Honolulu" };
    const instants = [
      { now: "2026-06-21T06:00:00.000Z", phase: "night", localDate: "2026-06-20" },
      { now: "2026-06-21T18:00:00.000Z", phase: "day", localDate: "2026-06-21" },
      { now: "2026-06-22T10:00:00.000Z", phase: "night", localDate: "2026-06-22" },
    ] as const;

    for (const testCase of instants) {
      const values = resolveAt(testCase.now, location, "Europe/Berlin");
      const days = [-1, 0, 1].map((offset) => calculateSunDay({
        ...location,
        localDate: shiftLocalDate(testCase.localDate, offset),
      }));
      const nextRise = days.flatMap((day) => day.sunriseAt === null ? [] : [day.sunriseAt])
        .map(Date.parse).filter((instant) => instant > Date.parse(testCase.now)).sort((a, b) => a - b)[0];
      const nextSet = days.flatMap((day) => day.sunsetAt === null ? [] : [day.sunsetAt])
        .map(Date.parse).filter((instant) => instant > Date.parse(testCase.now)).sort((a, b) => a - b)[0];

      expect(values.dataConditions["sun.phase"], testCase.now).toBe(testCase.phase);
      expect(values.values["sun.rise"], testCase.now).toBe(formatChannelTime(new Date(nextRise ?? 0).toISOString(), "Europe/Berlin"));
      expect(values.values["sun.set"], testCase.now).toBe(formatChannelTime(new Date(nextSet ?? 0).toISOString(), "Europe/Berlin"));
      expect(Date.parse(new Date(nextRise ?? 0).toISOString())).toBeGreaterThan(Date.parse(testCase.now));
      expect(Date.parse(new Date(nextSet ?? 0).toISOString())).toBeGreaterThan(Date.parse(testCase.now));
    }

    const berlinEvening = resolveAt("2026-06-21T18:00:00.000Z", location, "Europe/Berlin");
    expect(berlinEvening.dataConditions["sun.phase"]).toBe("day");
    expect(berlinEvening.values["sun.rise"]).not.toBe(errorText);
  });

  it("resolves Auckland daylight when Berlin is on the previous evening", () => {
    const values = resolveAt("2026-06-21T20:00:00.000Z", {
      latitude: -36.8485,
      longitude: 174.7633,
      timeZone: "Pacific/Auckland",
    }, "Europe/Berlin");

    expect(localDateInTimeZone(Date.parse("2026-06-21T20:00:00.000Z"), "Pacific/Auckland")).toBe("2026-06-22");
    expect(values.dataConditions["sun.phase"]).toBe("golden_hour");
    expect(values.values["sun.rise"]).not.toBe(errorText);
    expect(values.values["sun.set"]).not.toBe(errorText);
  });

  it("resolves the golden-hour interval across Tromsø local midnight", () => {
    const location = { latitude: 69.6492, longitude: 18.9553, timeZone: "Europe/Oslo" };
    const now = Date.parse("2026-05-15T21:30:00.000Z");
    const values = resolveAt("2026-05-15T21:30:00.000Z", location, location.timeZone);
    const currentInterval = calculateSunAltitudeIntervals(location, "2026-05-14", 3, "golden")
      .find(({ startAt, endAt }) => Date.parse(startAt) <= now && now < Date.parse(endAt));

    expect(values.dataConditions["sun.phase"]).toBe("golden_hour");
    expect(currentInterval).toBeDefined();
    expect(values.values["sun.golden_hour"]).toBe(formatChannelTime(currentInterval?.startAt ?? "", location.timeZone));
    expect(values.values["sun.golden_hour_in"]).toBe("0 min");
    expect(values.values["sun.golden_hour_end"]).toBe(formatChannelTime(currentInterval?.endAt ?? "", location.timeZone));
  });

  it("keeps polar phase and dusk behavior when calculated on demand", () => {
    const polarDay = resolveAt("2026-06-21T12:00:00.000Z", {
      latitude: 78.22,
      longitude: 15.65,
      timeZone: "Arctic/Longyearbyen",
    }, "Europe/Berlin");
    expect(polarDay.dataConditions["sun.phase"]).toBe("day");
    expect(polarDay.values["sun.rise"]).toBe(errorText);
    expect(polarDay.values["sun.set"]).toBe(errorText);

    const polarNight = resolveAt("2026-12-21T12:00:00.000Z", {
      latitude: 69.6492,
      longitude: 18.9553,
      timeZone: "Europe/Oslo",
    }, "Europe/Berlin");
    expect(polarNight.dataConditions["sun.phase"]).toBe("blue_hour");
    expect(polarNight.values["sun.rise"]).toBe(errorText);
    expect(polarNight.values["sun.set"]).toBe(errorText);
    expect(polarNight.values["sun.dusk"]).not.toBe(errorText);
  });

  it("formats an on-demand sunrise across a location DST transition in the channel zone", () => {
    const location = { latitude: 52.52, longitude: 13.405, timeZone: "Europe/Berlin" };
    const now = "2026-03-29T02:00:00.000Z";
    const values = resolveAt(now, location, "America/New_York", "de");
    const date = localDateInTimeZone(Date.parse(now), location.timeZone);
    const day = calculateSunDay({ ...location, localDate: date });

    expect(values.dataConditions["sun.phase"]).toBe("night");
    expect(values.values["sun.rise"]).toBe(formatChannelTime(day.sunriseAt ?? "", "America/New_York", "de"));
  });

  it("selects strictly future sunrise and sunset at the rounded event boundaries", () => {
    const location = { latitude: 52.52, longitude: 13.405, timeZone: "Europe/Berlin" };
    const today = calculateSunDay({ ...location, localDate: "2026-06-21" });
    const tomorrow = calculateSunDay({ ...location, localDate: "2026-06-22" });

    const atSunrise = resolveAt(today.sunriseAt ?? "", location, "Europe/Berlin");
    const atSunset = resolveAt(today.sunsetAt ?? "", location, "Europe/Berlin");

    expect(atSunrise.values["sun.rise"]).toBe(formatChannelTime(tomorrow.sunriseAt ?? "", "Europe/Berlin"));
    expect(atSunrise.values["sun.rise_in"]).not.toBe("0 min");
    expect(atSunrise.dataConditions["sun.phase"]).toBe("golden_hour");
    expect(atSunset.values["sun.set"]).toBe(formatChannelTime(tomorrow.sunsetAt ?? "", "Europe/Berlin"));
    expect(atSunset.values["sun.set_in"]).not.toBe("0 min");
    expect(atSunset.dataConditions["sun.phase"]).toBe("golden_hour");
  });

  it("exposes the next fixed sun event as an overlay refresh target", async () => {
    const location = { latitude: 52.52, longitude: 13.405, timeZone: "Europe/Berlin" };
    const now = Date.parse("2026-06-21T00:00:00.000Z");
    const day = calculateSunDay({ ...location, localDate: "2026-06-21" });
    const database = {
      prepare: () => ({
        bind: () => ({ first: () => Promise.resolve({
          error_text_de: "Nicht verfügbar.",
          error_text_en: errorText,
          revision: 1,
        }) }),
      }),
    } as unknown as D1Database;

    const values = await sunModule.resolveOverlayTemplateValues?.(["sun.rise", "sun.set", "sun.dusk"], {
      DB: database,
      channelId: "sun-channel",
      now,
      channelTimeZone: () => Promise.resolve("Europe/Berlin"),
      channelLocation: () => Promise.resolve({ name: "Berlin", ...location }),
      language: "en",
    });

    expect(values).toEqual({
      "sun.rise": { available: true, targetAt: day.sunriseAt, nextChangeAt: day.sunriseAt },
      "sun.set": { available: true, targetAt: day.sunsetAt, nextChangeAt: day.sunsetAt },
      "sun.dusk": { available: true, targetAt: day.duskAt, nextChangeAt: day.duskAt },
    });
  });

  it("keeps golden- and blue-hour countdowns on their interval start and refreshes at the end", async () => {
    const location = { latitude: 52.52, longitude: 13.405, timeZone: "Europe/Berlin" };
    const now = Date.parse("2026-06-21T00:00:00.000Z");
    const values = await sunModule.resolveOverlayTemplateValues?.(["sun.golden_hour_in", "sun.blue_hour_in"], {
      DB: {} as D1Database,
      channelId: "sun-channel",
      now,
      channelTimeZone: () => Promise.resolve("Europe/Berlin"),
      channelLocation: () => Promise.resolve({ name: "Berlin", ...location }),
      language: "en",
    });
    const goldenIntervals = calculateSunAltitudeIntervals(location, "2026-06-20", 2, "golden");
    const blueIntervals = calculateSunAltitudeIntervals(location, "2026-06-20", 2, "blue");
    const nextGolden = goldenIntervals.find(({ startAt }) => Date.parse(startAt) > now);
    const nextBlue = blueIntervals.find(({ startAt }) => Date.parse(startAt) > now);

    expect(values?.["sun.golden_hour_in"]?.targetAts).toEqual([nextGolden?.startAt]);
    expect(values?.["sun.golden_hour_in"]?.targetAts).not.toContain(nextGolden?.endAt);
    expect(values?.["sun.golden_hour_in"]?.nextChangeAt).toBe(nextGolden?.endAt);
    expect(values?.["sun.blue_hour_in"]?.targetAts).toEqual([nextBlue?.startAt]);
    expect(values?.["sun.blue_hour_in"]?.targetAts).not.toContain(nextBlue?.endAt);
    expect(values?.["sun.blue_hour_in"]?.nextChangeAt).toBe(nextBlue?.endAt);
  });

  it("resolves Berlin golden-hour countdown as zero while the interval is ongoing", async () => {
    const location = { latitude: 52.52, longitude: 13.405, timeZone: "Europe/Berlin" };
    const interval = calculateSunAltitudeIntervals(location, "2026-06-21", 1, "golden")[0];
    expect(interval).toBeDefined();
    const now = Date.parse(interval?.startAt ?? "") + 5 * 60_000;
    const resolved = resolveAt(new Date(now).toISOString(), location, location.timeZone);
    const values = await sunModule.resolveOverlayTemplateValues?.(["sun.golden_hour_in"], {
      DB: {} as D1Database,
      channelId: "sun-channel",
      now,
      channelTimeZone: () => Promise.resolve(location.timeZone),
      channelLocation: () => Promise.resolve({ name: "Berlin", ...location }),
      language: "en",
    });

    expect(resolved.dataConditions["sun.phase"]).toBe("golden_hour");
    expect(resolved.values["sun.golden_hour_in"]).toBe("0 min");
    expect(values?.["sun.golden_hour_in"]).toMatchObject({
      available: true,
      targetAts: [interval?.startAt],
      nextChangeAt: interval?.endAt,
    });
    expect(values?.["sun.golden_hour_in"]?.targetAts).not.toContain(interval?.endAt);
  });

  it("propagates a transient location lookup failure instead of masking it as unavailable", async () => {
    const now = Date.parse("2026-06-21T00:00:00.000Z");
    const database = {
      prepare: () => ({
        bind: () => ({ first: () => Promise.resolve({
          error_text_de: "Nicht verfügbar.",
          error_text_en: errorText,
          revision: 1,
        }) }),
      }),
    } as unknown as D1Database;

    await expect(sunModule.resolveOverlayTemplateValues?.(["sun.set_in", "sun.rise_in"], {
      DB: database,
      channelId: "sun-channel",
      now,
      channelTimeZone: () => Promise.resolve("Europe/Berlin"),
      channelLocation: () => Promise.reject(new Error("location lookup unavailable")),
      language: "en",
    })).rejects.toThrow("location lookup unavailable");
  });

  it("uses configured fallback text when there is no location", async () => {
    const variables = await sunModule.templateVariables?.({} as D1Database, "sun-channel") ?? [];
    const fallback = "x".repeat(SUN_ERROR_TEXT_MAX_LENGTH);
    const values = resolveSunTemplateValues({
      location: null,
      now: Date.parse("2026-06-21T12:00:00.000Z"),
      timeZone: "Europe/Berlin",
      language: "en",
      errorText: fallback,
    });

    expect(variables).toHaveLength(14);
    expect(variables.every((variable) => variable.maxLength >= fallback.length)).toBe(true);
    expect(Object.values(values.values).every((value) => value.length <= SUN_ERROR_TEXT_MAX_LENGTH)).toBe(true);
    expect(values.dataConditions["sun.phase"]).toBeUndefined();
  });
});
