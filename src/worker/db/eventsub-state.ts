export type EventSubAuthorizationIdentity =
  | { kind: "bot"; userId: string }
  | { kind: "login"; userId: string };

export interface EventSubRevocationRecord {
  subscriptionId: string;
  channelId: string;
  subscriptionType: string;
  /** Leer bei einem eindeutigen Ziel; wird nur für den lokalen Abo-Zustand benötigt. */
  variant?: string;
  version?: string;
  status: string;
  reason: string | null;
  revokedAt: string;
  updatedAt: string;
  authorizationIdentity?: EventSubAuthorizationIdentity | null;
}

export type EventSubSubscriptionStatus = "enabled" | "missing" | "error" | "revoked";

export interface EventSubSubscriptionRecord {
  channelId: string;
  subscriptionType: string;
  variant: string;
  version: string;
  subscriptionId: string | null;
  secretId: string | null;
  status: EventSubSubscriptionStatus;
  reason: string | null;
  errorMessage: string | null;
  errorStatus: number | null;
  updatedAt: string;
}

interface EventSubSubscriptionRow {
  channel_id: string;
  subscription_type: string;
  variant: string;
  version: string;
  subscription_id: string | null;
  secret_id: string | null;
  status: EventSubSubscriptionStatus;
  reason: string | null;
  error_message: string | null;
  error_status: number | null;
  updated_at: string;
}

const mapEventSubSubscription = (row: EventSubSubscriptionRow): EventSubSubscriptionRecord => ({
  channelId: row.channel_id,
  subscriptionType: row.subscription_type,
  variant: row.variant,
  version: row.version,
  subscriptionId: row.subscription_id,
  secretId: row.secret_id,
  status: row.status,
  reason: row.reason,
  errorMessage: row.error_message,
  errorStatus: row.error_status,
  updatedAt: row.updated_at,
});

export const rememberEventSubMessage = async (
  db: D1Database,
  messageId: string,
  receivedAt: string,
): Promise<boolean> => {
  const result = await db.prepare(
    `INSERT OR IGNORE INTO eventsub_messages (message_id, received_at)
     VALUES (?, ?)`,
  ).bind(messageId, receivedAt).run();
  return result.meta.changes > 0;
};

/** Liest den Deduplizierungsstand ohne die Message-ID vorab zu verbrauchen. */
export const hasEventSubMessage = async (
  db: D1Database,
  messageId: string,
): Promise<boolean> => {
  const row = await db.prepare(
    `SELECT 1 AS vorhanden
       FROM eventsub_messages
      WHERE message_id = ?`,
  ).bind(messageId).first<{ vorhanden: number }>();
  return row?.vorhanden === 1;
};

export const purgeOldEventSubMessages = async (
  db: D1Database,
  cutoff: string,
): Promise<void> => {
  await db.prepare(
    `DELETE FROM eventsub_messages
      WHERE received_at < ?`,
  ).bind(cutoff).run();
};

