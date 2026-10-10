import { DurableObject } from "cloudflare:workers";

import type {
  RealtimeEnvelope,
  RealtimeMessage,
  RealtimePrincipal,
  RealtimeRecipientKind,
} from "../../realtime-contract";
import {
  OVERLAY_ACCESS_BOUND_CLOSE_CODE,
  OVERLAY_ACCESS_BOUND_CLOSE_REASON,
  isModuleOverlayRealtimeEnvelope,
  realtimeRecipients,
} from "../../realtime-contract";
import { CHANNEL_ROLES, type ChannelRole } from "../../contracts/values";
import { processAdPrewarning } from "../ad-prewarning";
import { REALTIME_PRINCIPAL_HEADER, REALTIME_PROTOCOL } from "../realtime-protocol";
import type { AdsSchedule } from "../../modules/ads/contracts";
import { CHAT_VOTING_MODULE_ID } from "../../modules/chat_voting/contracts";
import { OVERLAY_STREAM_DETAILS_CACHE_TTL_MS } from "../../modules/contract";
import type {
  ActiveChatterActivity,
  BallotCastResult,
  BallotFinalizeResult,
  BallotFinalizeRule,
  BallotOpenResult,
  BallotSnapshot,
  BallotTermFilter,
  BotModule,
  HelixRequest,
  HelixRequestOptions,
  ModuleAlarmContext,
  ModuleAlarmDefinition,
  ModuleBallotAccess,
  ModuleExternalFetchBudget,
  ModuleScheduleInputChangeReason,
} from "../../modules/contract";
import { MODULES } from "../../modules/registry";
import {
  ACTIVE_CHATTER_EXPIRY_HANDLER,
  AD_COUNTDOWN_REFRESH_HANDLER,
  AD_PREWARNING_HANDLER,
  CHANNEL_HOST_ALARM_HANDLER_KEYS,
  MODULE_SCHEDULE_INPUTS_CHANGED_HANDLER,
  SECURITY_RETRY_HANDLER,
  SECURITY_ROUND_HANDLER,
  missingAlarmHandlerKeys,
  moduleAlarmHandlerEntries,
} from "./module-alarm-registry";
import { getAdSchedule } from "../../modules/ads/adapters/ad-schedule";
import { writeAdCountdownState } from "../../modules/ads/adapters/countdown-state";
import { adCountdownStateForSchedule, createAdCountdownOverlayAction } from "../../modules/ads/overlay/countdown-action";
import { refreshAdPrewarningAlarm } from "../../modules/ads/adapters/prewarning-alarm";
import type { AdPrewarningScheduler } from "../../modules/ads/adapters/prewarning-alarm";
import { getAppAccessToken } from "../app-token";
import { broadcasterHasScope } from "../broadcaster-scope";
import { helixRequest } from "../twitch/helix";
import { TWITCH_RATE_LIMIT_COOLDOWN_MS } from "../twitch/rate-limit";
import { prepareModuleOverlayRealtimeMessage } from "../module-overlay-realtime";
import {
  notifyCommittedResources,
  panelResourceChangedMessage,
  readPanelResourceRevisions,
  type PanelResourceRevisionVector,
  withCommittedPanelResourceDrain,
} from "../panel-resources";
import { createModuleSecretAccess } from "../module-secrets";
import { sendChatMessage } from "../chat";
import { sendModerationBan } from "../moderation";
import { readChannelStreamState } from "../db/stream-state";
import { moduleEnabledForChannel, readDispatchChannelState } from "../db/channel-controls";
import { chatOutputSuppressionReason } from "../chat-output-gate";
import { resolveModuleEventTimes } from "../module-event-times";
import { renderScheduledTemplate } from "../scheduled-template-renderer";
import { secureRandomInteger } from "../template-resolver";
import { createModuleExternalFetchBudget } from "../external-fetch-budget";
import { writeModuleDiagnostics } from "../event-log";
import {
  claimModuleAlarmSend,
  finishModuleAlarmSend,
  readModuleAlarmSendClaim,
} from "./module-alarm-send-claims";
import {
  claimAutomatedChatOutput,
  isRecentBotChatMessage,
  recordRecentBotChatMessage,
} from "./automated-chat-output";
import {
  BALLOT_EXPIRY_ALARM_HANDLER,
  BALLOT_HARD_DELETE_ALARM_HANDLER,
  approveStoredBallotTerm,
  ballotExpiryAlarmKey,
  ballotIdentityFromExpiryAlarmKey,
  castStoredBallot,
  castStoredBallotTerm,
  closeStoredBallot,
  forgetClosedStoredBallot,
  expireStoredBallot,
  finalizeStoredBallot,
  hasOpenStoredBallot,
  hasOpenStoredBallotSnapshot,
  hardDeleteFinalizedStoredBallot,
  openStoredBallot,
  readStoredBallot,
  readStoredBallotSnapshot,
  setStoredBallotBlockedTerms,
} from "./ballots";

const SECURITY_ALARM_INTERVAL_MS = 15 * 60 * 1000;
const SECURITY_RETRY_INTERVAL_MS = 60 * 1000;
const OVERLAY_HANDSHAKE_WINDOW_MS = 60 * 1000;
const OVERLAY_REVOKED_MARKER_TTL_MS = 10 * 60 * 1000;
const MAX_OVERLAY_HANDSHAKES_PER_TOKEN = 30;
const MAX_OVERLAY_SOCKETS_PER_TOKEN = 10;
const MAX_PANEL_SOCKETS_PER_USER = 10;
const MAX_CHANNEL_SOCKETS = 512;
// Keep a quarter of the room available to panel connections even when overlay
// tokens are being used at their limit.
const MAX_OVERLAY_SOCKETS_PER_CHANNEL = 384;
const D1_IN_PARAMETER_LIMIT = 100;
const FIXED_D1_PARAMETER_COUNT = 2;
const D1_IDS_PER_QUERY = D1_IN_PARAMETER_LIMIT - FIXED_D1_PARAMETER_COUNT;
const ALARM_TABLE_KEY = "channel:alarm_schedule";
const PANEL_DURABLE_REVISIONS_KEY = "channel:panel_resource_revisions";
const CHAT_ACTIVITY_COUNT_KEY = "channel:chat_activity_count";
const LEGACY_ACTIVE_CHATTER_STREAM_KEY = "chatter:stream";
const ACTIVE_CHATTER_TABLE = "active_chatters";
const ACTIVE_CHATTER_KEY_TABLE = "active_chatter_key";
const ACTIVE_CHATTER_EXPIRY_KEY = "host:active_chatters_expiry";
const ACTIVE_CHATTER_RETENTION_MS = 60 * 60 * 1_000;
const ACTIVE_CHATTER_KEY_ROTATION_MS = 24 * 60 * 60 * 1_000;
const MODULE_ALARM_OWNER_REVISIONS_KEY = "module_alarm:owner_revisions";
const MODULE_ALARM_OWNER_REVISION_RETENTION_MS = 24 * 60 * 60 * 1_000;
const SECURITY_DEADLINE_KEY = "security_round";
const SECURITY_RETRY_KEY = "security_retry";
const AD_PREWARNING_DEADLINE_KEY = "ad_prewarning";
const AD_PREWARNING_SEND_CLAIM_KEY = "ads:prewarning_send_claim";
const AD_SCHEDULE_CACHE_KEY = "ads:schedule";
const AD_SCHEDULE_GENERATION_KEY = "ads:schedule_generation";
const AD_PREWARNING_RECONCILED_KEY = "ads:prewarning_reconciled";
const TWITCH_RETRY_AFTER_KEY = "twitch:retry_after";
const AD_COUNTDOWN_REFRESH_ATTEMPT_KEY = "ads:countdown_refresh_attempt";
const AD_COUNTDOWN_REFRESH_DEADLINE_KEY = "ads:countdown_refresh_deadline";
const AD_COUNTDOWN_REFRESH_RETRY_COUNT_KEY = "ads:countdown_refresh_retry_count";
const PANEL_PUBLISHED_REVISIONS_KEY = "panel:published_resource_revisions";
const OVERLAY_STREAM_DETAILS_CACHE_KEY = "overlay:stream_details";
const CHANNEL_GAME_ID_CACHE_KEY = "channel:game_id";
// A failed lookup retries almost immediately instead of sitting on the full
// TTL below: an outage should not silently mean "no game" to every game
// filter for a minute.
const CHANNEL_GAME_ID_FAILURE_CACHE_TTL_MS = 5_000;
const AD_SCHEDULE_REFRESH_TIMEOUT_MS = 15_000;
const AD_COUNTDOWN_SCHEDULE_TTL_MS = 60_000;

const bumpDurablePanelResources = async (
  transaction: Pick<DurableObjectTransaction, "get" | "put">,
  resources: readonly string[],
): Promise<void> => {
  const revisions = await transaction.get<PanelResourceRevisionVector>(PANEL_DURABLE_REVISIONS_KEY) ?? {};
  const next = { ...revisions };
  for (const resource of new Set(resources)) next[resource] = (next[resource] ?? 0) + 1;
  await transaction.put(PANEL_DURABLE_REVISIONS_KEY, next);
};
const AD_COUNTDOWN_REFRESH_BUFFER_MS = 30_000;
const AD_COUNTDOWN_REFRESH_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;
const ALARM_HANDLER_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;
// The default 60s backoff above would itself burn through the (typically 60s)
// prewarning lead time on a single retry. A short delay here still lets a
// transient identity/token failure recover in time; `decideAdPrewarning`'s
// `too_late` check (see ad-prewarning.ts) is what actually bounds retries
// once the ad has started, not attempt count.
const AD_PREWARNING_RETRY_DELAYS_MS = [5_000, 10_000] as const;
// Send claims are kept per occurrence (keyed by its due-at ms) rather than
// deleted on clear, so a clear+re-arm of the same occurrence cannot send a
// second warning. Pruning anything older than this bounds that map's size
// across the channel's lifetime instead of retaining every occurrence ever
// claimed.
const AD_PREWARNING_CLAIM_RETENTION_MS = 24 * 60 * 60 * 1000;
const ALARM_HANDLER_RECOVERY_DELAY_MS = 60_000;
const MODULE_SCHEDULE_INPUTS_CHANGED_KEY = "host:schedule_inputs_changed";
const LEGACY_ALARM_DEFINITIONS = [
  { key: SECURITY_DEADLINE_KEY, handler: SECURITY_ROUND_HANDLER, suppressedBy: SECURITY_RETRY_KEY },
  { key: SECURITY_RETRY_KEY, handler: SECURITY_RETRY_HANDLER },
  { key: AD_PREWARNING_DEADLINE_KEY, handler: AD_PREWARNING_HANDLER },
  { key: AD_COUNTDOWN_REFRESH_DEADLINE_KEY, handler: AD_COUNTDOWN_REFRESH_HANDLER },
] as const;
const STREAM_REFRESH_LEASE_KEY = "stream_state_refresh_lease";
const STREAM_REFRESH_LEASE_MS = 30_000;
const SOCKET_EXPIRED_CODE = 4001;
const SOCKET_REVOKED_CODE = 4003;
const SOCKET_TRANSIENT_CODE = 4008;
const SOCKET_POLICY_VIOLATION_CODE = 1008;

/** Drops occurrences older than the retention window from a prewarning send-claim map. */
const prunePrewarningClaims = (
  claims: Readonly<Record<string, number>>,
  now: number,
): Record<string, number> => {
  const pruned: Record<string, number> = {};
  for (const [key, dueAtMs] of Object.entries(claims)) {
    if (Number.isFinite(dueAtMs) && now - dueAtMs <= AD_PREWARNING_CLAIM_RETENTION_MS) pruned[key] = dueAtMs;
  }
  return pruned;
};

const adCountdownRefreshAt = (schedule: AdsSchedule): number | null => {
  if (schedule.nextAdAt === null || typeof schedule.duration !== "number" ||
      !Number.isFinite(schedule.duration) || schedule.duration < 0) return null;
  const nextAdAt = Date.parse(schedule.nextAdAt);
  return Number.isFinite(nextAdAt)
    ? nextAdAt + schedule.duration * 1_000 + AD_COUNTDOWN_REFRESH_BUFFER_MS
    : null;
};

export interface CachedAdSchedule {
  schedule: AdsSchedule;
  asOf: string;
}

export interface AdScheduleRefreshResult {
  cache: CachedAdSchedule | null;
  reason: string | null;
  detail: Readonly<Record<string, string | number | boolean | null>>;
  d1Ms: number;
  helixMs: number;
  changed: boolean;
}

interface StreamRefreshLease {
  token: string;
  expiresAt: number;
}

interface OverlayStreamDetails {
  startedAt: string | null;
  viewerCount: number;
}

interface CachedOverlayStreamDetails {
  expectedStartedAt: string | null;
  expectedStreamId: string | null;
  checkedAt: number;
  details: OverlayStreamDetails | null;
}

interface OverlayStreamDetailsCache {
  details: OverlayStreamDetails | null;
  expiresAt: number;
}

interface CachedChannelGameId {
  checkedAt: number;
  gameId: string | null;
  /** True when `gameId` is null because the Helix lookup itself failed, not because the channel genuinely has no game set. */
  failed: boolean;
}

const revokedTokenKey = (tokenId: string): string => `overlay_revoked:${tokenId}`;

type SessionValidityRow = {
  session_id: string;
  user_id: string;
  role: ChannelRole | null;
};

type TokenValidityRow = { token_id: string; overlay_id: string | null };
type RevokedTokenMarker = { revokedAt: number };

type OverlayHandshakeWindow = { startedAt: number; count: number };
type RealtimeSocketAttachment = RealtimePrincipal;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const activeChatterKey = async (secretHex: string, channelId: string, userId: string): Promise<string> => {
  const encoder = new TextEncoder();
  const channel = encoder.encode(channelId);
  const user = encoder.encode(userId);
  const input = new Uint8Array(8 + channel.length + user.length);
  const view = new DataView(input.buffer);
  view.setUint32(0, channel.length);
  input.set(channel, 4);
  view.setUint32(4 + channel.length, user.length);
  input.set(user, 8 + channel.length);
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(secretHex.match(/.{2}/gu) ?? [], (byte) => Number.parseInt(byte, 16)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, input));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
};

type AlarmScheduleEntry = {
  /** The original scheduled time for this occurrence; stable across retries. */
  deadline: number;
  handler: string;
  /** The next execution time after a completed failed or retained attempt. */
  nextAttemptAt?: number;
  /** A durable lease left behind while the handler is running. */
  claimUntil?: number;
  failures?: number;
  revision?: number;
  ownerRevision?: number;
  suppressedBy?: string;
};

type AlarmScheduleTable = Record<string, AlarmScheduleEntry>;
type AlarmHandlerResult = undefined | "retain";
type AlarmHandler = (key: string, entry: AlarmScheduleEntry, now: number, nowIso: string) => Promise<AlarmHandlerResult>;
type AlarmHandlerRegistration = {
  handle: AlarmHandler;
  retryDelaysMs?: readonly number[];
};

interface AlarmStorageAccess {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
}

const validAlarmScheduleEntry = (value: unknown): value is AlarmScheduleEntry =>
  isRecord(value) && typeof value.deadline === "number" && Number.isFinite(value.deadline) &&
  typeof value.handler === "string" && value.handler.length > 0 &&
  (value.nextAttemptAt === undefined || (typeof value.nextAttemptAt === "number" && Number.isFinite(value.nextAttemptAt))) &&
  (value.claimUntil === undefined || (typeof value.claimUntil === "number" && Number.isFinite(value.claimUntil))) &&
  (value.failures === undefined || (typeof value.failures === "number" && Number.isInteger(value.failures) && value.failures >= 0)) &&
  (value.revision === undefined || (typeof value.revision === "number" && Number.isInteger(value.revision) && value.revision >= 0)) &&
  (value.ownerRevision === undefined || (typeof value.ownerRevision === "number" && Number.isInteger(value.ownerRevision) && value.ownerRevision >= 0)) &&
  (value.suppressedBy === undefined || typeof value.suppressedBy === "string");

