import type {
  PanelActiveModule,
  PanelAuditEntry,
  PanelAuditResponse,
  PanelBotStatus,
  PanelBotPermissions,
  PanelChannelOverview,
  PanelChannelRole,
  PanelChannelState,
  PanelLastError,
  PanelLoginStatusName,
  PanelModeratorStatus,
  PanelSystemResponse,
  PanelEventSubSubscription,
  PanelTokenStatus,
  PanelEventEntry,
  PanelEventsResponse,
} from "../../panel-contract";
import { channelBotConsentCondition, listEventSubSubscriptions } from "../auth/repository";

interface ChannelStateRow {
  channel_id: string;
  login: string;
  display_name: string;
  role: PanelChannelRole;
  broadcaster_connection: number;
  channel_bot_consent: number;
  bot_status: PanelBotStatus["status"] | null;
  bot_reason: string | null;
  bot_updated_at: string | null;
  bot_missing_scopes_json: string | null;
  bot_expires_at: string | null;
  login_status: PanelLoginStatusName | null;
  login_reason: string | null;
  login_expires_at: string | null;
  login_updated_at: string | null;
  moderator_is_moderator: number | null;
  moderator_checked_at: string | null;
  moderator_reason: string | null;
  eventsub_status: "enabled" | "missing" | "error" | "revoked" | null;
  eventsub_subscription_id: string | null;
  eventsub_subscription_type: string | null;
  eventsub_variant: string | null;
  eventsub_reason: string | null;
  eventsub_message: string | null;
  eventsub_status_code: number | null;
  eventsub_updated_at: string | null;
  eventsub_error_subscription_type: string | null;
  eventsub_error_variant: string | null;
  eventsub_error_reason: string | null;
  eventsub_error_message: string | null;
  eventsub_error_status: number | null;
  eventsub_error_updated_at: string | null;
}

interface ActiveModuleRow {
  module_id: string;
  settings: string;
}

interface AuditLogRow {
  audit_id: string;
  actor_user_id: string;
  created_at: string;
  module_id: string | null;
  action: string;
  before_json: string;
  after_json: string;
}

interface EventLogRow {
  event_id: string;
  created_at: string;
  module_id: string;
  trigger_id: string;
  code: string;
  detail_json: string;
  actor_user_id: string | null;
}

export interface LogCursor {
  createdAt: string;
  id: string;
}

const encodeCursor = (cursor: LogCursor): string => {
  const serialized = JSON.stringify(cursor);
  const encoded = btoa(serialized);
  return encoded.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};

export const decodeLogCursor = (serialized: string): LogCursor | null => {
  try {
    const normalized = serialized.replaceAll("-", "+").replaceAll("_", "/")
      .padEnd(Math.ceil(serialized.length / 4) * 4, "=");
    const value: unknown = JSON.parse(atob(normalized));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const cursor = value as Record<string, unknown>;
    return typeof cursor.createdAt === "string" && cursor.createdAt.length > 0 &&
      typeof cursor.id === "string" && cursor.id.length > 0
      ? { createdAt: cursor.createdAt, id: cursor.id }
      : null;
  } catch {
    return null;
  }
};