export const rememberEventSubMessageAndRevocation = async (
  db: D1Database,
  messageId: string,
  receivedAt: string,
  revocation: EventSubRevocationRecord,
  authorizationConfirmedRevoked = false,
): Promise<boolean> => {
  const message = db.prepare(
    `INSERT OR IGNORE INTO eventsub_messages (message_id, received_at)
     VALUES (?, ?)`,
  ).bind(messageId, receivedAt);
  const storedRevocation = db.prepare(
    `INSERT INTO eventsub_revocations
      (subscription_id, channel_id, subscription_type, status, reason, revoked_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?
      WHERE changes() = 1
     ON CONFLICT(subscription_id) DO UPDATE SET
       channel_id = excluded.channel_id,
       subscription_type = excluded.subscription_type,
       status = excluded.status,
       reason = excluded.reason,
       revoked_at = excluded.revoked_at,
       updated_at = excluded.updated_at`,
  ).bind(
    revocation.subscriptionId,
    revocation.channelId,
    revocation.subscriptionType,
    revocation.status,
    revocation.reason,
    revocation.revokedAt,
    revocation.updatedAt,
  );
  const storedState = db.prepare(
    `INSERT INTO eventsub_subscriptions
      (channel_id, subscription_type, variant, version, subscription_id, secret_id, status, reason, error_message, error_status, updated_at)
     SELECT ?, ?, ?, ?, ?, NULL, 'revoked', ?, NULL, NULL, ?
      WHERE changes() = 1
        AND EXISTS (SELECT 1 FROM channels WHERE channel_id = ?)
     ON CONFLICT(channel_id, subscription_type, variant, version) DO UPDATE SET
       subscription_id = excluded.subscription_id,
       secret_id = NULL,
       status = excluded.status,
       reason = excluded.reason,
       error_message = NULL,
       error_status = NULL,
       updated_at = excluded.updated_at`,
  ).bind(
    revocation.channelId,
    revocation.subscriptionType,
    revocation.variant ?? "",
    revocation.version ?? "1",
    revocation.subscriptionId,
    revocation.reason,
    revocation.updatedAt,
    revocation.channelId,
  );
  const identity = revocation.reason === "authorization_revoked" && authorizationConfirmedRevoked
    ? revocation.authorizationIdentity
    : null;
  const identityEffects = identity?.kind === "bot"
    ? [db.prepare(
      `INSERT INTO bot_identity_status (id, status, reason, updated_at)
       SELECT 1, 'revoked', ?, ?
        WHERE changes() = 1
          AND EXISTS (
            SELECT 1 FROM bot_identity
             WHERE id = 1 AND user_id = ?
          )
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         reason = excluded.reason,
         updated_at = excluded.updated_at`,
    ).bind(revocation.reason, revocation.updatedAt, identity.userId)]
    : identity?.kind === "login"
      ? [
        db.prepare(
          `UPDATE twitch_login_identity
              SET status = 'revoked', reason = ?, updated_at = ?
            WHERE changes() = 1
              AND user_id = ?
              AND status <> 'revoked'`,
        ).bind(revocation.reason, revocation.updatedAt, identity.userId),
        db.prepare(
          `UPDATE twitch_login_identity
              SET scopes_json = '[]', token_scopes_json = '[]'
            WHERE changes() = 1
              AND user_id = ?
              AND status = 'revoked'`,
        ).bind(identity.userId),
      ]
      : [];
  const results = await db.batch([message, storedRevocation, storedState, ...identityEffects]);
  return (results[0]?.meta.changes ?? 0) > 0;
};

export const upsertEventSubSubscription = async (
  db: D1Database,
  subscription: EventSubSubscriptionRecord,
): Promise<void> => {
  await db.prepare(
    `INSERT INTO eventsub_subscriptions
      (channel_id, subscription_type, variant, version, subscription_id, secret_id, status, reason, error_message, error_status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(channel_id, subscription_type, variant, version) DO UPDATE SET
       subscription_id = excluded.subscription_id,
       secret_id = excluded.secret_id,
       status = excluded.status,
       reason = excluded.reason,
       error_message = excluded.error_message,
       error_status = excluded.error_status,
       updated_at = excluded.updated_at`,
  ).bind(
    subscription.channelId,
    subscription.subscriptionType,
    subscription.variant,
    subscription.version,
    subscription.subscriptionId,
    subscription.secretId,
    subscription.status,
    subscription.reason,
    subscription.errorMessage,
    subscription.errorStatus,
    subscription.updatedAt,
  ).run();
};

export const listEventSubSubscriptions = async (
  db: D1Database,
  channelId?: string,
): Promise<EventSubSubscriptionRecord[]> => {
  const query = channelId === undefined
    ? `SELECT channel_id, subscription_type, variant, version, subscription_id, secret_id, status, reason, error_message, error_status, updated_at
         FROM eventsub_subscriptions
        ORDER BY channel_id, subscription_type, variant, version`
    : `SELECT channel_id, subscription_type, variant, version, subscription_id, secret_id, status, reason, error_message, error_status, updated_at
         FROM eventsub_subscriptions
         WHERE channel_id = ?
        ORDER BY subscription_type, variant, version`;
  const result = channelId === undefined
    ? await db.prepare(query).all<EventSubSubscriptionRow>()
    : await db.prepare(query).bind(channelId).all<EventSubSubscriptionRow>();
  return result.results.map(mapEventSubSubscription);
};

