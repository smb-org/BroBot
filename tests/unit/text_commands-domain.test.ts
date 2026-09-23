import { describe, expect, it } from "vitest";

import {
  commandFromMessage,
  renderCommandText,
  cooldownRemaining,
  chatStatusMeetsTier,
  validCommandName,
} from "../../src/modules/text_commands/domain";

describe("Text commands domain", () => {
  it("recognizes a generic !-word with no special case", () => {
    expect(commandFromMessage("!befehle")).toEqual({ kind: "command", name: "befehle" });
  });

  it("allows only simple lowercase command names", () => {
    expect(validCommandName("willkommen")).toBe(true);
    expect(validCommandName("Willkommen")).toBe(false);
    expect(validCommandName("willkommen!"), "Sonderzeichen sind keine Befehlsnamen.").toBe(false);
  });

  it("replaces the designated placeholders without introducing further variables", () => {
    expect(renderCommandText("Hallo {user} in {channel} — {unknown}", { user: "Alice", channel: "Kanal A" }))
      .toBe("Hallo Alice in Kanal A — {unknown}");
  });

  it("does not replace old German placeholder names", () => {
    expect(renderCommandText("Hallo {nutzer} in {kanal}", { user: "Alice", channel: "Kanal A" }))
      .toBe("Hallo {nutzer} in {kanal}");
  });

  it("returns the remaining cooldown in whole seconds", () => {
    expect(cooldownRemaining("2026-09-19T12:00:00.000Z", "2026-09-19T12:00:03.200Z", 5)).toBe(2);
    expect(cooldownRemaining("2026-09-19T12:00:00.000Z", "2026-09-19T12:00:05.000Z", 5)).toBe(0);
  });

  it("explicitly models the non-linear tier ladder", () => {
    expect(chatStatusMeetsTier(["moderator"], "moderator")).toBe(true);
    expect(chatStatusMeetsTier(["moderator"], "subscriber")).toBe(true);
    expect(chatStatusMeetsTier(["moderator"], "vip")).toBe(true);
    expect(chatStatusMeetsTier(["viewer"], "moderator")).toBe(false);
    expect(chatStatusMeetsTier(["vip"], "subscriber")).toBe(false);
    expect(chatStatusMeetsTier(["vip", "subscriber"], "subscriber")).toBe(true);
    expect(chatStatusMeetsTier(["subscriber"], "subscriber")).toBe(true);
    expect(chatStatusMeetsTier(null, "everyone")).toBe(true);
  });
});
