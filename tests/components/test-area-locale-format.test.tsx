import { describe, expect, it } from "vitest";

import { dashboardTexts } from "../../src/dashboard/locale";

describe("test area locale formatting", () => {
  it("quotes tokens per language", () => {
    expect(dashboardTexts("de").testArea.quoted("dc")).toBe("„dc“");
    expect(dashboardTexts("en").testArea.quoted("dc")).toBe("“dc”");
  });

  it("formats effect and summary numbers per language", () => {
    const de = dashboardTexts("de").testArea;
    const en = dashboardTexts("en").testArea;
    expect(de.timeoutEffect(12345, 23456, "")).toBe("Timeout 12.345–23.456 s");
    expect(en.timeoutEffect(12345, 23456, "")).toBe("Timeout 12,345–23,456 s");
    expect(de.variableEffect("x", 12345, 23456)).toContain("12.345 auf 23.456");
    expect(en.variableEffect("x", 12345, 23456)).toContain("12,345 to 23,456");
    expect(de.cooldownEffect(12345)).toContain("12.345 s");
    expect(en.userCooldownEffect(12345)).toContain("12,345 s");
    expect(de.blockReason("faq.cooldown", { remainingSeconds: 12345 })).toContain("12.345 s");
    expect(en.blockReason("faq.cooldown", { remainingSeconds: 12345 })).toContain("12,345 s");
    expect(de.resultCount(12345)).toBe("12.345 Treffer");
    expect(en.reactionsSummary(12345, 1234)).toBe("12,345 reactions · 1,234 blocked");
  });
});
