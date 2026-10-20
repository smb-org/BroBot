import { describe, expect, it } from "vitest";

import { DEFAULT_EMOTE_SLOT_SETTINGS, emoteSlotSettingsSchema } from "../../src/modules/emote_slots/contracts";
import { calculateSlotPayoutRate } from "../../src/modules/emote_slots/domain/payout-rate";
import { formatSlotReply, parseSlotStake } from "../../src/modules/emote_slots/domain/chat";
import { settleSlot } from "../../src/modules/emote_slots/domain/settlement";
import { emoteSlotsCatalog } from "../../src/modules/emote_slots/locale";

const settlementInput = (overrides: Partial<{
  balance: number;
  jackpot: number;
  stake: number;
  symbols: [number, number, number];
  seed: number;
}> = {}) => {
  const stake = overrides.stake ?? 50;
  return {
    actor: { accountId: "viewer_demo", login: "nachtfalke" },
    balance: overrides.balance ?? 200,
    stake,
    pots: { "__jackpot:emote_slots": overrides.jackpot ?? 1_000 },
    params: {
      stake,
      symbols: overrides.symbols ?? [0, 0, 4],
      table: { symbols: DEFAULT_EMOTE_SLOT_SETTINGS.symbols },
      jackpotShareBp: 700,
      maxStake: 500,
      seed: overrides.seed ?? 500,
    },
  };
};

describe("emote slot settlement", () => {
  it("returns the stake for a pair and adds the rounded share (protects=pair payout and 15-point share rounding; fails_when=a pair loses the stake or rounds 7% of 15 to zero; no_claim=concurrent ledger serialization)", () => {
    const result = settleSlot(settlementInput({ stake: 15, symbols: [0, 0, 4] }));

    expect(result.result).toMatchObject({ pair: true, triple: false, net: 0, balanceAfter: 200, jackpotAfter: 1_001 });
    expect(result.movements).toEqual([
      { accountId: "viewer_demo", delta: 0, login: "nachtfalke" },
      { accountId: "__jackpot:emote_slots", delta: 1 },
      { accountId: "__house", delta: -1 },
    ]);
  });

  it("pays stake times the configured non-jackpot triple (protects=the configured triple multiplier; fails_when=a triple pays only the stake or is reduced by the wager; no_claim=message formatting)", () => {
    const result = settleSlot(settlementInput({ symbols: [2, 2, 2] }));

    expect(result.result).toMatchObject({ triple: true, pair: false, net: 550, balanceAfter: 750 });
    expect(result.movements).toContainEqual({ accountId: "__house", delta: -553 });
  });

  it("charges the full stake for a loss (protects=loss net and player balance; fails_when=a losing spin leaves the balance unchanged; no_claim=chat delivery)", () => {
    const result = settleSlot(settlementInput({ symbols: [0, 1, 2] }));

    expect(result.result).toMatchObject({ net: -50, balanceAfter: 150, jackpotAfter: 1_003 });
    expect(result.movements).toContainEqual({ accountId: "viewer_demo", delta: -50, login: "nachtfalke" });
  });

  it("scales a jackpot by the current pot including this spin share (protects=stake/maxStake jackpot payout and share inclusion; fails_when=the result uses the pre-share pot or assumes a full-pot win; no_claim=jackpot announcement text)", () => {
    const result = settleSlot(settlementInput({ symbols: [5, 5, 5], stake: 250, jackpot: 1_000 }));

    expect(result.result).toMatchObject({ jackpotWin: 508, net: 258, balanceAfter: 458, jackpotAfter: 1_009 });
  });

  it("pre-seeds an empty jackpot before the share and post-seeds after a jackpot win (protects=empty-pot seed order and final pot; fails_when=the seed is omitted, counted after the share, or paid twice; no_claim=initial seed funding policy outside spins)", () => {
    const result = settleSlot(settlementInput({ symbols: [5, 5, 5], stake: 500, jackpot: 0 }));

    expect(result.result).toMatchObject({ jackpotWin: 535, net: 35, jackpotAfter: 500 });
    expect(result.movements).toEqual([
      { accountId: "viewer_demo", delta: 35, login: "nachtfalke" },
      { accountId: "__jackpot:emote_slots", delta: 500 },
      { accountId: "__house", delta: -535 },
    ]);
  });

  it("does not seed when seed is zero (protects=seed zero disables pre-seed and post-seed; fails_when=an empty jackpot receives points from a zero seed; no_claim=house funding outside the slot)", () => {
    const result = settleSlot(settlementInput({ symbols: [5, 5, 5], stake: 500, jackpot: 0, seed: 0 }));

    expect(result.result).toMatchObject({ jackpotWin: 35, jackpotAfter: 0 });
    expect(result.movements).toContainEqual({ accountId: "__house", delta: 465 });
  });

  it("rejects unsafe jackpot intermediates before booking (protects=safe integer ledger movements; fails_when=jackpot share overflow is rounded, wrapped, or booked; no_claim=database balance limits)", () => {
    expect(() => settleSlot(settlementInput({ jackpot: Number.MAX_SAFE_INTEGER }))).toThrow("balance_overflow");
  });
});

