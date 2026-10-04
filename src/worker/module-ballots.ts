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
      read: () => Promise.resolve(null),
      close: () => Promise.resolve(null),
      freeze: () => Promise.resolve({ status: "not_open", counts: [], revision: 0 }),
    };
  }
  const object = namespace.get(namespace.idFromName(channelId));
  return {
    open: (ballotId, optionCount, expiresAt) => object.openBallot(moduleId, ballotId, optionCount, expiresAt),
    cast: (ballotId, userId, choice) => object.castBallot(moduleId, ballotId, userId, choice),
    read: (ballotId) => object.readBallot(moduleId, ballotId),
    close: (ballotId) => object.closeBallot(moduleId, ballotId),
    freeze: (ballotId, condition) => object.freezeBallot(moduleId, ballotId, condition),
  };
};
