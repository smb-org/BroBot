import type { ModuleTwitchRanksAccess } from "../modules/contract";

const unavailable = <Value>(): Promise<Value> => Promise.reject(new Error("Twitch rank storage is unavailable."));

/** Binds rank reads and consumer dirty state to one channel and module. */
export const moduleTwitchRanks = (
  namespace: Env["CHANNEL"] | undefined,
  channelId: string,
  moduleId: string,
): ModuleTwitchRanksAccess => {
  if (namespace === undefined) {
    return {
      getTwitchRanks: () => unavailable(),
      isComplete: () => unavailable(),
      isDirty: () => unavailable(),
      markReconciled: () => false,
    };
  }
  const object = namespace.get(namespace.idFromName(channelId));
  return {
    getTwitchRanks: (rankType) => object.getTwitchRanks(rankType),
    isComplete: (rankType) => object.isTwitchRankComplete(rankType),
    isDirty: () => object.isTwitchRankConsumerDirty(moduleId),
    markReconciled: () => false,
  };
};
