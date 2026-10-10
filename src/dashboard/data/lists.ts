import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { fetchAuditLog, fetchChannelVariables, fetchEvents, fetchMembers, fetchOverlay, fetchOverlayAccesses, fetchOverlayTokens, fetchOverlays, fetchSystemOverview } from "../api";
import type { PanelAuditFilters, PanelEventFilters } from "../../panel-contract";
import { dashboardDataKeys } from "./keys";

export const useMembersQuery = (channelId: string) => useInfiniteQuery({
  queryKey: dashboardDataKeys.members(channelId),
  initialPageParam: null as string | null,
  queryFn: ({ pageParam, signal }) => fetchMembers(channelId, pageParam, signal),
  getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  placeholderData: (previousData, previousQuery) =>
    previousQuery?.queryKey[1] === channelId ? previousData : undefined,
  refetchOnWindowFocus: false,
});

export const useAuditQuery = (channelId: string, filters: PanelAuditFilters) => useInfiniteQuery({
  queryKey: dashboardDataKeys.audit(channelId, filters),
  initialPageParam: null as string | null,
  queryFn: ({ pageParam, signal }) => fetchAuditLog(channelId, pageParam, signal, filters),
  getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  placeholderData: (previousData, previousQuery) =>
    previousQuery?.queryKey[1] === channelId ? previousData : undefined,
  refetchOnWindowFocus: false,
});

export const useEventsQuery = (channelId: string, filters: PanelEventFilters) => {
  const queryKey = dashboardDataKeys.events(channelId, filters);
  return useInfiniteQuery({
    queryKey,
    // A cached filter becomes stale immediately so switching back revalidates it in the background.
    staleTime: 0,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => fetchEvents(channelId, pageParam, signal, filters),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    // Filters own separate displayed snapshots; do not borrow another filter's cached rows while loading.
    placeholderData: () => undefined,
    refetchOnWindowFocus: false,
  });
};

export const useSystemQuery = (channelId: string, enabled: boolean, offlineRefetchInterval: number | false) => useQuery({
  queryKey: dashboardDataKeys.system(channelId),
  queryFn: ({ signal }) => fetchSystemOverview(channelId, signal),
  enabled,
  refetchInterval: offlineRefetchInterval,
  refetchOnWindowFocus: false,
  placeholderData: (previousData, previousQuery) =>
    previousQuery?.queryKey[1] === channelId ? previousData : undefined,
});

export const useChannelVariablesQuery = (channelId: string) => useQuery({
  queryKey: dashboardDataKeys.variables(channelId),
  queryFn: ({ signal }) => fetchChannelVariables(channelId, signal),
  refetchOnWindowFocus: false,
  placeholderData: (previousData, previousQuery) =>
    previousQuery?.queryKey[1] === channelId ? previousData : undefined,
});

export const useOverlaysQuery = (channelId: string, enabled = true) => useQuery({
  queryKey: dashboardDataKeys.overlays(channelId),
  queryFn: ({ signal }) => fetchOverlays(channelId, signal),
  enabled,
  refetchOnWindowFocus: false,
  placeholderData: (previousData, previousQuery) =>
    previousQuery?.queryKey[1] === channelId ? previousData : undefined,
});

export const useOverlayQuery = (channelId: string, overlayId: string, enabled = true) => useQuery({
  queryKey: dashboardDataKeys.overlay(channelId, overlayId),
  queryFn: ({ signal }) => fetchOverlay(channelId, overlayId, signal),
  enabled,
  refetchOnMount: "always",
  refetchOnWindowFocus: false,
  placeholderData: () => undefined,
});

export const useOverlayAccessesQuery = (channelId: string, overlayId: string, enabled = true) => useQuery({
  queryKey: dashboardDataKeys.overlayAccesses(channelId, overlayId),
  queryFn: ({ signal }) => fetchOverlayAccesses(channelId, overlayId, signal),
  enabled,
  refetchOnWindowFocus: false,
  placeholderData: () => undefined,
});

export const useLegacyOverlayTokensQuery = (channelId: string) => useInfiniteQuery({
  queryKey: dashboardDataKeys.legacyOverlayTokens(channelId),
  initialPageParam: 0,
  queryFn: ({ pageParam, signal }) => fetchOverlayTokens(channelId, pageParam, signal),
  getNextPageParam: (lastPage) => lastPage.nextOffset ?? undefined,
  staleTime: 0,
  refetchOnWindowFocus: false,
  placeholderData: () => undefined,
});
