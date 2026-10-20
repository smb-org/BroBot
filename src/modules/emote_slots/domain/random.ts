import type { EmoteSlotSettings } from "../contracts";

const UINT32_RANGE = 2 ** 32;

const weightedSymbolIndex = (weights: readonly number[], nextRandom: () => number): number => {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (weights.length === 0 || weights.some((weight) => !Number.isSafeInteger(weight) || weight < 1) ||
      !Number.isSafeInteger(total) || total > UINT32_RANGE) throw new Error("invalid_symbol_weights");
  const limit = Math.floor(UINT32_RANGE / total) * total;
  let draw: number;
  do {
    draw = nextRandom();
    if (!Number.isSafeInteger(draw) || draw < 0 || draw >= UINT32_RANGE) throw new Error("invalid_random_value");
  } while (draw >= limit);
  let cursor = draw % total;
  for (let index = 0; index < weights.length; index += 1) {
    cursor -= weights[index] ?? 0;
    if (cursor < 0) return index;
  }
  throw new Error("invalid_symbol_weights");
};

const secureRandomUint32 = (): number => {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return value[0] ?? 0;
};

export const drawSlotSymbols = (settings: Pick<EmoteSlotSettings, "symbols">): [number, number, number] => {
  const weights = settings.symbols.map(({ weight }) => weight);
  return [
    weightedSymbolIndex(weights, secureRandomUint32),
    weightedSymbolIndex(weights, secureRandomUint32),
    weightedSymbolIndex(weights, secureRandomUint32),
  ];
};
