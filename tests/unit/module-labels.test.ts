import { describe, expect, it } from "vitest";

import { MODULES } from "../../src/modules/registry";
import { moduleDescription, moduleName, moduleNavigationName } from "../../src/dashboard/module-labels";

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

  it.each(MODULES.filter((module) => module.mandatory).map((module) => module.id))("has a localized lock reason in both languages for mandatory module %s", (moduleId) => {
    const module = MODULES.find((candidate) => candidate.id === moduleId);
    expect(module?.mandatoryReason).toBeDefined();
    for (const language of ["de", "en"] as const) {
      expect(module?.mandatoryReason?.[language].trim().length).toBeGreaterThan(0);
    }
  });

  it("returns the id and no description for an unknown module", () => {
    expect(moduleName("gibtesnicht", "de")).toBe("gibtesnicht");
    expect(moduleDescription("gibtesnicht", "de")).toBeNull();
  });

  it("labels the unregistered host module id instead of showing it raw (issue #201)", () => {
    expect(moduleName("host", "de")).toBe("System");
    expect(moduleName("host", "en")).toBe("System");
  });

  it("has a localized navigation description for the quiz game", () => {
    const quiz = MODULES.find((module) => module.id === "quiz");
    const entry = quiz?.navigationEntries?.[0];
    expect(entry?.description?.de.trim().length).toBeGreaterThan(0);
    expect(entry?.description?.en.trim().length).toBeGreaterThan(0);
  });

  it("uses the raid announcements and shoutout name for the existing raid module id in both catalogues", () => {
    expect(moduleName("raid", "de")).toBe("Raid-Ankündigungen & Shoutout");
    expect(moduleName("raid", "en")).toBe("Raid announcements & shoutout");
    expect(moduleNavigationName("raid", "de")).toBe("Raid & Shoutout");
    expect(moduleNavigationName("raid", "en")).toBe("Raid & shoutout");
    expect(moduleDescription("raid", "de")).toContain("Raids");
    expect(moduleDescription("raid", "de")).toContain("manuelle Shoutouts");
    expect(moduleDescription("raid", "en")).toContain("incoming raids");
    expect(moduleDescription("raid", "en")).toContain("manual shoutouts");
  });

  it("explains retained aggregate metrics and partner-channel raid details in both languages", () => {
    const module = MODULES.find((candidate) => candidate.id === "statistics");
    expect(module?.mandatory).toBe(true);
    expect(module?.navigationCategory).toBe("data");
    expect(module?.needsActiveChatters).toBe(true);
    expect(module?.eventSubTypes).toEqual(["channel.chat.message", "stream.online", "stream.offline", "channel.update"]);
    expect(moduleName("statistics", "de")).toBe("Statistiken");
    expect(moduleName("statistics", "en")).toBe("Statistics");
    expect(moduleDescription("statistics", "de")).toContain("ungefähre Zahl unterschiedlicher Chatter");
    expect(moduleDescription("statistics", "de")).toContain("Dauerhaft gespeichert werden Fenstersummen, eine kanalweite Liste der häufigsten Wörter");
    expect(moduleDescription("statistics", "de")).toContain("Zeitleisten-Ereignisse je Stream");
    expect(moduleDescription("statistics", "de")).toContain("eingehende und ausgehende Raids mit Kennung, Login und Anzeigenamen des Partnerkanals");
    expect(moduleDescription("statistics", "de")).toContain("keine Namen oder Kennungen einzelner Zuschauer oder Clip-Ersteller und keine einzelnen Nachrichten");
    expect(moduleDescription("statistics", "en")).toContain("approximates distinct chatters");
    expect(moduleDescription("statistics", "en")).toContain("Retained are window totals, a channel-wide list of the most frequent words");
    expect(moduleDescription("statistics", "en")).toContain("stream timeline events");
    expect(moduleDescription("statistics", "en")).toContain("incoming and outgoing raids with the partner channel's ID, login, and display name");
    expect(moduleDescription("statistics", "en")).toContain("no names or IDs of individual viewers or clip creators, and no individual messages");
    expect(module?.mandatoryReason?.de).toContain("immer aktiv");
    expect(module?.mandatoryReason?.en).toContain("always active");
  });
});
