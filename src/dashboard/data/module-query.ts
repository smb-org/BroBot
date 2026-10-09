import { keepPreviousData, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

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

export const moduleQueryKey = (channelId: string, moduleId: string, part: string) =>
  queryKeys.channel(channelId, `modules/${moduleId}/${part}`);

const revisionOf = (value: unknown): number | null => {
  if (typeof value !== "object" || value === null || !("revision" in value)) return null;
  const revision: unknown = Reflect.get(value, "revision");
  return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
};

const identityOf = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null) return null;
  for (const key of ["id", "name", "key"]) {
    const identity: unknown = Reflect.get(value, key);
    if (typeof identity === "string") return `${key}:${identity}`;
  }
  return null;
};

const preserveNewerRevisions = <Value,>(current: Value | undefined, next: Value): Value => {
  const currentRevision = revisionOf(current);
  const nextRevision = revisionOf(next);
  if (currentRevision !== null && nextRevision !== null) {
    return nextRevision < currentRevision ? current as Value : next;
  }

  if (Array.isArray(current) && Array.isArray(next)) {
    const currentByIdentity = new Map(current.flatMap((entry: unknown) => {
      const identity = identityOf(entry);
      return identity === null ? [] : [[identity, entry] as const];
    }));
    return next.map((entry: unknown) => {
      const identity = identityOf(entry);
      return identity === null ? entry : preserveNewerRevisions(currentByIdentity.get(identity), entry);
    }) as Value;
  }

  if (typeof current === "object" && current !== null && typeof next === "object" && next !== null &&
      !Array.isArray(current) && !Array.isArray(next)) {
    const currentRecord = current as Record<string, unknown>;
    const nextRecord = next as Record<string, unknown>;
    const merged = { ...nextRecord };
    for (const [key, nextValue] of Object.entries(nextRecord)) {
      if (Object.hasOwn(currentRecord, key)) {
        merged[key] = preserveNewerRevisions(currentRecord[key], nextValue);
      }
    }
    return merged as Value;
  }

  return next;
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
      return preserveNewerRevisions(queryClient.getQueryData<Value>(queryKey), result);
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
  queryClient.setQueryData(primaryFilter.queryKey, (current: unknown) =>
    preserveNewerRevisions(current, options.updateCache(current, result)));
  await Promise.all(filters.map((filter) => queryClient.invalidateQueries({ ...filter, refetchType: "none" })));
  await Promise.allSettled(filters.map((filter) => queryClient.refetchQueries(filter, { throwOnError: true })));
  return result;
};
