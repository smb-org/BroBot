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
import { CHANNEL_ROLES, type ChannelRole } from "../../contracts/values";

interface PlatformEnvironment {
  Bindings: Env;
  Variables: PlatformAuthorizationVariables;
}

interface JsonDatensatz {
  [key: string]: unknown;
}

const rollen = CHANNEL_ROLES;
const platformRoles = CHANNEL_ROLES.filter((rolle): rolle is Exclude<ChannelRole, "broadcaster"> => rolle !== "broadcaster");
const standardAuditLimit = 50;
const maximaleAuditLimit = 100;
const defaultMembersLimit = 100;
const maximumMembersLimit = 100;

const jetztIso = (): string => new Date().toISOString();

const istJsonDatensatz = (value: unknown): value is JsonDatensatz =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const leseJson = async (request: Request): Promise<JsonDatensatz | null> => {
  try {
    const value: unknown = await request.json();
    return istJsonDatensatz(value) ? value : null;
  } catch {
    return null;
  }
};

const leseLogin = (value: string | undefined): string | null => {
  const login = value?.trim() ?? "";
  return login.length > 0 && login.length <= 25 && !/\s/.test(login) ? login : null;
};

const leseUserId = (value: unknown): string | null =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;

const leseRolle = (value: unknown): ChannelRole | null =>
  typeof value === "string" && rollen.includes(value as ChannelRole)
    ? value as ChannelRole
    : null;

const readPlatformRole = (value: unknown): Exclude<ChannelRole, "broadcaster"> | null =>
  typeof value === "string" && platformRoles.includes(value as Exclude<ChannelRole, "broadcaster">)
    ? value as Exclude<ChannelRole, "broadcaster">
    : null;

const leseBoolean = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;

