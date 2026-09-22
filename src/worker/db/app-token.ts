export interface AppAccessTokenRecord {
  accessTokenCiphertext: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

interface AppAccessTokenRow {
  access_token_ciphertext: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

const mapAppAccessToken = (row: AppAccessTokenRow): AppAccessTokenRecord => ({
  accessTokenCiphertext: row.access_token_ciphertext,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const getAppAccessToken = async (
  db: D1Database,
): Promise<AppAccessTokenRecord | null> => {
  const row = await db.prepare(
    `SELECT access_token_ciphertext, expires_at, created_at, updated_at
       FROM twitch_app_access_token
      WHERE id = 1`,
  ).first<AppAccessTokenRow>();
  return row === null ? null : mapAppAccessToken(row);
};

/**
 * Ersetzt den globalen App-Token nur, wenn der gelesene Ciphertext noch
 * aktuell ist. Ein fehlender Datensatz darf genau einmal angelegt werden.
 */
export const rotateAppAccessToken = async (
  db: D1Database,
  expectedAccessTokenCiphertext: string | null,
  accessTokenCiphertext: string,
  expiresAt: string,
  createdAt: string,
  updatedAt: string,
): Promise<boolean> => {
  const mutation = expectedAccessTokenCiphertext === null
    ? db.prepare(
      `INSERT INTO twitch_app_access_token
        (id, access_token_ciphertext, expires_at, created_at, updated_at)
       SELECT 1, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM twitch_app_access_token WHERE id = 1
        )`,
    ).bind(accessTokenCiphertext, expiresAt, createdAt, updatedAt)
    : db.prepare(
      `UPDATE twitch_app_access_token
          SET access_token_ciphertext = ?, expires_at = ?, updated_at = ?
        WHERE id = 1 AND access_token_ciphertext = ?`,
    ).bind(accessTokenCiphertext, expiresAt, updatedAt, expectedAccessTokenCiphertext);
  const result = await mutation.run();
  return result.meta.changes > 0;
};

/** Dedupliziert EventSub-Nachrichten atomar über Twitchs Message-ID. */

