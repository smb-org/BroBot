import {
  actorGuard,
  bindActorGuard,
  type ActorContext,
} from "../db/guards";
import type { ModuleLanguage } from "../../modules/contract";
import { prepareModuleAudit } from "../module-audit";

export const overlayTokenRoles = "'broadcaster', 'verwalter'";
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
 * Zwischen dem Guard und dieser Mutation liegt `request.text()`. Ein Client
 * kann den Body offen lassen, bis seine Mitgliedschaft entzogen oder die
 * Session widerrufen wurde, und erst danach abschliessen. Deshalb wiederholt
 * der INSERT die Pruefung selbst; ohne lebende Session entsteht keine Zeile.
 *
 * Rueckgabe: true, wenn das Token ausgegeben wurde.
 */
export const createOverlayToken = async (
  db: D1Database,
  token: NewOverlayTokenRecord,
  actor: ActorContext,
): Promise<boolean> => {
  const mutation = db.prepare(
    `INSERT INTO overlay_tokens
      (token_id, channel_id, token_hash, expires_at, created_at,
       revoked_at, revocation_reason, last_used_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?
      WHERE 1 = 1
      ${actorGuard(overlayTokenRoles)}`,
  ).bind(
    token.tokenId,
    token.channelId,
    token.tokenHash,
    token.expiresAt,
    token.createdAt,
    token.revokedAt,
    token.revocationReason,
    token.lastUsedAt,
    ...bindActorGuard(actor, token.channelId, token.createdAt),
  );
  const audit = prepareModuleAudit(db, actor.userId, token.createdAt, {
    channelId: token.channelId,
    moduleId: OVERLAY_AUDIT_MODULE_ID,
    action: "overlay.token.ausgestellt",
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

export const touchOverlayToken = async (
  db: D1Database,
  tokenId: string,
  lastUsedAt: string,
  cutoff: string,
): Promise<boolean> => {
  const result = await db.prepare(
    `UPDATE overlay_tokens
        SET last_used_at = ?
      WHERE token_id = ?
        AND revoked_at IS NULL
        AND (
          last_used_at IS NULL
          OR julianday(last_used_at) IS NULL
          OR julianday(last_used_at) <= julianday(?)
        )
      RETURNING ${overlayTokenReturningColumns}`,
  ).bind(lastUsedAt, tokenId, cutoff).first<NewOverlayTokenRecord>();
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
      WHERE token_id = ? AND channel_id = ?`,
  ).bind(tokenId, channelId).first<OverlayTokenAuditRow>();
  if (beforeRow === null) return false;

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
    action: "overlay.token.widerrufen",
    before,
    after: { ...before, revokedAt, revocationReason: reason },
  });
  const results = await db.batch([mutation, audit]);
  return (results[0]?.meta.changes ?? 0) > 0;
};
