import { keepPreviousData, useQuery, useQueryClient, type QueryClient, type QueryObserverResult } from "@tanstack/react-query";

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

type ModuleQueryRefetchResult<Value> = Pick<QueryObserverResult<Value>, "data" | "error" | "isError" | "isSuccess">;
type ModuleQueryRefetch<Value> = () => Promise<ModuleQueryRefetchResult<Value>>;

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

/** Return data only when the refetch itself succeeded; cached data survives failed refetches. */
export const refetchModuleQueryData = async <Value,>(refetch: ModuleQueryRefetch<Value>): Promise<Value> => {
  const result = await refetch();
  if (!result.isSuccess || result.isError || result.data === undefined) {
    throw result.error ?? new Error("Module query refetch failed.");
  }
  return result.data;
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
  return useQuery({
    queryKey,
    queryFn: async ({ signal }) => {
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
    },
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
): Promise<Value> => {
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
};
