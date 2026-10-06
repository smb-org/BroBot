import {
  MANAGING_ROLES,
  OVERLAY_ACCESS_REVOCATION_REASONS,
  type OverlayAccessRevocationReason,
} from "../../contracts/values";
import { actorGuard, bindActorGuard, type ActorContext } from "../db/guards";
import { prepareAudit } from "../db/audit";

export const OVERLAY_ACCESS_MAXIMUM_COUNT = 10;
export const overlayAccessActivePredicate = `revoked_at IS NULL AND
  (expires_at IS NULL OR
    (julianday(expires_at) IS NOT NULL AND julianday(expires_at) > julianday(?)))`;

export interface NewOverlayAccessRecord {
  tokenId: string;
  channelId: string;
  overlayId: string;
  tokenHash: string;
  secretEnvelope: string;
  label: string;
  expiresAt: string | null;
  createdAt: string;
}

export interface OverlayAccessRecord extends NewOverlayAccessRecord {
  revokedAt: string | null;
  revocationReason: OverlayAccessRevocationReason | null;
  lastUsedAt: string | null;
}

export type OverlayAccessMetadata = Omit<OverlayAccessRecord, "tokenHash" | "secretEnvelope">;

export interface OverlayAccessListEntry {
  tokenId: string;
  overlayId: string;
  label: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  recoverable: boolean;
}

interface OverlayAccessRow {
  token_id: string;
  channel_id: string;
  overlay_id: string | null;
  token_hash: string;
  secret_envelope: string | null;
  label: string;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
  last_used_at: string | null;
}

const mapMetadata = (row: OverlayAccessRow): OverlayAccessMetadata | null => {
  if (row.overlay_id === null) return null;
  return {
    tokenId: row.token_id,
    channelId: row.channel_id,
    overlayId: row.overlay_id,
    label: row.label,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    revocationReason: OVERLAY_ACCESS_REVOCATION_REASONS.includes(
      row.revocation_reason as OverlayAccessRevocationReason,
    ) ? row.revocation_reason as OverlayAccessRevocationReason : null,
    lastUsedAt: row.last_used_at,
  };
};

const mapAccess = (row: OverlayAccessRow): OverlayAccessRecord | null => {
  const metadata = mapMetadata(row);
  return metadata === null ? null : {
    ...metadata,
    tokenHash: row.token_hash,
    secretEnvelope: row.secret_envelope ?? "",
  };
};

export const overlayAccessColumns = `
  token_id, channel_id, overlay_id, token_hash, secret_envelope, label,
  expires_at, created_at, revoked_at, revocation_reason, last_used_at`;

export const overlayAccessMetadataColumns = `
  token_id, channel_id, overlay_id, label, expires_at, created_at, revoked_at, revocation_reason, last_used_at`;

const accessAuditSnapshot = (access: Pick<OverlayAccessMetadata,
  "tokenId" | "overlayId" | "label" | "expiresAt" | "createdAt" | "revokedAt" | "revocationReason">) => ({
  tokenId: access.tokenId,
  overlayId: access.overlayId,
  label: access.label,
  expiresAt: access.expiresAt,
  createdAt: access.createdAt,
  revokedAt: access.revokedAt,
  revocationReason: access.revocationReason,
});

export const listOverlayAccesses = async (
  db: D1Database,
  channelId: string,
  overlayId: string,
): Promise<OverlayAccessListEntry[]> => {
  const result = await db.prepare(
    `SELECT token_id, overlay_id, secret_envelope, label, created_at, expires_at, revoked_at, last_used_at
       FROM overlay_tokens
      WHERE channel_id = ? AND overlay_id = ?
      ORDER BY created_at DESC, token_id DESC`,
  ).bind(channelId, overlayId).all<Pick<OverlayAccessRow,
    "token_id" | "overlay_id" | "secret_envelope" | "label" | "created_at" | "expires_at" | "revoked_at" | "last_used_at">>();
  return result.results.flatMap((row) => row.overlay_id === null ? [] : [{
    tokenId: row.token_id,
    overlayId: row.overlay_id,
    label: row.label,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    recoverable: typeof row.secret_envelope === "string" && row.secret_envelope.length > 0,
  }]);
};

