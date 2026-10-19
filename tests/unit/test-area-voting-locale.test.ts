import { describe, expect, it } from "vitest";

import { dashboardTexts } from "../../src/dashboard/locale";

describe("test area voting copy", () => {
  it("formats ballot counts in the selected language", () => {
    expect(dashboardTexts("de").testArea.ballotCounts("chat_voting", [1234, 2345]))
      .toBe("Stimmen: Option 1: 1.234 · Option 2: 2.345");
    expect(dashboardTexts("en").testArea.ballotCounts("chat_voting", [1234, 2345]))
      .toBe("Votes: Option 1: 1,234 · Option 2: 2,345");
  });

  it("uses singular and plural votes for ballot overflow in both catalogs", () => {
    expect(dashboardTexts("de").testArea.ballotMore(1)).toBe("1 weitere Stimme");
    expect(dashboardTexts("de").testArea.ballotMore(4)).toBe("4 weitere Stimmen");
    expect(dashboardTexts("en").testArea.ballotMore(1)).toBe("1 more vote");
    expect(dashboardTexts("en").testArea.ballotMore(4)).toBe("4 more votes");
  });
});
