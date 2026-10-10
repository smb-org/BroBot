import { useCallback, useSyncExternalStore } from "react";
import { hashKey, type QueryClient } from "@tanstack/react-query";

import type { RealtimeMessage } from "../../realtime-contract";
import { dashboardDataKeys, queryKeys } from "./keys";
import { refreshQuery } from "./refresh";
import { dispatchDashboardAuthenticationRequired } from "./events";

const REALTIME_REFRESH_INTERVAL_MS = 1_000;
const PANEL_REVISION_READ_INTERVAL_MS = 250;
const REALTIME_RETRY_INITIAL_DELAY_MS = 500;
const REALTIME_RETRY_MAX_DELAY_MS = 30_000;

interface ScheduledRealtimeRefresh {
  lastStartedAt: number;
  pending: boolean;
  running: boolean;
  retryCount: number;
  retryWaiting: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  promise: Promise<boolean> | null;
  resolve: ((refreshed: boolean) => void) | null;
  queryClient: QueryClient;
  queryKey: readonly unknown[];
  retryChannelId: string | null;
}

const scheduledRefreshes = new WeakMap<QueryClient, Map<string, ScheduledRealtimeRefresh>>();
const panelRevisionSnapshots = new WeakMap<QueryClient, Map<string, Readonly<Record<string, number>>>>();
interface PanelRevisionFetch {
  lastStartedAt: number;
  dirty: boolean;
  retryCount: number;
  promise: Promise<void> | null;
}

const panelRevisionFetches = new WeakMap<QueryClient, Map<string, PanelRevisionFetch>>();
const revisionFetchWasDirtied = (state: PanelRevisionFetch): boolean => state.dirty;
interface RealtimeRetryWaiter {
  queryClient: QueryClient;
  resume: () => void;
  cancel: () => void;
}

const realtimeRetryWaiters = new Map<string, Set<RealtimeRetryWaiter>>();
const realtimeRetryWaitersByClient = new WeakMap<QueryClient, Map<string, Set<() => void>>>();
const realtimeRetryGenerations = new WeakMap<QueryClient, Map<string, number>>();

const realtimeRetryGeneration = (queryClient: QueryClient, channelId: string): number =>
  realtimeRetryGenerations.get(queryClient)?.get(channelId) ?? 0;

export const cancelDashboardRealtimeRetries = (queryClient: QueryClient, channelId: string): void => {
  let generations = realtimeRetryGenerations.get(queryClient);
  if (generations === undefined) {
    generations = new Map();
    realtimeRetryGenerations.set(queryClient, generations);
  }
  generations.set(channelId, realtimeRetryGeneration(queryClient, channelId) + 1);

  const revisionFetches = panelRevisionFetches.get(queryClient);
  revisionFetches?.delete(channelId);

  const refreshes = scheduledRefreshes.get(queryClient);
  if (refreshes !== undefined) {
    for (const [id, state] of refreshes) {
      if (state.retryChannelId !== channelId) continue;
      if (state.timer !== null) clearTimeout(state.timer);
      state.timer = null;
      state.pending = false;
      state.retryWaiting = false;
      state.resolve?.(false);
      state.resolve = null;
      state.promise = null;
      refreshes.delete(id);
    }
  }

  for (const cancel of [...(realtimeRetryWaitersByClient.get(queryClient)?.get(channelId) ?? [])]) cancel();
};

const retryBackoffDelay = (retryCount: number): number =>
  Math.min(REALTIME_RETRY_INITIAL_DELAY_MS * (2 ** Math.min(16, Math.max(0, retryCount - 1))), REALTIME_RETRY_MAX_DELAY_MS);

