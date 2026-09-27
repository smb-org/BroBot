import { describe, expect, it, vi } from "vitest";

import { localMidnightInTimeZone } from "../../src/modules/contract";
import { nextTextBlockLocalMidnight, textBlockConditionSwitchTimes, textBlockConditionsMatch, textBlockTimeConditionsMatch } from "../../src/modules/text_library/domain";
import type { TextBlockConditions } from "../../src/modules/text_library/contracts";

/**
 * Confirms `textBlockConditionSwitchTimes`'s emitted switches are both necessary and
 * sufficient: scanning minute by minute across the range must flip `condition`'s live
 * evaluation at exactly those instants, no more and no fewer.
 */
const assertSwitchesFlipExactly = (
  condition: Pick<TextBlockConditions, "weekdays" | "timeWindow">,
  timeZone: string,
  from: number,
  until: number,
): readonly string[] => {
  const switches = textBlockConditionSwitchTimes([condition], timeZone, from, until);
  const state = (now: number): boolean => textBlockTimeConditionsMatch(condition, { now, timeZone, dataConditions: {} });
  let previous = state(from);
  const actualFlips: string[] = [];
  for (let now = from + 60_000; now <= until; now += 60_000) {
    const current = state(now);
    if (current !== previous) actualFlips.push(new Date(now).toISOString());
    previous = current;
  }
  expect(actualFlips).toEqual(switches);
  return switches;
};

const baseState = {
  streamState: "online" as const,
  game: null,
  chatStatus: null,
  commandContext: false,
  timeZone: "Europe/Berlin",
  now: Date.parse("2026-06-21T02:42:00.000Z"),
};

describe("module-provided text block conditions", () => {
  it("matches the declared sun phase and resumes the default variant after sunrise", () => {
    const nightCondition: TextBlockConditions = { data: { "sun.phase": "night" } };

    expect(textBlockConditionsMatch(nightCondition, { ...baseState, dataConditions: { "sun.phase": "night" } })).toBe(true);
    expect(textBlockConditionsMatch(nightCondition, { ...baseState, dataConditions: { "sun.phase": "day" } })).toBe(false);
    expect(textBlockConditionsMatch(nightCondition, { ...baseState, dataConditions: {} })).toBe(false);
  });
});

describe("nextTextBlockLocalMidnight", () => {
  it("resolves the overlay refresh instant across Africa/Cairo's 2026 spring change, which skips local midnight", () => {
    const from = Date.parse("2026-04-23T10:00:00.000Z");
    expect(nextTextBlockLocalMidnight(from, "Africa/Cairo")).toBe(Date.parse("2026-04-23T22:00:00.000Z"));
  });
});

describe("textBlockConditionSwitchTimes across Africa/Cairo's 2026 spring change", () => {
  const timeZone = "Africa/Cairo";
  const from = Date.parse("2026-04-23T10:00:00.000Z");
  const until = Date.parse("2026-04-25T10:00:00.000Z");

  it("places the weekday boundary at the true start of the skipped local date, not one hour early", () => {
    const switches = textBlockConditionSwitchTimes([{ weekdays: [0, 1, 2, 3, 4, 5, 6] }], timeZone, from, until);

    expect(switches).toContain(localMidnightInTimeZone("2026-04-24", timeZone));
    expect(switches).not.toContain("2026-04-23T21:00:00.000Z");
  });

  it("keeps time-window switch instants correct across the same transition", () => {
    const switches = textBlockConditionSwitchTimes([{ timeWindow: { start: "22:30", end: "06:00" } }], timeZone, from, until);

    expect(switches).toEqual(["2026-04-23T20:30:00.000Z", "2026-04-24T03:00:00.000Z", "2026-04-24T19:30:00.000Z", "2026-04-25T03:00:00.000Z"]);
  });
});

describe("textBlockConditionSwitchTimes on a normal day", () => {
  it("switches exactly at the start and end wall times, with no DST involved", () => {
    const switches = assertSwitchesFlipExactly(
      { timeWindow: { start: "02:30", end: "06:00" } },
      "Europe/Berlin",
      Date.parse("2026-06-20T10:00:00.000Z"),
      Date.parse("2026-06-22T10:00:00.000Z"),
    );

    expect(switches).toEqual([
      "2026-06-21T00:30:00.000Z", "2026-06-21T04:00:00.000Z",
      "2026-06-22T00:30:00.000Z", "2026-06-22T04:00:00.000Z",
    ]);
  });
});

