import type { ModulePointsAccess, PointsKind, PointsMovement } from "../modules/contract";
import { POINT_WELCOME_ACCOUNT_ID_KEY, type PointWelcomeNote } from "./point-welcome";

const unavailable = <T>(): Promise<T> => Promise.reject(new Error("Point storage is unavailable."));

/** Binds the raw ChannelObject RPCs so a module cannot choose another module or channel. */
export const modulePoints = (
  namespace: Env["CHANNEL"] | undefined,
  channelId: string,
  moduleId: string,
  pointWelcome?: PointWelcomeNote,
): ModulePointsAccess => {
  if (namespace === undefined) {
    return {
      apply: () => unavailable(),
      settle: () => unavailable(),
      touchAccount: () => unavailable(),
      ackWelcome: () => unavailable(),
      creditActivity: () => unavailable(),
      balance: () => unavailable(),
      getAccount: () => unavailable(),
      listAccounts: () => unavailable(),
      history: () => unavailable(),
      summary: () => unavailable(),
      ranking: () => unavailable(),
      rankOf: () => unavailable(),
      markAuditWritten: () => unavailable(),
      pendingAudits: () => unavailable(),
      claimCooldown: () => unavailable(),
      rounds: {
        open: () => unavailable(),
        openWithStake: () => unavailable(),
        active: () => unavailable(),
        listOpen: () => unavailable(),
        markAnnounced: () => unavailable(),
        join: () => unavailable(),
        participants: () => unavailable(),
        answer: () => unavailable(),
        attack: () => unavailable(),
        resolve: () => unavailable(),
        accept: () => unavailable(),
        cancel: () => unavailable(),
        cancelOpenRounds: () => unavailable(),
        setGate: () => unavailable(),
      },
    };
  }
  const object = namespace.get(namespace.idFromName(channelId));
  const pointWelcomeFor = (accountId: string, messageId?: string): PointWelcomeNote | undefined =>
    pointWelcome !== undefined && pointWelcome.accountId === accountId &&
      (messageId === undefined || pointWelcome.messageId === messageId) ? pointWelcome : undefined;
  const withPointWelcome = (data: unknown, accountId: string): unknown => {
    const note = pointWelcomeFor(accountId);
    if (note === undefined || typeof data !== "object" || data === null || Array.isArray(data)) return data;
    return { ...data, [POINT_WELCOME_ACCOUNT_ID_KEY]: accountId };
  };
  return {
    apply: (operationId, kind: PointsKind, movements: PointsMovement[], result, payloadIdentity) =>
      object.applyPointOperation(moduleId, operationId, kind, movements, result, payloadIdentity),
    settle: (operationId, kind, actor, stake, params, options) =>
      object.settlePointOperation(moduleId, operationId, kind, actor, stake, params, options),
    touchAccount: (accountId, login, startBonus) => object.touchPointAccount(moduleId, accountId, login, startBonus),
    storePendingWelcome: (welcome) => typeof object.storePendingPointWelcome === "function"
      ? object.storePendingPointWelcome(moduleId, {
        accountId: welcome.accountId,
        messageId: welcome.messageId,
        text: welcome.text,
      })
      : Promise.resolve(),
    claimWelcome: (accountId, claimId) => typeof object.claimPointWelcome === "function"
      ? object.claimPointWelcome(moduleId, accountId, claimId)
      : Promise.resolve(true),
    releaseWelcome: (accountId, claimId) => typeof object.releasePointWelcome === "function"
      ? object.releasePointWelcome(moduleId, accountId, claimId)
      : Promise.resolve(),
    ackWelcome: (accountId, claimId) => object.acknowledgePointWelcome(moduleId, accountId, claimId),
    creditActivity: (accountId, login, messageAt, live, rules) =>
      object.creditPointActivity(moduleId, accountId, login, messageAt, live, rules),
    balance: (accountId) => object.pointBalance(moduleId, accountId),
    getAccount: (accountId) => object.pointAccount(moduleId, accountId),
    listAccounts: (query) => object.listPointAccounts(moduleId, query),
    history: (accountId, cursor, limit) => object.pointHistory(moduleId, accountId, cursor, limit),
    summary: () => object.pointSummary(moduleId),
    ranking: (month, limit) => object.pointRanking(moduleId, month, limit),
    rankOf: (accountId, month) => object.pointRankOf(moduleId, accountId, month),
    markAuditWritten: (operationId) => object.markPointAuditWritten(moduleId, operationId),
    pendingAudits: () => object.pendingPointAudits(moduleId),
    claimCooldown: (key, seconds) => object.claimPointCooldown(moduleId, key, seconds),
    rounds: {
      open: (roundId, data) => object.openGameRound(moduleId, roundId, data),
      openWithStake: (roundId, data, operationId, accountId, login, stake, cooldown) =>
        object.openGameRoundWithStake(moduleId, roundId, withPointWelcome(data, accountId), operationId, accountId, login, stake, cooldown),
      active: () => object.activeGameRound(moduleId),
      listOpen: () => object.listOpenGameRounds(moduleId),
      markAnnounced: (roundId, deadlineAt, alarmKey) => object.markGameRoundAnnounced(moduleId, roundId, deadlineAt, alarmKey),
      join: (roundId, operationId, accountId, login, stake, data) =>
        object.joinGameRound(moduleId, roundId, operationId, accountId, login, stake, data),
      participants: (roundId, nameLimit) => object.gameRoundParticipants(moduleId, roundId, nameLimit),
      answer: (roundId, operationId, accountId, login, graceS, messageAt) =>
        object.answerGameRound(moduleId, roundId, operationId, accountId, login, graceS, messageAt),
      attack: (roundId, operationId, accountId, login, damage, messageAt) =>
        object.attackGameRound(moduleId, roundId, operationId, accountId, login, damage, messageAt),
      resolve: (roundId, settlement) => object.resolveGameRound(moduleId, roundId, settlement),
      accept: (roundId, operationId, accountId, login, replyToMessageId) =>
        object.acceptGameRound(moduleId, roundId, operationId, accountId, login, replyToMessageId),
      cancel: (roundId) => object.cancelGameRound(moduleId, roundId),
      cancelOpenRounds: (revision) => object.cancelOpenGameRounds(moduleId, revision),
      setGate: (closed, revision, lastDisabledRevision) => object.setGameModuleGate(moduleId, closed, revision, lastDisabledRevision),
    },
  };
};
