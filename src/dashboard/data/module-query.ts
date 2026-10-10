import { hashKey, keepPreviousData, useQuery, useQueryClient, type Query, type QueryClient } from "@tanstack/react-query";

import { queryKeys } from "./keys";

export type ModuleQueryFunction<Value> = (signal: AbortSignal) => Promise<Value>;
export type ModuleQueryRevision = number | null;
export interface ModuleQueryPart {
  moduleId: string;
  part: string;
}

export interface ModuleQueryWriteOptions<Value> {
  /** Revision captured when the draft was opened. `null` is used for creates. */
  baselineRevision: ModuleQueryRevision;
  /** Merge the committed result into the primary query before it is revalidated. */
  updateCache: (current: unknown, result: Value) => unknown;
  relatedParts?: readonly ModuleQueryPart[];
}

export interface ModuleQueryOptions<Value> {
  enabled?: boolean;
  refetchInterval?: number | false | ((query: Query<Value>) => number | false);
}

export type ModuleQueryWriteFunction<Value> = (baselineRevision: ModuleQueryRevision) => Promise<Value>;

interface ReadOrder {
  /** Last sequence handed out to a read start or a write commit. */
  nextSeq: number;
  /** Sequence of the newest read or write whose value is in the cache. */
  committedSeq: number;
}

const readOrders = new WeakMap<QueryClient, Map<string, ReadOrder>>();

const readOrderFor = (queryClient: QueryClient, queryKey: readonly unknown[]): ReadOrder => {
  let orders = readOrders.get(queryClient);
  if (orders === undefined) {
    orders = new Map();
    readOrders.set(queryClient, orders);
  }
  const key = hashKey(queryKey);
  let order = orders.get(key);
  if (order === undefined) {
    order = { nextSeq: 0, committedSeq: 0 };
    orders.set(key, order);
  }
  return order;
};

const readers = new WeakMap<QueryClient, Map<string, ModuleQueryFunction<unknown>>>();
const queues = new WeakMap<QueryClient, Map<string, Promise<unknown>>>();

/** Run operations for one query key strictly one after another, whatever each one's outcome. */
const enqueue = <Result,>(queryClient: QueryClient, queryKey: readonly unknown[], task: () => Promise<Result>): Promise<Result> => {
  let chains = queues.get(queryClient);
  if (chains === undefined) {
    chains = new Map();
    queues.set(queryClient, chains);
  }
  const key = hashKey(queryKey);
  const run = (chains.get(key) ?? Promise.resolve()).then(task, task);
  chains.set(key, run.catch(() => undefined));
  return run;
};

/**
 * Read through `fn`. Reads are ordered by when they started: one that started before
 * the newest committed read or write is superseded and yields the cached data.
 */
const readModuleData = async <Value,>(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  fn: ModuleQueryFunction<Value>,
  signal: AbortSignal,
): Promise<Value> => {
  const order = readOrderFor(queryClient, queryKey);
  const seq = ++order.nextSeq;
  const result = await fn(signal);
  if (seq < order.committedSeq) return queryClient.getQueryData<Value>(queryKey) ?? result;
  order.committedSeq = seq;
  return result;
};

/**
 * Explicit "reload server state", queued behind pending writes. Resolves only with
 * the value this very read produced; a failure throws so callers keep their draft.
 * Never infer success from cached query data.
 */
export const refetchModuleQueryData = <Value,>(
  queryClient: QueryClient,
  channelId: string,
  moduleId: string,
  part: string,
): Promise<Value> => {
  const queryKey = moduleQueryKey(channelId, moduleId, part);
  return enqueue(queryClient, queryKey, async () => {
    const fn = readers.get(queryClient)?.get(hashKey(queryKey)) as ModuleQueryFunction<Value> | undefined;
    if (fn === undefined) throw new Error("Module query has no registered reader.");
    // Deliberately outside the query cache's fetch: cancelQueries reverts a cache
    // fetch to its cached data, which would look like a successful reload.
    // Cancel earlier cache reads first so none can commit after this reload publishes.
    await queryClient.cancelQueries({ queryKey, exact: true });
    const order = readOrderFor(queryClient, queryKey);
    const seq = ++order.nextSeq;
    const value = await fn(new AbortController().signal);
    // A read or write that started later is newer server-confirmed state.
    if (seq < order.committedSeq) return queryClient.getQueryData<Value>(queryKey) ?? value;
    order.committedSeq = seq;
    queryClient.setQueryData(queryKey, value);
    return value;
  });
};

export const moduleQueryKey = (channelId: string, moduleId: string, part: string) =>
  queryKeys.module(channelId, moduleId, part);

export const useModuleQuery = <Value,>(
  channelId: string,
  moduleId: string,
  part: string,
  fn: ModuleQueryFunction<Value>,
  options: ModuleQueryOptions<Value> = {},
) => {
  const queryClient = useQueryClient();
  const queryKey = moduleQueryKey(channelId, moduleId, part);
  let registry = readers.get(queryClient);
  if (registry === undefined) {
    registry = new Map();
    readers.set(queryClient, registry);
  }
  registry.set(hashKey(queryKey), fn);
  return useQuery({
    queryKey,
    queryFn: ({ signal }) => readModuleData(queryClient, queryKey, fn, signal),
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    ...(options.refetchInterval === undefined ? {} : { refetchInterval: options.refetchInterval }),
    placeholderData: (previousData, previousQuery) => {
      const previousKey = previousQuery?.queryKey;
      return previousKey?.[0] === "channel" && previousKey[1] === channelId &&
        previousKey[2] === "module" && previousKey[3] === moduleId && previousKey[4] === part
        ? keepPreviousData(previousData)
        : undefined;
    },
  });
};

/**
 * Own the complete write lifecycle for a module resource. Reads are cancelled
 * before the write, committed data reaches the cache before refresh, and a
 * failed write restarts those reads without replacing the write error.
 */
export const runModuleQueryWrite = async <Value,>(
  queryClient: QueryClient,
  channelId: string,
  moduleId: string,
  part: string,
  write: ModuleQueryWriteFunction<Value>,
  options: ModuleQueryWriteOptions<Value>,
): Promise<Value> => enqueue(queryClient, moduleQueryKey(channelId, moduleId, part), async () => {
  const primaryFilter = { queryKey: moduleQueryKey(channelId, moduleId, part), exact: true } as const;
  const filters = [
    primaryFilter,
    ...(options.relatedParts ?? []).map((relatedPart) => ({
      queryKey: moduleQueryKey(channelId, relatedPart.moduleId, relatedPart.part),
      exact: true,
    })),
  ];
  await Promise.all(filters.map((filter) => queryClient.cancelQueries(filter)));
  let result: Value;
  try {
    result = await write(options.baselineRevision);
  } catch (writeFailure: unknown) {
    // Each query retains its own read failure for the panel's visible retry
    // action; keep the mutation failure as the error returned to the editor.
    await Promise.allSettled(filters.map((filter) => queryClient.refetchQueries(filter, { throwOnError: true })));
    throw writeFailure;
  }

  await Promise.all(filters.map((filter) => queryClient.cancelQueries(filter)));
  const writeOrder = readOrderFor(queryClient, primaryFilter.queryKey);
  writeOrder.committedSeq = ++writeOrder.nextSeq;
  queryClient.setQueryData(primaryFilter.queryKey, (current: unknown) =>
    options.updateCache(current, result));
  await Promise.all(filters.map((filter) => queryClient.invalidateQueries({ ...filter, refetchType: "none" })));
  await Promise.allSettled(filters.map((filter) => queryClient.refetchQueries(filter, { throwOnError: true })));
  return result;
});