const channelStateQuery = `
    SELECT channel.channel_id, channel.login, channel.display_name, member.role,
           CASE WHEN broadcaster_identity.status = 'connected' THEN 1 ELSE 0 END AS broadcaster_connection,
           CASE WHEN ${channelBotConsentCondition("channel")} THEN 1 ELSE 0 END AS channel_bot_consent,
           bot_status.status AS bot_status, bot_status.reason AS bot_reason,
           bot_status.updated_at AS bot_updated_at,
           bot_identity.missing_scopes_json AS bot_missing_scopes_json,
           bot_identity.expires_at AS bot_expires_at,
           login_identity.status AS login_status, login_identity.reason AS login_reason,
           login_identity.expires_at AS login_expires_at,
           login_identity.updated_at AS login_updated_at,
           moderator.is_moderator AS moderator_is_moderator,
           moderator.checked_at AS moderator_checked_at,
           moderator.reason AS moderator_reason,
           eventsub.status AS eventsub_status,
           eventsub.subscription_id AS eventsub_subscription_id,
           eventsub.subscription_type AS eventsub_subscription_type,
           eventsub.variant AS eventsub_variant,
           eventsub.reason AS eventsub_reason,
           eventsub.error_message AS eventsub_message,
           eventsub.error_status AS eventsub_status_code,
           eventsub.updated_at AS eventsub_updated_at,
           (SELECT state.subscription_type
              FROM eventsub_subscriptions AS state
             WHERE state.channel_id = channel.channel_id
               AND state.status IN ('error', 'revoked')
             ORDER BY state.updated_at DESC
             LIMIT 1) AS eventsub_error_subscription_type,
           (SELECT state.variant
              FROM eventsub_subscriptions AS state
             WHERE state.channel_id = channel.channel_id
               AND state.status IN ('error', 'revoked')
             ORDER BY state.updated_at DESC
             LIMIT 1) AS eventsub_error_variant,
           (SELECT state.reason
              FROM eventsub_subscriptions AS state
             WHERE state.channel_id = channel.channel_id
               AND state.status IN ('error', 'revoked')
             ORDER BY state.updated_at DESC
             LIMIT 1) AS eventsub_error_reason,
           (SELECT state.error_message
              FROM eventsub_subscriptions AS state
             WHERE state.channel_id = channel.channel_id
               AND state.status IN ('error', 'revoked')
             ORDER BY state.updated_at DESC
             LIMIT 1) AS eventsub_error_message,
           (SELECT state.error_status
              FROM eventsub_subscriptions AS state
             WHERE state.channel_id = channel.channel_id
               AND state.status IN ('error', 'revoked')
             ORDER BY state.updated_at DESC
             LIMIT 1) AS eventsub_error_status,
           (SELECT state.updated_at
              FROM eventsub_subscriptions AS state
             WHERE state.channel_id = channel.channel_id
               AND state.status IN ('error', 'revoked')
             ORDER BY state.updated_at DESC
             LIMIT 1) AS eventsub_error_updated_at
      FROM channels AS channel
      JOIN channel_members AS member ON member.channel_id = channel.channel_id
      LEFT JOIN twitch_login_identity AS broadcaster_identity
        ON broadcaster_identity.user_id = channel.channel_id
      LEFT JOIN bot_identity_status AS bot_status ON bot_status.id = 1
      LEFT JOIN bot_identity ON bot_identity.id = 1
      LEFT JOIN twitch_login_identity AS login_identity ON login_identity.user_id = ?
      LEFT JOIN bot_channel_status AS moderator ON moderator.channel_id = channel.channel_id
      LEFT JOIN eventsub_subscriptions AS eventsub
        ON eventsub.channel_id = channel.channel_id
       AND eventsub.subscription_type = 'channel.chat.message'
       AND eventsub.variant = ''
     WHERE member.user_id = ?`;

const mapBotStatus = (row: ChannelStateRow): PanelBotStatus | null =>
  row.bot_status === null || row.bot_updated_at === null
    ? null
    : { status: row.bot_status, reason: row.bot_reason, updatedAt: row.bot_updated_at };

const mapBotPermissions = (row: ChannelStateRow): PanelBotPermissions | null => {
  if (row.bot_missing_scopes_json === null) return null;
  try {
    const parsed: unknown = JSON.parse(row.bot_missing_scopes_json);
    return Array.isArray(parsed) && parsed.every((scope) => typeof scope === "string")
      ? { missingScopes: [...parsed] }
      : null;
  } catch {
    return null;
  }
};

const mapModerator = (row: ChannelStateRow): PanelModeratorStatus | null =>
  row.moderator_is_moderator === null || row.moderator_checked_at === null
    ? null
    : {
      isModerator: row.moderator_is_moderator === 1,
      checkedAt: row.moderator_checked_at,
      reason: row.moderator_reason,
    };

const mapEventSub = (row: ChannelStateRow): PanelChannelState["chatSubscription"] =>
  row.eventsub_status === null || row.eventsub_updated_at === null
    ? null
    : {
      status: row.eventsub_status,
      subscriptionId: row.eventsub_subscription_id,
      reason: row.eventsub_reason,
      updatedAt: row.eventsub_updated_at,
    };

