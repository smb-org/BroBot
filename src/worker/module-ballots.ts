import type { ModuleBallotAccess } from "../modules/contract";

/** Binds the raw ChannelObject RPCs so a module cannot choose another module or channel. */
export const moduleBallots = (
  namespace: Env["CHANNEL"] | undefined,
  channelId: string,
  moduleId: string,
): ModuleBallotAccess => {
  if (namespace === undefined) {
    return {
      open: () => Promise.reject(new Error("Ballot storage is unavailable.")),
      cast: () => Promise.resolve({ status: "not_open", counts: [], revision: 0 }),
      castTerm: () => Promise.resolve({ status: "not_open", counts: [], revision: 0 }),
      setBlockedTerms: () => Promise.resolve(null),
      approveTerm: () => Promise.resolve({ status: "not_open", snapshot: null }),
      read: () => Promise.resolve(null),
      close: () => Promise.resolve(null),
      finalize: () => Promise.resolve({ outcome: "not_open", counts: [], revision: 0 }),
      acknowledgeClosed: () => Promise.resolve(),
    };
  }
  const object = namespace.get(namespace.idFromName(channelId));
  return {
    open: (ballotId, optionCount, expiresAt, rule, termFilter) => object.openBallot(moduleId, ballotId, optionCount, expiresAt, rule, termFilter),
    cast: (ballotId, userId, choice, options) => object.castBallot(moduleId, ballotId, userId, choice, options),
    castTerm: (ballotId, userId, term, matchText) => object.castBallotTerm(moduleId, ballotId, userId, term, matchText),
    setBlockedTerms: (ballotId, terms) => object.setBlockedTerms(moduleId, ballotId, terms),
    approveTerm: (ballotId, term) => object.approveTerm(moduleId, ballotId, term),
    read: (ballotId) => object.readBallot(moduleId, ballotId),
    hasOpenBallot: () => object.hasOpenBallot(),
    close: (ballotId) => object.closeBallot(moduleId, ballotId),
    finalize: (ballotId) => object.finalizeBallot(moduleId, ballotId),
    acknowledgeClosed: (ballotId) => object.acknowledgeClosedBallot(moduleId, ballotId),
  };
};
