import { Hono } from "hono";

import {
  requirePlatform,
  type PlatformAuthorizationVariables,
} from "../auth/guards";
import {
  countBroadcasterMembers,
  decodeChannelMemberCursor,
  getChannelMemberForChannel,
  listChannelMembers,
  type ChannelMemberRecord,
} from "../db/channel-members";
import { fetchTwitchUsersById } from "../twitch/user-resolution";
import { type TwitchUser } from "../shoutout";
import { getAppAccessToken } from "../app-token";
import { helixRequest } from "../twitch/helix";
import { measureServerTiming } from "../server-timing";
import {
  changePlatformMember,
  changeFullConsent,
  decodePlatformAuditCursor,
  removePlatformMember,
  addPlatformMember,
  releasePlatformChannel,
  getPlatformChannel,
  listPlatformAudit,
  listPlatformChannels,
  listPlatformSpotifyAccess,
  setPlatformSpotifyAccess,
} from "./repository";
import { maintainEventSubSubscriptions } from "../eventsub-subscriptions";
import { CHANNEL_ROLES, PLATFORM_ASSIGNABLE_ROLES, type ChannelRole } from "../../contracts/values";
import { auditSubjectUserId } from "../../dashboard/audit/areas";
import { revokeRealtimeUser } from "../realtime";

interface PlatformEnvironment {
  Bindings: Env;
  Variables: PlatformAuthorizationVariables;
}

interface JsonRecord {
  [key: string]: unknown;
}

const roles = CHANNEL_ROLES;
const platformRoles = PLATFORM_ASSIGNABLE_ROLES;
const defaultAuditLimit = 50;
const maximumAuditLimit = 100;
const defaultMembersLimit = 100;
const maximumMembersLimit = 100;

const nowIso = (): string => new Date().toISOString();

const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJson = async (request: Request): Promise<JsonRecord | null> => {
  try {
    const value: unknown = await request.json();
    return isJsonRecord(value) ? value : null;
  } catch {
    return null;
  }
};

const readUserId = (value: unknown): string | null =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;

interface PlatformUserSuggestion extends TwitchUser {
  isLive?: boolean;
}

interface CachedPlatformUserSuggestions {
  expiresAt: number;
  response: { users: readonly PlatformUserSuggestion[]; partial: boolean };
}

interface HelixUsersResponse { data?: unknown }
interface HelixChannelsResponse { data?: unknown }

const PLATFORM_USER_SUGGESTION_TTL_MS = 60_000;
const PLATFORM_USER_SUGGESTION_CACHE_LIMIT = 1_000;
const PLATFORM_USER_SUGGESTION_LIMIT = 8;
const PLATFORM_USER_LOGIN_PATTERN = /^[A-Za-z0-9_]{1,25}$/u;
const platformUserSuggestionCache = new Map<string, CachedPlatformUserSuggestions>();

const platformSuggestionFromHelixUser = (value: unknown): PlatformUserSuggestion | null => {
  if (!isJsonRecord(value) || typeof value.id !== "string" || typeof value.login !== "string" || typeof value.display_name !== "string") return null;
  return {
    userId: value.id,
    login: value.login,
    displayName: value.display_name,
    profileImageUrl: typeof value.profile_image_url === "string" && value.profile_image_url.length > 0 ? value.profile_image_url : null,
  };
};

const platformSuggestionFromHelixChannel = (value: unknown): PlatformUserSuggestion | null => {
  if (!isJsonRecord(value) || typeof value.id !== "string" || typeof value.broadcaster_login !== "string" || typeof value.display_name !== "string") return null;
  return {
    userId: value.id,
    login: value.broadcaster_login,
    displayName: value.display_name,
    profileImageUrl: typeof value.thumbnail_url === "string" && value.thumbnail_url.length > 0 ? value.thumbnail_url : null,
    ...(typeof value.is_live === "boolean" ? { isLive: value.is_live } : {}),
  };
};

const readPlatformSuggestionCache = (query: string, now: number): CachedPlatformUserSuggestions | null => {
  const key = query.toLowerCase();
  const entry = platformUserSuggestionCache.get(key);
  if (entry === undefined) return null;
  if (entry.expiresAt <= now) {
    platformUserSuggestionCache.delete(key);
    return null;
  }
  return entry;
};

