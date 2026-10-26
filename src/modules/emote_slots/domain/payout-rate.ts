import { emoteSlotSettingsSchema, type EmoteSlotSettings } from "../contracts";

type SettingsParser = Pick<typeof emoteSlotSettingsSchema, "safeParse">;

interface ExactRate {
  numerator: bigint;
  denominator: bigint;
}

type SlotPayoutRateStatus = "target" | "warning" | "locked";

const greatestCommonDivisor = (left: bigint, right: bigint): bigint => {
  let a = left < 0n ? -left : left;
  let b = right < 0n ? -right : right;
  while (b !== 0n) [a, b] = [b, a % b];
  return a === 0n ? 1n : a;
};

const exactRate = (numerator: bigint, denominator: bigint): ExactRate => {
  const divisor = greatestCommonDivisor(numerator, denominator);
  return { numerator: numerator / divisor, denominator: denominator / divisor };
};

const compareRates = (left: ExactRate, right: ExactRate): number => {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
};

export interface SlotPayoutRate {
  fixed: ExactRate;
  total: ExactRate;
  value: number;
  allowed: boolean;
  status: SlotPayoutRateStatus;
}

/**
 * Calculates expected payout using integer fractions, including jackpot share and seed.
 * The result is an upper bound across all permitted stakes (stake >= minStake): pair payout and
 * jackpot share use unrounded basis points, the seed is divided by minStake (its largest
 * per-point weight). Settlement rounding down can only pay less than this rate.
 */
export const calculateSlotPayoutRate = (settings: Pick<EmoteSlotSettings,
  "symbols" | "minStake" | "jackpotSeed" | "jackpotShareBp" | "pairPayoutBp">): SlotPayoutRate => {
  const weights = settings.symbols.map(({ weight }) => BigInt(weight));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0n);
  const weightCubed = totalWeight ** 3n;
  const jackpotIndex = settings.symbols.findIndex(({ isJackpot }) => isJackpot);
  const jackpotWeight = weights[jackpotIndex] ?? 0n;
  const tripleNumerator = settings.symbols.reduce((sum, symbol, index) => {
    const weight = weights[index] ?? 0n;
    const triple = symbol.isJackpot ? 0n : BigInt(symbol.triple);
    return sum + weight ** 3n * triple;
  }, 0n);
  const minimumStake = BigInt(settings.minStake);
  const pairOutcomes = weights.reduce((sum, weight) => sum + 3n * weight ** 2n * (totalWeight - weight), 0n);
  // Common denominator: weightCubed * minStake * 10_000. Pair and share use unrounded basis points.
  const denominator = weightCubed * minimumStake * 10_000n;
  const fixedNumerator = tripleNumerator * minimumStake * 10_000n + pairOutcomes * minimumStake * BigInt(settings.pairPayoutBp);
  const fixed = exactRate(fixedNumerator, denominator);
  const shareNumerator = BigInt(settings.jackpotShareBp) * minimumStake * weightCubed;
  const seedNumerator = BigInt(settings.jackpotSeed) * jackpotWeight ** 3n * 10_000n;
  const total = exactRate(fixedNumerator + shareNumerator + seedNumerator, denominator);
  const one = { numerator: 1n, denominator: 1n };
  const eightyFivePercent = { numerator: 85n, denominator: 100n };
  const ninetyFivePercent = { numerator: 95n, denominator: 100n };
  const isLocked = compareRates(total, one) >= 0;
  const isInTarget = compareRates(total, eightyFivePercent) >= 0 && compareRates(total, ninetyFivePercent) <= 0;
  return {
    fixed,
    total,
    value: Number(total.numerator) / Number(total.denominator),
    allowed: !isLocked,
    status: isLocked ? "locked" : isInTarget ? "target" : "warning",
  };
};

/** Calculates the rate only when the complete draft satisfies the settings schema. */
/** The payout maths ignores message texts; the editor passes the read schema so an empty message keeps the quote. */
export const calculateSlotPayoutRateForDraft = (draft: unknown, schema: SettingsParser = emoteSlotSettingsSchema): SlotPayoutRate | null => {
  const parsed = schema.safeParse(draft);
  return parsed.success ? calculateSlotPayoutRate(parsed.data) : null;
};

export const formatSlotPayoutRate = (rate: SlotPayoutRate, language: "de" | "en"): string =>
  new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(rate.value * 100) + " %";
