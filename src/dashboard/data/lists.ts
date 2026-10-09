import { useInfiniteQuery, useQuery } from "@tanstack/react-query";

import { fetchAuditLog, fetchEvents, fetchMembers, fetchSystemOverview } from "../api";
import type { PanelAuditFilters, PanelEventFilters } from "../../panel-contract";
import { dashboardDataKeys } from "./keys";

export const useMembersQuery = (channelId: string) => useInfiniteQuery({
  queryKey: dashboardDataKeys.members(channelId),
  initialPageParam: null as string | null,
  queryFn: ({ pageParam, signal }) => fetchMembers(channelId, pageParam, signal),
  getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  refetchOnWindowFocus: false,
});

export const useAuditQuery = (channelId: string, filters: PanelAuditFilters) => useInfiniteQuery({
  queryKey: dashboardDataKeys.audit(channelId, filters),
  initialPageParam: null as string | null,
  queryFn: ({ pageParam, signal }) => fetchAuditLog(channelId, pageParam, signal, filters),
  getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  refetchOnWindowFocus: false,
});

export const useEventsQuery = (channelId: string, filters: PanelEventFilters) => useInfiniteQuery({
  queryKey: dashboardDataKeys.events(channelId, filters),
  initialPageParam: null as string | null,
  queryFn: ({ pageParam, signal }) => fetchEvents(channelId, pageParam, signal, filters),
  getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  refetchOnWindowFocus: false,
});

export const useSystemQuery = (channelId: string, enabled: boolean) => useQuery({
  queryKey: dashboardDataKeys.system(channelId),
  queryFn: ({ signal }) => fetchSystemOverview(channelId, signal),
  enabled,
  refetchOnWindowFocus: false,
  placeholderData: (previousData, previousQuery) =>
    previousQuery?.queryKey[1] === channelId ? previousData : undefined,
});