const alarmAttemptAt = (entry: AlarmScheduleEntry): number =>
  entry.claimUntil ?? entry.nextAttemptAt ?? entry.deadline;

const earliestAlarmAt = (table: AlarmScheduleTable, now: number): number | null => {
  const deadlines = Object.entries(table)
    .filter(([, entry]) => Number.isFinite(alarmAttemptAt(entry)))
    .filter(([, entry]) => !(entry.deadline <= now && entry.suppressedBy !== undefined &&
      Object.hasOwn(table, entry.suppressedBy)))
    .map(([, entry]) => alarmAttemptAt(entry));
  return deadlines.length === 0 ? null : Math.min(...deadlines);
};

const readAlarmScheduleTable = async (storage: AlarmStorageAccess): Promise<AlarmScheduleTable> => {
  const saved = await storage.get(ALARM_TABLE_KEY);
  const table: AlarmScheduleTable = {};
  if (isRecord(saved)) {
    for (const [key, value] of Object.entries(saved)) {
      if (validAlarmScheduleEntry(value)) table[key] = value;
    }
  }
  for (const definition of LEGACY_ALARM_DEFINITIONS) {
    const deadline = await storage.get(definition.key);
    const current = table[definition.key];
    if (typeof deadline !== "number" || !Number.isFinite(deadline)) {
      // During a rollback the legacy implementation could clear its key while
      // the newer table still held the old deadline. The legacy key wins.
      Reflect.deleteProperty(table, definition.key);
      continue;
    }
    if (current !== undefined && alarmAttemptAt(current) === deadline) continue;

    // Legacy keys are the compatibility source of truth across a rollback.
    // A changed mirror is a new legacy deadline; discard retry/claim state
    // that the old implementation could not have understood.
    table[definition.key] = {
      deadline,
      handler: definition.handler,
      revision: (current?.revision ?? 0) + 1,
      ...( "suppressedBy" in definition ? { suppressedBy: definition.suppressedBy } : {}),
    };
  }
  return table;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isRealtimePrincipal = (value: unknown): value is RealtimePrincipal => {
  if (!isRecord(value) || value.v !== 1 || !isNonEmptyString(value.channelId)) return false;
  if (value.kind === "panel") {
    return isNonEmptyString(value.userId) &&
      isNonEmptyString(value.sessionId) &&
      typeof value.role === "string" && CHANNEL_ROLES.includes(value.role as ChannelRole) &&
      isNonEmptyString(value.expiresAt);
  }
  if (value.kind === "overlay") {
    return isNonEmptyString(value.tokenId) &&
      (value.overlayId === null || isNonEmptyString(value.overlayId)) &&
      (value.expiresAt === null || isNonEmptyString(value.expiresAt));
  }
  return false;
};

const isRealtimeSocketAttachment = (value: unknown): value is RealtimeSocketAttachment => {
  return isRealtimePrincipal(value);
};

const hasActiveRevocationMarker = (marker: unknown, now: number): boolean =>
  marker === true || (isRecord(marker) && typeof marker.revokedAt === "number" &&
    Number.isFinite(marker.revokedAt) && now - marker.revokedAt < OVERLAY_REVOKED_MARKER_TTL_MS);

const readAttachment = (webSocket: WebSocket): RealtimeSocketAttachment | null => {
  try {
    const attachment: unknown = webSocket.deserializeAttachment();
    return isRealtimeSocketAttachment(attachment) ? attachment : null;
  } catch {
    return null;
  }
};

const isExpired = (principal: RealtimePrincipal, now: number): boolean => {
  if (principal.expiresAt === null) return false;
  const expiresAt = Date.parse(principal.expiresAt);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
};

const closeSocket = (webSocket: WebSocket, code: number, reason: string): boolean => {
  try {
    webSocket.close(code, reason);
    return true;
  } catch {
    // The socket may already have closed between selection and close.
    return false;
  }
};

const tagsFor = (principal: RealtimePrincipal): string[] => principal.kind === "panel"
  ? [`kind:${principal.kind}`, `user:${principal.userId}`, `session:${principal.sessionId}`]
  : [`kind:${principal.kind}`, `token:${principal.tokenId}`,
    ...(principal.overlayId === null ? [] : [`overlay:${principal.overlayId}`])];

const chunksOf = <T>(values: readonly T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    chunks.push(values.slice(offset, offset + size));
  }
  return chunks;
};

const envelopeFor = (
  channelId: string,
  type: "system.hello",
): RealtimeEnvelope<"system.hello"> => ({
  version: 1,
  id: crypto.randomUUID(),
  createdAt: new Date().toISOString(),
  channelId,
  type,
  payload: {},
});

/**
 * Channel-bound realtime room. Hibernation is a hard invariant here: no
 * class field holds state that still needs to be correct after waking up.
 * Principals and tags live on the socket; the only periodic work is in the
 * alarm, and the authorization data lives in D1.
 */
