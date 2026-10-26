import { describe, expect, it } from "vitest";

import { DEFAULT_EMOTE_SLOT_SETTINGS, emoteSlotSettingsReadSchema, emoteSlotSettingsSchema } from "../../src/modules/emote_slots/contracts";
import { calculateSlotPayoutRate } from "../../src/modules/emote_slots/domain/payout-rate";
import { formatSlotReply, parseSlotStake } from "../../src/modules/emote_slots/domain/chat";
import { settleSlot } from "../../src/modules/emote_slots/domain/settlement";
import { emoteSlotsCatalog } from "../../src/modules/emote_slots/locale";
import { emoteSlotsModule } from "../../src/modules/emote_slots";

const settlementInput = (overrides: Partial<{
  balance: number;
  jackpot: number;
  stake: number;
  pairPayoutBp: number;
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
      pairPayoutBp: overrides.pairPayoutBp ?? DEFAULT_EMOTE_SLOT_SETTINGS.pairPayoutBp,
      jackpotShareBp: 700,
      maxStake: 500,
      seed: overrides.seed ?? 500,
    },
  };
};

describe("emote slot settlement", () => {
  it.each([[15, 22], [19, 28]])("pays the floored pair multiplier at stake %i (protects=pair payouts floor to whole points for small stakes; fails_when=a pair refunds the stake or rounds up; no_claim=concurrent ledger serialization)", (stake, payout) => {
    const result = settleSlot(settlementInput({ stake, symbols: [0, 0, 4] }));

    expect(result.result).toMatchObject({ pair: true, triple: false, payout, net: payout - stake, balanceAfter: 200 + payout - stake, jackpotAfter: 1_001 });
    expect(result.movements).toContainEqual({ accountId: "viewer_demo", delta: payout - stake, login: "nachtfalke" });
    expect(result.movements).toContainEqual({ accountId: "__jackpot:emote_slots", delta: 1 });
    expect(result.movements).toContainEqual({ accountId: "__house", delta: stake - 1 - payout });
  });

  it("pays a pair containing the jackpot symbol at the configured pair rate (protects=jackpot symbol pairs keep pair semantics; fails_when=a pair involving seven is treated as a jackpot or only refunds; no_claim=three sevens jackpot award)", () => {
    const result = settleSlot(settlementInput({ stake: 15, symbols: [5, 5, 0] }));

    expect(result.result).toMatchObject({ pair: true, triple: false, payout: 22, net: 7 });
  });

  it("keeps exact stake return when pair payout is one times (protects=legacy refund amount at 10,000 basis points; fails_when=the pair payout changes at 1×; no_claim=pair chat wording)", () => {
    const result = settleSlot(settlementInput({ stake: 15, pairPayoutBp: 10_000, symbols: [0, 0, 4] }));

    expect(result.result).toMatchObject({ pair: true, payout: 15, net: 0, balanceAfter: 200 });
  });

  it("pays stake times the configured non-jackpot triple (protects=the configured triple multiplier; fails_when=a triple pays only the stake or is reduced by the wager; no_claim=message formatting)", () => {
    const result = settleSlot(settlementInput({ symbols: [2, 2, 2] }));

    expect(result.result).toMatchObject({ triple: true, pair: false, net: 200, balanceAfter: 400 });
    expect(result.movements).toContainEqual({ accountId: "__house", delta: -203 });
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
  it("includes the floored pair payout and jackpot terms as exact fractions (protects=pair, share, and seed calculations at minimum stake; fails_when=the pair payout is treated as a float or ignores point flooring; no_claim=display rounding)", () => {
    const rate = calculateSlotPayoutRate(DEFAULT_EMOTE_SLOT_SETTINGS);

    expect(rate.fixed).toEqual({ numerator: 17_051n, denominator: 20_480n });
    expect(rate.total).toEqual({ numerator: 18_583n, denominator: 20_480n });
    expect(rate.allowed).toBe(true);
  });

  it("calculates pair payouts with integer fractions for a small table (protects=pair payout floors at minStake before rate calculation; fails_when=the rate assumes fractional points; no_claim=other stake sizes)", () => {
    const table = {
      ...DEFAULT_EMOTE_SLOT_SETTINGS,
      minStake: 3,
      jackpotSeed: 0,
      jackpotShareBp: 0,
      pairPayoutBp: 15_000,
      symbols: DEFAULT_EMOTE_SLOT_SETTINGS.symbols.map((symbol) => ({ ...symbol, weight: 1, triple: 2 })),
    };

    expect(calculateSlotPayoutRate(table).fixed).toEqual({ numerator: 65n, denominator: 108n });
    expect(calculateSlotPayoutRate(table).total).toEqual({ numerator: 65n, denominator: 108n });
  });

  it("keeps the default rate in the 85–95 percent target band (protects=the rebalance supports a 1.5× pair payout; fails_when=the published default table drifts outside target; no_claim=existing channel tables)", () => {
    const rate = calculateSlotPayoutRate(DEFAULT_EMOTE_SLOT_SETTINGS);

    expect(rate.status).toBe("target");
    expect(rate.value).toBeGreaterThanOrEqual(0.85);
    expect(rate.value).toBeLessThanOrEqual(0.95);
  });

  it("keeps the pre-change default table playable at the refund multiplier and locked at 1.5× (protects=saved tables balanced for refunds are read at 1× instead of jumping past 100 percent; fails_when=a legacy table without a stored pair payout reads at 1.5× or its 1× rate drifts; no_claim=other legacy tables)", () => {
    const legacyTriples = [7, 7, 12, 20, 20, 2];
    const legacy = {
      ...DEFAULT_EMOTE_SLOT_SETTINGS,
      symbols: DEFAULT_EMOTE_SLOT_SETTINGS.symbols.map((symbol, index) => ({ ...symbol, triple: legacyTriples[index] ?? 2 })),
    };
    Reflect.deleteProperty(legacy, "pairPayoutBp");
    const read = emoteSlotSettingsReadSchema.parse(legacy);

    expect(read.pairPayoutBp).toBe(10_000);
    expect(calculateSlotPayoutRate(read).total).toEqual({ numerator: 4_663n, denominator: 5_120n });
    expect(calculateSlotPayoutRate(read).status).toBe("target");
    const atOneAndAHalf = calculateSlotPayoutRate({ ...read, pairPayoutBp: 15_000 });
    expect(atOneAndAHalf.total).toEqual({ numerator: 2_881n, denominator: 2_560n });
    expect(atOneAndAHalf.status).toBe("locked");
  });

  it("marks a rate at one hundred percent as locked (protects=the exact server/client save threshold; fails_when=a rate equal to one remains allowed; no_claim=the rendered lock reason)", () => {
    const settings = {
      ...DEFAULT_EMOTE_SLOT_SETTINGS,
      symbols: DEFAULT_EMOTE_SLOT_SETTINGS.symbols.map((symbol, index) => index === 0 ? { ...symbol, triple: 500 } : symbol),
    };

    expect(calculateSlotPayoutRate(settings).allowed).toBe(false);
    expect(emoteSlotsModule.validateSettings?.(settings)).toBe("payout_rate_too_high");
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

  it("defaults a missing pair payout only when reading saved settings and enforces its write range (protects=old channels load at the refund multiplier and writes require an explicit valid basis-point setting; fails_when=legacy settings fail to load, load at 1.5×, or strict writes silently omit the setting; no_claim=server rate validation)", () => {
    const oldSettings = { ...DEFAULT_EMOTE_SLOT_SETTINGS };
    Reflect.deleteProperty(oldSettings, "pairPayoutBp");

    expect(emoteSlotSettingsReadSchema.safeParse(oldSettings)).toMatchObject({ success: true, data: { pairPayoutBp: 10_000 } });
    expect(emoteSlotSettingsSchema.safeParse(oldSettings).success).toBe(false);
    expect(emoteSlotSettingsSchema.safeParse({ ...DEFAULT_EMOTE_SLOT_SETTINGS, pairPayoutBp: 9_999 }).success).toBe(false);
    expect(emoteSlotSettingsSchema.safeParse({ ...DEFAULT_EMOTE_SLOT_SETTINGS, pairPayoutBp: 15_000.5 }).success).toBe(false);
    expect(emoteSlotSettingsSchema.safeParse({ ...DEFAULT_EMOTE_SLOT_SETTINGS, pairPayoutBp: 30_001 }).success).toBe(false);
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
      .replace("{slot.net}", "+25")
      .replace("{slot.balance}", "225")
      .replace("{slot.jackpot}", "1.003");
    expect(formatSlotReply(result.result, table, "de", "nachtfalke", "pair")).toBe(dePair);
    expect(formatSlotReply(result.result, table, "en", "nachtfalke", "pair"))
      .toBe("🍒 | 🍒 | 💎  +25 · Balance 225 · Jackpot 1,003");
    expect(formatSlotReply(result.result, table, "en", "nachtfalke", "pair", emoteSlotsCatalog.en.chat.pairRefund, 15_000))
      .toBe("🍒 | 🍒 | 💎  +25 · Balance 225 · Jackpot 1,003");
    expect(formatSlotReply(result.result, table, "en", "nachtfalke", "pair", undefined, 10_000))
      .toBe("🍒 | 🍒 | 💎  Stake back · +25 · Balance 225 · Jackpot 1,003");
  });
});