const waitForRealtimeRetry = (
  queryClient: QueryClient,
  channelId: string,
  delay: number,
  generation: number,
): Promise<boolean> => new Promise<boolean>((resolve) => {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let channelWaiters: Set<RealtimeRetryWaiter> | null = null;
  const removeWaiter = (): void => {
    if (channelWaiters !== null) {
      channelWaiters.delete(waiter);
      if (channelWaiters.size === 0) realtimeRetryWaiters.delete(channelId);
      channelWaiters = null;
    }
    const clientChannels = realtimeRetryWaitersByClient.get(queryClient);
    const clientWaiters = clientChannels?.get(channelId);
    clientWaiters?.delete(cancel);
    if (clientWaiters?.size === 0) clientChannels?.delete(channelId);
  };
  const finish = (connected: boolean): void => {
    if (settled) return;
    settled = true;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    removeWaiter();
    resolve(connected && realtimeRetryGeneration(queryClient, channelId) === generation);
  };
  const cancel = (): void => { finish(false); };
  const waiter: RealtimeRetryWaiter = { queryClient, resume: () => { finish(true); }, cancel };

  let clientChannels = realtimeRetryWaitersByClient.get(queryClient);
  if (clientChannels === undefined) {
    clientChannels = new Map();
    realtimeRetryWaitersByClient.set(queryClient, clientChannels);
  }
  let clientWaiters = clientChannels.get(channelId);
  if (clientWaiters === undefined) {
    clientWaiters = new Set();
    clientChannels.set(channelId, clientWaiters);
  }
  clientWaiters.add(cancel);

  timer = setTimeout(() => {
    timer = null;
    if (realtimeRetryGeneration(queryClient, channelId) !== generation) {
      finish(false);
      return;
    }
    if (getDashboardRealtimeStatus(channelId) === "connected") {
      finish(true);
      return;
    }
    channelWaiters = realtimeRetryWaiters.get(channelId) ?? new Set();
    realtimeRetryWaiters.set(channelId, channelWaiters);
    channelWaiters.add(waiter);
  }, delay);
});

export type DashboardRealtimeStatus = "connecting" | "connected" | "reconnecting" | "offline" | "renew";

const statuses = new Map<string, DashboardRealtimeStatus>();
const subscribers = new Map<string, Set<() => void>>();

export const getDashboardRealtimeStatus = (channelId: string): DashboardRealtimeStatus =>
  statuses.get(channelId) ?? "offline";

export const setDashboardRealtimeStatus = (channelId: string, status: DashboardRealtimeStatus): void => {
  if (statuses.get(channelId) === status) return;
  statuses.set(channelId, status);
  for (const subscriber of subscribers.get(channelId) ?? []) subscriber();
  if (status === "connected") {
    for (const waiter of [...(realtimeRetryWaiters.get(channelId) ?? [])]) waiter.resume();
  }
};

