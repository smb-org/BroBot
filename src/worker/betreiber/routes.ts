import { Hono } from "hono";

import {
  requireBetreiber,
  type BetreiberAuthorizationVariables,
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
  ändereBetreiberMitglied,
  ändereVollzustimmung,
  decodeBetreiberAuditCursor,
  entferneBetreiberMitglied,
  fügeBetreiberMitgliedHinzu,
  freigebenBetreiberKanal,
  holeBetreiberKanal,
  listeBetreiberAudit,
  listeBetreiberKanäle,
} from "./repository";
import { CHANNEL_ROLES, type ChannelRole } from "../../contracts/values";

interface BetreiberUmgebung {
  Bindings: Env;
  Variables: BetreiberAuthorizationVariables;
}

interface JsonDatensatz {
  [schlüssel: string]: unknown;
}

const rollen = CHANNEL_ROLES;
const betreiberRollen = CHANNEL_ROLES.filter((rolle): rolle is Exclude<ChannelRole, "broadcaster"> => rolle !== "broadcaster");
const standardAuditLimit = 50;
const maximaleAuditLimit = 100;
const standardMitgliederLimit = 100;
const maximaleMitgliederLimit = 100;

const jetztIso = (): string => new Date().toISOString();

const istJsonDatensatz = (wert: unknown): wert is JsonDatensatz =>
  typeof wert === "object" && wert !== null && !Array.isArray(wert);

const leseJson = async (anfrage: Request): Promise<JsonDatensatz | null> => {
  try {
    const wert: unknown = await anfrage.json();
    return istJsonDatensatz(wert) ? wert : null;
  } catch {
    return null;
  }
};

const leseLogin = (wert: string | undefined): string | null => {
  const login = wert?.trim() ?? "";
  return login.length > 0 && login.length <= 25 && !/\s/.test(login) ? login : null;
};

const leseUserId = (wert: unknown): string | null =>
  typeof wert === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(wert) ? wert : null;

const leseRolle = (wert: unknown): ChannelRole | null =>
  typeof wert === "string" && rollen.includes(wert as ChannelRole)
    ? wert as ChannelRole
    : null;

const leseBetreiberRolle = (wert: unknown): Exclude<ChannelRole, "broadcaster"> | null =>
  typeof wert === "string" && betreiberRollen.includes(wert as Exclude<ChannelRole, "broadcaster">)
    ? wert as Exclude<ChannelRole, "broadcaster">
    : null;

const leseBoolean = (wert: unknown): boolean | null => typeof wert === "boolean" ? wert : null;

const leseLimit = (
  wert: string | undefined,
  standard: number,
  maximum: number,
): number | null => {
  if (wert === undefined) return standard;
  if (!/^\d+$/.test(wert)) return null;
  const limit = Number(wert);
  return Number.isSafeInteger(limit) && limit > 0 && limit <= maximum ? limit : null;
};

const mitgliedAntwort = (mitglied: ChannelMemberRecord, nutzer?: TwitchUser) => ({
  userId: mitglied.userId,
  login: nutzer?.login ?? null,
  displayName: nutzer?.displayName ?? null,
  profileImageUrl: nutzer?.profileImageUrl ?? null,
  role: mitglied.role,
  joinedAt: mitglied.createdAt,
});

const rolleBroadcasterVerweigert = (kontext: { text: (text: string, status: 403) => Response }): Response =>
  kontext.text("Die Rolle Broadcaster darf auf der Betreiberebene nicht geändert werden.", 403);

const mutationFehlgeschlagen = (kontext: { text: (text: string, status: 409) => Response }): Response =>
  kontext.text("Die Änderung konnte nicht durchgeführt werden.", 409);

export const betreiberRouter = new Hono<BetreiberUmgebung>();

betreiberRouter.use("/api/betreiber", requireBetreiber());
betreiberRouter.use("/api/betreiber/*", requireBetreiber());

betreiberRouter.get("/api/betreiber", async (kontext) =>
  kontext.json({ channels: await listeBetreiberKanäle(kontext.env.DB) }));

betreiberRouter.get("/api/betreiber/nutzer", async (kontext) => {
  const login = leseLogin(kontext.req.query("login"));
  if (login === null) return kontext.text("Twitch-Name fehlt oder ist ungültig.", 400);
  try {
    const nutzer = await fetchTwitchUserByLogin(fetch, kontext.env, login);
    return nutzer === null
      ? kontext.text("Twitch-Nutzer nicht gefunden.", 404)
      : kontext.json({ user: nutzer });
  } catch (fehler: unknown) {
    const meldung = fehler instanceof Error ? fehler.message : "Twitch-Nutzersuche ist fehlgeschlagen.";
    return kontext.text(meldung, 502);
  }
});

