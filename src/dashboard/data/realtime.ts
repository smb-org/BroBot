import { useCallback, useSyncExternalStore } from "react";
import { hashKey, type QueryClient } from "@tanstack/react-query";

import type { RealtimeMessage } from "../../realtime-contract";
import { dashboardDataKeys, queryKeys } from "./keys";
import { refreshQuery } from "./refresh";
import { dispatchDashboardAuthenticationRequired } from "./events";

const REALTIME_REFRESH_INTERVAL_MS = 1_000;

interface ScheduledRealtimeRefresh {
  lastStartedAt: number;
  pending: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const scheduledRefreshes = new WeakMap<QueryClient, Map<string, ScheduledRealtimeRefresh>>();
const panelRevisionSnapshots = new WeakMap<QueryClient, Map<string, Readonly<Record<string, number>>>>();
interface PanelRevisionFetch {
  dirty: boolean;
  promise: Promise<void>;
}

const panelRevisionFetches = new WeakMap<QueryClient, Map<string, PanelRevisionFetch>>();
const revisionFetchWasDirtied = (state: PanelRevisionFetch): boolean => state.dirty;

export type DashboardRealtimeStatus = "connecting" | "connected" | "reconnecting" | "offline" | "renew";

const statuses = new Map<string, DashboardRealtimeStatus>();
const subscribers = new Map<string, Set<() => void>>();

export const getDashboardRealtimeStatus = (channelId: string): DashboardRealtimeStatus =>
  statuses.get(channelId) ?? "offline";

export const setDashboardRealtimeStatus = (channelId: string, status: DashboardRealtimeStatus): void => {
  if (statuses.get(channelId) === status) return;
  statuses.set(channelId, status);
  for (const subscriber of subscribers.get(channelId) ?? []) subscriber();
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
  scheduledQueryKeys?: Set<string>,
): void => {
  const matchingQueries = queryClient.getQueryCache().findAll({ queryKey });
  void queryClient.invalidateQueries({ queryKey, refetchType: "none" });
  for (const query of matchingQueries) {
    if (!query.isActive()) continue;
    const queryId = hashKey(query.queryKey);
    if (scheduledQueryKeys?.has(queryId)) continue;
    scheduledQueryKeys?.add(queryId);
    scheduleRealtimeRefresh(queryClient, query.queryKey);
  }
};

const invalidateBelaboxLiveQueries = (queryClient: QueryClient, channelId: string, scheduledQueryKeys: Set<string>): void => {
  const moduleQueries = queryClient.getQueryCache().findAll({ queryKey: dashboardDataKeys.module(channelId, "belabox") });
  for (const query of moduleQueries) {
    const part = query.queryKey[4];
    if (part === "status" || part === "streams" || part === "history-live" || (typeof part === "string" && part.startsWith("history-stream-"))) {
      invalidate(queryClient, query.queryKey, scheduledQueryKeys);
    }
  }
};

const invalidateModuleDataQueries = (queryClient: QueryClient, channelId: string, moduleId: string, scheduledQueryKeys: Set<string>): void => {
  const moduleQueries = queryClient.getQueryCache().findAll({ queryKey: dashboardDataKeys.module(channelId, moduleId) });
  for (const query of moduleQueries) {
    const part = query.queryKey[4];
    if (typeof part === "string" && part !== "settings") invalidate(queryClient, query.queryKey, scheduledQueryKeys);
  }
};

const invalidateModuleSettingsQueries = (queryClient: QueryClient, channelId: string, scheduledQueryKeys: Set<string>): void => {
  const moduleQueries = queryClient.getQueryCache().findAll({ queryKey: ["channel", channelId, "module"] });
  for (const query of moduleQueries) {
    if (query.queryKey[4] === "settings") invalidate(queryClient, query.queryKey, scheduledQueryKeys);
  }
};

const invalidatePanelResource = (queryClient: QueryClient, channelId: string, resource: string, scheduledQueryKeys: Set<string>): void => {
  switch (resource) {
    case "channels":
      invalidate(queryClient, queryKeys.channels(), scheduledQueryKeys);
      return;
    case "channel.all":
      // This is only the bounded socket hint for a large batch. The following
      // authoritative vector names each changed resource exactly.
      return;
    case "channel.overview":
      invalidate(queryClient, queryKeys.channel(channelId, "overview"), scheduledQueryKeys);
      return;
    case "channel.system":
      invalidate(queryClient, dashboardDataKeys.system(channelId), scheduledQueryKeys);
      return;
    case "channel.settings":
      invalidate(queryClient, queryKeys.channel(channelId, "settings"), scheduledQueryKeys);
      return;
    case "channel.members":
      invalidate(queryClient, dashboardDataKeys.members(channelId), scheduledQueryKeys);
      return;
    case "channel.modules":
      invalidate(queryClient, queryKeys.channel(channelId, "modules"), scheduledQueryKeys);
      invalidate(queryClient, queryKeys.channel(channelId, "overview"), scheduledQueryKeys);
      return;
    case "channel.events":
      invalidate(queryClient, queryKeys.channel(channelId, "events"), scheduledQueryKeys);
      return;
    case "channel.audit":
      invalidate(queryClient, queryKeys.channel(channelId, "audit-log"), scheduledQueryKeys);
      return;
    case "channel.variables":
      invalidate(queryClient, dashboardDataKeys.variables(channelId), scheduledQueryKeys);
      invalidate(queryClient, queryKeys.module(channelId, "text_commands", "commands"), scheduledQueryKeys);
      invalidateModuleSettingsQueries(queryClient, channelId, scheduledQueryKeys);
      return;
    case "channel.overlays":
      invalidate(queryClient, dashboardDataKeys.overlays(channelId), scheduledQueryKeys);
      return;
    case "channel.overlay-accesses":
      invalidate(queryClient, dashboardDataKeys.overlays(channelId), scheduledQueryKeys);
      invalidate(queryClient, queryKeys.channel(channelId, "overlay-accesses"), scheduledQueryKeys);
      invalidate(queryClient, dashboardDataKeys.legacyOverlayTokens(channelId), scheduledQueryKeys);
      return;
    case "weather.cache":
      invalidate(queryClient, queryKeys.module(channelId, "text_library", "library"), scheduledQueryKeys);
      return;
    case "api.cache":
      invalidate(queryClient, queryKeys.module(channelId, "api_source", "sources"), scheduledQueryKeys);
      return;
    case "channel.library":
      invalidate(queryClient, queryKeys.module(channelId, "text_library", "library"), scheduledQueryKeys);
      invalidate(queryClient, queryKeys.module(channelId, "timers", "panel"), scheduledQueryKeys);
      invalidate(queryClient, queryKeys.module(channelId, "faq", "panel"), scheduledQueryKeys);
      invalidate(queryClient, queryKeys.module(channelId, "text_commands", "template-variables"), scheduledQueryKeys);
      invalidate(queryClient, queryKeys.module(channelId, "api_source", "sources"), scheduledQueryKeys);
      return;
    default:
      break;
  }

  const moduleMatch = /^module:([a-z][a-z0-9_]*):([a-z][a-z0-9_-]*)$/u.exec(resource);
  const moduleId = moduleMatch?.[1];
  const part = moduleMatch?.[2];
  if (moduleId === undefined || part === undefined) return;
  if (part === "data") {
    invalidateModuleDataQueries(queryClient, channelId, moduleId, scheduledQueryKeys);
    return;
  }
  if (moduleId === "belabox" && part === "live") {
    invalidateBelaboxLiveQueries(queryClient, channelId, scheduledQueryKeys);
    return;
  }
  invalidate(queryClient, queryKeys.module(channelId, moduleId, part), scheduledQueryKeys);
};

const validPanelRevisionVector = (value: unknown): value is Readonly<Record<string, number>> =>
  typeof value === "object" && value !== null && !Array.isArray(value) &&
  Object.entries(value).length <= 4_096 && Object.entries(value).every(([resource, revision]) =>
    resource.length <= 128 && Number.isSafeInteger(revision) && Number(revision) >= 0);

/** Fetches and compares the channel vector; duplicate hints share an in-flight read. */
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
  const inFlight = fetches.get(channelId);
  if (inFlight !== undefined) {
    inFlight.dirty = true;
    return inFlight.promise;
  }
  const state: PanelRevisionFetch = { dirty: false, promise: Promise.resolve() };
  const request = (async (): Promise<void> => {
    do {
      state.dirty = false;
      try {
        const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/revisions`, {
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        });
        if (response.status === 401 || response.status === 403) {
          dispatchDashboardAuthenticationRequired();
          return;
        }
        if (!response.ok) continue;
        const body: unknown = await response.json();
        if (typeof body !== "object" || body === null || Array.isArray(body)) continue;
        const revisions = (body as Record<string, unknown>).revisions;
        if (!validPanelRevisionVector(revisions)) continue;
        const previous = snapshots.get(channelId) ?? {};
        const scheduledQueryKeys = new Set<string>();
        for (const [resource, revision] of Object.entries(revisions)) {
          if (revision > (previous[resource] ?? 0)) invalidatePanelResource(queryClient, channelId, resource, scheduledQueryKeys);
        }
        snapshots.set(channelId, revisions);
      } catch {
        // The durable vector is compared again on the next hint, reconnect, or focus.
      }
    } while (revisionFetchWasDirtied(state));
  })().finally(() => {
    if (fetches.get(channelId) === state) fetches.delete(channelId);
  });
  state.promise = request;
  fetches.set(channelId, state);
  return request;
};

/** Runs a leading refresh, then limits hints for this key to one refresh per interval. */
const scheduleRealtimeRefresh = (queryClient: QueryClient, queryKey: readonly unknown[]): void => {
  let refreshes = scheduledRefreshes.get(queryClient);
  if (refreshes === undefined) {
    refreshes = new Map();
    scheduledRefreshes.set(queryClient, refreshes);
  }

  const id = hashKey(queryKey);
  const now = Date.now();
  let state = refreshes.get(id);
  if (state === undefined) {
    state = { lastStartedAt: now, pending: false, timer: null };
    refreshes.set(id, state);
    void refreshQuery(queryClient, queryKey);
    return;
  }

  state.pending = true;
  if (state.timer !== null) return;
  const wait = Math.max(0, REALTIME_REFRESH_INTERVAL_MS - (now - state.lastStartedAt));
  const scheduled = state;
  scheduled.timer = setTimeout(() => {
    scheduled.timer = null;
    if (!scheduled.pending) return;
    scheduled.pending = false;
    scheduled.lastStartedAt = Date.now();
    void refreshQuery(queryClient, queryKey);
  }, wait);
};

/** A realtime message is a wake-up; persisted resource revisions decide what to invalidate. */
export const reconcileDashboardRealtimeMessage = (
  queryClient: QueryClient,
  message: RealtimeMessage,
): Promise<void> => message.type === "system.hello"
  ? Promise.resolve()
  : reconcileDashboardPanelResourceRevisions(queryClient, message.channelId);

/** A successful reconnect makes every cached resource for that channel stale. */
export const invalidateDashboardChannelQueries = (queryClient: QueryClient, channelId: string): void => {
  invalidate(queryClient, ["channel", channelId]);
};
