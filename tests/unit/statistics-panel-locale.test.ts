import { describe, expect, it } from "vitest";

import { statisticsPanelTexts } from "../../src/modules/statistics/panel/locale";

describe("statistics raid sentences", () => {
  it.each([
    ["de", 1, "Raid von Partner mit 1 Zuschauer", "Raid zu Partner mit 1 Zuschauer"],
    ["de", 0, "Raid von Partner mit 0 Zuschauern", "Raid zu Partner mit 0 Zuschauern"],
    ["de", 1234, "Raid von Partner mit 1.234 Zuschauern", "Raid zu Partner mit 1.234 Zuschauern"],
    ["en", 1, "Raid from Partner with 1 viewer", "Raid to Partner with 1 viewer"],
    ["en", 0, "Raid from Partner with 0 viewers", "Raid to Partner with 0 viewers"],
    ["en", 1234, "Raid from Partner with 1,234 viewers", "Raid to Partner with 1,234 viewers"],
  ] as const)("formats %s with %i viewers in both directions", (language, viewers, from, to) => {
    const texts = statisticsPanelTexts(language);

    expect(texts.raidFrom("Partner", viewers)).toBe(from);
    expect(texts.raidTo("Partner", viewers)).toBe(to);
  });
});
