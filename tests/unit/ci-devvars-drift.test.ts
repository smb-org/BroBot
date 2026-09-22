import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const wurzel = path.resolve(import.meta.dirname, "../..");
const beispiel = readFileSync(path.join(wurzel, ".dev.vars.example"), "utf8");
const workflow = readFileSync(path.join(wurzel, ".github/workflows/ci.yml"), "utf8");

/** Namen, die in .dev.vars.example einen Wert zugewiesen bekommen. */
const beispielNamen = (): string[] =>
  [...beispiel.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].flatMap((m) => m[1] === undefined ? [] : [m[1]]);

/** Namen, für die der Workflow eine sed-Ersetzung mitbringt. */
const ersetzteNamen = (): Set<string> => new Set(
  [...workflow.matchAll(/s\|\^([A-Z][A-Z0-9_]*)=\.\*\|/g)].flatMap((m) => m[1] === undefined ? [] : [m[1]]),
);

/**
 * Die CI baut ihre `.dev.vars` aus `.dev.vars.example`, indem sie einzelne
 * Zeilen per `sed` durch echte Zufallswerte ersetzt. Wird ein Secret umbenannt
 * und der Workflow nicht mitgezogen, greift die Regel ins Leere: Der
 * Platzhalter `replace-with-…` landet unverändert in `.dev.vars`, gilt als
 * fehlend — und weil er nicht leer ist, springt auch kein Fallback an. Genau
 * das ist bei der Umbenennung zu TOKEN_ENCRYPTION_KEYS passiert, und lokal
 * fällt es nie auf, weil dort keine `.dev.vars` aus dem Beispiel entsteht.
 */
describe("CI-Testkonfiguration", () => {
  it("übernimmt das gültige leere Betreiber-Array unverändert", () => {
    const value = /^BETREIBER_USER_IDS=(.*)$/m.exec(beispiel)?.[1];

    expect(value).toBe("[]");
  });

  it("ersetzt jeden Platzhalter aus .dev.vars.example", () => {
    const ersetzt = ersetzteNamen();
    const offen = beispielNamen().filter((name) => {
      const zeile = new RegExp(`^${name}=(.*)$`, "m").exec(beispiel)?.[1] ?? "";
      return /replace-with|example\.invalid/i.test(zeile) && !ersetzt.has(name);
    });

    expect(offen).toEqual([]);
  });

  it("ersetzt keinen Namen, den es im Beispiel nicht mehr gibt", () => {
    const vorhanden = new Set(beispielNamen());
    expect([...ersetzteNamen()].filter((name) => !vorhanden.has(name))).toEqual([]);
  });
});
