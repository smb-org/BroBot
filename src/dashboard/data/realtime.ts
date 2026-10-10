import { useCallback, useSyncExternalStore } from "react";
import { hashKey, type QueryClient } from "@tanstack/react-query";

import type { RealtimeMessage } from "../../realtime-contract";
import { dashboardDataKeys, queryKeys } from "./keys";
import { refreshQuery } from "./refresh";

const REALTIME_REFRESH_INTERVAL_MS = 1_000;

interface ScheduledRealtimeRefresh {
  lastStartedAt: number;
  pending: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

const scheduledRefreshes = new WeakMap<QueryClient, Map<string, ScheduledRealtimeRefresh>>();

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

const invalidate = (queryClient: QueryClient, queryKey: readonly unknown[]): void => {
  const matchingQueries = queryClient.getQueryCache().findAll({ queryKey });
  void queryClient.invalidateQueries({ queryKey, refetchType: "none" });
  for (const query of matchingQueries) {
    if (query.isActive()) scheduleRealtimeRefresh(queryClient, query.queryKey);
  }
};

const invalidateBelaboxLiveQueries = (queryClient: QueryClient, channelId: string): void => {
  const moduleQueries = queryClient.getQueryCache().findAll({ queryKey: dashboardDataKeys.module(channelId, "belabox") });
  for (const query of moduleQueries) {
    const part = query.queryKey[4];
    if (part === "status" || part === "streams" || part === "history-live" || (typeof part === "string" && part.startsWith("history-stream-"))) {
      invalidate(queryClient, query.queryKey);
    }
  }
};

const invalidateModuleDataQueries = (queryClient: QueryClient, channelId: string, moduleId: string): void => {
  const moduleQueries = queryClient.getQueryCache().findAll({ queryKey: dashboardDataKeys.module(channelId, moduleId) });
  for (const query of moduleQueries) {
    const part = query.queryKey[4];
    if (typeof part === "string" && part !== "settings") invalidate(queryClient, query.queryKey);
  }
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

/** Invalidates the channel caches affected by a realtime hint; API responses remain authoritative. */
export const invalidateDashboardRealtimeMessage = (
  queryClient: QueryClient,
  message: RealtimeMessage,
): void => {
  const { channelId } = message;
  switch (message.type) {
    case "stream.state.changed":
      invalidate(queryClient, queryKeys.channels());
      invalidate(queryClient, ["channel", channelId]);
      break;
    case "event_log.new": {
      invalidate(queryClient, queryKeys.channel(channelId, "events"));
      const moduleIds = new Set(message.payload.entries.map((entry) => entry.moduleId));
      for (const moduleId of moduleIds) invalidateModuleDataQueries(queryClient, channelId, moduleId);
      break;
    }
    case "variables.changed":
      invalidate(queryClient, dashboardDataKeys.variables(channelId));
      invalidate(queryClient, dashboardDataKeys.overlays(channelId));
      invalidate(queryClient, ["channel", channelId, "module"]);
      break;
    case "overlay.changed":
      invalidate(queryClient, dashboardDataKeys.overlays(channelId));
      invalidate(queryClient, dashboardDataKeys.variables(channelId));
      break;
    case "ads.schedule.updated":
      invalidate(queryClient, queryKeys.module(channelId, "ads", "schedule"));
      break;
    default: {
      switch (message.type) {
        case "modul.chat_voting.opened":
        case "modul.chat_voting.tally":
          invalidate(queryClient, queryKeys.module(channelId, "chat_voting", "panel"));
          break;
        case "modul.belabox.state_changed":
        case "modul.belabox.sample":
          // Refresh only live data parts; stream history keys are selected dynamically by the panel.
          invalidateBelaboxLiveQueries(queryClient, channelId);
          break;
        case "modul.votekick.opened":
          invalidate(queryClient, queryKeys.module(channelId, "votekick", "panel"));
          // Chat voting also reads channel-wide ballot availability from the shared ballot.
          invalidate(queryClient, queryKeys.module(channelId, "chat_voting", "panel"));
          break;
        case "modul.votekick.tally":
          invalidate(queryClient, queryKeys.module(channelId, "votekick", "panel"));
          if (message.payload.status !== "running") {
            // Chat voting also reads channel-wide ballot availability from the shared ballot.
            invalidate(queryClient, queryKeys.module(channelId, "chat_voting", "panel"));
          }
          break;
        default:
          break;
      }
    }
  }
};

/** A successful reconnect makes every cached resource for that channel stale. */
export const invalidateDashboardChannelQueries = (queryClient: QueryClient, channelId: string): void => {
  invalidate(queryClient, queryKeys.channels());
  invalidate(queryClient, ["channel", channelId]);
};
