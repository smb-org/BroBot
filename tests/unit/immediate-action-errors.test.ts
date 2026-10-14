import { describe, expect, it } from "vitest";

import { PanelApiError } from "../../src/contracts/panel-error";
import { immediateActionErrorFeedback } from "../../src/dashboard/immediate-action-errors";

describe("immediate action API errors", () => {
  it("shows the localized ads scope reason and a concrete next step", () => {
    const feedback = immediateActionErrorFeedback(
      new PanelApiError(403, "commercial_failed", { reason: "scope_missing" }),
      "ads",
      "Fallback",
      "de",
    );

    expect(feedback.message).toContain("Berechtigung für Werbeeinblendungen fehlt");
    expect(feedback.message).toContain("channel:edit:commercial");
    expect(feedback.until).toBeNull();
  });

  it("shows the commercial cooldown countdown from the reason catalog", () => {
    const until = Date.now() + 95_000;
    const feedback = immediateActionErrorFeedback(
      new PanelApiError(429, "commercial_cooldown", {
        reason: "commercial_cooldown",
        detail: { commercialCooldownUntil: until },
      }),
      "ads",
      "Fallback",
      "en",
    );

    expect(feedback.message).toContain("commercial cooldown");
    expect(feedback.message).toContain("Try again in {time}");
    expect(feedback.until).toBe(until);
  });

  it("adds the clip scope recovery action to the localized catalog message", () => {
    const feedback = immediateActionErrorFeedback(
      new PanelApiError(401, "scope_missing", { reason: "scope_missing" }),
      "clips",
      "Fallback",
      "en",
    );

    expect(feedback.message).toContain("Permission to create clips is missing");
    expect(feedback.message).toContain("Reconnect the bot account");
  });
});
