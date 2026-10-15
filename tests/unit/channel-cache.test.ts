import { QueryClient } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { createElement, useCallback } from "react";
import { describe, expect, it, vi } from "vitest";

import type { PanelChannelOverview, PanelChannelState, PanelChannelsResponse, PanelModeratorStatus } from "../../src/panel-contract";
import { mergeChannelRefreshData, mergeChannelsRefreshData, runModeratorRecheck, updateChannelCache } from "../../src/dashboard/data/channel-cache";
import { useMountedPageGuard } from "../../src/dashboard/data/page-generation";
import { queryKeys } from "../../src/dashboard/data/keys";

const status = (checkedAt: number, isModerator: boolean): PanelModeratorStatus => ({
  isModerator,
  checkedAt: new Date(checkedAt).toISOString(),
  reason: null,
});

const channel = (channelId: string, moderator: PanelModeratorStatus | null): PanelChannelState => ({
  channelId,
  moderator,
} as PanelChannelState);

const channelsResponse = (entry: PanelChannelState): PanelChannelsResponse => ({
  channels: [entry], bot: null, platformAdmin: false, viewerIsBot: false,
});

describe("updateChannelCache", () => {
  it("keeps the newer moderator observation when partial responses arrive out of order", () => {
    const queryClient = new QueryClient();
    const initial = status(100, false);
    const channels = channelsResponse(channel("channel-a", initial));
    const overview: PanelChannelOverview = { ...channel("channel-a", initial), activeModules: [] };
    queryClient.setQueryData(queryKeys.channels(), channels, { updatedAt: 200 });
    queryClient.setQueryData(queryKeys.channel("channel-a", "overview"), overview, { updatedAt: 300 });
    const newer = status(300, true);
    const older = status(200, false);

    updateChannelCache(queryClient, "channel-a", newer);
    updateChannelCache(queryClient, "channel-a", older);

    expect(queryClient.getQueryData<PanelChannelsResponse>(queryKeys.channels())?.channels[0]?.moderator).toEqual(newer);
    expect(queryClient.getQueryData<PanelChannelOverview>(queryKeys.channel("channel-a", "overview"))?.moderator).toEqual(newer);
    expect(queryClient.getQueryState(queryKeys.channels())?.dataUpdatedAt).toBe(200);
    expect(queryClient.getQueryState(queryKeys.channel("channel-a", "overview"))?.dataUpdatedAt).toBe(300);
    queryClient.clear();
  });

  it("keeps a newer moderator check across an intervening full refresh", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const channelsKey = queryKeys.channels();
    const overviewKey = queryKeys.channel("channel-a", "overview");
    queryClient.setQueryDefaults(channelsKey, { structuralSharing: mergeChannelsRefreshData });
    queryClient.setQueryDefaults(overviewKey, { structuralSharing: mergeChannelRefreshData });

    const initial = status(100, false);
    const startingChannel = channel("channel-a", initial);
    queryClient.setQueryData(channelsKey, channelsResponse(startingChannel), { updatedAt: 100 });
    queryClient.setQueryData(overviewKey, { ...startingChannel, activeModules: [] }, { updatedAt: 100 });

    let resolveRefresh: ((result: { moderator: PanelModeratorStatus }) => void) | undefined;
    const pendingRefresh = new Promise<{ moderator: PanelModeratorStatus }>((resolve) => { resolveRefresh = resolve; });
    const request = runModeratorRecheck(queryClient, "channel-a", () => true, () => pendingRefresh);
    const interveningRefresh = status(200, false);
    await Promise.all([
      queryClient.query({
        queryKey: channelsKey,
        queryFn: () => Promise.resolve(channelsResponse(channel("channel-a", interveningRefresh))),
      }),
      queryClient.query({
        queryKey: overviewKey,
        queryFn: () => Promise.resolve({ ...channel("channel-a", interveningRefresh), activeModules: [] }),
      }),
    ]);

    const newerCheck = status(300, true);
    if (resolveRefresh === undefined) throw new Error("Expected a pending moderator check.");
    resolveRefresh({ moderator: newerCheck });
    await request;

    const olderRefresh = status(250, false);
    await Promise.all([
      queryClient.query({
        queryKey: channelsKey,
        queryFn: () => Promise.resolve(channelsResponse(channel("channel-a", olderRefresh))),
      }),
      queryClient.query({
        queryKey: overviewKey,
        queryFn: () => Promise.resolve({ ...channel("channel-a", olderRefresh), activeModules: [] }),
      }),
    ]);

    expect(queryClient.getQueryData<PanelChannelsResponse>(channelsKey)?.channels[0]?.moderator).toEqual(newerCheck);
    expect(queryClient.getQueryData<PanelChannelOverview>(overviewKey)?.moderator).toEqual(newerCheck);
    queryClient.clear();
  });

  it("does not write a moderator result after its System page unmounts", async () => {
    const queryClient = new QueryClient();
    const initial = status(100, false);
    const channelsKey = queryKeys.channels();
    const overviewKey = queryKeys.channel("channel-a", "overview");
    queryClient.setQueryData(channelsKey, channelsResponse(channel("channel-a", initial)), { updatedAt: 200 });
    queryClient.setQueryData(overviewKey, { ...channel("channel-a", initial), activeModules: [] }, { updatedAt: 300 });
    let resolveRefresh: ((result: { moderator: PanelModeratorStatus }) => void) | undefined;
    const pendingRefresh = new Promise<{ moderator: PanelModeratorStatus }>((resolve) => { resolveRefresh = resolve; });
    const refresh = vi.fn(() => pendingRefresh);
    let recheck: Promise<void> | undefined;

    function SystemPageHarness() {
      const isCurrentPage = useMountedPageGuard();
      const onClick = useCallback(() => {
        recheck = runModeratorRecheck(queryClient, "channel-a", isCurrentPage, refresh);
      }, [isCurrentPage]);
      return createElement("button", { type: "button", onClick }, "Recheck");
    }

    const page = render(createElement(SystemPageHarness));
    fireEvent.click(screen.getByRole("button", { name: "Recheck" }));
    expect(refresh).toHaveBeenCalledOnce();
    page.unmount();

    await act(async () => {
      if (resolveRefresh === undefined || recheck === undefined) throw new Error("Expected a pending moderator check.");
      resolveRefresh({ moderator: status(400, true) });
      await recheck;
    });

    expect(queryClient.getQueryData<PanelChannelsResponse>(channelsKey)?.channels[0]?.moderator).toEqual(initial);
    expect(queryClient.getQueryData<PanelChannelOverview>(overviewKey)?.moderator).toEqual(initial);
    expect(queryClient.getQueryState(channelsKey)?.dataUpdatedAt).toBe(200);
    expect(queryClient.getQueryState(overviewKey)?.dataUpdatedAt).toBe(300);
    queryClient.clear();
  });
});
