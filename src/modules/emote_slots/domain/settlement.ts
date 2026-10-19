import { z } from "zod";

import type { PointsMovement } from "../../contract";
import type { EmoteSlotSettings } from "../contracts";

const settlementParametersSchema = z.object({
  stake: z.number().int().positive(),
  symbols: z.tuple([z.number().int().min(0).max(5), z.number().int().min(0).max(5), z.number().int().min(0).max(5)]),
  table: z.object({
    symbols: z.array(z.object({
      id: z.string().min(1),
      weight: z.number().int().min(1).max(99),
      triple: z.number().int().min(2).max(500),
      isJackpot: z.boolean(),
    })).length(6),
  }),
  jackpotShareBp: z.number().int().min(0).max(2_000),
  maxStake: z.number().int().positive().max(100_000),
  seed: z.number().int().min(0).max(1_000_000),
}).superRefine((params, context) => {
  if (params.table.symbols.filter(({ isJackpot }) => isJackpot).length !== 1) {
    context.addIssue({ code: "custom", path: ["table", "symbols"], message: "exactly_one_jackpot_required" });
  }
});

export interface SlotSettlementInput {
  actor: { accountId: string; login: string };
  balance: number;
  stake: number;
  pots: Readonly<Record<string, number>>;
  params: unknown;
}

export interface SlotSettlementResult {
  kind: "slot";
  symbols: [number, number, number];
  stake: number;
  payout: number;
  net: number;
  balanceAfter: number;
  jackpotAfter: number;
  jackpotWin: number;
  triple: boolean;
  pair: boolean;
}

export interface SlotSettlementOutput {
  movements: PointsMovement[];
  result: SlotSettlementResult;
}

const assertSafeInteger = (value: bigint): bigint => {
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("balance_overflow");
  }
  return value;
};

const safeNumber = (value: bigint): number => {
  assertSafeInteger(value);
  return Number(value);
};

const safeInputInteger = (value: number): boolean => Number.isSafeInteger(value);

/** Pure settlement; all balance-dependent values are computed from the transaction snapshot. */
export const settleSlot = (input: SlotSettlementInput): SlotSettlementOutput => {
  const parsed = settlementParametersSchema.safeParse(input.params);
  if (!parsed.success || !safeInputInteger(input.stake) || input.stake < 1 ||
      input.stake !== parsed.data.stake || input.stake > parsed.data.maxStake ||
      !safeInputInteger(input.balance) || input.balance < 0) {
    throw new Error("invalid_settlement_params");
  }
  const params = parsed.data;
  const initialJackpot = input.pots["__jackpot:emote_slots"] ?? 0;
  if (!safeInputInteger(initialJackpot) || initialJackpot < 0) throw new Error("invalid_settlement_params");

  const stake = BigInt(input.stake);
  const seed = BigInt(params.seed);
  const share = assertSafeInteger((stake * BigInt(params.jackpotShareBp)) / 10_000n);
  const emptyPot = BigInt(initialJackpot) === 0n;
  const preSeed = assertSafeInteger(emptyPot ? seed : 0n);
  let jackpot = assertSafeInteger(BigInt(initialJackpot) + preSeed + share);
  const [first, second, third] = params.symbols;
  const selected = [first, second, third] as const;
  const allEqual = first === second && second === third;
  const hasPair = first === second || first === third || second === third;
  const jackpotSymbolIndex = params.table.symbols.findIndex(({ isJackpot }) => isJackpot);
  let payout = 0n;
  let jackpotWin = 0n;
  let jackpotOutcome = false;
  let triple = false;
  let pair = false;

  if (allEqual && first === jackpotSymbolIndex) {
    jackpotOutcome = true;
    jackpotWin = assertSafeInteger((jackpot * stake) / BigInt(params.maxStake));
    jackpot = assertSafeInteger(jackpot - jackpotWin);
    payout = jackpotWin;
  } else if (allEqual) {
    const symbol = params.table.symbols[first];
    if (symbol === undefined) throw new Error("invalid_settlement_params");
    payout = stake * BigInt(symbol.triple);
    triple = true;
  } else if (hasPair) {
    payout = stake;
    pair = true;
  }

  const postSeed = assertSafeInteger(jackpotOutcome ? seed : 0n);
  jackpot = assertSafeInteger(jackpot + postSeed);
  const net = assertSafeInteger(payout - stake);
  const balanceAfter = assertSafeInteger(BigInt(input.balance) + net);
  const house = assertSafeInteger(stake - share - (pair || triple ? payout : 0n) - preSeed - postSeed);
  const jackpotDelta = assertSafeInteger(preSeed + share - jackpotWin + postSeed);
  const jackpotAfter = jackpot;
  const movements: PointsMovement[] = [
    { accountId: input.actor.accountId, delta: safeNumber(net), login: input.actor.login },
    { accountId: "__jackpot:emote_slots", delta: safeNumber(jackpotDelta) },
    { accountId: "__house", delta: safeNumber(house) },
  ];

  return {
    movements,
    result: {
      kind: "slot",
      symbols: [...selected],
      stake: input.stake,
      payout: safeNumber(payout),
      net: safeNumber(net),
      balanceAfter: safeNumber(balanceAfter),
      jackpotAfter: safeNumber(jackpotAfter),
      jackpotWin: safeNumber(jackpotWin),
      triple,
      pair,
    },
  };
};

export const slotSettlementTable = (settings: Pick<EmoteSlotSettings, "symbols">): {
  symbols: { id: string; weight: number; triple: number; isJackpot: boolean }[];
} => ({
  symbols: settings.symbols.map(({ id, weight, triple, isJackpot }) => ({ id, weight, triple, isJackpot })),
});
