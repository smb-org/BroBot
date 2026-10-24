import { describe, expect, it } from "vitest";

import { chatVotingSettingsReadSchema, chatVotingSettingsSchema } from "../../src/modules/chat_voting/contracts";
import { MODULES } from "../../src/modules/registry";
import { resolveMessageEnabledFlags } from "../../src/contracts/resolve-message-enabled";

type SettingsParser = { safeParse: (value: unknown) => { success: boolean } };

const moduleFor = (id: string) => {
  const module = MODULES.find((candidate) => candidate.id === id);
  if (module === undefined) throw new Error(`Missing module: ${id}`);
  return module;
};

const settingsFor = (id: string): Record<string, unknown> =>
  JSON.parse(JSON.stringify(moduleFor(id).defaultSettings)) as Record<string, unknown>;

const objectAt = (settings: Record<string, unknown>, key: string): Record<string, unknown> => {
  const value = settings[key];
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`Missing settings object: ${key}`);
  return value as Record<string, unknown>;
};

const messageCases = (): Array<{ id: string; settings: Record<string, unknown> }> => {
  const ads = settingsFor("ads");
  for (const key of ["automatic", "manual", "prewarningText"]) {
    ads[key] = "";
    ads[`${key}Enabled`] = true;
  }

  const raid = settingsFor("raid");
  for (const key of ["textLong", "textShort"]) {
    raid[key] = "";
    raid[`${key}Enabled`] = true;
  }

  const duel = settingsFor("duel");
  const duelTexts = objectAt(duel, "texts");
  for (const key of ["challengeOpen", "challengeTargeted", "result", "botResult"]) {
    duelTexts[key] = "";
    duelTexts[`${key}Enabled`] = true;
  }
  for (const key of ["fightVariants", "botFightVariants"]) {
    duelTexts[key] = ["", ...(duelTexts[key] as string[]).slice(1)];
    duelTexts[`${key}Enabled`] = [true, ...((duelTexts[`${key}Enabled`] as boolean[] | undefined)?.slice(1) ?? [])];
  }
  const errors = objectAt(duelTexts, "errors");
  for (const key of Object.keys(errors).filter((candidate) => !candidate.endsWith("Enabled"))) {
    errors[key] = "";
    errors[`${key}Enabled`] = true;
  }

  const belabox = settingsFor("belabox");
  for (const key of ["lowText", "disconnectText", "recoveryText"]) {
    belabox[key] = "";
    belabox[`${key}Enabled`] = true;
  }

  const votekick = settingsFor("votekick");
  for (const key of ["startText", "passText", "failText", "expiredText", "protectedText", "busyText"]) {
    votekick[key] = "";
    votekick[`${key}Enabled`] = true;
  }

  const chatVoting = settingsFor("chat_voting");
  chatVoting.startText = "";
  chatVoting.startTextEnabled = true;
  chatVoting.resultText = "";
  chatVoting.announceResult = true;

  const emoteSlots = settingsFor("emote_slots");
  const slotTexts = objectAt(emoteSlots, "texts");
  for (const key of ["win", "loss", "pair", "jackpot"]) {
    slotTexts[key] = "";
    slotTexts[`${key}Enabled`] = true;
  }

  const blitzRound = settingsFor("blitz_round");
  for (const key of ["startText", "solvedText", "timeoutText"]) {
    blitzRound[key] = "";
    blitzRound[`${key}Enabled`] = true;
  }

  return [
    { id: "ads", settings: ads },
    { id: "raid", settings: raid },
    { id: "duel", settings: duel },
    { id: "belabox", settings: belabox },
    { id: "votekick", settings: votekick },
    { id: "chat_voting", settings: chatVoting },
    { id: "emote_slots", settings: emoteSlots },
    { id: "blitz_round", settings: blitzRound },
  ];
};

describe("legacy message settings", () => {
  it("reads stored enabled-but-empty messages while rejecting the same values as new writes", () => {
    for (const { id, settings } of messageCases()) {
      const module = moduleFor(id);
      const readSchema = (module as unknown as { settingsReadSchema?: SettingsParser }).settingsReadSchema ?? module.settingsSchema;

      expect(readSchema.safeParse(settings).success, `${id} legacy read`).toBe(true);
      expect(module.settingsSchema.safeParse(settings).success, `${id} new write`).toBe(false);
    }
  });

  it("resolves missing nested and variant switches once for a draft", () => {
    const settings = settingsFor("duel");
    const texts = objectAt(settings, "texts");
    texts.challengeOpen = "Legacy challenge";
    texts.challengeOpenEnabled = undefined;
    texts.fightVariants = ["Legacy fight", ""];
    texts.fightVariantsEnabled = undefined;
    const errors = objectAt(texts, "errors");
    errors.notEnoughPoints = "";
    errors.notEnoughPointsEnabled = undefined;

    const resolved = resolveMessageEnabledFlags(settings, [
      { messagePath: "texts.challengeOpen", enabledPath: "texts.challengeOpenEnabled" },
      { messagePath: "texts.fightVariants", enabledPath: "texts.fightVariantsEnabled" },
      { messagePath: "texts.errors.notEnoughPoints", enabledPath: "texts.errors.notEnoughPointsEnabled" },
    ]);
    const resolvedTexts = objectAt(resolved, "texts");
    expect(resolvedTexts.challengeOpenEnabled).toBe(true);
    expect(resolvedTexts.fightVariantsEnabled).toEqual([true, false]);
    expect(objectAt(resolvedTexts, "errors").notEnoughPointsEnabled).toBe(false);
  });

  it("keeps the stored chat voting result switch through a read and write of an unrelated field", () => {
    const stored = { ...settingsFor("chat_voting"), announceResult: true, resultText: "" };
    const read = chatVotingSettingsReadSchema.parse(stored);
    expect(read.announceResult).toBe(true);

    // Blank text with the switch on is reported on the next save instead of flipping the switch.
    const blankWrite = chatVotingSettingsSchema.safeParse({ ...read, autoCloseSeconds: 300 });
    expect(blankWrite.success).toBe(false);

    const fixedWrite = chatVotingSettingsSchema.parse({ ...read, autoCloseSeconds: 300, resultText: "{vote.result}" });
    expect(fixedWrite.announceResult).toBe(true);
  });
});