export const getOverlayAccessMetadata = async (
  db: D1Database,
  channelId: string,
  overlayId: string,
  tokenId: string,
): Promise<OverlayAccessMetadata | null> => {
  const row = await db.prepare(
    `SELECT ${overlayAccessMetadataColumns}
       FROM overlay_tokens
      WHERE channel_id = ? AND overlay_id = ? AND token_id = ?`,
  ).bind(channelId, overlayId, tokenId).first<OverlayAccessRow>();
  return row === null ? null : mapMetadata(row);
};

export const getOverlayAccessForReplacement = async (
  db: D1Database,
  channelId: string,
  overlayId: string,
  tokenId: string,
  actor: ActorContext,
  now: string,
): Promise<OverlayAccessMetadata | null> => {
  const row = await db.prepare(
    `SELECT ${overlayAccessMetadataColumns}
       FROM overlay_tokens
      WHERE channel_id = ? AND overlay_id = ? AND token_id = ?
        ${actorGuard(MANAGING_ROLES)}`,
  ).bind(channelId, overlayId, tokenId, ...bindActorGuard(actor, channelId, now)).first<OverlayAccessRow>();
  return row === null ? null : mapMetadata(row);
};

export const getOverlayAccessForReveal = async (
  db: D1Database,
  channelId: string,
  overlayId: string,
  tokenId: string,
  actor: ActorContext,
  now: string,
): Promise<OverlayAccessRecord | null> => {
  const row = await db.prepare(
    `SELECT ${overlayAccessColumns}
       FROM overlay_tokens
      WHERE channel_id = ? AND overlay_id = ? AND token_id = ?
        AND revoked_at IS NULL
        AND (expires_at IS NULL OR
          (julianday(expires_at) IS NOT NULL AND julianday(expires_at) > julianday(?)))
        ${actorGuard(MANAGING_ROLES)}`,
  ).bind(channelId, overlayId, tokenId, now, ...bindActorGuard(actor, channelId, now)).first<OverlayAccessRow>();
  return row === null ? null : mapAccess(row);
};

export const countActiveOverlayAccesses = async (
  db: D1Database,
  channelId: string,
  overlayId: string,
  now: string,
): Promise<number> => {
  const row = await db.prepare(
    `SELECT COUNT(*) AS count
       FROM overlay_tokens
      WHERE channel_id = ? AND overlay_id = ? AND revoked_at IS NULL
        AND (expires_at IS NULL OR (julianday(expires_at) IS NOT NULL AND julianday(expires_at) > julianday(?)))`,
  ).bind(channelId, overlayId, now).first<{ count: number }>();
  return row?.count ?? 0;
};

export const createOverlayAccess = async (
  db: D1Database,
  access: NewOverlayAccessRecord,
  actor: ActorContext,
): Promise<boolean> => {
  const mutation = db.prepare(
    `INSERT INTO overlay_tokens
      (token_id, channel_id, token_hash, expires_at, created_at, created_by_user_id,
       revoked_at, revocation_reason, last_used_at, overlay_id, label, secret_envelope)
     SELECT ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM overlays
         WHERE channel_id = ? AND overlay_id = ?
      )
        AND (
          SELECT COUNT(*) FROM overlay_tokens
           WHERE channel_id = ? AND overlay_id = ? AND revoked_at IS NULL
             AND (expires_at IS NULL OR
               (julianday(expires_at) IS NOT NULL AND julianday(expires_at) > julianday(?)))
        ) < ?
        ${actorGuard(MANAGING_ROLES)}`,
  ).bind(
    access.tokenId,
    access.channelId,
    access.tokenHash,
    access.expiresAt,
    access.createdAt,
    actor.userId,
    access.overlayId,
    access.label,
    access.secretEnvelope,
    access.channelId,
    access.overlayId,
    access.channelId,
    access.overlayId,
    access.createdAt,
    OVERLAY_ACCESS_MAXIMUM_COUNT,
    ...bindActorGuard(actor, access.channelId, access.createdAt),
  );
  const audit = prepareAudit(db, actor.userId, access.createdAt, access.channelId, null,
    "overlay.access.issued", null, accessAuditSnapshot({ ...access, revokedAt: null, revocationReason: null }));
  const result = await db.batch([mutation, audit]);
  return (result[0]?.meta.changes ?? 0) > 0;
};

