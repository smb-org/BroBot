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
import {
  fetchTwitchUserByLogin,
  fetchTwitchUsersById,
  type TwitchUser,
} from "../panel/member-routes";
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
} from "./repository";
import { maintainEventSubSubscriptions } from "../eventsub-subscriptions";
import { CHANNEL_ROLES, PLATFORM_ASSIGNABLE_ROLES, type ChannelRole } from "../../contracts/values";

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

const readLogin = (value: string | undefined): string | null => {
  const login = value?.trim() ?? "";
  return login.length > 0 && login.length <= 25 && !/\s/.test(login) ? login : null;
};

const readUserId = (value: unknown): string | null =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;

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

platformRouter.get("/api/platform/users", async (context) => {
  const login = readLogin(context.req.query("login"));
  if (login === null) return context.json({ error: "twitch_login_invalid" }, 400);
  try {
    const user = await fetchTwitchUserByLogin(fetch, context.env, login);
    return user === null
      ? context.json({ error: "twitch_user_not_found" }, 404)
      : context.json({ user: user });
  } catch {
    return context.json({ error: "twitch_user_search_failed" }, 502);
  }
});

platformRouter.post("/api/platform/channels", async (context) => {
  const body = await readJson(context.req.raw);
  const login = typeof body?.login === "string" ? readLogin(body.login) : null;
  const fullConsent = readBoolean(body?.fullConsent);
  if (login === null || fullConsent === null) {
    return context.json({ error: "release_input_invalid" }, 400);
  }

  let user: TwitchUser | null;
  try {
    user = await fetchTwitchUserByLogin(fetch, context.env, login);
  } catch {
    return context.json({ error: "twitch_user_search_failed" }, 502);
  }
  if (user === null) return context.json({ error: "twitch_user_not_found" }, 404);

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
  const page = await listChannelMembers(context.env.DB, channelId, limit, cursor);
  const names = await fetchTwitchUsersById(fetch, context.env, page.members.map((member) => member.userId));
  return context.json({
    members: page.members.map((member) => memberResponse(member, names.get(member.userId))),
    nextCursor: page.nextCursor,
    broadcasterCount: await countBroadcasterMembers(context.env.DB, channelId),
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
  const actorIds = audit.entries.map((entry) => entry.actorUserId);
  const actors = await fetchTwitchUsersById(fetch, context.env, actorIds);
  return context.json({
    ...audit,
    entries: audit.entries.map((entry) => {
      const actor = actors.get(entry.actorUserId);
      return {
        ...entry,
        actorLogin: actor?.login ?? null,
        actorDisplayName: actor?.displayName ?? null,
      };
    }),
  });
});
