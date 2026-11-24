import { z } from "zod";
import { MODULES } from "../../modules/registry";
import type {
  BotModule,
  ModuleConsumedResource,
  ModuleTwitchRankIncompleteReason,
  ModuleTwitchRankSnapshot,
  ModuleTwitchRankType,
  ModuleTwitchRankUser,
} from "../../modules/contract";
import type { HelixResult } from "../../modules/contract";
import type { ChannelJobRunContext, HostChannelJobRegistration } from "./channel-jobs";
import { withBroadcasterToken } from "../auth/broadcaster-token";
import { getLoginIdentity } from "../db/login-identity";
import { decryptLoginIdentityAccessToken } from "../auth/login-token-refresh";
import { listEventSubSubscriptions } from "../db/eventsub-state";
import { helixRequest, helixPages } from "../twitch/helix";

export type TwitchRankType = ModuleTwitchRankType;
export type TwitchRankUser = ModuleTwitchRankUser;
type TwitchRankSnapshotStatus ="never" | "running" | "failed" | "success";

export interface TwitchRankConsumer {
  moduleId: string;
  alarmKey: string;
}

export interface TwitchRankEvent {
  messageId: string;
  rankType: TwitchRankType;
  action: "add" | "remove";
  userId: string;
  login: string;
  displayName: string;
  eventAt: string;
}

export interface TwitchRankState {
  snapshotStatus: TwitchRankSnapshotStatus;
  snapshotStartedAt: string | null;
  lastSuccessAt: string | null;
  userIds: ReadonlySet<string>;
}

export interface TwitchRankCompletenessInput {
  scopeAvailable: boolean;
  tokenValid: boolean;
  snapshotStatus: TwitchRankSnapshotStatus;
  lastSuccessAt: string | null;
  snapshotStartedAt: string | null;
  subscriptionsEnabledSinceSnapshot: boolean;
  jobPaused: boolean;
  now: number;
  intervalMs: number;
}

export interface TwitchRanksStoreOptions {
  scheduleConsumerAlarmSync?: (moduleId: string, alarmKey: string, deadline: number) => void;
}

export interface RunTwitchRanksReconcileOptions {
  store: TwitchRanksStore;
  now: string;
  consumers: readonly TwitchRankConsumer[];
  scopeAvailable: (rankType: TwitchRankType) => Promise<boolean>;
  listRankUsers: (rankType: TwitchRankType) => Promise<HelixResult<TwitchRankUser[]>>;
  completedAt?: () => string;
}

export const TWITCH_RANKS_JOB_ID = "host:twitch_ranks:reconcile";
const TWITCH_RANKS_JOB_INTERVAL_MS = 60 * 60_000;
const TWITCH_RANKS_JOB_LABEL = { de: "Twitch-Ränge abgleichen", en: "Sync Twitch ranks" } as const;
const TWITCH_RANKS_JOB_REQUIRED_SCOPES: readonly string[] = [];
const TWITCH_RANKS_SCOPE_ALTERNATIVES = {
  vip: ["channel:read:vips", "channel:manage:vips"],
  moderator: ["moderation:read"],
} as const satisfies Readonly<Record<TwitchRankType, readonly string[]>>;

const RANK_TYPES: readonly TwitchRankType[] = ["vip", "moderator"];
const RECEIPT_RETENTION_MS = 24 * 60 * 60_000;

const snapshotStatusValue = (value: unknown): value is TwitchRankSnapshotStatus =>
  value === "never" || value === "running" || value === "failed" || value === "success";

const parseTimestamp = (value: string): number => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("invalid_twitch_rank_timestamp");
  return timestamp;
};

const canonicalTimestamp = (value: string): string => {
  const timestamp = parseTimestamp(value);
  const fraction = /\.(\d+)(?=Z|[+-]\d{2}:\d{2}$)/u.exec(value)?.[1] ?? "";
  const nanoseconds = fraction.padEnd(9, "0").slice(0, 9);
  return `${new Date(timestamp).toISOString().slice(0, -4)}${nanoseconds}Z`;
};