describe("textBlockConditionSwitchTimes when the boundary falls in a skipped hour (spring-forward)", () => {
  it("switches Europe/Berlin at the transition instant, not 30 minutes late", () => {
    const switches = assertSwitchesFlipExactly(
      { timeWindow: { start: "02:30", end: "06:00" } },
      "Europe/Berlin",
      Date.parse("2026-03-28T10:00:00.000Z"),
      Date.parse("2026-03-30T10:00:00.000Z"),
    );

    // 02:30 never occurs on 2026-03-29 (clocks jump 01:59:59 -> 03:00:00); the switch
    // fires at the jump itself, matching when the window would have opened.
    expect(switches).toContain("2026-03-29T01:00:00.000Z");
    expect(switches).not.toContain("2026-03-29T01:30:00.000Z");
  });

  it("switches Africa/Cairo at the transition instant, not 30 minutes late", () => {
    const switches = assertSwitchesFlipExactly(
      { timeWindow: { start: "00:30", end: "04:00" } },
      "Africa/Cairo",
      Date.parse("2026-04-23T10:00:00.000Z"),
      Date.parse("2026-04-25T10:00:00.000Z"),
    );

    expect(switches).toContain(localMidnightInTimeZone("2026-04-24", "Africa/Cairo"));
    expect(switches).not.toContain("2026-04-23T22:30:00.000Z");
  });
});

describe("textBlockConditionSwitchTimes when the boundary falls in a replayed hour (fall-back)", () => {
  it("switches Europe/Berlin at both occurrences, plus the mid-replay dip the reset itself causes", () => {
    const switches = assertSwitchesFlipExactly(
      { timeWindow: { start: "02:30", end: "06:00" } },
      "Europe/Berlin",
      Date.parse("2026-10-24T10:00:00.000Z"),
      Date.parse("2026-10-25T10:00:00.000Z"),
    );

    // 02:30 occurs twice on 2026-10-25 (clocks fall back 02:59:59 CEST -> 02:00:00 CET).
    // The window opens at the first 02:30, but the fall-back itself resets the clock to
    // 02:00 -- below the 02:30 start -- so the window closes again until the second 02:30.
    expect(switches).toEqual([
      "2026-10-25T00:30:00.000Z",
      "2026-10-25T01:00:00.000Z",
      "2026-10-25T01:30:00.000Z",
      "2026-10-25T05:00:00.000Z",
    ]);
  });

  it("switches America/Havana at both occurrences, plus the mid-replay dip the reset itself causes", () => {
    const switches = assertSwitchesFlipExactly(
      { timeWindow: { start: "00:30", end: "04:00" } },
      "America/Havana",
      Date.parse("2026-10-31T10:00:00.000Z"),
      Date.parse("2026-11-01T10:00:00.000Z"),
    );

    expect(switches).toEqual([
      "2026-11-01T04:30:00.000Z",
      "2026-11-01T05:00:00.000Z",
      "2026-11-01T05:30:00.000Z",
      "2026-11-01T09:00:00.000Z",
    ]);
  });
});

describe("textBlockConditionSwitchTimes formatter reuse", () => {
  it("reuses cached Intl.DateTimeFormat instances across a whole seven-day lookahead instead of rebuilding one per date probe", () => {
    const OriginalDateTimeFormat = Intl.DateTimeFormat;
    let constructions = 0;
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (
      this: unknown,
      ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
    ) {
      constructions += 1;
      return new OriginalDateTimeFormat(...args);
    });

    // A block with many time-windowed variants against a time zone this file hasn't
    // used yet, so the count below reflects only this one lookahead, not warm caches
    // left over from earlier tests in this file.
    const conditions = Array.from({ length: 20 }, (_, index) => ({
      timeWindow: { start: `0${String(index % 10)}:00`, end: `1${String(index % 10)}:00` },
    }));
    const from = Date.parse("2026-11-01T00:00:00.000Z");
    const until = from + 7 * 24 * 60 * 60 * 1_000;

    textBlockConditionSwitchTimes(conditions, "Asia/Tokyo", from, until);

    vi.restoreAllMocks();

    // One formatter per distinct helper (day-key, wall-clock, local-date, day-transition,
    // weekday/hour) for this one time zone, not one per date x condition probe -- the
    // regression this guards against rebuilt one on every probe (612 for a single
    // window, 1,372 for twenty, in a real seven-day lookahead).
    expect(constructions).toBeLessThanOrEqual(6);
  });
});
