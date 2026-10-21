import { describe, expect, it } from "vitest";
import { POINT_SETTLEMENTS } from "../../src/worker/durable/point-settlements";

const blitz = POINT_SETTLEMENTS.get("blitz");

describe("blitz points settlement", () => {
  it("splits the prize evenly and leaves the remainder in the house [protects=only whole equal shares leave the house; fails_when=the split loses a point or movements are not zero-sum; no_claim=does not exercise the Durable Object ledger]", () => {
    expect(blitz).toBeDefined();
    const result = blitz?.({
      round: { roundId: "fictional-round", moduleId: "blitz_round", data: { answer: "CLOUD" } },
      participants: [
        { accountId: "viewer_one", login: "frostfern", stake: 0, data: {} },
        { accountId: "viewer_two", login: "moonmoss", stake: 0, data: {} },
        { accountId: "viewer_three", login: "pixelpilz", stake: 0, data: {} },
      ],
      pots: {},
      params: { prize: 50 },
    });

    expect(result?.result).toEqual({
      answer: "CLOUD",
      winners: [
        { accountId: "viewer_one", login: "frostfern" },
        { accountId: "viewer_two", login: "moonmoss" },
        { accountId: "viewer_three", login: "pixelpilz" },
      ],
      share: 16,
    });
    expect(result?.movements).toEqual([
      { accountId: "__house", delta: -48 },
      { accountId: "viewer_one", delta: 16, login: "frostfern" },
      { accountId: "viewer_two", delta: 16, login: "moonmoss" },
      { accountId: "viewer_three", delta: 16, login: "pixelpilz" },
    ]);
    expect(result?.movements.reduce((sum, movement) => sum + ("delta" in movement ? movement.delta : 0), 0)).toBe(0);
  });

  it("resolves an empty round with no ledger movements [protects=no-answer rounds settle without creating a payout; fails_when=an empty winner set charges the house or emits a movement; no_claim=does not verify timeout copy delivery]", () => {
    expect(blitz).toBeDefined();
    expect(blitz?.({
      round: { roundId: "fictional-empty-round", moduleId: "blitz_round", data: { answer: "LANTERN" } },
      participants: [],
      pots: {},
      params: { prize: 50 },
    })).toEqual({
      movements: [],
      result: { answer: "LANTERN", winners: [], share: 0 },
    });
  });
});
