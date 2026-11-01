import type { ModuleTempVipAccess } from "../modules/contract";

const unavailable = <T>(): Promise<T> => Promise.reject(new Error("Temporary VIP storage is unavailable."));

/** Binds every temporary VIP RPC to the event's channel object. */
export const moduleTempVips = (namespace: Env["CHANNEL"] | undefined, channelId: string): ModuleTempVipAccess => {
  if (namespace === undefined) {
    return {
      grant: () => unavailable(),
      extend: () => unavailable(),
      importExisting: () => unavailable(),
      end: () => unavailable(),
      release: () => unavailable(),
      list: () => unavailable(),
      runExpiry: () => unavailable(),
      handleRemoved: () => unavailable(),
    };
  }
  const object = namespace.get(namespace.idFromName(channelId));
  return {
    grant: (request) => object.grantTempVip(request),
    extend: (request) => object.extendTempVip(request),
    importExisting: (request) => object.importExistingTempVip(request),
    end: (request) => object.endTempVip(request),
    release: (request) => object.releaseTempVip(request),
    list: () => object.listTempVips(),
    runExpiry: (now) => now === undefined ? object.runTempVipExpiry() : object.runTempVipExpiry(now),
    handleRemoved: (event) => object.handleTempVipRemoved(event),
  };
};
