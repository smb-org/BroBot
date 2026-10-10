import { hashKey, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";

/** Observe one cached query error, including background failures with stale data. */
export const useDashboardQueryError = (queryKey: QueryKey): unknown => {
  const queryClient = useQueryClient();
  const queryHash = hashKey(queryKey);
  const subscribe = useCallback((onStoreChange: () => void) => queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryHash === queryHash) onStoreChange();
  }), [queryClient, queryHash]);
  const getSnapshot = useCallback(() => queryClient.getQueryCache().get(queryHash)?.state.error ?? null, [queryClient, queryHash]);
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
};
