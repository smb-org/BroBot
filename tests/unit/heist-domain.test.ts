import { describe, expect, it } from "vitest";
import { parseHeistCommand } from "../../src/modules/heist/domain/command";
import { resolveHeist } from "../../src/modules/heist/domain/settlement";
import { heistSettingsForLanguage, heistSettingsReadSchema, heistSettingsSchema } from "../../src/modules/heist/contracts";

describe("heist command", () => {
  it("requires one whole-number stake within the configured bounds", () => {
    const settings = { command: "!heist", minStake: 10, maxStake: 100 };

    expect(parseHeistCommand("!heist 25", settings)).toEqual({ ok: true, stake: 25 });
    expect(parseHeistCommand("!heist", settings)).toEqual({ ok: false, reason: "invalid_stake" });
    expect(parseHeistCommand("!heist 25 extra", settings)).toEqual({ ok: false, reason: "invalid_stake" });
    expect(parseHeistCommand("!heist 9", settings)).toEqual({ ok: false, reason: "out_of_range" });
  });
});

describe("heist settings", () => {
  it("defaults to a 60-second round, bounded stakes, and the owner chance rules", () => {
    const settings = heistSettingsForLanguage("en");

    expect(settings).toMatchObject({
      joinWindowSeconds: 60,
      minStake: 10,
      maxStake: 1_000,
      cooldownSeconds: 30,
      baseChance: 50,
      maxChance: 65,
      startTextEnabled: true,
      resultTextEnabled: true,
    });
    expect(heistSettingsSchema.safeParse(settings).success).toBe(true);
  });

  it("reads settings written before message switches and chance overrides existed", () => {
    const settings = heistSettingsForLanguage("en");
    const legacy = { ...settings } as Record<string, unknown>;
    delete legacy.startTextEnabled;
    delete legacy.resultTextEnabled;
    delete legacy.baseChance;
    delete legacy.maxChance;

    const parsed = heistSettingsReadSchema.parse(legacy);
    expect(parsed).toMatchObject({ baseChance: 50, maxChance: 65 });
    expect(parsed.startTextEnabled).toBeUndefined();
    expect(parsed.resultTextEnabled).toBeUndefined();
  });

  it("rejects inverted stake bounds, a cap below the base chance, and enabled empty messages", () => {
    const settings = heistSettingsForLanguage("en");

    expect(heistSettingsSchema.safeParse({ ...settings, minStake: 101, maxStake: 100 }).success).toBe(false);
    expect(heistSettingsSchema.safeParse({ ...settings, baseChance: 60, maxChance: 59 }).success).toBe(false);
    expect(heistSettingsSchema.safeParse({ ...settings, resultText: "", resultTextEnabled: true }).success).toBe(false);
  });
});

describe("heist settlement", () => {
  it("adds two percentage points per additional participant and caps the shared chance", () => {
    const participants = Array.from({ length: 10 }, (_, index) => ({
      accountId: `viewer_${String(index)}`,
      login: `fictional_${String(index)}`,
      stake: 10,
    }));
    const rolls = [0.649, 0.65, ...Array.from({ length: 8 }, () => 0.99)];
    let rollIndex = 0;

    const result = resolveHeist("fictional_round", participants, { baseChance: 50, maxChance: 65 }, () => {
      const roll = rolls[rollIndex] ?? 0.99;
      rollIndex += 1;
      return roll;
    });

    expect(result.chancePercent).toBe(65);
    expect(result.result.winners.map(({ login }) => login)).toEqual(["fictional_0"]);
    expect(result.result.losers).toHaveLength(9);
  });

  it("pays each winner twice their own stake and transfers the remaining escrow to the house", () => {
    const participants = [
      { accountId: "viewer_anna", login: "frostfern", stake: 10 },
      { accountId: "viewer_ben", login: "moonmoss", stake: 20 },
      { accountId: "viewer_cara", login: "starling", stake: 30 },
    ];
    const rolls = [0.53, 0.54, 0.9];
    let rollIndex = 0;

    const result = resolveHeist("fictional_round", participants, { baseChance: 50, maxChance: 65 }, () => {
      const roll = rolls[rollIndex] ?? 0.99;
      rollIndex += 1;
      return roll;
    });

    expect(result.chancePercent).toBe(54);
    expect(result.movements).toEqual([
      { accountId: "__escrow:fictional_round", delta: -60 },
      { accountId: "viewer_anna", delta: 20, login: "frostfern" },
      { accountId: "__house", delta: 40 },
    ]);
    expect(result.movements.reduce((total, movement) => total + movement.delta, 0)).toBe(0);
    expect(result.result.winners).toEqual([{ accountId: "viewer_anna", login: "frostfern", stake: 10, payout: 20 }]);
    expect(result.result.losers.map(({ login, stake }) => ({ login, stake }))).toEqual([
      { login: "moonmoss", stake: 20 },
      { login: "starling", stake: 30 },
    ]);
  });

  it("uses a stable non-identifying round id for a repeated start message", async () => {
    const { heistRoundIdForMessage } = await import("../../src/modules/heist/domain/round-id");

    const first = await heistRoundIdForMessage("fictional-eventsub-message");

    expect(await heistRoundIdForMessage("fictional-eventsub-message")).toBe(first);
    expect(first).toMatch(/^heist-[a-f0-9]{40}$/u);
    expect(first).not.toContain("fictional-eventsub-message");
  });
});