const writePlatformSuggestionCache = (query: string, response: CachedPlatformUserSuggestions["response"], now: number): void => {
  for (const [key, entry] of platformUserSuggestionCache) {
    if (entry.expiresAt <= now) platformUserSuggestionCache.delete(key);
  }
  const key = query.toLowerCase();
  platformUserSuggestionCache.delete(key);
  while (platformUserSuggestionCache.size >= PLATFORM_USER_SUGGESTION_CACHE_LIMIT) {
    const oldestKey = platformUserSuggestionCache.keys().next().value;
    if (oldestKey === undefined) break;
    platformUserSuggestionCache.delete(oldestKey);
  }
  platformUserSuggestionCache.set(key, { expiresAt: now + PLATFORM_USER_SUGGESTION_TTL_MS, response });
};

const readRole = (value: unknown): ChannelRole | null =>
  typeof value === "string" && roles.includes(value as ChannelRole)
    ? value as ChannelRole
    : null;

const readPlatformRole = (value: unknown): Exclude<ChannelRole, "broadcaster"> | null =>
  typeof value === "string" && platformRoles.includes(value as Exclude<ChannelRole, "broadcaster">)
    ? value as Exclude<ChannelRole, "broadcaster">
    : null;

const readBoolean = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;

const readLimit = (
  value: string | undefined,
  fallback: number,
  maximum: number,
): number | null => {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit > 0 && limit <= maximum ? limit : null;
};

const memberResponse = (member: ChannelMemberRecord, user?: TwitchUser) => ({
  userId: member.userId,
  login: user?.login ?? null,
  displayName: user?.displayName ?? null,
  profileImageUrl: user?.profileImageUrl ?? null,
  role: member.role,
  joinedAt: member.createdAt,
});

const broadcasterRoleDenied = (context: { json: (body: { error: string }, status: 403) => Response }): Response =>
  context.json({ error: "broadcaster_role_immutable" }, 403);

const mutationFailed = (context: { json: (body: { error: string }, status: 409) => Response }): Response =>
  context.json({ error: "mutation_failed" }, 409);

export const platformRouter = new Hono<PlatformEnvironment>();

platformRouter.use("/api/platform", requirePlatform());
platformRouter.use("/api/platform/*", requirePlatform());

platformRouter.get("/api/platform", async (context) =>
  context.json({ channels: await listPlatformChannels(context.env.DB) }));

platformRouter.get("/api/platform/spotify-channels", async (context) =>
  context.json(await listPlatformSpotifyAccess(context.env.DB)));

platformRouter.patch("/api/platform/spotify-channels/:channelId", async (context) => {
  const body = await readJson(context.req.raw);
  const enabled = readBoolean(body?.enabled);
  if (enabled === null) return context.json({ error: "spotify_access_invalid" }, 400);
  const channelId = context.req.param("channelId");
  if (await getPlatformChannel(context.env.DB, channelId) === null) return context.json({ error: "channel_not_found" }, 404);
  const result = await setPlatformSpotifyAccess(context.env.DB, context.get("actor"), channelId, enabled, nowIso());
  if (result === "limit") return context.json({ error: "spotify_access_limit" }, 409);
  return context.json({ enabled: result === "enabled" || result === "unchanged" && enabled });
});

platformRouter.get("/api/platform/twitch/user-suggestions", async (context) => {
  const query = context.req.query("q") ?? "";
  if (!PLATFORM_USER_LOGIN_PATTERN.test(query)) return context.json({ error: "twitch_user_query_invalid" }, 400);
  const now = Date.now();
  const cached = readPlatformSuggestionCache(query, now);
  if (cached !== null) return context.json(cached.response);

  let partial = false;
  let exactUsers: Array<PlatformUserSuggestion | null> = [];
  let channelUsers: Array<PlatformUserSuggestion | null> = [];
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
      helixRequest<HelixChannelsResponse>({
        url: "https://api.twitch.tv/helix/search/channels",
        query: { query, first: "8" },
        accessToken,
        clientId: context.env.TWITCH_CLIENT_ID,
        fetcher: fetch,
      }),
    ]);
    if (exactResult.ok && Array.isArray(exactResult.data.data)) exactUsers = exactResult.data.data.map(platformSuggestionFromHelixUser);
    else partial = true;
    if (searchResult.ok && Array.isArray(searchResult.data.data)) channelUsers = searchResult.data.data.map(platformSuggestionFromHelixChannel);
    else partial = true;
  } catch {
    partial = true;
  }

  const users: PlatformUserSuggestion[] = [];
  const seen = new Set<string>();
  for (const candidate of [...exactUsers, ...channelUsers]) {
    if (candidate === null || seen.has(candidate.userId)) continue;
    seen.add(candidate.userId);
    users.push(candidate);
    if (users.length >= PLATFORM_USER_SUGGESTION_LIMIT) break;
  }
  const response = { users, partial };
  writePlatformSuggestionCache(query, response, now);
  return context.json(response);
});

