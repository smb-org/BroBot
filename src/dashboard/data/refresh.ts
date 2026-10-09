import { hashKey, type InvalidateQueryFilters, type QueryClient, type QueryKey } from "@tanstack/react-query";

interface RefreshState {
  dirty: boolean;
  /** Sequence at which the current run started; `refreshIfDirty` skips hints this run already covers. */
  startSeq: number;
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
  const state: RefreshState = { dirty: false, startSeq: recordFor(queryClient, queryKey).seq() };
  states.set(id, state);
  const invalidate = (): Promise<void> => queryClient.invalidateQueries({ queryKey, exact: true, refetchType });
  try {
    await queryClient.cancelQueries({ queryKey, exact: true });
    await invalidate();
    while (state.dirty) {
      state.dirty = false;
      state.startSeq = recordFor(queryClient, queryKey).seq();
      await invalidate();
    }
  } finally {
    states.delete(id);
  }
};

interface DirtyRecord {
  /** Sequence of the newest hint that no later-started fetch has covered yet. */
  dirtySeq: number | null;
  /** Sequences at which first-page fetches of this key are currently in flight. */
  inflight: Set<number>;
}

const records = new WeakMap<QueryClient, { seq: number; byKey: Map<string, DirtyRecord> }>();

const recordFor = (queryClient: QueryClient, queryKey: QueryKey): { seq: () => number; record: DirtyRecord; drop: () => void } => {
  let entry = records.get(queryClient);
  if (entry === undefined) {
    entry = { seq: 0, byKey: new Map() };
    records.set(queryClient, entry);
  }
  const owner = entry;
  const id = hashKey(queryKey);
  let record = owner.byKey.get(id);
  if (record === undefined) {
    record = { dirtySeq: null, inflight: new Set() };
    owner.byKey.set(id, record);
  }
  const found = record;
  return {
    seq: () => (owner.seq += 1),
    record: found,
    drop: () => { if (found.dirtySeq === null && found.inflight.size === 0) owner.byKey.delete(id); },
  };
};

/** Records that the server has something this key's cache has not seen yet. */
export const markDirty = (queryClient: QueryClient, queryKey: QueryKey): void => {
  const { seq, record } = recordFor(queryClient, queryKey);
  record.dirtySeq = seq();
};

/**
 * Wraps a first-page fetch. It clears the dirty marker only when it succeeds and started after the
 * marker was set, so an older in-flight response can never satisfy a newer hint.
 */
export const trackFetch = async <Value>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  fetchPage: () => Promise<Value>,
): Promise<Value> => {
  const { seq, record, drop } = recordFor(queryClient, queryKey);
  const start = seq();
  record.inflight.add(start);
  try {
    const result = await fetchPage();
    if (record.dirtySeq !== null && record.dirtySeq < start) record.dirtySeq = null;
    return result;
  } finally {
    record.inflight.delete(start);
    drop();
  }
};

/** Refreshes once when the key is dirty and no fetch that started after the hint is already running. */
export const refreshIfDirty = (queryClient: QueryClient, queryKey: QueryKey): void => {
  const { record } = recordFor(queryClient, queryKey);
  const dirtySeq = record.dirtySeq;
  if (dirtySeq === null) return;
  for (const start of record.inflight) if (start > dirtySeq) return;
  const run = running.get(queryClient)?.get(hashKey(queryKey));
  if (run !== undefined && run.startSeq > dirtySeq) return;
  void refreshQuery(queryClient, queryKey);
};
