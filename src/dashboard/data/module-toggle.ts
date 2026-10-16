import type { QueryClient, QueryFilters } from "@tanstack/react-query";

import { queryKeys } from "./keys";

const moduleWriteQueues = new Map<string, Promise<void>>();

/** Serialize settings saves and enabled-state changes for one channel module. */
export const withModuleWriteLock = async <Value,>(
  channelId: string,
  moduleId: string,
  operation: () => Promise<Value>,
): Promise<Value> => {
  const key = JSON.stringify([channelId, moduleId]);
  const previous = moduleWriteQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  moduleWriteQueues.set(key, current);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (moduleWriteQueues.get(key) === current) moduleWriteQueues.delete(key);
  }
};

/**
 * The single owner of "a module's enabled state changed for this channel". Every successful
 * enable/disable (module list, header switch, command palette) calls it with the mutation's own channelId.
 * The overview carries activeModules, so it is cancelled first (a late in-flight response must not
 * restore stale data) and then invalidated even while inactive. Channels and modules queries only
 * refetch when active, so nothing is fetched twice.
 */
export const refreshAfterModuleToggle = async (queryClient: QueryClient, channelId: string): Promise<void> => {
  const overview: QueryFilters = { queryKey: queryKeys.channel(channelId, "overview"), exact: true };
  const modules: QueryFilters = { queryKey: queryKeys.channel(channelId, "modules"), exact: true };
  const channels: QueryFilters = { queryKey: queryKeys.channels(), exact: true };
  const moduleSettings = queryClient.getQueryCache()
    .findAll({ queryKey: ["channel", channelId, "module"] })
    .filter((query) => query.queryKey[4] === "settings")
    .map(({ queryKey }) => ({ queryKey, exact: true }));
  const refreshes = [overview, modules, channels, ...moduleSettings];
  await Promise.all(refreshes.map((filter) => queryClient.cancelQueries(filter)));
  await Promise.all([
    queryClient.invalidateQueries({ ...overview, refetchType: "all" }),
    queryClient.invalidateQueries(modules),
    queryClient.invalidateQueries(channels),
    ...moduleSettings.map((filter) => queryClient.invalidateQueries(filter)),
  ]);
};
