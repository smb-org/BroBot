import {
  platformSessionGuard,
  sqlRole,
  sqlRoleList,
  type ActorContext,
  type MutationGuard,
} from "../db/guards";
import {
  type ChannelMemberRecord,
} from "../db/channel-members";
import { prepareAudit } from "../db/audit";
import { decodeCursor, encodeCursor } from "../db/cursor";
import { PLATFORM_ASSIGNABLE_ROLES, type AuditActorKind } from "../../contracts/values";

export interface PlatformChannel {
  channelId: string;
  login: string;
  displayName: string;
  fullConsent: boolean;
}

export interface PlatformChannelOverview extends PlatformChannel {
  memberCounts: {
    broadcaster: number;
    manager: number;
    operator: number;
  };
  broadcasterConnected: boolean;
}

export interface PlatformAuditCursor {
  createdAt: string;
  id: string;
}

export interface PlatformAuditEntry {
  auditId: string;
  actorUserId: string;
  actorLogin: string | null;
  actorDisplayName: string | null;
  actorKind: AuditActorKind;
  createdAt: string;
  channelId: string;
  moduleId: string | null;
  action: string;
  before: string;
  after: string;
}

export interface PlatformAuditPage {
  entries: PlatformAuditEntry[];
  nextCursor: string | null;
}

export type PlatformAction =
  | "channel.released"
  | "channel.full_consent_changed"
  | "member.added"
  | "member.role_changed"
  | "member.removed";

interface PlatformChannelRow {
  channel_id: string;
  login: string;
  display_name: string;
  full_consent: number;
}

interface PlatformChannelOverviewRow extends PlatformChannelRow {
  broadcaster_count: number;
  manager_count: number;
  operator_count: number;
  broadcaster_connected: number;
}

interface AuditRow {
  audit_id: string;
  actor_user_id: string;
  actor_kind: AuditActorKind;
  created_at: string;
  channel_id: string;
  module_id: string | null;
  action: string;
  before_json: string;
  after_json: string;
}

export const platformRolesSql = sqlRoleList(PLATFORM_ASSIGNABLE_ROLES);

const mutationGuard = (actor: ActorContext, timestamp: string): MutationGuard =>
  platformSessionGuard(actor, timestamp);

const prepareAuditEntry = (
  db: D1Database,
  actorId: string,
  timestamp: string,
  channelId: string,
  action: PlatformAction,
  before: PlatformChannel | ChannelMemberRecord | null,
  after: PlatformChannel | ChannelMemberRecord | null,
): D1PreparedStatement => prepareAudit(
  db,
  actorId,
  timestamp,
  channelId,
  null,
  action,
  before,
  after,
  "platform_admin",
);

const mapChannel = (row: PlatformChannelRow): PlatformChannel => ({
  channelId: row.channel_id,
  login: row.login,
  displayName: row.display_name,
  fullConsent: row.full_consent === 1,
});

export const decodePlatformAuditCursor = (serialized: string): PlatformAuditCursor | null => decodeCursor(serialized, (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const cursor = value as Record<string, unknown>;
    return typeof cursor.createdAt === "string" && cursor.createdAt.length > 0 &&
      typeof cursor.id === "string" && cursor.id.length > 0
      ? { createdAt: cursor.createdAt, id: cursor.id }
      : null;
});

export const listPlatformChannels = async (
  db: D1Database,
): Promise<PlatformChannelOverview[]> => {
  const result = await db.prepare(
    `SELECT channel.channel_id, channel.login, channel.display_name, channel.full_consent,
            COUNT(CASE WHEN member.role = ${sqlRole("broadcaster")} THEN 1 END) AS broadcaster_count,
            COUNT(CASE WHEN member.role = ${sqlRole("manager")} THEN 1 END) AS manager_count,
            COUNT(CASE WHEN member.role = ${sqlRole("operator")} THEN 1 END) AS operator_count,
            CASE WHEN EXISTS (
              SELECT 1
                FROM twitch_login_identity AS identity
               WHERE identity.user_id = channel.channel_id
                 AND identity.status = 'connected'
            ) THEN 1 ELSE 0 END AS broadcaster_connected
       FROM channels AS channel
       LEFT JOIN channel_members AS member ON member.channel_id = channel.channel_id
      GROUP BY channel.channel_id, channel.login, channel.display_name, channel.full_consent
      ORDER BY channel.login, channel.channel_id`,
  ).all<PlatformChannelOverviewRow>();
  return result.results.map((row) => ({
    ...mapChannel(row),
    memberCounts: {
      broadcaster: row.broadcaster_count,
      manager: row.manager_count,
      operator: row.operator_count,
    },
    broadcasterConnected: row.broadcaster_connected === 1,
  }));
};

