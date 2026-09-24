import type {
  PanelActiveModule,
  PanelAuditEntry,
  PanelAuditFilters,
  PanelAuditResponse,
  PanelBotStatus,
  PanelBotPermissions,
  PanelBroadcasterPermissions,
  PanelChannelOverview,
  PanelChannelState,
  PanelLastError,
  PanelModeratorStatus,
  PanelSystemResponse,
  PanelEventSubSubscription,
  PanelTokenStatus,
  PanelEventEntry,
  PanelEventFilters,
  PanelEventsResponse,
} from "../../panel-contract";
import type {
  AuditActorKind,
  AuditArea,
  ChannelStreamState,
  ChannelRole,
  EventSubSubscriptionType,
  IdentityStatus,
} from "../../contracts/values";
import { AUDIT_AREA_PREFIXES } from "../../dashboard/audit/areas";
import { eventToneEntries } from "../../dashboard/locale";
import {
  channelBotConsentCondition,
} from "../db/guards";
import {
  listEventSubSubscriptions,
} from "../db/eventsub-state";
import { decodeCursor, encodeCursor } from "../db/cursor";
import { listAllBroadcasterScopes } from "../module-scopes";
import { mapChannelControls, type ChannelControlFields } from "../db/channel-controls";
import { getPanelModuleDataForChannels, getPanelModuleStatesForChannels } from "./module-repository";

interface ChannelStateRow {
  channel_id: string;
  login: string;
  display_name: string;
  role: ChannelRole;
  broadcaster_connection: number;
  full_consent: number;
  broadcaster_scopes_json: string | null;
  broadcaster_status: string | null;
  channel_bot_consent: number;
  chat_subscription_needed: number;
  bot_status: PanelBotStatus["status"] | null;
  bot_reason: string | null;
  bot_updated_at: string | null;
  bot_missing_scopes_json: string | null;
  bot_expires_at: string | null;
  login_status: IdentityStatus | null;
  login_reason: string | null;
  login_expires_at: string | null;
  login_updated_at: string | null;
  moderator_is_moderator: number | null;
  moderator_checked_at: string | null;
  moderator_reason: string | null;
  eventsub_status: "enabled" | "missing" | "error" | "revoked" | null;
  eventsub_subscription_id: string | null;
  eventsub_subscription_type: EventSubSubscriptionType | null;
  eventsub_variant: string | null;
  eventsub_reason: string | null;
  eventsub_message: string | null;
  eventsub_status_code: number | null;
  eventsub_updated_at: string | null;
  eventsub_error_subscription_type: EventSubSubscriptionType | null;
  eventsub_error_variant: string | null;
  eventsub_error_reason: string | null;
  eventsub_error_message: string | null;
  eventsub_error_status: number | null;
  eventsub_error_updated_at: string | null;
  stream_state: ChannelStreamState | null;
  stream_started_at: string | null;
  stream_state_changed_at: string | null;
  stream_state_checked_at: string | null;
  stream_id: string | null;
  muted: ChannelControlFields["muted"];
  muted_until: string | null;
  mute_until_stream_end: ChannelControlFields["mute_until_stream_end"];
  mute_stream_started_at: string | null;
  mute_stream_id: string | null;
  paused: ChannelControlFields["paused"];
  paused_until: string | null;
  pause_until_stream_end: ChannelControlFields["pause_until_stream_end"];
  pause_stream_started_at: string | null;
  pause_stream_id: string | null;
}

