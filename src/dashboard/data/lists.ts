import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";

import { fetchAuditLog, fetchChannelVariables, fetchEvents, fetchMembers, fetchOverlay, fetchOverlayAccesses, fetchOverlayTokens, fetchOverlays, fetchRecentEvents, fetchSystemOverview } from "../api";
import type { PanelAuditFilters, PanelEventEntry, PanelEventFilters, PanelRecentEventsResponse } from "../../panel-contract";
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
  placeholderData: () => undefined,
  refetchOnWindowFocus: false,
});

export const useEventsQuery = (channelId: string, filters: PanelEventFilters, refetchInterval: number | false = false) => {
  const queryKey = dashboardDataKeys.events(channelId, filters);
  return useInfiniteQuery({
    queryKey,
    // History pages stay put; event revisions refresh the separate bounded head query.
    staleTime: Infinity,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => fetchEvents(channelId, pageParam, signal, filters),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    maxPages: 10,
    // Filters own separate displayed snapshots; do not borrow another filter's cached rows while loading.
    placeholderData: () => undefined,
    refetchInterval,
    refetchOnWindowFocus: false,
  });
};

const RECENT_EVENT_LIMIT = 100;

const mergeRecentEvents = (
  current: readonly PanelEventEntry[],
  incoming: readonly PanelEventEntry[],
): PanelEventEntry[] => {
  const entries = new Map(current.map((entry) => [entry.eventId, entry]));
  for (const entry of incoming) entries.set(entry.eventId, entry);
  return [...entries.values()]
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.eventId.localeCompare(left.eventId))
    .slice(0, RECENT_EVENT_LIMIT);
};

export const useRecentEventsQuery = (channelId: string, refetchInterval: number | false = false) => {
  const queryClient = useQueryClient();
  const queryKey = dashboardDataKeys.recentEvents(channelId);
  return useQuery({
    queryKey,
    queryFn: async ({ signal }): Promise<PanelRecentEventsResponse> => {
      const current = queryClient.getQueryData<PanelRecentEventsResponse>(queryKey);
      const latest = await fetchRecentEvents(channelId, current?.cursor ?? null, signal);
      return current === undefined
        ? latest
        : {
          entries: mergeRecentEvents(current.entries, latest.entries),
          cursor: latest.cursor ?? current.cursor,
        };
    },
    staleTime: 0,
    refetchInterval,
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
