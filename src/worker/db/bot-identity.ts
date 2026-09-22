import type { IdentityStatus } from "../../contracts/values";

export interface BotIdentityRecord {
  id: 1;
  userId: string;
  login: string;
  scopesJson: string;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface BotIdentityStatusRecord {
  status: IdentityStatus;
  reason: string | null;
  updatedAt: string;
}

interface BotIdentityRow {
  id: 1;
  user_id: string;
  login: string;
  scopes_json: string;
  access_token_ciphertext: string;
  refresh_token_ciphertext: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

interface BotIdentityStatusRow {
  id: 1;
  status: IdentityStatus;
  reason: string | null;
  updated_at: string;
}

const mapBotIdentity = (row: BotIdentityRow): BotIdentityRecord => ({
  id: 1,
  userId: row.user_id,
  login: row.login,
  scopesJson: row.scopes_json,
  accessTokenCiphertext: row.access_token_ciphertext,
  refreshTokenCiphertext: row.refresh_token_ciphertext,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const getBotIdentity = async (db: D1Database): Promise<BotIdentityRecord | null> => {
  const row = await db.prepare(
    `SELECT id, user_id, login, scopes_json, access_token_ciphertext,
            refresh_token_ciphertext, expires_at, created_at, updated_at
       FROM bot_identity
      WHERE id = 1`,
  ).first<BotIdentityRow>();
  return row === null ? null : mapBotIdentity(row);
};

export const upsertBotIdentity = async (
  db: D1Database,
  identity: BotIdentityRecord,
): Promise<void> => {
  await db.prepare(
    `INSERT INTO bot_identity
      (id, user_id, login, scopes_json, access_token_ciphertext,
       refresh_token_ciphertext, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       user_id = excluded.user_id,
       login = excluded.login,
       scopes_json = excluded.scopes_json,
       access_token_ciphertext = excluded.access_token_ciphertext,
       refresh_token_ciphertext = excluded.refresh_token_ciphertext,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`,
  ).bind(
    identity.id,
    identity.userId,
    identity.login,
    identity.scopesJson,
    identity.accessTokenCiphertext,
    identity.refreshTokenCiphertext,
    identity.expiresAt,
    identity.createdAt,
    identity.updatedAt,
  ).run();
};

export const upsertBotIdentityAndStatus = async (
  db: D1Database,
  identity: BotIdentityRecord,
  status: IdentityStatus,
  reason: string | null,
  updatedAt: string,
): Promise<void> => {
  const identityMutation = db.prepare(
    `INSERT INTO bot_identity
      (id, user_id, login, scopes_json, access_token_ciphertext,
       refresh_token_ciphertext, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       user_id = excluded.user_id,
       login = excluded.login,
       scopes_json = excluded.scopes_json,
       access_token_ciphertext = excluded.access_token_ciphertext,
       refresh_token_ciphertext = excluded.refresh_token_ciphertext,
       expires_at = excluded.expires_at,
       updated_at = excluded.updated_at`,
  ).bind(
    identity.id,
    identity.userId,
    identity.login,
    identity.scopesJson,
    identity.accessTokenCiphertext,
    identity.refreshTokenCiphertext,
    identity.expiresAt,
    identity.createdAt,
    identity.updatedAt,
  );
  const statusMutation = db.prepare(
    `INSERT INTO bot_identity_status (id, status, reason, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       reason = excluded.reason,
       updated_at = excluded.updated_at`,
  ).bind(1, status, reason, updatedAt);
  await db.batch([identityMutation, statusMutation]);
};

export const getBotIdentityStatus = async (
  db: D1Database,
): Promise<BotIdentityStatusRecord | null> => {
  const row = await db.prepare(
    "SELECT id, status, reason, updated_at FROM bot_identity_status WHERE id = 1",
  ).first<BotIdentityStatusRow>();
  return row === null ? null : {
    status: row.status,
    reason: row.reason,
    updatedAt: row.updated_at,
  };
};

export const setBotIdentityStatus = async (
  db: D1Database,
  status: IdentityStatus,
  reason: string | null,
  updatedAt: string,
): Promise<void> => {
  await db.prepare(
    `INSERT INTO bot_identity_status (id, status, reason, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       status = excluded.status,
       reason = excluded.reason,
       updated_at = excluded.updated_at`,
  ).bind(1, status, reason, updatedAt).run();
};

export const setBotIdentityStatusIfCurrent = async (
  db: D1Database,
  status: IdentityStatus,
  reason: string | null,
  updatedAt: string,
  expectedAccessTokenCiphertext: string,
  expectedRefreshTokenCiphertext: string,
): Promise<boolean> => {
  const result = await db.prepare(
    `UPDATE bot_identity_status
        SET status = ?, reason = ?, updated_at = ?
      WHERE id = 1
        AND status <> 'revoked'
        AND EXISTS (
          SELECT 1 FROM bot_identity
           WHERE id = 1
             AND access_token_ciphertext = ?
             AND refresh_token_ciphertext = ?
        )`,
  ).bind(
    status,
    reason,
    updatedAt,
    expectedAccessTokenCiphertext,
    expectedRefreshTokenCiphertext,
  ).run();
  return result.meta.changes > 0;
};

export const rotateBotTokens = async (
  db: D1Database,
  expectedAccessTokenCiphertext: string,
  expectedRefreshTokenCiphertext: string,
  accessTokenCiphertext: string,
  refreshTokenCiphertext: string,
  expiresAt: string,
  updatedAt: string,
): Promise<boolean> => {
  const tokenRotation = db.prepare(
    `UPDATE bot_identity
        SET access_token_ciphertext = ?,
            refresh_token_ciphertext = ?,
            expires_at = ?,
            updated_at = ?
      WHERE id = 1
        AND access_token_ciphertext = ?
        AND refresh_token_ciphertext = ?`,
  ).bind(
    accessTokenCiphertext,
    refreshTokenCiphertext,
    expiresAt,
    updatedAt,
    expectedAccessTokenCiphertext,
    expectedRefreshTokenCiphertext,
  );
  const statusRecovery = db.prepare(
    `UPDATE bot_identity_status
        SET status = 'connected', reason = NULL, updated_at = ?
      WHERE id = 1
        AND status = 'revoked'
        AND reason = 'authorization_revoked'
        AND julianday(updated_at) <= julianday(?)
        AND EXISTS (
          SELECT 1 FROM bot_identity
           WHERE id = 1
             AND access_token_ciphertext = ?
             AND refresh_token_ciphertext = ?
        )`,
  ).bind(updatedAt, updatedAt, accessTokenCiphertext, refreshTokenCiphertext);
  const results = await db.batch([tokenRotation, statusRecovery]);
  return (results[0]?.meta.changes ?? 0) > 0;
};

export const setBotIdentityMissingScopesIfCurrent = async (
  db: D1Database,
  missingScopes: readonly string[],
  expectedAccessTokenCiphertext: string,
  expectedRefreshTokenCiphertext: string,
): Promise<boolean> => {
  const result = await db.prepare(
    `UPDATE bot_identity
        SET missing_scopes_json = ?
      WHERE id = 1
        AND access_token_ciphertext = ?
        AND refresh_token_ciphertext = ?`,
  ).bind(
    JSON.stringify([...missingScopes]),
    expectedAccessTokenCiphertext,
    expectedRefreshTokenCiphertext,
  ).run();
  return result.meta.changes > 0;
};
