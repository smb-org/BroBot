import { describe, expect, it } from "vitest";
import { bossHealth, calculateBossPayouts, rollBossDamage } from "../../src/modules/boss_fight/domain/boss";

describe("boss fight damage rules", () => {
  it("maps equal random intervals to every integer in the configured range", () => {
    const randomValues = [0, 0.2, 0.4, 0.6, 0.8];
    expect(randomValues.map((value) => rollBossDamage(20, 24, () => value))).toEqual([20, 21, 22, 23, 24]);
    expect(rollBossDamage(20, 24, () => 0.999999)).toBe(24);
  });

  it("adds health for each distinct attacker and never sets total health below damage dealt", () => {
    expect(bossHealth({ baseHp: 300, hpPerAttacker: 80, attackers: 2, damageDealt: 100 })).toEqual({
      maxHp: 460,
      currentHp: 360,
      defeated: false,
    });
    expect(bossHealth({ baseHp: 300, hpPerAttacker: 80, attackers: 2, damageDealt: 500 })).toEqual({
      maxHp: 500,
      currentHp: 0,
      defeated: true,
    });
  });

  it("splits loot in proportion to damage and leaves floor remainders with the house", () => {
    expect(calculateBossPayouts(101, [
      { accountId: "viewer_one", login: "frostfern", damage: 20 },
      { accountId: "viewer_two", login: "moonmoss", damage: 30 },
      { accountId: "viewer_three", login: "pixelpilz", damage: 50 },
    ])).toEqual({
      totalDamage: 100,
      distributed: 100,
      payouts: [
        { accountId: "viewer_one", login: "frostfern", damage: 20, amount: 20 },
        { accountId: "viewer_two", login: "moonmoss", damage: 30, amount: 30 },
        { accountId: "viewer_three", login: "pixelpilz", damage: 50, amount: 50 },
      ],
    });
  });

  it("rejects invalid random values and damage inputs", () => {
    expect(() => rollBossDamage(0, 10, () => 0.5)).toThrow("invalid_boss_damage_range");
    expect(() => rollBossDamage(1, 10, () => 1)).toThrow("invalid_random_value");
    expect(() => bossHealth({ baseHp: 300, hpPerAttacker: 80, attackers: -1, damageDealt: 0 })).toThrow("invalid_boss_health");
  });
});
