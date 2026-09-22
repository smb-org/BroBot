import {
  betreiberSessionGuard,
  type ActorContext,
  type MutationGuard,
} from "../db/guards";
import {
  type ChannelMemberRecord,
} from "../db/channel-members";
import { prepareAudit } from "../db/audit";
import { decodeCursor, encodeCursor } from "../db/cursor";

export interface BetreiberKanal {
  channelId: string;
  login: string;
  displayName: string;
  vollzustimmung: boolean;
}

export interface BetreiberKanalÜbersicht extends BetreiberKanal {
  memberCounts: {
    broadcaster: number;
    verwalter: number;
    bediener: number;
  };
  broadcasterConnected: boolean;
}

export interface BetreiberAuditCursor {
  createdAt: string;
  id: string;
}

export interface BetreiberAuditEintrag {
  auditId: string;
  actorUserId: string;
  actorLogin: string | null;
  actorDisplayName: string | null;
  actorKind: "mitglied" | "betreiber";
  createdAt: string;
  channelId: string;
  moduleId: string | null;
  action: string;
  before: string;
  after: string;
}

export interface BetreiberAuditSeite {
  entries: BetreiberAuditEintrag[];
  nextCursor: string | null;
}

export type BetreiberAktion =
  | "kanal.freigegeben"
  | "kanal.vollzustimmung_geaendert"
  | "mitglied.hinzugefuegt"
  | "mitglied.rolle_geaendert"
  | "mitglied.entfernt";

interface BetreiberKanalZeile {
  channel_id: string;
  login: string;
  display_name: string;
  vollzustimmung: number;
}

interface BetreiberKanalÜbersichtZeile extends BetreiberKanalZeile {
  broadcaster_count: number;
  verwalter_count: number;
  bediener_count: number;
  broadcaster_connected: number;
}

interface AuditZeile {
  audit_id: string;
  actor_user_id: string;
  actor_kind: "mitglied" | "betreiber";
  created_at: string;
  channel_id: string;
  module_id: string | null;
  action: string;
  before_json: string;
  after_json: string;
}

export const betreiberRollenSql = "'verwalter', 'bediener'";

const mutationsschutz = (akteur: ActorContext, zeitpunkt: string): MutationGuard =>
  betreiberSessionGuard(akteur, zeitpunkt);

const vorbereiteAudit = (
  db: D1Database,
  akteurId: string,
  zeitpunkt: string,
  kanalId: string,
  aktion: BetreiberAktion,
  vorher: BetreiberKanal | ChannelMemberRecord | null,
  nachher: BetreiberKanal | ChannelMemberRecord | null,
): D1PreparedStatement => prepareAudit(
  db,
  akteurId,
  zeitpunkt,
  kanalId,
  null,
  aktion,
  vorher,
  nachher,
  "betreiber",
);

const mapKanal = (zeile: BetreiberKanalZeile): BetreiberKanal => ({
  channelId: zeile.channel_id,
  login: zeile.login,
  displayName: zeile.display_name,
  vollzustimmung: zeile.vollzustimmung === 1,
});

export const decodeBetreiberAuditCursor = (serialized: string): BetreiberAuditCursor | null => decodeCursor(serialized, (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const cursor = value as Record<string, unknown>;
    return typeof cursor.createdAt === "string" && cursor.createdAt.length > 0 &&
      typeof cursor.id === "string" && cursor.id.length > 0
      ? { createdAt: cursor.createdAt, id: cursor.id }
      : null;
});

export const listeBetreiberKanäle = async (
  db: D1Database,
): Promise<BetreiberKanalÜbersicht[]> => {
  const result = await db.prepare(
    `SELECT channel.channel_id, channel.login, channel.display_name, channel.vollzustimmung,
            COUNT(CASE WHEN member.role = 'broadcaster' THEN 1 END) AS broadcaster_count,
            COUNT(CASE WHEN member.role = 'verwalter' THEN 1 END) AS verwalter_count,
            COUNT(CASE WHEN member.role = 'bediener' THEN 1 END) AS bediener_count,
            CASE WHEN EXISTS (
              SELECT 1
                FROM twitch_login_identity AS identity
               WHERE identity.user_id = channel.channel_id
                 AND identity.status = 'connected'
            ) THEN 1 ELSE 0 END AS broadcaster_connected
       FROM channels AS channel
       LEFT JOIN channel_members AS member ON member.channel_id = channel.channel_id
      GROUP BY channel.channel_id, channel.login, channel.display_name, channel.vollzustimmung
      ORDER BY channel.login, channel.channel_id`,
  ).all<BetreiberKanalÜbersichtZeile>();
  return result.results.map((zeile) => ({
    ...mapKanal(zeile),
    memberCounts: {
      broadcaster: zeile.broadcaster_count,
      verwalter: zeile.verwalter_count,
      bediener: zeile.bediener_count,
    },
    broadcasterConnected: zeile.broadcaster_connected === 1,
  }));
};

