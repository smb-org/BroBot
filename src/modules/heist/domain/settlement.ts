export interface HeistParticipant {
  accountId: string;
  login: string;
  stake: number;
}

export interface HeistSettlementResult {
  chancePercent: number;
  movements: Array<{ accountId: string; delta: number; login?: string }>;
  result: {
    chancePercent: number;
    participantCount: number;
    winners: Array<HeistParticipant & { payout: number }>;
    losers: HeistParticipant[];
  };
}

const heistChancePercent = (participantCount: number, baseChance: number, maxChance: number): number => {
  if (!Number.isSafeInteger(participantCount) || participantCount < 1 ||
      !Number.isSafeInteger(baseChance) || baseChance < 0 || baseChance > 100 ||
      !Number.isSafeInteger(maxChance) || maxChance < baseChance || maxChance > 100) {
    throw new Error("invalid_heist_rules");
  }
  return Math.min(maxChance, baseChance + Math.max(0, participantCount - 1) * 2);
};

export const resolveHeist = (
  roundId: string,
  participants: readonly HeistParticipant[],
  settings: { baseChance: number; maxChance: number },
  random: () => number,
): HeistSettlementResult => {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(roundId) || participants.length === 0) throw new Error("invalid_heist_round");
  const chancePercent = heistChancePercent(participants.length, settings.baseChance, settings.maxChance);
  const winners: Array<HeistParticipant & { payout: number }> = [];
  const losers: HeistParticipant[] = [];
  let totalStake = 0;
  let totalPayout = 0;
  for (const participant of participants) {
    if (!/^[A-Za-z0-9_-]{1,32}$/u.test(participant.accountId) || participant.login.length === 0 ||
        !Number.isSafeInteger(participant.stake) || participant.stake < 1) throw new Error("invalid_heist_participant");
    totalStake += participant.stake;
    if (!Number.isSafeInteger(totalStake)) throw new Error("invalid_heist_stake_total");
    const roll = random();
    if (!Number.isFinite(roll) || roll < 0 || roll >= 1) throw new Error("invalid_heist_random_value");
    if (roll < chancePercent / 100) {
      const payout = participant.stake * 2;
      if (!Number.isSafeInteger(payout)) throw new Error("invalid_heist_payout");
      totalPayout += payout;
      if (!Number.isSafeInteger(totalPayout)) throw new Error("invalid_heist_payout_total");
      winners.push({ ...participant, payout });
    } else {
      losers.push(participant);
    }
  }
  const movements: HeistSettlementResult["movements"] = [
    { accountId: `__escrow:${roundId}`, delta: -totalStake },
    ...winners.map(({ accountId, login, payout }) => ({ accountId, delta: payout, login })),
  ];
  const houseDelta = totalStake - totalPayout;
  if (houseDelta !== 0) movements.push({ accountId: "__house", delta: houseDelta });
  return {
    chancePercent,
    movements,
    result: { chancePercent, participantCount: participants.length, winners, losers },
  };
};