const mapTokens = (row: ChannelStateRow): PanelTokenStatus => ({
  botExpiresAt: row.bot_expires_at,
  loginStatus: row.login_status,
  loginReason: row.login_reason,
  loginExpiresAt: row.login_expires_at,
});

const mapLastError = (row: ChannelStateRow): PanelLastError | null => {
  const candidates: PanelLastError[] = [];
  if (row.moderator_reason !== null && row.moderator_checked_at !== null) {
    candidates.push({ source: "moderator", reason: row.moderator_reason, at: row.moderator_checked_at });
  }
  if (row.bot_reason !== null && row.bot_updated_at !== null) {
    candidates.push({ source: "bot", reason: row.bot_reason, at: row.bot_updated_at });
  }
  if (row.login_reason !== null && row.login_updated_at !== null) {
    candidates.push({ source: "login", reason: row.login_reason, at: row.login_updated_at });
  }
  if (row.eventsub_reason !== null && row.eventsub_updated_at !== null &&
      (row.eventsub_status === "error" || row.eventsub_status === "revoked")) {
    candidates.push({
      source: "eventsub",
      reason: row.eventsub_reason,
      at: row.eventsub_updated_at,
      message: row.eventsub_message,
      status: row.eventsub_status_code,
      subscriptionType: row.eventsub_subscription_type ?? undefined,
      subscriptionVariant: row.eventsub_variant ?? undefined,
    });
  }
  if (row.eventsub_error_reason !== null && row.eventsub_error_updated_at !== null) {
    candidates.push({
      source: "eventsub",
      reason: row.eventsub_error_reason,
      at: row.eventsub_error_updated_at,
      message: row.eventsub_error_message,
      status: row.eventsub_error_status,
      subscriptionType: row.eventsub_error_subscription_type ?? undefined,
      subscriptionVariant: row.eventsub_error_variant ?? undefined,
    });
  }
  candidates.sort((left, right) => right.at.localeCompare(left.at));
  return candidates[0] ?? null;
};

const mapChannelState = (row: ChannelStateRow): PanelChannelState => ({
  channelId: row.channel_id,
  login: row.login,
  displayName: row.display_name,
  role: row.role,
  broadcasterConnection: row.broadcaster_connection === 1 ? "connected" : "not_connected",
  channelBotConsent: row.channel_bot_consent === 1 ? "granted" : "missing",
  bot: mapBotStatus(row),
  botPermissions: mapBotPermissions(row),
  moderator: mapModerator(row),
  chatSubscription: mapEventSub(row),
  tokens: mapTokens(row),
  lastError: mapLastError(row),
});

const getChannelStateRow = async (
  db: D1Database,
  userId: string,
  channelId?: string,
): Promise<ChannelStateRow | null> => {
  const query = channelId === undefined
    ? `${channelStateQuery} ORDER BY channel.display_name, channel.channel_id`
    : `${channelStateQuery} AND channel.channel_id = ?`;
  const values = channelId === undefined ? [userId, userId] : [userId, userId, channelId];
  return db.prepare(query).bind(...values).first<ChannelStateRow>();
};

const listChannelStateRows = async (db: D1Database, userId: string): Promise<ChannelStateRow[]> => {
  const result = await db.prepare(
    `${channelStateQuery} ORDER BY channel.display_name, channel.channel_id`,
  ).bind(userId, userId).all<ChannelStateRow>();
  return result.results;
};

export const listChannelsForUser = async (
  db: D1Database,
  userId: string,
): Promise<PanelChannelState[]> => (await listChannelStateRows(db, userId)).map(mapChannelState);

export const getChannelOverviewForUser = async (
  db: D1Database,
  userId: string,
  channelId: string,
): Promise<PanelChannelOverview | null> => {
  const row = await getChannelStateRow(db, userId, channelId);
  if (row === null) return null;
  const result = await db.prepare(
    `SELECT module_id, settings
       FROM channel_modules
      WHERE channel_id = ? AND enabled = 1
      ORDER BY module_id`,
  ).bind(channelId).all<ActiveModuleRow>();
  const activeModules: PanelActiveModule[] = result.results.map((module) => ({
    moduleId: module.module_id,
    settings: module.settings,
  }));
  return { ...mapChannelState(row), activeModules };
};