const leseLimit = (
  value: string | undefined,
  standard: number,
  maximum: number,
): number | null => {
  if (value === undefined) return standard;
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

const rolleBroadcasterVerweigert = (kontext: { text: (text: string, status: 403) => Response }): Response =>
  kontext.text("Die Rolle Broadcaster darf auf der Betreiberebene nicht geändert werden.", 403);

const mutationFehlgeschlagen = (kontext: { text: (text: string, status: 409) => Response }): Response =>
  kontext.text("Die Änderung konnte nicht durchgeführt werden.", 409);

export const platformRouter = new Hono<PlatformEnvironment>();

platformRouter.use("/api/platform", requirePlatform());
platformRouter.use("/api/platform/*", requirePlatform());

platformRouter.get("/api/platform", async (kontext) =>
  kontext.json({ channels: await listPlatformChannels(kontext.env.DB) }));

platformRouter.get("/api/platform/users", async (kontext) => {
  const login = leseLogin(kontext.req.query("login"));
  if (login === null) return kontext.text("Twitch-Name fehlt oder ist ungültig.", 400);
  try {
    const user = await fetchTwitchUserByLogin(fetch, kontext.env, login);
    return user === null
      ? kontext.text("Twitch-Nutzer nicht gefunden.", 404)
      : kontext.json({ user: user });
  } catch (error: unknown) {
    const meldung = error instanceof Error ? error.message : "Twitch-Nutzersuche ist fehlgeschlagen.";
    return kontext.text(meldung, 502);
  }
});

platformRouter.post("/api/platform/channels", async (kontext) => {
  const rumpf = await leseJson(kontext.req.raw);
  const login = typeof rumpf?.login === "string" ? leseLogin(rumpf.login) : null;
  const fullConsent = leseBoolean(rumpf?.fullConsent);
  if (login === null || fullConsent === null) {
    return kontext.text("Login oder Vollzustimmung ist ungültig.", 400);
  }

  let user: TwitchUser | null;
  try {
    user = await fetchTwitchUserByLogin(fetch, kontext.env, login);
  } catch (error: unknown) {
    const meldung = error instanceof Error ? error.message : "Twitch-Nutzersuche ist fehlgeschlagen.";
    return kontext.text(meldung, 502);
  }
  if (user === null) return kontext.text("Twitch-Nutzer nicht gefunden.", 404);

  try {
    const freigegeben = await releasePlatformChannel(
      kontext.env.DB,
      kontext.get("actor"),
      user,
      fullConsent,
      jetztIso(),
    );
    if (!freigegeben) return kontext.text("Der Kanal ist bereits freigegeben.", 409);
  } catch {
    return kontext.text("Der Kanal konnte nicht freigegeben werden.", 409);
  }
  return kontext.json({
    channel: {
      channelId: user.userId,
      login: user.login,
      displayName: user.displayName,
      fullConsent: fullConsent,
    },
  }, 201);
});

platformRouter.patch("/api/platform/channels/:channelId", async (kontext) => {
  const rumpf = await leseJson(kontext.req.raw);
  const fullConsent = leseBoolean(rumpf?.fullConsent);
  if (fullConsent === null) return kontext.text("Vollzustimmung ist ungültig.", 400);

  const channel = await getPlatformChannel(kontext.env.DB, kontext.req.param("channelId"));
  if (channel === null) return kontext.text("Kanal nicht gefunden.", 404);
  if (channel.fullConsent === fullConsent) {
    return kontext.text("Diese Vollzustimmung ist bereits gesetzt.", 400);
  }

  const changed = await changeFullConsent(
    kontext.env.DB,
    kontext.get("actor"),
    channel,
    fullConsent,
    jetztIso(),
  );
  if (!changed) return mutationFehlgeschlagen(kontext);
  return kontext.json({ channel: { ...channel, fullConsent: fullConsent } });
});

platformRouter.get("/api/platform/channels/:channelId/members", async (kontext) => {
  const limit = leseLimit(kontext.req.query("limit"), defaultMembersLimit, maximumMembersLimit);
  if (limit === null) return kontext.text("Mitglieder-Begrenzung ist ungültig.", 400);
  const serialisierterCursor = kontext.req.query("cursor");
  const cursor = serialisierterCursor === undefined
    ? null
    : decodeChannelMemberCursor(serialisierterCursor);
  if (serialisierterCursor !== undefined && cursor === null) {
    return kontext.text("Mitglieder-Cursor ist ungültig.", 400);
  }

  const channelId = kontext.req.param("channelId");
  const page = await listChannelMembers(kontext.env.DB, channelId, limit, cursor);
  const namen = await fetchTwitchUsersById(fetch, kontext.env, page.members.map((member) => member.userId));
  return kontext.json({
    members: page.members.map((member) => memberResponse(member, namen.get(member.userId))),
    nextCursor: page.nextCursor,
    broadcasterCount: await countBroadcasterMembers(kontext.env.DB, channelId),
    viewerUserId: kontext.get("session").userId,
  });
});

platformRouter.post("/api/platform/channels/:channelId/members", async (kontext) => {
  const rumpf = await leseJson(kontext.req.raw);
  const userId = leseUserId(rumpf?.userId);
  const rolle = leseRolle(rumpf?.role);
  if (userId === null || rolle === null) return kontext.text("Mitglied oder Rolle ist ungültig.", 400);
  if (rolle === "broadcaster") return rolleBroadcasterVerweigert(kontext);

  const channelId = kontext.req.param("channelId");
  if (await getPlatformChannel(kontext.env.DB, channelId) === null) {
    return kontext.text("Kanal nicht gefunden.", 404);
  }
  const vorhanden = await getChannelMemberForChannel(kontext.env.DB, channelId, userId);
  if (vorhanden !== null) {
    return vorhanden.role === "broadcaster"
      ? rolleBroadcasterVerweigert(kontext)
      : kontext.text("Dieses Mitglied ist bereits freigegeben.", 409);
  }

  const timestamp = jetztIso();
  const member: ChannelMemberRecord = {
    channelId: channelId,
    userId,
    role: rolle,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const changed = await addPlatformMember(
    kontext.env.DB,
    kontext.get("actor"),
    member,
    timestamp,
  );
  if (!changed) return mutationFehlgeschlagen(kontext);
  return kontext.json({ member: memberResponse(member) }, 201);
});

platformRouter.patch("/api/platform/channels/:channelId/members/:userId", async (kontext) => {
  const rumpf = await leseJson(kontext.req.raw);
  const rolle = readPlatformRole(rumpf?.role);
  if (rolle === null) {
    return typeof rumpf?.role === "string" && rumpf.role === "broadcaster"
      ? rolleBroadcasterVerweigert(kontext)
      : kontext.text("Rolle ist ungültig.", 400);
  }

  const channelId = kontext.req.param("channelId");
  const userId = kontext.req.param("userId");
  const vorhanden = await getChannelMemberForChannel(kontext.env.DB, channelId, userId);
  if (vorhanden === null) return kontext.text("Mitglied nicht gefunden.", 404);
  if (vorhanden.role === "broadcaster") return rolleBroadcasterVerweigert(kontext);
  if (vorhanden.role === rolle) return kontext.text("Diese Rolle ist bereits gesetzt.", 400);

  const timestamp = jetztIso();
  const changed = await changePlatformMember(
    kontext.env.DB,
    kontext.get("actor"),
    vorhanden,
    { ...vorhanden, role: rolle, updatedAt: timestamp },
    timestamp,
  );
  if (!changed) return mutationFehlgeschlagen(kontext);
  return kontext.json({
    member: memberResponse({ ...vorhanden, role: rolle, updatedAt: timestamp }),
  });
});

platformRouter.delete("/api/platform/channels/:channelId/members/:userId", async (kontext) => {
  const channelId = kontext.req.param("channelId");
  const userId = kontext.req.param("userId");
  const vorhanden = await getChannelMemberForChannel(kontext.env.DB, channelId, userId);
  if (vorhanden === null) return kontext.text("Mitglied nicht gefunden.", 404);
  if (vorhanden.role === "broadcaster") return rolleBroadcasterVerweigert(kontext);

  const entfernt = await removePlatformMember(
    kontext.env.DB,
    kontext.get("actor"),
    vorhanden,
    jetztIso(),
  );
  if (!entfernt) return mutationFehlgeschlagen(kontext);
  return kontext.body(null, 204);
});

platformRouter.get("/api/platform/audit", async (kontext) => {
  const limit = leseLimit(kontext.req.query("limit"), standardAuditLimit, maximaleAuditLimit);
  if (limit === null) return kontext.text("Audit-Begrenzung ist ungültig.", 400);
  const serialisierterCursor = kontext.req.query("cursor");
  const cursor = serialisierterCursor === undefined
    ? null
    : decodePlatformAuditCursor(serialisierterCursor);
  if (serialisierterCursor !== undefined && cursor === null) {
    return kontext.text("Audit-Cursor ist ungültig.", 400);
  }
  const audit = await listPlatformAudit(kontext.env.DB, limit, cursor);
  const actorIds = audit.entries.map((entry) => entry.actorUserId);
  const actors = await fetchTwitchUsersById(fetch, kontext.env, actorIds);
  return kontext.json({
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