export const useDashboardRealtimeStatus = (channelId: string): DashboardRealtimeStatus => {
  const subscribe = useCallback((subscriber: () => void) => {
    let channelSubscribers = subscribers.get(channelId);
    if (channelSubscribers === undefined) {
      channelSubscribers = new Set();
      subscribers.set(channelId, channelSubscribers);
    }
    channelSubscribers.add(subscriber);
    return () => {
      channelSubscribers.delete(subscriber);
      if (channelSubscribers.size === 0) subscribers.delete(channelId);
    };
  }, [channelId]);
  const getSnapshot = useCallback(() => getDashboardRealtimeStatus(channelId), [channelId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

const invalidate = (
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  scheduledQueryRefreshes?: Map<string, Promise<boolean>>,
  resourceRefreshes?: Promise<boolean>[],
  retryChannelId?: string,
): void => {
  const matchingQueries = queryClient.getQueryCache().findAll({ queryKey });
  void queryClient.invalidateQueries({ queryKey, refetchType: "none" });
  for (const query of matchingQueries) {
    if (!query.isActive()) continue;
    const queryId = hashKey(query.queryKey);
    const scheduled = scheduledQueryRefreshes?.get(queryId);
    if (scheduled !== undefined) {
      resourceRefreshes?.push(scheduled);
      continue;
    }
    const refresh = scheduleRealtimeRefresh(queryClient, query.queryKey, retryChannelId);
    scheduledQueryRefreshes?.set(queryId, refresh);
    resourceRefreshes?.push(refresh);
  }
};

const invalidateBelaboxLiveQueries = (
  queryClient: QueryClient,
  channelId: string,
  scheduledQueryRefreshes: Map<string, Promise<boolean>>,
  resourceRefreshes: Promise<boolean>[],
): void => {
  const moduleQueries = queryClient.getQueryCache().findAll({ queryKey: dashboardDataKeys.module(channelId, "belabox") });
  for (const query of moduleQueries) {
    const part = query.queryKey[4];
    if (part === "status" || part === "streams" || part === "history-live" || (typeof part === "string" && part.startsWith("history-stream-"))) {
      invalidate(queryClient, query.queryKey, scheduledQueryRefreshes, resourceRefreshes, channelId);
    }
  }
};

const invalidateModuleDataQueries = (
  queryClient: QueryClient,
  channelId: string,
  moduleId: string,
  scheduledQueryRefreshes: Map<string, Promise<boolean>>,
  resourceRefreshes: Promise<boolean>[],
): void => {
  const moduleQueries = queryClient.getQueryCache().findAll({ queryKey: dashboardDataKeys.module(channelId, moduleId) });
  for (const query of moduleQueries) {
    const part = query.queryKey[4];
    if (typeof part === "string" && part !== "settings") {
      invalidate(queryClient, query.queryKey, scheduledQueryRefreshes, resourceRefreshes, channelId);
    }
  }
};

const invalidateModuleSettingsQueries = (
  queryClient: QueryClient,
  channelId: string,
  scheduledQueryRefreshes: Map<string, Promise<boolean>>,
  resourceRefreshes: Promise<boolean>[],
): void => {
  const moduleQueries = queryClient.getQueryCache().findAll({ queryKey: ["channel", channelId, "module"] });
  for (const query of moduleQueries) {
    if (query.queryKey[4] === "settings") {
      invalidate(queryClient, query.queryKey, scheduledQueryRefreshes, resourceRefreshes, channelId);
    }
  }
};

const invalidatePanelResource = (
  queryClient: QueryClient,
  channelId: string,
  resource: string,
  scheduledQueryRefreshes: Map<string, Promise<boolean>>,
  resourceRefreshes: Promise<boolean>[],
): void => {
  switch (resource) {
    case "channels":
      invalidate(queryClient, queryKeys.channels(), scheduledQueryRefreshes, resourceRefreshes, channelId);
      return;
    case "channel.all":
      // This is only the bounded socket hint for a large batch. The following
      // authoritative vector names each changed resource exactly.
      return;
    case "channel.overview":
      invalidate(queryClient, queryKeys.channel(channelId, "overview"), scheduledQueryRefreshes, resourceRefreshes, channelId);
      return;
    case "channel.system":
      invalidate(queryClient, dashboardDataKeys.system(channelId), scheduledQueryRefreshes, resourceRefreshes, channelId);
      return;
    case "channel.settings":
      invalidate(queryClient, queryKeys.channel(channelId, "settings"), scheduledQueryRefreshes, resourceRefreshes, channelId);
      return;
    case "channel.members":
      invalidate(queryClient, dashboardDataKeys.members(channelId), scheduledQueryRefreshes, resourceRefreshes, channelId);
      return;
    case "channel.modules":
      invalidate(queryClient, queryKeys.channel(channelId, "modules"), scheduledQueryRefreshes, resourceRefreshes, channelId);
      invalidate(queryClient, queryKeys.channel(channelId, "overview"), scheduledQueryRefreshes, resourceRefreshes, channelId);
      return;
    case "channel.events":
      invalidate(queryClient, queryKeys.channel(channelId, "events"), scheduledQueryRefreshes, resourceRefreshes, channelId);
      return;
    case "channel.audit":
      invalidate(queryClient, queryKeys.channel(channelId, "audit-log"), scheduledQueryRefreshes, resourceRefreshes, channelId);
      return;
    case "channel.variables":
      invalidate(queryClient, dashboardDataKeys.variables(channelId), scheduledQueryRefreshes, resourceRefreshes, channelId);
      invalidate(queryClient, queryKeys.module(channelId, "text_commands", "commands"), scheduledQueryRefreshes, resourceRefreshes, channelId);
      invalidateModuleSettingsQueries(queryClient, channelId, scheduledQueryRefreshes, resourceRefreshes);
      return;
    case "channel.overlays":
      invalidate(queryClient, dashboardDataKeys.overlays(channelId), scheduledQueryRefreshes, resourceRefreshes, channelId);
      return;
    case "channel.overlay-accesses":
      invalidate(queryClient, dashboardDataKeys.overlays(channelId), scheduledQueryRefreshes, resourceRefreshes, channelId);
      invalidate(queryClient, queryKeys.channel(channelId, "overlay-accesses"), scheduledQueryRefreshes, resourceRefreshes, channelId);
      invalidate(queryClient, dashboardDataKeys.legacyOverlayTokens(channelId), scheduledQueryRefreshes, resourceRefreshes, channelId);
      return;
    case "channel.library":
      invalidate(queryClient, queryKeys.module(channelId, "text_library", "library"), scheduledQueryRefreshes, resourceRefreshes, channelId);
      invalidate(queryClient, queryKeys.module(channelId, "timers", "panel"), scheduledQueryRefreshes, resourceRefreshes, channelId);
      invalidate(queryClient, queryKeys.module(channelId, "faq", "panel"), scheduledQueryRefreshes, resourceRefreshes, channelId);
      invalidate(queryClient, queryKeys.module(channelId, "text_commands", "template-variables"), scheduledQueryRefreshes, resourceRefreshes, channelId);
      return;
    default:
      break;
  }

  const moduleMatch = /^module:([a-z][a-z0-9_]*):([a-z][a-z0-9_-]*)$/u.exec(resource);
  const moduleId = moduleMatch?.[1];
  const part = moduleMatch?.[2];
  if (moduleId === undefined || part === undefined) return;
  if (part === "data") {
    invalidateModuleDataQueries(queryClient, channelId, moduleId, scheduledQueryRefreshes, resourceRefreshes);
    return;
  }
  if (moduleId === "belabox" && part === "live") {
    invalidateBelaboxLiveQueries(queryClient, channelId, scheduledQueryRefreshes, resourceRefreshes);
    return;
  }
  invalidate(queryClient, queryKeys.module(channelId, moduleId, part), scheduledQueryRefreshes, resourceRefreshes, channelId);
};

const validPanelRevisionVector = (value: unknown): value is Readonly<Record<string, number>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  Object.entries(value).length <= 4_096 && Object.entries(value).every(([resource, revision]) =>
    resource.length <= 128 && Number.isSafeInteger(revision) && Number(revision) >= 0);

const advancePanelRevisionSnapshot = (
  queryClient: QueryClient,
  channelId: string,
  resource: string,
  revision: number,
): void => {
  const snapshots = panelRevisionSnapshots.get(queryClient);
  if (snapshots === undefined) return;
  const current = snapshots.get(channelId) ?? {};
  if (revision <= (current[resource] ?? 0)) return;
  snapshots.set(channelId, { ...current, [resource]: revision });
};

/** Coalesces hints into trailing reads and retries failed reads with a capped backoff. */
export const reconcileDashboardPanelResourceRevisions = (
  queryClient: QueryClient,
  channelId: string,
): Promise<void> => {
  let snapshots = panelRevisionSnapshots.get(queryClient);
  if (snapshots === undefined) {
    snapshots = new Map();
    panelRevisionSnapshots.set(queryClient, snapshots);
  }
  let fetches = panelRevisionFetches.get(queryClient);
  if (fetches === undefined) {
    fetches = new Map();
    panelRevisionFetches.set(queryClient, fetches);
  }
  let state = fetches.get(channelId);
  if (state === undefined) {
    state = { lastStartedAt: Number.NEGATIVE_INFINITY, dirty: false, retryCount: 0, promise: null };
    fetches.set(channelId, state);
  }
  if (state.promise !== null) {
    state.dirty = true;
    return state.promise;
  }
  const scheduled = state;
  const generation = realtimeRetryGeneration(queryClient, channelId);
  const request = (async (): Promise<void> => {
    scheduled.dirty = true;
    while (revisionFetchWasDirtied(scheduled)) {
      const wait = Math.max(0, PANEL_REVISION_READ_INTERVAL_MS - (Date.now() - scheduled.lastStartedAt));
      if (wait > 0) await new Promise<void>((resolve) => { setTimeout(resolve, wait); });
      if (realtimeRetryGeneration(queryClient, channelId) !== generation) break;
      // All hints received before this read are represented by its authoritative vector.
      scheduled.dirty = false;
      scheduled.lastStartedAt = Date.now();
      let failed = false;
      try {
        const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/revisions`, {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        if (realtimeRetryGeneration(queryClient, channelId) !== generation) break;
        if (response.status === 401 || response.status === 403) {
          dispatchDashboardAuthenticationRequired();
          scheduled.dirty = false;
          break;
        }
        if (!response.ok) {
          failed = true;
        } else {
          const body: unknown = await response.json();
          if (typeof body !== "object" || body === null || Array.isArray(body)) {
            failed = true;
          } else {
            const revisions = (body as Record<string, unknown>).revisions;
            if (!validPanelRevisionVector(revisions)) {
              failed = true;
            } else {
              const previous = snapshots.get(channelId) ?? {};
              const next = { ...previous };
              const scheduledQueryRefreshes = new Map<string, Promise<boolean>>();
              for (const [resource, revision] of Object.entries(revisions)) {
                if (revision <= (previous[resource] ?? 0)) continue;
                const resourceRefreshes: Promise<boolean>[] = [];
                invalidatePanelResource(queryClient, channelId, resource, scheduledQueryRefreshes, resourceRefreshes);
                if (resourceRefreshes.length === 0) {
                  next[resource] = revision;
                } else {
                  void Promise.all(resourceRefreshes).then((results) => {
                    if (results.every(Boolean)) advancePanelRevisionSnapshot(queryClient, channelId, resource, revision);
                  });
                }
              }
              snapshots.set(channelId, next);
              scheduled.retryCount = 0;
            }
          }
        }
      } catch {
        failed = true;
      }
      if (failed) {
        scheduled.dirty = true;
        scheduled.retryCount += 1;
        const resumed = await waitForRealtimeRetry(queryClient, channelId, retryBackoffDelay(scheduled.retryCount), generation);
        if (!resumed) {
          scheduled.dirty = false;
          break;
        }
      }
    }
  })().finally(() => {
    scheduled.promise = null;
  });
  scheduled.promise = request;
  return request;
};

const queryRefreshSucceeded = (queryClient: QueryClient, queryKey: readonly unknown[]): boolean => {
  const query = queryClient.getQueryCache().find({ queryKey, exact: true });
  return query === undefined || !query.isActive() || (query.state.status === "success" && !query.state.isInvalidated);
};

const runScheduledRealtimeRefresh = (state: ScheduledRealtimeRefresh): void => {
  if (!state.pending) return;
  state.pending = false;
  state.lastStartedAt = Date.now();
  if (state.running) {
    // Let refreshQuery own the trailing read so module queries keep their
    // per-key ordering while a prior realtime refresh is still in flight.
    void refreshQuery(state.queryClient, state.queryKey);
    return;
  }
  state.running = true;
  const generation = state.retryChannelId === null
    ? null
    : realtimeRetryGeneration(state.queryClient, state.retryChannelId);
  void refreshQuery(state.queryClient, state.queryKey)
    .then(() => queryRefreshSucceeded(state.queryClient, state.queryKey))
    .catch(() => false)
    .then((refreshed) => {
      if (generation !== null && state.retryChannelId !== null &&
        realtimeRetryGeneration(state.queryClient, state.retryChannelId) !== generation) return;
      state.running = false;
      if (!refreshed) {
        if (state.timer !== null) clearTimeout(state.timer);
        state.timer = null;
        state.pending = true;
        state.retryCount += 1;
        if (state.retryChannelId === null) return;
        if (state.retryWaiting) return;
        state.retryWaiting = true;
        void waitForRealtimeRetry(
          state.queryClient,
          state.retryChannelId,
          retryBackoffDelay(state.retryCount),
          generation ?? realtimeRetryGeneration(state.queryClient, state.retryChannelId),
        ).then((resumed) => {
          state.retryWaiting = false;
          if (resumed) runScheduledRealtimeRefresh(state);
        });
        return;
      }

      state.retryCount = 0;
      if (state.pending) {
        scheduleRealtimeRefreshAttempt(state, Math.max(0, REALTIME_REFRESH_INTERVAL_MS - (Date.now() - state.lastStartedAt)));
        return;
      }
      state.resolve?.(true);
      state.resolve = null;
      state.promise = null;
    });
};

const scheduleRealtimeRefreshAttempt = (state: ScheduledRealtimeRefresh, delay: number): void => {
  if (state.timer !== null || !state.pending) return;
  if (delay <= 0) {
    runScheduledRealtimeRefresh(state);
    return;
  }
  state.timer = setTimeout(() => {
    state.timer = null;
    runScheduledRealtimeRefresh(state);
  }, delay);
};

/** Runs a leading refresh, then limits hints for this key to one refresh per interval. */
const scheduleRealtimeRefresh = (
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  retryChannelId?: string,
): Promise<boolean> => {
  let refreshes = scheduledRefreshes.get(queryClient);
  if (refreshes === undefined) {
    refreshes = new Map();
    scheduledRefreshes.set(queryClient, refreshes);
  }

  const id = hashKey(queryKey);
  const now = Date.now();
  let state = refreshes.get(id);
  if (state === undefined) {
    state = {
      lastStartedAt: Number.NEGATIVE_INFINITY,
      pending: false,
      running: false,
      retryCount: 0,
      retryWaiting: false,
      timer: null,
      promise: null,
      resolve: null,
      queryClient,
      queryKey,
      retryChannelId: retryChannelId ?? (queryKey[0] === "channel" && typeof queryKey[1] === "string" ? queryKey[1] : null),
    };
    refreshes.set(id, state);
  }
  state.pending = true;
  if (state.promise === null) {
    state.promise = new Promise<boolean>((resolve) => { state.resolve = resolve; });
  }
  const wait = state.retryCount > 0
    ? retryBackoffDelay(state.retryCount)
    : Math.max(0, REALTIME_REFRESH_INTERVAL_MS - (now - state.lastStartedAt));
  if (!state.retryWaiting) scheduleRealtimeRefreshAttempt(state, wait);
  return state.promise;
};

/**
 * A realtime message is a wake-up; persisted resource revisions decide what to invalidate.
 * `modul.*` messages target overlays only. Chat voting, votekick and BELABOX panels
 * refresh from D1-backed resource revisions, so their intervals only run offline.
 */
export const reconcileDashboardRealtimeMessage = (
  queryClient: QueryClient,
  message: RealtimeMessage,
): Promise<void> => message.type === "system.hello"
  ? Promise.resolve()
  : reconcileDashboardPanelResourceRevisions(queryClient, message.channelId);

/** A successful reconnect makes every cached resource for that channel stale. */
export const invalidateDashboardChannelQueries = (queryClient: QueryClient, channelId: string): void => {
  invalidate(queryClient, ["channel", channelId], undefined, undefined, channelId);
};
