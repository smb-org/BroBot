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
import { MODULES } from "../../modules/registry";

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

interface PlatformAuditEntry {
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

type PlatformAction =
  | "channel.released"
  | "channel.full_consent_changed"
  | "platform.spotify_access_changed"
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
  before: object | null,
  after: object | null,
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
  // One source of truth for module activation: a released channel gets a
  // real row for every default-enabled module here, the same row every
  // reader (overview, sidebar, dispatch, EventSub targets) checks. Gated on
  // memberMutation's changes() the same way memberMutation itself is gated
  // on channelMutation's, so a re-release attempt on an existing channel
  // inserts nothing.
  const moduleMutations = MODULES
    .filter((module) => module.defaultEnabled === true)
    .map((module) => db.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings, initialized, revision, settings_revision)
       SELECT ?, ?, 1, ?, 1, 1, 1
        WHERE changes() > 0
          AND NOT EXISTS (
            SELECT 1 FROM channel_modules WHERE channel_id = ? AND module_id = ?
          )`,
    ).bind(channel.userId, module.id, JSON.stringify(module.defaultSettings), channel.userId, module.id));
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
  const results = await db.batch([channelMutation, memberMutation, ...moduleMutations, audit]);
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

export interface PlatformSpotifyAccess {
  slot: number;
  channelId: string;
  login: string;
  displayName: string;
  enabledAt: string;
}

export const listPlatformSpotifyAccess = async (db: D1Database): Promise<{
  usedSlots: number;
  limit: 5;
  channels: PlatformSpotifyAccess[];
}> => {
  const result = await db.prepare(
    `SELECT access.slot, access.channel_id, channel.login, channel.display_name, access.enabled_at
       FROM spotify_channel_access AS access
       JOIN channels AS channel ON channel.channel_id = access.channel_id
      ORDER BY access.slot`,
  ).all<{ slot: number; channel_id: string; login: string; display_name: string; enabled_at: string }>();
  const channels = result.results.map((row) => ({
    slot: row.slot,
    channelId: row.channel_id,
    login: row.login,
    displayName: row.display_name,
    enabledAt: row.enabled_at,
  }));
  return { usedSlots: channels.length, limit: 5, channels };
};

export const setPlatformSpotifyAccess = async (
  db: D1Database,
  actor: ActorContext,
  channelId: string,
  enabled: boolean,
  timestamp: string,
): Promise<"enabled" | "disabled" | "unchanged" | "limit"> => {
  const existing = await db.prepare(
    "SELECT slot FROM spotify_channel_access WHERE channel_id = ?",
  ).bind(channelId).first<{ slot: number }>();
  if (enabled && existing !== null || !enabled && existing === null) return "unchanged";
  const mutation = enabled
    ? db.prepare(
      `INSERT INTO spotify_channel_access (slot, channel_id, enabled_by, enabled_at)
       SELECT candidate.slot, ?, ?, ?
         FROM (SELECT 1 AS slot UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5) AS candidate
        WHERE NOT EXISTS (SELECT 1 FROM spotify_channel_access WHERE slot = candidate.slot)
          AND NOT EXISTS (SELECT 1 FROM spotify_channel_access WHERE channel_id = ?)
        ORDER BY candidate.slot LIMIT 1
       ON CONFLICT DO NOTHING`,
    ).bind(channelId, actor.userId, timestamp, channelId)
    : db.prepare("DELETE FROM spotify_channel_access WHERE channel_id = ?").bind(channelId);
  const cleanup = enabled ? [] : [
    db.prepare(
      `DELETE FROM module_secrets
        WHERE channel_id = ? AND module_id = 'song_requests' AND name = 'spotify_credentials'
          AND NOT EXISTS (SELECT 1 FROM spotify_channel_access WHERE channel_id = ?)`,
    ).bind(channelId, channelId),
    db.prepare(
      `INSERT INTO song_requests_connections (channel_id, state, error_message, updated_at)
       SELECT ?, 'not_connected', NULL, ?
        WHERE NOT EXISTS (SELECT 1 FROM spotify_channel_access WHERE channel_id = ?)
       ON CONFLICT (channel_id) DO UPDATE SET state = 'not_connected', error_message = NULL, updated_at = excluded.updated_at`,
    ).bind(channelId, timestamp, channelId),
  ];
  const audit = prepareAuditEntry(
    db,
    actor.userId,
    timestamp,
    channelId,
    "platform.spotify_access_changed",
    existing === null ? null : { channelId, slot: existing.slot, enabled: true },
    enabled ? { channelId, enabled: true } : null,
  );
  const result = await db.batch([mutation, ...cleanup, audit]);
  if ((result[0]?.meta.changes ?? 0) === 0) {
    if (enabled) {
      const count = await db.prepare("SELECT COUNT(*) AS count FROM spotify_channel_access")
        .first<{ count: number }>();
      return (count?.count ?? 0) >= 5 ? "limit" : "unchanged";
    }
    return "unchanged";
  }
  return enabled ? "enabled" : "disabled";
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
