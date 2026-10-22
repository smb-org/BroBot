const STORAGE_PREFIX = "brobot-dashboard-counter-variable-v1:";

const storageFor = (): Storage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

const keyFor = (channelId: string): string => `${STORAGE_PREFIX}${encodeURIComponent(channelId)}`;

export const readLastCounterVariable = (channelId: string): string | null => {
  try {
    return storageFor()?.getItem(keyFor(channelId)) ?? null;
  } catch {
    return null;
  }
};

export const rememberLastCounterVariable = (channelId: string, name: string): void => {
  try {
    storageFor()?.setItem(keyFor(channelId), name);
  } catch {
    // The quick action remains usable when browser storage is unavailable.
  }
};
