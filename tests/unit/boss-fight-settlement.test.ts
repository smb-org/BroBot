import { describe, expect, it } from "vitest";
import { POINT_SETTLEMENTS } from "../../src/worker/durable/point-settlements";

const bossFight = POINT_SETTLEMENTS.get("boss_fight");

describe("boss fight point settlement", () => {
  it("pays proportional whole point shares from the house when defeated", () => {
    expect(bossFight).toBeDefined();
    const result = bossFight?.({
      round: {
        roundId: "boss-round",
        moduleId: "boss_fight",
        data: { defeated: true, lootPool: 101, damageDealt: 100, attackerCount: 3 },
      },
      participants: [
        { accountId: "viewer_one", login: "frostfern", stake: 0, data: { damage: 20 } },
        { accountId: "viewer_two", login: "moonmoss", stake: 0, data: { damage: 30 } },
        { accountId: "viewer_three", login: "pixelpilz", stake: 0, data: { damage: 50 } },
      ],
      pots: {},
      params: {},
    });
    expect(result?.movements).toEqual([
      { accountId: "__house", delta: -100 },
      { accountId: "viewer_one", delta: 20, login: "frostfern" },
      { accountId: "viewer_two", delta: 30, login: "moonmoss" },
      { accountId: "viewer_three", delta: 50, login: "pixelpilz" },
    ]);
    expect(result?.movements.reduce((total, movement) => total + ("delta" in movement ? movement.delta : 0), 0)).toBe(0);
    expect(result?.result).toMatchObject({ defeated: true, lootPool: 101, distributed: 100, houseRemainder: 1 });
    expect(result?.result).toMatchObject({
      topDamageDealers: [
        { login: "pixelpilz", damage: 50, amount: 50 },
        { login: "moonmoss", damage: 30, amount: 30 },
        { login: "frostfern", damage: 20, amount: 20 },
      ],
      otherCount: 0,
    });
  });

  it("does not pay anyone when the boss survives the window", () => {
    expect(bossFight?.({
      round: { roundId: "boss-timeout", moduleId: "boss_fight", data: { defeated: false, lootPool: 500, damageDealt: 120, attackerCount: 1 } },
      participants: [{ accountId: "viewer_one", login: "frostfern", stake: 0, data: { damage: 120 } }],
      pots: {},
      params: {},
    })).toMatchObject({ movements: [], result: { defeated: false, distributed: 0 } });
  });

  it("rejects a payout whose participants do not match recorded damage", () => {
    expect(() => bossFight?.({
      round: { roundId: "boss-invalid", moduleId: "boss_fight", data: { defeated: true, lootPool: 100, damageDealt: 100 } },
      participants: [{ accountId: "viewer_one", login: "frostfern", stake: 0, data: { damage: 99 } }],
      pots: {},
      params: {},
    })).toThrow("invalid_settlement_params");
  });
});
