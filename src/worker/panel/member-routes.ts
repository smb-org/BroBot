import { Hono } from "hono";

import { decryptJson, parseKeyRing } from "../auth/crypto";
import {
  countBroadcasterMembers,
  createChannelMemberWithAudit,
  decodeChannelMemberCursor,
  deleteChannelMemberWithAudit,
  getBotIdentity,
  getChannelMemberForChannel,
  listChannelMembers,
  updateChannelMemberWithAudit,
  type ChannelMemberRecord,
} from "../auth/repository";
import {
  requireChannelAuthorization,
  type ChannelAuthorizationVariables,
} from "../auth/guards";
import type { ChannelMemberRole } from "../auth/authorization";

interface MemberRouteEnvironment {
  Bindings: Env;
  Variables: ChannelAuthorizationVariables;
}

interface JsonRecord {
  [key: string]: unknown;
}

interface TwitchUser {
  userId: string;
  login: string;
  displayName: string;
}

const roles: readonly ChannelMemberRole[] = ["broadcaster", "verwalter", "bediener"];
const roleRank: Record<ChannelMemberRole, number> = {
  bediener: 0,
  verwalter: 1,
  broadcaster: 2,
};

const DEFAULT_MEMBER_LIMIT = 100;
const MAX_MEMBER_LIMIT = 100;
const HELIX_TIMEOUT_MS = 5_000;

const nowIso = (): string => new Date().toISOString();

const isJsonRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readJsonBody = async (request: Request): Promise<JsonRecord | null> => {
  try {
    const value: unknown = await request.json();
    return isJsonRecord(value) ? value : null;
  } catch {
    return null;
  }
};

const readRole = (value: unknown): ChannelMemberRole | null =>
  typeof value === "string" && roles.includes(value as ChannelMemberRole)
    ? value as ChannelMemberRole
    : null;

const readUserId = (value: unknown): string | null =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;

const memberResponse = (member: ChannelMemberRecord, user?: TwitchUser) => ({
  userId: member.userId,
  login: user?.login ?? null,
  displayName: user?.displayName ?? null,
  role: member.role,
  joinedAt: member.createdAt,
});

const canManageMembers = (role: ChannelMemberRole): boolean => role !== "bediener";

/**
 * Nur ein Broadcaster darf die Rolle `broadcaster` vergeben. Sonst koennte ein
 * Verwalter ein Zweitkonto zum Broadcaster machen und danach den urspruenglichen
 * Broadcaster entfernen — der Schutz des letzten Broadcasters greift dann nicht,
 * weil zwischenzeitlich zwei existieren.
 *
 * Diese Pruefung liefert nur die verstaendliche Fehlermeldung; verbindlich
 * durchgesetzt wird die Regel in der Mutation selbst.
 */
const mayAssignRole = (
  actorRole: ChannelMemberRole,
  targetRole: ChannelMemberRole,
): boolean => targetRole !== "broadcaster" || actorRole === "broadcaster";

const assignDenied = (context: { text: (body: string, status: 403) => Response }): Response =>
  context.text("Nur ein Broadcaster darf die Rolle Broadcaster vergeben.", 403);

const actorOf = (context: { get: (key: "session") => { userId: string; sessionId: string } }) => ({
  userId: context.get("session").userId,
  sessionId: context.get("session").sessionId,
});

const readStoredBotAccessToken = async (environment: Env): Promise<string | null> => {
  const identity = await getBotIdentity(environment.DB);
  if (identity === null) return null;
  const value = await decryptJson<{ token?: unknown }>(
    identity.accessTokenCiphertext,
    parseKeyRing(environment.SESSION_ENCRYPTION_KEYS),
  );
  return value !== null && typeof value.token === "string" && value.token.length > 0
    ? value.token
    : null;
};

const readResponseJson = async (response: Response): Promise<Record<string, unknown>> => {
  try {
    const value: unknown = await response.json();
    return isJsonRecord(value) ? value : {};
  } catch {
    return {};
  }
};

