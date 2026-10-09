import { keepPreviousData, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { queryKeys } from "./keys";

export type ModuleQueryFunction<Value> = (signal: AbortSignal) => Promise<Value>;
export interface ModuleQueryPart {
  moduleId: string;
  part: string;
}

export interface ModuleQueryWriteOptions<Value> {
  relatedParts?: readonly ModuleQueryPart[];
  updateCache?: (current: unknown, result: Value) => unknown;
}

export const moduleQueryKey = (channelId: string, moduleId: string, part: string) =>
  queryKeys.channel(channelId, `modules/${moduleId}/${part}`);

const revisionOf = (value: unknown): number | null => {
  if (typeof value !== "object" || value === null || !("revision" in value)) return null;
  const revision: unknown = Reflect.get(value, "revision");
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
};

const preserveNewerRevision = <Value,>(current: Value | undefined, next: Value): Value => {
  const currentRevision = revisionOf(current);
  const nextRevision = revisionOf(next);
  return currentRevision !== null && nextRevision !== null && nextRevision < currentRevision ? current as Value : next;
};

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
      const result = await fn(signal);
      return preserveNewerRevision(queryClient.getQueryData<Value>(queryKey), result);
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
 * Cancel reads around a successful module write, then refetch the active query.
 * This prevents a read started before the write from restoring an older revision.
 */
export const runModuleQueryWrite = async <Value,>(
  queryClient: QueryClient,
  channelId: string,
  moduleId: string,
  part: string,
  write: () => Promise<Value>,
  options: ModuleQueryWriteOptions<Value> = {},
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
  const result = await write();
  await Promise.all(filters.map((filter) => queryClient.cancelQueries(filter)));
  const resultRevision = revisionOf(result);
  const updateCache = options.updateCache;
  if (resultRevision !== null && updateCache !== undefined) {
    queryClient.setQueryData(primaryFilter.queryKey, (current: unknown) => {
      const currentRevision = revisionOf(current);
      if (currentRevision !== null && currentRevision > resultRevision) return current;
      return updateCache(current, result);
    });
  }
  await Promise.all(filters.map((filter) => queryClient.invalidateQueries(filter)));
  return result;
};
