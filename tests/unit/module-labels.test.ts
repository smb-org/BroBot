import { describe, expect, it } from "vitest";

import { MODULES } from "../../src/modules/registry";
import { moduleDescription, moduleName } from "../../src/dashboard/module-labels";

/**
 * The label catalogs are keyed by module id, and a missing entry
 * otherwise goes unnoticed: `moduleName` then returns the
 * technical id and `moduleDescription` returns null — the UI
 * shows "raid" and "No description", the build stays green.
 *
 * This check deliberately replaces a compiler check. Enforcing it through
 * the type would require a heterogeneous literal registry and thus a
 * bivariant `handleEvent`; that would loosen the module contract exactly where
 * schema and handler can diverge. The contract weighs heavier.
 */
describe("Module labels", () => {
  it.each(MODULES.map((module) => module.id))("has names in both languages for %s", (moduleId) => {
    for (const sprache of ["de", "en"] as const) {
      const name = moduleName(moduleId, sprache);
      expect(name).not.toBe(moduleId);
      expect(name.trim().length).toBeGreaterThan(0);
    }
  });

  it.each(MODULES.map((module) => module.id))("has a description in both languages for %s", (moduleId) => {
    for (const sprache of ["de", "en"] as const) {
      const beschreibung = moduleDescription(moduleId, sprache);
      expect(beschreibung).not.toBeNull();
      expect((beschreibung ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  it("returns the id and no description for an unknown module", () => {
    expect(moduleName("gibtesnicht", "de")).toBe("gibtesnicht");
    expect(moduleDescription("gibtesnicht", "de")).toBeNull();
  });
});
