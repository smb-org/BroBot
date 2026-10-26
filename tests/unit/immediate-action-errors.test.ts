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

  it.each([
    ["scope_missing", "Die erforderliche Twitch-Berechtigung zum Aufheben von Timeouts fehlt."],
    ["not_timed_out", "Für diesen Nutzer läuft kein Timeout"],
    ["twitch_error", "Twitch hat die Moderationsanfrage abgelehnt"],
  ])("maps Votekick lift failure %s to its localized moderation message", (reason, expected) => {
    const error = new PanelApiError(502, "votekick_timeout_lift_failed", { reason });

    expect(immediateActionErrorFeedback(error, "votekick", "Timeout konnte nicht aufgehoben werden", "de").message).toBe(expected);
  });
});