const ensureTwitchRanksSchema = (sql: SqlStorage): void => {
  sql.exec(`CREATE TABLE IF NOT EXISTS twitch_rank_sync_state (
    rank_type TEXT PRIMARY KEY CHECK (rank_type IN ('vip', 'moderator')),
    snapshot_status TEXT NOT NULL CHECK (snapshot_status IN ('never', 'running', 'failed', 'success')),
    snapshot_started_at TEXT,
    applied_snapshot_started_at TEXT,
    last_success_at TEXT
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS twitch_rank_memberships (
    rank_type TEXT NOT NULL CHECK (rank_type IN ('vip', 'moderator')),
    user_id TEXT NOT NULL,
    user_login TEXT NOT NULL,
    user_display_name TEXT NOT NULL,
    is_member INTEGER NOT NULL CHECK (is_member IN (0, 1)),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (rank_type, user_id)
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS twitch_rank_memberships_current_idx
    ON twitch_rank_memberships (rank_type, is_member, user_id)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS twitch_rank_events (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    rank_type TEXT NOT NULL CHECK (rank_type IN ('vip', 'moderator')),
    action TEXT NOT NULL CHECK (action IN ('add', 'remove')),
    user_id TEXT NOT NULL,
    user_login TEXT NOT NULL,
    user_display_name TEXT NOT NULL,
    event_at TEXT NOT NULL
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS twitch_rank_events_order_idx
    ON twitch_rank_events (rank_type, event_at, sequence)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS twitch_rank_event_receipts (
    message_id TEXT PRIMARY KEY,
    received_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS twitch_rank_event_receipts_received_idx
    ON twitch_rank_event_receipts (received_at)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS twitch_rank_consumers (
    module_id TEXT PRIMARY KEY,
    dirty INTEGER NOT NULL CHECK (dirty IN (0, 1)),
    generation INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  )`);
  for (const rankType of RANK_TYPES) {
    sql.exec(
      `INSERT OR IGNORE INTO twitch_rank_sync_state
         (rank_type, snapshot_status, snapshot_started_at, applied_snapshot_started_at, last_success_at)
       VALUES (?, 'never', NULL, NULL, NULL)`,
      rankType,
    );
  }
};

interface RankSyncRow extends Record<string, string | null> {
  rank_type: string;
  snapshot_status: string;
  snapshot_started_at: string | null;
  applied_snapshot_started_at: string | null;
  last_success_at: string | null;
}

interface RankMembershipRow extends Record<string, string | number> {
  user_id: string;
  user_login: string;
  user_display_name: string;
  is_member: number;
  updated_at: string;
}

interface RankEventRow extends Record<string, string | number> {
  sequence: number;
  rank_type: string;
  action: string;
  user_id: string;
  user_login: string;
  user_display_name: string;
  event_at: string;
}

const readSyncRow = (sql: SqlStorage, rankType: TwitchRankType): RankSyncRow | undefined =>
  sql.exec<RankSyncRow>(
    `SELECT rank_type, snapshot_status, snapshot_started_at, applied_snapshot_started_at, last_success_at
       FROM twitch_rank_sync_state WHERE rank_type = ?`,
    rankType,
  ).toArray()[0];

const activeUserIds = (sql: SqlStorage, rankType: TwitchRankType): Set<string> => new Set(
  sql.exec<{ user_id: string }>(
    `SELECT user_id FROM twitch_rank_memberships WHERE rank_type = ? AND is_member = 1 ORDER BY user_id`,
    rankType,
  ).toArray().map(({ user_id }) => user_id),
);

const applyMembershipEvent = (sql: SqlStorage, event: Pick<TwitchRankEvent,
  "rankType" | "action" | "userId" | "login" | "displayName" | "eventAt">): boolean => {
  const prior = sql.exec<RankMembershipRow>(
    `SELECT user_id, user_login, user_display_name, is_member, updated_at
       FROM twitch_rank_memberships WHERE rank_type = ? AND user_id = ?`,
    event.rankType,
    event.userId,
  ).toArray()[0];
  const eventAt = canonicalTimestamp(event.eventAt);
  if (prior !== undefined && prior.updated_at > eventAt) return false;
  const isMember = event.action === "add" ? 1 : 0;
  const changed = prior === undefined || prior.is_member !== isMember;
  sql.exec(
    `INSERT INTO twitch_rank_memberships
       (rank_type, user_id, user_login, user_display_name, is_member, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(rank_type, user_id) DO UPDATE SET
       user_login = excluded.user_login,
       user_display_name = excluded.user_display_name,
       is_member = excluded.is_member,
       updated_at = excluded.updated_at`,
    event.rankType,
    event.userId,
    event.login,
    event.displayName,
    isMember,
    eventAt,
  );
  return changed;
};