/** Issues a new credential and cuts off the old one in one guarded D1 batch. */
export const replaceOverlayAccess = async (
  db: D1Database,
  before: OverlayAccessMetadata,
  replacement: NewOverlayAccessRecord,
  actor: ActorContext,
): Promise<boolean> => {
  const insert = db.prepare(
    `INSERT INTO overlay_tokens
      (token_id, channel_id, token_hash, expires_at, created_at, created_by_user_id,
       revoked_at, revocation_reason, last_used_at, overlay_id, label, secret_envelope)
     SELECT ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM overlays
         WHERE channel_id = ? AND overlay_id = ?
      )
        AND EXISTS (
          SELECT 1 FROM overlay_tokens
           WHERE token_id = ? AND channel_id = ? AND overlay_id = ?
             AND created_at = ? AND (expires_at = ? OR (expires_at IS NULL AND ? IS NULL))
             AND revoked_at IS NULL
        )
        AND (
          (SELECT COUNT(*) FROM overlay_tokens
            WHERE channel_id = ? AND overlay_id = ? AND revoked_at IS NULL
              AND (expires_at IS NULL OR
                (julianday(expires_at) IS NOT NULL AND julianday(expires_at) > julianday(?)))) < ?
          OR EXISTS (
            SELECT 1 FROM overlay_tokens
             WHERE token_id = ? AND channel_id = ? AND overlay_id = ?
               AND created_at = ? AND (expires_at = ? OR (expires_at IS NULL AND ? IS NULL))
               AND ${overlayAccessActivePredicate}
          )
        )
        ${actorGuard(MANAGING_ROLES)}`,
  ).bind(
    replacement.tokenId,
    replacement.channelId,
    replacement.tokenHash,
    replacement.expiresAt,
    replacement.createdAt,
    actor.userId,
    replacement.overlayId,
    replacement.label,
    replacement.secretEnvelope,
    replacement.channelId,
    replacement.overlayId,
    before.tokenId,
    before.channelId,
    before.overlayId,
    before.createdAt,
    before.expiresAt,
    before.expiresAt,
    replacement.channelId,
    replacement.overlayId,
    replacement.createdAt,
    OVERLAY_ACCESS_MAXIMUM_COUNT,
    before.tokenId,
    before.channelId,
    before.overlayId,
    before.createdAt,
    before.expiresAt,
    before.expiresAt,
    replacement.createdAt,
    ...bindActorGuard(actor, replacement.channelId, replacement.createdAt),
  );
  const revoke = db.prepare(
    `UPDATE overlay_tokens
        SET revoked_at = ?, revocation_reason = 'replaced'
      WHERE token_id = ? AND channel_id = ? AND overlay_id = ? AND revoked_at IS NULL
        AND created_at = ? AND (expires_at = ? OR (expires_at IS NULL AND ? IS NULL))
        AND EXISTS (
          SELECT 1 FROM overlay_tokens
           WHERE token_id = ? AND channel_id = ? AND overlay_id = ?
             AND created_at = ? AND revoked_at IS NULL
        )
        ${actorGuard(MANAGING_ROLES)}`,
  ).bind(
    replacement.createdAt,
    before.tokenId,
    before.channelId,
    before.overlayId,
    before.createdAt,
    before.expiresAt,
    before.expiresAt,
    replacement.tokenId,
    replacement.channelId,
    replacement.overlayId,
    replacement.createdAt,
    ...bindActorGuard(actor, replacement.channelId, replacement.createdAt),
  );
  const audit = prepareAudit(db, actor.userId, replacement.createdAt, replacement.channelId, null,
    "overlay.access.replaced",
    accessAuditSnapshot(before),
    accessAuditSnapshot({ ...replacement, revokedAt: null, revocationReason: null }));
  const result = await db.batch([insert, revoke, audit]);
  return (result[0]?.meta.changes ?? 0) > 0 && (result[1]?.meta.changes ?? 0) > 0;
};

