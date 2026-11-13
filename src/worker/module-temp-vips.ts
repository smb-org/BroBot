import type { ModuleTempVipAccess, ModuleTempVipRouteAccess } from "../modules/contract";

const unavailable = <Value>(): Promise<Value> => Promise.reject(new Error("Temporary VIP storage is unavailable."));

/** Binds temporary VIP queue RPCs to one channel and keeps Twitch discovery read-only. */
export const moduleTempVips = (
  namespace: Env["CHANNEL"] | undefined,
  channelId: string,
): ModuleTempVipAccess => {
  if (namespace === undefined) {
    return {
      mode: () => unavailable(),
      recordIntent: () => unavailable(),
      addObserved: () => unavailable(),
      classify: () => unavailable(),
      handleModeration: () => unavailable(),
      grant: () => unavailable(),
      replayGrant: () => unavailable(),
      extend: () => unavailable(),
      importExisting: () => unavailable(),
      replayImport: () => unavailable(),
      end: () => unavailable(),
      retryRemovalNow: () => unavailable(),
      release: () => unavailable(),
      list: () => unavailable(),
      runExpiry: () => unavailable(),
      handleRemoved: () => unavailable(),
    };
  }
  const object = namespace.get(namespace.idFromName(channelId));
  return {
    mode: () => object.tempVipMode(),
    recordIntent: (request) => object.recordTempVipIntent(request),
    addObserved: (request) => object.addObservedTempVip(request),
    classify: (request) => object.classifyTempVip(request),
    handleModeration: (event) => object.handleTempVipModeration(event),
    grant: (request) => object.grantTempVip(request),
    replayGrant: (operationId, userId) => object.replayTempVipGrant(operationId, userId),
    extend: (request) => object.extendTempVip(request),
    importExisting: (request) => object.importExistingTempVip(request),
    replayImport: (operationId, userId, expiresAt) => object.replayTempVipImport(operationId, userId, expiresAt),
    end: (request) => object.endTempVip(request),
    retryRemovalNow: (userId) => object.retryTempVipRemovalNow(userId),
    release: (request) => object.releaseTempVip(request),
    list: () => object.listTempVips(),
    runExpiry: (now) => object.runTempVipExpiry(now),
    handleRemoved: (event) => object.handleTempVipRemoved(event),
  };
};

export const moduleTempVipRoutes = (
  namespace: Env["CHANNEL"] | undefined,
  channelId: string,
  listExisting: ModuleTempVipRouteAccess["listExisting"],
): ModuleTempVipRouteAccess => {
  const access = moduleTempVips(namespace, channelId);
  return { ...access, listExisting };
};
