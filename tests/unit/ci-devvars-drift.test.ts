import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const wurzel = path.resolve(import.meta.dirname, "../..");
const beispiel = readFileSync(path.join(wurzel, ".dev.vars.example"), "utf8");
const workflow = readFileSync(path.join(wurzel, ".github/workflows/ci.yml"), "utf8");

/** Names that get a value assigned in .dev.vars.example. */
const beispielNamen = (): string[] =>
  [...beispiel.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].flatMap((m) => m[1] === undefined ? [] : [m[1]]);

/** Names for which the workflow provides a sed replacement. */
const ersetzteNamen = (): Set<string> => new Set(
  [...workflow.matchAll(/s\|\^([A-Z][A-Z0-9_]*)=\.\*\|/g)].flatMap((m) => m[1] === undefined ? [] : [m[1]]),
);

/**
 * CI builds its `.dev.vars` from `.dev.vars.example` by replacing individual
 * lines with real random values via `sed`. If a secret gets renamed and the
 * workflow isn't updated along with it, the rule misses: the
 * `replace-with-…` placeholder lands in `.dev.vars` unchanged, counts as
 * missing — and because it isn't empty, no fallback kicks in either. That's
 * exactly what happened with the rename to TOKEN_ENCRYPTION_KEYS, and it
 * never shows up locally, because no `.dev.vars` gets built from the example
 * there.
 */
describe("CI test configuration", () => {
  it("carries over the valid empty operator array unchanged", () => {
    const value = /^PLATFORM_USER_IDS=(.*)$/m.exec(beispiel)?.[1];

    expect(value).toBe("[]");
  });

  it("replaces every placeholder from .dev.vars.example", () => {
    const ersetzt = ersetzteNamen();
    const offen = beispielNamen().filter((name) => {
      const zeile = new RegExp(`^${name}=(.*)$`, "m").exec(beispiel)?.[1] ?? "";
      return /replace-with|example\.invalid/i.test(zeile) && !ersetzt.has(name);
    });

    expect(offen).toEqual([]);
  });

  it("doesn't replace a name that no longer exists in the example", () => {
    const vorhanden = new Set(beispielNamen());
    expect([...ersetzteNamen()].filter((name) => !vorhanden.has(name))).toEqual([]);
  });
});
