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
import { OVERLAY_STREAM_DETAILS_CACHE_TTL_MS } from "../../modules/contract";
import type { BotModule, HelixRequest, HelixRequestOptions } from "../../modules/contract";
import type { ModuleAlarmContext, ModuleAlarmDefinition, ModuleExternalFetchBudget, ModuleScheduleInputChangeReason } from "../../modules/contract";
import { MODULES } from "../../modules/registry";
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
import { sendChatMessage } from "../chat";
import { readChannelStreamState } from "../db/stream-state";
import { readDispatchChannelState } from "../db/channel-controls";
import { chatOutputSuppressionReason } from "../chat-output-gate";
import { resolveModuleEventTimes } from "../module-event-times";
import { renderScheduledTemplate } from "../scheduled-template-renderer";
import { createModuleExternalFetchBudget } from "../external-fetch-budget";
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
const CHAT_ACTIVITY_COUNT_KEY = "channel:chat_activity_count";
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
const OVERLAY_STREAM_DETAILS_CACHE_KEY = "overlay:stream_details";
const CHANNEL_GAME_ID_CACHE_KEY = "channel:game_id";
const AD_SCHEDULE_REFRESH_TIMEOUT_MS = 15_000;
const AD_COUNTDOWN_SCHEDULE_TTL_MS = 60_000;
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
const SECURITY_ROUND_HANDLER = "channel.security_round";
const SECURITY_RETRY_HANDLER = "channel.security_retry";
const AD_PREWARNING_HANDLER = "channel.ad_prewarning";
const AD_COUNTDOWN_REFRESH_HANDLER = "channel.ad_countdown_refresh";
const MODULE_SCHEDULE_INPUTS_CHANGED_HANDLER = "channel.module_schedule_inputs_changed";
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
  // ponytail: This Set is per-instance memory and is empty after hibernation, so the residual window is bounded by the security alarm. Persist token IDs in DO storage if that window needs to be shorter.
  private recentlyBoundOverlayTokenIds = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  private ownChannelId(): string | null {
    const name = this.ctx.id.name;
    return typeof name === "string" && name.length > 0 ? name : null;
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
      if (reconcileAlarm) await this.reconcileAdPrewarning(schedule, grantedScopes);
      try {
        await writeAdCountdownState(this.env.DB, channelId, countdownState, asOf);
      } catch (error: unknown) {
        console.warn("Ad countdown state snapshot could not be stored.", error);
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
      await this.publish([{
        version: 1,
        id: crypto.randomUUID(),
        createdAt: asOf,
        channelId,
        type: "ads.schedule.updated",
        payload: { schedule, asOf },
      }]);
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
    if (cached !== undefined && Number.isFinite(cached.checkedAt) && cached.checkedAt <= now &&
        now - cached.checkedAt < OVERLAY_STREAM_DETAILS_CACHE_TTL_MS) {
      return cached.gameId;
    }

    let refresh = this.channelGameIdRefresh;
    if (refresh === null) {
      refresh = (async () => {
        let gameId: string | null = null;
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
          }
        } catch {
          // Cache the miss briefly too, so an API outage cannot multiply lookups per message.
        }
        await this.ctx.storage.put(CHANNEL_GAME_ID_CACHE_KEY, { checkedAt: now, gameId } satisfies CachedChannelGameId);
        return { checkedAt: now, gameId } satisfies CachedChannelGameId;
      })();
      this.channelGameIdRefresh = refresh;
    }
    try {
      return (await refresh).gameId;
    } finally {
      if (this.channelGameIdRefresh === refresh) this.channelGameIdRefresh = null;
    }
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
    await this.ctx.storage.put(TWITCH_RETRY_AFTER_KEY, retryAfter);
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
      storage: {
        get: (key: string) => this.ctx.storage.get(`${storagePrefix}${key}`),
        put: (key: string, value: unknown) => this.ctx.storage.put(`${storagePrefix}${key}`, value),
        delete: (key: string) => this.ctx.storage.delete(`${storagePrefix}${key}`),
      },
      schedule: async (key, deadline, ownerRevision) => {
        await this.scheduleAlarmEntry(`module:${moduleId}:${key}`, handler, deadline, undefined, ownerRevision);
      },
      clear: async (key, ownerRevision) => {
        await this.clearAlarmEntry(`module:${moduleId}:${key}`, ownerRevision);
      },
      renderTemplate: async (text, now = Date.now()) => renderScheduledTemplate(this.env, channelId, text, now, externalFetchBudget),
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
    };
  }

  public async recordChatActivity(): Promise<number> {
    if ((await readChannelStreamState(this.env.DB, this.ownChannelId() ?? ""))?.state !== "online") {
      return await this.getChatActivityCount();
    }
    return await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<number>(CHAT_ACTIVITY_COUNT_KEY);
      const next = typeof current === "number" && Number.isSafeInteger(current) && current >= 0 ? current + 1 : 1;
      await transaction.put(CHAT_ACTIVITY_COUNT_KEY, next);
      return next;
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

  private alarmHandlers(
    modules: readonly BotModule[] = MODULES,
    externalFetchBudget: ModuleExternalFetchBudget = createModuleExternalFetchBudget(),
  ): Map<string, AlarmHandlerRegistration> {
    const handlers = new Map<string, AlarmHandlerRegistration>([
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
    for (const module of modules) {
      for (const registration of module.alarms ?? []) {
        const handler = `module:${module.id}:${registration.key}`;
        if (handlers.has(handler)) throw new Error(`Duplicate alarm handler ${handler}.`);
        const modulePrefix = `module:${module.id}:`;
        handlers.set(handler, {
          ...(registration.retryDelaysMs === undefined ? {} : { retryDelaysMs: registration.retryDelaysMs }),
          handle: async (key, entry) => {
            await registration.handle(
              this.moduleAlarmContext(module.id, registration, externalFetchBudget),
              key.startsWith(modulePrefix) ? key.slice(modulePrefix.length) : key,
              entry.deadline,
              entry.ownerRevision,
            );
          },
        });
      }
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
    const now = Date.now();
    const deadlines = Object.entries(table)
      .filter(([, entry]) => Number.isFinite(alarmAttemptAt(entry)))
      .filter(([, entry]) => !(entry.deadline <= now && entry.suppressedBy !== undefined &&
        Object.hasOwn(table, entry.suppressedBy)))
      .map(([, entry]) => alarmAttemptAt(entry));
    if (deadlines.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...deadlines));
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
    this.ctx.acceptWebSocket(pair[1], tagsFor(principal));
    pair[1].serializeAttachment(principal);
    await this.scheduleSecurityAlarm();
    const overlayBindingChanged = principal.kind === "overlay" &&
      overlayTokenAtHandshake?.overlay_id !== principal.overlayId;
    if (overlayBindingChanged) {
      closeSocket(pair[1], OVERLAY_ACCESS_BOUND_CLOSE_CODE, OVERLAY_ACCESS_BOUND_CLOSE_REASON);
    } else {
      pair[1].send(JSON.stringify(envelopeFor(ownChannelId, "system.hello")));
    }
    return new Response(null, {
      status: 101,
      headers: { "Sec-WebSocket-Protocol": REALTIME_PROTOCOL },
      webSocket: pair[0],
    });
  }

  /** Distributes only within its own channel and only to principals of the requested kind. */
  public publish(
    messages: readonly RealtimeMessage[],
  ): Promise<void> {
    if (messages.length === 0) return Promise.resolve();
    const ownChannelId = this.ownChannelId();
    if (ownChannelId === null || messages.some((message) => message.channelId !== ownChannelId)) {
      throw new Error("Realtime message belongs to a foreign channel.");
    }
    const now = Date.now();
    const ordinarySockets = messages.some((message) => message.type !== "overlay.changed" &&
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
        : isModuleOverlayRealtimeEnvelope(envelope)
          ? [...new Set((envelope.overlayIds ?? []).flatMap((overlayId) => overlaySocketsById.get(overlayId) ?? []))]
          : ordinarySockets,
    }));
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
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const externalFetchBudget = createModuleExternalFetchBudget();
    await this.pruneRevokedTokenMarkers(now);
    await this.stopSecurityAlarmIfIdle();
    await this.dispatchDueAlarmEntries(now, nowIso, this.alarmHandlers(MODULES, externalFetchBudget));
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
