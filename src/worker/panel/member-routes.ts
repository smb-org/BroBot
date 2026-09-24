import { Hono } from "hono";

import {
  countBroadcasterMembers,
  createChannelMemberWithAudit,
  decodeChannelMemberCursor,
  deleteChannelMemberWithAudit,
  getChannelMemberForChannel,
  listChannelMembers,
  updateChannelMemberWithAudit,
  type ChannelMemberRecord,
} from "../db/channel-members";
import {
  actorGuard,
  requiredActorRoles,
} from "../db/guards";
import {
  requireChannelAuthorization,
  type ChannelAuthorizationVariables,
} from "../auth/guards";
import { CHANNEL_ROLES, canManage, type AuditAction, type ChannelRole } from "../../contracts/values";
import { revokeRealtimeUser } from "../realtime";
import { fetchTwitchUserByLogin, type TwitchUser } from "../shoutout";
import { fetchTwitchUsersById } from "../twitch/user-resolution";

interface MemberRouteEnvironment {
  Bindings: Env;
  Variables: ChannelAuthorizationVariables;
}

interface JsonRecord {
  [key: string]: unknown;
}

const roles = CHANNEL_ROLES;
const roleRank: Record<ChannelRole, number> = {
  operator: 0,
  manager: 1,
  broadcaster: 2,
};

const DEFAULT_MEMBER_LIMIT = 100;
const MAX_MEMBER_LIMIT = 100;

const nowIso = (): string => new Date().toISOString();

export const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const readJsonBody = async (request: Request): Promise<JsonRecord | null> => {
  try {
    const value: unknown = await request.json();
    return isJsonRecord(value) ? value : null;
  } catch {
    return null;
  }
};

const readRole = (value: unknown): ChannelRole | null =>
  typeof value === "string" && roles.includes(value as ChannelRole)
    ? value as ChannelRole
    : null;

const readUserId = (value: unknown): string | null =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;

const memberResponse = (member: ChannelMemberRecord, user?: TwitchUser) => ({
  userId: member.userId,
  login: user?.login ?? null,
  displayName: user?.displayName ?? null,
  profileImageUrl: user?.profileImageUrl ?? null,
  role: member.role,
  joinedAt: member.createdAt,
});

const canManageMembers = canManage;

/**
 * Only a broadcaster may grant or revoke the `broadcaster` role. Otherwise
 * a manager could turn a second account into a broadcaster and then remove
 * the original broadcaster — the last-broadcaster protection wouldn't apply
 * at that point, because two exist in the meantime.
 *
 * This check only produces the readable error message; the rule is
 * authoritatively enforced in the mutation itself.
 */
const mayAssignRole = (
  actorRole: ChannelRole,
  targetRole: ChannelRole | undefined,
  existingRole?: ChannelRole,
): boolean => (targetRole !== "broadcaster" && existingRole !== "broadcaster") || actorRole === "broadcaster";

const broadcasterRoleDenied = (context: { json: (body: { error: string }, status: 403) => Response }): Response =>
  context.json({ error: "broadcaster_role_change_requires_broadcaster" }, 403);

export const actorOf = (context: { get: (key: "session") => { userId: string; sessionId: string } }) => ({
  userId: context.get("session").userId,
  sessionId: context.get("session").sessionId,
});

const memberResponseWithNames = (
  member: ChannelMemberRecord,
  names: Map<string, TwitchUser>,
) => memberResponse(member, names.get(member.userId));

const searchLogin = (value: string | undefined): string | null => {
  const login = value?.trim() ?? "";
  return login.length > 0 && login.length <= 25 && !/\s/.test(login) ? login : null;
};

const parseMemberLimit = (value: string | undefined): number | null => {
  if (value === undefined) return DEFAULT_MEMBER_LIMIT;
  if (!/^\d+$/.test(value)) return null;
  const limit = Number(value);
  return Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_MEMBER_LIMIT ? limit : null;
};

const manageDenied = (context: { json: (body: { error: string }, status: 403) => Response }): Response =>
  context.json({ error: "member_management_denied" }, 403);

const lastBroadcaster = async (
  db: D1Database,
  channelId: string,
  currentRole: ChannelRole,
  nextRole?: ChannelRole,
): Promise<boolean> => currentRole === "broadcaster" &&
  (nextRole === undefined || nextRole !== "broadcaster") &&
  await countBroadcasterMembers(db, channelId) <= 1;

export const memberRouter = new Hono<MemberRouteEnvironment>();

memberRouter.use("/api/channels/:channelId/members", requireChannelAuthorization());
memberRouter.use("/api/channels/:channelId/members/*", requireChannelAuthorization());

memberRouter.get("/api/channels/:channelId/members", async (context) => {
  const channelId = context.req.param("channelId");
  const limit = parseMemberLimit(context.req.query("limit"));
  if (limit === null) return context.json({ error: "pagination_limit_invalid" }, 400);
  const serializedCursor = context.req.query("cursor");
  const cursor = serializedCursor === undefined ? null : decodeChannelMemberCursor(serializedCursor);
  if (serializedCursor !== undefined && cursor === null) return context.json({ error: "pagination_cursor_invalid" }, 400);
  const page = await listChannelMembers(context.env.DB, channelId, limit, cursor);
  const names = await fetchTwitchUsersById(fetch, context.env, page.members.map((member) => member.userId));
  const broadcasterCount = await countBroadcasterMembers(context.env.DB, channelId);
  return context.json({
    members: page.members.map((member) => memberResponseWithNames(member, names)),
    nextCursor: page.nextCursor,
    broadcasterCount,
    viewerUserId: context.get("session").userId,
  });
});