export const holeBetreiberKanal = async (
  db: D1Database,
  kanalId: string,
): Promise<BetreiberKanal | null> => {
  const zeile = await db.prepare(
    `SELECT channel_id, login, display_name, vollzustimmung
       FROM channels
      WHERE channel_id = ?`,
  ).bind(kanalId).first<BetreiberKanalZeile>();
  return zeile === null ? null : mapKanal(zeile);
};

export const freigebenBetreiberKanal = async (
  db: D1Database,
  akteur: ActorContext,
  kanal: { userId: string; login: string; displayName: string },
  vollzustimmung: boolean,
  zeitpunkt: string,
): Promise<boolean> => {
  const schutz = mutationsschutz(akteur, zeitpunkt);
  const kanalMutation = db.prepare(
    `INSERT INTO channels
      (channel_id, login, display_name, created_at, updated_at, vollzustimmung)
     SELECT ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM channels WHERE channel_id = ?
      )
      ${schutz.sql}`,
  ).bind(
    kanal.userId,
    kanal.login,
    kanal.displayName,
    zeitpunkt,
    zeitpunkt,
    vollzustimmung ? 1 : 0,
    kanal.userId,
    ...schutz.values,
  );
  const mitgliedMutation = db.prepare(
    `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
     SELECT ?, channel_id, 'broadcaster', ?, ?
       FROM channels
      WHERE channel_id = ?
        AND changes() > 0`,
  ).bind(kanal.userId, zeitpunkt, zeitpunkt, kanal.userId);
  const nachher: BetreiberKanal = {
    channelId: kanal.userId,
    login: kanal.login,
    displayName: kanal.displayName,
    vollzustimmung,
  };
  const audit = vorbereiteAudit(
    db,
    akteur.userId,
    zeitpunkt,
    kanal.userId,
    "kanal.freigegeben",
    null,
    nachher,
  );
  const ergebnisse = await db.batch([kanalMutation, mitgliedMutation, audit]);
  return (ergebnisse[0]?.meta.changes ?? 0) > 0 && (ergebnisse[1]?.meta.changes ?? 0) > 0;
};

export const ändereVollzustimmung = async (
  db: D1Database,
  akteur: ActorContext,
  kanal: BetreiberKanal,
  vollzustimmung: boolean,
  zeitpunkt: string,
): Promise<boolean> => {
  const schutz = mutationsschutz(akteur, zeitpunkt);
  const vorher: BetreiberKanal = { ...kanal };
  const nachher: BetreiberKanal = { ...kanal, vollzustimmung };
  const mutation = db.prepare(
    `UPDATE channels
        SET vollzustimmung = ?, updated_at = ?
      WHERE channel_id = ?
        AND vollzustimmung <> ?
        ${schutz.sql}`,
  ).bind(
    vollzustimmung ? 1 : 0,
    zeitpunkt,
    kanal.channelId,
    vollzustimmung ? 1 : 0,
    ...schutz.values,
  );
  const audit = vorbereiteAudit(
    db,
    akteur.userId,
    zeitpunkt,
    kanal.channelId,
    "kanal.vollzustimmung_geaendert",
    vorher,
    nachher,
  );
  const ergebnisse = await db.batch([mutation, audit]);
  return (ergebnisse[0]?.meta.changes ?? 0) > 0;
};

export const fügeBetreiberMitgliedHinzu = async (
  db: D1Database,
  akteur: ActorContext,
  mitglied: ChannelMemberRecord,
  zeitpunkt: string,
): Promise<boolean> => {
  const schutz = mutationsschutz(akteur, zeitpunkt);
  const mutation = db.prepare(
    `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM channels WHERE channel_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM channel_members
           WHERE channel_id = ? AND user_id = ?
        )
        AND ? IN (${betreiberRollenSql})
        ${schutz.sql}`,
  ).bind(
    mitglied.channelId,
    mitglied.userId,
    mitglied.role,
    mitglied.createdAt,
    mitglied.updatedAt,
    mitglied.channelId,
    mitglied.channelId,
    mitglied.userId,
    mitglied.role,
    ...schutz.values,
  );
  const audit = vorbereiteAudit(
    db,
    akteur.userId,
    zeitpunkt,
    mitglied.channelId,
    "mitglied.hinzugefuegt",
    null,
    mitglied,
  );
  const ergebnisse = await db.batch([mutation, audit]);
  return (ergebnisse[0]?.meta.changes ?? 0) > 0;
};

