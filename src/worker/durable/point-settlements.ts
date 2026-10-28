import type { PointSettlement, PointSettlementInput } from "./points";
import type { InstantPointSettlement } from "./points";
import { settleSlot } from "../../modules/emote_slots/domain/settlement";
import { resolveHeist } from "../../modules/heist/domain/settlement";
import { calculateBossPayouts } from "../../modules/boss_fight/domain/boss";
import { scoreQuizSession } from "../../modules/quiz/domain/session";

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

const duelSettlement: PointSettlement = ({ round, participants, pots, params }: PointSettlementInput) => {
  if (!isRecord(params) || (params.mode !== "accept" && params.mode !== "expire")) {
    throw new Error("invalid_settlement_params");
  }
  const data = isRecord(round.data) ? round.data : null;
  if (data === null || typeof data.challengerId !== "string" || typeof data.challengerLogin !== "string" ||
      !(data.targetId === null || typeof data.targetId === "string") || typeof data.botEnabled !== "boolean" ||
      !Number.isSafeInteger(data.stake) || (data.stake as number) < 1 || (data.stake as number) > 100_000) {
    throw new Error("invalid_settlement_params");
  }
  const stake = data.stake as number;
  const challenger = participants.find(({ accountId }) => accountId === data.challengerId);
  if (challenger === undefined || challenger.login !== data.challengerLogin || challenger.stake !== stake) {
    throw new Error("invalid_settlement_params");
  }
  const escrowId = `__escrow:${round.roundId}`;
  const expectedEscrow = stake * (params.mode === "accept" ? 2 : 1);
  if (!Number.isSafeInteger(expectedEscrow) || pots[escrowId] !== expectedEscrow) throw new Error("invalid_settlement_params");

  if (params.mode === "accept") {
    if (participants.length !== 2 || participants.some(({ stake: participantStake }) => participantStake !== stake)) {
      throw new Error("invalid_settlement_params");
    }
    const acceptor = participants.find(({ accountId }) => accountId !== challenger.accountId);
    if (acceptor === undefined) throw new Error("invalid_settlement_params");
    const random = new Uint8Array(1);
    crypto.getRandomValues(random);
    const winner = participants[(random[0] ?? 0) % 2];
    const loser = winner === challenger ? acceptor : challenger;
    if (winner === undefined) throw new Error("invalid_settlement_params");
    return {
      movements: [
        { accountId: escrowId, delta: -expectedEscrow },
        { accountId: winner.accountId, delta: expectedEscrow, login: winner.login },
      ],
      result: {
        winner: winner.accountId,
        winnerLogin: winner.login,
        loserLogin: loser.login,
        net: stake,
        bot: false,
      },
    };
  }

  if (participants.length !== 1) throw new Error("invalid_settlement_params");
  if (data.targetId !== null || !data.botEnabled) {
    return {
      movements: [
        { accountId: escrowId, delta: -stake },
        { accountId: challenger.accountId, delta: stake, login: challenger.login },
      ],
      result: { expired: true },
    };
  }

  const random = new Uint8Array(1);
  crypto.getRandomValues(random);
  const botWins = (random[0] ?? 0) % 2 === 0;
  return {
    movements: [
      { accountId: escrowId, delta: -stake },
      { accountId: "__house", delta: -stake },
      { accountId: botWins ? "__house" : challenger.accountId, delta: stake * 2, ...(botWins ? {} : { login: challenger.login }) },
    ],
    result: {
      winner: botWins ? "bot" : challenger.accountId,
      winnerLogin: botWins ? "BroBot" : challenger.login,
      loserLogin: botWins ? challenger.login : "BroBot",
      net: botWins ? -stake : stake,
      bot: true,
    },
  };
};

const heistSettlement: PointSettlement = ({ round, participants, pots, params }: PointSettlementInput) => {
  if (!isRecord(params) || !Number.isSafeInteger(params.baseChance) || !Number.isSafeInteger(params.maxChance)) {
    throw new Error("invalid_settlement_params");
  }
  const escrowId = `__escrow:${round.roundId}`;
  const totalStake = participants.reduce((total, participant) => total + participant.stake, 0);
  if (!Number.isSafeInteger(totalStake) || totalStake < 1 || pots[escrowId] !== totalStake) {
    throw new Error("invalid_settlement_params");
  }
  const random = (): number => {
    const value = new Uint32Array(1);
    crypto.getRandomValues(value);
    return (value[0] ?? 0) / 0x1_0000_0000;
  };
  const resolution = resolveHeist(
    round.roundId,
    participants.map(({ accountId, login, stake }) => ({ accountId, login, stake })),
    { baseChance: params.baseChance as number, maxChance: params.maxChance as number },
    random,
  );
  return { movements: resolution.movements, result: resolution.result };
};