interface AuditLogRow {
  audit_id: string;
  actor_user_id: string;
  actor_kind: AuditActorKind;
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

const eventCodesForTone = (tone: PanelEventFilters["tone"]): string[] => {
  if (tone === null) return [];
  return Object.entries(eventToneEntries)
    .filter(([, metadata]) => metadata.tone === tone)
    .map(([code]) => code);
};

const eventCodesForTones = (tones: readonly NonNullable<PanelEventFilters["tone"]>[]): string[] => {
  const selected = new Set(tones);
  return Object.entries(eventToneEntries)
    .filter(([, metadata]) => metadata.tone !== undefined && selected.has(metadata.tone))
    .map(([code]) => code);
};

export const decodeLogCursor = (serialized: string): LogCursor | null => decodeCursor(serialized, (value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const cursor = value as Record<string, unknown>;
    return typeof cursor.createdAt === "string" && cursor.createdAt.length > 0 &&
      typeof cursor.id === "string" && cursor.id.length > 0
      ? { createdAt: cursor.createdAt, id: cursor.id }
      : null;
});

export const channelStateQuery = `
    SELECT channel.channel_id, channel.login, channel.display_name, member.role,
           CASE WHEN broadcaster_identity.status = 'connected' THEN 1 ELSE 0 END AS broadcaster_connection,
           channel.full_consent AS full_consent,
           broadcaster_identity.scopes_json AS broadcaster_scopes_json,
           broadcaster_identity.status AS broadcaster_status,
           CASE WHEN ${channelBotConsentCondition("channel")} THEN 1 ELSE 0 END AS channel_bot_consent,
           CASE WHEN EXISTS (
             SELECT 1 FROM channel_modules AS chat_module
              WHERE chat_module.channel_id = channel.channel_id
                AND chat_module.module_id = 'text_commands'
                AND chat_module.enabled = 1
           ) THEN 1 ELSE 0 END AS chat_subscription_needed,
           bot_status.status AS bot_status, bot_status.reason AS bot_reason,
           bot_status.updated_at AS bot_updated_at,
           bot_identity.missing_scopes_json AS bot_missing_scopes_json,
           bot_identity.expires_at AS bot_expires_at,
           login_identity.status AS login_status, login_identity.reason AS login_reason,
           login_identity.expires_at AS login_expires_at,
           login_identity.updated_at AS login_updated_at,
           (SELECT stream_state.state
              FROM channel_stream_state AS stream_state
             WHERE stream_state.channel_id = channel.channel_id
             LIMIT 1) AS stream_state,
           (SELECT stream_state.changed_at
              FROM channel_stream_state AS stream_state
             WHERE stream_state.channel_id = channel.channel_id
             LIMIT 1) AS stream_state_changed_at,
           (SELECT COALESCE(stream_state.checked_at, stream_state.changed_at)
              FROM channel_stream_state AS stream_state
             WHERE stream_state.channel_id = channel.channel_id
             LIMIT 1) AS stream_state_checked_at,
           (SELECT stream_state.started_at
              FROM channel_stream_state AS stream_state
             WHERE stream_state.channel_id = channel.channel_id
               AND stream_state.state = 'online'
             LIMIT 1) AS stream_started_at,
           (SELECT stream_state.stream_id
              FROM channel_stream_state AS stream_state
             WHERE stream_state.channel_id = channel.channel_id
               AND stream_state.state = 'online'
             LIMIT 1) AS stream_id,
           channel_controls.muted AS muted,
           channel_controls.muted_until AS muted_until,
           channel_controls.mute_until_stream_end AS mute_until_stream_end,
           channel_controls.mute_stream_started_at AS mute_stream_started_at,
           channel_controls.mute_stream_id AS mute_stream_id,
           channel_controls.paused AS paused,
           channel_controls.paused_until AS paused_until,
           channel_controls.pause_until_stream_end AS pause_until_stream_end,
           channel_controls.pause_stream_started_at AS pause_stream_started_at,
           channel_controls.pause_stream_id AS pause_stream_id,
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
      LEFT JOIN channel_controls AS channel_controls ON channel_controls.channel_id = channel.channel_id
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

const parseScopes = (serialized: string | null): string[] => {
  if (serialized === null) return [];
  try {
    const parsed: unknown = JSON.parse(serialized);
    return Array.isArray(parsed) && parsed.every((scope) => typeof scope === "string")
      ? [...new Set(parsed)]
      : [];
  } catch {
    return [];
  }
};

const mapBroadcasterPermissions = (row: ChannelStateRow): PanelBroadcasterPermissions | null => {
  if (row.full_consent !== 1) return null;
  const granted = new Set(row.broadcaster_status === "connected" ? parseScopes(row.broadcaster_scopes_json) : []);
  return {
    missingScopes: listAllBroadcasterScopes().filter((scope) => !granted.has(scope)),
  };
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
  broadcasterPermissions: mapBroadcasterPermissions(row),
  moderator: mapModerator(row),
  chatSubscription: mapEventSub(row),
  chatSubscriptionNeeded: row.chat_subscription_needed === 1,
  streamState: row.stream_state,
  streamStartedAt: row.stream_started_at,
  streamStateChangedAt: row.stream_state_changed_at,
  streamStateCheckedAt: row.stream_state_checked_at,
  controls: mapChannelControls(row, new Date().toISOString()),
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
): Promise<PanelChannelState[]> => {
  const rows = await listChannelStateRows(db, userId);
  const modules = await getPanelModuleStatesForChannels(db, rows.map((row) => row.channel_id));
  return rows.map((row) => ({ ...mapChannelState(row), modules: modules.get(row.channel_id) ?? [] }));
};

export const getChannelOverviewForUser = async (
  db: D1Database,
  userId: string,
  channelId: string,
): Promise<PanelChannelOverview | null> => {
  const [row, moduleData] = await Promise.all([
    getChannelStateRow(db, userId, channelId),
    getPanelModuleDataForChannels(db, [channelId]),
  ]);
  if (row === null) return null;
  const moduleStates = moduleData.states.get(channelId) ?? [];
  const activeModules: PanelActiveModule[] = moduleData.active.get(channelId) ?? [];
  return { ...mapChannelState(row), modules: moduleStates, activeModules };
};

export const getSystemOverviewForUser = async (
  db: D1Database,
  userId: string,
  channelId: string,
): Promise<PanelSystemResponse | null> => {
  const [row, subscriptions] = await Promise.all([
    getChannelStateRow(db, userId, channelId),
    listEventSubSubscriptions(db, channelId),
  ]);
  if (row === null) return null;
  return {
    broadcasterConnection: row.broadcaster_connection === 1 ? "connected" : "not_connected",
    bot: mapBotStatus(row),
    botPermissions: mapBotPermissions(row),
    broadcasterPermissions: mapBroadcasterPermissions(row),
    chatSubscription: mapEventSub(row),
    chatSubscriptionNeeded: row.chat_subscription_needed === 1,
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

/** All audit action prefixes end in `.`, so `/` is their exclusive upper bound. */
const actionPrefixUpperBound = (prefix: string): string => {
  const lastCharacter = prefix.at(-1);
  if (lastCharacter === undefined) return prefix;
  return `${prefix.slice(0, -1)}${String.fromCharCode(lastCharacter.charCodeAt(0) + 1)}`;
};

/**
 * "module" has no prefix of its own in `AUDIT_AREA_PREFIXES` -- it's every
 * action none of the other areas' prefixes match, so its predicate is the
 * conjunction of the others' negations. Kept in sync with
 * `dashboard/audit/areas.ts`'s `auditAreaForAction` by construction: both
 * read the same table.
 */
export const auditAreaSqlClause = (area: AuditArea): { sql: string; values: string[] } => {
  const match = AUDIT_AREA_PREFIXES.find((entry) => entry.area === area);
  if (match !== undefined) {
    return {
      sql: "action >= ? AND action < ?",
      values: [match.prefix, actionPrefixUpperBound(match.prefix)],
    };
  }
  const prefixes = [...AUDIT_AREA_PREFIXES].sort((left, right) =>
    left.prefix < right.prefix ? -1 : left.prefix > right.prefix ? 1 : 0,
  );
  const ranges: { lower: string | null; upper: string | null }[] = [
    { lower: null, upper: prefixes[0]?.prefix ?? null },
    ...prefixes.slice(0, -1).map((entry, index) => ({
      lower: actionPrefixUpperBound(entry.prefix),
      upper: prefixes[index + 1]?.prefix ?? null,
    })),
    { lower: actionPrefixUpperBound(prefixes.at(-1)?.prefix ?? ""), upper: null },
  ];
  return {
    sql: `(${ranges.map(({ lower, upper }) => {
      if (lower === null && upper === null) return "1 = 1";
      if (lower === null) return "action < ?";
      if (upper === null) return "action >= ?";
      return "(action >= ? AND action < ?)";
    }).join(" OR ")})`,
    values: ranges.flatMap(({ lower, upper }) => lower === null
      ? upper === null ? [] : [upper]
      : upper === null ? [lower] : [lower, upper]),
  };
};

const NO_AUDIT_FILTERS: PanelAuditFilters = Object.freeze({ person: null, area: null });

// The channel + actor and channel + action indexes keep both optional filters
// selective before the descending timestamp scan as each channel's audit log
// grows.
export const getAuditLogForChannel = async (
  db: D1Database,
  channelId: string,
  limit: number,
  cursor: LogCursor | null,
  filters: PanelAuditFilters = NO_AUDIT_FILTERS,
): Promise<PanelAuditResponse> => {
  const where = ["channel_id = ?"];
  const filterValues: string[] = [channelId];
  if (filters.person !== null) {
    where.push("actor_user_id = ?");
    filterValues.push(filters.person);
  }
  if (filters.area !== null) {
    const area = auditAreaSqlClause(filters.area);
    where.push(area.sql);
    filterValues.push(...area.values);
  }
  const whereClause = where.join("\n          AND ");
  const query = cursor === null
    ? `SELECT audit_id, actor_user_id, actor_kind, created_at, channel_id, module_id, action, before_json, after_json
         FROM audit_log
        WHERE ${whereClause}
        ORDER BY created_at DESC, audit_id DESC
        LIMIT ?`
    : `SELECT audit_id, actor_user_id, actor_kind, created_at, channel_id, module_id, action, before_json, after_json
         FROM audit_log
        WHERE ${whereClause}
          AND (created_at < ? OR (created_at = ? AND audit_id < ?))
        ORDER BY created_at DESC, audit_id DESC
        LIMIT ?`;
  const values = cursor === null
    ? [...filterValues, limit + 1]
    : [...filterValues, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1];
  const result = await db.prepare(query).bind(...values).all<AuditLogRow>();
  const hasNextPage = result.results.length > limit;
  const rows = result.results.slice(0, limit);
  const entries: PanelAuditEntry[] = rows.map((row) => ({
    auditId: row.audit_id,
    actorUserId: row.actor_user_id,
    actorLogin: null,
    actorDisplayName: null,
    actorKind: row.actor_kind,
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
  filters: PanelEventFilters = { origin: null, module: null, tone: null, person: null },
): Promise<PanelEventsResponse> => {
  const where = ["channel_id = ?"];
  const filterValues: (string | number)[] = [channelId];
  if (filters.origin !== null) {
    where.push(filters.origin === "channel" ? "module_id = ?" : "module_id != ?");
    filterValues.push("channel_events");
  }
  if (filters.module !== null) {
    where.push("module_id = ?");
    filterValues.push(filters.module);
  }
  const selectedTones = filters.tones !== undefined && filters.tones.length > 0
    ? filters.tones
    : filters.tone === null ? [] : [filters.tone];
  if (selectedTones.length > 0) {
    const codes = filters.tones !== undefined && filters.tones.length > 0
      ? eventCodesForTones(filters.tones)
      : eventCodesForTone(filters.tone);
    if (codes.length === 0) where.push("1 = 0");
    else {
      where.push(`code IN (${codes.map(() => "?").join(", ")})`);
      filterValues.push(...codes);
    }
  }
  if (filters.person !== null) {
    where.push("actor_user_id = ?");
    filterValues.push(filters.person);
  }
  const whereClause = where.join("\n          AND ");
  const query = cursor === null
    ? `SELECT event_id, created_at, module_id, trigger_id, code, detail_json, actor_user_id
         FROM event_log
        WHERE ${whereClause}
        ORDER BY created_at DESC, event_id DESC
        LIMIT ?`
    : `SELECT event_id, created_at, module_id, trigger_id, code, detail_json, actor_user_id
         FROM event_log
        WHERE ${whereClause}
          AND (created_at < ? OR (created_at = ? AND event_id < ?))
        ORDER BY created_at DESC, event_id DESC
        LIMIT ?`;
  const values = cursor === null
    ? [...filterValues, limit + 1]
    : [...filterValues, cursor.createdAt, cursor.createdAt, cursor.id, limit + 1];
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
