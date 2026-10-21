import type { PointSettlement, PointSettlementInput } from "./points";
import type { InstantPointSettlement } from "./points";
import { settleSlot } from "../../modules/emote_slots/domain/settlement";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const testSettlement: PointSettlement = ({ round, participants, params }: PointSettlementInput) => {
  if (!isRecord(params)) throw new Error("invalid_settlement_params");
  const rawPayouts = params.payouts;
  if (!Array.isArray(rawPayouts)) throw new Error("invalid_settlement_params");
  const participantsById = new Map(participants.map((participant) => [participant.accountId, participant]));
  const payouts = rawPayouts.map((value) => {
    if (!isRecord(value) || typeof value.accountId !== "string" || !Number.isSafeInteger(value.amount) ||
        (value.amount as number) < 0 || !participantsById.has(value.accountId)) throw new Error("invalid_settlement_params");
    return { accountId: value.accountId, amount: value.amount as number };
  });
  const totalStake = participants.reduce((total, participant) => total + participant.stake, 0);
  const totalPayout = payouts.reduce((total, payout) => total + payout.amount, 0);
  const movements = [
    { accountId: `__escrow:${round.roundId}`, delta: -totalStake },
    ...payouts.map(({ accountId, amount }) => ({ accountId, delta: amount })),
    { accountId: "__house", delta: totalStake - totalPayout },
  ];
  return { movements, result: params.result ?? { payouts } };
};

const blitzSettlement: PointSettlement = ({ round, participants, params }: PointSettlementInput) => {
  if (!isRecord(params) || !Number.isSafeInteger(params.prize) || (params.prize as number) < 1 || (params.prize as number) > 10_000) {
    throw new Error("invalid_settlement_params");
  }
  const data = isRecord(round.data) ? round.data : {};
  if (typeof data.answer !== "string" || data.answer.length === 0) throw new Error("invalid_settlement_params");
  const prize = params.prize as number;
  const share = participants.length === 0 ? 0 : Math.floor(prize / participants.length);
  const winners = participants.map(({ accountId, login }) => ({ accountId, login }));
  const movements = share === 0 || winners.length === 0
    ? []
    : [
      { accountId: "__house", delta: -share * winners.length },
      ...winners.map(({ accountId, login }) => ({ accountId, delta: share, login })),
    ];
  return { movements, result: { answer: data.answer, winners, share } };
};

export const POINT_SETTLEMENTS: ReadonlyMap<string, PointSettlement> = new Map([
  ["test", testSettlement],
  ["blitz", blitzSettlement],
]);

export const INSTANT_SETTLEMENTS: ReadonlyMap<string, InstantPointSettlement> = new Map([
  ["slot", settleSlot],
]);
