import { describe, expect, it } from "vitest";

import { MODULES } from "../../src/modules/registry";
import { moduleDescription, moduleName } from "../../src/dashboard/module-labels";

/**
 * Die Beschriftungskataloge sind nach Modulkennung geschlüsselt, und ein
 * fehlender Eintrag fällt sonst nicht auf: `moduleName` gibt dann die
 * technische Kennung zurück und `moduleDescription` null — die Oberfläche
 * zeigt „raid" und „Keine Beschreibung", der Build bleibt grün.
 *
 * Diese Prüfung ersetzt eine Compilerprüfung bewusst. Sie über den Typ zu
 * erzwingen verlangte eine heterogene Literal-Registry und damit einen
 * bivarianten `handleEvent`; das lockerte den Modulvertrag genau dort, wo
 * Schema und Handler auseinanderlaufen können. Der Vertrag wiegt schwerer.
 */
describe("Modulbeschriftungen", () => {
  it.each(MODULES.map((modul) => modul.id))("führt für %s Namen in beiden Sprachen", (moduleId) => {
    for (const sprache of ["de", "en"] as const) {
      const name = moduleName(moduleId, sprache);
      expect(name).not.toBe(moduleId);
      expect(name.trim().length).toBeGreaterThan(0);
    }
  });

  it.each(MODULES.map((modul) => modul.id))("führt für %s eine Beschreibung in beiden Sprachen", (moduleId) => {
    for (const sprache of ["de", "en"] as const) {
      const beschreibung = moduleDescription(moduleId, sprache);
      expect(beschreibung).not.toBeNull();
      expect((beschreibung ?? "").trim().length).toBeGreaterThan(0);
    }
  });

  it("gibt für ein unbekanntes Modul die Kennung und keine Beschreibung zurück", () => {
    expect(moduleName("gibtesnicht", "de")).toBe("gibtesnicht");
    expect(moduleDescription("gibtesnicht", "de")).toBeNull();
  });
});
