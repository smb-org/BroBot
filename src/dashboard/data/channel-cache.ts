import type { QueryClient } from "@tanstack/react-query";

import type { PanelChannelOverview, PanelChannelState, PanelChannelsResponse } from "../../panel-contract";
import { queryKeys } from "./keys";

export interface PartialChannelCacheUpdate {
  channel?: (current: PanelChannelState) => PanelChannelState;
  overview?: (current: PanelChannelOverview) => PanelChannelOverview;
}

/** Apply a partial channel update without making stale data appear newly refreshed. */
export const updateChannelCache = (
  queryClient: QueryClient,
  channelId: string,
  requestStartedAt: number,
  update: PartialChannelCacheUpdate,
): void => {
  if (update.channel !== undefined) {
    const updateChannel = update.channel;
    const key = queryKeys.channels();
    const state = queryClient.getQueryState<PanelChannelsResponse>(key);
    if (state?.data !== undefined && state.dataUpdatedAt < requestStartedAt) {
      queryClient.setQueryData<PanelChannelsResponse>(key, (current) => {
        if (current === undefined) return current;
        const currentChannel = current.channels.find((channel) => channel.channelId === channelId);
        if (currentChannel === undefined) return current;
        const nextChannel = updateChannel(currentChannel);
        if (nextChannel === currentChannel) return current;
        return {
          ...current,
          channels: current.channels.map((channel) => channel.channelId === channelId ? nextChannel : channel),
        };
      }, { updatedAt: state.dataUpdatedAt });
    }
  }

  if (update.overview !== undefined) {
    const updateOverview = update.overview;
    const key = queryKeys.channel(channelId, "overview");
    const state = queryClient.getQueryState<PanelChannelOverview>(key);
    if (state?.data?.channelId === channelId && state.dataUpdatedAt < requestStartedAt) {
      queryClient.setQueryData<PanelChannelOverview>(key, (current) =>
        current?.channelId === channelId ? updateOverview(current) : current,
      { updatedAt: state.dataUpdatedAt });
    }
  }
};
