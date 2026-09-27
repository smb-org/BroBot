import { describe, expect, it } from "vitest";

import { nextTextBlockLocalMidnight, textBlockConditionsMatch } from "../../src/modules/text_library/domain";
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
