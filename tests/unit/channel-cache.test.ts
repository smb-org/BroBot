import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import type { PanelChannelOverview, PanelChannelState, PanelChannelsResponse } from "../../src/panel-contract";
import { updateChannelCache } from "../../src/dashboard/data/channel-cache";
import { queryKeys } from "../../src/dashboard/data/keys";

const channel = (channelId: string, isModerator: boolean): PanelChannelState => ({
  channelId,
  moderator: { isModerator, checkedAt: "2026-10-15T08:00:00.000Z", reason: null },
} as PanelChannelState);

describe("updateChannelCache", () => {
  it("updates viewer count without replacing newer overview controls or tokens", () => {
    const queryClient = new QueryClient();
    const controls = { mute: { active: true }, pause: { active: false } };
    const tokens = { botExpiresAt: "2030-01-01T00:00:00.000Z", loginStatus: "connected", loginReason: null, loginExpiresAt: "2030-01-01T00:00:00.000Z" };
    const overview = { ...channel("channel-a", true), viewerCount: 42, controls, tokens, activeModules: [] } as unknown as PanelChannelOverview;
    queryClient.setQueryData(queryKeys.channel("channel-a", "overview"), overview, { updatedAt: 200 });

    updateChannelCache(queryClient, "channel-a", 300, {
      overview: (current) => ({ ...current, viewerCount: 91 }),
    });

    const next = queryClient.getQueryData<PanelChannelOverview>(queryKeys.channel("channel-a", "overview"));
    expect(next?.viewerCount).toBe(91);
    expect(next?.controls).toBe(controls);
    expect(next?.tokens).toBe(tokens);
    expect(queryClient.getQueryState(queryKeys.channel("channel-a", "overview"))?.dataUpdatedAt).toBe(200);
    queryClient.clear();
  });

  it("keeps cache freshness and updates only the requested channel", () => {
    const queryClient = new QueryClient();
    const firstChannel = channel("channel-a", false);
    const otherChannel = channel("channel-b", false);
    const channelsResponse = {
      channels: [firstChannel, otherChannel], bot: null, platformAdmin: false, viewerIsBot: false,
    } as PanelChannelsResponse;
    const overview = { ...firstChannel, activeModules: [] } as PanelChannelOverview;
    queryClient.setQueryData(queryKeys.channels(), channelsResponse, { updatedAt: 100 });
    queryClient.setQueryData(queryKeys.channel("channel-a", "overview"), overview, { updatedAt: 200 });
    const updatedAt = { channels: queryClient.getQueryState(queryKeys.channels())?.dataUpdatedAt, overview: queryClient.getQueryState(queryKeys.channel("channel-a", "overview"))?.dataUpdatedAt };
    const checkedModerator = { isModerator: true, checkedAt: "2026-10-15T08:01:00.000Z", reason: null };

    updateChannelCache(queryClient, "channel-a", 300, {
      channel: (current) => ({ ...current, moderator: checkedModerator }),
      overview: (current) => ({ ...current, moderator: checkedModerator }),
    });

    const nextChannels = queryClient.getQueryData<PanelChannelsResponse>(queryKeys.channels());
    const nextOverview = queryClient.getQueryData<PanelChannelOverview>(queryKeys.channel("channel-a", "overview"));
    expect(nextChannels?.channels[0]?.moderator).toEqual(checkedModerator);
    expect(nextChannels?.channels[1]).toBe(otherChannel);
    expect(nextOverview?.moderator).toEqual(checkedModerator);
    expect(queryClient.getQueryState(queryKeys.channels())?.dataUpdatedAt).toBe(updatedAt.channels);
    expect(queryClient.getQueryState(queryKeys.channel("channel-a", "overview"))?.dataUpdatedAt).toBe(updatedAt.overview);
    queryClient.clear();
  });

  it("rejects a partial response that started before a full refresh", () => {
    const queryClient = new QueryClient();
    const initial = channel("channel-a", false);
    const fullRefresh = channel("channel-a", true);
    const response = {
      channels: [fullRefresh], bot: null, platformAdmin: false, viewerIsBot: false,
    } as PanelChannelsResponse;
    queryClient.setQueryData(queryKeys.channels(), response, { updatedAt: 200 });

    updateChannelCache(queryClient, "channel-a", 100, {
      channel: (current) => ({ ...current, moderator: { isModerator: false, checkedAt: "2026-10-15T07:59:00.000Z", reason: null } }),
    });
    updateChannelCache(queryClient, "channel-a", 200, {
      channel: (current) => ({ ...current, moderator: { isModerator: false, checkedAt: "2026-10-15T07:59:00.000Z", reason: null } }),
    });

    expect(queryClient.getQueryData<PanelChannelsResponse>(queryKeys.channels())?.channels[0]).toBe(fullRefresh);
    expect(queryClient.getQueryData<PanelChannelsResponse>(queryKeys.channels())?.channels[0]).not.toBe(initial);
    expect(queryClient.getQueryState(queryKeys.channels())?.dataUpdatedAt).toBe(200);
    queryClient.clear();
  });
});
