import { describe, expect, it } from "vitest";

import { eventText as eventTextFor, eventToneEntries } from "../../src/dashboard/locale";
import { eventSubName, moduleDescription, moduleName, moduleScopePurpose } from "../../src/dashboard/module-labels";

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
});
