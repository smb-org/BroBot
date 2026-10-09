import { hashKey, type InvalidateQueryFilters, type QueryClient, type QueryKey } from "@tanstack/react-query";

interface RefreshState {
  /** Sequence of the latest call that joined the running refresh; null when nothing is queued. */
  joinSeq: number | null;
  /** Sequence at which the current run started; `refreshIfDirty` skips hints this run already covers. */
  startSeq: number;
  /** Latest `canRun` of the callers: the trailing run only starts while it returns true. */
  canRun: (() => boolean) | undefined;
}

// Per-client, per-key state; a WeakMap keeps separate clients (and tests) isolated.
const running = new WeakMap<QueryClient, Map<string, RefreshState>>();

/**
 * Single-flight refresh with one trailing run per exact query key. The first call cancels the
 * query (cold requests included, so a late older response cannot satisfy the invalidation
 * without a new fetch) and invalidates it. Calls made while it runs only queue a trailing run;
 * once it settles, exactly one more invalidation runs without cancelling, so a stream of hints can
 * never starve the refetch. The trailing run is skipped when a successful fetch started after the
 * last join, and left to `refreshIfDirty` when `canRun` says the reader is away.
 */
export const refreshQuery = async (
  queryClient: QueryClient,
  queryKey: QueryKey,
  refetchType: InvalidateQueryFilters["refetchType"] = "active",
  canRun?: () => boolean,
): Promise<void> => {
  let states = running.get(queryClient);
  if (states === undefined) {
    states = new Map();
    running.set(queryClient, states);
  }
  const id = hashKey(queryKey);
  const current = states.get(id);
  const owner = ownerFor(queryClient);
  if (current !== undefined) {
    current.joinSeq = owner.nextSeq();
    current.canRun = canRun;
    return;
  }
  const state: RefreshState = { joinSeq: null, startSeq: owner.nextSeq(), canRun };
  states.set(id, state);
  const record = recordFor(queryClient, queryKey);
  const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey, exact: true, refetchType });
  try {
    await queryClient.cancelQueries({ queryKey, exact: true });
    await invalidate();
    while (state.joinSeq !== null) {
      const joined = state.joinSeq;
      state.joinSeq = null;
      if (record.lastSuccessStart !== null && record.lastSuccessStart > joined) break;
      if (state.canRun !== undefined && !state.canRun()) {
        // Reader is away: keep the key dirty so reaching the start fetches it.
        record.dirtySeq ??= owner.nextSeq();
        break;
      }
      state.startSeq = owner.nextSeq();
      await invalidate();
    }
  } finally {
    states.delete(id);
  }
};

interface DirtyRecord {
  /** Sequence of the newest hint that no later-started complete fetch has covered yet. */
  dirtySeq: number | null;
  /** Start of the newest first-page fetch whose whole query has not settled yet. */
  lastStart: number | null;
  /** Start of the newest fetch whose whole query settled successfully. */
  lastSuccessStart: number | null;
}

interface ClientOwner {
  seq: number;
  nextSeq: () => number;
  byKey: Map<string, DirtyRecord>;
}

const owners = new WeakMap<QueryClient, ClientOwner>();

const newRecord = (): DirtyRecord => ({ dirtySeq: null, lastStart: null, lastSuccessStart: null });

const ownerFor = (queryClient: QueryClient): ClientOwner => {
  let owner = owners.get(queryClient);
  if (owner === undefined) {
    const created: ClientOwner = { seq: 0, nextSeq: () => (created.seq += 1), byKey: new Map() };
    owner = created;
    owners.set(queryClient, created);
    // The whole infinite query settles in one cache event, after every page was refetched.
    queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated") return;
      const record = created.byKey.get(event.query.queryHash);
      if (record === undefined || record.lastStart === null) return;
      if (event.action.type === "success") {
        record.lastSuccessStart = record.lastStart;
        if (record.dirtySeq !== null && record.dirtySeq < record.lastStart) record.dirtySeq = null;
        record.lastStart = null;
      } else if (event.action.type === "error") {
        record.lastStart = null;
      }
    });
  }
  return owner;
};

const recordFor = (queryClient: QueryClient, queryKey: QueryKey): DirtyRecord => {
  const owner = ownerFor(queryClient);
  const id = hashKey(queryKey);
  let record = owner.byKey.get(id);
  if (record === undefined) {
    record = newRecord();
    owner.byKey.set(id, record);
  }
  return record;
};

/** Records that the server has something this key's cache has not seen yet. */
export const markDirty = (queryClient: QueryClient, queryKey: QueryKey): void => {
  recordFor(queryClient, queryKey).dirtySeq = ownerFor(queryClient).nextSeq();
};

/**
 * Wraps a first-page fetch to note when it started. The dirty marker is cleared only when the whole
 * query settles successfully (see the cache subscription), never by this page alone, so a failed
 * later page or a cancellation keeps the key dirty.
 */
export const trackFetch = <Value>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  fetchPage: () => Promise<Value>,
): Promise<Value> => {
  const record = recordFor(queryClient, queryKey);
  const start = ownerFor(queryClient).nextSeq();
  record.lastStart = start;
  return fetchPage();
};

/** Refreshes once when the key is dirty and no fetch that started after the hint is already running. */
export const refreshIfDirty = (queryClient: QueryClient, queryKey: QueryKey, canRun?: () => boolean): void => {
  const record = recordFor(queryClient, queryKey);
  const dirtySeq = record.dirtySeq;
  if (dirtySeq === null) return;
  if (record.lastStart !== null && record.lastStart > dirtySeq) return;
  const run = running.get(queryClient)?.get(hashKey(queryKey));
  if (run !== undefined && run.startSeq > dirtySeq) return;
  void refreshQuery(queryClient, queryKey, "active", canRun);
};
