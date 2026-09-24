import {
  actorGuard,
  bindActorGuard,
  type ActorContext,
} from "../db/guards";
import { MANAGING_ROLES, type ChannelRole } from "../../contracts/values";
import type { ModuleLanguage } from "../../modules/contract";
import { prepareModuleAudit } from "../module-audit";

export const overlayTokenRoles: readonly ChannelRole[] = MANAGING_ROLES;
const OVERLAY_AUDIT_MODULE_ID = null;

type OverlayTokenAuditSnapshot = Pick<
  NewOverlayTokenRecord,
  "tokenId" | "createdAt" | "expiresAt" | "revokedAt" | "revocationReason"
>;

interface OverlayTokenAuditRow {
  token_id: string;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  revocation_reason: string | null;
}

const overlayTokenAuditSnapshot = (token: OverlayTokenAuditSnapshot): OverlayTokenAuditSnapshot => ({
  tokenId: token.tokenId,
  createdAt: token.createdAt,
  expiresAt: token.expiresAt,
  revokedAt: token.revokedAt,
  revocationReason: token.revocationReason,
});

export interface NewOverlayTokenRecord {
  tokenId: string;
  channelId: string;
  tokenHash: string;
  expiresAt: string | null;
  createdAt: string;
  revokedAt: string | null;
  revocationReason: string | null;
  lastUsedAt: string | null;
}

export interface OverlayTokenRecord extends NewOverlayTokenRecord {
  language: ModuleLanguage;
}

