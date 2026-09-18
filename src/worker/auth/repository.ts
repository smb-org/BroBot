export interface NewSessionRecord {
  sessionId: string;
  userId: string;
  login: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord extends NewSessionRecord {
  revokedAt: string | null;
  revocationReason: string | null;
}

export type OAuthPurpose = "login" | "bot";

export interface OAuthTransactionRecord {
  transactionId: string;
  purpose: OAuthPurpose;
  expiresAt: string;
  createdAt: string;
}

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

export type BotIdentityStatus = "connected" | "revoked" | "error";

export interface LoginIdentityRecord {
  userId: string;
  login: string;
  scopesJson: string;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  expiresAt: string;
  status: LoginIdentityStatus;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

export type LoginIdentityStatus = "connected" | "revoked" | "error";

export interface BotIdentityStatusRecord {
  status: BotIdentityStatus;
  reason: string | null;
  updatedAt: string;
}

interface SessionRow {
  session_id: string;
  user_id: string;
  login: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
  revoked_at: string | null;
  revocation_reason: string | null;
}

interface OAuthTransactionRow {
  transaction_id: string;
  purpose: OAuthPurpose;
  expires_at: string;
  created_at: string;
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

interface LoginIdentityRow {
  user_id: string;
  login: string;
  scopes_json: string;
  access_token_ciphertext: string;
  refresh_token_ciphertext: string;
  expires_at: string;
  status: LoginIdentityStatus;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

interface BotIdentityStatusRow {
  id: 1;
  status: BotIdentityStatus;
  reason: string | null;
  updated_at: string;
}

interface ChannelIdRow {
  channel_id: string;
}

const mapSession = (row: SessionRow): SessionRecord => ({
  sessionId: row.session_id,
  userId: row.user_id,
  login: row.login,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  revokedAt: row.revoked_at,
  revocationReason: row.revocation_reason,
});

const mapOAuthTransaction = (row: OAuthTransactionRow): OAuthTransactionRecord => ({
  transactionId: row.transaction_id,
  purpose: row.purpose,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
});

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

const mapLoginIdentity = (row: LoginIdentityRow): LoginIdentityRecord => ({
  userId: row.user_id,
  login: row.login,
  scopesJson: row.scopes_json,
  accessTokenCiphertext: row.access_token_ciphertext,
  refreshTokenCiphertext: row.refresh_token_ciphertext,
  expiresAt: row.expires_at,
  status: row.status,
  reason: row.reason,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const createSession = async (db: D1Database, session: NewSessionRecord): Promise<void> => {
  await db.prepare(
    `INSERT INTO auth_sessions
      (session_id, user_id, login, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    session.sessionId,
    session.userId,
    session.login,
    session.expiresAt,
    session.createdAt,
    session.updatedAt,
  ).run();
};

export const getSession = async (db: D1Database, sessionId: string): Promise<SessionRecord | null> => {
  const row = await db.prepare(
    `SELECT session_id, user_id, login, expires_at, created_at, updated_at,
            revoked_at, revocation_reason
       FROM auth_sessions
      WHERE session_id = ?`,
  ).bind(sessionId).first<SessionRow>();
  return row === null ? null : mapSession(row);
};

export const getSessionWithLoginIdentity = async (
  db: D1Database,
  sessionId: string,
): Promise<SessionRecord | null> => {
  const row = await db.prepare(
    `SELECT s.session_id, s.user_id, s.login, s.expires_at, s.created_at, s.updated_at,
            s.revoked_at, s.revocation_reason
       FROM auth_sessions AS s
       JOIN twitch_login_identity AS i ON i.user_id = s.user_id
      WHERE s.session_id = ?
        AND s.revoked_at IS NULL
        AND i.status <> 'revoked'`,
  ).bind(sessionId).first<SessionRow>();
  return row === null ? null : mapSession(row);
};

export const revokeSession = async (
  db: D1Database,
  sessionId: string,
  revokedAt: string,
  reason: string,
): Promise<void> => {
  await db.prepare(
    `UPDATE auth_sessions
        SET revoked_at = ?, revocation_reason = ?, updated_at = ?
      WHERE session_id = ?`,
  ).bind(revokedAt, reason, revokedAt, sessionId).run();
};

export const createOAuthTransaction = async (
  db: D1Database,
  transaction: OAuthTransactionRecord,
): Promise<void> => {
  await db.prepare(
    `INSERT INTO oauth_transactions
      (transaction_id, purpose, expires_at, created_at)
     VALUES (?, ?, ?, ?)`,
  ).bind(
    transaction.transactionId,
    transaction.purpose,
    transaction.expiresAt,
    transaction.createdAt,
  ).run();
};

export const getBotIdentity = async (db: D1Database): Promise<BotIdentityRecord | null> => {
  const row = await db.prepare(
    `SELECT id, user_id, login, scopes_json, access_token_ciphertext,
            refresh_token_ciphertext, expires_at, created_at, updated_at
       FROM bot_identity
      WHERE id = 1`,
  ).first<BotIdentityRow>();
  return row === null ? null : mapBotIdentity(row);
};

export const listLoginIdentities = async (db: D1Database): Promise<LoginIdentityRecord[]> => {
  const result = await db.prepare(
    `SELECT user_id, login, scopes_json, access_token_ciphertext,
            refresh_token_ciphertext, expires_at, status, reason,
            created_at, updated_at
       FROM twitch_login_identity
      WHERE status <> 'revoked'
      ORDER BY user_id`,
  ).all<LoginIdentityRow>();
  return result.results.map(mapLoginIdentity);
};

export const getLoginIdentity = async (
  db: D1Database,
  userId: string,
): Promise<LoginIdentityRecord | null> => {
  const row = await db.prepare(
    `SELECT user_id, login, scopes_json, access_token_ciphertext,
            refresh_token_ciphertext, expires_at, status, reason,
            created_at, updated_at
       FROM twitch_login_identity
      WHERE user_id = ?`,
  ).bind(userId).first<LoginIdentityRow>();
  return row === null ? null : mapLoginIdentity(row);
};

export const upsertLoginIdentity = async (
  db: D1Database,
  identity: LoginIdentityRecord,
): Promise<void> => {
  await db.prepare(
    `INSERT INTO twitch_login_identity
      (user_id, login, scopes_json, access_token_ciphertext,
       refresh_token_ciphertext, expires_at, status, reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       login = excluded.login,
       scopes_json = excluded.scopes_json,
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
    identity.accessTokenCiphertext,
    identity.refreshTokenCiphertext,
    identity.expiresAt,
    identity.status,
    identity.reason,
    identity.createdAt,
    identity.updatedAt,
  ).run();
};

export const setLoginIdentityStatus = async (
  db: D1Database,
  userId: string,
  status: LoginIdentityStatus,
  reason: string | null,
  updatedAt: string,
): Promise<void> => {
  await db.prepare(
    `UPDATE twitch_login_identity
        SET status = ?, reason = ?, updated_at = ?
      WHERE user_id = ?`,
  ).bind(status, reason, updatedAt, userId).run();
};

export const setLoginIdentityStatusIfCurrent = async (
  db: D1Database,
  userId: string,
  status: LoginIdentityStatus,
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
        SET status = 'revoked', reason = ?, updated_at = ?
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
  status: BotIdentityStatus,
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
  status: BotIdentityStatus,
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

export const listChannelIds = async (db: D1Database): Promise<string[]> => {
  const result = await db.prepare("SELECT channel_id FROM channels ORDER BY channel_id").all<ChannelIdRow>();
  return result.results.map((row) => row.channel_id);
};

export const setBotChannelStatus = async (
  db: D1Database,
  channelId: string,
  isModerator: boolean,
  checkedAt: string,
  reason: string | null,
): Promise<void> => {
  await db.prepare(
    `INSERT INTO bot_channel_status (channel_id, is_moderator, checked_at, reason)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(channel_id) DO UPDATE SET
       is_moderator = excluded.is_moderator,
       checked_at = excluded.checked_at,
       reason = excluded.reason`,
  ).bind(channelId, isModerator ? 1 : 0, checkedAt, reason).run();
};

export const consumeOAuthTransaction = async (
  db: D1Database,
  transactionId: string,
  consumedAt: string,
): Promise<OAuthTransactionRecord | null> => {
  const row = await db.prepare(
    `UPDATE oauth_transactions
        SET used_at = ?
      WHERE transaction_id = ?
        AND used_at IS NULL
        AND expires_at > ?
      RETURNING transaction_id, purpose, expires_at, created_at`,
  ).bind(consumedAt, transactionId, consumedAt).first<OAuthTransactionRow>();
  return row === null ? null : mapOAuthTransaction(row);
};

export const failOAuthTransaction = async (
  db: D1Database,
  transactionId: string,
  reason: string,
): Promise<void> => {
  await db.prepare(
    `UPDATE oauth_transactions
        SET failure_reason = ?
      WHERE transaction_id = ? AND used_at IS NOT NULL`,
  ).bind(reason, transactionId).run();
};

export const purgeExpiredOAuthTransactions = async (
  db: D1Database,
  now: string,
): Promise<void> => {
  await db.prepare(
    "DELETE FROM oauth_transactions WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)",
  ).bind(now, now).run();
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
  const result = await db.prepare(
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
  ).run();
  return result.meta.changes > 0;
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
): Promise<boolean> => {
  const result = await db.prepare(
    `UPDATE twitch_login_identity
      SET access_token_ciphertext = ?,
            refresh_token_ciphertext = ?,
            expires_at = ?,
            updated_at = ?
      WHERE user_id = ?
        AND access_token_ciphertext = ?
        AND refresh_token_ciphertext = ?`,
  ).bind(
    accessTokenCiphertext,
    refreshTokenCiphertext,
    expiresAt,
    updatedAt,
    userId,
    expectedAccessTokenCiphertext,
    expectedRefreshTokenCiphertext,
  ).run();
  return result.meta.changes > 0;
};

export const revokeSessionsForUser = async (
  db: D1Database,
  userId: string,
  revokedAt: string,
  reason: string,
): Promise<void> => {
  await db.prepare(
    `UPDATE auth_sessions
        SET revoked_at = ?, revocation_reason = ?, updated_at = ?
      WHERE user_id = ? AND revoked_at IS NULL`,
  ).bind(revokedAt, reason, revokedAt, userId).run();
};