betreiberRouter.post("/api/betreiber/kanaele", async (kontext) => {
  const rumpf = await leseJson(kontext.req.raw);
  const login = typeof rumpf?.login === "string" ? leseLogin(rumpf.login) : null;
  const vollzustimmung = leseBoolean(rumpf?.vollzustimmung);
  if (login === null || vollzustimmung === null) {
    return kontext.text("Login oder Vollzustimmung ist ungültig.", 400);
  }

  let nutzer: TwitchUser | null;
  try {
    nutzer = await fetchTwitchUserByLogin(fetch, kontext.env, login);
  } catch (fehler: unknown) {
    const meldung = fehler instanceof Error ? fehler.message : "Twitch-Nutzersuche ist fehlgeschlagen.";
    return kontext.text(meldung, 502);
  }
  if (nutzer === null) return kontext.text("Twitch-Nutzer nicht gefunden.", 404);

  try {
    const freigegeben = await freigebenBetreiberKanal(
      kontext.env.DB,
      kontext.get("actor"),
      nutzer,
      vollzustimmung,
      jetztIso(),
    );
    if (!freigegeben) return kontext.text("Der Kanal ist bereits freigegeben.", 409);
  } catch {
    return kontext.text("Der Kanal konnte nicht freigegeben werden.", 409);
  }
  return kontext.json({
    channel: {
      channelId: nutzer.userId,
      login: nutzer.login,
      displayName: nutzer.displayName,
      vollzustimmung,
    },
  }, 201);
});

betreiberRouter.patch("/api/betreiber/kanaele/:channelId", async (kontext) => {
  const rumpf = await leseJson(kontext.req.raw);
  const vollzustimmung = leseBoolean(rumpf?.vollzustimmung);
  if (vollzustimmung === null) return kontext.text("Vollzustimmung ist ungültig.", 400);

  const kanal = await holeBetreiberKanal(kontext.env.DB, kontext.req.param("channelId"));
  if (kanal === null) return kontext.text("Kanal nicht gefunden.", 404);
  if (kanal.vollzustimmung === vollzustimmung) {
    return kontext.text("Diese Vollzustimmung ist bereits gesetzt.", 400);
  }

  const geändert = await ändereVollzustimmung(
    kontext.env.DB,
    kontext.get("actor"),
    kanal,
    vollzustimmung,
    jetztIso(),
  );
  if (!geändert) return mutationFehlgeschlagen(kontext);
  return kontext.json({ channel: { ...kanal, vollzustimmung } });
});

betreiberRouter.get("/api/betreiber/kanaele/:channelId/mitglieder", async (kontext) => {
  const limit = leseLimit(kontext.req.query("limit"), standardMitgliederLimit, maximaleMitgliederLimit);
  if (limit === null) return kontext.text("Mitglieder-Begrenzung ist ungültig.", 400);
  const serialisierterCursor = kontext.req.query("cursor");
  const cursor = serialisierterCursor === undefined
    ? null
    : decodeChannelMemberCursor(serialisierterCursor);
  if (serialisierterCursor !== undefined && cursor === null) {
    return kontext.text("Mitglieder-Cursor ist ungültig.", 400);
  }

  const kanalId = kontext.req.param("channelId");
  const seite = await listChannelMembers(kontext.env.DB, kanalId, limit, cursor);
  const namen = await fetchTwitchUsersById(fetch, kontext.env, seite.members.map((mitglied) => mitglied.userId));
  return kontext.json({
    members: seite.members.map((mitglied) => mitgliedAntwort(mitglied, namen.get(mitglied.userId))),
    nextCursor: seite.nextCursor,
    broadcasterCount: await countBroadcasterMembers(kontext.env.DB, kanalId),
    viewerUserId: kontext.get("session").userId,
  });
});