export const getPlatformChannel = async (
  db: D1Database,
  channelId: string,
): Promise<PlatformChannel | null> => {
  const row = await db.prepare(
    `SELECT channel_id, login, display_name, full_consent
       FROM channels
      WHERE channel_id = ?`,
  ).bind(channelId).first<PlatformChannelRow>();
  return row === null ? null : mapChannel(row);
};

export const releasePlatformChannel = async (
  db: D1Database,
  actor: ActorContext,
  channel: { userId: string; login: string; displayName: string },
  fullConsent: boolean,
  timestamp: string,
): Promise<boolean> => {
  const guard = mutationGuard(actor, timestamp);
  const channelMutation = db.prepare(
    `INSERT INTO channels
      (channel_id, login, display_name, created_at, updated_at, full_consent)
     SELECT ?, ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM channels WHERE channel_id = ?
      )
      ${guard.sql}`,
  ).bind(
    channel.userId,
    channel.login,
    channel.displayName,
    timestamp,
    timestamp,
    fullConsent ? 1 : 0,
    channel.userId,
    ...guard.values,
  );
  const memberMutation = db.prepare(
    `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
     SELECT ?, channel_id, ${sqlRole("broadcaster")}, ?, ?
       FROM channels
      WHERE channel_id = ?
        AND changes() > 0`,
  ).bind(channel.userId, timestamp, timestamp, channel.userId);
  const after: PlatformChannel = {
    channelId: channel.userId,
    login: channel.login,
    displayName: channel.displayName,
    fullConsent: fullConsent,
  };
  const audit = prepareAuditEntry(
    db,
    actor.userId,
    timestamp,
    channel.userId,
    "channel.released",
    null,
    after,
  );
  const results = await db.batch([channelMutation, memberMutation, audit]);
  return (results[0]?.meta.changes ?? 0) > 0 && (results[1]?.meta.changes ?? 0) > 0;
};

export const changeFullConsent = async (
  db: D1Database,
  actor: ActorContext,
  channel: PlatformChannel,
  fullConsent: boolean,
  timestamp: string,
): Promise<boolean> => {
  const guard = mutationGuard(actor, timestamp);
  const before: PlatformChannel = { ...channel };
  const after: PlatformChannel = { ...channel, fullConsent: fullConsent };
  const mutation = db.prepare(
    `UPDATE channels
        SET full_consent = ?, updated_at = ?
      WHERE channel_id = ?
        AND full_consent <> ?
        ${guard.sql}`,
  ).bind(
    fullConsent ? 1 : 0,
    timestamp,
    channel.channelId,
    fullConsent ? 1 : 0,
    ...guard.values,
  );
  const audit = prepareAuditEntry(
    db,
    actor.userId,
    timestamp,
    channel.channelId,
    "channel.full_consent_changed",
    before,
    after,
  );
  const results = await db.batch([mutation, audit]);
  return (results[0]?.meta.changes ?? 0) > 0;
};

export const addPlatformMember = async (
  db: D1Database,
  actor: ActorContext,
  member: ChannelMemberRecord,
  timestamp: string,
): Promise<boolean> => {
  const guard = mutationGuard(actor, timestamp);
  const mutation = db.prepare(
    `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM channels WHERE channel_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM channel_members
           WHERE channel_id = ? AND user_id = ?
        )
        AND ? IN (${platformRolesSql})
        ${guard.sql}`,
  ).bind(
    member.channelId,
    member.userId,
    member.role,
    member.createdAt,
    member.updatedAt,
    member.channelId,
    member.channelId,
    member.userId,
    member.role,
    ...guard.values,
  );
  const audit = prepareAuditEntry(
    db,
    actor.userId,
    timestamp,
    member.channelId,
    "member.added",
    null,
    member,
  );
  const results = await db.batch([mutation, audit]);
  return (results[0]?.meta.changes ?? 0) > 0;
};

