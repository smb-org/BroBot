import { useQuery } from "@tanstack/react-query";

import { fetchChannelSettings } from "../api";
import { queryKeys } from "./keys";

export const useChannelSettings = (channelId: string) => useQuery({
  queryKey: queryKeys.channel(channelId, "settings"),
  queryFn: ({ signal }) => fetchChannelSettings(channelId, signal),
  staleTime: 60_000,
});
