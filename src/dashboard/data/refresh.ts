import { hashKey, type InvalidateQueryFilters, type QueryClient, type QueryKey } from "@tanstack/react-query";

interface RefreshState {
  dirty: boolean;
}

// Per-client, per-key state; a WeakMap keeps separate clients (and tests) isolated.
const running = new WeakMap<QueryClient, Map<string, RefreshState>>();

/**
 * Single-flight refresh with one trailing run per exact query key. The first call cancels the
 * query (cold requests included, so a late older response cannot satisfy the invalidation
 * without a new fetch) and invalidates it. Calls made while it runs only mark it dirty; once it
 * settles, exactly one more invalidation runs without cancelling, so a stream of hints can never
 * starve the refetch.
 */
export const refreshQuery = async (
  queryClient: QueryClient,
  queryKey: QueryKey,
  refetchType: InvalidateQueryFilters["refetchType"] = "active",
): Promise<void> => {
  let states = running.get(queryClient);
  if (states === undefined) {
    states = new Map();
    running.set(queryClient, states);
  }
  const id = hashKey(queryKey);
  const current = states.get(id);
  if (current !== undefined) {
    current.dirty = true;
    return;
  }
  const state: RefreshState = { dirty: false };
  states.set(id, state);
  const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey, exact: true, refetchType });
  try {
    await queryClient.cancelQueries({ queryKey, exact: true });
    await invalidate();
    while (state.dirty) {
      state.dirty = false;
      await invalidate();
    }
  } finally {
    states.delete(id);
  }
};