export const changePlatformMember = async (
  db: D1Database,
  actor: ActorContext,
  before: ChannelMemberRecord,
  after: ChannelMemberRecord,
  timestamp: string,
): Promise<boolean> => {
  const guard = mutationGuard(actor, timestamp);
  const mutation = db.prepare(
    `UPDATE channel_members
        SET role = ?, updated_at = ?
      WHERE channel_id = ? AND user_id = ?
        AND role = ? AND created_at = ? AND updated_at = ?
        AND role IN (${platformRolesSql})
        AND ? IN (${platformRolesSql})
        ${guard.sql}`,
  ).bind(
    after.role,
    after.updatedAt,
    after.channelId,
    after.userId,
    before.role,
    before.createdAt,
    before.updatedAt,
    after.role,
    ...guard.values,
  );
  const audit = prepareAuditEntry(
    db,
    actor.userId,
    timestamp,
    after.channelId,
    "member.role_changed",
    before,
    after,
  );
  const results = await db.batch([mutation, audit]);
  return (results[0]?.meta.changes ?? 0) > 0;
};

export const removePlatformMember = async (
  db: D1Database,
  actor: ActorContext,
  member: ChannelMemberRecord,
  timestamp: string,
): Promise<boolean> => {
  const guard = mutationGuard(actor, timestamp);
  const mutation = db.prepare(
    `DELETE FROM channel_members
      WHERE channel_id = ? AND user_id = ?
        AND role = ? AND created_at = ? AND updated_at = ?
        AND role IN (${platformRolesSql})
        ${guard.sql}`,
  ).bind(
    member.channelId,
    member.userId,
    member.role,
    member.createdAt,
    member.updatedAt,
    ...guard.values,
  );
  const audit = prepareAuditEntry(
    db,
    actor.userId,
    timestamp,
    member.channelId,
    "member.removed",
    member,
    null,
  );
  const results = await db.batch([mutation, audit]);
  return (results[0]?.meta.changes ?? 0) > 0;
};

export const listPlatformAudit = async (
  db: D1Database,
  limit: number,
  cursor: PlatformAuditCursor | null,
): Promise<PlatformAuditPage> => {
  const query = cursor === null
    ? `SELECT audit_id, actor_user_id, actor_kind, created_at, channel_id, module_id, action, before_json, after_json
         FROM audit_log
        WHERE actor_kind = 'platform_admin'
        ORDER BY created_at DESC, audit_id DESC
        LIMIT ?`
    : `SELECT audit_id, actor_user_id, actor_kind, created_at, channel_id, module_id, action, before_json, after_json
         FROM audit_log
        WHERE actor_kind = 'platform_admin'
          AND (created_at < ? OR (created_at = ? AND audit_id < ?))
        ORDER BY created_at DESC, audit_id DESC
        LIMIT ?`;
  const values = cursor === null
    ? [limit + 1]
    : [cursor.createdAt, cursor.createdAt, cursor.id, limit + 1];
  const result = await db.prepare(query).bind(...values).all<AuditRow>();
  const hasNextPage = result.results.length > limit;
  const rows = result.results.slice(0, limit);
  const entries = rows.map((row): PlatformAuditEntry => ({
    auditId: row.audit_id,
    actorUserId: row.actor_user_id,
    actorLogin: null,
    actorDisplayName: null,
    actorKind: row.actor_kind,
    createdAt: row.created_at,
    channelId: row.channel_id,
    moduleId: row.module_id,
    action: row.action,
    before: row.before_json,
    after: row.after_json,
  }));
  const lastRow = rows.at(-1);
  return {
    entries: entries,
    nextCursor: hasNextPage && lastRow !== undefined
      ? encodeCursor({ createdAt: lastRow.created_at, id: lastRow.audit_id })
      : null,
  };
};