export interface ActiveOverlayTokenRecord {
  tokenId: string;
  name: null;
  createdAt: string;
  createdByUserId: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export interface ActiveOverlayTokenPage {
  tokens: ActiveOverlayTokenRecord[];
  nextOffset: number | null;
}

interface ActiveOverlayTokenRow {
  token_id: string;
  created_at: string;
  created_by_user_id: string | null;
  last_used_at: string | null;
  expires_at: string | null;
}

interface OverlayTokenRow {
  token_id: string;
  channel_id: string;
  token_hash: string;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
  last_used_at: string | null;
  language: ModuleLanguage;
}

const mapOverlayToken = (row: OverlayTokenRow): OverlayTokenRecord => ({
  tokenId: row.token_id,
  channelId: row.channel_id,
  tokenHash: row.token_hash,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  revokedAt: row.revoked_at,
  revocationReason: row.revocation_reason,
  lastUsedAt: row.last_used_at,
  language: row.language,
});

export const overlayTokenSelectColumns = `
  token.token_id AS token_id,
  token.channel_id AS channel_id,
  token.token_hash AS token_hash,
  token.expires_at AS expires_at,
  token.created_at AS created_at,
  token.revoked_at AS revoked_at,
  token.revocation_reason AS revocation_reason,
  token.last_used_at AS last_used_at,
  channel.language AS language`;

export const overlayTokenReturningColumns = `
  token_id, channel_id, token_hash, expires_at, created_at,
  revoked_at, revocation_reason, last_used_at`;

/**
 * Creator IDs are stored directly on token rows so dashboard listing does not
 * need to join and extract the issuance audit JSON for every token.
 */
export const listActiveOverlayTokens = async (
  db: D1Database,
  channelId: string,
  now: string,
  offset = 0,
): Promise<ActiveOverlayTokenPage> => {
  const pageSize = 50;
  const rows = await db.prepare(
    `SELECT token.token_id, token.created_at, token.created_by_user_id,
            token.last_used_at, token.expires_at
       FROM overlay_tokens AS token
      WHERE token.channel_id = ?
        AND token.overlay_id IS NULL
        AND token.revoked_at IS NULL
        AND (
          token.expires_at IS NULL
          OR (
            julianday(token.expires_at) IS NOT NULL
            AND julianday(token.expires_at) > julianday(?)
          )
        )
      ORDER BY token.created_at DESC, token.token_id DESC
      LIMIT ? OFFSET ?`,
  ).bind(channelId, now, pageSize + 1, offset).all<ActiveOverlayTokenRow>();
  const hasMore = rows.results.length > pageSize;
  return {
    tokens: rows.results.slice(0, pageSize).map((row) => ({
      tokenId: row.token_id,
      name: null,
      createdAt: row.created_at,
      createdByUserId: row.created_by_user_id,
      lastUsedAt: row.last_used_at,
      expiresAt: row.expires_at,
    })),
    nextOffset: hasMore ? offset + pageSize : null,
  };
};

/**
 * `request.text()` sits between the guard and this mutation. A client can
 * leave the body open until its membership is revoked or the session is
 * revoked, and only close it afterward. That's why the INSERT repeats the
 * check itself; without a live session no row is created.
 *
 * Returns: true if the token was issued.
 */
export const createOverlayToken = async (
  db: D1Database,
  token: NewOverlayTokenRecord,
  actor: ActorContext,
): Promise<boolean> => {
  const mutation = db.prepare(
    `INSERT INTO overlay_tokens
      (token_id, channel_id, token_hash, expires_at, created_at, created_by_user_id,
       revoked_at, revocation_reason, last_used_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE 1 = 1
      ${actorGuard(overlayTokenRoles)}`,
  ).bind(
    token.tokenId,
    token.channelId,
    token.tokenHash,
    token.expiresAt,
    token.createdAt,
    actor.userId,
    token.revokedAt,
    token.revocationReason,
    token.lastUsedAt,
    ...bindActorGuard(actor, token.channelId, token.createdAt),
  );
  const audit = prepareModuleAudit(db, actor.userId, token.createdAt, {
    channelId: token.channelId,
    moduleId: OVERLAY_AUDIT_MODULE_ID,
    action: "overlay.token.issued",
    before: null,
    after: overlayTokenAuditSnapshot(token),
  });
  const results = await db.batch([mutation, audit]);
  return (results[0]?.meta.changes ?? 0) > 0;
};

export const getUsableOverlayToken = async (
  db: D1Database,
  tokenHash: string,
  now: string,
): Promise<OverlayTokenRecord | null> => {
  const row = await db.prepare(
    `SELECT ${overlayTokenSelectColumns}
       FROM overlay_tokens AS token
       JOIN channels AS channel ON channel.channel_id = token.channel_id
      WHERE token.token_hash = ?
        AND token.revoked_at IS NULL
        AND (
          token.expires_at IS NULL
          OR (
            julianday(token.expires_at) IS NOT NULL
            AND julianday(token.expires_at) > julianday(?)
          )
        )`,
  ).bind(tokenHash, now).first<OverlayTokenRow>();
  return row === null ? null : mapOverlayToken(row);
};

/** Reads the immutable overlay assignment stored on the token row. */
export const getOverlayBindingForToken = async (
  db: D1Database,
  channelId: string,
  tokenId: string,
): Promise<string | null> => {
  const row = await db.prepare(
    `SELECT overlay_id
       FROM overlay_tokens
      WHERE channel_id = ? AND token_id = ?`,
  ).bind(channelId, tokenId).first<{ overlay_id: string | null }>();
  // A missing row is an authentication consistency failure. Treating it as a
  // legacy token would grant channel-wide access after a failed binding read.
  if (row === null) throw new Error("Authenticated overlay token binding could not be read.");
  return row.overlay_id;
};

export const touchOverlayToken = async (
  db: D1Database,
  channelId: string,
  tokenId: string,
  lastUsedAt: string,
  cutoff: string,
): Promise<boolean> => {
  const result = await db.prepare(
    `UPDATE overlay_tokens
        SET last_used_at = ?
      WHERE token_id = ?
        AND channel_id = ?
        AND revoked_at IS NULL
        AND (
          last_used_at IS NULL
          OR julianday(last_used_at) IS NULL
          OR julianday(last_used_at) <= julianday(?)
        )
      RETURNING ${overlayTokenReturningColumns}`,
  ).bind(lastUsedAt, tokenId, channelId, cutoff).first<NewOverlayTokenRecord>();
  return result !== null;
};

export const revokeOverlayToken = async (
  db: D1Database,
  channelId: string,
  tokenId: string,
  revokedAt: string,
  reason: string,
  actor: ActorContext,
): Promise<boolean> => {
  const beforeRow = await db.prepare(
    `SELECT token_id, created_at, expires_at, revoked_at, revocation_reason
       FROM overlay_tokens
      WHERE token_id = ? AND channel_id = ? AND overlay_id IS NULL`,
  ).bind(tokenId, channelId).first<OverlayTokenAuditRow>();
  if (beforeRow === null) return false;
  // A repeated revoke is a useful retry for the realtime close. The row is
  // already authoritative, so don't write a second audit entry.
  if (beforeRow.revoked_at !== null) {
    const authorized = await db.prepare(
      `SELECT 1 AS allowed WHERE 1 = 1 ${actorGuard(overlayTokenRoles)}`,
    ).bind(...bindActorGuard(actor, channelId, revokedAt)).first<{ allowed: number }>();
    return authorized !== null;
  }

  const before = overlayTokenAuditSnapshot({
    tokenId: beforeRow.token_id,
    createdAt: beforeRow.created_at,
    expiresAt: beforeRow.expires_at,
    revokedAt: beforeRow.revoked_at,
    revocationReason: beforeRow.revocation_reason,
  });
  const mutation = db.prepare(
    `UPDATE overlay_tokens
        SET revoked_at = ?, revocation_reason = ?
      WHERE token_id = ?
        AND channel_id = ?
        AND overlay_id IS NULL
        AND revoked_at IS NULL
        AND created_at = ?
        AND (expires_at = ? OR (expires_at IS NULL AND ? IS NULL))
      ${actorGuard(overlayTokenRoles)}`,
  ).bind(
    revokedAt,
    reason,
    tokenId,
    channelId,
    before.createdAt,
    before.expiresAt,
    before.expiresAt,
    ...bindActorGuard(actor, channelId, revokedAt),
  );
  const audit = prepareModuleAudit(db, actor.userId, revokedAt, {
    channelId,
    moduleId: OVERLAY_AUDIT_MODULE_ID,
    action: "overlay.token.revoked",
    before,
    after: { ...before, revokedAt, revocationReason: reason },
  });
  const results = await db.batch([mutation, audit]);
  return (results[0]?.meta.changes ?? 0) > 0;
};