const markConsumersDirty = (
  sql: SqlStorage,
  consumers: readonly TwitchRankConsumer[],
  at: string,
  scheduleConsumerAlarmSync: TwitchRanksStoreOptions["scheduleConsumerAlarmSync"],
): void => {
  for (const consumer of consumers) {
    sql.exec(
      `INSERT INTO twitch_rank_consumers (module_id, dirty, generation, updated_at)
       VALUES (?, 1, 1, ?)
       ON CONFLICT(module_id) DO UPDATE SET dirty = 1, generation = twitch_rank_consumers.generation + 1,
         updated_at = excluded.updated_at`,
      consumer.moduleId,
      at,
    );
    scheduleConsumerAlarmSync?.(consumer.moduleId, consumer.alarmKey, Date.parse(at));
  }
};

export class TwitchRanksStore {
  private readonly storage: Pick<DurableObjectStorage, "sql" | "transactionSync">;
  private readonly options: TwitchRanksStoreOptions;

  public constructor(
    storage: Pick<DurableObjectStorage, "sql" | "transactionSync">,
    options: TwitchRanksStoreOptions = {},
  ) {
    this.storage = storage;
    this.options = options;
  }

  private transaction<Result>(operation: (sql: SqlStorage) => Result): Result {
    return this.storage.transactionSync(() => {
      ensureTwitchRanksSchema(this.storage.sql);
      return operation(this.storage.sql);
    });
  }

  public readState(rankType: TwitchRankType): TwitchRankState {
    return this.transaction((sql) => {
      const row = readSyncRow(sql, rankType);
      return {
        snapshotStatus: row !== undefined && snapshotStatusValue(row.snapshot_status) ? row.snapshot_status : "never",
        snapshotStartedAt: row?.snapshot_started_at ?? null,
        lastSuccessAt: row?.last_success_at ?? null,
        userIds: activeUserIds(sql, rankType),
      };
    });
  }

  public readUserIds(rankType: TwitchRankType): ReadonlySet<string> {
    return this.readState(rankType).userIds;
  }

  public beginSnapshot(context: ChannelJobRunContext, rankType: TwitchRankType, startedAt: string): boolean {
    const normalizedStart = canonicalTimestamp(startedAt);
    return context.commit((sql) => {
      ensureTwitchRanksSchema(sql);
      sql.exec(
        `UPDATE twitch_rank_sync_state
            SET snapshot_status = 'running', snapshot_started_at = ?
          WHERE rank_type = ?`,
        normalizedStart,
        rankType,
      );
    });
  }

  public failSnapshot(
    context: ChannelJobRunContext,
    rankType: TwitchRankType,
    startedAt: string,
  ): boolean {
    const normalizedStart = canonicalTimestamp(startedAt);
    return context.commit((sql) => {
      ensureTwitchRanksSchema(sql);
      sql.exec(
        `UPDATE twitch_rank_sync_state SET snapshot_status = 'failed'
          WHERE rank_type = ? AND snapshot_started_at = ? AND snapshot_status = 'running'`,
        rankType,
        normalizedStart,
      );
    });
  }

