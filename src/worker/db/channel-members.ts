import { prepareAudit } from "./audit";
import type { AuditAction, AuditActorKind, ChannelRole } from "../../contracts/values";
import { decodeCursor, encodeCursor } from "./cursor";
import {
  bindActorGuard,
  lastBroadcasterGuard,
  lastBroadcasterRoleChangeGuard,
  sqlRole,
  type ActorContext,
  type MutationGuard,
} from "./guards";

export interface ChannelMemberRecord {
  channelId: string;
  userId: string;
  role: ChannelRole;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelMemberCursor {
  createdAt: string;
  userId: string;
}

export interface ChannelMemberPage {
  members: ChannelMemberRecord[];
  nextCursor: string | null;
}

interface ChannelMemberRow {
  channel_id: string;
  user_id: string;
  role: ChannelMemberRecord["role"];
  created_at: string;
  updated_at: string;
}

const mapChannelMember = (row: ChannelMemberRow): ChannelMemberRecord => ({
  channelId: row.channel_id,
  userId: row.user_id,
  role: row.role,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const decodeChannelMemberCursor = (
  serialized: string,
): ChannelMemberCursor | null => decodeCursor(serialized, (value): ChannelMemberCursor | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const cursor = value as Record<string, unknown>;
  return typeof cursor.createdAt === "string" && cursor.createdAt.length > 0 &&
    typeof cursor.userId === "string" && cursor.userId.length > 0
    ? { createdAt: cursor.createdAt, userId: cursor.userId }
    : null;
});

const prepareMemberAudit = (
  db: D1Database,
  actorUserId: string,
  changedAt: string,
  channelId: string,
  action: AuditAction,
  before: ChannelMemberRecord | null,
  after: ChannelMemberRecord | null,
  actorKind: AuditActorKind = "member",
): D1PreparedStatement => prepareAudit(
  db,
  actorUserId,
  changedAt,
  channelId,
  null,
  action,
  before,
  after,
  actorKind,
);

const mutationGuardParts = (
  guard: string | MutationGuard,
  actor: ActorContext,
  channelId: string,
  changedAt: string,
): MutationGuard => typeof guard === "string"
  ? { sql: guard, values: bindActorGuard(actor, channelId, changedAt) }
  : guard;

const getChannelMember = async (
  db: D1Database,
  channelId: string,
  userId: string,
): Promise<ChannelMemberRecord | null> => {
  const row = await db.prepare(
    `SELECT channel_id, user_id, role, created_at, updated_at
       FROM channel_members
      WHERE channel_id = ? AND user_id = ?`,
  ).bind(channelId, userId).first<ChannelMemberRow>();
  return row === null ? null : mapChannelMember(row);
};

export const getChannelMemberForChannel = async (
  db: D1Database,
  channelId: string,
  userId: string,
): Promise<ChannelMemberRecord | null> => getChannelMember(db, channelId, userId);

export const listChannelMembers = async (
  db: D1Database,
  channelId: string,
  limit: number,
  cursor: ChannelMemberCursor | null,
): Promise<ChannelMemberPage> => {
  const query = cursor === null
    ? `SELECT channel_id, user_id, role, created_at, updated_at
         FROM channel_members
        WHERE channel_id = ?
        ORDER BY created_at, user_id
        LIMIT ?`
    : `SELECT channel_id, user_id, role, created_at, updated_at
         FROM channel_members
        WHERE channel_id = ?
          AND (created_at > ? OR (created_at = ? AND user_id > ?))
        ORDER BY created_at, user_id
        LIMIT ?`;
  const values = cursor === null
    ? [channelId, limit + 1]
    : [channelId, cursor.createdAt, cursor.createdAt, cursor.userId, limit + 1];
  const result = await db.prepare(query).bind(...values).all<ChannelMemberRow>();
  const hasNextPage = result.results.length > limit;
  const rows = result.results.slice(0, limit);
  const members = rows.map(mapChannelMember);
  const last = rows.at(-1);
  return {
    members,
    nextCursor: hasNextPage && last !== undefined
      ? encodeCursor({ createdAt: last.created_at, userId: last.user_id })
      : null,
  };
};

export const countBroadcasterMembers = async (
  db: D1Database,
  channelId: string,
): Promise<number> => {
  const row = await db.prepare(
    `SELECT COUNT(*) AS count
       FROM channel_members
      WHERE channel_id = ? AND role = ${sqlRole("broadcaster")}`,
  ).bind(channelId).first<{ count: number }>();
  return row?.count ?? 0;
};

export const createChannelMemberWithAudit = async (
  db: D1Database,
  actor: ActorContext,
  member: ChannelMemberRecord,
  action: AuditAction,
  changedAt: string,
  guard: string | MutationGuard,
  actorKind: AuditActorKind = "member",
): Promise<boolean> => {
  const guardParts = mutationGuardParts(guard, actor, member.channelId, changedAt);
  const mutation = db.prepare(
    `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM channel_members
         WHERE channel_id = ? AND user_id = ?
      )
      ${guardParts.sql}`,
  ).bind(
    member.channelId,
    member.userId,
    member.role,
    member.createdAt,
    member.updatedAt,
    member.channelId,
    member.userId,
    ...guardParts.values,
  );
  const audit = prepareMemberAudit(
    db,
    actor.userId,
    changedAt,
    member.channelId,
    action,
    null,
    member,
    actorKind,
  );
  const results = await db.batch([mutation, audit]);
  return (results[0]?.meta.changes ?? 0) > 0;
};

export const updateChannelMemberWithAudit = async (
  db: D1Database,
  actor: ActorContext,
  member: ChannelMemberRecord,
  action: AuditAction,
  changedAt: string,
  guard: string | MutationGuard,
  actorKind: AuditActorKind = "member",
): Promise<boolean> => {
  const before = await getChannelMember(db, member.channelId, member.userId);
  if (before === null) return false;
  const after: ChannelMemberRecord = { ...member, createdAt: before.createdAt };
  const guardParts = mutationGuardParts(guard, actor, after.channelId, changedAt);
  const mutation = db.prepare(
    `UPDATE channel_members
        SET role = ?, updated_at = ?
      WHERE channel_id = ? AND user_id = ?
        AND role = ?
        AND created_at = ?
        AND updated_at = ?
      ${guardParts.sql}
      ${lastBroadcasterRoleChangeGuard}`,
  ).bind(
    after.role,
    after.updatedAt,
    after.channelId,
    after.userId,
    before.role,
    before.createdAt,
    before.updatedAt,
    ...guardParts.values,
    after.role,
    after.channelId,
  );
  const audit = prepareMemberAudit(
    db,
    actor.userId,
    changedAt,
    after.channelId,
    action,
    before,
    after,
    actorKind,
  );
  const results = await db.batch([mutation, audit]);
  return (results[0]?.meta.changes ?? 0) > 0;
};

export const deleteChannelMemberWithAudit = async (
  db: D1Database,
  actor: ActorContext,
  channelId: string,
  userId: string,
  action: AuditAction,
  changedAt: string,
  guard: string | MutationGuard,
  actorKind: AuditActorKind = "member",
): Promise<boolean> => {
  const before = await getChannelMember(db, channelId, userId);
  if (before === null) return false;
  const guardParts = mutationGuardParts(guard, actor, channelId, changedAt);
  const mutation = db.prepare(
    `DELETE FROM channel_members
      WHERE channel_id = ? AND user_id = ?
        AND role = ?
        AND created_at = ?
        AND updated_at = ?
      ${guardParts.sql}
      ${lastBroadcasterGuard}`,
  ).bind(
    channelId,
    userId,
    before.role,
    before.createdAt,
    before.updatedAt,
    ...guardParts.values,
    channelId,
  );
  const audit = prepareMemberAudit(
    db,
    actor.userId,
    changedAt,
    channelId,
    action,
    before,
    null,
    actorKind,
  );
  const results = await db.batch([mutation, audit]);
  return (results[0]?.meta.changes ?? 0) > 0;
};
