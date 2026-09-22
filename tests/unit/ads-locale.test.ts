import { describe, expect, it } from "vitest";

import { ereignisText, ereignisTon } from "../../src/dashboard/locale";
import { eventSubName, moduleDescription, moduleName, moduleScopePurpose } from "../../src/dashboard/module-labels";

describe("Werbung-Lokalisierung", () => {
  it.each([
    ["de" as const, "Werbung", "Kündigt beginnende Werbepausen im Chat an.", "Werbepausen", "Werbepause automatisch gestartet: 30 Sekunden"],
    ["en" as const, "Ad breaks", "Announces beginning ad breaks in chat.", "Ad breaks", "Ad break automatically started: 30 seconds"],
  ])("liefert alle sichtbaren Texte für %s", (language, name, description, eventName, eventText) => {
    expect(moduleName("ads", language)).toBe(name);
    expect(moduleDescription("ads", language)).toBe(description);
    expect(eventSubName("channel.ad_break.begin", "", language)).toBe(eventName);
    expect(ereignisText("ads.ankuendigung", { dauer: 30, automatic: true }, language)).toBe(eventText);
    expect(moduleScopePurpose("ads", "channel:read:ads", language)).toBe(
      language === "de" ? "Werbepausen erkennen" : "Detect ad breaks",
    );
  });

  it("ordnet Ansage und Überspringen getrennten Tönen zu", () => {
    expect(ereignisTon["ads.ankuendigung"]).toMatchObject({ familie: "betrieb", stufe: "gezeichnet", tone: "info", zahlSchluessel: "dauer" });
    expect(ereignisTon["ads.uebersprungen"]).toMatchObject({ familie: "betrieb", stufe: "gezeichnet", tone: "warning", zahlSchluessel: null });
  });
});
