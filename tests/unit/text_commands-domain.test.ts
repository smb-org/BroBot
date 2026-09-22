import { describe, expect, it } from "vitest";

import {
  commandFromMessage,
  commandTextWithPlaceholders,
  cooldownRestzeit,
  chatStatusMeetsTier,
  validCommandName,
} from "../../src/modules/text_commands/domain";

describe("Textbefehle-Domain", () => {
  it("erkennt ein generisches !-Wort ohne Sonderfall", () => {
    expect(commandFromMessage("!befehle")).toEqual({ kind: "befehl", name: "befehle" });
  });

  it("erlaubt nur einfache kleingeschriebene Befehlsnamen", () => {
    expect(validCommandName("willkommen")).toBe(true);
    expect(validCommandName("Willkommen")).toBe(false);
    expect(validCommandName("willkommen!"), "Sonderzeichen sind keine Befehlsnamen.").toBe(false);
  });

  it("ersetzt die vorgesehenen Platzhalter ohne weitere Variablen einzuführen", () => {
    expect(commandTextWithPlaceholders("Hallo {user} in {channel} — {unknown}", "Alice", "Kanal A"))
      .toBe("Hallo Alice in Kanal A — {unknown}");
  });

  it("ersetzt keine deutschen Altname", () => {
    expect(commandTextWithPlaceholders("Hallo {nutzer} in {kanal}", "Alice", "Kanal A"))
      .toBe("Hallo {nutzer} in {kanal}");
  });

  it("liefert die verbleibende Abkühlzeit in ganzen Sekunden", () => {
    expect(cooldownRestzeit("2026-09-19T12:00:00.000Z", "2026-09-19T12:00:03.200Z", 5)).toBe(2);
    expect(cooldownRestzeit("2026-09-19T12:00:00.000Z", "2026-09-19T12:00:05.000Z", 5)).toBe(0);
  });

  it("bildet die nicht-lineare Stufenleiter ausdrücklich ab", () => {
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
