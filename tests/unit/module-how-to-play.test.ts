import { describe, expect, it } from "vitest";

import { MODULES } from "../../src/modules/registry";
import { deriveModuleHowToPlay, moduleChatCommandsForSettings, moduleSettingsForHelp } from "../../src/dashboard/module-how-to-play-model";

const moduleById = (moduleId: string) => {
  const module = MODULES.find((candidate) => candidate.id === moduleId);
  if (module === undefined) throw new Error(`Module ${moduleId} is missing.`);
  return module;
};

const settingsWith = (moduleId: string, overrides: Record<string, unknown>): Record<string, unknown> => ({
  ...(moduleById(moduleId).defaultSettings as Record<string, unknown>),
  ...overrides,
});

describe("module how-to-play derivation", () => {
  it("derives game start and participation rows from each game module contract", () => {
    const expectedKinds = {
      quiz: ["cockpit", "participation"],
      blitz_round: ["cockpit", "auto_start", "participation"],
      boss_fight: ["cockpit", "command"],
      heist: ["command"],
      duel: ["command", "command", "participation_setting"],
      emote_slots: ["command", "participation"],
      votekick: ["command", "participation"],
    } as const;

    for (const [moduleId, expected] of Object.entries(expectedKinds)) {
      const module = moduleById(moduleId);
      const rows = deriveModuleHowToPlay(module, module.defaultSettings, "de");
      expect(rows.map((row) => row.kind), moduleId).toEqual(expected);
    }
  });

  it("marks only cockpit actions that require the stream to be live", () => {
    const quiz = moduleById("quiz");
    const blitz = moduleById("blitz_round");
    const boss = moduleById("boss_fight");
    const quizRows = deriveModuleHowToPlay(quiz, quiz.defaultSettings, "de");
    const blitzRows = deriveModuleHowToPlay(blitz, blitz.defaultSettings, "de");
    const bossRows = deriveModuleHowToPlay(boss, boss.defaultSettings, "de");

    expect(quizRows[0]?.text).toContain("Quiz starten");
    expect(quizRows[0]?.text).toContain("Stream läuft");
    expect(blitzRows[0]?.text).toContain("Blitzrunde starten");
    expect(blitzRows[0]?.text).not.toContain("Stream läuft");
    expect(bossRows[0]?.text).toContain("Bosskampf starten");
    expect(bossRows[0]?.text).toContain("Stream läuft");
  });

  it("derives game cockpit starts from immediate actions when no start list is configured", () => {
    const boss = moduleById("boss_fight");
    expect(boss.howToPlay?.cockpitActionIds).toBeUndefined();
    expect(deriveModuleHowToPlay(boss, boss.defaultSettings, "de")[0]?.text).toContain("Bosskampf starten");
  });

  it("uses localized optional stake syntax for Slot", () => {
    const slot = moduleById("emote_slots");
    expect(deriveModuleHowToPlay(slot, slot.defaultSettings, "de")[0]?.text).toContain("!slot [Einsatz]");
    expect(deriveModuleHowToPlay(slot, slot.defaultSettings, "en")[0]?.text).toContain("!slot [stake]");
  });

  it("shows the numeric Votekick ballot choices", () => {
    const votekick = moduleById("votekick");
    expect(deriveModuleHowToPlay(votekick, votekick.defaultSettings, "de")[1]?.text).toContain("1 = Ja und 2 = Nein");
    expect(deriveModuleHowToPlay(votekick, votekick.defaultSettings, "en")[1]?.text).toContain("1 = yes and 2 = no");
  });

  it("uses configured duel command names and votekick role settings", () => {
    const duel = moduleById("duel");
    const duelSettings = settingsWith("duel", { challengeCommand: "!challenge", acceptCommand: "!accept" });
    const duelRows = deriveModuleHowToPlay(duel, duelSettings, "de");
    const votekick = moduleById("votekick");
    const votekickRows = deriveModuleHowToPlay(votekick, settingsWith("votekick", { starterMinRole: "moderator" }), "de");

    expect(duelRows.map((row) => row.text)).toEqual([
      "Chat → !challenge [@login] [Einsatz] (für alle)",
      "Chat → !accept (für alle)",
      "Broadcaster und Moderatoren dürfen mitspielen.",
    ]);
    expect(votekickRows[0]?.text).toContain("(ab Moderator)");
    expect(votekickRows[0]?.text).not.toContain("VIP");
    expect(deriveModuleHowToPlay(votekick, settingsWith("votekick", { starterMinRole: "vip" }), "en")[0]?.text).toContain("(VIP and up)");
  });

  it("does not present default command names as configured when the Duel settings are invalid or malformed", () => {
    const duel = moduleById("duel");
    const invalid = settingsWith("duel", { challengeCommand: "!same", acceptCommand: "!same" });
    const malformed = moduleSettingsForHelp(duel, "{not json");

    for (const settings of [invalid, malformed]) {
      expect(moduleChatCommandsForSettings(duel, settings, "de")).toEqual([]);
      for (const language of ["de", "en"] as const) {
        const texts = deriveModuleHowToPlay(duel, settings, language).map((row) => row.text);
        expect(texts[0]).toMatch(language === "de" ? /nicht verfügbar/u : /unavailable/u);
        expect(texts.join(" ")).not.toMatch(/!duell|!ja|Chat →/u);
      }
    }
    expect(moduleSettingsForHelp(moduleById("blitz_round"), "{not json")).toEqual(moduleById("blitz_round").defaultSettings);
  });

  it("labels rule notes separately from the ways to join", () => {
    const labelsOf = (moduleId: string) => {
      const module = moduleById(moduleId);
      return deriveModuleHowToPlay(module, module.defaultSettings, "de").map((row) => row.label);
    };

    expect(labelsOf("duel")).toEqual(["start", "participate", "note"]);
    expect(labelsOf("emote_slots")).toEqual(["startAndJoin", "note"]);
    expect(labelsOf("quiz")).toEqual(["start", "participate"]);
    expect(labelsOf("votekick")).toEqual(["start", "participate"]);
  });

  it("shows nothing for Points, which sits in the games category but is not a game", () => {
    const points = moduleById("points");
    expect(deriveModuleHowToPlay(points, points.defaultSettings, "de")).toEqual([]);
  });
});
