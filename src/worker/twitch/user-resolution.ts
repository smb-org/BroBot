import { decryptJson, getTokenEncryptionKeys, parseKeyRing } from "../auth/crypto";
import { getBotIdentity } from "../db/bot-identity";
import { helixRequest } from "./helix";
import type { TwitchUser } from "../shoutout";

interface JsonRecord {
  [key: string]: unknown;
}

const USER_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_USER_IDS_PER_REQUEST = 100;
const MAX_CACHED_USERS = 1_000;

interface CachedUser {
  expiresAt: number;
  user: TwitchUser | null;
}

interface UserResolutionCache {
  users: Map<string, CachedUser>;
  pending: Map<string, Promise<TwitchUser | null>>;
}

const caches = new WeakMap<typeof fetch, UserResolutionCache>();

const cacheFor = (fetcher: typeof fetch): UserResolutionCache => {
  const existing = caches.get(fetcher);
  if (existing !== undefined) return existing;
  const created = { users: new Map(), pending: new Map() } satisfies UserResolutionCache;
  caches.set(fetcher, created);
  return created;
};

const cacheUser = (
  cache: UserResolutionCache,
  userId: string,
  user: TwitchUser | null,
  now: number,
): void => {
  for (const [cachedId, cached] of cache.users) {
    if (cached.expiresAt <= now) cache.users.delete(cachedId);
  }
  cache.users.delete(userId);
  while (cache.users.size >= MAX_CACHED_USERS) {
    const oldestId = cache.users.keys().next().value;
    if (oldestId === undefined) break;
    cache.users.delete(oldestId);
  }
  cache.users.set(userId, { expiresAt: now + USER_CACHE_TTL_MS, user });
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readStoredBotAccessToken = async (environment: Env): Promise<string | null> => {
  const identity = await getBotIdentity(environment.DB);
  if (identity === null) return null;
  const value = await decryptJson<{ token?: unknown }>(
    identity.accessTokenCiphertext,
    parseKeyRing(getTokenEncryptionKeys(environment)),
  );
  return value !== null && typeof value.token === "string" && value.token.length > 0
    ? value.token
    : null;
};

interface BatchLookupResult {
  users: Map<string, TwitchUser>;
  cacheable: boolean;
}

const fetchUserBatch = async (
  fetcher: typeof fetch,
  environment: Env,
  userIds: string[],
): Promise<BatchLookupResult> => {
  const resolved = new Map<string, TwitchUser>();
  try {
    const accessToken = await readStoredBotAccessToken(environment);
    if (accessToken === null) return { users: resolved, cacheable: false };
    const url = new URL("https://api.twitch.tv/helix/users");
    for (const userId of userIds) url.searchParams.append("id", userId);
    const result = await helixRequest<JsonRecord>({
      url: url.toString(),
      accessToken,
      clientId: environment.TWITCH_CLIENT_ID,
      fetcher,
    });
    if (!result.ok || !Array.isArray(result.data.data)) return { users: resolved, cacheable: false };
    for (const entry of result.data.data as unknown[]) {
      if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.login !== "string" ||
          typeof entry.display_name !== "string") continue;
      resolved.set(entry.id, {
        userId: entry.id,
        login: entry.login,
        displayName: entry.display_name,
        profileImageUrl: typeof entry.profile_image_url === "string" && entry.profile_image_url.length > 0
          ? entry.profile_image_url
          : null,
      });
    }
    return { users: resolved, cacheable: true };
  } catch {
    return { users: resolved, cacheable: false };
  }
};

/** Resolve every distinct user in Helix batches of 100, caching by ID and coalescing overlapping lookups. */
export const fetchTwitchUsersById = async (
  fetcher: typeof fetch,
  environment: Env,
  userIds: string[],
): Promise<Map<string, TwitchUser>> => {
  const resolved = new Map<string, TwitchUser>();
  if (userIds.length === 0) return resolved;

  const cache = cacheFor(fetcher);
  const now = Date.now();
  const requestedIds = [...new Set(userIds)];
  const missing: string[] = [];
  for (const userId of requestedIds) {
    const cached = cache.users.get(userId);
    if (cached !== undefined && cached.expiresAt > now) {
      if (cached.user !== null) resolved.set(userId, cached.user);
      continue;
    }
    if (cached !== undefined) cache.users.delete(userId);
    if (!cache.pending.has(userId)) missing.push(userId);
  }

  for (let offset = 0; offset < missing.length; offset += MAX_USER_IDS_PER_REQUEST) {
    const batchIds = missing.slice(offset, offset + MAX_USER_IDS_PER_REQUEST);
    const batch = fetchUserBatch(fetcher, environment, batchIds);
    for (const userId of batchIds) {
      const pending = batch.then((result) => {
        const user = result.users.get(userId) ?? null;
        if (result.cacheable) cacheUser(cache, userId, user, Date.now());
        return user;
      }).finally(() => {
        if (cache.pending.get(userId) === pending) cache.pending.delete(userId);
      });
      cache.pending.set(userId, pending);
    }
  }

  const lookups = await Promise.all(requestedIds.map(async (userId) => {
    const cached = cache.users.get(userId);
    if (cached !== undefined && cached.expiresAt > Date.now()) return [userId, cached.user] as const;
    return [userId, await cache.pending.get(userId)] as const;
  }));
  for (const [userId, user] of lookups) {
    if (user !== null && user !== undefined) resolved.set(userId, user);
  }
  return resolved;
};