export const authorizeOverlayAccessManager = async (
  db: D1Database,
  actor: ActorContext,
  channelId: string,
  now: string,
): Promise<boolean> => {
  const row = await db.prepare(`SELECT 1 AS allowed WHERE 1 = 1 ${actorGuard(MANAGING_ROLES)}`)
    .bind(...bindActorGuard(actor, channelId, now)).first<{ allowed: number }>();
  return row !== null;
};

export const recordOverlayAccessReveal = async (
  db: D1Database,
  access: OverlayAccessRecord,
  actor: ActorContext,
  revealedAt: string,
): Promise<boolean> => {
  const snapshot = accessAuditSnapshot({ ...access, revokedAt: null, revocationReason: null });
  const result = await db.prepare(
    `INSERT INTO audit_log
      (audit_id, actor_user_id, created_at, channel_id, module_id, action, before_json, after_json, actor_kind)
     SELECT ?, ?, ?, ?, NULL, 'overlay.access.revealed', ?, ?, 'member'
      WHERE EXISTS (
        SELECT 1 FROM overlay_tokens
         WHERE token_id = ? AND channel_id = ? AND overlay_id = ?
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR
             (julianday(expires_at) IS NOT NULL AND julianday(expires_at) > julianday(?)))
      )
        ${actorGuard(MANAGING_ROLES)}`,
  ).bind(
    crypto.randomUUID(), actor.userId, revealedAt, access.channelId,
    JSON.stringify(snapshot), JSON.stringify(snapshot),
    access.tokenId, access.channelId, access.overlayId, revealedAt,
    ...bindActorGuard(actor, access.channelId, revealedAt),
  ).run();
  return result.meta.changes > 0;
};

export type RevokeOverlayAccessResult = "revoked" | "already_revoked" | "not_found" | "forbidden";
export type RemoveOverlayAccessResult = "removed" | "not_found" | "not_revoked" | "forbidden";

export const revokeOverlayAccess = async (
  db: D1Database,
  channelId: string,
  overlayId: string,
  tokenId: string,
  actor: ActorContext,
  revokedAt: string,
): Promise<RevokeOverlayAccessResult> => {
  const before = await getOverlayAccessMetadata(db, channelId, overlayId, tokenId);
  if (before === null) {
    return await authorizeOverlayAccessManager(db, actor, channelId, revokedAt) ? "not_found" : "forbidden";
  }
  if (before.revokedAt !== null) {
    return await authorizeOverlayAccessManager(db, actor, channelId, revokedAt) ? "already_revoked" : "forbidden";
  }
  const reason: OverlayAccessRevocationReason = "manual";
  const mutation = db.prepare(
    `UPDATE overlay_tokens
        SET revoked_at = ?, revocation_reason = ?
      WHERE token_id = ? AND channel_id = ? AND overlay_id = ? AND revoked_at IS NULL
        AND created_at = ? AND (expires_at = ? OR (expires_at IS NULL AND ? IS NULL))
        ${actorGuard(MANAGING_ROLES)}`,
  ).bind(revokedAt, reason, tokenId, channelId, overlayId, before.createdAt,
    before.expiresAt, before.expiresAt, ...bindActorGuard(actor, channelId, revokedAt));
  const audit = prepareAudit(db, actor.userId, revokedAt, channelId, null,
    "overlay.access.revoked", accessAuditSnapshot(before), accessAuditSnapshot({ ...before, revokedAt, revocationReason: reason }));
  const result = await db.batch([mutation, audit]);
  if ((result[0]?.meta.changes ?? 0) > 0) return "revoked";
  if (!await authorizeOverlayAccessManager(db, actor, channelId, revokedAt)) return "forbidden";
  const current = await getOverlayAccessMetadata(db, channelId, overlayId, tokenId);
  if (current === null) return "not_found";
  return current.revokedAt === null ? "not_found" : "already_revoked";
};