  public applySnapshot(
    context: ChannelJobRunContext,
    rankType: TwitchRankType,
    startedAt: string,
    completedAt: string,
    users: readonly TwitchRankUser[],
    consumers: readonly TwitchRankConsumer[],
  ): boolean {
    const normalizedStart = canonicalTimestamp(startedAt);
    const normalizedComplete = canonicalTimestamp(completedAt);
    let changed = false;
    const committed = context.commit((sql) => {
      ensureTwitchRanksSchema(sql);
      const state = readSyncRow(sql, rankType);
      if (state?.snapshot_status !== "running" || state.snapshot_started_at !== normalizedStart) {
        throw new Error("twitch_rank_snapshot_superseded");
      }
      const before = activeUserIds(sql, rankType);
      sql.exec(
        `UPDATE twitch_rank_memberships
            SET is_member = 0, updated_at = ?
          WHERE rank_type = ?`,
        normalizedStart,
        rankType,
      );
      for (const user of users) {
        sql.exec(
          `INSERT INTO twitch_rank_memberships
             (rank_type, user_id, user_login, user_display_name, is_member, updated_at)
           VALUES (?, ?, ?, ?, 1, ?)
           ON CONFLICT(rank_type, user_id) DO UPDATE SET
             user_login = excluded.user_login,
             user_display_name = excluded.user_display_name,
             is_member = 1,
             updated_at = excluded.updated_at`,
          rankType,
          user.userId,
          user.login,
          user.displayName,
          normalizedStart,
        );
      }
      const journal = sql.exec<RankEventRow>(
        `SELECT sequence, rank_type, action, user_id, user_login, user_display_name, event_at
           FROM twitch_rank_events
          WHERE rank_type = ? AND event_at > ?
          ORDER BY event_at, sequence`,
        rankType,
        normalizedStart,
      ).toArray();
      for (const row of journal) {
        applyMembershipEvent(sql, {
          rankType,
          action: row.action === "add" ? "add" : "remove",
          userId: row.user_id,
          login: row.user_login,
          displayName: row.user_display_name,
          eventAt: row.event_at,
        });
      }
      sql.exec(
        `UPDATE twitch_rank_sync_state
            SET snapshot_status = 'success', applied_snapshot_started_at = ?, last_success_at = ?
          WHERE rank_type = ? AND snapshot_started_at = ?`,
        normalizedStart,
        normalizedComplete,
        rankType,
        normalizedStart,
      );
      sql.exec("DELETE FROM twitch_rank_events WHERE rank_type = ?", rankType);
      const after = activeUserIds(sql, rankType);
      changed = before.size !== after.size || [...before].some((userId) => !after.has(userId));
      if (changed) markConsumersDirty(sql, consumers, normalizedComplete, this.options.scheduleConsumerAlarmSync);
    });
    return committed;
  }