export const ändereBetreiberMitglied = async (
  db: D1Database,
  akteur: ActorContext,
  vorher: ChannelMemberRecord,
  nachher: ChannelMemberRecord,
  zeitpunkt: string,
): Promise<boolean> => {
  const schutz = mutationsschutz(akteur, zeitpunkt);
  const mutation = db.prepare(
    `UPDATE channel_members
        SET role = ?, updated_at = ?
      WHERE channel_id = ? AND user_id = ?
        AND role = ? AND created_at = ? AND updated_at = ?
        AND role IN (${betreiberRollenSql})
        AND ? IN (${betreiberRollenSql})
        ${schutz.sql}`,
  ).bind(
    nachher.role,
    nachher.updatedAt,
    nachher.channelId,
    nachher.userId,
    vorher.role,
    vorher.createdAt,
    vorher.updatedAt,
    nachher.role,
    ...schutz.values,
  );
  const audit = vorbereiteAudit(
    db,
    akteur.userId,
    zeitpunkt,
    nachher.channelId,
    "mitglied.rolle_geaendert",
    vorher,
    nachher,
  );
  const ergebnisse = await db.batch([mutation, audit]);
  return (ergebnisse[0]?.meta.changes ?? 0) > 0;
};

export const entferneBetreiberMitglied = async (
  db: D1Database,
  akteur: ActorContext,
  mitglied: ChannelMemberRecord,
  zeitpunkt: string,
): Promise<boolean> => {
  const schutz = mutationsschutz(akteur, zeitpunkt);
  const mutation = db.prepare(
    `DELETE FROM channel_members
      WHERE channel_id = ? AND user_id = ?
        AND role = ? AND created_at = ? AND updated_at = ?
        AND role IN (${betreiberRollenSql})
        ${schutz.sql}`,
  ).bind(
    mitglied.channelId,
    mitglied.userId,
    mitglied.role,
    mitglied.createdAt,
    mitglied.updatedAt,
    ...schutz.values,
  );
  const audit = vorbereiteAudit(
    db,
    akteur.userId,
    zeitpunkt,
    mitglied.channelId,
    "mitglied.entfernt",
    mitglied,
    null,
  );
  const ergebnisse = await db.batch([mutation, audit]);
  return (ergebnisse[0]?.meta.changes ?? 0) > 0;
};

export const listeBetreiberAudit = async (
  db: D1Database,
  limit: number,
  cursor: BetreiberAuditCursor | null,
): Promise<BetreiberAuditSeite> => {
  const query = cursor === null
    ? `SELECT audit_id, actor_user_id, actor_kind, created_at, channel_id, module_id, action, before_json, after_json
         FROM audit_log
        WHERE actor_kind = 'betreiber'
        ORDER BY created_at DESC, audit_id DESC
        LIMIT ?`
    : `SELECT audit_id, actor_user_id, actor_kind, created_at, channel_id, module_id, action, before_json, after_json
         FROM audit_log
        WHERE actor_kind = 'betreiber'
          AND (created_at < ? OR (created_at = ? AND audit_id < ?))
        ORDER BY created_at DESC, audit_id DESC
        LIMIT ?`;
  const werte = cursor === null
    ? [limit + 1]
    : [cursor.createdAt, cursor.createdAt, cursor.id, limit + 1];
  const ergebnis = await db.prepare(query).bind(...werte).all<AuditZeile>();
  const hatNächsteSeite = ergebnis.results.length > limit;
  const zeilen = ergebnis.results.slice(0, limit);
  const einträge = zeilen.map((zeile): BetreiberAuditEintrag => ({
    auditId: zeile.audit_id,
    actorUserId: zeile.actor_user_id,
    actorLogin: null,
    actorDisplayName: null,
    actorKind: zeile.actor_kind,
    createdAt: zeile.created_at,
    channelId: zeile.channel_id,
    moduleId: zeile.module_id,
    action: zeile.action,
    before: zeile.before_json,
    after: zeile.after_json,
  }));
  const letzteZeile = zeilen.at(-1);
  return {
    entries: einträge,
    nextCursor: hatNächsteSeite && letzteZeile !== undefined
      ? encodeCursor({ createdAt: letzteZeile.created_at, id: letzteZeile.audit_id })
      : null,
  };
};
