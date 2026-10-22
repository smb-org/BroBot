import { afterEach, describe, expect, it, vi } from "vitest";
import { POINT_SETTLEMENTS } from "../../src/worker/durable/point-settlements";

const duel = POINT_SETTLEMENTS.get("duel");

const withRandomByte = <T>(value: number, run: () => T): T => {
  const random = vi.spyOn(crypto, "getRandomValues").mockImplementation(((bytes: Uint8Array) => {
    bytes[0] = value;
    return bytes;
  }) as typeof crypto.getRandomValues);
  try { return run(); } finally { random.mockRestore(); }
};

afterEach(() => { vi.restoreAllMocks(); });

describe("duel point settlement", () => {
  it("pays the full two-player pot to exactly one human winner [protects=accept resolution debits the escrow and pays a single participant; fails_when=the pot is split, lost, or exceeds its two stakes; no_claim=the DO transaction and monthly net accounting are verified by worker tests]", () => {
    expect(duel).toBeDefined();
    const result = withRandomByte(0, () => duel?.({
      round: { roundId: "duel-round", moduleId: "duel", data: { challengerId: "viewer_anna", challengerLogin: "frostfern", targetId: null, stake: 100, botEnabled: true } },
      participants: [
        { accountId: "viewer_anna", login: "frostfern", stake: 100, data: {} },
        { accountId: "viewer_ben", login: "moonmoss", stake: 100, data: {} },
      ],
      pots: { "__escrow:duel-round": 200 },
      params: { mode: "accept" },
    }));
    expect(result?.movements).toEqual([
      { accountId: "__escrow:duel-round", delta: -200 },
      { accountId: "viewer_anna", delta: 200, login: "frostfern" },
    ]);
    expect(result?.result).toMatchObject({ winner: "viewer_anna", winnerLogin: "frostfern", loserLogin: "moonmoss", net: 100, bot: false });
  });

  it("books the fixed bot stake and a 50 percent winner [protects=an open challenge transfers one stake between the human and house with a two-stake payout; fails_when=the house is not charged on a human win or the bot profit is not zero-sum; no_claim=long-run aggregate balance invariants are covered by worker tests]", () => {
    expect(duel).toBeDefined();
    const humanWins = withRandomByte(1, () => duel?.({
      round: { roundId: "duel-bot", moduleId: "duel", data: { challengerId: "viewer_anna", challengerLogin: "frostfern", targetId: null, stake: 100, botEnabled: true } },
      participants: [{ accountId: "viewer_anna", login: "frostfern", stake: 100, data: {} }],
      pots: { "__escrow:duel-bot": 100 },
      params: { mode: "expire" },
    }));
    expect(humanWins?.movements).toEqual([
      { accountId: "__escrow:duel-bot", delta: -100 },
      { accountId: "__house", delta: -100 },
      { accountId: "viewer_anna", delta: 200, login: "frostfern" },
    ]);
    expect(humanWins?.result).toMatchObject({ winner: "viewer_anna", net: 100, bot: true });
    expect(humanWins?.movements.reduce((sum, item) => sum + ("delta" in item ? item.delta : 0), 0)).toBe(0);
  });

  it("returns an unaccepted targeted or bot-disabled stake [protects=expiry without bot play refunds the challenger exactly; fails_when=expiry books a winner or leaves the escrow funded; no_claim=the alarm timing and silent formatter path are covered by worker tests]", () => {
    expect(duel?.({
      round: { roundId: "duel-refund", moduleId: "duel", data: { challengerId: "viewer_anna", challengerLogin: "frostfern", targetId: "viewer_ben", stake: 100, botEnabled: true } },
      participants: [{ accountId: "viewer_anna", login: "frostfern", stake: 100, data: {} }],
      pots: { "__escrow:duel-refund": 100 },
      params: { mode: "expire" },
    })).toEqual({
      movements: [
        { accountId: "__escrow:duel-refund", delta: -100 },
        { accountId: "viewer_anna", delta: 100, login: "frostfern" },
      ],
      result: { expired: true },
    });
  });

  it("rejects invalid settlement parameters [protects=only accept and expire modes can move duel points; fails_when=malformed or unknown modes reach ledger movements; no_claim=callers validate persisted round data before the settlement boundary]", () => {
    expect(() => duel?.({
      round: { roundId: "duel-invalid", moduleId: "duel", data: { challengerId: "viewer_anna", challengerLogin: "frostfern", targetId: null, stake: 100, botEnabled: true } },
      participants: [{ accountId: "viewer_anna", login: "frostfern", stake: 100, data: {} }],
      pots: {},
      params: { mode: "unknown" },
    })).toThrow("invalid_settlement_params");
  });
});
