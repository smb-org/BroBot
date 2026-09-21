import { describe, expect, it } from "vitest";

import {
  befehlAusNachricht,
  befehlTextMitPlatzhaltern,
  cooldownRestzeit,
  gueltigerBefehlsname,
} from "../../src/modules/textbefehle/domain";

describe("Textbefehle-Domain", () => {
  it("erkennt das Listen-Kommando", () => {
    expect(befehlAusNachricht("!befehle")).toEqual({ art: "listen", name: "befehle" });
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

  it("liefert die verbleibende Abkühlzeit in ganzen Sekunden", () => {
    expect(cooldownRestzeit("2026-09-19T12:00:00.000Z", "2026-09-19T12:00:03.200Z", 5)).toBe(2);
    expect(cooldownRestzeit("2026-09-19T12:00:00.000Z", "2026-09-19T12:00:05.000Z", 5)).toBe(0);
  });
});
