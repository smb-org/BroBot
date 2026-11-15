import { Hono } from "hono";

import { requireChannelAuthorization, type ChannelAuthorizationVariables } from "../auth/guards";
import { getAppAccessToken } from "../app-token";
import { helixRequest } from "../twitch/helix";

interface TwitchUserSuggestion {
  userId: string;
  login: string;
  displayName: string;
  profileImageUrl: string | null;
  isLive?: boolean;
}

interface HelixUsersResponse {
  data?: unknown;
}

interface HelixChannelSearchResponse {
  data?: unknown;
}

interface CachedSuggestions {
  expiresAt: number;
  response: { users: readonly TwitchUserSuggestion[]; partial: boolean };
}

interface TwitchUserRouteEnvironment {
  Bindings: Env;
  Variables: ChannelAuthorizationVariables;
}

const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 1_000;
const MAX_SUGGESTIONS = 8;
const LOGIN_PATTERN = /^[A-Za-z0-9_]{1,25}$/u;
const suggestionCache = new Map<string, CachedSuggestions>();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeChatters = (
  entries: readonly TwitchUserSuggestion[],
  query: string,
): TwitchUserSuggestion[] => {
  const normalizedQuery = query.toLocaleLowerCase("en-US");
  return entries.filter((entry) => entry.login.toLocaleLowerCase("en-US").startsWith(normalizedQuery) ||
    entry.displayName.toLocaleLowerCase("en-US").startsWith(normalizedQuery));
};

const userFromHelix = (entry: unknown): TwitchUserSuggestion | null => {
  if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.login !== "string" ||
      typeof entry.display_name !== "string") return null;
  return {
    userId: entry.id,
    login: entry.login,
    displayName: entry.display_name,
    profileImageUrl: typeof entry.profile_image_url === "string" && entry.profile_image_url.length > 0
      ? entry.profile_image_url
      : null,
  };
};

const channelFromHelix = (entry: unknown): TwitchUserSuggestion | null => {
  if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.broadcaster_login !== "string" ||
      typeof entry.display_name !== "string") return null;
  return {
    userId: entry.id,
    login: entry.broadcaster_login,
    displayName: entry.display_name,
    profileImageUrl: typeof entry.thumbnail_url === "string" && entry.thumbnail_url.length > 0
      ? entry.thumbnail_url
      : null,
    ...(typeof entry.is_live === "boolean" ? { isLive: entry.is_live } : {}),
  };
};

const appendUnique = (
  result: TwitchUserSuggestion[],
  seenIds: Set<string>,
  entries: readonly (TwitchUserSuggestion | null)[],
): void => {
  for (const entry of entries) {
    if (entry === null) continue;
    if (seenIds.has(entry.userId)) {
      const existingIndex = result.findIndex((existing) => existing.userId === entry.userId);
      const existing = result[existingIndex];
      if (existingIndex < 0 || existing === undefined) continue;
      result[existingIndex] = {
        ...existing,
        ...(existing.isLive === undefined && entry.isLive !== undefined ? { isLive: entry.isLive } : {}),
        ...(existing.profileImageUrl === null && entry.profileImageUrl !== null ? { profileImageUrl: entry.profileImageUrl } : {}),
        ...(existing.displayName.length === 0 && entry.displayName.length > 0 ? { displayName: entry.displayName } : {}),
      };
      continue;
    }
    if (result.length >= MAX_SUGGESTIONS) continue;
    seenIds.add(entry.userId);
    result.push(entry);
  }
};

const cacheKeyFor = (channelId: string, query: string): string =>
  `${channelId}\u0000${query.toLocaleLowerCase("en-US")}`;

const readCache = (key: string, now: number): CachedSuggestions | null => {
  const entry = suggestionCache.get(key);
  if (entry === undefined) return null;
  if (entry.expiresAt <= now) {
    suggestionCache.delete(key);
    return null;
  }
  return entry;
};

const writeCache = (key: string, response: CachedSuggestions["response"], now: number): void => {
  for (const [cachedKey, entry] of suggestionCache) {
    if (entry.expiresAt <= now) suggestionCache.delete(cachedKey);
  }
  suggestionCache.delete(key);
  while (suggestionCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = suggestionCache.keys().next().value;
    if (oldestKey === undefined) break;
    suggestionCache.delete(oldestKey);
  }
  suggestionCache.set(key, { expiresAt: now + CACHE_TTL_MS, response });
};

export const twitchUserRouter = new Hono<TwitchUserRouteEnvironment>();

twitchUserRouter.get(
  "/api/channels/:channelId/twitch/user-suggestions",
  requireChannelAuthorization(),
  async (context) => {
    const query = context.req.query("q") ?? "";
    if (!LOGIN_PATTERN.test(query)) return context.json({ error: "twitch_user_query_invalid" }, 400);

    const channelId = context.req.param("channelId");
    const key = cacheKeyFor(channelId, query);
    const now = Date.now();
    const cached = readCache(key, now);
    if (cached !== null) return context.json(cached.response);

    let chatters: TwitchUserSuggestion[];
    let partial = false;
    try {
      const recentChatters = await context.env.CHANNEL
        .get(context.env.CHANNEL.idFromName(channelId))
        .getRecentChatters(query, MAX_SUGGESTIONS);
      chatters = normalizeChatters(recentChatters, query);
    } catch {
      chatters = [];
      partial = true;
    }

    let exactUsers: (TwitchUserSuggestion | null)[] = [];
    let channelUsers: (TwitchUserSuggestion | null)[] = [];
    try {
      const accessToken = await getAppAccessToken(context.env, new Date(now).toISOString(), fetch);
      const [exactResult, searchResult] = await Promise.all([
        helixRequest<HelixUsersResponse>({
          url: "https://api.twitch.tv/helix/users",
          query: { login: query },
          accessToken,
          clientId: context.env.TWITCH_CLIENT_ID,
          fetcher: fetch,
        }),
        helixRequest<HelixChannelSearchResponse>({
          url: "https://api.twitch.tv/helix/search/channels",
          query: { query, first: "8" },
          accessToken,
          clientId: context.env.TWITCH_CLIENT_ID,
          fetcher: fetch,
        }),
      ]);
      if (exactResult.ok && Array.isArray(exactResult.data.data)) {
        exactUsers = exactResult.data.data.map(userFromHelix);
      } else {
        partial = true;
      }
      if (searchResult.ok && Array.isArray(searchResult.data.data)) {
        channelUsers = searchResult.data.data.map(channelFromHelix);
      } else {
        partial = true;
      }
    } catch {
      partial = true;
    }

    const users: TwitchUserSuggestion[] = [];
    const seenIds = new Set<string>();
    // Preserve a slot for an exact login so free-text resolution still works
    // when the recent chatter roster is full of prefix matches.
    const hasExactUser = exactUsers.some((user) => user !== null);
    appendUnique(users, seenIds, chatters.slice(0, hasExactUser ? MAX_SUGGESTIONS - 1 : MAX_SUGGESTIONS));
    appendUnique(users, seenIds, exactUsers);
    appendUnique(users, seenIds, channelUsers);
    const response = { users, partial };
    writeCache(key, response, now);
    return context.json(response);
  },
);