export const getSystemOverviewForUser = async (
  db: D1Database,
  userId: string,
  channelId: string,
): Promise<PanelSystemResponse | null> => {
  const row = await getChannelStateRow(db, userId, channelId);
  if (row === null) return null;
  const subscriptions = await listEventSubSubscriptions(db, channelId);
  return {
    broadcasterConnection: row.broadcaster_connection === 1 ? "connected" : "not_connected",
    bot: mapBotStatus(row),
    botPermissions: mapBotPermissions(row),
    chatSubscription: mapEventSub(row),
    subscriptions: subscriptions.map((subscription): PanelEventSubSubscription => ({
      subscriptionType: subscription.subscriptionType,
      variant: subscription.variant,
      version: subscription.version,
      subscriptionId: subscription.subscriptionId,
      status: subscription.status,
      reason: subscription.reason,
      message: subscription.errorMessage,
      statusCode: subscription.errorStatus,
      updatedAt: subscription.updatedAt,
    })),
    tokens: mapTokens(row),
  };
};

export const getAuditLogForChannel = async (
  db: D1Database,
  channelId: string,
  limit: number,
  cursor: LogCursor | null,
): Promise<PanelAuditResponse> => {
  const query = cursor === null
    ? `SELECT audit_id, actor_user_id, created_at, channel_id, module_id, action, before_json, after_json
         FROM audit_log
        WHERE channel_id = ?
        ORDER BY created_at DESC, audit_id DESC
        LIMIT ?`
    : `SELECT audit_id, actor_user_id, created_at, channel_id, module_id, action, before_json, after_json
         FROM audit_log
        WHERE channel_id = ?
          AND (created_at < ? OR (created_at = ? AND audit_id < ?))
        ORDER BY created_at DESC, audit_id DESC
        LIMIT ?`;
  const values = cursor === null
    ? [channelId, limit + 1]
    : [channelId, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1];
  const result = await db.prepare(query).bind(...values).all<AuditLogRow>();
  const hasNextPage = result.results.length > limit;
  const rows = result.results.slice(0, limit);
  const entries: PanelAuditEntry[] = rows.map((row) => ({
    auditId: row.audit_id,
    actorUserId: row.actor_user_id,
    createdAt: row.created_at,
    moduleId: row.module_id,
    action: row.action,
    before: row.before_json,
    after: row.after_json,
  }));
  const last = rows.at(-1);
  return {
    entries,
    nextCursor: hasNextPage && last !== undefined
      ? encodeCursor({ createdAt: last.created_at, id: last.audit_id })
      : null,
  };
};

export const getEventLogForChannel = async (
  db: D1Database,
  channelId: string,
  limit: number,
  cursor: LogCursor | null,
): Promise<PanelEventsResponse> => {
  const query = cursor === null
    ? `SELECT event_id, created_at, module_id, trigger_id, code, detail_json, actor_user_id
         FROM event_log
        WHERE channel_id = ?
        ORDER BY created_at DESC, event_id DESC
        LIMIT ?`
    : `SELECT event_id, created_at, module_id, trigger_id, code, detail_json, actor_user_id
         FROM event_log
        WHERE channel_id = ?
          AND (created_at < ? OR (created_at = ? AND event_id < ?))
        ORDER BY created_at DESC, event_id DESC
        LIMIT ?`;
  const values = cursor === null
    ? [channelId, limit + 1]
    : [channelId, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1];
  const result = await db.prepare(query).bind(...values).all<EventLogRow>();
  const hasNextPage = result.results.length > limit;
  const rows = result.results.slice(0, limit);
  const entries: PanelEventEntry[] = rows.map((row) => ({
    eventId: row.event_id,
    createdAt: row.created_at,
    moduleId: row.module_id,
    triggerId: row.trigger_id,
    code: row.code,
    detail: row.detail_json,
    actorUserId: row.actor_user_id,
    actorLogin: null,
    actorDisplayName: null,
  }));
  const last = rows.at(-1);
  return {
    entries,
    nextCursor: hasNextPage && last !== undefined
      ? encodeCursor({ createdAt: last.created_at, id: last.event_id })
      : null,
  };
};
