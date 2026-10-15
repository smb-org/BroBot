import { replaceEqualDeep, type QueryClient } from "@tanstack/react-query";

import type { PanelChannelOverview, PanelChannelState, PanelChannelsResponse, PanelModeratorStatus } from "../../panel-contract";
import { queryKeys } from "./keys";

const isAtLeastAsNewObservation = (
  incoming: PanelModeratorStatus | null,
  current: PanelModeratorStatus | null,
): boolean => {
  if (incoming === null) return current === null;
  if (current === null) return Number.isFinite(Date.parse(incoming.checkedAt));

  const incomingAt = Date.parse(incoming.checkedAt);
  const currentAt = Date.parse(current.checkedAt);
  return Number.isFinite(incomingAt) && (!Number.isFinite(currentAt) || incomingAt >= currentAt);
};

const isNewerObservation = (
  incoming: PanelModeratorStatus,
  current: PanelModeratorStatus | null,
): boolean => {
  const incomingAt = Date.parse(incoming.checkedAt);
  if (!Number.isFinite(incomingAt)) return false;
  if (current === null) return true;

  const currentAt = Date.parse(current.checkedAt);
  return !Number.isFinite(currentAt) || incomingAt > currentAt;
};

/** Keep the newest moderator observation when a full channel refresh lands. */
const mergeChannelRefresh = <T extends PanelChannelState>(
  previous: T | undefined,
  incoming: T,
): T => {
  if (previous === undefined || isAtLeastAsNewObservation(incoming.moderator, previous.moderator)) return incoming;
  return { ...incoming, moderator: previous.moderator };
};

/** Reconcile each channel's moderator observation in a full channels refresh. */
const mergeChannelsRefresh = (
  previous: PanelChannelsResponse | undefined,
  incoming: PanelChannelsResponse,
): PanelChannelsResponse => {
  if (previous === undefined) return incoming;
  const previousById = new Map(previous.channels.map((channel) => [channel.channelId, channel]));
  return {
    ...incoming,
    channels: incoming.channels.map((channel) => mergeChannelRefresh(previousById.get(channel.channelId), channel)),
  };
};

/** QueryClient's structural-sharing callback is untyped at its boundary. */
export const mergeChannelRefreshData = (previous: unknown, incoming: unknown): unknown =>
  replaceEqualDeep(previous, mergeChannelRefresh(previous as PanelChannelOverview | undefined, incoming as PanelChannelOverview));

/** QueryClient's structural-sharing callback is untyped at its boundary. */
export const mergeChannelsRefreshData = (previous: unknown, incoming: unknown): unknown =>
  replaceEqualDeep(previous, mergeChannelsRefresh(previous as PanelChannelsResponse | undefined, incoming as PanelChannelsResponse));

const withNewerModerator = <T extends PanelChannelState>(
  current: T | undefined,
  channelId: string,
  moderator: PanelModeratorStatus,
): T | undefined => {
  if (current === undefined || current.channelId !== channelId || !isNewerObservation(moderator, current.moderator)) return current;
  return { ...current, moderator };
};

/** Apply a moderator observation without changing the query's freshness time. */
export const updateChannelCache = (
  queryClient: QueryClient,
  channelId: string,
  moderator: PanelModeratorStatus,
): void => {
  const channelsKey = queryKeys.channels();
  const channelsState = queryClient.getQueryState<PanelChannelsResponse>(channelsKey);
  if (channelsState?.data !== undefined) {
    const channels = channelsState.data;
    const channel = channels.channels.find((entry) => entry.channelId === channelId);
    if (channel !== undefined && isNewerObservation(moderator, channel.moderator)) {
      queryClient.setQueryData<PanelChannelsResponse>(channelsKey, (current) => {
        if (current === undefined) return current;
        const currentChannel = current.channels.find((entry) => entry.channelId === channelId);
        const nextChannel = withNewerModerator(currentChannel, channelId, moderator);
        if (nextChannel === undefined || nextChannel === currentChannel) return current;
        return {
          ...current,
          channels: current.channels.map((entry) => entry.channelId === channelId ? nextChannel : entry),
        };
      }, { updatedAt: channelsState.dataUpdatedAt });
    }
  }

  const overviewKey = queryKeys.channel(channelId, "overview");
  const overviewState = queryClient.getQueryState<PanelChannelOverview>(overviewKey);
  if (overviewState?.data?.channelId === channelId && isNewerObservation(moderator, overviewState.data.moderator)) {
    queryClient.setQueryData<PanelChannelOverview>(overviewKey, (current) =>
      withNewerModerator(current, channelId, moderator),
    { updatedAt: overviewState.dataUpdatedAt });
  }
};

/** Ignore an async moderator result when the page that requested it has unmounted. */
export const runModeratorRecheck = async (
  queryClient: QueryClient,
  channelId: string,
  isCurrentPage: () => boolean,
  refresh: (channelId: string) => Promise<{ moderator: PanelModeratorStatus }>,
): Promise<void> => {
  if (!isCurrentPage()) return;
  const { moderator } = await refresh(channelId);
  if (!isCurrentPage()) return;
  updateChannelCache(queryClient, channelId, moderator);
};