describe("emote slot payout rate", () => {
  it("pins the default fixed return and complete rational rate (protects=exact default fractions 107/128 and 4663/5120; fails_when=the formula or seed/share terms drift; no_claim=rounding in the displayed percentage)", () => {
    const rate = calculateSlotPayoutRate(DEFAULT_EMOTE_SLOT_SETTINGS);

    expect(rate.fixed).toEqual({ numerator: 107n, denominator: 128n });
    expect(rate.total).toEqual({ numerator: 4_663n, denominator: 5_120n });
    expect(rate.allowed).toBe(true);
  });

  it("marks a rate at one hundred percent as locked (protects=the exact server/client save threshold; fails_when=a rate equal to one remains allowed; no_claim=the rendered lock reason)", () => {
    const settings = {
      ...DEFAULT_EMOTE_SLOT_SETTINGS,
      symbols: DEFAULT_EMOTE_SLOT_SETTINGS.symbols.map((symbol, index) => index === 0 ? { ...symbol, triple: 500 } : symbol),
    };

    expect(calculateSlotPayoutRate(settings).allowed).toBe(false);
  });
});

describe("emote slot settings", () => {
  it("accepts the six default rows and rejects duplicate symbols (protects=exactly six distinct reel identities and one jackpot; fails_when=a duplicate emoji or emote code is saved; no_claim=picker availability)", () => {
    expect(emoteSlotSettingsSchema.safeParse(DEFAULT_EMOTE_SLOT_SETTINGS).success).toBe(true);
    const duplicate = {
      ...DEFAULT_EMOTE_SLOT_SETTINGS,
      symbols: DEFAULT_EMOTE_SLOT_SETTINGS.symbols.map((symbol, index) => index === 1
        ? { ...symbol, source: "emoji" as const, code: "🍒" }
        : symbol),
    };
    expect(emoteSlotSettingsSchema.safeParse(duplicate).success).toBe(false);
  });

  it("rejects tables without exactly one jackpot row (protects=one jackpot row per reel table; fails_when=no jackpot or multiple jackpot rows pass validation; no_claim=jackpot payout calculation)", () => {
    const noJackpot = {
      ...DEFAULT_EMOTE_SLOT_SETTINGS,
      symbols: DEFAULT_EMOTE_SLOT_SETTINGS.symbols.map((symbol) => ({ ...symbol, isJackpot: false })),
    };
    const twoJackpots = {
      ...DEFAULT_EMOTE_SLOT_SETTINGS,
      symbols: DEFAULT_EMOTE_SLOT_SETTINGS.symbols.map((symbol, index) => index === 0 ? { ...symbol, isJackpot: true } : symbol),
    };

    expect(emoteSlotSettingsSchema.safeParse(noJackpot).success).toBe(false);
    expect(emoteSlotSettingsSchema.safeParse(twoJackpots).success).toBe(false);
  });

  it("enforces stake and multiplier bounds (protects=min/default/max order and documented limits; fails_when=unsafe or inverted values pass settings validation; no_claim=chat command parsing)", () => {
    expect(emoteSlotSettingsSchema.safeParse({ ...DEFAULT_EMOTE_SLOT_SETTINGS, minStake: 10_001 }).success).toBe(false);
    expect(emoteSlotSettingsSchema.safeParse({ ...DEFAULT_EMOTE_SLOT_SETTINGS, defaultStake: 501 }).success).toBe(false);
    expect(emoteSlotSettingsSchema.safeParse({ ...DEFAULT_EMOTE_SLOT_SETTINGS, maxStake: 0 }).success).toBe(false);
    expect(emoteSlotSettingsSchema.safeParse({ ...DEFAULT_EMOTE_SLOT_SETTINGS, minStake: 60, defaultStake: 50 }).success).toBe(false);
  });
});

describe("emote slot chat domain", () => {
  it("parses the default stake and one integer argument (protects=!slot and !slot n syntax; fails_when=valid stakes are parsed as errors or extra text is ignored; no_claim=balance and cooldown checks)", () => {
    expect(parseSlotStake("!slot", DEFAULT_EMOTE_SLOT_SETTINGS)).toEqual({ ok: true, stake: 50 });
    expect(parseSlotStake("!slot 15", DEFAULT_EMOTE_SLOT_SETTINGS)).toEqual({ ok: true, stake: 15 });
    expect(parseSlotStake("!slot 15 extra", DEFAULT_EMOTE_SLOT_SETTINGS)).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("rejects non-numeric and out-of-range stakes (protects=invalid, below-minimum, and above-maximum rejection; fails_when=invalid chat input reaches the ledger; no_claim=rate-limited error delivery)", () => {
    expect(parseSlotStake("!slot xyz", DEFAULT_EMOTE_SLOT_SETTINGS)).toMatchObject({ ok: false, reason: "invalid" });
    expect(parseSlotStake("!slot 14", DEFAULT_EMOTE_SLOT_SETTINGS)).toMatchObject({ ok: false, reason: "out_of_range" });
    expect(parseSlotStake("!slot 501", DEFAULT_EMOTE_SLOT_SETTINGS)).toMatchObject({ ok: false, reason: "out_of_range" });
  });

  it("formats pair, loss, and jackpot replies in both locales (protects=localized number formatting and signed net text; fails_when=the chat line disagrees with the stored balance or jackpot; no_claim=Twitch delivery outcome)", () => {
    const result = settleSlot(settlementInput({ symbols: [0, 0, 4], stake: 50 }));
    const table = DEFAULT_EMOTE_SLOT_SETTINGS.symbols;

    const dePair = emoteSlotsCatalog.de.chat.pair
      .replace("{slot.symbols}", "🍒 | 🍒 | 💎")
      .replace("{slot.net}", "±0")
      .replace("{slot.balance}", "200")
      .replace("{slot.jackpot}", "1.003");
    expect(formatSlotReply(result.result, table, "de", "nachtfalke", "pair")).toBe(dePair);
    expect(formatSlotReply(result.result, table, "en", "nachtfalke", "pair"))
      .toBe("🍒 | 🍒 | 💎  Stake back · ±0 · Balance 200 · Jackpot 1,003");
  });
});