const fetchWithTimeout = async (
  fetcher: typeof fetch,
  input: string,
  init: RequestInit,
): Promise<Response> => {
  const controller = new AbortController();
  const timeout = setTimeout(() => { controller.abort(); }, HELIX_TIMEOUT_MS);
  try {
    return await fetcher(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
};

const fetchTwitchUserByLogin = async (
  fetcher: typeof fetch,
  environment: Env,
  login: string,
): Promise<TwitchUser | null> => {
  const accessToken = await readStoredBotAccessToken(environment);
  if (accessToken === null) throw new Error("Bot-Token für Twitch-Nutzersuche fehlt.");

  const url = new URL("https://api.twitch.tv/helix/users");
  url.searchParams.set("login", login);
  const response = await fetchWithTimeout(fetcher, url.toString(), {
    headers: {
      "Client-ID": environment.TWITCH_CLIENT_ID,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const body = await readResponseJson(response);
  if (!response.ok) throw new Error("Twitch-Nutzersuche ist fehlgeschlagen.");
  if (!Array.isArray(body.data)) return null;

  const first = (body.data as unknown[])[0];
  if (!isJsonRecord(first) || typeof first.id !== "string" || typeof first.login !== "string" ||
      typeof first.display_name !== "string") return null;
  return { userId: first.id, login: first.login, displayName: first.display_name };
};

const fetchTwitchUsersById = async (
  fetcher: typeof fetch,
  environment: Env,
  userIds: string[],
): Promise<Map<string, TwitchUser>> => {
  const resolved = new Map<string, TwitchUser>();
  if (userIds.length === 0) return resolved;

  try {
    const accessToken = await readStoredBotAccessToken(environment);
    if (accessToken === null) return resolved;
    for (let offset = 0; offset < userIds.length; offset += 100) {
      const url = new URL("https://api.twitch.tv/helix/users");
      for (const userId of userIds.slice(offset, offset + 100)) url.searchParams.append("id", userId);
      const response = await fetchWithTimeout(fetcher, url.toString(), {
        headers: {
          "Client-ID": environment.TWITCH_CLIENT_ID,
          Authorization: `Bearer ${accessToken}`,
        },
      });
      if (!response.ok) break;
      const body = await readResponseJson(response);
      if (!Array.isArray(body.data)) break;
      for (const entry of body.data as unknown[]) {
        if (!isJsonRecord(entry) || typeof entry.id !== "string" || typeof entry.login !== "string" ||
            typeof entry.display_name !== "string") continue;
        resolved.set(entry.id, {
          userId: entry.id,
          login: entry.login,
          displayName: entry.display_name,
        });
      }
    }
  } catch {
    return resolved;
  }
  return resolved;
};

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

const manageDenied = (context: { text: (body: string, status: 403) => Response }): Response =>
  context.text("Nur Broadcaster und Verwalter dürfen Mitglieder ändern.", 403);

const lastBroadcaster = async (
  db: D1Database,
  channelId: string,
  currentRole: ChannelMemberRole,
  nextRole?: ChannelMemberRole,
): Promise<boolean> => currentRole === "broadcaster" &&
  (nextRole === undefined || nextRole !== "broadcaster") &&
  await countBroadcasterMembers(db, channelId) <= 1;

export const memberRouter = new Hono<MemberRouteEnvironment>();

memberRouter.use("/api/channels/:channelId/members", requireChannelAuthorization());
memberRouter.use("/api/channels/:channelId/members/*", requireChannelAuthorization());

memberRouter.get("/api/channels/:channelId/members", async (context) => {
  const channelId = context.req.param("channelId");
  const limit = parseMemberLimit(context.req.query("limit"));
  if (limit === null) return context.text("Mitglieder-Begrenzung ist ungültig.", 400);
  const serializedCursor = context.req.query("cursor");
  const cursor = serializedCursor === undefined ? null : decodeChannelMemberCursor(serializedCursor);
  if (serializedCursor !== undefined && cursor === null) return context.text("Mitglieder-Cursor ist ungültig.", 400);
  const page = await listChannelMembers(context.env.DB, channelId, limit, cursor);
  const names = await fetchTwitchUsersById(fetch, context.env, page.members.map((member) => member.userId));
  return context.json({ members: page.members.map((member) => memberResponseWithNames(member, names)), nextCursor: page.nextCursor });
});

memberRouter.get("/api/channels/:channelId/members/search", async (context) => {
  if (!canManageMembers(context.get("channelRole"))) return manageDenied(context);
  const login = searchLogin(context.req.query("login"));
  if (login === null) return context.text("Twitch-Name fehlt oder ist ungültig.", 400);
  try {
    const user = await fetchTwitchUserByLogin(fetch, context.env, login);
    if (user === null) return context.text("Twitch-Nutzer nicht gefunden.", 404);
    return context.json({ user });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Twitch-Nutzersuche ist fehlgeschlagen.";
    return context.text(message, 502);
  }
});

memberRouter.post("/api/channels/:channelId/members", async (context) => {
  const channelRole = context.get("channelRole");
  if (!canManageMembers(channelRole)) return manageDenied(context);

  const body = await readJsonBody(context.req.raw);
  const userId = readUserId(body?.userId);
  const role = readRole(body?.role);
  if (userId === null || role === null) return context.text("Mitglied oder Rolle ist ungültig.", 400);

  const channelId = context.req.param("channelId");
  if (userId === context.get("session").userId) {
    return context.text("Du kannst deine eigene Mitgliedschaft nicht per POST anlegen.", 403);
  }
  if (!mayAssignRole(channelRole, role)) return assignDenied(context);
  const existing = await getChannelMemberForChannel(context.env.DB, channelId, userId);
  if (existing !== null) return context.text("Dieses Mitglied ist bereits freigegeben.", 409);

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
    "mitglied.hinzugefügt",
    now,
  );
  if (!changed) return context.text("Mitglied konnte nicht hinzugefügt werden.", 409);
  return context.json({ member: memberResponse(member) }, 201);
});

memberRouter.patch("/api/channels/:channelId/members/:userId", async (context) => {
  const channelRole = context.get("channelRole");
  if (!canManageMembers(channelRole)) return manageDenied(context);

  const body = await readJsonBody(context.req.raw);
  const role = readRole(body?.role);
  if (role === null) return context.text("Rolle ist ungültig.", 400);

  const channelId = context.req.param("channelId");
  const userId = context.req.param("userId");
  const existing = await getChannelMemberForChannel(context.env.DB, channelId, userId);
  if (existing === null) return context.text("Mitglied nicht gefunden.", 404);
  if (existing.role === role) return context.text("Diese Rolle ist bereits gesetzt.", 400);
  if (userId === context.get("session").userId && roleRank[role] > roleRank[existing.role]) {
    return context.text("Du kannst deine eigene Rolle nicht erhöhen.", 403);
  }
  if (!mayAssignRole(channelRole, role)) return assignDenied(context);
  if (await lastBroadcaster(context.env.DB, channelId, existing.role, role)) {
    return context.text("Der letzte Broadcaster kann nicht herabgestuft werden.", 409);
  }

  const now = nowIso();
  const member: ChannelMemberRecord = { ...existing, role, updatedAt: now };
  const changed = await updateChannelMemberWithAudit(
    context.env.DB,
    actorOf(context),
    member,
    "mitglied.rolle_geändert",
    now,
  );
  if (!changed) return context.text("Mitglied wurde inzwischen geändert.", 409);
  return context.json({ member: memberResponse(member) });
});

memberRouter.delete("/api/channels/:channelId/members/:userId", async (context) => {
  const channelRole = context.get("channelRole");
  if (!canManageMembers(channelRole)) return manageDenied(context);

  const channelId = context.req.param("channelId");
  const userId = context.req.param("userId");
  const existing = await getChannelMemberForChannel(context.env.DB, channelId, userId);
  if (existing === null) return context.text("Mitglied nicht gefunden.", 404);
  if (await lastBroadcaster(context.env.DB, channelId, existing.role)) {
    return context.text("Der letzte Broadcaster kann nicht entfernt werden.", 409);
  }

  const changed = await deleteChannelMemberWithAudit(
    context.env.DB,
    actorOf(context),
    channelId,
    userId,
    "mitglied.entfernt",
    nowIso(),
  );
  if (!changed) return context.text("Mitglied wurde inzwischen geändert.", 409);
  return context.body(null, 204);
});
