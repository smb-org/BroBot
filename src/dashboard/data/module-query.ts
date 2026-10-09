import { hashKey, keepPreviousData, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

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

export type ModuleQueryWriteFunction<Value> = (baselineRevision: ModuleQueryRevision) => Promise<Value>;

const writeGenerations = new WeakMap<QueryClient, Map<string, number>>();

const generationKey = (queryKey: readonly unknown[]): string => JSON.stringify(queryKey);

const writeGenerationFor = (queryClient: QueryClient, queryKey: readonly unknown[]): number =>
  writeGenerations.get(queryClient)?.get(generationKey(queryKey)) ?? 0;

const commitWriteGeneration = (queryClient: QueryClient, queryKey: readonly unknown[]): number => {
  let generations = writeGenerations.get(queryClient);
  if (generations === undefined) {
    generations = new Map();
    writeGenerations.set(queryClient, generations);
  }
  const key = generationKey(queryKey);
  const generation = (generations.get(key) ?? 0) + 1;
  generations.set(key, generation);
  return generation;
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

/** Read through `fn`, discarding results that started before the latest committed write. */
const readModuleData = async <Value,>(
  queryClient: QueryClient,
  queryKey: readonly unknown[],
  fn: ModuleQueryFunction<Value>,
  signal: AbortSignal,
): Promise<Value> => {
  let readGeneration = writeGenerationFor(queryClient, queryKey);
  for (;;) {
    const result = await fn(signal);
    const latestGeneration = writeGenerationFor(queryClient, queryKey);
    if (readGeneration >= latestGeneration) return result;

    const current = queryClient.getQueryData<Value>(queryKey);
    if (current !== undefined) return current;
    if (signal.aborted) throw signal.reason ?? new Error("Module query read was cancelled.");

    // A dependent resource may not have been cached when the write committed.
    // Start a fresh read at the committed generation instead of accepting this one.
    readGeneration = latestGeneration;
  }
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
    const startedAt = Date.now();
    const value = await fn(new AbortController().signal);
    // A read or committed write that landed while this one was in flight is newer
    // server-confirmed state; never regress the cache to this older snapshot.
    const landed = queryClient.getQueryState<Value>(queryKey);
    if (landed?.data !== undefined && landed.dataUpdatedAt > startedAt) return landed.data;
    // Older background reads must not overwrite this fresher value.
    commitWriteGeneration(queryClient, queryKey);
    queryClient.setQueryData(queryKey, value);
    return value;
  });
};

export const moduleQueryKey = (channelId: string, moduleId: string, part: string) =>
  queryKeys.channel(channelId, `modules/${moduleId}/${part}`);

export const useModuleQuery = <Value,>(
  channelId: string,
  moduleId: string,
  part: string,
  fn: ModuleQueryFunction<Value>,
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
    placeholderData: (previousData, previousQuery) => {
      const previousKey = previousQuery?.queryKey;
      const resource = `modules/${moduleId}/${part}`;
      return previousKey?.[0] === "channel" && previousKey[1] === channelId && previousKey[2] === resource
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
  filters.forEach((filter) => { commitWriteGeneration(queryClient, filter.queryKey); });
  queryClient.setQueryData(primaryFilter.queryKey, (current: unknown) =>
    options.updateCache(current, result));
  await Promise.all(filters.map((filter) => queryClient.invalidateQueries({ ...filter, refetchType: "none" })));
  await Promise.allSettled(filters.map((filter) => queryClient.refetchQueries(filter, { throwOnError: true })));
  return result;
});