  public applyEvent(
    event: TwitchRankEvent,
    consumers: readonly TwitchRankConsumer[],
    receivedAt = Date.now(),
  ): { duplicate: boolean; changed: boolean; ignored: boolean } {
    const normalizedEvent = { ...event, eventAt: canonicalTimestamp(event.eventAt) };
    if (!Number.isSafeInteger(receivedAt)) throw new RangeError("Invalid Twitch rank event receipt time.");
    return this.transaction((sql) => {
      if (consumers.length === 0) return { duplicate: false, changed: false, ignored: true };
      sql.exec("DELETE FROM twitch_rank_event_receipts WHERE received_at < ?", receivedAt - RECEIPT_RETENTION_MS);
      sql.exec(
        "INSERT OR IGNORE INTO twitch_rank_event_receipts (message_id, received_at) VALUES (?, ?)",
        normalizedEvent.messageId,
        receivedAt,
      );
      const duplicate = sql.exec<{ changes: number }>("SELECT changes() AS changes").one().changes === 0;
      if (duplicate) return { duplicate: true, changed: false, ignored: false };
      const state = readSyncRow(sql, normalizedEvent.rankType);
      if (state?.snapshot_status === "running" && state.snapshot_started_at !== null &&
          normalizedEvent.eventAt > state.snapshot_started_at) {
        sql.exec(
          `INSERT INTO twitch_rank_events
             (message_id, rank_type, action, user_id, user_login, user_display_name, event_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          normalizedEvent.messageId,
          normalizedEvent.rankType,
          normalizedEvent.action,
          normalizedEvent.userId,
          normalizedEvent.login,
          normalizedEvent.displayName,
          normalizedEvent.eventAt,
        );
      }
      const eventIsOlderThanSnapshot = state?.applied_snapshot_started_at !== null &&
        state?.applied_snapshot_started_at !== undefined &&
        state.applied_snapshot_started_at >= normalizedEvent.eventAt;
      const changed = eventIsOlderThanSnapshot ? false : applyMembershipEvent(sql, normalizedEvent);
      if (changed) {
        markConsumersDirty(sql, consumers, normalizedEvent.eventAt, this.options.scheduleConsumerAlarmSync);
      }
      return { duplicate: false, changed, ignored: false };
    });
  }

  public isConsumerDirty(moduleId: string): { dirty: boolean; generation: number } {
    return this.transaction((sql) => {
      const row = sql.exec<{ dirty: number; generation: number }>(
        "SELECT dirty, generation FROM twitch_rank_consumers WHERE module_id = ?",
        moduleId,
      ).toArray()[0];
      return { dirty: row?.dirty === 1, generation: row?.generation ?? 0 };
    });
  }

  public markConsumerReconciled(moduleId: string, generation: number, context: ChannelJobRunContext): boolean {
    return context.commit((sql) => {
      ensureTwitchRanksSchema(sql);
      sql.exec("UPDATE twitch_rank_consumers SET dirty = 0 WHERE module_id = ? AND generation = ?", moduleId, generation);
    });
  }
}

export const twitchRankCompletenessReason = (
  input: TwitchRankCompletenessInput,
): ModuleTwitchRankIncompleteReason | null => {
  if (!input.scopeAvailable) return "missing_scope";
  if (!input.tokenValid) return "token_invalid";
  if (input.snapshotStatus === "failed") return "snapshot_failed";
  if (input.snapshotStatus !== "success" || input.lastSuccessAt === null || input.snapshotStartedAt === null) {
    return "not_synced";
  }
  const lastSuccess = Date.parse(input.lastSuccessAt);
  if (!Number.isFinite(lastSuccess) || input.now - lastSuccess >= 2 * input.intervalMs) return "stale";
  if (!input.subscriptionsEnabledSinceSnapshot) return "eventsub_incomplete";
  if (input.jobPaused) return "job_paused";
  return null;
};

export const twitchRankSnapshot = (
  state: TwitchRankState,
  input: TwitchRankCompletenessInput,
): ModuleTwitchRankSnapshot => {
  const reason = twitchRankCompletenessReason(input);
  const available = input.scopeAvailable;
  return {
    available,
    complete: reason === null,
    ...(reason === null ? {} : { reason }),
    userIds: available ? state.userIds : new Set<string>(),
  };
};

const userRecord = (value: unknown): TwitchRankUser | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const userId = record.user_id;
  const login = record.user_login;
  const displayName = record.user_name;
  if (typeof userId !== "string" || userId.length === 0 || userId.length > 64 ||
      typeof login !== "string" || !/^[A-Za-z0-9_]{1,25}$/u.test(login) ||
      typeof displayName !== "string" || displayName.trim().length === 0 || displayName.length > 50) return null;
  return { userId, login, displayName };
};

const eventUser = (payload: Readonly<Record<string, unknown>>, action: string): TwitchRankUser | null => {
  const direct = userRecord(payload[action]);
  if (direct !== null) return direct;
  const nested = payload[action];
  if (typeof nested !== "object" || nested === null || Array.isArray(nested)) return null;
  return userRecord((nested as Record<string, unknown>).user);
};

export const parseTwitchRankEvent = (
  messageId: string,
  subscriptionType: string,
  payload: Readonly<Record<string, unknown>>,
  eventAt: string,
): TwitchRankEvent | null => {
  let rankType: TwitchRankType;
  let action: TwitchRankEvent["action"];
  let user: TwitchRankUser | null;
  if (subscriptionType === "channel.vip.add" || subscriptionType === "channel.vip.remove") {
    rankType = "vip";
    action = subscriptionType.endsWith(".add") ? "add" : "remove";
    user = userRecord(payload);
  } else if (subscriptionType === "channel.moderator.add" || subscriptionType === "channel.moderator.remove") {
    rankType = "moderator";
    action = subscriptionType.endsWith(".add") ? "add" : "remove";
    user = userRecord(payload);
  } else if (subscriptionType === "channel.moderate") {
    const moderationAction = payload.action;
    if (moderationAction === "vip" || moderationAction === "unvip") {
      rankType = "vip";
      action = moderationAction === "vip" ? "add" : "remove";
    } else if (moderationAction === "mod" || moderationAction === "unmod") {
      rankType = "moderator";
      action = moderationAction === "mod" ? "add" : "remove";
    } else return null;
    user = eventUser(payload, moderationAction);
  } else return null;
  if (user === null || messageId.length === 0 || messageId.length > 512) return null;
  try {
    return {
      messageId,
      rankType,
      action,
      userId: user.userId,
      login: user.login,
      displayName: user.displayName,
      eventAt: canonicalTimestamp(eventAt),
    };
  } catch {
    return null;
  }
};

const errorWithCode = (code: "missing_scope" | "refresh_failed"): Error & { code: string } =>
  Object.assign(new Error(code), { code });

export const runTwitchRanksReconcile = async (
  context: ChannelJobRunContext,
  options: RunTwitchRanksReconcileOptions,
): Promise<{ summary: Readonly<Record<"de" | "en", string>> }> => {
  const startedAt = canonicalTimestamp(options.now);
  if (options.consumers.length === 0) {
    return { summary: { de: "0 VIPs, 0 Moderator:innen", en: "0 VIPs, 0 moderators" } };
  }
  let availableTypes = 0;
  let failure: unknown;
  const counts = new Map<TwitchRankType, number>();
  for (const rankType of RANK_TYPES) {
    if (!await options.scopeAvailable(rankType)) continue;
    availableTypes += 1;
    if (!options.store.beginSnapshot(context, rankType, startedAt)) context.assertCurrent();
    let result: HelixResult<TwitchRankUser[]>;
    try {
      result = await options.listRankUsers(rankType);
    } catch (error: unknown) {
      if (!options.store.failSnapshot(context, rankType, startedAt)) context.assertCurrent();
      failure ??= error;
      continue;
    }
    if (!result.ok) {
      if (!options.store.failSnapshot(context, rankType, startedAt)) context.assertCurrent();
      failure ??= new Error(`Twitch rank snapshot failed: ${result.reason}`);
      continue;
    }
    const completedAt = canonicalTimestamp(options.completedAt?.() ?? new Date().toISOString());
    if (!options.store.applySnapshot(context, rankType, startedAt, completedAt, result.data, options.consumers)) {
      context.assertCurrent();
    }
    counts.set(rankType, result.data.length);
  }
  if (availableTypes === 0) throw errorWithCode("missing_scope");
  if (failure !== undefined) throw failure instanceof Error ? failure : new Error("Twitch rank snapshot failed.", { cause: failure });
  const vipCount = counts.get("vip");
  const moderatorCount = counts.get("moderator");
  const summary = [
    ...(vipCount === undefined ? [] : [`${String(vipCount)} VIPs`]),
    ...(moderatorCount === undefined ? [] : [`${String(moderatorCount)} moderators`]),
  ].join(", ");
  const germanSummary = [
    ...(vipCount === undefined ? [] : [`${String(vipCount)} VIPs`]),
    ...(moderatorCount === undefined ? [] : [`${String(moderatorCount)} Moderator:innen`]),
  ].join(", ");
  return { summary: { de: germanSummary, en: summary } };
};

const parsedTokenScopes = (serialized: string): string[] => {
  try {
    const value: unknown = JSON.parse(serialized);
    return Array.isArray(value) && value.every((scope) => typeof scope === "string") ? value : [];
  } catch {
    return [];
  }
};

const rankScopeAvailable =async (
  environment: Pick<Env, "DB">,
  channelId: string,
  rankType: TwitchRankType,
): Promise<boolean> => {
  const identity = await getLoginIdentity(environment.DB, channelId);
  if (identity?.status !== "connected") return false;
  const tokenScopes = new Set(parsedTokenScopes(identity.tokenScopesJson));
  return TWITCH_RANKS_SCOPE_ALTERNATIVES[rankType].some((scope) => tokenScopes.has(scope));
};

export const applyTwitchRankEventToStore = async (
  environment: Pick<Env, "DB">,
  store: TwitchRanksStore,
  channelId: string,
  input: {
    messageId: string;
    subscriptionType: string;
    payload: Readonly<Record<string, unknown>>;
    eventAt: string;
  },
  reconcileNeeded: () => Promise<void>,
): Promise<{ duplicate: boolean; changed: boolean; ignored: boolean }> => {
  const event = parseTwitchRankEvent(input.messageId, input.subscriptionType, input.payload, input.eventAt);
  if (event === null) return { duplicate: false, changed: false, ignored: true };
  const consumers = await listTwitchRanksConsumers(environment, channelId);
  if (consumers.length === 0 || !await rankScopeAvailable(environment, channelId, event.rankType)) {
    return { duplicate: false, changed: false, ignored: true };
  }
  const result = store.applyEvent(event, consumers);
  if (result.changed || result.duplicate) await reconcileNeeded();
  return result;
};

export const readTwitchRankSnapshot = async (
  environment: Env,
  store: TwitchRanksStore,
  channelId: string,
  rankType: TwitchRankType,
  jobPaused: boolean,
  now = Date.now(),
): Promise<ModuleTwitchRankSnapshot> => {
  const [state, identity, subscriptions] = await Promise.all([
    Promise.resolve(store.readState(rankType)),
    getLoginIdentity(environment.DB, channelId),
    listEventSubSubscriptions(environment.DB, channelId),
  ]);
  const tokenScopes = (() => {
    try {
      const parsed: unknown = identity === null ? [] : JSON.parse(identity.tokenScopesJson);
      return Array.isArray(parsed) && parsed.every((scope) => typeof scope === "string") ? parsed : [];
    } catch {
      return [];
    }
  })();
  const scopeAvailable = identity?.reason !== "active_module_scope_missing" &&
    TWITCH_RANKS_SCOPE_ALTERNATIVES[rankType].some((scope) => tokenScopes.includes(scope));
  let tokenValid = identity !== null && identity.status === "connected" && Date.parse(identity.expiresAt) > now;
  if (tokenValid && identity !== null) {
    try {
      tokenValid = await decryptLoginIdentityAccessToken(identity, environment) !== null;
    } catch {
      tokenValid = false;
    }
  }
  const matchingSubscriptions = rankType === "vip"
    ? ["channel.vip.add", "channel.vip.remove"]
    : ["channel.moderator.add", "channel.moderator.remove"];
  const subscriptionsEnabledSinceSnapshot = state.snapshotStartedAt !== null && matchingSubscriptions.every((type) => {
    const matching = subscriptions.filter((subscription) => subscription.subscriptionType === type);
    return matching.length > 0 && matching.every((subscription) =>
      subscription.status === "enabled" && Date.parse(subscription.updatedAt) <= Date.parse(state.snapshotStartedAt ?? ""));
  });
  return twitchRankSnapshot(state, {
    scopeAvailable,
    tokenValid,
    snapshotStatus: state.snapshotStatus,
    lastSuccessAt: state.lastSuccessAt,
    snapshotStartedAt: state.snapshotStartedAt,
    subscriptionsEnabledSinceSnapshot,
    jobPaused,
    now,
    intervalMs: TWITCH_RANKS_JOB_INTERVAL_MS,
  });
};

const fetchRankUsers = async (
  environment: Env,
  channelId: string,
  rankType: TwitchRankType,
  now: string,
): Promise<HelixResult<TwitchRankUser[]>> => {
  const scopeAlternatives = [TWITCH_RANKS_SCOPE_ALTERNATIVES[rankType]];
  const result = await withBroadcasterToken(
    environment,
    channelId,
    [],
    (accessToken) => rankType === "vip"
      ? listRankPages(environment, channelId, accessToken, "channels/vips")
      : listRankPages(environment, channelId, accessToken, "moderation/moderators"),
    { now: () => now, scopeAlternatives },
  );
  if (result.kind === "ok") return { ok: true, status: 200, data: result.value };
  if (result.kind === "http_error") return result.result;
  if (result.kind === "scope_missing") throw errorWithCode("missing_scope");
  throw errorWithCode(result.kind === "refresh_failed" || result.kind === "revoked" ? "refresh_failed" : "missing_scope");
};

const listRankPages = (
  environment: Env,
  channelId: string,
  accessToken: string,
  path: "channels/vips" | "moderation/moderators",
): Promise<HelixResult<TwitchRankUser[]>> => helixPages<TwitchRankUser>(async (cursor) => {
  const result = await helixRequest({
    url: `https://api.twitch.tv/helix/${path}`,
    clientId: environment.TWITCH_CLIENT_ID,
    accessToken,
    query: {
      broadcaster_id: channelId,
      first: "100",
      after: cursor ?? undefined,
    },
    schema: twitchRankPageSchema,
  });
  if (!result.ok) return result;
  return { ok: true, status: result.status, data: result.data };
});

interface TwitchRankHelixPage {
  data: TwitchRankUser[];
  pagination?: { cursor?: string };
}

export const twitchRankPageSchema: z.ZodType<TwitchRankHelixPage> = z.object({
  data: z.array(z.object({
    user_id: z.string().min(1).max(64),
    user_login: z.string().regex(/^[A-Za-z0-9_]{1,25}$/u),
    user_name: z.string().trim().min(1).max(50),
  })).max(100),
  pagination: z.object({ cursor: z.string().min(1).max(512).optional() }).optional(),
}).transform(({ data, pagination }) => ({
  data: data.map(({ user_id: userId, user_login: login, user_name: displayName }) => ({ userId, login, displayName })),
  ...(pagination === undefined ? {} : { pagination: pagination.cursor === undefined ? {} : { cursor: pagination.cursor } }),
}));

export const twitchRanksHostJob: HostChannelJobRegistration = {
  id: TWITCH_RANKS_JOB_ID,
  handlerKey: "host:twitch_ranks:reconcile",
  intervalMs: TWITCH_RANKS_JOB_INTERVAL_MS,
  label: TWITCH_RANKS_JOB_LABEL,
  requiredScopes: TWITCH_RANKS_JOB_REQUIRED_SCOPES,
  resource: "twitch_ranks" satisfies ModuleConsumedResource,
  run: async (context, _alarmKey, _deadline, now, _nowIso, runtime) => {
    const consumers = await listTwitchRanksConsumers(runtime.environment, runtime.channelId);
    const store = new TwitchRanksStore(runtime.storage, {
      scheduleConsumerAlarmSync: runtime.scheduleModuleAlarmSync,
    });
    try {
      return await runTwitchRanksReconcile(context, {
        store,
        now: new Date(now).toISOString(),
        consumers,
        scopeAvailable: async (rankType) => await rankScopeAvailable(runtime.environment, runtime.channelId, rankType),
        listRankUsers: async (rankType) => await fetchRankUsers(
          runtime.environment,
          runtime.channelId,
          rankType,
          new Date(now).toISOString(),
        ),
      });
    } finally {
      await runtime.scheduleAlarm();
    }
  },
};

export const listTwitchRanksConsumers = async (
  environment: Pick<Env, "DB">,
  channelId: string,
  registry: readonly BotModule[] = MODULES,
): Promise<TwitchRankConsumer[]> => {
  const rows = await environment.DB.prepare(
    "SELECT module_id FROM channel_modules WHERE channel_id = ? AND enabled = 1 ORDER BY module_id",
  ).bind(channelId).all<{ module_id: string }>();
  const enabledIds = new Set(rows.results.map(({ module_id }) => module_id));
  return registry.flatMap((module) => {
    if (module.mandatory !== true && !enabledIds.has(module.id)) return [];
    if (module.consumes?.includes("twitch_ranks") !== true) return [];
    const alarmKey = module.reconcileAlarmKeys?.twitch_ranks;
    const alarm = module.alarms?.find(({ key }) => key === alarmKey);
    return typeof alarmKey === "string" && alarm?.job !== undefined ? [{ moduleId: module.id, alarmKey }] : [];
  });
};
