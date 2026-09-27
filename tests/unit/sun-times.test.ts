import { describe, expect, it } from "vitest";

import { calculateSunDay, nextSunRefreshAt, resolveSunTemplateValues } from "../../src/modules/sun/domain";

const localMinute = (value: string | null, timeZone: string): string | null => value === null
  ? null
  : new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value));

const withinOneMinute = (actual: string | null, expected: string): boolean => {
  if (actual === null) return false;
  const minuteOfDay = (value: string): number => {
    const [hours, minutes] = value.split(":").map(Number);
    return (hours ?? 0) * 60 + (minutes ?? 0);
  };
  return Math.abs(minuteOfDay(actual) - minuteOfDay(expected)) <= 1;
};

describe("NOAA sun calculations", () => {
  it("calculates Berlin summer solstice events in local time", () => {
    const day = calculateSunDay({ latitude: 52.52, longitude: 13.405, localDate: "2026-06-21", timeZone: "Europe/Berlin" });

    expect(localMinute(day.sunriseAt, "Europe/Berlin")).toBe("04:43");
    expect(localMinute(day.sunsetAt, "Europe/Berlin")).toBe("21:33");
    expect(withinOneMinute(localMinute(day.duskAt, "Europe/Berlin"), "22:23")).toBe(true);
    expect(day.polarState).toBe("normal");
  });

  it("calculates New York summer solstice events in the channel time zone", () => {
    const day = calculateSunDay({ latitude: 40.7128, longitude: -74.006, localDate: "2026-06-21", timeZone: "America/New_York" });

    expect(withinOneMinute(localMinute(day.sunriseAt, "America/New_York"), "05:24")).toBe(true);
    expect(withinOneMinute(localMinute(day.sunsetAt, "America/New_York"), "20:30")).toBe(true);
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
});

describe("channel-local refresh schedule", () => {
  it("keeps the 00:15 refresh on the channel calendar across the spring DST switch", () => {
    expect(nextSunRefreshAt(Date.parse("2026-03-28T23:00:00.000Z"), "Europe/Berlin"))
      .toBe(Date.parse("2026-03-28T23:15:00.000Z"));
    expect(nextSunRefreshAt(Date.parse("2026-03-29T00:16:00.000Z"), "Europe/Berlin"))
      .toBe(Date.parse("2026-03-29T22:15:00.000Z"));
  });
});

describe("sun template values", () => {
  it("uses the previous record's tomorrow as today after midnight", () => {
    const yesterday = calculateSunDay({ latitude: 52.52, longitude: 13.405, localDate: "2026-06-20", timeZone: "Europe/Berlin" });
    const today = calculateSunDay({ latitude: 52.52, longitude: 13.405, localDate: "2026-06-21", timeZone: "Europe/Berlin" });
    const expiresAt = "2026-06-22T22:00:00.000Z";

    const values = resolveSunTemplateValues({
      days: [yesterday, today],
      now: Date.parse("2026-06-21T01:00:00.000Z"),
      timeZone: "Europe/Berlin",
      language: "en",
      errorText: "Sun data unavailable.",
      expiresAt,
    });

    expect(values.dataConditions["sun.phase"]).toBe("night");
    expect(values.values["sun.rise"]).toBe("4:43 AM");
    expect(values.values["sun.set"]).toBe("9:33 PM");
    expect(values.values["sun.rise_in"]).toContain("hr");
  });

  it("switches between day and night at sunrise and formats values in the channel language", () => {
    const today = calculateSunDay({ latitude: 52.52, longitude: 13.405, localDate: "2026-06-21", timeZone: "Europe/Berlin" });
    const tomorrow = calculateSunDay({ latitude: 52.52, longitude: 13.405, localDate: "2026-06-22", timeZone: "Europe/Berlin" });
    const base = {
      days: [today, tomorrow],
      timeZone: "Europe/Berlin",
      fetchedAt: "2026-06-21T00:15:00.000Z",
      expiresAt: "2026-06-23T00:00:00.000Z",
      errorText: "Sonnendaten nicht verfügbar.",
      language: "de" as const,
    };

    const night = resolveSunTemplateValues({ ...base, now: Date.parse("2026-06-21T02:42:00.000Z") });
    const day = resolveSunTemplateValues({ ...base, now: Date.parse("2026-06-21T02:45:00.000Z") });

    expect(night.dataConditions["sun.phase"]).toBe("night");
    expect(day.dataConditions["sun.phase"]).toBe("day");
    expect(night.values["sun.rise_in"]).toContain("Min.");
    expect(day.values["sun.set_in"]).toContain("Std.");
  });

  it("returns a channel override when no valid sun record covers today", () => {
    const values = resolveSunTemplateValues({
      days: [],
      now: Date.parse("2026-06-21T12:00:00.000Z"),
      timeZone: "Europe/Berlin",
      language: "en",
      errorText: "My channel's sun data is offline.",
      expiresAt: null,
    });

    expect(values.values).toEqual({
      "sun.set": "My channel's sun data is offline.",
      "sun.rise": "My channel's sun data is offline.",
      "sun.dusk": "My channel's sun data is offline.",
      "sun.set_in": "My channel's sun data is offline.",
      "sun.rise_in": "My channel's sun data is offline.",
    });
    expect(values.dataConditions["sun.phase"]).toBeUndefined();
  });
});