export const removeRevokedOverlayAccess = async (
  db: D1Database,
  channelId: string,
  overlayId: string,
  tokenId: string,
  actor: ActorContext,
  removedAt: string,
): Promise<RemoveOverlayAccessResult> => {
  const before = await getOverlayAccessMetadata(db, channelId, overlayId, tokenId);
  if (before === null) {
    return await authorizeOverlayAccessManager(db, actor, channelId, removedAt) ? "not_found" : "forbidden";
  }
  if (before.revokedAt === null) {
    return await authorizeOverlayAccessManager(db, actor, channelId, removedAt) ? "not_revoked" : "forbidden";
  }

  const mutation = db.prepare(
    `DELETE FROM overlay_tokens
      WHERE token_id = ? AND channel_id = ? AND overlay_id = ?
        AND created_at = ? AND revoked_at = ?
        ${actorGuard(MANAGING_ROLES)}`,
  ).bind(tokenId, channelId, overlayId, before.createdAt, before.revokedAt,
    ...bindActorGuard(actor, channelId, removedAt));
  const audit = prepareAudit(db, actor.userId, removedAt, channelId, null,
    "overlay.access.removed", accessAuditSnapshot(before), null);
  const result = await db.batch([mutation, audit]);
  if ((result[0]?.meta.changes ?? 0) > 0) return "removed";
  if (!await authorizeOverlayAccessManager(db, actor, channelId, removedAt)) return "forbidden";
  const current = await getOverlayAccessMetadata(db, channelId, overlayId, tokenId);
  if (current === null) return "not_found";
  return current.revokedAt === null ? "not_revoked" : "not_found";
};

/** Removes revoked overlay accesses after 30 days, retaining channel-scoped audit snapshots. */
export const purgeRevokedOverlayAccesses = async (db: D1Database, now: string): Promise<void> => {
  const audit = db.prepare(
    `INSERT INTO audit_log
      (audit_id, actor_user_id, created_at, channel_id, module_id, action, before_json, after_json, actor_kind)
     SELECT lower(hex(randomblob(16))), NULL, ?, channel_id, NULL, 'overlay.access.removed',
       json_object(
         'tokenId', token_id,
         'overlayId', overlay_id,
         'label', label,
         'expiresAt', expires_at,
         'createdAt', created_at,
         'revokedAt', revoked_at,
         'revocationReason', revocation_reason
       ), 'null', 'system'
      FROM overlay_tokens
      WHERE overlay_id IS NOT NULL AND revoked_at IS NOT NULL
        AND julianday(revoked_at) IS NOT NULL
        AND julianday(revoked_at) <= julianday(?, '-30 days')`,
  ).bind(now, now);
  const remove = db.prepare(
    `DELETE FROM overlay_tokens
      WHERE overlay_id IS NOT NULL AND revoked_at IS NOT NULL
        AND julianday(revoked_at) IS NOT NULL
        AND julianday(revoked_at) <= julianday(?, '-30 days')`,
  ).bind(now);
  await db.batch([audit, remove]);
};
