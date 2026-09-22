import type { IdentityStatus } from "../../contracts/values";

export interface LoginIdentityRecord {
  userId: string;
  login: string;
  scopesJson: string;
  tokenScopesJson: string;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  expiresAt: string;
  status: IdentityStatus;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

interface LoginIdentityRow {
  user_id: string;
  login: string;
  scopes_json: string;
  token_scopes_json: string;
  access_token_ciphertext: string;
  refresh_token_ciphertext: string;
  expires_at: string;
  status: IdentityStatus;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

interface FullConsentChannelRow {
  vorhanden: number;
}

const mapLoginIdentity = (row: LoginIdentityRow): LoginIdentityRecord => ({
  userId: row.user_id,
  login: row.login,
  scopesJson: row.scopes_json,
  tokenScopesJson: row.token_scopes_json,
  accessTokenCiphertext: row.access_token_ciphertext,
  refreshTokenCiphertext: row.refresh_token_ciphertext,
  expiresAt: row.expires_at,
  status: row.status,
  reason: row.reason,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const listLoginIdentities = async (
  db: D1Database,
  now: string = new Date().toISOString(),
): Promise<LoginIdentityRecord[]> => {
  const result = await db.prepare(
    `SELECT user_id, login, scopes_json, token_scopes_json, access_token_ciphertext,
            refresh_token_ciphertext, expires_at, status, reason,
            created_at, updated_at
       FROM twitch_login_identity
      WHERE status <> 'revoked'
        AND EXISTS (
          SELECT 1 FROM auth_sessions
           WHERE auth_sessions.user_id = twitch_login_identity.user_id
             AND auth_sessions.revoked_at IS NULL
             AND auth_sessions.expires_at > ?
        )
      ORDER BY user_id`,
  ).bind(now).all<LoginIdentityRow>();
  return result.results.map(mapLoginIdentity);
};

export const getLoginIdentity = async (
  db: D1Database,
  userId: string,
): Promise<LoginIdentityRecord | null> => {
  const row = await db.prepare(
    `SELECT user_id, login, scopes_json, token_scopes_json, access_token_ciphertext,
            refresh_token_ciphertext, expires_at, status, reason,
            created_at, updated_at
       FROM twitch_login_identity
      WHERE user_id = ?`,
  ).bind(userId).first<LoginIdentityRow>();
  return row === null ? null : mapLoginIdentity(row);
};

export const hasFullConsentForChannelId = async (
  db: D1Database,
  channelId: string,
): Promise<boolean> => {
  const zeile = await db.prepare(
    `SELECT 1 AS vorhanden
       FROM channels
      WHERE channel_id = ? AND full_consent = 1`,
  ).bind(channelId).first<FullConsentChannelRow>();
  return zeile?.vorhanden === 1;
};

export const hasFullConsentForChannelLogin = async (
  db: D1Database,
  channelLogin: string,
): Promise<boolean> => {
  const zeile = await db.prepare(
    `SELECT 1 AS vorhanden
       FROM channels
      WHERE login = ? COLLATE NOCASE AND full_consent = 1`,
  ).bind(channelLogin).first<FullConsentChannelRow>();
  return zeile?.vorhanden === 1;
};

export const upsertLoginIdentity = async (
  db: D1Database,
  identity: LoginIdentityRecord,
): Promise<void> => {
  // scopes_json grows as a historical record of consent; token_scopes_json describes only the stored token and gets replaced.
  await db.prepare(
    `INSERT INTO twitch_login_identity
      (user_id, login, scopes_json, token_scopes_json, access_token_ciphertext,
       refresh_token_ciphertext, expires_at, status, reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       login = excluded.login,
       scopes_json = (
         SELECT json_group_array(scope)
           FROM (
             SELECT value AS scope FROM json_each(twitch_login_identity.scopes_json)
             UNION
             SELECT value AS scope FROM json_each(excluded.scopes_json)
            ORDER BY scope
           )
       ),
       token_scopes_json = excluded.token_scopes_json,
       access_token_ciphertext = excluded.access_token_ciphertext,
       refresh_token_ciphertext = excluded.refresh_token_ciphertext,
       expires_at = excluded.expires_at,
       status = excluded.status,
       reason = excluded.reason,
       updated_at = excluded.updated_at`,
  ).bind(
    identity.userId,
    identity.login,
    identity.scopesJson,
    identity.tokenScopesJson,
    identity.accessTokenCiphertext,
    identity.refreshTokenCiphertext,
    identity.expiresAt,
    identity.status,
    identity.reason,
    identity.createdAt,
    identity.updatedAt,
  ).run();
};

export const setLoginIdentityTokenScopes = async (
  db: D1Database,
  userId: string,
  scopesJson: string,
  updatedAt: string,
  expectedAccessTokenCiphertext?: string,
  expectedRefreshTokenCiphertext?: string,
): Promise<void> => {
  const currentToken = expectedAccessTokenCiphertext !== undefined && expectedRefreshTokenCiphertext !== undefined;
  const statement = currentToken
    ? db.prepare(
        `UPDATE twitch_login_identity
          SET token_scopes_json = ?, updated_at = ?
        WHERE user_id = ?
          AND status <> 'revoked'
          AND access_token_ciphertext = ?
          AND refresh_token_ciphertext = ?`,
    ).bind(
      scopesJson,
      updatedAt,
      userId,
      expectedAccessTokenCiphertext,
      expectedRefreshTokenCiphertext,
    )
    : db.prepare(
        `UPDATE twitch_login_identity
          SET token_scopes_json = ?, updated_at = ?
        WHERE user_id = ?
          AND status <> 'revoked'`,
    ).bind(scopesJson, updatedAt, userId);
  await statement.run();
};

export const setLoginIdentityStatus = async (
  db: D1Database,
  userId: string,
  status: IdentityStatus,
  reason: string | null,
  updatedAt: string,
): Promise<void> => {
  await db.prepare(
    `UPDATE twitch_login_identity
        SET status = ?, reason = ?, updated_at = ?
      WHERE user_id = ?`,
  ).bind(status, reason, updatedAt, userId).run();
  if (status === "revoked") {
    await db.prepare(
      `UPDATE twitch_login_identity
          SET scopes_json = '[]', token_scopes_json = '[]'
        WHERE user_id = ? AND status = 'revoked'`,
    ).bind(userId).run();
  }
};

export const setLoginIdentityStatusIfCurrent = async (
  db: D1Database,
  userId: string,
  status: IdentityStatus,
  reason: string | null,
  updatedAt: string,
  expectedAccessTokenCiphertext: string,
  expectedRefreshTokenCiphertext: string,
): Promise<boolean> => {
  const result = await db.prepare(
    `UPDATE twitch_login_identity
        SET status = ?, reason = ?, updated_at = ?
      WHERE user_id = ?
        AND status <> 'revoked'
        AND access_token_ciphertext = ?
        AND refresh_token_ciphertext = ?`,
  ).bind(
    status,
    reason,
    updatedAt,
    userId,
    expectedAccessTokenCiphertext,
    expectedRefreshTokenCiphertext,
  ).run();
  if (result.meta.changes > 0 && status === "revoked") {
    await db.prepare(
      `UPDATE twitch_login_identity
          SET scopes_json = '[]', token_scopes_json = '[]'
        WHERE user_id = ? AND status = 'revoked'
          AND access_token_ciphertext = ?
          AND refresh_token_ciphertext = ?`,
    ).bind(userId, expectedAccessTokenCiphertext, expectedRefreshTokenCiphertext).run();
  }
  return result.meta.changes > 0;
};

export const revokeLoginIdentityAndSessionsForUser = async (
  db: D1Database,
  userId: string,
  expectedAccessTokenCiphertext: string,
  expectedRefreshTokenCiphertext: string,
  reason: string,
  revokedAt: string,
): Promise<boolean> => {
  const identityRevocation = db.prepare(
    `UPDATE twitch_login_identity
        SET status = 'revoked', reason = ?, updated_at = ?, scopes_json = '[]', token_scopes_json = '[]'
      WHERE user_id = ?
        AND status <> 'revoked'
        AND access_token_ciphertext = ?
        AND refresh_token_ciphertext = ?`,
  ).bind(
    reason,
    revokedAt,
    userId,
    expectedAccessTokenCiphertext,
    expectedRefreshTokenCiphertext,
  );
  const sessionRevocation = db.prepare(
    `UPDATE auth_sessions
        SET revoked_at = ?, revocation_reason = ?, updated_at = ?
      WHERE user_id = ?
        AND revoked_at IS NULL
        AND EXISTS (
          SELECT 1 FROM twitch_login_identity
           WHERE user_id = ?
             AND status = 'revoked'
             AND access_token_ciphertext = ?
             AND refresh_token_ciphertext = ?
        )`,
  ).bind(
    revokedAt,
    reason,
    revokedAt,
    userId,
    userId,
    expectedAccessTokenCiphertext,
    expectedRefreshTokenCiphertext,
  );
  const results = await db.batch([identityRevocation, sessionRevocation]);
  return (results[0]?.meta.changes ?? 0) > 0;
};

export const rotateLoginTokensForUser = async (
  db: D1Database,
  userId: string,
  expectedAccessTokenCiphertext: string,
  expectedRefreshTokenCiphertext: string,
  accessTokenCiphertext: string,
  refreshTokenCiphertext: string,
  expiresAt: string,
  updatedAt: string,
  expectedUpdatedAt: string,
): Promise<boolean> => {
  const tokenRotation = db.prepare(
    `UPDATE twitch_login_identity
      SET access_token_ciphertext = ?,
            refresh_token_ciphertext = ?,
            expires_at = ?,
            status = CASE
              WHEN status <> 'revoked' OR julianday(updated_at) <= julianday(?)
                THEN 'connected'
              ELSE status
            END,
            reason = CASE
              WHEN status <> 'revoked' OR julianday(updated_at) <= julianday(?)
                THEN NULL
              ELSE reason
            END,
            updated_at = ?
      WHERE user_id = ?
        AND access_token_ciphertext = ?
        AND refresh_token_ciphertext = ?`,
  ).bind(
    accessTokenCiphertext,
    refreshTokenCiphertext,
    expiresAt,
    updatedAt,
    updatedAt,
    updatedAt,
    userId,
    expectedAccessTokenCiphertext,
    expectedRefreshTokenCiphertext,
  );
  const sessionRecovery = db.prepare(
    `UPDATE auth_sessions
        SET revoked_at = NULL, revocation_reason = NULL, updated_at = ?
      WHERE user_id = ?
        AND revoked_at IS NOT NULL
        AND revocation_reason = 'authorization_revoked'
        AND julianday(revoked_at) > julianday(?)
        AND julianday(revoked_at) <= julianday(?)
        AND EXISTS (
          SELECT 1 FROM twitch_login_identity
           WHERE user_id = ?
             AND access_token_ciphertext = ?
             AND refresh_token_ciphertext = ?
        )`,
  ).bind(
    updatedAt,
    userId,
    expectedUpdatedAt,
    updatedAt,
    userId,
    accessTokenCiphertext,
    refreshTokenCiphertext,
  );
  const results = await db.batch([tokenRotation, sessionRecovery]);
  return (results[0]?.meta.changes ?? 0) > 0;
};
