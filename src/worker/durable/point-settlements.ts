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

export const POINT_SETTLEMENTS: ReadonlyMap<string, PointSettlement> = new Map([
  ["test", testSettlement],
]);

export const INSTANT_SETTLEMENTS: ReadonlyMap<string, InstantPointSettlement> = new Map([
  ["slot", settleSlot],
]);
