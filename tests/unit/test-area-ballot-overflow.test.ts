import { describe, expect, it } from "vitest";

import { dashboardTexts } from "../../src/dashboard/locale";

describe("test area ballot overflow", () => {
  it("counts repeated votes for one term as votes, not terms", () => {
    const de = dashboardTexts("de").testArea;
    const en = dashboardTexts("en").testArea;
    expect(de.ballotMore(2)).toBe("2 weitere Stimmen");
    expect(en.ballotMore(2)).toBe("2 more votes");
    expect(de.ballotMore(1234)).toBe("1.234 weitere Stimmen");
  });

  it("labels free-text votes as terms and option votes as numbers", () => {
    expect(dashboardTexts("de").testArea.wouldCountVote("123", "term")).toBe("Würde Begriff „123“ zählen");
    expect(dashboardTexts("en").testArea.wouldCountVote("123", "term")).toBe("Would count term “123”");
    expect(dashboardTexts("de").testArea.wouldCountVote("2", "option")).toBe("Würde Stimme 2 zählen");
  });
});