platformRouter.post("/api/platform/channels", async (context) => {
  const body = await readJson(context.req.raw);
  const userValue = body?.user;
  const user: TwitchUser | null = isJsonRecord(userValue) &&
      readUserId(userValue.userId) !== null && typeof userValue.login === "string" && PLATFORM_USER_LOGIN_PATTERN.test(userValue.login) &&
      typeof userValue.displayName === "string" && userValue.displayName.trim().length > 0 && userValue.displayName.length <= 100 &&
      (userValue.profileImageUrl === null || typeof userValue.profileImageUrl === "string")
    ? {
      userId: userValue.userId as string,
      login: userValue.login,
      displayName: userValue.displayName,
      profileImageUrl: userValue.profileImageUrl,
    }
    : null;
  const fullConsent = readBoolean(body?.fullConsent);
  if (user === null || fullConsent === null) {
    return context.json({ error: "release_input_invalid" }, 400);
  }

  try {
    const released = await releasePlatformChannel(
      context.env.DB,
      context.get("actor"),
      user,
      fullConsent,
      nowIso(),
    );
    if (!released) return context.json({ error: "channel_already_released" }, 409);
    try {
      await maintainEventSubSubscriptions(context.env, nowIso(), fetch, user.userId);
    } catch {
      // A maintenance failure does not undo the completed channel release.
    }
  } catch {
    return context.json({ error: "channel_release_failed" }, 409);
  }
  return context.json({
    channel: {
      channelId: user.userId,
      login: user.login,
      displayName: user.displayName,
      fullConsent: fullConsent,
    },
  }, 201);
});

platformRouter.patch("/api/platform/channels/:channelId", async (context) => {
  const body = await readJson(context.req.raw);
  const fullConsent = readBoolean(body?.fullConsent);
  if (fullConsent === null) return context.json({ error: "full_consent_invalid" }, 400);

  const channel = await getPlatformChannel(context.env.DB, context.req.param("channelId"));
  if (channel === null) return context.json({ error: "channel_not_found" }, 404);
  if (channel.fullConsent === fullConsent) {
    return context.json({ error: "full_consent_already_set" }, 400);
  }

  const changed = await changeFullConsent(
    context.env.DB,
    context.get("actor"),
    channel,
    fullConsent,
    nowIso(),
  );
  if (!changed) return mutationFailed(context);
  return context.json({ channel: { ...channel, fullConsent: fullConsent } });
});

platformRouter.get("/api/platform/channels/:channelId/members", async (context) => {
  const limit = readLimit(context.req.query("limit"), defaultMembersLimit, maximumMembersLimit);
  if (limit === null) return context.json({ error: "pagination_limit_invalid" }, 400);
  const serializedCursor = context.req.query("cursor");
  const cursor = serializedCursor === undefined
    ? null
    : decodeChannelMemberCursor(serializedCursor);
  if (serializedCursor !== undefined && cursor === null) {
    return context.json({ error: "pagination_cursor_invalid" }, 400);
  }

  const channelId = context.req.param("channelId");
  const [page, broadcasterCount] = await measureServerTiming(context, "d1", () => Promise.all([
    listChannelMembers(context.env.DB, channelId, limit, cursor),
    countBroadcasterMembers(context.env.DB, channelId),
  ]));
  const names = await measureServerTiming(context, "helix", () => fetchTwitchUsersById(fetch, context.env, page.members.map((member) => member.userId)));
  return context.json({
    members: page.members.map((member) => memberResponse(member, names.get(member.userId))),
    nextCursor: page.nextCursor,
    broadcasterCount,
    viewerUserId: context.get("session").userId,
  });
});

