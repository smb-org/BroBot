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

