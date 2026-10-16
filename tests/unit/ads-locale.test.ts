import { describe, expect, it } from "vitest";

import { eventText as eventTextFor, eventToneEntries } from "../../src/dashboard/locale";
import { eventSubName, moduleDescription, moduleName, moduleScopePurpose } from "../../src/dashboard/module-labels";
import { adsPanelTexts } from "../../src/modules/ads/panel/locale";

describe("ad locale", () => {
  it.each([
    ["de" as const, "Werbung", "Kündigt beginnende Werbepausen im Chat an.", "Werbepausen", "Werbepause automatisch startedAt: 30 Sekunden"],
    ["en" as const, "Ad breaks", "Announces beginning ad breaks in chat.", "Ad breaks", "Ad break automatically started: 30 seconds"],
  ])("delivers all visible texts for %s", (language, name, description, eventName, eventText) => {
    expect(moduleName("ads", language)).toBe(name);
    expect(moduleDescription("ads", language)).toBe(description);
    expect(eventSubName("channel.ad_break.begin", "", language)).toBe(eventName);
    expect(eventTextFor("ads.announcement", { duration: 30, automatic: true }, language)).toBe(eventText);
    expect(moduleScopePurpose("ads", "channel:read:ads", language)).toBe(
      language === "de" ? "Werbepausen erkennen" : "Detect ad breaks",
    );
  });

  it("assigns separate tones to announcement and skip", () => {
    expect(eventToneEntries["ads.announcement"]).toMatchObject({ family: "operations", tier: "outlined", tone: "info", numberKey: "duration" });
    expect(eventToneEntries["ads.skipped"]).toMatchObject({ family: "operations", tier: "outlined", tone: "warning", numberKey: null });
  });

  it("uses singular and plural wait units in both languages", () => {
    expect(adsPanelTexts("de").rateLimited(1)).toContain("in 1 Sekunde erneut");
    expect(adsPanelTexts("de").rateLimited(2)).toContain("in 2 Sekunden erneut");
    expect(adsPanelTexts("en").rateLimited(1)).toContain("in 1 second.");
    expect(adsPanelTexts("en").rateLimited(2)).toContain("in 2 seconds.");
  });
});