betreiberRouter.post("/api/betreiber/kanaele/:channelId/mitglieder", async (kontext) => {
  const rumpf = await leseJson(kontext.req.raw);
  const userId = leseUserId(rumpf?.userId);
  const rolle = leseRolle(rumpf?.role);
  if (userId === null || rolle === null) return kontext.text("Mitglied oder Rolle ist ungültig.", 400);
  if (rolle === "broadcaster") return rolleBroadcasterVerweigert(kontext);

  const kanalId = kontext.req.param("channelId");
  if (await holeBetreiberKanal(kontext.env.DB, kanalId) === null) {
    return kontext.text("Kanal nicht gefunden.", 404);
  }
  const vorhanden = await getChannelMemberForChannel(kontext.env.DB, kanalId, userId);
  if (vorhanden !== null) {
    return vorhanden.role === "broadcaster"
      ? rolleBroadcasterVerweigert(kontext)
      : kontext.text("Dieses Mitglied ist bereits freigegeben.", 409);
  }

  const zeitpunkt = jetztIso();
  const mitglied: ChannelMemberRecord = {
    channelId: kanalId,
    userId,
    role: rolle,
    createdAt: zeitpunkt,
    updatedAt: zeitpunkt,
  };
  const geändert = await fügeBetreiberMitgliedHinzu(
    kontext.env.DB,
    kontext.get("actor"),
    mitglied,
    zeitpunkt,
  );
  if (!geändert) return mutationFehlgeschlagen(kontext);
  return kontext.json({ member: mitgliedAntwort(mitglied) }, 201);
});

betreiberRouter.patch("/api/betreiber/kanaele/:channelId/mitglieder/:userId", async (kontext) => {
  const rumpf = await leseJson(kontext.req.raw);
  const rolle = leseBetreiberRolle(rumpf?.role);
  if (rolle === null) {
    return typeof rumpf?.role === "string" && rumpf.role === "broadcaster"
      ? rolleBroadcasterVerweigert(kontext)
      : kontext.text("Rolle ist ungültig.", 400);
  }

  const kanalId = kontext.req.param("channelId");
  const userId = kontext.req.param("userId");
  const vorhanden = await getChannelMemberForChannel(kontext.env.DB, kanalId, userId);
  if (vorhanden === null) return kontext.text("Mitglied nicht gefunden.", 404);
  if (vorhanden.role === "broadcaster") return rolleBroadcasterVerweigert(kontext);
  if (vorhanden.role === rolle) return kontext.text("Diese Rolle ist bereits gesetzt.", 400);

  const zeitpunkt = jetztIso();
  const geändert = await ändereBetreiberMitglied(
    kontext.env.DB,
    kontext.get("actor"),
    vorhanden,
    { ...vorhanden, role: rolle, updatedAt: zeitpunkt },
    zeitpunkt,
  );
  if (!geändert) return mutationFehlgeschlagen(kontext);
  return kontext.json({
    member: mitgliedAntwort({ ...vorhanden, role: rolle, updatedAt: zeitpunkt }),
  });
});

betreiberRouter.delete("/api/betreiber/kanaele/:channelId/mitglieder/:userId", async (kontext) => {
  const kanalId = kontext.req.param("channelId");
  const userId = kontext.req.param("userId");
  const vorhanden = await getChannelMemberForChannel(kontext.env.DB, kanalId, userId);
  if (vorhanden === null) return kontext.text("Mitglied nicht gefunden.", 404);
  if (vorhanden.role === "broadcaster") return rolleBroadcasterVerweigert(kontext);

  const entfernt = await entferneBetreiberMitglied(
    kontext.env.DB,
    kontext.get("actor"),
    vorhanden,
    jetztIso(),
  );
  if (!entfernt) return mutationFehlgeschlagen(kontext);
  return kontext.body(null, 204);
});

betreiberRouter.get("/api/betreiber/audit", async (kontext) => {
  const limit = leseLimit(kontext.req.query("limit"), standardAuditLimit, maximaleAuditLimit);
  if (limit === null) return kontext.text("Audit-Begrenzung ist ungültig.", 400);
  const serialisierterCursor = kontext.req.query("cursor");
  const cursor = serialisierterCursor === undefined
    ? null
    : decodeBetreiberAuditCursor(serialisierterCursor);
  if (serialisierterCursor !== undefined && cursor === null) {
    return kontext.text("Audit-Cursor ist ungültig.", 400);
  }
  const audit = await listeBetreiberAudit(kontext.env.DB, limit, cursor);
  const actorIds = audit.entries.map((eintrag) => eintrag.actorUserId);
  const akteure = await fetchTwitchUsersById(fetch, kontext.env, actorIds);
  return kontext.json({
    ...audit,
    entries: audit.entries.map((eintrag) => {
      const akteur = akteure.get(eintrag.actorUserId);
      return {
        ...eintrag,
        actorLogin: akteur?.login ?? null,
        actorDisplayName: akteur?.displayName ?? null,
      };
    }),
  });
});