memberRouter.get("/api/channels/:channelId/members/search", async (context) => {
  if (!canManageMembers(context.get("channelRole"))) return manageDenied(context);
  const login = searchLogin(context.req.query("login"));
  if (login === null) return context.json({ error: "twitch_login_invalid" }, 400);
  try {
    const user = await fetchTwitchUserByLogin(fetch, context.env, login);
    if (user === null) return context.json({ error: "twitch_user_not_found" }, 404);
    return context.json({ user });
  } catch {
    return context.json({ error: "twitch_user_search_failed" }, 502);
  }
});

memberRouter.post("/api/channels/:channelId/members", async (context) => {
  const channelRole = context.get("channelRole");
  if (!canManageMembers(channelRole)) return manageDenied(context);

  const body = await readJsonBody(context.req.raw);
  const userId = readUserId(body?.userId);
  const role = readRole(body?.role);
  if (userId === null || role === null) return context.json({ error: "member_or_role_invalid" }, 400);

  const channelId = context.req.param("channelId");
  if (userId === context.get("session").userId) {
    return context.json({ error: "self_membership_denied" }, 403);
  }
  if (!mayAssignRole(channelRole, role)) return broadcasterRoleDenied(context);
  const existing = await getChannelMemberForChannel(context.env.DB, channelId, userId);
  if (existing !== null) return context.json({ error: "member_already_exists" }, 409);

  const now = nowIso();
  const member: ChannelMemberRecord = {
    channelId,
    userId,
    role,
    createdAt: now,
    updatedAt: now,
  };
  const changed = await createChannelMemberWithAudit(
    context.env.DB,
    actorOf(context),
    member,
    "member.added" satisfies AuditAction,
    now,
    actorGuard(requiredActorRoles(member.role)),
  );
  if (!changed) return context.json({ error: "member_add_failed" }, 409);
  return context.json({ member: memberResponse(member) }, 201);
});

memberRouter.patch("/api/channels/:channelId/members/:userId", async (context) => {
  const channelRole = context.get("channelRole");
  if (!canManageMembers(channelRole)) return manageDenied(context);

  const body = await readJsonBody(context.req.raw);
  const role = readRole(body?.role);
  if (role === null) return context.json({ error: "role_invalid" }, 400);

  const channelId = context.req.param("channelId");
  const userId = context.req.param("userId");
  const existing = await getChannelMemberForChannel(context.env.DB, channelId, userId);
  if (existing === null) return context.json({ error: "member_not_found" }, 404);
  if (existing.role === role) return context.json({ error: "role_already_set" }, 400);
  if (userId === context.get("session").userId && roleRank[role] > roleRank[existing.role]) {
    return context.json({ error: "self_role_escalation_denied" }, 403);
  }
  if (!mayAssignRole(channelRole, role, existing.role)) return broadcasterRoleDenied(context);
  if (await lastBroadcaster(context.env.DB, channelId, existing.role, role)) {
    return context.json({ error: "last_broadcaster_cannot_be_demoted" }, 409);
  }

  const now = nowIso();
  const member: ChannelMemberRecord = { ...existing, role, updatedAt: now };
  const changed = await updateChannelMemberWithAudit(
    context.env.DB,
    actorOf(context),
    member,
    "member.role_changed" satisfies AuditAction,
    now,
    actorGuard(requiredActorRoles(member.role, existing.role)),
  );
  if (!changed) return context.json({ error: "member_changed_concurrently" }, 409);
  void revokeRealtimeUser(context.env.CHANNEL, channelId, userId);
  return context.json({ member: memberResponse(member) });
});

memberRouter.delete("/api/channels/:channelId/members/:userId", async (context) => {
  const channelRole = context.get("channelRole");
  if (!canManageMembers(channelRole)) return manageDenied(context);

  const channelId = context.req.param("channelId");
  const userId = context.req.param("userId");
  const existing = await getChannelMemberForChannel(context.env.DB, channelId, userId);
  if (existing === null) return context.json({ error: "member_not_found" }, 404);
  if (!mayAssignRole(channelRole, undefined, existing.role)) return broadcasterRoleDenied(context);
  if (await lastBroadcaster(context.env.DB, channelId, existing.role)) {
    return context.json({ error: "last_broadcaster_cannot_be_removed" }, 409);
  }

  const changed = await deleteChannelMemberWithAudit(
    context.env.DB,
    actorOf(context),
    channelId,
    userId,
    "member.removed" satisfies AuditAction,
    nowIso(),
    actorGuard(requiredActorRoles(undefined, existing.role)),
  );
  if (!changed) return context.json({ error: "member_changed_concurrently" }, 409);
  void revokeRealtimeUser(context.env.CHANNEL, channelId, userId);
  return context.body(null, 204);
});