const bossFightSettlement: PointSettlement = ({ round, participants, params }) => {
  if (!isRecord(params) || Object.keys(params).length !== 0) throw new Error("invalid_settlement_params");
  const data = isRecord(round.data) ? round.data : null;
  if (data === null || typeof data.defeated !== "boolean" || !Number.isSafeInteger(data.lootPool) ||
      (data.lootPool as number) < 1 || (data.lootPool as number) > 100_000 || !Number.isSafeInteger(data.damageDealt) ||
      (data.damageDealt as number) < 0 || !Number.isSafeInteger(data.attackerCount) || (data.attackerCount as number) < 0) {
    throw new Error("invalid_settlement_params");
  }
  const damage = participants.map(({ accountId, login, stake, data: participantData }) => {
    if (stake !== 0 || !isRecord(participantData) || !Number.isSafeInteger(participantData.damage) ||
        (participantData.damage as number) < 0) throw new Error("invalid_settlement_params");
    return { accountId, login, damage: participantData.damage as number };
  });
  const calculated = calculateBossPayouts(data.lootPool as number, damage);
  if (calculated.totalDamage !== data.damageDealt || damage.length !== data.attackerCount) throw new Error("invalid_settlement_params");
  if (data.defeated && calculated.totalDamage === 0) throw new Error("invalid_settlement_params");

  const ranked = calculated.payouts
    .filter(({ damage: amount }) => amount > 0)
    .sort((left, right) => right.damage - left.damage || left.accountId.localeCompare(right.accountId));
  const topDamageDealers = ranked.slice(0, 3).map(({ accountId, login, damage: amount, amount: payout }) => ({
    accountId,
    login,
    damage: amount,
    amount: data.defeated ? payout : 0,
  }));
  const distributed = data.defeated ? calculated.distributed : 0;
  const movements = distributed === 0 ? [] : [
    { accountId: "__house", delta: -distributed },
    ...calculated.payouts.filter(({ amount }) => amount > 0).map(({ accountId, login, amount }) => ({ accountId, delta: amount, login })),
  ];
  return {
    movements,
    result: {
      defeated: data.defeated,
      lootPool: data.lootPool,
      distributed,
      houseRemainder: data.defeated ? (data.lootPool as number) - distributed : data.lootPool,
      totalDamage: calculated.totalDamage,
      topDamageDealers,
      otherCount: Math.max(0, ranked.length - topDamageDealers.length),
    },
  };
};

const quizSettlement: PointSettlement = ({ round, participants, params }) => {
  if (!isRecord(params) || Object.keys(params).length !== 0) throw new Error("invalid_settlement_params");
  const data = isRecord(round.data) ? round.data : null;
  if (data === null || !Array.isArray(data.questions) || !Number.isSafeInteger(data.pot) ||
      (data.pot as number) < 0 || data.questions.length === 0) throw new Error("invalid_settlement_params");
  const questions = data.questions.map((value) => {
    if (!isRecord(value) || typeof value.text !== "string" || !Array.isArray(value.options) ||
        !value.options.every((option) => typeof option === "string") || typeof value.correctIndex !== "number" ||
        !Number.isSafeInteger(value.correctIndex)) {
      throw new Error("invalid_settlement_params");
    }
    return { text: value.text, options: value.options, correctIndex: value.correctIndex };
  });
  const scoringParticipants = participants.map(({ accountId, login, stake, data: participantData }) => {
    if (stake !== 0 || !isRecord(participantData) || !Array.isArray(participantData.answers) ||
        !participantData.answers.every((answer) => answer === null || Number.isSafeInteger(answer))) {
      throw new Error("invalid_settlement_params");
    }
    return {
      accountId,
      login,
      answers: participantData.answers as (number | null)[],
    };
  });
  const score = scoreQuizSession(questions, scoringParticipants, data.pot as number);
  const movements = score.distributed === 0 ? [] : [
    { accountId: "__house", delta: -score.distributed },
    ...score.ranking.filter(({ payout }) => payout > 0).map(({ accountId, login, payout }) => ({
      accountId, login, delta: payout,
    })),
  ];
  const result = {
    sessionId: typeof data.sessionId === "string" ? data.sessionId : round.roundId,
    setId: typeof data.setId === "string" ? data.setId : "",
    setName: typeof data.setName === "string" ? data.setName : "",
    questions: questions.map((question, index) => ({
      text: question.text,
      correctCounts: score.correctCounts[index] ?? 0,
      answerDistribution: score.answerDistribution[index] ?? [],
    })),
    participants: score.participants,
    totalAnswers: score.totalAnswers,
    totalCorrect: score.totalCorrect,
    correctRate: score.correctRate,
    distributed: score.distributed,
    houseRemainder: score.houseRemainder,
    ranking: score.ranking.slice(0, 10).map(({ login, correct, rank, payout }) => ({
      login, correct, rank, payout,
    })),
  };
  return { movements, result, clearParticipantData: true };
};

export const POINT_SETTLEMENTS: ReadonlyMap<string, PointSettlement> = new Map([
  ["test", testSettlement],
  ["blitz", blitzSettlement],
  ["duel", duelSettlement],
  ["heist", heistSettlement],
  ["boss_fight", bossFightSettlement],
  ["quiz", quizSettlement],
]);

export const INSTANT_SETTLEMENTS: ReadonlyMap<string, InstantPointSettlement> = new Map([
  ["slot", settleSlot],
]);
