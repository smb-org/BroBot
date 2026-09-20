import {
  prepareModuleAudit as prepareHostModuleAudit,
  type AuditActorKind,
} from "../module-audit";

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
  redirectPath?: string | null;
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

export interface AppAccessTokenRecord {
  accessTokenCiphertext: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

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

/**
 * Der Akteur einer Mutation. Die sessionId gehoert dazu, weil die Mutation
 * selbst pruefen muss, ob die Session noch lebt — die Rolle allein genuegt
 * nicht.
 */
export interface ActorContext {
  userId: string;
  sessionId: string;
}

export interface ChannelMemberRecord {
  channelId: string;
  userId: string;
  role: "broadcaster" | "verwalter" | "bediener";
  createdAt: string;
  updatedAt: string;
}

export interface ChannelMemberCursor {
  createdAt: string;
  userId: string;
}

export interface ChannelMemberPage {
  members: ChannelMemberRecord[];
  nextCursor: string | null;
}

export interface ChannelModuleRecord {
  channelId: string;
  moduleId: string;
  enabled: boolean;
  settings: string;
}

interface ChannelModuleRow {
  channel_id: string;
  module_id: string;
  enabled: number;
  settings: string;
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
  redirect_path?: string | null;
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

interface AppAccessTokenRow {
  access_token_ciphertext: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

interface ChannelIdRow {
  channel_id: string;
}

interface EventSubRevocationRow {
  subscription_id: string;
  channel_id: string;
  subscription_type: string;
  status: string;
  reason: string | null;
  revoked_at: string;
  updated_at: string;
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

interface BotChannelStatusCheckLockRow {
  channel_id: string;
  locked_until: string;
}

interface BotChannelStatusCheckedAtRow {
  checked_at: string;
}

interface ChannelMemberRow {
  channel_id: string;
  user_id: string;
  role: ChannelMemberRecord["role"];
  created_at: string;
  updated_at: string;
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
  ...(row.redirect_path === null || row.redirect_path === undefined ? {} : { redirectPath: row.redirect_path }),
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

const mapChannelModule = (row: ChannelModuleRow): ChannelModuleRecord => ({
  channelId: row.channel_id,
  moduleId: row.module_id,
  enabled: row.enabled === 1,
  settings: row.settings,
});

const mapChannelMember = (row: ChannelMemberRow): ChannelMemberRecord => ({
  channelId: row.channel_id,
  userId: row.user_id,
  role: row.role,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapAppAccessToken = (row: AppAccessTokenRow): AppAccessTokenRecord => ({
  accessTokenCiphertext: row.access_token_ciphertext,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const mapEventSubRevocation = (row: EventSubRevocationRow): EventSubRevocationRecord => ({
  subscriptionId: row.subscription_id,
  channelId: row.channel_id,
  subscriptionType: row.subscription_type,
  status: row.status,
  reason: row.reason,
  revokedAt: row.revoked_at,
  updatedAt: row.updated_at,
});

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

const auditId = (): string => crypto.randomUUID();

const memberJson = (member: ChannelMemberRecord | null): string => JSON.stringify(member);

/**
 * Der Handler prueft die Berechtigung, bevor er den Request-Body liest. Zwischen
 * Guard und Mutation liegt aber ein beliebig langes Fenster: Ein Client kann den
 * Body offen lassen, bis seine Session widerrufen wurde, und ihn erst danach
 * schliessen. Deshalb wiederholt jede Mutation die vollstaendige Pruefung im
 * selben D1-Batch — nicht nur die Kanalrolle, sondern auch die Session selbst.
 *
 * Bindereihenfolge: sessionId, actorUserId, now, channelId.
 */
export const actorGuard = (allowedRoles: string): string => `
        AND EXISTS (
          SELECT 1
            FROM auth_sessions AS actor_session
            JOIN twitch_login_identity AS actor_identity
              ON actor_identity.user_id = actor_session.user_id
            JOIN channel_members AS actor
              ON actor.user_id = actor_session.user_id
           WHERE actor_session.session_id = ?
             AND actor_session.user_id = ?
             AND actor_session.revoked_at IS NULL
             AND actor_session.expires_at > ?
             AND actor_identity.status <> 'revoked'
             AND actor.channel_id = ?
             AND actor.role IN (${allowedRoles})
        )`;

export interface MutationGuard {
  sql: string;
  values: readonly (string | number | null)[];
}

export const betreiberSessionGuard = (
  actor: ActorContext,
  now: string,
): MutationGuard => ({
  sql: `
        AND EXISTS (
          SELECT 1
            FROM auth_sessions AS actor_session
            JOIN twitch_login_identity AS actor_identity
              ON actor_identity.user_id = actor_session.user_id
           WHERE actor_session.session_id = ?
             AND actor_session.user_id = ?
             AND actor_session.revoked_at IS NULL
             AND actor_session.expires_at > ?
             AND actor_identity.status <> 'revoked'
        )`,
  values: [actor.sessionId, actor.userId, now],
});

/**
 * Wer die Rolle `broadcaster` vergibt, kann den bisherigen Broadcaster
 * anschliessend entfernen — der Schutz des letzten Broadcasters greift dann
 * nicht mehr, weil zwischenzeitlich zwei existieren. Deshalb darf nur ein
 * Broadcaster diese Rolle vergeben. Die Regel steht hier und nicht nur im
 * Handler, damit sie auch dann gilt, wenn sich die Rolle zwischen Guard und
 * Mutation aendert.
 */
export const ANY_MEMBER_ROLES = "'broadcaster', 'verwalter', 'bediener'";

/** Gemeinsame SQL-Prüfung der Broadcaster-Zustimmung für channel:bot. */
export const channelBotConsentCondition = (channelAlias: string): string => `
        EXISTS (
          SELECT 1
            FROM twitch_login_identity AS broadcaster_identity
           WHERE broadcaster_identity.user_id = ${channelAlias}.channel_id
             AND broadcaster_identity.status = 'connected'
             AND EXISTS (
               SELECT 1
                 FROM json_each(broadcaster_identity.scopes_json) AS granted_scope
                WHERE granted_scope.value = 'channel:bot'
             )
        )`;

export const requiredActorRoles = (targetRole: ChannelMemberRecord["role"]): string =>
  targetRole === "broadcaster" ? "'broadcaster'" : "'broadcaster', 'verwalter'";

export const bindActorGuard = (actor: ActorContext, channelId: string, now: string) =>
  [actor.sessionId, actor.userId, now, channelId] as const;

const soleBroadcasterPredicate = `
          AND (
            SELECT COUNT(*)
              FROM channel_members
             WHERE channel_id = ? AND role = 'broadcaster'
          ) <= 1`;

const lastBroadcasterGuard = `
        AND NOT (
          role = 'broadcaster'
          ${soleBroadcasterPredicate}
        )`;

const lastBroadcasterRoleChangeGuard = `
        AND NOT (
          role = 'broadcaster'
          AND ? <> 'broadcaster'
          ${soleBroadcasterPredicate}
        )`;

const prepareMemberAudit = (
  db: D1Database,
  actorUserId: string,
  changedAt: string,
  channelId: string,
  action: string,
  before: ChannelMemberRecord | null,
  after: ChannelMemberRecord | null,
  actorKind: AuditActorKind = "mitglied",
): D1PreparedStatement => db.prepare(
  `INSERT INTO audit_log
    (audit_id, actor_user_id, created_at, channel_id, module_id, action, before_json, after_json, actor_kind)
   SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE changes() > 0`,
).bind(
  auditId(),
  actorUserId,
  changedAt,
  channelId,
  null,
  action,
  memberJson(before),
  memberJson(after),
  actorKind,
);

const mutationGuardParts = (
  guard: string | MutationGuard,
  actor: ActorContext,
  channelId: string,
  changedAt: string,
): MutationGuard => typeof guard === "string"
  ? { sql: guard, values: bindActorGuard(actor, channelId, changedAt) }
  : guard;

const encodeChannelMemberCursor = (cursor: ChannelMemberCursor): string => {
  const serialized = JSON.stringify(cursor);
  const encoded = btoa(serialized);
  return encoded.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

export const decodeChannelMemberCursor = (serialized: string): ChannelMemberCursor | null => {
  try {
    const normalized = serialized.replaceAll("-", "+").replaceAll("_", "/")
      .padEnd(Math.ceil(serialized.length / 4) * 4, "=");
    const value: unknown = JSON.parse(atob(normalized));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const cursor = value as Record<string, unknown>;
    return typeof cursor.createdAt === "string" && cursor.createdAt.length > 0 &&
      typeof cursor.userId === "string" && cursor.userId.length > 0
      ? { createdAt: cursor.createdAt, userId: cursor.userId }
      : null;
  } catch {
    return null;
  }
};

const getChannelMember = async (
  db: D1Database,
  channelId: string,
  userId: string,
): Promise<ChannelMemberRecord | null> => {
  const row = await db.prepare(
    `SELECT channel_id, user_id, role, created_at, updated_at
       FROM channel_members
      WHERE channel_id = ? AND user_id = ?`,
  ).bind(channelId, userId).first<ChannelMemberRow>();
  return row === null ? null : mapChannelMember(row);
};

export const getChannelMemberForChannel = async (
  db: D1Database,
  channelId: string,
  userId: string,
): Promise<ChannelMemberRecord | null> => getChannelMember(db, channelId, userId);

export const listChannelMembers = async (
  db: D1Database,
  channelId: string,
  limit: number,
  cursor: ChannelMemberCursor | null,
): Promise<ChannelMemberPage> => {
  const query = cursor === null
    ? `SELECT channel_id, user_id, role, created_at, updated_at
         FROM channel_members
        WHERE channel_id = ?
        ORDER BY created_at, user_id
        LIMIT ?`
    : `SELECT channel_id, user_id, role, created_at, updated_at
         FROM channel_members
        WHERE channel_id = ?
          AND (created_at > ? OR (created_at = ? AND user_id > ?))
        ORDER BY created_at, user_id
        LIMIT ?`;
  const values = cursor === null
    ? [channelId, limit + 1]
    : [channelId, cursor.createdAt, cursor.createdAt, cursor.userId, limit + 1];
  const result = await db.prepare(query).bind(...values).all<ChannelMemberRow>();
  const hasNextPage = result.results.length > limit;
  const rows = result.results.slice(0, limit);
  const members = rows.map(mapChannelMember);
  const last = rows.at(-1);
  return {
    members,
    nextCursor: hasNextPage && last !== undefined
      ? encodeChannelMemberCursor({ createdAt: last.created_at, userId: last.user_id })
      : null,
  };
};

export const countBroadcasterMembers = async (
  db: D1Database,
  channelId: string,
): Promise<number> => {
  const row = await db.prepare(
    `SELECT COUNT(*) AS count
       FROM channel_members
      WHERE channel_id = ? AND role = 'broadcaster'`,
  ).bind(channelId).first<{ count: number }>();
  return row?.count ?? 0;
};

export const createChannelMemberWithAudit = async (
  db: D1Database,
  actor: ActorContext,
  member: ChannelMemberRecord,
  action: string,
  changedAt: string,
  guard: string | MutationGuard,
  actorKind: AuditActorKind = "mitglied",
): Promise<boolean> => {
  const guardParts = mutationGuardParts(guard, actor, member.channelId, changedAt);
  const mutation = db.prepare(
    `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
     SELECT ?, ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM channel_members
         WHERE channel_id = ? AND user_id = ?
      )
      ${guardParts.sql}`,
  ).bind(
    member.channelId,
    member.userId,
    member.role,
    member.createdAt,
    member.updatedAt,
    member.channelId,
    member.userId,
    ...guardParts.values,
  );
  const audit = prepareMemberAudit(
    db,
    actor.userId,
    changedAt,
    member.channelId,
    action,
    null,
    member,
    actorKind,
  );
  const results = await db.batch([mutation, audit]);
  return (results[0]?.meta.changes ?? 0) > 0;
};

export const updateChannelMemberWithAudit = async (
  db: D1Database,
  actor: ActorContext,
  member: ChannelMemberRecord,
  action: string,
  changedAt: string,
  guard: string | MutationGuard,
  actorKind: AuditActorKind = "mitglied",
): Promise<boolean> => {
  const before = await getChannelMember(db, member.channelId, member.userId);
  if (before === null) return false;
  const after: ChannelMemberRecord = { ...member, createdAt: before.createdAt };
  const guardParts = mutationGuardParts(guard, actor, after.channelId, changedAt);
  const mutation = db.prepare(
    `UPDATE channel_members
        SET role = ?, updated_at = ?
      WHERE channel_id = ? AND user_id = ?
        AND role = ?
        AND created_at = ?
        AND updated_at = ?
      ${guardParts.sql}
      ${lastBroadcasterRoleChangeGuard}`,
  ).bind(
    after.role,
    after.updatedAt,
    after.channelId,
    after.userId,
    before.role,
    before.createdAt,
    before.updatedAt,
    ...guardParts.values,
    after.role,
    after.channelId,
  );
  const audit = prepareMemberAudit(
    db,
    actor.userId,
    changedAt,
    after.channelId,
    action,
    before,
    after,
    actorKind,
  );
  const results = await db.batch([mutation, audit]);
  return (results[0]?.meta.changes ?? 0) > 0;
};

export const deleteChannelMemberWithAudit = async (
  db: D1Database,
  actor: ActorContext,
  channelId: string,
  userId: string,
  action: string,
  changedAt: string,
  guard: string | MutationGuard,
  actorKind: AuditActorKind = "mitglied",
): Promise<boolean> => {
  const before = await getChannelMember(db, channelId, userId);
  if (before === null) return false;
  const guardParts = mutationGuardParts(guard, actor, channelId, changedAt);
  const mutation = db.prepare(
    `DELETE FROM channel_members
      WHERE channel_id = ? AND user_id = ?
        AND role = ?
        AND created_at = ?
        AND updated_at = ?
      ${guardParts.sql}
      ${lastBroadcasterGuard}`,
  ).bind(
    channelId,
    userId,
    before.role,
    before.createdAt,
    before.updatedAt,
    ...guardParts.values,
    channelId,
  );
  const audit = prepareMemberAudit(
    db,
    actor.userId,
    changedAt,
    channelId,
    action,
    before,
    null,
    actorKind,
  );
  const results = await db.batch([mutation, audit]);
  return (results[0]?.meta.changes ?? 0) > 0;
};

const getChannelModule = async (
  db: D1Database,
  channelId: string,
  moduleId: string,
): Promise<ChannelModuleRecord | null> => {
  const row = await db.prepare(
    `SELECT channel_id, module_id, enabled, settings
       FROM channel_modules
      WHERE channel_id = ? AND module_id = ?`,
  ).bind(channelId, moduleId).first<ChannelModuleRow>();
  return row === null ? null : mapChannelModule(row);
};

export const getChannelModuleForChannel = async (
  db: D1Database,
  channelId: string,
  moduleId: string,
): Promise<ChannelModuleRecord | null> => getChannelModule(db, channelId, moduleId);

export const listChannelModulesForChannel = async (
  db: D1Database,
  channelId: string,
): Promise<ChannelModuleRecord[]> => {
  const result = await db.prepare(
    `SELECT channel_id, module_id, enabled, settings
       FROM channel_modules
      WHERE channel_id = ?`,
  ).bind(channelId).all<ChannelModuleRow>();
  return result.results.map(mapChannelModule);
};

/**
 * Dieselbe Rollenschwelle wie bei Mitgliederaenderungen: Nur Broadcaster und
 * Verwalter duerfen Module schalten, durchgesetzt im actorGuard der Mutation
 * selbst, nicht nur im Handler.
 */
export const createChannelModuleWithAudit = async (
  db: D1Database,
  actor: ActorContext,
  module: ChannelModuleRecord,
  action: string,
  changedAt: string,
): Promise<boolean> => {
  const mutation = db.prepare(
    `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
     SELECT ?, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM channel_modules
         WHERE channel_id = ? AND module_id = ?
      )
      ${actorGuard("'broadcaster', 'verwalter'")}`,
  ).bind(
    module.channelId,
    module.moduleId,
    module.enabled ? 1 : 0,
    module.settings,
    module.channelId,
    module.moduleId,
    ...bindActorGuard(actor, module.channelId, changedAt),
  );
  const audit = prepareHostModuleAudit(db, actor.userId, changedAt, {
    channelId: module.channelId,
    moduleId: module.moduleId,
    action,
    before: null,
    after: { ...module },
  });
  const results = await db.batch([mutation, audit]);
  return (results[0]?.meta.changes ?? 0) > 0;
};

export const updateChannelModuleWithAudit = async (
  db: D1Database,
  actor: ActorContext,
  channelId: string,
  moduleId: string,
  enabled: boolean,
  settings: string,
  action: string,
  changedAt: string,
): Promise<boolean> => {
  const before = await getChannelModule(db, channelId, moduleId);
  if (before === null) return false;
  const after: ChannelModuleRecord = { channelId, moduleId, enabled, settings };
  const mutation = db.prepare(
    `UPDATE channel_modules
        SET enabled = ?, settings = ?
      WHERE channel_id = ? AND module_id = ?
        AND enabled = ?
        AND settings = ?
      ${actorGuard("'broadcaster', 'verwalter'")}`,
  ).bind(
    after.enabled ? 1 : 0,
    after.settings,
    after.channelId,
    after.moduleId,
    before.enabled ? 1 : 0,
    before.settings,
    ...bindActorGuard(actor, after.channelId, changedAt),
  );
  const audit = prepareHostModuleAudit(db, actor.userId, changedAt, {
    channelId,
    moduleId,
    action,
    before: { ...before },
    after: { ...after },
  });
  const results = await db.batch([mutation, audit]);
  return (results[0]?.meta.changes ?? 0) > 0;
};

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
      (transaction_id, purpose, expires_at, created_at, redirect_path)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(
    transaction.transactionId,
    transaction.purpose,
    transaction.expiresAt,
    transaction.createdAt,
    transaction.redirectPath ?? null,
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

export const purgeOldEventSubMessages = async (
  db: D1Database,
  cutoff: string,
): Promise<void> => {
  await db.prepare(
    `DELETE FROM eventsub_messages
      WHERE received_at < ?`,
  ).bind(cutoff).run();
};

export const recordEventSubRevocation = async (
  db: D1Database,
  revocation: EventSubRevocationRecord,
): Promise<void> => {
  await db.prepare(
    `INSERT INTO eventsub_revocations
      (subscription_id, channel_id, subscription_type, status, reason, revoked_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
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
  ).run();
  if (revocation.reason === "authorization_revoked") {
    await db.prepare(
      `UPDATE twitch_login_identity
          SET status = 'revoked', reason = ?, updated_at = ?
        WHERE user_id = ? AND status <> 'revoked'`,
    ).bind(revocation.reason, revocation.updatedAt, revocation.channelId).run();
    await db.prepare(
      `UPDATE twitch_login_identity
          SET scopes_json = '[]'
        WHERE user_id = ? AND status = 'revoked'`,
    ).bind(revocation.channelId).run();
  }
  await db.prepare(
    `INSERT INTO eventsub_subscriptions
      (channel_id, subscription_type, variant, version, subscription_id, secret_id, status, reason, error_message, error_status, updated_at)
     SELECT ?, ?, ?, ?, ?, NULL, 'revoked', ?, NULL, NULL, ?
      WHERE EXISTS (SELECT 1 FROM channels WHERE channel_id = ?)
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
  ).run();
};

/** Speichert Message-ID und Widerruf in derselben D1-Transaktion. */
export const rememberEventSubMessageAndRevocation = async (
  db: D1Database,
  messageId: string,
  receivedAt: string,
  revocation: EventSubRevocationRecord,
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
  const revokedIdentity = db.prepare(
    `UPDATE twitch_login_identity
        SET status = 'revoked', reason = ?, updated_at = ?
      WHERE user_id = ? AND status <> 'revoked'`,
  ).bind(revocation.reason, revocation.updatedAt, revocation.channelId);
  const clearedIdentityScopes = db.prepare(
    `UPDATE twitch_login_identity
        SET scopes_json = '[]'
      WHERE user_id = ? AND status = 'revoked'`,
  ).bind(revocation.channelId);
  const results = await db.batch(revocation.reason === "authorization_revoked"
    ? [message, storedRevocation, storedState, revokedIdentity, clearedIdentityScopes]
    : [message, storedRevocation, storedState]);
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

export const listEventSubRevocations = async (
  db: D1Database,
  channelId: string,
): Promise<EventSubRevocationRecord[]> => {
  const result = await db.prepare(
    `SELECT subscription_id, channel_id, subscription_type, status, reason,
            revoked_at, updated_at
       FROM eventsub_revocations
      WHERE channel_id = ?
      ORDER BY revoked_at DESC, subscription_id DESC`,
  ).bind(channelId).all<EventSubRevocationRow>();
  return result.results.map(mapEventSubRevocation);
};

export const listLoginIdentities = async (
  db: D1Database,
  now: string = new Date().toISOString(),
): Promise<LoginIdentityRecord[]> => {
  const result = await db.prepare(
    `SELECT user_id, login, scopes_json, access_token_ciphertext,
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
       scopes_json = (
         SELECT json_group_array(scope)
           FROM (
             SELECT value AS scope FROM json_each(twitch_login_identity.scopes_json)
             UNION
             SELECT value AS scope FROM json_each(excluded.scopes_json)
            ORDER BY scope
           )
       ),
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
  if (status === "revoked") {
    await db.prepare(
      `UPDATE twitch_login_identity SET scopes_json = '[]' WHERE user_id = ? AND status = 'revoked'`,
    ).bind(userId).run();
  }
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
  if (result.meta.changes > 0 && status === "revoked") {
    await db.prepare(
      `UPDATE twitch_login_identity
          SET scopes_json = '[]'
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
        SET status = 'revoked', reason = ?, updated_at = ?, scopes_json = '[]'
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

export const upsertBotIdentityAndStatus = async (
  db: D1Database,
  identity: BotIdentityRecord,
  status: BotIdentityStatus,
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

export const tryReserveBotChannelStatusCheck = async (
  db: D1Database,
  channelId: string,
  lockedUntil: string,
  now: string,
  checkedSince: string,
): Promise<string | null> => {
  const ownerId = crypto.randomUUID();
  const row = await db.prepare(
    `INSERT INTO bot_channel_status_check_locks (channel_id, owner_id, locked_until)
     SELECT ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM bot_channel_status
         WHERE channel_id = ?
           AND julianday(checked_at) > julianday(?)
      )
     ON CONFLICT(channel_id) DO UPDATE SET
       owner_id = excluded.owner_id,
       locked_until = excluded.locked_until
     WHERE julianday(bot_channel_status_check_locks.locked_until) <= julianday(?)
       AND bot_channel_status_check_locks.owner_id <> excluded.owner_id
       AND NOT EXISTS (
         SELECT 1 FROM bot_channel_status
          WHERE channel_id = ?
            AND julianday(checked_at) > julianday(?)
       )
     RETURNING owner_id`,
  ).bind(channelId, ownerId, lockedUntil, channelId, checkedSince, now, channelId, checkedSince)
    .first<{ owner_id: string }>();
  return row?.owner_id ?? null;
};

export const getBotChannelStatusCheckLock = async (
  db: D1Database,
  channelId: string,
): Promise<string | null> => {
  const row = await db.prepare(
    `SELECT channel_id, locked_until
       FROM bot_channel_status_check_locks
      WHERE channel_id = ?`,
  ).bind(channelId).first<BotChannelStatusCheckLockRow>();
  return row?.locked_until ?? null;
};

export const getBotChannelStatusCheckedAt = async (
  db: D1Database,
  channelId: string,
): Promise<string | null> => {
  const row = await db.prepare(
    `SELECT checked_at
       FROM bot_channel_status
      WHERE channel_id = ?`,
  ).bind(channelId).first<BotChannelStatusCheckedAtRow>();
  return row?.checked_at ?? null;
};

export const releaseBotChannelStatusCheck = async (
  db: D1Database,
  channelId: string,
  ownerId: string,
): Promise<void> => {
  await db.prepare(
    "DELETE FROM bot_channel_status_check_locks WHERE channel_id = ? AND owner_id = ?",
  ).bind(channelId, ownerId).run();
};

const prepareBotChannelStatusMutation = (
  db: D1Database,
  channelId: string,
  isModerator: boolean,
  checkedAt: string,
  reason: string | null,
): D1PreparedStatement => db.prepare(
  `INSERT INTO bot_channel_status (channel_id, is_moderator, checked_at, reason)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(channel_id) DO UPDATE SET
     is_moderator = excluded.is_moderator,
     checked_at = excluded.checked_at,
     reason = excluded.reason
   WHERE julianday(bot_channel_status.checked_at) < julianday(excluded.checked_at)`,
).bind(channelId, isModerator ? 1 : 0, checkedAt, reason);

export const setBotChannelStatus = async (
  db: D1Database,
  channelId: string,
  isModerator: boolean,
  checkedAt: string,
  reason: string | null,
): Promise<void> => {
  await prepareBotChannelStatusMutation(db, channelId, isModerator, checkedAt, reason).run();
};

export const setBotChannelStatusAndLock = async (
  db: D1Database,
  channelId: string,
  ownerId: string,
  isModerator: boolean,
  checkedAt: string,
  reason: string | null,
  lockedUntil: string,
): Promise<void> => {
  await db.batch([
    prepareBotChannelStatusMutation(db, channelId, isModerator, checkedAt, reason),
    db.prepare(
      `UPDATE bot_channel_status_check_locks
          SET locked_until = ?
        WHERE channel_id = ?
          AND owner_id = ?
          AND EXISTS (
            SELECT 1 FROM bot_channel_status
             WHERE channel_id = ? AND checked_at = ?
          )`,
    ).bind(lockedUntil, channelId, ownerId, channelId, checkedAt),
    db.prepare(
      `DELETE FROM bot_channel_status_check_locks
        WHERE channel_id = ?
          AND owner_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM bot_channel_status
             WHERE channel_id = ? AND checked_at = ?
          )`,
    ).bind(channelId, ownerId, channelId, checkedAt),
  ]);
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
      RETURNING transaction_id, purpose, expires_at, created_at, redirect_path`,
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
    `DELETE FROM oauth_transactions
      WHERE julianday(expires_at) IS NULL
         OR julianday(expires_at) <= julianday(?)
         OR (used_at IS NOT NULL AND (
           julianday(used_at) IS NULL OR julianday(used_at) <= julianday(?)
         ))`,
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
