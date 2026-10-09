import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";

import { fetchAuditLog, fetchEvents, fetchMembers, fetchSystemOverview } from "../api";
import type { PanelAuditFilters, PanelEventFilters } from "../../panel-contract";
import { dashboardDataKeys } from "./keys";
import { trackFetch } from "./refresh";

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
  const queryClient = useQueryClient();
  const queryKey = dashboardDataKeys.events(channelId, filters);
  return useInfiniteQuery({
  queryKey,
  // ponytail: revalidate on every mount; central socket invalidation replaces this in #387
  refetchOnMount: "always",
  initialPageParam: null as string | null,
  queryFn: ({ pageParam, signal }) => pageParam === null
    ? trackFetch(queryClient, queryKey, () => fetchEvents(channelId, pageParam, signal, filters))
    : fetchEvents(channelId, pageParam, signal, filters),
  getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  placeholderData: (previousData, previousQuery) =>
    previousQuery?.queryKey[1] === channelId ? previousData : undefined,
  refetchOnWindowFocus: false,
  });
};

export const useSystemQuery = (channelId: string, enabled: boolean) => useQuery({
  queryKey: dashboardDataKeys.system(channelId),
  queryFn: ({ signal }) => fetchSystemOverview(channelId, signal),
  enabled,
  refetchOnWindowFocus: false,
  placeholderData: (previousData, previousQuery) =>
    previousQuery?.queryKey[1] === channelId ? previousData : undefined,
});
