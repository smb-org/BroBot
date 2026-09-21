import { describe, expect, it } from "vitest";

import {
  befehlAusNachricht,
  befehlTextMitPlatzhaltern,
  cooldownRestzeit,
  chatStatusErfuelltStufe,
  gueltigerBefehlsname,
} from "../../src/modules/textbefehle/domain";

describe("Textbefehle-Domain", () => {
  it("erkennt ein generisches !-Wort ohne Sonderfall", () => {
    expect(befehlAusNachricht("!befehle")).toEqual({ art: "befehl", name: "befehle" });
  });

  it("erlaubt nur einfache kleingeschriebene Befehlsnamen", () => {
    expect(gueltigerBefehlsname("willkommen")).toBe(true);
    expect(gueltigerBefehlsname("Willkommen")).toBe(false);
    expect(gueltigerBefehlsname("willkommen!"), "Sonderzeichen sind keine Befehlsnamen.").toBe(false);
  });

  it("ersetzt die vorgesehenen Platzhalter ohne weitere Variablen einzuführen", () => {
    expect(befehlTextMitPlatzhaltern("Hallo {user} in {channel} — {unknown}", "Alice", "Kanal A"))
      .toBe("Hallo Alice in Kanal A — {unknown}");
  });

  it("ersetzt keine deutschen Altname", () => {
    expect(befehlTextMitPlatzhaltern("Hallo {nutzer} in {kanal}", "Alice", "Kanal A"))
      .toBe("Hallo {nutzer} in {kanal}");
  });

  it("liefert die verbleibende Abkühlzeit in ganzen Sekunden", () => {
    expect(cooldownRestzeit("2026-09-19T12:00:00.000Z", "2026-09-19T12:00:03.200Z", 5)).toBe(2);
    expect(cooldownRestzeit("2026-09-19T12:00:00.000Z", "2026-09-19T12:00:05.000Z", 5)).toBe(0);
  });

  it("bildet die nicht-lineare Stufenleiter ausdrücklich ab", () => {
    expect(chatStatusErfuelltStufe(["moderator"], "moderator")).toBe(true);
    expect(chatStatusErfuelltStufe(["moderator"], "abonnent")).toBe(true);
    expect(chatStatusErfuelltStufe(["moderator"], "vip")).toBe(true);
    expect(chatStatusErfuelltStufe(["zuschauer"], "moderator")).toBe(false);
    expect(chatStatusErfuelltStufe(["vip"], "abonnent")).toBe(false);
    expect(chatStatusErfuelltStufe(["vip", "abonnent"], "abonnent")).toBe(true);
    expect(chatStatusErfuelltStufe(["abonnent"], "abonnent")).toBe(true);
    expect(chatStatusErfuelltStufe(null, "alle")).toBe(true);
  });
});
