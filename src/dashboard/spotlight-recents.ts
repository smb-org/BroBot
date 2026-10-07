export const RECENT_TARGET_LIMIT = 5;
const STORAGE_PREFIX = "brobot-dashboard-spotlight-recent-v1";
const memoryFallback = new Map<string, string[]>();

export interface RecentTargetStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

const browserStorage = (): RecentTargetStorage | null => {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
};

const storageKey = (viewerUserId: string, channelId: string): string =>
  `${STORAGE_PREFIX}:${encodeURIComponent(viewerUserId)}:${encodeURIComponent(channelId)}`;

export const readRecentTargets = (
  viewerUserId: string | null,
  channelId: string,
  storage: RecentTargetStorage | null = browserStorage(),
): string[] => {
  if (viewerUserId === null || viewerUserId.length === 0 || channelId.length === 0) return [];
  const key = storageKey(viewerUserId, channelId);
  if (storage === null) return [...(memoryFallback.get(key) ?? [])];
  try {
    const stored = storage.getItem(key);
    if (stored === null) return [...(memoryFallback.get(key) ?? [])];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [...(memoryFallback.get(key) ?? [])];
    return [...new Set(parsed.filter((target): target is string => typeof target === "string" && target.length > 0))].slice(0, RECENT_TARGET_LIMIT);
  } catch {
    return [...(memoryFallback.get(key) ?? [])];
  }
};

export const rememberRecentTarget = (
  viewerUserId: string | null,
  channelId: string,
  target: string,
  storage: RecentTargetStorage | null = browserStorage(),
): string[] => {
  if (viewerUserId === null || viewerUserId.length === 0 || channelId.length === 0 || target.length === 0) return [];
  const current = readRecentTargets(viewerUserId, channelId, storage);
  const next = [target, ...current.filter((entry) => entry !== target)].slice(0, RECENT_TARGET_LIMIT);
  const key = storageKey(viewerUserId, channelId);
  memoryFallback.set(key, next);
  if (storage === null) return next;
  try {
    storage.setItem(key, JSON.stringify(next));
  } catch {
    return next;
  }
  return next;
};
