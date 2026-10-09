import { hashKey, type InvalidateQueryFilters, type QueryClient, type QueryKey } from "@tanstack/react-query";

interface RefreshState {
  queued: boolean;
  promise: Promise<void>;
}

// Per-client, per-key state; a WeakMap keeps separate clients (and tests) isolated.
const running = new WeakMap<QueryClient, Map<string, RefreshState>>();

const hasQueuedRefresh = (state: RefreshState): boolean => state.queued;

/** Coalesces refresh requests for one query key and runs one trailing refresh when hints arrive mid-flight. */
export const refreshQuery = (
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
    current.queued = true;
    return current.promise;
  }

  const state: RefreshState = { queued: false, promise: Promise.resolve() };
  states.set(id, state);
  state.promise = (async () => {
    await queryClient.cancelQueries({ queryKey, exact: true });
    do {
      state.queued = false;
      await queryClient.invalidateQueries({ queryKey, exact: true, refetchType });
    } while (hasQueuedRefresh(state));
  })().finally(() => {
    states.delete(id);
  });
  return state.promise;
};
