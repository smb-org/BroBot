import { useEffect } from "react";
import { hashKey, useInfiniteQuery, useQuery, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";

import { fetchAuditLog, fetchChannelVariables, fetchEventChanges, fetchEvents, fetchMembers, fetchOverlay, fetchOverlayAccesses, fetchOverlayTokens, fetchOverlays, fetchSystemOverview } from "../api";
import type { PanelAuditFilters, PanelEventFilters, PanelEventsResponse } from "../../panel-contract";
import { dashboardDataKeys } from "./keys";
import { refreshEventHead, type EventHead } from "../events/model";

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
  placeholderData: () => undefined,
  refetchOnWindowFocus: false,
});

const cockpitFollowingHeadCounts = new WeakMap<QueryClient, Map<string, number>>();

const hasFollowingCockpit = (queryClient: QueryClient, queryId: string): boolean =>
  (cockpitFollowingHeadCounts.get(queryClient)?.get(queryId) ?? 0) > 0;

const trackCockpitFollowingHead = (queryClient: QueryClient, queryId: string): (() => void) => {
  let heads = cockpitFollowingHeadCounts.get(queryClient);
  if (heads === undefined) {
    heads = new Map();
    cockpitFollowingHeadCounts.set(queryClient, heads);
  }
  const id = queryId;
  heads.set(id, (heads.get(id) ?? 0) + 1);
  return () => {
    const nextCount = (heads.get(id) ?? 1) - 1;
    if (nextCount <= 0) heads.delete(id);
    else heads.set(id, nextCount);
  };
};

export const useEventHeadQuery = (
  channelId: string,
  filters: PanelEventFilters,
  refetchInterval: number | false = false,
  isFollowing: () => boolean = () => true,
  cockpitAlwaysFollowing = false,
) => {
  const queryClient = useQueryClient();
  const queryKey = dashboardDataKeys.eventHead(channelId, filters);
  const queryId = hashKey(queryKey);
  useEffect(() => {
    if (!cockpitAlwaysFollowing) return;
    return trackCockpitFollowingHead(queryClient, queryId);
  }, [cockpitAlwaysFollowing, queryClient, queryId]);

  return useQuery({
    queryKey,
    staleTime: 0,
    queryFn: ({ signal }) => refreshEventHead(queryClient.getQueryData<EventHead>(queryKey), {
      fetchHead: () => fetchEvents(channelId, null, signal, filters),
      fetchChanges: (after) => fetchEventChanges(channelId, after, signal, filters),
      historyHasPages: (epoch) => (queryClient.getQueryData<InfiniteData<PanelEventsResponse, string | null>>(
        dashboardDataKeys.eventHistory(channelId, filters, epoch),
      )?.pages.length ?? 0) > 0,
      isFollowing: () => cockpitAlwaysFollowing || isFollowing() || hasFollowingCockpit(queryClient, queryId),
    }),
    placeholderData: () => undefined,
    refetchInterval,
    refetchOnWindowFocus: false,
  });
};

export const useEventHistoryQuery = (
  channelId: string,
  filters: PanelEventFilters,
  head: EventHead | undefined,
) => useInfiniteQuery({
  queryKey: dashboardDataKeys.eventHistory(channelId, filters, head?.epoch ?? 0),
  enabled: false,
  initialPageParam: head?.nextCursor ?? null as string | null,
  queryFn: ({ pageParam, signal }) => fetchEvents(channelId, pageParam, signal, filters),
  getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  placeholderData: () => undefined,
});

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

export const useOverlayAccessesQuery = (channelId: string, overlayId: string, enabled = true, refetchInterval?: number) => useQuery({
  queryKey: dashboardDataKeys.overlayAccesses(channelId, overlayId),
  queryFn: ({ signal }) => fetchOverlayAccesses(channelId, overlayId, signal),
  enabled,
  staleTime: 0,
  refetchOnMount: "always",
  refetchOnWindowFocus: true,
  ...(refetchInterval === undefined ? {} : { refetchInterval }),
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
