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
import type { HelixRequest, HelixRequestOptions } from "../../modules/contract";
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
// On reset, the Durable Object class instance is discarded, so new keys are
// safe. Without this reset, scheduleEarliestAlarm() would not find the old
// deadlines, would silently delete the alarm, and both the security round
// and the ad prewarning would stop firing.
const SECURITY_DEADLINE_KEY = "security_round";
const SECURITY_RETRY_KEY = "security_retry";
const AD_PREWARNING_DEADLINE_KEY = "ad_prewarning";
const AD_SCHEDULE_CACHE_KEY = "ads:schedule";
const AD_SCHEDULE_GENERATION_KEY = "ads:schedule_generation";
const AD_PREWARNING_RECONCILED_KEY = "ads:prewarning_reconciled";
const TWITCH_RETRY_AFTER_KEY = "twitch:retry_after";
const AD_SCHEDULE_REFRESH_TIMEOUT_MS = 15_000;
const STREAM_REFRESH_LEASE_KEY = "stream_state_refresh_lease";
const STREAM_REFRESH_LEASE_MS = 30_000;
const SOCKET_EXPIRED_CODE = 4001;
const SOCKET_REVOKED_CODE = 4003;
const SOCKET_TRANSIENT_CODE = 4008;
const SOCKET_POLICY_VIOLATION_CODE = 1008;

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
      if (change.countdownChanged) {
        try {
          const prepared = await prepareModuleOverlayRealtimeMessage(
            this.env.DB,
            channelId,
            "ads",
            createAdCountdownOverlayAction(countdownState),
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

  public async getAdScheduleGeneration(): Promise<number> {
    return await this.ctx.storage.get<number>(AD_SCHEDULE_GENERATION_KEY) ?? 0;
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

  private async scheduleEarliestAlarm(): Promise<void> {
    const deadlines = await Promise.all([
      this.ctx.storage.get(SECURITY_DEADLINE_KEY),
      this.ctx.storage.get(SECURITY_RETRY_KEY),
      this.ctx.storage.get(AD_PREWARNING_DEADLINE_KEY),
    ]);
    const retryDeadline = deadlines[1];
    const securityDeadline = deadlines[0];
    const validDeadlines = deadlines.filter((deadline, index): deadline is number => {
      if (typeof deadline !== "number" || !Number.isFinite(deadline)) return false;
      // A failed due round keeps its original deadline as evidence that the
      // periodic round is still owed. The separate retry alarm avoids a tight
      // loop on that past-due value.
      return !(index === 0 && typeof retryDeadline === "number" &&
        Number.isFinite(retryDeadline) && typeof securityDeadline === "number" &&
        securityDeadline <= Date.now());
    });
    if (validDeadlines.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(Math.min(...validDeadlines));
  }

  private async scheduleSecurityAlarm(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.delete(SECURITY_DEADLINE_KEY);
      await this.ctx.storage.delete(SECURITY_RETRY_KEY);
    } else {
      const deadline = await this.ctx.storage.get(SECURITY_DEADLINE_KEY);
      if (typeof deadline !== "number" || !Number.isFinite(deadline)) {
        await this.ctx.storage.put(SECURITY_DEADLINE_KEY, Date.now() + SECURITY_ALARM_INTERVAL_MS);
      }
    }
    await this.scheduleEarliestAlarm();
  }

  private async stopSecurityAlarmIfIdle(): Promise<void> {
    if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.delete(SECURITY_DEADLINE_KEY);
      await this.ctx.storage.delete(SECURITY_RETRY_KEY);
      await this.scheduleEarliestAlarm();
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
    await this.ctx.storage.put(AD_PREWARNING_DEADLINE_KEY, dueAtMs);
    await this.scheduleEarliestAlarm();
  }

  public async clearAdPrewarning(): Promise<void> {
    await this.ctx.storage.delete(AD_PREWARNING_DEADLINE_KEY);
    await this.scheduleEarliestAlarm();
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
      await this.ctx.storage.put(SECURITY_RETRY_KEY, Date.now() + SECURITY_RETRY_INTERVAL_MS);
      await this.scheduleEarliestAlarm();
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

  override async alarm(): Promise<void> {
    const webSockets = this.ctx.getWebSockets();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    await this.pruneRevokedTokenMarkers(now);
    const [securityDeadline, warningDeadline] = await Promise.all([
      this.ctx.storage.get(SECURITY_DEADLINE_KEY),
      this.ctx.storage.get(AD_PREWARNING_DEADLINE_KEY),
    ]);
    const securityDue = typeof securityDeadline === "number" && Number.isFinite(securityDeadline) && securityDeadline <= now;
    const retryDeadline = await this.ctx.storage.get(SECURITY_RETRY_KEY);
    const securityRetryDue = typeof retryDeadline === "number" && Number.isFinite(retryDeadline) && retryDeadline <= now;
    const warningDue = typeof warningDeadline === "number" && Number.isFinite(warningDeadline) && warningDeadline <= now;
    const expired = new Set<WebSocket>();
    const revoked = new Set<WebSocket>();
    const overlayBindingChanged = new Set<WebSocket>();
    // Sockets whose authorization batch could not be checked this round. They
    // are closed with the transient code so clients reconnect and are
    // re-authorized on handshake, instead of staying subscribed past the
    // backstop while D1 keeps failing.
    const transientAuth = new Set<WebSocket>();
    let transientFailure = false;

    if (warningDue) await this.ctx.storage.delete(AD_PREWARNING_DEADLINE_KEY);

    const principals = webSockets.map((webSocket) => ({ webSocket, principal: readAttachment(webSocket) }));

    if ((securityDue || securityRetryDue) && webSockets.length > 0) {
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

    if ((securityDue || securityRetryDue) && webSockets.length > 0) try {
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

    if (securityDue || securityRetryDue) {
      if (this.ctx.getWebSockets().length === 0) {
        await this.ctx.storage.delete(SECURITY_DEADLINE_KEY);
        await this.ctx.storage.delete(SECURITY_RETRY_KEY);
      } else if (transientFailure) {
        await this.ctx.storage.put(SECURITY_RETRY_KEY, now + SECURITY_RETRY_INTERVAL_MS);
      } else {
        await this.ctx.storage.delete(SECURITY_RETRY_KEY);
        await this.ctx.storage.put(SECURITY_DEADLINE_KEY, now + SECURITY_ALARM_INTERVAL_MS);
      }
    } else if (this.ctx.getWebSockets().length === 0) {
      await this.ctx.storage.delete(SECURITY_DEADLINE_KEY);
      await this.ctx.storage.delete(SECURITY_RETRY_KEY);
    }

    const ownChannel = this.ownChannelId();
    if (warningDue && typeof warningDeadline === "number" && ownChannel !== null) {
      try {
        await processAdPrewarning(
          this.env,
          ownChannel,
          warningDeadline,
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
      } catch (error: unknown) {
        // A flow or D1 error must not swallow the other deadlines that are due.
        console.error("Ad prewarning could not be processed in the alarm.", error);
      }
    }
    await this.scheduleEarliestAlarm();
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