platformRouter.post("/api/platform/channels/:channelId/members", async (context) => {
  const body = await readJson(context.req.raw);
  const userId = readUserId(body?.userId);
  const role = readRole(body?.role);
  if (userId === null || role === null) return context.json({ error: "member_or_role_invalid" }, 400);
  if (role === "broadcaster") return broadcasterRoleDenied(context);

  const channelId = context.req.param("channelId");
  if (await getPlatformChannel(context.env.DB, channelId) === null) {
    return context.json({ error: "channel_not_found" }, 404);
  }
  const existing = await getChannelMemberForChannel(context.env.DB, channelId, userId);
  if (existing !== null) {
    return existing.role === "broadcaster"
      ? broadcasterRoleDenied(context)
      : context.json({ error: "member_already_exists" }, 409);
  }

  const timestamp = nowIso();
  const member: ChannelMemberRecord = {
    channelId: channelId,
    userId,
    role,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const changed = await addPlatformMember(
    context.env.DB,
    context.get("actor"),
    member,
    timestamp,
  );
  if (!changed) return mutationFailed(context);
  return context.json({ member: memberResponse(member) }, 201);
});

platformRouter.patch("/api/platform/channels/:channelId/members/:userId", async (context) => {
  const body = await readJson(context.req.raw);
  const role = readPlatformRole(body?.role);
  if (role === null) {
    return typeof body?.role === "string" && body.role === "broadcaster"
      ? broadcasterRoleDenied(context)
      : context.json({ error: "role_invalid" }, 400);
  }

  const channelId = context.req.param("channelId");
  const userId = context.req.param("userId");
  const existing = await getChannelMemberForChannel(context.env.DB, channelId, userId);
  if (existing === null) return context.json({ error: "member_not_found" }, 404);
  if (existing.role === "broadcaster") return broadcasterRoleDenied(context);
  if (existing.role === role) return context.json({ error: "role_already_set" }, 400);

  const timestamp = nowIso();
  const changed = await changePlatformMember(
    context.env.DB,
    context.get("actor"),
    existing,
    { ...existing, role, updatedAt: timestamp },
    timestamp,
  );
  if (!changed) return mutationFailed(context);
  await revokeRealtimeUser(context.env.CHANNEL, channelId, userId);
  return context.json({
    member: memberResponse({ ...existing, role, updatedAt: timestamp }),
  });
});

platformRouter.delete("/api/platform/channels/:channelId/members/:userId", async (context) => {
  const channelId = context.req.param("channelId");
  const userId = context.req.param("userId");
  const existing = await getChannelMemberForChannel(context.env.DB, channelId, userId);
  if (existing === null) return context.json({ error: "member_not_found" }, 404);
  if (existing.role === "broadcaster") return broadcasterRoleDenied(context);

  const removed = await removePlatformMember(
    context.env.DB,
    context.get("actor"),
    existing,
    nowIso(),
  );
  if (!removed) return mutationFailed(context);
  await revokeRealtimeUser(context.env.CHANNEL, channelId, userId);
  return context.body(null, 204);
});

platformRouter.get("/api/platform/audit", async (context) => {
  const limit = readLimit(context.req.query("limit"), defaultAuditLimit, maximumAuditLimit);
  if (limit === null) return context.json({ error: "pagination_limit_invalid" }, 400);
  const serializedCursor = context.req.query("cursor");
  const cursor = serializedCursor === undefined
    ? null
    : decodePlatformAuditCursor(serializedCursor);
  if (serializedCursor !== undefined && cursor === null) {
    return context.json({ error: "pagination_cursor_invalid" }, 400);
  }
  const audit = await listPlatformAudit(context.env.DB, limit, cursor);
  const subjectIds = audit.entries.flatMap((entry) => {
    const subjectId = auditSubjectUserId(entry.action, entry.before, entry.after);
    return subjectId === null ? [] : [subjectId];
  });
  const userIds = [...new Set([...audit.entries.map((entry) => entry.actorUserId), ...subjectIds])];
  const users = await fetchTwitchUsersById(fetch, context.env, userIds);
  return context.json({
    ...audit,
    entries: audit.entries.map((entry) => {
      const actor = users.get(entry.actorUserId);
      const subjectId = auditSubjectUserId(entry.action, entry.before, entry.after);
      const subject = subjectId === null ? undefined : users.get(subjectId);
      return {
        ...entry,
        actorLogin: actor?.login ?? null,
        actorDisplayName: actor?.displayName ?? null,
        ...(subjectId === null ? {} : {
          subjectUserId: subjectId,
          subjectLogin: subject?.login ?? null,
          subjectDisplayName: subject?.displayName ?? null,
        }),
      };
    }),
  });
});
