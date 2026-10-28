import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/dashboard/LiveCockpitBroadcast", () => ({ LiveCockpitBroadcast: () => null }));
vi.mock("../../src/dashboard/LiveCockpitParts", () => ({ LiveCockpitEventFeed: () => null, LiveCockpitTiles: () => null }));

import { LiveCockpit } from "../../src/dashboard/LiveCockpit";
import type { PanelChannelOverview, PanelModuleState } from "../../src/panel-contract";
import { setDashboardRealtimeStatus } from "../../src/dashboard/data/realtime";
import { renderWithQuery } from "../query-test-utils";

const channelId = "idle-cockpit-channel";

const overview = {
  channelId,
  displayName: "Idle cockpit",
  role: "manager",
  streamState: "online",
  streamStartedAt: "2026-10-28T09:00:00.000Z",
  viewerCount: 12,
  bot: { status: "connected" },
  location: { name: "Berlin", timeZone: "Europe/Berlin" },
} as unknown as PanelChannelOverview;

const modules = ["ads", "belabox", "chat_voting", "text_commands"].map((id) => ({ id, enabled: true })) as PanelModuleState[];

const responseBody = (path: string): unknown => {
  if (path.endsWith("/events/recent")) return { entries: [], cursor: null };
  if (path.endsWith("/overlays")) return { overlays: [] };
  if (path.endsWith("/settings")) return { timeZone: "Europe/Berlin" };
  if (path.endsWith("/variables/availability")) return { available: true };
  if (path.endsWith("/modules/chat_voting/current")) {
    return { vote: null, counts: null, revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 60 };
  }
  if (path.endsWith("/modules/belabox/status")) {
    return { configured: false, updatedAt: null, mode: null, sample: null, errorCode: null, polling: false, pollingDesired: false, streamId: null, belaboxStreamId: null, alertNotice: null, fetchFailureNotice: false, intervalSeconds: 30 };
  }
  if (path.endsWith("/modules/ads/schedule")) {
    return { schedule: { nextAdAt: null, duration: null, lastAdAt: null, prerollFreeTime: null, snoozeCount: null, snoozeRefreshAt: null }, recentAdBreaks: [], snoozeScopeAvailable: false };
  }
  return {};
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setDashboardRealtimeStatus(channelId, "offline");
});

describe("idle live cockpit polling", () => {
  it("keeps clock-driven ad freshness while revision-backed reads stay quiet during a connected minute", async () => {
    const paths: string[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const waitOnRealClock = (duration: number): Promise<void> => new Promise((resolve) => {
      realSetTimeout(resolve, duration);
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? new URL(input.url) : input instanceof URL ? input : new URL(input, window.location.href);
      paths.push(url.pathname);
      return Promise.resolve(new Response(JSON.stringify(responseBody(url.pathname)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }));
    setDashboardRealtimeStatus(channelId, "connected");
    vi.useFakeTimers();

    const view = renderWithQuery(<LiveCockpit overview={overview} modules={modules} modulesLoaded viewerUserId={channelId} onNavigate={() => undefined} />, {}, {
      gcTime: 600_000,
      staleTime: 600_000,
    });

    await act(async () => {
      await waitOnRealClock(50);
    });
    expect(paths).toEqual(expect.arrayContaining([
      `/api/channels/${channelId}/events/recent`,
      `/api/channels/${channelId}/overlays`,
      `/api/channels/${channelId}/settings`,
      `/api/channels/${channelId}/variables/availability`,
      `/api/channels/${channelId}/modules/chat_voting/current`,
      `/api/channels/${channelId}/modules/belabox/status`,
      `/api/channels/${channelId}/modules/ads/schedule`,
    ]));
    const initialRequestCount = paths.length;

    // Viewer counts and the mixed live-tile query retain their previous connected cadence.
    // The ad schedule is time-driven; revision-backed resources stay at their single request.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(paths).toHaveLength(initialRequestCount + 12);
    for (const path of [
      `/api/channels/${channelId}/events/recent`,
      `/api/channels/${channelId}/variables/availability`,
      `/api/channels/${channelId}/modules/chat_voting/current`,
      `/api/channels/${channelId}/modules/belabox/status`,
    ]) {
      expect(paths.filter((requestPath) => requestPath === path)).toHaveLength(1);
    }
    expect(paths.filter((requestPath) => requestPath === `/api/channels/${channelId}/modules/ads/schedule`)).toHaveLength(13);
    view.unmount();
  });
});
