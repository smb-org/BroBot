export type OAuthPurpose = "login" | "bot";

/**
 * Closed for the same reason as `EVENT_CODES`/`AUDIT_ACTIONS`: it stores
 * into `oauth_transactions.failure_reason`, so a German value here is a
 * silent leak, not a typo caught by a reviewer skimming English text. Not
 * shared through `contracts/values.ts` -- nothing outside `worker/auth`
 * reads this column.
 */
export type OAuthTransactionFailureReason =
  | "authorization_denied"
  | "authorization_code_missing"
  | "login_identity_user_mismatch"
  | "bot_identity_mismatch"
  | "bot_identity_user_mismatch"
  | "full_consent_incomplete"
  | "full_consent_second_attempt_incomplete"
  | "code_exchange_rejected"
  | "callback_failed";

export interface OAuthTransactionRecord {
  transactionId: string;
  purpose: OAuthPurpose;
  expiresAt: string;
  createdAt: string;
  redirectPath?: string | null;
  expectedUserId?: string | null;
}

interface OAuthTransactionRow {
  transaction_id: string;
  purpose: OAuthPurpose;
  expires_at: string;
  created_at: string;
  redirect_path?: string | null;
  expected_user_id?: string | null;
}

const mapOAuthTransaction = (row: OAuthTransactionRow): OAuthTransactionRecord => ({
  transactionId: row.transaction_id,
  purpose: row.purpose,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  ...(row.redirect_path === null || row.redirect_path === undefined ? {} : { redirectPath: row.redirect_path }),
  ...(row.expected_user_id === null || row.expected_user_id === undefined
    ? {}
    : { expectedUserId: row.expected_user_id }),
});

export const createOAuthTransaction = async (
  db: D1Database,
  transaction: OAuthTransactionRecord,
): Promise<void> => {
  await db.prepare(
    `INSERT INTO oauth_transactions
      (transaction_id, purpose, expires_at, created_at, redirect_path, expected_user_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    transaction.transactionId,
    transaction.purpose,
    transaction.expiresAt,
    transaction.createdAt,
    transaction.redirectPath ?? null,
    transaction.expectedUserId ?? null,
  ).run();
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
        AND julianday(expires_at) > julianday(?)
      RETURNING transaction_id, purpose, expires_at, created_at, redirect_path, expected_user_id`,
  ).bind(consumedAt, transactionId, consumedAt).first<OAuthTransactionRow>();
  return row === null ? null : mapOAuthTransaction(row);
};

export const failOAuthTransaction = async (
  db: D1Database,
  transactionId: string,
  reason: OAuthTransactionFailureReason,
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
    `DELETE FROM oauth_transactions
      WHERE julianday(expires_at) IS NULL
         OR julianday(expires_at) <= julianday(?)
         OR (used_at IS NOT NULL AND (
           julianday(used_at) IS NULL OR julianday(used_at) <= julianday(?)
         ))`,
  ).bind(now, now).run();
};

