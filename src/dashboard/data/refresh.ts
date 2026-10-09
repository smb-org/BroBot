import type { InvalidateQueryFilters, QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * Cancels the exact query (cold requests included, so a late older response cannot satisfy
 * the invalidation without a new fetch) and then invalidates it.
 */
export const refreshQuery = async (
  queryClient: QueryClient,
  queryKey: QueryKey,
  refetchType: InvalidateQueryFilters["refetchType"] = "active",
): Promise<void> => {
  await queryClient.cancelQueries({ queryKey, exact: true });
  await queryClient.invalidateQueries({ queryKey, exact: true, refetchType });
};
