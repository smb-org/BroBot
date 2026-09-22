import { describe, expect, it } from "vitest";

import { decideAdPrewarning } from "../../src/modules/ads/domain";

const jetztAmMs = Date.parse("2026-09-21T11:59:00.000Z");
const geplanterTerminAmMs = Date.parse("2026-09-21T12:00:00.000Z");
const einstellungen = {
  prewarning: true,
  leadSeconds: 60,
  prewarningText: "Werbung in {seconds} Sekunden.",
};

const eingabe = (overrides: Partial<Parameters<typeof decideAdPrewarning>[0]> = {}) => ({
  settings: einstellungen,
  scopeVorhanden: true,
  jetztAmMs,
  geplantAmMs: geplanterTerminAmMs,
  schedule: {
    nextAdAt: "2026-09-21T12:00:00.000Z",
    lastAdAt: null,
  },
  ...overrides,
});

describe("Werbe-Vorwarnungsentscheidung", () => {
  it("sagt den unveränderten Termin mit dem Platzhalter an", () => {
    expect(decideAdPrewarning(eingabe())).toEqual({
      kind: "announce",
      text: "Werbung in 60 Sekunden.",
      sekunden: 60,
      terminAm: "2026-09-21T12:00:00.000Z",
    });
  });

  // Ein Wecker feuert nie zu früh, aber regelmäßig ein paar Millisekunden zu
  // spät. Ohne Spielraum wäre das der Normalfall und die Vorwarnung fiele
  // jedes Mal aus — ein Test mit exakten Zeiten sähe davon nichts.
  it("sagt auch dann an, wenn der Wecker eine Sekunde zu spät kommt", () => {
    expect(decideAdPrewarning(eingabe({
      jetztAmMs: jetztAmMs + 1_100,
    }))).toMatchObject({ kind: "announce", sekunden: 59, text: "Werbung in 59 Sekunden." });
  });

  it("ignoriert den deutschen Altname für Sekunden", () => {
    const result = decideAdPrewarning(eingabe({
      settings: { ...einstellungen, prewarningText: "Werbung in {sekunden} Sekunden." },
    }));

    expect(result).toMatchObject({ kind: "announce", text: "Werbung in {sekunden} Sekunden." });
  });

  it("nennt die tatsächlich verbleibende Zeit, nicht die eingestellte Vorlaufzeit", () => {
    expect(decideAdPrewarning(eingabe({
      jetztAmMs: Date.parse("2026-09-21T11:59:15.000Z"),
    }))).toMatchObject({ kind: "announce", sekunden: 45, text: "Werbung in 45 Sekunden." });
  });

  it("behandelt eine Verschiebung um eine Sekunde als denselben Termin", () => {
    expect(decideAdPrewarning(eingabe({
      schedule: { nextAdAt: "2026-09-21T12:00:01.000Z", lastAdAt: null },
    }))).toMatchObject({ kind: "announce" });
  });

  it.each([
    ["kein Termin", { schedule: { nextAdAt: null, lastAdAt: null } }, "kein_termin"],
    ["Termin unmittelbar bevorstehend", { jetztAmMs: Date.parse("2026-09-21T11:59:57.000Z") }, "zu_spaet"],
    ["begonnene Pause", { schedule: { nextAdAt: "2026-09-21T12:05:00.000Z", lastAdAt: "2026-09-21T12:00:01.000Z" } }, "pause_begonnen"],
    ["verschobener Termin", { schedule: { nextAdAt: "2026-09-21T12:05:00.000Z", lastAdAt: null } }, "termin_verschoben"],
    ["fehlender Scope", { scopeVorhanden: false }, "scope_fehlt"],
  ] as const)("begründet %s mit eigenem Code", (_name, overrides, reason) => {
    expect(decideAdPrewarning(eingabe(overrides))).toMatchObject({ kind: "skip", reason });
  });
});