export class ChannelObject extends DurableObject<Env> {
  private overlayStreamDetailsRefreshes = new Map<string, Promise<OverlayStreamDetailsCache>>();
  private channelGameIdRefresh: Promise<CachedChannelGameId> | null = null;
  private adScheduleRefresh: Promise<AdScheduleRefreshResult> | null = null;
  private adScheduleRefreshStartedAt = 0;
  private adScheduleRefreshGeneration = 0;
  private adScheduleOperationQueue: Promise<void> = Promise.resolve();
  private belaboxPollQueue: Promise<void> = Promise.resolve();
  private activeChatterSchemaReady = false;
  // ponytail: This Set is per-instance memory and is empty after hibernation, so the residual window is bounded by the security alarm. Persist token IDs in DO storage if that window needs to be shorter.
  private recentlyBoundOverlayTokenIds = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    if (ctx.storage.kv.get(LEGACY_ACTIVE_CHATTER_STREAM_KEY) !== undefined) {
      this.ensureActiveChatterTable();
      ctx.storage.transactionSync(() => {
        if (this.activeChatterKeyRowSync() === null) this.clearActiveChatterStateSync();
        else ctx.storage.kv.delete(LEGACY_ACTIVE_CHATTER_STREAM_KEY);
      });
    }
  }

  private ownChannelId(): string | null {
    const name = this.ctx.id.name;
    return typeof name === "string" && name.length > 0 ? name : null;
  }

  private async serializeBelaboxPoll<Result>(operation: () => Promise<Result>): Promise<Result> {
    const previous = this.belaboxPollQueue;
    let release!: () => void;
    this.belaboxPollQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async runModuleAlarmHandler<Result>(
    moduleId: string,
    handlerKey: string,
    operation: () => Promise<Result>,
  ): Promise<Result> {
    // Both explicit poll requests and the alarm dispatcher enter through this
    // gate, so every BELABOX reason shares the alarm's serialized routine.
    return moduleId === "belabox" && handlerKey === "poll"
      ? await this.serializeBelaboxPoll(operation)
      : await operation();
  }

  private ensureActiveChatterTable(): void {
    if (this.activeChatterSchemaReady) return;
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${ACTIVE_CHATTER_TABLE} (
        hmac TEXT PRIMARY KEY,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      )`,
    );
    // EXPLAIN QUERY PLAN reports a covering-index range search for last_seen_at >= ?.
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS active_chatters_last_seen_at_idx
       ON ${ACTIVE_CHATTER_TABLE} (last_seen_at)`,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${ACTIVE_CHATTER_KEY_TABLE} (
        slot INTEGER PRIMARY KEY CHECK (slot = 1),
        key_hex TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
    );
    this.activeChatterSchemaReady = true;
  }

  private incrementChatActivityCountSync(): number {
    const next = this.currentChatActivityCountSync() + 1;
    this.ctx.storage.kv.put(CHAT_ACTIVITY_COUNT_KEY, next);
    return next;
  }

  private currentChatActivityCountSync(): number {
    const current = this.ctx.storage.kv.get<number>(CHAT_ACTIVITY_COUNT_KEY);
    return typeof current === "number" && Number.isSafeInteger(current) && current >= 0 ? current : 0;
  }

  private writeActiveChatterExpiryEntrySync(deadline: number): void {
    const saved = this.ctx.storage.kv.get(ALARM_TABLE_KEY);
    const table: AlarmScheduleTable = {};
    if (isRecord(saved)) {
      for (const [key, value] of Object.entries(saved)) {
        if (validAlarmScheduleEntry(value)) table[key] = value;
      }
    }
    const current = table[ACTIVE_CHATTER_EXPIRY_KEY];
    if (current?.handler === ACTIVE_CHATTER_EXPIRY_HANDLER && current.deadline === deadline &&
        current.nextAttemptAt === undefined && current.claimUntil === undefined) return;
    table[ACTIVE_CHATTER_EXPIRY_KEY] = {
      deadline,
      handler: ACTIVE_CHATTER_EXPIRY_HANDLER,
      revision: (current?.revision ?? 0) + 1,
    };
    this.ctx.storage.kv.put(ALARM_TABLE_KEY, table);
  }

  private clearActiveChatterExpiryEntrySync(): void {
    const saved = this.ctx.storage.kv.get(ALARM_TABLE_KEY);
    if (!isRecord(saved)) return;
    const table: AlarmScheduleTable = {};
    for (const [key, value] of Object.entries(saved)) {
      if (validAlarmScheduleEntry(value)) table[key] = value;
    }
    const current = table[ACTIVE_CHATTER_EXPIRY_KEY];
    if (current === undefined) return;
    Reflect.deleteProperty(table, ACTIVE_CHATTER_EXPIRY_KEY);
    this.ctx.storage.kv.put(ALARM_TABLE_KEY, table);
  }

  private clearActiveChatterRecordsSync(): void {
    this.ensureActiveChatterTable();
    this.ctx.storage.sql.exec(`DELETE FROM ${ACTIVE_CHATTER_TABLE}`);
  }

  private activeChatterKeyRowSync(): { keyHex: string; createdAt: number } | null {
    this.ensureActiveChatterTable();
    const row = this.ctx.storage.sql.exec<{ key_hex: string; created_at: string }>(
      `SELECT key_hex, created_at FROM ${ACTIVE_CHATTER_KEY_TABLE} WHERE slot = 1`,
    ).toArray()[0];
    if (row === undefined || !/^[0-9a-f]{64}$/iu.test(row.key_hex)) return null;
    const createdAt = Date.parse(row.created_at);
    return Number.isFinite(createdAt) ? { keyHex: row.key_hex, createdAt } : null;
  }

  private activeChatterNextSweepSync(keyCreatedAt: number): number | null {
    this.ensureActiveChatterTable();
    const row = this.ctx.storage.sql.exec<{ first_expiry: string | null }>(
      `SELECT MIN(last_seen_at) AS first_expiry FROM ${ACTIVE_CHATTER_TABLE}`,
    ).toArray()[0];
    if (row?.first_expiry == null) return null;
    const firstSeen = Date.parse(row.first_expiry);
    if (!Number.isFinite(firstSeen)) return Date.now();
    return Math.min(firstSeen + ACTIVE_CHATTER_RETENTION_MS, keyCreatedAt + ACTIVE_CHATTER_KEY_ROTATION_MS);
  }

  private recordActiveChatter(hmac: string, seenAt: string): void {
    this.ensureActiveChatterTable();
    this.ctx.storage.sql.exec(
      `INSERT INTO ${ACTIVE_CHATTER_TABLE} (hmac, first_seen_at, last_seen_at)
       VALUES (?, ?, ?)
       ON CONFLICT(hmac) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
      hmac,
      seenAt,
      seenAt,
    );
  }

  /** Arm a physical alarm before committing a new or earlier sweep deadline. */
  private async ensurePlatformActiveChatterAlarm(deadline: number): Promise<void> {
    const platformAlarm = await this.ctx.storage.getAlarm();
    if (platformAlarm === null || platformAlarm > deadline) await this.ctx.storage.setAlarm(deadline);
  }

  private clearActiveChatterStateSync(): void {
    this.clearActiveChatterRecordsSync();
    this.ctx.storage.sql.exec(`DELETE FROM ${ACTIVE_CHATTER_KEY_TABLE}`);
    this.ctx.storage.kv.delete(LEGACY_ACTIVE_CHATTER_STREAM_KEY);
    this.clearActiveChatterExpiryEntrySync();
  }

  /** Keep schedule cache writes and their alarm reconciliation in one order. */
  private async withAdScheduleOperation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.adScheduleOperationQueue;
    let release!: () => void;
    this.adScheduleOperationQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async saveAdSchedule(
    schedule: AdsSchedule,
    asOf: string,
    grantedScopes?: readonly string[],
    expectedGeneration?: number,
    reconcileAlarm = true,
  ): Promise<boolean | null> {
    return this.withAdScheduleOperation(async () => {
      const channelId = this.ownChannelId();
      if (channelId === null) throw new Error("Channel-bound data requires a named Durable Object.");
      const cache = { schedule, asOf } satisfies CachedAdSchedule;
      const countdownState = adCountdownStateForSchedule(schedule, asOf);
      const change = await this.ctx.storage.transaction(async (transaction) => {
        const currentGeneration = await transaction.get<number>(AD_SCHEDULE_GENERATION_KEY) ?? 0;
        if (expectedGeneration !== undefined && currentGeneration !== expectedGeneration) return null;
        const previous = await transaction.get<CachedAdSchedule>(AD_SCHEDULE_CACHE_KEY);
        const previousCountdownState = previous === undefined ? null : adCountdownStateForSchedule(previous.schedule, previous.asOf);
        await transaction.put(AD_SCHEDULE_GENERATION_KEY, currentGeneration + 1);
        await transaction.put(AD_SCHEDULE_CACHE_KEY, cache);
        await bumpDurablePanelResources(transaction, ["module:ads:schedule"]);
        return {
          changed: previous === undefined || JSON.stringify(previous.schedule) !== JSON.stringify(schedule),
          countdownChanged: previousCountdownState === null ||
            previousCountdownState.nextAdAt !== countdownState.nextAdAt ||
            previousCountdownState.duration !== countdownState.duration ||
            previousCountdownState.snoozeCount !== countdownState.snoozeCount ||
            previousCountdownState.snoozeRefreshAt !== countdownState.snoozeRefreshAt,
        };
      });
      if (change === null) return null;
      await this.notifyCommittedPanelResources();
      if (reconcileAlarm) await this.reconcileAdPrewarning(schedule, grantedScopes);
      try {
        await writeAdCountdownState(this.env.DB, channelId, countdownState, asOf);
      } catch (error: unknown) {
        console.warn("Ad countdown state snapshot could not be stored.", error);
      } finally {
        await this.notifyCommittedPanelResources();
      }
      if (change.changed) await this.notifyScheduleInputsChanged("event_times");
      await this.reconcileAdCountdownRefresh(schedule);
      if (change.countdownChanged) {
        try {
          const publishedAt = new Date().toISOString();
          const prepared = await prepareModuleOverlayRealtimeMessage(
            this.env.DB,
            channelId,
            "ads",
            createAdCountdownOverlayAction({ ...countdownState, serverNow: publishedAt }),
          );
          if (prepared.outcome === "ready") await this.publish([prepared.message]);
        } catch (error: unknown) {
          console.warn("Ad countdown overlay update could not be sent.", error);
        }
      }
      return change.changed;
    });
  }

  public async reconcileCachedAdPrewarning(grantedScopes?: readonly string[]): Promise<void> {
    await this.withAdScheduleOperation(async () => {
      // Read after entering the queue: an EventSub or Helix schedule save that
      // was queued first must be the value reconciled by this panel read.
      const cache = await this.getCachedAdSchedule();
      if (cache !== null) await this.reconcileAdPrewarning(cache.schedule, grantedScopes);
    });
  }

  private async reconcileAdPrewarning(schedule: AdsSchedule, grantedScopes?: readonly string[]): Promise<void> {
    const channelId = this.ownChannelId();
    if (channelId === null) return;
    const scheduler: AdPrewarningScheduler = {
      schedule: (dueAtMs) => this.scheduleAdPrewarning(dueAtMs),
      clear: () => this.clearAdPrewarning(),
    };
    try {
      await refreshAdPrewarningAlarm(this.env, channelId, schedule, broadcasterHasScope, scheduler, grantedScopes);
      await this.ctx.storage.put(AD_PREWARNING_RECONCILED_KEY, {
        schedule: JSON.stringify(schedule),
        scopes: grantedScopes === undefined ? null : [...grantedScopes].sort((a, b) => a.localeCompare(b)).join("\u001f"),
        reconciledAt: Date.now(),
      });
    } catch (error: unknown) {
      await this.ctx.storage.delete(AD_PREWARNING_RECONCILED_KEY);
      console.warn("Ad prewarning alarm reconciliation failed.", error);
    }
  }

  public async getCachedAdSchedule(): Promise<CachedAdSchedule | null> {
    const channelId = this.ownChannelId();
    if (channelId === null) return null;
    const cache = await this.ctx.storage.get<CachedAdSchedule>(AD_SCHEDULE_CACHE_KEY);
    return cache ?? null;
  }

  /** Shares overlay stream lookups across bootstraps for this channel. */
  public async getOverlayStreamDetails(
    expectedStartedAt: string | null,
    expectedStreamId: string | null,
    now: number,
  ): Promise<OverlayStreamDetailsCache | null> {
    const channelId = this.ownChannelId();
    if (channelId === null) return null;
    const cached = await this.ctx.storage.get<CachedOverlayStreamDetails>(OVERLAY_STREAM_DETAILS_CACHE_KEY);
    if (cached !== undefined && cached.expectedStartedAt === expectedStartedAt &&
        cached.expectedStreamId === expectedStreamId &&
        Number.isFinite(cached.checkedAt) && cached.checkedAt <= now &&
        now - cached.checkedAt < OVERLAY_STREAM_DETAILS_CACHE_TTL_MS) {
      return { details: cached.details, expiresAt: cached.checkedAt + OVERLAY_STREAM_DETAILS_CACHE_TTL_MS };
    }

    const cacheIdentity = JSON.stringify([expectedStartedAt, expectedStreamId]);
    const refreshes = this.overlayStreamDetailsRefreshes;
    let refresh = refreshes.get(cacheIdentity);
    if (refresh === undefined) {
      refresh = (async () => {
        let details: OverlayStreamDetails | null = null;
        try {
          const accessToken = await getAppAccessToken(this.env, new Date(now).toISOString());
          const result = await helixRequest<{ data?: unknown }>({
            url: "https://api.twitch.tv/helix/streams",
            query: { user_id: channelId, type: "live" },
            accessToken,
            clientId: this.env.TWITCH_CLIENT_ID,
          });
          if (result.ok && isRecord(result.data) && Array.isArray(result.data.data)) {
            const item: unknown = result.data.data[0];
            if (item === undefined) {
              details = { startedAt: expectedStartedAt, viewerCount: 0 };
            } else if (isRecord(item)) {
              details = {
                startedAt: typeof item.started_at === "string" ? item.started_at : expectedStartedAt,
                viewerCount: typeof item.viewer_count === "number" && Number.isSafeInteger(item.viewer_count)
                  ? item.viewer_count
                  : 0,
              };
            }
          }
        } catch {
          // Cache the miss briefly too, so an API outage cannot multiply lookups per bootstrap.
        }
        await this.ctx.storage.put(OVERLAY_STREAM_DETAILS_CACHE_KEY, {
          expectedStartedAt,
          expectedStreamId,
          checkedAt: now,
          details,
        } satisfies CachedOverlayStreamDetails);
        return { details, expiresAt: now + OVERLAY_STREAM_DETAILS_CACHE_TTL_MS };
      })();
      refreshes.set(cacheIdentity, refresh);
    }
    try {
      return await refresh;
    } finally {
      if (refreshes.get(cacheIdentity) === refresh) refreshes.delete(cacheIdentity);
    }
  }

  /**
   * Shares the channel's current game across chat modules (FAQ and text
   * commands game filters) so a busy chat cannot turn every message into a
   * Helix channel lookup. Reuses the overlay stream-details TTL: game
   * changes are not time-critical enough to warrant their own constant.
   */
  public async getCachedChannelGameId(now: number): Promise<string | null> {
    const channelId = this.ownChannelId();
    if (channelId === null) return null;
    const cached = await this.ctx.storage.get<CachedChannelGameId>(CHANNEL_GAME_ID_CACHE_KEY);
    const cacheTtlMs = cached?.failed === true ? CHANNEL_GAME_ID_FAILURE_CACHE_TTL_MS : OVERLAY_STREAM_DETAILS_CACHE_TTL_MS;
    if (cached !== undefined && Number.isFinite(cached.checkedAt) && cached.checkedAt <= now &&
        now - cached.checkedAt < cacheTtlMs) {
      return cached.gameId;
    }

    let refresh = this.channelGameIdRefresh;
    if (refresh === null) {
      refresh = (async () => {
        let gameId: string | null = null;
        let failed = false;
        try {
          const accessToken = await getAppAccessToken(this.env, new Date(now).toISOString());
          const result = await helixRequest<{ data?: unknown }>({
            url: "https://api.twitch.tv/helix/channels",
            query: { broadcaster_id: channelId },
            accessToken,
            clientId: this.env.TWITCH_CLIENT_ID,
          });
          if (result.ok && isRecord(result.data) && Array.isArray(result.data.data)) {
            const item: unknown = result.data.data[0];
            if (isRecord(item) && typeof item.game_id === "string" && item.game_id.length > 0) gameId = item.game_id;
          } else if (!result.ok) {
            failed = true;
          }
        } catch {
          failed = true;
          // Cache the failure briefly too, so an API outage cannot multiply lookups per message.
        }
        await this.ctx.storage.put(CHANNEL_GAME_ID_CACHE_KEY, { checkedAt: now, gameId, failed } satisfies CachedChannelGameId);
        return { checkedAt: now, gameId, failed } satisfies CachedChannelGameId;
      })();
      this.channelGameIdRefresh = refresh;
    }
    try {
      return (await refresh).gameId;
    } finally {
      if (this.channelGameIdRefresh === refresh) this.channelGameIdRefresh = null;
    }
  }

  /**
   * Keeps the shared game-id cache in step with a `channel.update` EventSub
   * notification for this channel, using the category id it already carries
   * instead of waiting out the cache TTL (or spending another Helix call).
   */
  public async updateCachedChannelGameId(gameId: string | null, now: number): Promise<void> {
    const channelId = this.ownChannelId();
    if (channelId === null) return;
    await this.ctx.storage.put(CHANNEL_GAME_ID_CACHE_KEY, { checkedAt: now, gameId, failed: false } satisfies CachedChannelGameId);
  }

  public async getAdScheduleGeneration(): Promise<number> {
    return await this.ctx.storage.get<number>(AD_SCHEDULE_GENERATION_KEY) ?? 0;
  }

  /** Refreshes stale countdown data at most once per minute for this channel. */
  public async refreshAdScheduleForCountdown(): Promise<AdScheduleRefreshResult | null> {
    const now = Date.now();
    const cached = await this.getCachedAdSchedule();
    const cachedAt = cached === null ? Number.NaN : Date.parse(cached.asOf);
    const nextAdAt = cached?.schedule.nextAdAt === null || cached?.schedule.nextAdAt === undefined
      ? null
      : Date.parse(cached.schedule.nextAdAt);
    const durationMs = typeof cached?.schedule.duration === "number" && Number.isFinite(cached.schedule.duration)
      ? cached.schedule.duration * 1_000
      : null;
    const adEnded = nextAdAt !== null && Number.isFinite(nextAdAt)
      && nextAdAt <= now && (durationMs === null || now >= nextAdAt + durationMs);
    const stale = cached === null || !Number.isFinite(cachedAt) || now - cachedAt >= AD_COUNTDOWN_SCHEDULE_TTL_MS || adEnded;
    if (!stale) return null;

    const claimed = await this.ctx.storage.transaction(async (transaction) => {
      const previousAttempt = await transaction.get<number>(AD_COUNTDOWN_REFRESH_ATTEMPT_KEY);
      if (typeof previousAttempt === "number" && now - previousAttempt < AD_COUNTDOWN_SCHEDULE_TTL_MS) return false;
      await transaction.put(AD_COUNTDOWN_REFRESH_ATTEMPT_KEY, now);
      return true;
    });
    return claimed ? this.refreshAdSchedule() : null;
  }

  public async refreshAdSchedule(grantedScopes?: readonly string[]): Promise<AdScheduleRefreshResult> {
    const now = Date.now();
    if (this.adScheduleRefresh !== null && now - this.adScheduleRefreshStartedAt < AD_SCHEDULE_REFRESH_TIMEOUT_MS) {
      return this.adScheduleRefresh;
    }
    const refreshGeneration = ++this.adScheduleRefreshGeneration;
    this.adScheduleRefreshStartedAt = now;
    const task = (async (): Promise<AdScheduleRefreshResult> => {
      const channelId = this.ownChannelId();
      if (channelId === null) return { cache: null, reason: "channel_missing", detail: {}, d1Ms: 0, helixMs: 0, changed: false };
      const snapshot = await this.ctx.storage.transaction(async (transaction) => ({
        cache: await transaction.get<CachedAdSchedule>(AD_SCHEDULE_CACHE_KEY) ?? null,
        generation: await transaction.get<number>(AD_SCHEDULE_GENERATION_KEY) ?? 0,
      }));
      const previous = snapshot.cache;
      const retryAfter = await this.getTwitchRateLimitRetryAfter(now);
      if (retryAfter !== null) {
        return { cache: previous, reason: "rate_limited", detail: { retryAfter }, d1Ms: 0, helixMs: 0, changed: false };
      }
      let d1Ms = 0;
      let helixMs = 0;
      const timedGetAppAccessToken: typeof getAppAccessToken = async (...args) => {
        const startedAt = performance.now();
        try {
          return await getAppAccessToken(...args);
        } finally {
          d1Ms += performance.now() - startedAt;
        }
      };
      const timedHelixRequest: HelixRequest = async <Data>(options: HelixRequestOptions<Data>) => {
        const startedAt = performance.now();
        try {
          return await helixRequest<Data>(options);
        } finally {
          helixMs += performance.now() - startedAt;
        }
      };
      const result = await getAdSchedule(this.env, channelId, new Date().toISOString(), timedGetAppAccessToken, timedHelixRequest, fetch);
      if (!result.fetched || result.schedule === null) {
        if (result.reason === "rate_limited") await this.setTwitchRateLimitRetryAfter(Date.now() + TWITCH_RATE_LIMIT_COOLDOWN_MS);
        return { cache: previous, reason: result.reason, detail: result.detail, d1Ms, helixMs, changed: false };
      }
      if (refreshGeneration !== this.adScheduleRefreshGeneration) {
        return { cache: await this.getCachedAdSchedule(), reason: null, detail: result.detail, d1Ms, helixMs, changed: false };
      }
      const asOf = new Date().toISOString();
      const changed = await this.saveAdSchedule(result.schedule, asOf, grantedScopes, snapshot.generation);
      if (changed === null) {
        return { cache: await this.getCachedAdSchedule(), reason: null, detail: result.detail, d1Ms, helixMs, changed: false };
      }
      return { cache: { schedule: result.schedule, asOf }, reason: null, detail: result.detail, d1Ms, helixMs, changed };
    })();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timedOut: Promise<AdScheduleRefreshResult> = new Promise((resolve) => {
      timeoutId = setTimeout(() => {
        resolve({ cache: null, reason: "timeout", detail: {}, d1Ms: 0, helixMs: 0, changed: false });
      }, AD_SCHEDULE_REFRESH_TIMEOUT_MS);
    });
    this.adScheduleRefresh = Promise.race([task, timedOut]);
    try {
      return await this.adScheduleRefresh;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (refreshGeneration === this.adScheduleRefreshGeneration) {
        this.adScheduleRefresh = null;
        this.adScheduleRefreshStartedAt = 0;
      }
    }
  }

  public async storeAdSchedule(
    schedule: AdsSchedule,
    asOf: string,
    grantedScopes?: readonly string[],
    expectedGeneration?: number,
    reconcileAlarm = true,
  ): Promise<CachedAdSchedule | null> {
    const saved = await this.saveAdSchedule(schedule, asOf, grantedScopes, expectedGeneration, reconcileAlarm);
    if (saved === null) return null;
    await this.ctx.storage.delete(AD_COUNTDOWN_REFRESH_RETRY_COUNT_KEY);
    return { schedule, asOf };
  }

  public async getTwitchRateLimitRetryAfter(now = Date.now()): Promise<number | null> {
    const retryAfter = await this.ctx.storage.get<number>(TWITCH_RETRY_AFTER_KEY);
    return typeof retryAfter === "number" && Number.isFinite(retryAfter) && retryAfter > now
      ? retryAfter
      : null;
  }

  public async setTwitchRateLimitRetryAfter(retryAfter: number): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      await transaction.put(TWITCH_RETRY_AFTER_KEY, retryAfter);
      await bumpDurablePanelResources(transaction, ["module:ads:schedule"]);
    });
    await this.notifyCommittedPanelResources();
  }

  private async hasAdCountdownOverlay(channelId: string): Promise<boolean> {
    const result = await this.env.DB.prepare(
      `SELECT 1 AS present
         FROM overlay_elements
        WHERE channel_id = ? AND kind = 'ads.countdown'
        LIMIT 1`,
    ).bind(channelId).all<{ present: number }>();
    return result.results.length > 0;
  }

  private async clearAdCountdownRefresh(clearRetries = true): Promise<void> {
    await this.clearAlarmEntry(AD_COUNTDOWN_REFRESH_DEADLINE_KEY);
    if (clearRetries) await this.ctx.storage.delete(AD_COUNTDOWN_REFRESH_RETRY_COUNT_KEY);
  }

  private async reconcileAdCountdownRefresh(schedule: AdsSchedule): Promise<void> {
    const refreshAt = adCountdownRefreshAt(schedule);
    if (refreshAt === null) {
      await this.clearAdCountdownRefresh(false);
      return;
    }

    const channelId = this.ownChannelId();
    if (channelId === null) return;
    try {
      if (!await this.hasAdCountdownOverlay(channelId)) {
        await this.clearAdCountdownRefresh();
        return;
      }

      const now = Date.now();
      if (refreshAt > now) await this.ctx.storage.delete(AD_COUNTDOWN_REFRESH_RETRY_COUNT_KEY);
      await this.scheduleAlarmEntry(
        AD_COUNTDOWN_REFRESH_DEADLINE_KEY,
        AD_COUNTDOWN_REFRESH_HANDLER,
        Math.max(refreshAt, now + AD_COUNTDOWN_REFRESH_BUFFER_MS),
      );
    } catch (error: unknown) {
      console.warn("Ad countdown refresh alarm could not be reconciled.", error);
    }
  }

  private async retryAdCountdownRefresh(): Promise<void> {
    const retryCount = await this.ctx.storage.get<number>(AD_COUNTDOWN_REFRESH_RETRY_COUNT_KEY) ?? 0;
    const retryDelay = AD_COUNTDOWN_REFRESH_RETRY_DELAYS_MS[retryCount];
    if (retryDelay === undefined || !Number.isInteger(retryCount) || retryCount < 0) {
      await this.clearAdCountdownRefresh();
      return;
    }

    const retryAt = Date.now() + retryDelay;
    await this.ctx.storage.put(AD_COUNTDOWN_REFRESH_RETRY_COUNT_KEY, retryCount + 1);
    await this.scheduleAlarmEntry(AD_COUNTDOWN_REFRESH_DEADLINE_KEY, AD_COUNTDOWN_REFRESH_HANDLER, retryAt);
  }

  private async refreshCountdownScheduleFromAlarm(): Promise<void> {
    const channelId = this.ownChannelId();
    if (channelId === null) return;

    const existingDeadline = await this.readAlarmDeadline(AD_COUNTDOWN_REFRESH_DEADLINE_KEY);
    if (existingDeadline !== null && existingDeadline > Date.now()) return;

    let hasOverlay: boolean;
    try {
      hasOverlay = await this.hasAdCountdownOverlay(channelId);
    } catch (error: unknown) {
      console.warn("Ad countdown overlay lookup failed during refresh.", error);
      await this.retryAdCountdownRefresh();
      return;
    }
    if (!hasOverlay) {
      await this.clearAdCountdownRefresh();
      return;
    }

    try {
      await this.refreshAdScheduleForCountdown();
      const cache = await this.getCachedAdSchedule();
      const nextRefreshAt = cache === null ? null : adCountdownRefreshAt(cache.schedule);
      if (nextRefreshAt !== null && nextRefreshAt > Date.now()) {
        await this.ctx.storage.delete(AD_COUNTDOWN_REFRESH_RETRY_COUNT_KEY);
        await this.scheduleAlarmEntry(AD_COUNTDOWN_REFRESH_DEADLINE_KEY, AD_COUNTDOWN_REFRESH_HANDLER, nextRefreshAt);
      } else {
        await this.retryAdCountdownRefresh();
      }
    } catch (error: unknown) {
      console.warn("Ad countdown schedule refresh failed.", error);
      await this.retryAdCountdownRefresh();
    }
  }

  /** A durable short lease coalesces overview-triggered refreshes across Worker isolates. */
  public async beginStreamStateRefresh(now = Date.now()): Promise<string | null> {
    const token = crypto.randomUUID();
    return this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<StreamRefreshLease>(STREAM_REFRESH_LEASE_KEY);
      if (current !== undefined && current.expiresAt > now) return null;
      await transaction.put(STREAM_REFRESH_LEASE_KEY, { token, expiresAt: now + STREAM_REFRESH_LEASE_MS } satisfies StreamRefreshLease);
      return token;
    });
  }

  public async endStreamStateRefresh(token: string): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<StreamRefreshLease>(STREAM_REFRESH_LEASE_KEY);
      if (current?.token === token) await transaction.delete(STREAM_REFRESH_LEASE_KEY);
    });
  }

  private async mutateAlarmSchedule(
    mutate: (table: AlarmScheduleTable, storage: AlarmStorageAccess) => Promise<void> | void,
  ): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const table = await readAlarmScheduleTable(transaction);
      await mutate(table, transaction);
      await transaction.put(ALARM_TABLE_KEY, table);
    });
  }

  private async ensureAlarmScheduleTable(): Promise<AlarmScheduleTable> {
    return await this.ctx.storage.transaction(async (transaction) => {
      const table = await readAlarmScheduleTable(transaction);
      if (Object.keys(table).length === 0) await transaction.delete(ALARM_TABLE_KEY);
      else await transaction.put(ALARM_TABLE_KEY, table);
      return table;
    });
  }

  private async scheduleAlarmEntry(
    key: string,
    handler: string,
    deadline: number,
    suppressedBy?: string,
    ownerRevision?: number,
  ): Promise<void> {
    if (!Number.isFinite(deadline)) {
      await this.clearAlarmEntry(key);
      return;
    }
    await this.mutateAlarmSchedule(async (table, storage) => {
      if (ownerRevision !== undefined && !await this.acceptAlarmOwnerRevision(storage, key, ownerRevision)) return;
      const current = table[key];
      table[key] = {
        deadline,
        handler,
        revision: (current?.revision ?? 0) + 1,
        ...(ownerRevision === undefined ? {} : { ownerRevision }),
        ...(suppressedBy === undefined ? {} : { suppressedBy }),
      };
      if (LEGACY_ALARM_DEFINITIONS.some((definition) => definition.key === key)) {
        await storage.put(key, deadline);
      }
    });
    await this.scheduleEarliestAlarm();
  }

  private async acceptAlarmOwnerRevision(
    storage: AlarmStorageAccess,
    key: string,
    ownerRevision: number,
  ): Promise<boolean> {
    const now = Date.now();
    const storedValue = await storage.get(MODULE_ALARM_OWNER_REVISIONS_KEY);
    const stored = isRecord(storedValue) ? storedValue as Record<string, { revision: number; updatedAt: number }> : {};
    const current = stored[key];
    if (current !== undefined && Number.isSafeInteger(current.revision) && ownerRevision < current.revision) return false;
    const revisions = Object.fromEntries(Object.entries(stored).filter(([, entry]) =>
      Number.isSafeInteger(entry.revision) && Number.isFinite(entry.updatedAt) && now - entry.updatedAt <= MODULE_ALARM_OWNER_REVISION_RETENTION_MS,
    ));
    revisions[key] = { revision: ownerRevision, updatedAt: now };
    await storage.put(MODULE_ALARM_OWNER_REVISIONS_KEY, revisions);
    return true;
  }

  private async clearAlarmEntry(key: string, ownerRevision?: number): Promise<void> {
    await this.mutateAlarmSchedule(async (table, storage) => {
      if (ownerRevision !== undefined && !await this.acceptAlarmOwnerRevision(storage, key, ownerRevision)) return;
      Reflect.deleteProperty(table, key);
      if (LEGACY_ALARM_DEFINITIONS.some((definition) => definition.key === key)) {
        await storage.delete(key);
      }
    });
    await this.scheduleEarliestAlarm();
  }

  private async clearAlarmEntries(keys: readonly string[]): Promise<void> {
    await this.mutateAlarmSchedule(async (table, storage) => {
      for (const key of keys) {
        Reflect.deleteProperty(table, key);
        if (LEGACY_ALARM_DEFINITIONS.some((definition) => definition.key === key)) {
          await storage.delete(key);
        }
      }
    });
    await this.scheduleEarliestAlarm();
  }

  private async readAlarmDeadline(key: string): Promise<number | null> {
    const table = await this.ensureAlarmScheduleTable();
    const entry = table[key];
    return entry === undefined ? null : entry.deadline;
  }

  private async claimAlarmEntry(
    key: string,
    expected: AlarmScheduleEntry,
  ): Promise<AlarmScheduleEntry | null> {
    return await this.ctx.storage.transaction(async (transaction) => {
      const table = await readAlarmScheduleTable(transaction);
      const current = table[key];
      const now = Date.now();
      if (current === undefined || JSON.stringify(current) !== JSON.stringify(expected) || alarmAttemptAt(current) > now) {
        await transaction.put(ALARM_TABLE_KEY, table);
        return null;
      }
      const claimed: AlarmScheduleEntry = {
        ...current,
        claimUntil: now + ALARM_HANDLER_RECOVERY_DELAY_MS,
        revision: (current.revision ?? 0) + 1,
      };
      delete claimed.nextAttemptAt;
      table[key] = claimed;
      await transaction.put(ALARM_TABLE_KEY, table);
      if (LEGACY_ALARM_DEFINITIONS.some((definition) => definition.key === key)) {
        await transaction.put(key, claimed.claimUntil);
      }
      return claimed;
    });
  }

  private async completeAlarmEntry(key: string, claimed: AlarmScheduleEntry): Promise<void> {
    await this.mutateAlarmSchedule(async (table, storage) => {
      if (JSON.stringify(table[key]) !== JSON.stringify(claimed)) return;
      Reflect.deleteProperty(table, key);
      if (LEGACY_ALARM_DEFINITIONS.some((definition) => definition.key === key)) {
        await storage.delete(key);
      }
    });
    await this.scheduleEarliestAlarm();
  }

  private async retainAlarmEntry(key: string, claimed: AlarmScheduleEntry): Promise<void> {
    await this.mutateAlarmSchedule(async (table, storage) => {
      if (JSON.stringify(table[key]) !== JSON.stringify(claimed)) return;
      const entry = { ...claimed };
      delete entry.claimUntil;
      delete entry.nextAttemptAt;
      const retained: AlarmScheduleEntry = {
        ...entry,
        nextAttemptAt: Date.now() + ALARM_HANDLER_RECOVERY_DELAY_MS,
        revision: (claimed.revision ?? 0) + 1,
      };
      table[key] = retained;
      if (LEGACY_ALARM_DEFINITIONS.some((definition) => definition.key === key)) {
        await storage.put(key, alarmAttemptAt(retained));
      }
    });
    await this.scheduleEarliestAlarm();
  }

  private async rescheduleFailedAlarm(
    key: string,
    claimed: AlarmScheduleEntry,
    retryDelaysMs: readonly number[] | undefined,
  ): Promise<void> {
    const configuredDelays = retryDelaysMs?.filter((delay) => Number.isFinite(delay) && delay >= 1);
    const delays = configuredDelays?.length ? configuredDelays : ALARM_HANDLER_RETRY_DELAYS_MS;
    const failures = claimed.failures ?? 0;
    const delay = delays[Math.min(failures, delays.length - 1)];
    if (delay === undefined || !Number.isFinite(delay) || delay < 1) return;
    await this.mutateAlarmSchedule(async (table, storage) => {
      const current = table[key];
      if (JSON.stringify(current) !== JSON.stringify(claimed)) return;
      const entry = { ...claimed };
      delete entry.claimUntil;
      delete entry.nextAttemptAt;
      table[key] = {
        ...entry,
        nextAttemptAt: Date.now() + delay,
        failures: failures + 1,
        revision: (claimed.revision ?? 0) + 1,
      };
      if (LEGACY_ALARM_DEFINITIONS.some((definition) => definition.key === key)) {
        await storage.put(key, alarmAttemptAt(table[key]));
      }
    });
    await this.scheduleEarliestAlarm();
  }

  private moduleAlarmContext(
    moduleId: string,
    registration: ModuleAlarmDefinition,
    externalFetchBudget: ModuleExternalFetchBudget,
  ): ModuleAlarmContext {
    const channelId = this.ownChannelId();
    if (channelId === null) throw new Error("Module alarms require a named Durable Object.");
    const storagePrefix = `module:${moduleId}:storage:`;
    const handler = `module:${moduleId}:${registration.key}`;
    return {
      DB: this.env.DB,
      channelId,
      externalFetchBudget,
      ballots: this.ballotAccess(moduleId),
      secrets: createModuleSecretAccess(this.env, channelId, moduleId),
      channelLanguage: async () => {
        const row = await this.env.DB.prepare("SELECT language FROM channels WHERE channel_id = ?")
          .bind(channelId).first<{ language: string }>();
        return row?.language === "en" ? "en" : "de";
      },
      secureRandomInteger,
      executeTimeout: async (action) => {
        const module = MODULES.find((candidate) => candidate.id === moduleId);
        if (!await moduleEnabledForChannel(this.env.DB, channelId, moduleId, module?.mandatory === true)) {
          return "suppressed";
        }
        return (await sendModerationBan(this.env, channelId, {
          userId: action.userId,
          durationSeconds: action.durationSeconds,
          reason: action.reason,
        })).outcome;
      },
      storage: {
        get: (key: string) => this.ctx.storage.get(`${storagePrefix}${key}`),
        put: async (key: string, value: unknown) => {
          await this.ctx.storage.transaction(async (transaction) => {
            await transaction.put(`${storagePrefix}${key}`, value);
            await bumpDurablePanelResources(transaction, [`module:${moduleId}:data`]);
          });
          await this.notifyCommittedPanelResources();
        },
        delete: async (key: string) => {
          const deleted = await this.ctx.storage.transaction(async (transaction) => {
            const removed = await transaction.delete(`${storagePrefix}${key}`);
            if (removed) await bumpDurablePanelResources(transaction, [`module:${moduleId}:data`]);
            return removed;
          });
          if (deleted) await this.notifyCommittedPanelResources();
          return deleted;
        },
      },
      schedule: async (key, deadline, ownerRevision) => {
        const scheduledRegistration = MODULES.find((module) => module.id === moduleId)?.alarms?.find((alarm) => alarm.key === key);
        await this.scheduleAlarmEntry(
          `module:${moduleId}:${key}`,
          scheduledRegistration === undefined ? handler : `module:${moduleId}:${scheduledRegistration.key}`,
          deadline,
          undefined,
          ownerRevision,
        );
      },
      clear: async (key, ownerRevision) => {
        await this.clearAlarmEntry(`module:${moduleId}:${key}`, ownerRevision);
      },
      getAlarmDeadline: (key) => this.getModuleAlarmDeadline(moduleId, key),
      renderTemplate: async (text, moduleValuesOrNow = {}, nowOrModuleValues = Date.now()) => {
        const now = typeof moduleValuesOrNow === "number"
          ? moduleValuesOrNow
          : typeof nowOrModuleValues === "number" ? nowOrModuleValues : Date.now();
        const moduleValues = typeof moduleValuesOrNow === "number"
          ? typeof nowOrModuleValues === "object" ? nowOrModuleValues : {}
          : moduleValuesOrNow;
        return renderScheduledTemplate(
          this.env,
          channelId,
          text,
          now,
          externalFetchBudget,
          moduleValues,
          (runModuleId, handlerKey, alarmKey, invocation) => invocation === undefined
            ? this.runModuleAlarm(runModuleId, handlerKey, alarmKey)
            : this.runModuleAlarm(runModuleId, handlerKey, alarmKey, invocation),
        );
      },
      publishModuleOverlayMessage: async (type, elementKind, payload) => {
        const prepared = await prepareModuleOverlayRealtimeMessage(this.env.DB, channelId, moduleId, {
          kind: "overlay",
          type,
          elementKind,
          payload,
        });
        if (prepared.outcome === "ready") await this.publish([prepared.message]);
      },
      sendChat: async (text, idempotencyKey, attributions = [], stillValid, target = "source_only") => {
        const suppression = { reason: null as string | null };
        const validateOutput = async (): Promise<boolean> => {
          if (stillValid !== undefined && !await stillValid()) {
            suppression.reason = "stale_before_send";
            return false;
          }
          const [channelState, registration] = await Promise.all([
            readDispatchChannelState(this.env.DB, channelId, new Date().toISOString()),
            Promise.resolve(MODULES.find((module) => module.id === moduleId)),
          ]);
          const activation = channelState.activations.find((entry) => entry.moduleId === moduleId);
          suppression.reason = chatOutputSuppressionReason({
            moduleEnabled: registration?.mandatory === true || activation?.enabled === true,
            mandatory: registration?.mandatory === true,
            paused: channelState.controls.pause.active,
            muted: channelState.controls.mute.active,
          });
          return suppression.reason === null;
        };
        const claimBeforePost = async (): Promise<boolean | "rate_limited"> => {
          if (!await validateOutput()) return false;
          return await claimModuleAlarmSend(this.ctx.storage, idempotencyKey, Date.now());
        };
        const afterPost = async (delivery: "sent" | "rejected" | "ambiguous" | "not_attempted"): Promise<void> => {
          if (delivery !== "not_attempted") await finishModuleAlarmSend(this.ctx.storage, idempotencyKey, delivery, Date.now());
        };
        const result = await sendChatMessage(
          this.env,
          channelId,
          text,
          undefined,
          fetch,
          validateOutput,
          claimBeforePost,
          attributions,
          afterPost,
          target,
          undefined,
          (senderId, messageText) => this.recordBotChatMessage(senderId, messageText),
        );
        if (result.reason === "already_attempted") {
          const claim = await readModuleAlarmSendClaim(this.ctx.storage, idempotencyKey);
          if (claim?.status === "sent") return { sent: true, reason: null, retryable: false };
        }
        const reason = suppression.reason ?? result.reason;
        const retryable = suppression.reason === null && result.reason !== "stale_before_send" &&
          result.reason !== "already_attempted" && result.delivery !== "ambiguous";
        return { sent: result.sent, reason, retryable };
      },
      chatActivityCount: () => this.getChatActivityCount(),
      resolveEventTimes: (now) => resolveModuleEventTimes(this.env.DB, channelId, now),
      streamState: async () => (await readChannelStreamState(this.env.DB, channelId))?.state ?? "unknown",
      streamStartedAt: async () => {
        const state = await readChannelStreamState(this.env.DB, channelId);
        return state === null ? { streamId: null, startedAt: null } : { streamId: state.streamId, startedAt: state.startedAt };
      },
      writeDiagnostics: (triggerId, diagnostics, now) =>
        writeModuleDiagnostics(this.env.DB, channelId, moduleId, triggerId, null, diagnostics, now),
    };
  }

  public async recordChatActivity(
    chatterUserId: string | null = null,
    needsActiveChatters = false,
  ): Promise<number> {
    const stream = await readChannelStreamState(this.env.DB, this.ownChannelId() ?? "");
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const userIdForTracking = needsActiveChatters && typeof chatterUserId === "string" && chatterUserId.length > 0
      ? chatterUserId
      : null;
    const online = stream?.state === "online";

    if (userIdForTracking === null) {
      if (!online) return await this.getChatActivityCount();
      return this.ctx.storage.transactionSync(() => this.incrementChatActivityCountSync());
    }

    return await this.ctx.blockConcurrencyWhile(async () => {
      this.ensureActiveChatterTable();
      const current = this.activeChatterKeyRowSync();
      const rotating = current === null || now - current.createdAt >= ACTIVE_CHATTER_KEY_ROTATION_MS;
      const keyHex = rotating
        ? Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join("")
        : current.keyHex;
      const keyCreatedAt = rotating ? now : current.createdAt;
      const hmac = await activeChatterKey(keyHex, this.ownChannelId() ?? "", userIdForTracking);
      const currentSweep = rotating ? null : this.activeChatterNextSweepSync(keyCreatedAt);
      const preflightDeadline = Math.min(
        currentSweep ?? Number.POSITIVE_INFINITY,
        now + ACTIVE_CHATTER_RETENTION_MS,
        keyCreatedAt + ACTIVE_CHATTER_KEY_ROTATION_MS,
      );

      try {
        await this.ensurePlatformActiveChatterAlarm(preflightDeadline);
      } catch (error: unknown) {
        if (online) this.ctx.storage.transactionSync(() => this.incrementChatActivityCountSync());
        throw error;
      }
      return this.ctx.storage.transactionSync(() => {
        this.ensureActiveChatterTable();
        const latest = this.activeChatterKeyRowSync();
        const latestRotating = latest === null || now - latest.createdAt >= ACTIVE_CHATTER_KEY_ROTATION_MS;
        if (latestRotating || latest.keyHex !== keyHex || latest.createdAt !== keyCreatedAt) {
          this.clearActiveChatterRecordsSync();
          this.ctx.storage.sql.exec(`DELETE FROM ${ACTIVE_CHATTER_KEY_TABLE}`);
          this.ctx.storage.kv.delete(LEGACY_ACTIVE_CHATTER_STREAM_KEY);
          this.ctx.storage.sql.exec(
            `INSERT INTO ${ACTIVE_CHATTER_KEY_TABLE} (slot, key_hex, created_at) VALUES (1, ?, ?)`,
            keyHex,
            new Date(keyCreatedAt).toISOString(),
          );
        }
        this.recordActiveChatter(hmac, nowIso);
        const nextSweep = this.activeChatterNextSweepSync(keyCreatedAt);
        if (nextSweep === null) this.clearActiveChatterExpiryEntrySync();
        else this.writeActiveChatterExpiryEntrySync(nextSweep);
        return online ? this.incrementChatActivityCountSync() : this.currentChatActivityCountSync();
      });
    });
  }

  public async clearActiveChatters(): Promise<void> {
    await this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.transactionSync(() => {
        this.clearActiveChatterStateSync();
      });
      await this.scheduleEarliestAlarm();
    });
  }

  public getActiveChatterCount(windowMs: number): Promise<number> {
    if (!Number.isFinite(windowMs) || windowMs <= 0) return Promise.resolve(0);
    const now = Date.now();
    const key = this.activeChatterKeyRowSync();
    if (key === null || now - key.createdAt >= ACTIVE_CHATTER_KEY_ROTATION_MS) return Promise.resolve(0);
    const cutoff = Math.max(now - windowMs, now - ACTIVE_CHATTER_RETENTION_MS);
    this.ensureActiveChatterTable();
    const result = this.ctx.storage.sql.exec<{ count: number }>(
      `SELECT COUNT(*) AS count FROM ${ACTIVE_CHATTER_TABLE} WHERE last_seen_at >= ?`,
      new Date(cutoff).toISOString(),
    ).one();
    return Promise.resolve(result.count);
  }

  public async getActiveChatter(userId: string): Promise<ActiveChatterActivity | null> {
    if (userId.length === 0) return null;
    this.ensureActiveChatterTable();
    const key = this.activeChatterKeyRowSync();
    if (key === null || Date.now() - key.createdAt >= ACTIVE_CHATTER_KEY_ROTATION_MS) return null;
    const hmac = await activeChatterKey(key.keyHex, this.ownChannelId() ?? "", userId);
    const activity = this.ctx.storage.sql.exec<{ first_seen_at: string; last_seen_at: string }>(
      `SELECT first_seen_at, last_seen_at FROM ${ACTIVE_CHATTER_TABLE}
       WHERE hmac = ? AND last_seen_at >= ?`,
      hmac,
      new Date(Date.now() - ACTIVE_CHATTER_RETENTION_MS).toISOString(),
    ).toArray()[0];
    return activity === undefined
      ? null
      : { firstSeenAt: activity.first_seen_at, lastSeenAt: activity.last_seen_at };
  }

  private async expireActiveChatters(_deadline: number, now: number): Promise<void> {
    await this.ctx.blockConcurrencyWhile(() => {
      this.ctx.storage.transactionSync(() => {
        this.ensureActiveChatterTable();
        this.ctx.storage.sql.exec(
          `DELETE FROM ${ACTIVE_CHATTER_TABLE} WHERE last_seen_at <= ?`,
          new Date(now - ACTIVE_CHATTER_RETENTION_MS).toISOString(),
        );
        const key = this.activeChatterKeyRowSync();
        if (key !== null && now - key.createdAt >= ACTIVE_CHATTER_KEY_ROTATION_MS) {
          this.clearActiveChatterStateSync();
          return;
        }
        const nextSweep = key === null ? null : this.activeChatterNextSweepSync(key.createdAt);
        if (nextSweep === null) this.clearActiveChatterStateSync();
        else this.writeActiveChatterExpiryEntrySync(nextSweep);
      });
      return Promise.resolve();
    });
  }

  public async claimAutomatedChatOutput(): Promise<boolean> {
    return claimAutomatedChatOutput(this.ctx.storage, Date.now());
  }

  public async isRecentBotChatMessage(senderId: string | null, text: string): Promise<boolean> {
    return isRecentBotChatMessage(this.ctx.storage, senderId, text, Date.now());
  }

  public async recordBotChatMessage(senderId: string, text: string): Promise<void> {
    await recordRecentBotChatMessage(this.ctx.storage, senderId, text, Date.now());
  }

  public async getChatActivityCount(): Promise<number> {
    const current = await this.ctx.storage.get<number>(CHAT_ACTIVITY_COUNT_KEY);
    return typeof current === "number" && Number.isSafeInteger(current) && current >= 0 ? current : 0;
  }

  /** Runs one registered module alarm from an authorized host request. */
  public async runModuleAlarm(
    moduleId: string,
    handlerKey: string,
    alarmKey: string,
    invocation?: unknown,
  ): Promise<unknown> {
    const module = MODULES.find((candidate) => candidate.id === moduleId);
    const registration = module?.alarms?.find((candidate) => candidate.key === handlerKey);
    if (registration === undefined || alarmKey.length === 0 || alarmKey.length > 256) {
      throw new Error("Module alarm is unavailable.");
    }
    const execute = () => registration.handle(
      this.moduleAlarmContext(moduleId, registration, createModuleExternalFetchBudget()),
      alarmKey,
      Date.now(),
      undefined,
      invocation,
    );
    return await withCommittedPanelResourceDrain(
      () => this.runModuleAlarmHandler(moduleId, handlerKey, execute),
      () => this.notifyCommittedPanelResources(),
    );
  }

  private ballotAccess(moduleId: string): ModuleBallotAccess {
    return {
      open: (ballotId, optionCount, expiresAt, rule, termFilter) => this.openBallot(moduleId, ballotId, optionCount, expiresAt, rule, termFilter),
      cast: (ballotId, userId, choice, options) => this.castBallot(moduleId, ballotId, userId, choice, options),
      castTerm: (ballotId, userId, term, matchText) => this.castBallotTerm(moduleId, ballotId, userId, term, matchText),
      setBlockedTerms: (ballotId, terms) => setStoredBallotBlockedTerms(this.ballotStorage(moduleId), moduleId, ballotId, terms),
      approveTerm: (ballotId, term) => approveStoredBallotTerm(this.ballotStorage(moduleId), moduleId, ballotId, term),
      read: (ballotId) => this.readBallot(moduleId, ballotId),
      close: (ballotId) => this.closeBallot(moduleId, ballotId),
      finalize: (ballotId) => this.finalizeBallot(moduleId, ballotId),
      acknowledgeClosed: (ballotId) => this.acknowledgeClosedBallot(moduleId, ballotId),
    };
  }

  /** Opens a channel-wide exclusive ballot for a host-supplied module id. */
  public async openBallot(
    moduleId: string,
    ballotId: string,
    optionCount: number,
    expiresAt: number,
    passRule?: BallotFinalizeRule,
    termFilter?: BallotTermFilter,
  ): Promise<BallotOpenResult> {
    const channelId = this.ownChannelId();
    if (channelId === null) throw new Error("Ballots require a named Durable Object.");
    const requestedAlarmKey = ballotExpiryAlarmKey(moduleId, ballotId);
    const result = await openStoredBallot(
      this.ballotStorage(moduleId),
      moduleId,
      ballotId,
      optionCount,
      expiresAt,
      passRule,
      async (transaction) => {
        await this.writeBallotAlarmInTransaction(
          transaction, requestedAlarmKey, BALLOT_EXPIRY_ALARM_HANDLER, expiresAt,
        );
      },
      async (transaction, finalizedModuleId, finalizedBallotId, hardDeleteAt) => {
        await this.writeBallotAlarmInTransaction(
          transaction,
          ballotExpiryAlarmKey(finalizedModuleId, finalizedBallotId),
          BALLOT_HARD_DELETE_ALARM_HANDLER,
          hardDeleteAt,
        );
      },
      termFilter,
    );
    if (result.status === "opened" || result.activeBallot !== undefined) {
      await this.notifyCommittedPanelResources();
    }
    if (result.status === "opened") {
      return { status: "opened" };
    }
    return { status: "busy", moduleId: result.moduleId };
  }

  public async castBallot(
    moduleId: string,
    ballotId: string,
    userId: string,
    choice: number,
    options?: { onlyIfNew?: boolean },
  ): Promise<BallotCastResult> {
    const channelId = this.ownChannelId();
    if (channelId === null) return { status: "not_open", counts: [], revision: 0 };
    const result = await castStoredBallot(this.ballotStorage(moduleId), channelId, moduleId, ballotId, userId, choice, options);
    if (result.status === "counted" || result.status === "changed") {
      await this.notifyCommittedPanelResources();
    }
    return result;
  }

  public async castBallotTerm(
    moduleId: string,
    ballotId: string,
    userId: string,
    term: string,
    matchText?: string,
  ): Promise<BallotCastResult> {
    const channelId = this.ownChannelId();
    if (channelId === null) return { status: "not_open", counts: [], revision: 0 };
    const result = await castStoredBallotTerm(this.ballotStorage(moduleId), channelId, moduleId, ballotId, userId, term, matchText);
    if (result.status === "counted" || result.status === "changed" || result.status === "overflow") {
      await this.notifyCommittedPanelResources();
    }
    return result;
  }

  public async setBlockedTerms(
    moduleId: string,
    ballotId: string,
    blockedTerms: readonly string[],
  ): Promise<BallotSnapshot | null> {
    const snapshot = await setStoredBallotBlockedTerms(this.ballotStorage(moduleId), moduleId, ballotId, blockedTerms);
    if (snapshot !== null) await this.notifyCommittedPanelResources();
    return snapshot;
  }

  public async approveTerm(
    moduleId: string,
    ballotId: string,
    term: string,
  ): ReturnType<typeof approveStoredBallotTerm> {
    const channelId = this.ownChannelId();
    if (channelId === null || moduleId !== CHAT_VOTING_MODULE_ID) {
      return { status: "not_open", snapshot: null };
    }
    const approval = await this.env.DB.prepare(
      `SELECT 1 AS approved
         FROM chat_vote_term_approvals
        WHERE channel_id = ? AND poll_id = ? AND term = ?`,
    ).bind(channelId, ballotId, term).first<{ approved: number }>();
    if (approval === null) return { status: "not_open", snapshot: null };
    const result = await approveStoredBallotTerm(this.ballotStorage(moduleId), moduleId, ballotId, term);
    if (result.status === "approved" && result.snapshot !== null) {
      await this.notifyCommittedPanelResources();
    }
    return result;
  }

  public async readBallot(moduleId: string, ballotId: string): Promise<BallotSnapshot | null> {
    const snapshot = await readStoredBallot(this.ballotStorage(moduleId), moduleId, ballotId, async (transaction, finalizedModuleId, finalizedBallotId, hardDeleteAt) => {
      await this.writeBallotAlarmInTransaction(
        transaction,
        ballotExpiryAlarmKey(finalizedModuleId, finalizedBallotId),
        BALLOT_HARD_DELETE_ALARM_HANDLER,
        hardDeleteAt,
      );
    });
    if (snapshot?.outcome !== undefined) {
      await this.notifyCommittedPanelResources();
    }
    return snapshot;
  }

  public async readBallotSnapshot(moduleId: string, ballotId: string): Promise<BallotSnapshot | null> {
    return await readStoredBallotSnapshot(this.ballotStorage(moduleId), moduleId, ballotId);
  }

  public async hasOpenBallot(): Promise<boolean> {
    const hasOpen = await hasOpenStoredBallot(this.ballotStorage(CHAT_VOTING_MODULE_ID), async (transaction, moduleId, ballotId, hardDeleteAt) => {
      await this.writeBallotAlarmInTransaction(
        transaction,
        ballotExpiryAlarmKey(moduleId, ballotId),
        BALLOT_HARD_DELETE_ALARM_HANDLER,
        hardDeleteAt,
      );
    });
    if (!hasOpen) await this.notifyCommittedPanelResources();
    return hasOpen;
  }

  public async hasOpenBallotSnapshot(): Promise<boolean> {
    return await hasOpenStoredBallotSnapshot(this.ballotStorage(CHAT_VOTING_MODULE_ID));
  }

  public async closeBallot(moduleId: string, ballotId: string): Promise<BallotSnapshot | null> {
    const result = await closeStoredBallot(this.ballotStorage(moduleId), moduleId, ballotId);
    if (result !== null) await this.notifyCommittedPanelResources();
    await this.clearAlarmEntry(ballotExpiryAlarmKey(moduleId, ballotId));
    return result;
  }

  public async finalizeBallot(moduleId: string, ballotId: string): Promise<BallotFinalizeResult> {
    const result = await finalizeStoredBallot(this.ballotStorage(moduleId), moduleId, ballotId, async (transaction, finalizedModuleId, finalizedBallotId, hardDeleteAt) => {
      await this.writeBallotAlarmInTransaction(
        transaction,
        ballotExpiryAlarmKey(finalizedModuleId, finalizedBallotId),
        BALLOT_HARD_DELETE_ALARM_HANDLER,
        hardDeleteAt,
      );
    });
    if (result.outcome !== "not_open" && result.outcome !== "open") {
      await this.notifyCommittedPanelResources();
    }
    return result;
  }

  public async acknowledgeClosedBallot(moduleId: string, ballotId: string): Promise<void> {
    await forgetClosedStoredBallot(this.ctx.storage, moduleId, ballotId);
  }

  private async expireBallot(key: string): Promise<void> {
    const identity = ballotIdentityFromExpiryAlarmKey(key);
    if (identity === null) return;
    const nextExpiry = await expireStoredBallot(
      this.ballotStorage(identity.moduleId),
      identity.moduleId,
      identity.ballotId,
      async (transaction, moduleId, ballotId, hardDeleteAt) => {
        await this.writeBallotAlarmInTransaction(
          transaction, ballotExpiryAlarmKey(moduleId, ballotId), BALLOT_HARD_DELETE_ALARM_HANDLER, hardDeleteAt,
        );
      },
    );
    if (nextExpiry === null) await this.notifyCommittedPanelResources();
    if (nextExpiry !== null) {
      await this.scheduleAlarmEntry(key, BALLOT_EXPIRY_ALARM_HANDLER, nextExpiry);
    }
  }

  private async hardDeleteBallot(key: string): Promise<void> {
    const identity = ballotIdentityFromExpiryAlarmKey(key);
    if (identity === null) return;
    const retryAt = await hardDeleteFinalizedStoredBallot(this.ballotStorage(identity.moduleId), identity.moduleId, identity.ballotId);
    if (retryAt !== null) await this.scheduleAlarmEntry(key, BALLOT_HARD_DELETE_ALARM_HANDLER, retryAt);
  }

  private ballotPanelResources(moduleId: string): string[] {
    return [...new Set([`module:${moduleId}:panel`, "module:chat_voting:panel"])];
  }

  /** Wraps ballot storage transactions so the vector commits with ballot state. */
  private ballotStorage(moduleId: string): Pick<DurableObjectStorage, "get" | "list" | "put" | "delete" | "transaction"> {
    const storage = this.ctx.storage;
    const transaction = <Value>(
      operation: (transaction: DurableObjectTransaction) => Promise<Value>,
    ): Promise<Value> => storage.transaction(async (underlying) => {
      const changedResources = new Set<string>();
      const recordWrite = (keyArgument: unknown): void => {
        const keys = typeof keyArgument === "string" ? [keyArgument]
          : Array.isArray(keyArgument) ? keyArgument.filter((key): key is string => typeof key === "string")
            : typeof keyArgument === "object" && keyArgument !== null ? Object.keys(keyArgument) : [];
        for (const key of keys) {
          if (key === "ballot:active") {
            this.ballotPanelResources(moduleId).forEach((resource) => changedResources.add(resource));
            continue;
          }
          const match = /^ballot:(?:closed:)?([A-Za-z0-9_-]{1,128}):/u.exec(key);
          if (match?.[1] !== undefined) this.ballotPanelResources(match[1]).forEach((resource) => changedResources.add(resource));
        }
      };
      const monitored = new Proxy(underlying, {
        get: (target, property, receiver) => {
          if (property === "put" || property === "delete") {
            const method = Reflect.get(target, property, target) as (...args: unknown[]) => unknown;
            return (...args: unknown[]): unknown => {
              recordWrite(args[0]);
              return Reflect.apply(method, target, args);
            };
          }
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) as unknown : value;
        },
      });
      const result = await operation(monitored);
      if (changedResources.size > 0) await bumpDurablePanelResources(underlying, [...changedResources]);
      return result;
    });
    return {
      get: storage.get.bind(storage),
      list: storage.list.bind(storage),
      put: storage.put.bind(storage),
      delete: storage.delete.bind(storage),
      transaction,
    };
  }

  private async notifyCommittedPanelResources(): Promise<void> {
    const channelId = this.ownChannelId();
    if (channelId === null) return;
    await notifyCommittedResources(this.env, channelId, (revisions) => this.reconcilePanelResources(revisions));
  }

  public async getPanelResourceRevisions(): Promise<PanelResourceRevisionVector> {
    return await this.ctx.storage.get<PanelResourceRevisionVector>(PANEL_DURABLE_REVISIONS_KEY) ?? {};
  }

  /** Delivers only advanced, data-free resources to panel principals in this channel. */
  public async reconcilePanelResources(revisions: PanelResourceRevisionVector): Promise<void> {
    const channelId = this.ownChannelId();
    if (channelId === null) return;
    const durableRevisions = await this.getPanelResourceRevisions();
    const combinedRevisions = { ...revisions };
    for (const [resource, revision] of Object.entries(durableRevisions)) {
      combinedRevisions[resource] = (combinedRevisions[resource] ?? 0) + revision;
    }
    const channelRevisionTotal = Object.entries(combinedRevisions)
      .filter(([resource]) => resource !== "channel.all")
      .reduce((sum, [, revision]) => Math.min(Number.MAX_SAFE_INTEGER, sum + revision), 0);
    const previous = await this.ctx.storage.get<PanelResourceRevisionVector>(PANEL_PUBLISHED_REVISIONS_KEY) ?? {};
    const advanced = Object.entries(combinedRevisions)
      .filter(([resource, revision]) => revision > (previous[resource] ?? 0))
      .sort(([left], [right]) => left.localeCompare(right));
    if (advanced.length === 0) return;
    const next = Object.fromEntries(advanced);
    const overflow = advanced.length > 128;
    // Large batches carry one bounded wake-up hint; the authenticated GET
    // still returns the exact per-resource vector for client invalidation.
    const resources = overflow ? ["channel.all"] : advanced.map(([resource]) => resource);
    const messageRevisions = overflow
      ? { "channel.all": channelRevisionTotal }
      : next;
    const message = panelResourceChangedMessage(channelId, resources, messageRevisions);
    await this.publish([message]);
    await this.ctx.storage.transaction(async (transaction) => {
      const latest = await transaction.get<PanelResourceRevisionVector>(PANEL_PUBLISHED_REVISIONS_KEY) ?? {};
      const published = { ...latest };
      for (const [resource, revision] of Object.entries(combinedRevisions)) {
        published[resource] = Math.max(published[resource] ?? 0, revision);
      }
      await transaction.put(PANEL_PUBLISHED_REVISIONS_KEY, published);
    });
  }

  private async writeBallotAlarmInTransaction(
    transaction: AlarmStorageAccess & Pick<DurableObjectTransaction, "setAlarm" | "deleteAlarm">,
    key: string,
    handler: string,
    deadline: number,
  ): Promise<void> {
    const table = await readAlarmScheduleTable(transaction);
    const current = table[key];
    table[key] = { deadline, handler, revision: (current?.revision ?? 0) + 1 };
    await transaction.put(ALARM_TABLE_KEY, table);
    const nextAlarmAt = earliestAlarmAt(table, Date.now());
    if (nextAlarmAt === null) await transaction.deleteAlarm();
    else await transaction.setAlarm(nextAlarmAt);
  }

  private alarmHandlers(
    modules: readonly BotModule[] = MODULES,
    externalFetchBudget: ModuleExternalFetchBudget = createModuleExternalFetchBudget(),
  ): Map<string, AlarmHandlerRegistration> {
    const handlers = new Map<string, AlarmHandlerRegistration>([
      [ACTIVE_CHATTER_EXPIRY_HANDLER, {
        handle: async (_key, entry, now) => {
          await this.expireActiveChatters(entry.deadline, now);
        },
      }],
      [BALLOT_EXPIRY_ALARM_HANDLER, { handle: async (key) => { await this.expireBallot(key); } }],
      [BALLOT_HARD_DELETE_ALARM_HANDLER, { handle: async (key) => { await this.hardDeleteBallot(key); } }],
      [SECURITY_ROUND_HANDLER, { handle: (_key, _entry, now, nowIso) => this.runSecurityRound(now, nowIso) }],
      [SECURITY_RETRY_HANDLER, { handle: (_key, _entry, now, nowIso) => this.runSecurityRound(now, nowIso) }],
      [AD_PREWARNING_HANDLER, {
        handle: (_key, entry, _now, nowIso) => this.runAdPrewarning(entry.deadline, nowIso),
        retryDelaysMs: AD_PREWARNING_RETRY_DELAYS_MS,
      }],
      [AD_COUNTDOWN_REFRESH_HANDLER, {
        handle: async () => {
          await this.refreshCountdownScheduleFromAlarm();
          return undefined;
        },
      }],
      [MODULE_SCHEDULE_INPUTS_CHANGED_HANDLER, {
        retryDelaysMs: [5_000, 15_000, 60_000],
        handle: async (key) => {
          const reason = key.slice(`${MODULE_SCHEDULE_INPUTS_CHANGED_KEY}:`.length);
          if (reason !== "event_times" && reason !== "channel_time_zone" && reason !== "activation") return;
          for (const module of modules) {
            for (const registration of module.alarms ?? []) {
              if (registration.onScheduleInputsChanged === undefined) continue;
              await registration.onScheduleInputsChanged(this.moduleAlarmContext(module.id, registration, externalFetchBudget), reason);
            }
          }
        },
      }],
    ]);
    for (const { moduleId, registration } of moduleAlarmHandlerEntries(modules)) {
      const handler = `module:${moduleId}:${registration.key}`;
      if (handlers.has(handler)) throw new Error(`Duplicate alarm handler ${handler}.`);
      const modulePrefix = `module:${moduleId}:`;
      handlers.set(handler, {
        ...(registration.retryDelaysMs === undefined ? {} : { retryDelaysMs: registration.retryDelaysMs }),
        handle: async (key, entry) => {
          const execute = () => registration.handle(
            this.moduleAlarmContext(moduleId, registration, externalFetchBudget),
            key.startsWith(modulePrefix) ? key.slice(modulePrefix.length) : key,
            entry.deadline,
            entry.ownerRevision,
          );
          await this.runModuleAlarmHandler(moduleId, registration.key, execute);
          return undefined;
        },
      });
    }
    const scheduledHandlers = [
      ...CHANNEL_HOST_ALARM_HANDLER_KEYS,
      ...moduleAlarmHandlerEntries(modules).map(({ moduleId, registration }) =>
        `module:${moduleId}:${registration.key}`),
    ];
    const missingHandlers = missingAlarmHandlerKeys(scheduledHandlers, handlers.keys());
    if (missingHandlers.length > 0) {
      throw new Error(`Alarm handlers are not registered: ${missingHandlers.join(", ")}.`);
    }
    return handlers;
  }

  private async dispatchDueAlarmEntries(
    now: number,
    nowIso: string,
    handlers: ReadonlyMap<string, AlarmHandlerRegistration>,
  ): Promise<void> {
    const table = await this.ensureAlarmScheduleTable();
    const dueEntries = Object.entries(table)
      .filter(([, entry]) => alarmAttemptAt(entry) <= now)
      .filter(([, entry]) => !(entry.deadline <= now && entry.suppressedBy !== undefined &&
        Object.hasOwn(table, entry.suppressedBy)))
      .sort(([, left], [, right]) => alarmAttemptAt(left) - alarmAttemptAt(right));

    for (const [key, entry] of dueEntries) {
      const currentTable = await this.ensureAlarmScheduleTable();
      const currentEntry = currentTable[key];
      if (currentEntry === undefined || JSON.stringify(currentEntry) !== JSON.stringify(entry) ||
          alarmAttemptAt(currentEntry) > Date.now()) continue;
      const claimed = await this.claimAlarmEntry(key, entry);
      if (claimed === null) continue;
      const registration = handlers.get(entry.handler);
      if (registration === undefined) {
        console.error(`Alarm handler ${entry.handler} is not registered for ${key}.`);
        await this.rescheduleFailedAlarm(key, claimed, undefined);
        continue;
      }
      try {
        const result = await registration.handle(key, entry, now, nowIso);
        if (result === "retain") await this.retainAlarmEntry(key, claimed);
        else await this.completeAlarmEntry(key, claimed);
      } catch (error: unknown) {
        console.error(`Alarm handler ${entry.handler} failed for ${key}.`, error);
        await this.rescheduleFailedAlarm(key, claimed, registration.retryDelaysMs);
      }
    }
    await this.scheduleEarliestAlarm();
  }

  private async scheduleEarliestAlarm(): Promise<void> {
    const table = await this.ensureAlarmScheduleTable();
    const nextAlarmAt = earliestAlarmAt(table, Date.now());
    if (nextAlarmAt === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(nextAlarmAt);
  }

  private async scheduleSecurityAlarm(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) {
      await this.clearAlarmEntries([SECURITY_DEADLINE_KEY, SECURITY_RETRY_KEY]);
    } else {
      const deadline = await this.readAlarmDeadline(SECURITY_DEADLINE_KEY);
      if (deadline === null) {
        await this.scheduleAlarmEntry(
          SECURITY_DEADLINE_KEY,
          SECURITY_ROUND_HANDLER,
          Date.now() + SECURITY_ALARM_INTERVAL_MS,
          SECURITY_RETRY_KEY,
        );
      }
    }
    await this.scheduleEarliestAlarm();
  }

  private async stopSecurityAlarmIfIdle(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) {
      await this.clearAlarmEntries([SECURITY_DEADLINE_KEY, SECURITY_RETRY_KEY]);
    }
  }

  private async pruneRevokedTokenMarkers(now: number): Promise<void> {
    try {
      let startAfter: string | undefined;
      for (;;) {
        const markers = await this.ctx.storage.list({
          prefix: "overlay_revoked:",
          limit: 1_000,
          ...(startAfter === undefined ? {} : { startAfter }),
        });
        const lastKey = [...markers.keys()].at(-1);
        const updates: Promise<unknown>[] = [];
        for (const [key, value] of markers) {
          if (value === true) {
            // Migrate markers written by earlier code and give any old in-flight
            // handshake one final bounded window to observe them.
            updates.push(this.ctx.storage.put(key, { revokedAt: now } satisfies RevokedTokenMarker));
          } else if (!isRecord(value) || typeof value.revokedAt !== "number" ||
              !Number.isFinite(value.revokedAt) || now - value.revokedAt >= OVERLAY_REVOKED_MARKER_TTL_MS) {
            updates.push(this.ctx.storage.delete(key));
          }
        }
        await Promise.all(updates);
        if (markers.size < 1_000 || lastKey === undefined) break;
        startAfter = lastKey;
      }
    } catch (error: unknown) {
      // Marker retention is opportunistic. D1 remains the authorization
      // source of truth for new handshakes and periodic socket checks.
      console.error("Realtime overlay revocation markers could not be pruned.", error);
    }
  }

  private async getOverlayToken(tokenId: string, channelId: string, nowIso: string): Promise<TokenValidityRow | null> {
    return await this.env.DB.prepare(
      `SELECT token_id, overlay_id
         FROM overlay_tokens
        WHERE channel_id = ?
          AND token_id = ?
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)`,
    ).bind(channelId, tokenId, nowIso).first<TokenValidityRow>();
  }

  private async panelPrincipalIsCurrent(
    principal: Extract<RealtimePrincipal, { kind: "panel" }>,
    channelId: string,
    now: number,
  ): Promise<boolean> {
    if (isExpired(principal, now)) return false;
    const row = await this.env.DB.prepare(
      `SELECT session.session_id, session.user_id, member.role
         FROM auth_sessions AS session
         JOIN twitch_login_identity AS identity ON identity.user_id = session.user_id
         JOIN channel_members AS member
           ON member.channel_id = ? AND member.user_id = session.user_id
        WHERE session.session_id = ?
          AND session.user_id = ?
          AND member.role = ?
          AND session.revoked_at IS NULL
          AND session.expires_at > ?
          AND identity.status <> 'revoked'`,
    ).bind(channelId, principal.sessionId, principal.userId, principal.role, new Date(now).toISOString())
      .first<SessionValidityRow>();
    return row?.session_id === principal.sessionId && row.user_id === principal.userId && row.role === principal.role;
  }

  private async allowOverlayHandshake(tokenId: string, now: number): Promise<boolean> {
    const key = `overlay_handshakes:${tokenId}`;
    return this.ctx.storage.transaction(async (transaction) => {
      const previous = await transaction.get<OverlayHandshakeWindow>(key);
      if (previous === undefined || !Number.isFinite(previous.startedAt) ||
          !Number.isFinite(previous.count) || previous.count < 0 ||
          now - previous.startedAt >= OVERLAY_HANDSHAKE_WINDOW_MS || now < previous.startedAt) {
        await transaction.put(key, { startedAt: now, count: 1 } satisfies OverlayHandshakeWindow);
        return true;
      }
      if (previous.count >= MAX_OVERLAY_HANDSHAKES_PER_TOKEN) return false;
      await transaction.put(key, { ...previous, count: previous.count + 1 });
      return true;
    });
  }

  private hasConnectionCapacity(principal: RealtimePrincipal): boolean {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_CHANNEL_SOCKETS) return false;
    if (principal.kind === "panel") {
      return this.ctx.getWebSockets(`user:${principal.userId}`).length < MAX_PANEL_SOCKETS_PER_USER;
    }
    return this.ctx.getWebSockets("kind:overlay").length < MAX_OVERLAY_SOCKETS_PER_CHANNEL &&
      this.ctx.getWebSockets(`token:${principal.tokenId}`).length < MAX_OVERLAY_SOCKETS_PER_TOKEN;
  }

  public async scheduleAdPrewarning(dueAtMs: number): Promise<void> {
    if (!Number.isFinite(dueAtMs)) {
      await this.clearAdPrewarning();
      return;
    }
    await this.scheduleAlarmEntry(AD_PREWARNING_DEADLINE_KEY, AD_PREWARNING_HANDLER, dueAtMs);
  }

  public async clearAdPrewarning(): Promise<void> {
    await this.clearAlarmEntry(AD_PREWARNING_DEADLINE_KEY);
    // The send claim for the occurrence just cleared is kept, not deleted: a
    // re-arm for that same due-at ms (e.g. an unrelated schedule refresh
    // clearing and re-setting the same alarm) must still see it as already
    // sent. Only pruning happens here, to keep the claim map bounded.
    const stored = await this.ctx.storage.get<Record<string, number> | number>(AD_PREWARNING_SEND_CLAIM_KEY);
    if (stored === undefined) return;
    const claims = typeof stored === "number" ? { [String(stored)]: stored } : stored;
    const pruned = prunePrewarningClaims(claims, Date.now());
    if (Object.keys(pruned).length === 0) await this.ctx.storage.delete(AD_PREWARNING_SEND_CLAIM_KEY);
    else await this.ctx.storage.put(AD_PREWARNING_SEND_CLAIM_KEY, pruned);
  }

  /** Schedule one module-owned alarm key through its registered handler. */
  public async scheduleModuleAlarm(
    moduleId: string,
    handlerKey: string,
    alarmKey: string,
    deadline: number,
    ownerRevision?: number,
  ): Promise<void> {
    const registration = MODULES.find((module) => module.id === moduleId)?.alarms?.find((alarm) => alarm.key === handlerKey);
    if (registration === undefined || alarmKey.length === 0) {
      throw new Error(`Unknown module alarm ${moduleId}.${handlerKey}.`);
    }
    await this.scheduleAlarmEntry(
      `module:${moduleId}:${alarmKey}`,
      `module:${moduleId}:${registration.key}`,
      deadline,
      undefined,
      ownerRevision,
    );
  }

  /** Returns the current retry/execution time for one module alarm, if scheduled. */
  public async getModuleAlarmDeadline(moduleId: string, alarmKey: string): Promise<number | null> {
    if (!MODULES.some((module) => module.id === moduleId) || alarmKey.length === 0) return null;
    const stored = await this.ctx.storage.get(ALARM_TABLE_KEY);
    if (!isRecord(stored)) return null;
    const entry = stored[`module:${moduleId}:${alarmKey}`];
    if (!validAlarmScheduleEntry(entry)) return null;
    return entry.claimUntil === undefined ? entry.nextAttemptAt ?? entry.deadline : entry.deadline;
  }

  /** Clear one module-owned alarm key without disturbing other module deadlines. */
  public async clearModuleAlarm(moduleId: string, alarmKey: string, ownerRevision?: number): Promise<void> {
    if (!MODULES.some((module) => module.id === moduleId) || alarmKey.length === 0) {
      throw new Error(`Unknown module alarm key ${moduleId}.${alarmKey}.`);
    }
    await this.clearAlarmEntry(`module:${moduleId}:${alarmKey}`, ownerRevision);
  }

  /** Queues a generic replan after a host or module changes schedule inputs. */
  public async notifyScheduleInputsChanged(reason: ModuleScheduleInputChangeReason): Promise<void> {
    await this.scheduleAlarmEntry(
      `${MODULE_SCHEDULE_INPUTS_CHANGED_KEY}:${reason}`,
      MODULE_SCHEDULE_INPUTS_CHANGED_HANDLER,
      Date.now(),
    );
  }

  override async fetch(request: Request): Promise<Response> {
    const rawPrincipal = request.headers.get(REALTIME_PRINCIPAL_HEADER);
    let principal: RealtimePrincipal | null = null;
    if (rawPrincipal !== null) {
      try {
        const parsed: unknown = JSON.parse(rawPrincipal);
        principal = isRealtimePrincipal(parsed) ? parsed : null;
      } catch {
        principal = null;
      }
    }

    const ownChannelId = this.ownChannelId();
    if (principal === null || ownChannelId === null || principal.channelId !== ownChannelId) {
      return new Response("Channel access denied.", { status: 403 });
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required.", { status: 426 });
    }
    if (request.headers.get("Sec-WebSocket-Protocol") !== REALTIME_PROTOCOL) {
      return new Response("Realtime protocol is not supported.", { status: 426 });
    }

    if (principal.kind === "overlay") {
      let withinHandshakeLimit: boolean;
      try {
        withinHandshakeLimit = await this.allowOverlayHandshake(principal.tokenId, Date.now());
      } catch (error: unknown) {
        console.error("Realtime overlay handshake limit could not be checked.", error);
        return new Response(null, { status: 503, headers: { "Retry-After": "1" } });
      }
      if (!withinHandshakeLimit) {
        return new Response(null, { status: 429, headers: { "Retry-After": "60" } });
      }
    }

    // This check follows any awaited rate-limit operation, so the subsequent
    // accept is synchronous and another handshake observes the new socket.
    if (!this.hasConnectionCapacity(principal)) {
      return new Response(null, { status: 503, headers: { "Retry-After": "1" } });
    }

    const pair = new WebSocketPair();
    let overlayTokenAtHandshake: TokenValidityRow | null | undefined;
    if (principal.kind === "overlay") {
      try {
        // D1 protects handshakes whose in-memory revocation marker has aged
        // out. The marker is re-read at the final accept boundary below, so
        // it also catches a revoke that lands while this query is in flight.
        // The same lookup reads the binding so a stale route principal cannot
        // keep a legacy socket after an import binds its token.
        overlayTokenAtHandshake = await this.getOverlayToken(
          principal.tokenId,
          ownChannelId,
          new Date().toISOString(),
        );
        if (overlayTokenAtHandshake === null) {
          return new Response("Overlay token revoked.", { status: 403 });
        }
      } catch (error: unknown) {
        console.error("Realtime overlay revocation could not be checked.", error);
        return new Response(null, { status: 503, headers: { "Retry-After": "1" } });
      }
    }
    if (principal.kind === "overlay") {
      try {
        // Re-read the durable marker immediately before acceptance and reuse
        // the D1 authorization result from this handshake.
        const marker: unknown = await this.ctx.storage.get(revokedTokenKey(principal.tokenId));
        if (overlayTokenAtHandshake === null || overlayTokenAtHandshake === undefined || isExpired(principal, Date.now()) ||
            hasActiveRevocationMarker(marker, Date.now())) {
          return new Response("Overlay token revoked.", { status: 403 });
        }
      } catch (error: unknown) {
        console.error("Realtime overlay revocation could not be rechecked.", error);
        return new Response(null, { status: 503, headers: { "Retry-After": "1" } });
      }
    }
    if (principal.kind === "overlay" && principal.overlayId === null &&
        this.recentlyBoundOverlayTokenIds.has(principal.tokenId)) {
      closeSocket(pair[1], OVERLAY_ACCESS_BOUND_CLOSE_CODE, OVERLAY_ACCESS_BOUND_CLOSE_REASON);
      return new Response("Overlay token is now bound.", { status: 403 });
    }
    if (principal.kind === "panel") {
      try {
        // Outer route authorization may have gone stale while the request was
        // queued for this object. This D1 check is the final await before the
        // synchronous accept, so revocation prevents even the hello message.
        if (!await this.panelPrincipalIsCurrent(principal, ownChannelId, Date.now())) {
          return new Response("Panel authorization revoked.", { status: 403 });
        }
      } catch (error: unknown) {
        console.error("Realtime panel handshake authorization could not be checked.", error);
        return new Response(null, { status: 503, headers: { "Retry-After": "1" } });
      }
    }
    // Authorization above awaits D1 and lets concurrent handshakes interleave.
    // Reserve capacity again at the synchronous acceptance boundary.
    if (!this.hasConnectionCapacity(principal)) {
      return new Response(null, { status: 503, headers: { "Retry-After": "1" } });
    }
    this.ctx.acceptWebSocket(pair[1], tagsFor(principal));
    pair[1].serializeAttachment(principal);
    await this.scheduleSecurityAlarm();
    const overlayBindingChanged = principal.kind === "overlay" &&
      overlayTokenAtHandshake?.overlay_id !== principal.overlayId;
    if (overlayBindingChanged) {
      closeSocket(pair[1], OVERLAY_ACCESS_BOUND_CLOSE_CODE, OVERLAY_ACCESS_BOUND_CLOSE_REASON);
    } else {
      pair[1].send(JSON.stringify(envelopeFor(ownChannelId, "system.hello")));
      if (principal.kind === "panel") {
        try {
          const revisions = await readPanelResourceRevisions(this.env.DB, ownChannelId);
          await this.reconcilePanelResources(revisions);
        } catch (error: unknown) {
          console.warn("Panel resource revision snapshot could not be sent.", error);
        }
      }
    }
    return new Response(null, {
      status: 101,
      headers: { "Sec-WebSocket-Protocol": REALTIME_PROTOCOL },
      webSocket: pair[0],
    });
  }

  /** Distributes only within its own channel and only to principals of the requested kind. */
  public async publish(
    messages: readonly RealtimeMessage[],
  ): Promise<void> {
    if (messages.length === 0) return Promise.resolve();
    const ownChannelId = this.ownChannelId();
    if (ownChannelId === null || messages.some((message) => message.channelId !== ownChannelId)) {
      throw new Error("Realtime message belongs to a foreign channel.");
    }
    const now = Date.now();
    const ordinarySockets = messages.some((message) => message.type !== "overlay.changed" &&
      message.type !== "panel.resources.changed" &&
      !isModuleOverlayRealtimeEnvelope(message))
      ? this.ctx.getWebSockets()
      : [];
    const overlaySocketsById = new Map<string, WebSocket[]>();
    const targetedOverlayIds = new Set(messages.flatMap((message) =>
      message.type === "overlay.changed" ? [message.payload.overlayId]
        : isModuleOverlayRealtimeEnvelope(message) ? [...(message.overlayIds ?? [])] : []));
    for (const overlayId of targetedOverlayIds) {
      overlaySocketsById.set(overlayId, this.ctx.getWebSockets(`overlay:${overlayId}`));
    }
    const serialized = messages.map((envelope) => ({
      envelope,
      payload: JSON.stringify(isModuleOverlayRealtimeEnvelope(envelope)
        ? {
          version: envelope.version,
          id: envelope.id,
          createdAt: envelope.createdAt,
          channelId: envelope.channelId,
          type: envelope.type,
          payload: envelope.payload,
        }
        : envelope.type === "variables.changed"
          ? { ...envelope, payload: { set: envelope.payload.set, removed: envelope.payload.removed } }
          : envelope),
      sockets: envelope.type === "overlay.changed"
        ? [
          ...this.ctx.getWebSockets("kind:panel"),
          ...(overlaySocketsById.get(envelope.payload.overlayId) ?? []),
        ]
        : envelope.type === "panel.resources.changed"
          ? this.ctx.getWebSockets("kind:panel")
        : isModuleOverlayRealtimeEnvelope(envelope)
          ? [...new Set((envelope.overlayIds ?? []).flatMap((overlayId) => overlaySocketsById.get(overlayId) ?? []))]
          : ordinarySockets,
    }));
    const panelRecipients = [...new Set(serialized.flatMap(({ sockets }) => sockets)
      .filter((webSocket) => readAttachment(webSocket)?.kind === "panel"))];
    const authorizedPanels = new Set<WebSocket>();
    const unavailablePanels = new Set<WebSocket>();
    const panelSessions = new Map<string, WebSocket[]>();
    for (const webSocket of panelRecipients) {
      const principal = readAttachment(webSocket);
      if (principal?.kind !== "panel") continue;
      const sockets = panelSessions.get(principal.sessionId) ?? [];
      sockets.push(webSocket);
      panelSessions.set(principal.sessionId, sockets);
    }
    for (const sessionIds of chunksOf([...panelSessions.keys()], D1_IDS_PER_QUERY)) {
      const placeholders = sessionIds.map(() => "?").join(", ");
      try {
        const result = await this.env.DB.prepare(
          `SELECT session.session_id, session.user_id, member.role
             FROM auth_sessions AS session
             JOIN twitch_login_identity AS identity ON identity.user_id = session.user_id
             JOIN channel_members AS member
               ON member.channel_id = ? AND member.user_id = session.user_id
            WHERE session.session_id IN (${placeholders})
              AND session.revoked_at IS NULL
              AND session.expires_at > ?
              AND identity.status <> 'revoked'`,
        ).bind(ownChannelId, ...sessionIds, new Date(now).toISOString()).all<SessionValidityRow>();
        const validSessions = new Set(result.results.map((row) =>
          `${row.session_id}:${row.user_id}:${String(row.role)}`));
        for (const sessionId of sessionIds) {
          for (const webSocket of panelSessions.get(sessionId) ?? []) {
            const principal = readAttachment(webSocket);
            if (principal?.kind === "panel" && validSessions.has(
              `${principal.sessionId}:${principal.userId}:${principal.role}`,
            )) authorizedPanels.add(webSocket);
          }
        }
      } catch (error: unknown) {
        console.error("Realtime panel authorization check failed.", error);
        for (const sessionId of sessionIds) {
          for (const webSocket of panelSessions.get(sessionId) ?? []) {
            unavailablePanels.add(webSocket);
            closeSocket(webSocket, SOCKET_TRANSIENT_CODE, "authorization check unavailable");
          }
        }
      }
    }
    for (const message of serialized) {
      const envelope = message.envelope;
      for (const webSocket of message.sockets) {
        const principal = readAttachment(webSocket);
        if (principal === null || principal.channelId !== ownChannelId) {
          closeSocket(webSocket, SOCKET_REVOKED_CODE, "invalid principal");
          continue;
        }
        if (isExpired(principal, now)) {
          closeSocket(webSocket, SOCKET_EXPIRED_CODE, "authorization expired");
          continue;
        }
        if (principal.kind === "panel" && unavailablePanels.has(webSocket)) continue;
        if (principal.kind === "panel" && !authorizedPanels.has(webSocket)) {
          closeSocket(webSocket, SOCKET_REVOKED_CODE, "authorization revoked");
          continue;
        }
        if (envelope.type === "variables.changed" && principal.kind === "overlay" &&
            principal.overlayId === null && this.recentlyBoundOverlayTokenIds.has(principal.tokenId)) {
          closeSocket(webSocket, OVERLAY_ACCESS_BOUND_CLOSE_CODE, OVERLAY_ACCESS_BOUND_CLOSE_REASON);
          continue;
        }
        if (envelope.type === "overlay.changed" && principal.kind === "overlay" &&
            principal.overlayId !== envelope.payload.overlayId) continue;
        let serializedPayload = message.payload;
        if (envelope.type === "variables.changed" && principal.kind === "overlay" && principal.overlayId !== null) {
          const overlayId = principal.overlayId;
          const overlayIdsByVariable = envelope.payload.overlayIdsByVariable ?? {};
          const referencesOverlay = (name: string): boolean =>
            Array.isArray(overlayIdsByVariable[name]) && overlayIdsByVariable[name].includes(overlayId);
          const set = envelope.payload.set.filter((entry) => referencesOverlay(entry.name));
          const removed = envelope.payload.removed.filter(referencesOverlay);
          if (set.length === 0 && removed.length === 0) continue;
          serializedPayload = JSON.stringify({ ...envelope, payload: { set, removed } });
        }
        try {
          const recipients: readonly RealtimeRecipientKind[] = realtimeRecipients(envelope.type);
          if (recipients.includes(principal.kind)) webSocket.send(serializedPayload);
        } catch {
          closeSocket(webSocket, SOCKET_TRANSIENT_CODE, "connection unavailable");
        }
      }
    }
    return Promise.resolve();
  }

  public async revokeSession(sessionId: string): Promise<void> {
    for (const webSocket of this.ctx.getWebSockets(`session:${sessionId}`)) {
      closeSocket(webSocket, SOCKET_REVOKED_CODE, "Session revoked");
    }
    await this.stopSecurityAlarmIfIdle();
  }

  public async revokeUser(userId: string): Promise<void> {
    for (const webSocket of this.ctx.getWebSockets(`user:${userId}`)) {
      const principal = readAttachment(webSocket);
      if (principal?.kind === "panel" && principal.userId === userId) {
        const channelId = this.ownChannelId();
        if (channelId !== null && principal.channelId === channelId) {
          try {
            if (await this.panelPrincipalIsCurrent(principal, channelId, Date.now())) continue;
          } catch (error: unknown) {
            console.error("Realtime panel revocation check failed.", error);
            throw error;
          }
        }
      }
      closeSocket(webSocket, SOCKET_REVOKED_CODE, "Channel access revoked");
    }
    await this.stopSecurityAlarmIfIdle();
  }

  public async revokeToken(tokenId: string): Promise<boolean> {
    const now = Date.now();
    await this.pruneRevokedTokenMarkers(now);
    // A short-lived marker blocks handshakes already in flight while the
    // route's D1 revocation propagates. D1 validates every accepted handshake.
    await this.ctx.storage.put(revokedTokenKey(tokenId), { revokedAt: now } satisfies RevokedTokenMarker);
    const sockets = this.ctx.getWebSockets(`token:${tokenId}`);
    await this.ctx.storage.delete(`overlay_handshakes:${tokenId}`);
    if (sockets.length > 0) {
      // Schedule the marker check before attempting close. This also covers a
      // DO call that times out after the durable revoke has been recorded.
      await this.scheduleAlarmEntry(
        SECURITY_RETRY_KEY,
        SECURITY_RETRY_HANDLER,
        Date.now() + SECURITY_RETRY_INTERVAL_MS,
      );
    }
    let closed = true;
    for (const webSocket of sockets) {
      if (!closeSocket(webSocket, SOCKET_REVOKED_CODE, "Overlay token revoked")) closed = false;
    }
    await this.stopSecurityAlarmIfIdle();
    if (!closed) await this.scheduleEarliestAlarm();
    return closed;
  }

  public async closeUnboundOverlayTokenSockets(tokenId: string): Promise<boolean> {
    const ownChannelId = this.ownChannelId();
    this.recentlyBoundOverlayTokenIds.add(tokenId);
    let closed = true;
    for (const webSocket of this.ctx.getWebSockets(`token:${tokenId}`)) {
      const principal = readAttachment(webSocket);
      if (principal?.kind !== "overlay" || principal.channelId !== ownChannelId ||
          principal.tokenId !== tokenId || principal.overlayId !== null) continue;
      if (!closeSocket(webSocket, OVERLAY_ACCESS_BOUND_CLOSE_CODE, OVERLAY_ACCESS_BOUND_CLOSE_REASON)) closed = false;
    }
    await this.stopSecurityAlarmIfIdle();
    return closed;
  }

  private async runSecurityRound(now: number, nowIso: string): Promise<AlarmHandlerResult> {
    const webSockets = this.ctx.getWebSockets();
    const expired = new Set<WebSocket>();
    const revoked = new Set<WebSocket>();
    const overlayBindingChanged = new Set<WebSocket>();
    // Sockets whose authorization batch could not be checked this round. They
    // are closed with the transient code so clients reconnect and are
    // re-authorized on handshake, instead of staying subscribed past the
    // backstop while D1 keeps failing.
    const transientAuth = new Set<WebSocket>();
    let transientFailure = false;

    const principals = webSockets.map((webSocket) => ({ webSocket, principal: readAttachment(webSocket) }));

    if (webSockets.length > 0) {
      for (const { webSocket, principal } of principals) {
        if (principal === null) revoked.add(webSocket);
        else if (isExpired(principal, now)) expired.add(webSocket);
        else if (principal.kind === "overlay") {
          try {
            if (await this.ctx.storage.get<boolean>(revokedTokenKey(principal.tokenId)) === true) {
              revoked.add(webSocket);
            }
          } catch (error: unknown) {
            console.error("Realtime overlay revocation marker could not be checked.", error);
          }
        }
      }
    }

    if (webSockets.length > 0) try {
      const ownChannelId = this.ownChannelId();
      if (ownChannelId === null) {
        for (const webSocket of webSockets) revoked.add(webSocket);
      } else {
        const panelPrincipals = principals.flatMap(({ webSocket, principal }) =>
          principal?.kind === "panel" && !expired.has(webSocket) && !revoked.has(webSocket) ? [{ webSocket, principal }] : []);
        const overlayPrincipals = principals.flatMap(({ webSocket, principal }) =>
          principal?.kind === "overlay" && !expired.has(webSocket) && !revoked.has(webSocket) ? [{ webSocket, principal }] : []);

        const sessionIds = [...new Set(panelPrincipals.map(({ principal }) => principal.sessionId))];
        for (const batch of chunksOf(sessionIds, D1_IDS_PER_QUERY)) {
          const placeholders = batch.map(() => "?").join(", ");
          try {
            const result = await this.env.DB.prepare(
              `SELECT session.session_id, session.user_id, member.role
                 FROM auth_sessions AS session
                 JOIN twitch_login_identity AS identity ON identity.user_id = session.user_id
                 LEFT JOIN channel_members AS member
                   ON member.channel_id = ? AND member.user_id = session.user_id
                WHERE session.session_id IN (${placeholders})
                  AND session.revoked_at IS NULL
                  AND session.expires_at > ?
                  AND identity.status <> 'revoked'`,
            ).bind(ownChannelId, ...batch, nowIso).all<SessionValidityRow>();
            const validSessions = new Set(result.results
              .filter((row) => row.role !== null)
              .map((row) => `${row.session_id}:${row.user_id}:${String(row.role)}`));
            for (const { webSocket, principal } of panelPrincipals) {
              if (batch.includes(principal.sessionId) &&
                  !validSessions.has(`${principal.sessionId}:${principal.userId}:${principal.role}`)) {
                revoked.add(webSocket);
              }
            }
          } catch (error: unknown) {
            transientFailure = true;
            console.error("Realtime session authorization check failed.", error);
            for (const { webSocket, principal } of panelPrincipals) {
              if (batch.includes(principal.sessionId)) transientAuth.add(webSocket);
            }
          }
        }

        const tokenIds = [...new Set(overlayPrincipals.map(({ principal }) => principal.tokenId))];
        for (const batch of chunksOf(tokenIds, D1_IDS_PER_QUERY)) {
          const placeholders = batch.map(() => "?").join(", ");
          try {
            const result = await this.env.DB.prepare(
              `SELECT token_id, overlay_id
                 FROM overlay_tokens
                WHERE channel_id = ?
                  AND token_id IN (${placeholders})
                  AND revoked_at IS NULL
                  AND (expires_at IS NULL OR expires_at > ?)`,
            ).bind(ownChannelId, ...batch, nowIso).all<TokenValidityRow>();
            const validTokens = new Map(result.results.map((row) => [row.token_id, row.overlay_id]));
            for (const { webSocket, principal } of overlayPrincipals) {
              if (!batch.includes(principal.tokenId)) continue;
              const currentOverlayId = validTokens.get(principal.tokenId);
              if (currentOverlayId === undefined) revoked.add(webSocket);
              else if (currentOverlayId !== principal.overlayId) overlayBindingChanged.add(webSocket);
            }
          } catch (error: unknown) {
            transientFailure = true;
            console.error("Realtime overlay token authorization check failed.", error);
            for (const { webSocket, principal } of overlayPrincipals) {
              if (batch.includes(principal.tokenId)) transientAuth.add(webSocket);
            }
          }
        }
      }
    } catch (error: unknown) {
      // Keep connections open when authorization cannot be checked. D1 errors
      // are transient; a separate retry alarm repeats the incomplete round.
      transientFailure = true;
      console.error("Realtime authorization round failed.", error);
    }

    let closeFailure = false;
    for (const webSocket of expired) {
      if (!closeSocket(webSocket, SOCKET_EXPIRED_CODE, "Authorization expired")) closeFailure = true;
    }
    for (const webSocket of revoked) {
      if (!closeSocket(webSocket, SOCKET_REVOKED_CODE, "Authorization revoked")) closeFailure = true;
    }
    for (const webSocket of overlayBindingChanged) {
      if (!closeSocket(webSocket, OVERLAY_ACCESS_BOUND_CLOSE_CODE, OVERLAY_ACCESS_BOUND_CLOSE_REASON)) closeFailure = true;
    }
    for (const webSocket of transientAuth) {
      if (expired.has(webSocket) || revoked.has(webSocket) || overlayBindingChanged.has(webSocket)) continue;
      if (!closeSocket(webSocket, SOCKET_TRANSIENT_CODE, "authorization check unavailable")) closeFailure = true;
    }
    if (closeFailure) transientFailure = true;

    if (this.ctx.getWebSockets().length === 0) {
      await this.clearAlarmEntries([SECURITY_DEADLINE_KEY, SECURITY_RETRY_KEY]);
      return undefined;
    } else if (transientFailure) {
      await this.scheduleAlarmEntry(
        SECURITY_RETRY_KEY,
        SECURITY_RETRY_HANDLER,
        now + SECURITY_RETRY_INTERVAL_MS,
      );
      return "retain";
    }

    await this.clearAlarmEntry(SECURITY_RETRY_KEY);
    await this.scheduleAlarmEntry(
      SECURITY_DEADLINE_KEY,
      SECURITY_ROUND_HANDLER,
      now + SECURITY_ALARM_INTERVAL_MS,
      SECURITY_RETRY_KEY,
    );
  }

  private async runAdPrewarning(deadline: number, nowIso: string): Promise<undefined> {
    const ownChannel = this.ownChannelId();
    if (ownChannel === null) return undefined;
    await processAdPrewarning(
      this.env,
      ownChannel,
      deadline,
      undefined,
      nowIso,
      fetch,
      // Own scheduler instead of a stub: a stub to this same object would
      // be a self-call from within alarm() and would never return.
      {
        schedule: async (dueAtMs) => { await this.scheduleAdPrewarning(dueAtMs); },
        clear: async () => { await this.clearAdPrewarning(); },
        readScheduleGeneration: () => this.getAdScheduleGeneration(),
        readSchedule: async () => (await this.getCachedAdSchedule())?.schedule ?? null,
        claimPrewarningSend: async (scheduledDueAtMs) => await this.ctx.storage.transaction(async (transaction) => {
          // Pre-migration deployments stored a single number here instead of
          // a per-occurrence map; fold that legacy shape in rather than
          // dropping it, so an in-flight upgrade cannot forget a real claim.
          const stored = await transaction.get<Record<string, number> | number>(AD_PREWARNING_SEND_CLAIM_KEY);
          const claims = typeof stored === "number" ? { [String(stored)]: stored } : stored ?? {};
          const key = String(scheduledDueAtMs);
          if (Object.hasOwn(claims, key)) return false;
          // Exempt from the shared automated-output limit: an ad prewarning
          // is time-critical (it must land before the ad break starts) and
          // infrequent, unlike timers/FAQ, which yield to each other on that
          // shared slot. Gating it the same way meant a timer or FAQ reply
          // that took the slot within the last 5s made this occurrence
          // "already_attempted" with no retry (see ad-prewarning.ts's
          // isRetryablePrePostFailure, which deliberately excludes it).
          const pruned = prunePrewarningClaims(claims, Date.now());
          pruned[key] = scheduledDueAtMs;
          await transaction.put(AD_PREWARNING_SEND_CLAIM_KEY, pruned);
          return true;
        }),
        recordSentChatMessage: (senderId, text) => this.recordBotChatMessage(senderId, text),
        storeSchedule: async (schedule, asOf, options) => {
          return await this.storeAdSchedule(
            schedule,
            asOf,
            undefined,
            options?.expectedGeneration,
            options?.reconcileAlarm,
          );
        },
      },
    );
    return undefined;
  }

  override async alarm(): Promise<void> {
    await withCommittedPanelResourceDrain(async () => {
      const now = Date.now();
      const nowIso = new Date(now).toISOString();
      const externalFetchBudget = createModuleExternalFetchBudget();
      await this.pruneRevokedTokenMarkers(now);
      await this.stopSecurityAlarmIfIdle();
      await this.dispatchDueAlarmEntries(now, nowIso, this.alarmHandlers(MODULES, externalFetchBudget));
    }, () => this.notifyCommittedPanelResources());
  }

  override webSocketMessage(webSocket: WebSocket, message: string | ArrayBuffer): void {
    // This socket is one-way. Closing data senders prevents authenticated
    // clients from waking the object with an unbounded stream of frames.
    void webSocket;
    void message;
    closeSocket(webSocket, SOCKET_POLICY_VIOLATION_CODE, "Realtime channel is one-way");
  }

  override webSocketClose(webSocket: WebSocket, code: number, reason: string, wasClean: boolean): void {
    void webSocket;
    void code;
    void reason;
    void wasClean;
    void this.stopSecurityAlarmIfIdle();
  }
}
