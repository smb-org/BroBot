import { useCallback, useSyncExternalStore } from "react";
import type { QueryClient } from "@tanstack/react-query";

import type { RealtimeMessage } from "../../realtime-contract";
import { dashboardDataKeys, queryKeys } from "./keys";
import { refreshQuery } from "./refresh";

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
    if (query.isActive()) void refreshQuery(queryClient, query.queryKey);
  }
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
      for (const moduleId of moduleIds) invalidate(queryClient, dashboardDataKeys.module(channelId, moduleId));
      break;
    }
    case "variables.changed":
      invalidate(queryClient, dashboardDataKeys.variables(channelId));
      invalidate(queryClient, dashboardDataKeys.overlays(channelId));
      invalidate(queryClient, ["channel", channelId, "module"]);
      break;
    case "overlay.changed":
      invalidate(queryClient, dashboardDataKeys.overlays(channelId));
      invalidate(queryClient, dashboardDataKeys.overlay(channelId, message.payload.overlayId));
      invalidate(queryClient, dashboardDataKeys.variables(channelId));
      break;
    case "ads.schedule.updated":
      invalidate(queryClient, dashboardDataKeys.module(channelId, "ads"));
      break;
    default: {
      if (message.type.startsWith("modul.")) {
        const moduleId = message.type.split(".")[1];
        if (moduleId !== undefined) invalidate(queryClient, dashboardDataKeys.module(channelId, moduleId));
        const votekickOpened = message.type === "modul.votekick.opened";
        const votekickClosed = message.type === "modul.votekick.tally" && message.payload.status !== "running";
        if (votekickOpened || votekickClosed) {
          // Chat voting also reads channel-wide ballot availability from the shared ballot.
          invalidate(queryClient, dashboardDataKeys.module(channelId, "chat_voting"));
        }
      }
    }
  }
};

/** A successful reconnect makes every cached resource for that channel stale. */
export const invalidateDashboardChannelQueries = (queryClient: QueryClient, channelId: string): void => {
  invalidate(queryClient, queryKeys.channels());
  invalidate(queryClient, ["channel", channelId]);
};
