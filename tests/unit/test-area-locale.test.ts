import { describe, expect, it } from "vitest";

import { dashboardTexts } from "../../src/dashboard/locale";

describe("test area reaction summary", () => {
  it("omits zero counts in both language catalogs", () => {
    expect(dashboardTexts("de").testArea.reactionsSummary(0, 1)).toBe("1 blockiert");
    expect(dashboardTexts("de").testArea.reactionsSummary(1, 0)).toBe("1 reagiert");
    expect(dashboardTexts("en").testArea.reactionsSummary(0, 1)).toBe("1 blocked");
    expect(dashboardTexts("en").testArea.reactionsSummary(1, 0)).toBe("1 reaction");
  });
});
