import { describe, expect, it } from "vitest";

import { localMidnightInTimeZone } from "../../src/modules/contract";
import { nextTextBlockLocalMidnight, textBlockConditionSwitchTimes, textBlockConditionsMatch } from "../../src/modules/text_library/domain";
import type { TextBlockConditions } from "../../src/modules/text_library/contracts";

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
