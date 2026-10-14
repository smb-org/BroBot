import { describe, expect, it } from "vitest";

import { PanelApiError } from "../../src/contracts/panel-error";
import { immediateActionErrorFeedback } from "../../src/dashboard/immediate-action-errors";

describe("immediate action error feedback", () => {
  it.each([
    ["scope_missing", "Berechtigung zum Senden des Shoutouts fehlt"],
    ["not_moderator", "Der Bot ist kein Moderator in diesem Kanal"],
    ["rate_limited", "Twitch-Abklingzeit aktiv"],
  ])("keeps the localized shoutout reason for %s", (reason, expected) => {
    const error = new PanelApiError(502, "shoutout_send_failed", { reason });

    expect(immediateActionErrorFeedback(error, "raid", "Shoutout fehlgeschlagen", "de").message).toBe(expected);
  });
});
