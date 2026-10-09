import type { QueryClient, QueryFilters } from "@tanstack/react-query";

import { queryKeys } from "./keys";

/**
 * The single owner of "a module's enabled state changed for this channel". Every successful
 * enable/disable (module list, header switch, Spotlight) calls it with the mutation's own channelId.
 * The overview carries activeModules, so it is cancelled first (a late in-flight response must not
 * restore stale data) and then invalidated even while inactive. Channels and modules queries only
 * refetch when active, so nothing is fetched twice.
 */
export const refreshAfterModuleToggle = async (queryClient: QueryClient, channelId: string): Promise<void> => {
  const overview: QueryFilters = { queryKey: queryKeys.channel(channelId, "overview"), exact: true };
  const modules: QueryFilters = { queryKey: queryKeys.channel(channelId, "modules"), exact: true };
  const channels: QueryFilters = { queryKey: queryKeys.channels(), exact: true };
  await Promise.all([overview, modules, channels].map((filter) => queryClient.cancelQueries(filter)));
  await Promise.all([
    queryClient.invalidateQueries({ ...overview, refetchType: "all" }),
    queryClient.invalidateQueries(modules),
    queryClient.invalidateQueries(channels),
  ]);
};
