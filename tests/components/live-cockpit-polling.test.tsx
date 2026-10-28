import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImmediateActions as ImmediateActionsComponent } from "../../src/dashboard/ImmediateActions";

const mockActions = vi.hoisted(() => ({ manualResult: null as "failure" | "success" | null }));

vi.mock("../../src/dashboard/LiveCockpitBroadcast", () => ({ LiveCockpitBroadcast: () => null }));
vi.mock("../../src/dashboard/LiveCockpitParts", () => ({
  LiveCockpitEventFeed: () => null,
  LiveCockpitTiles: ({ snapshots }: { snapshots: readonly { kind: string }[] }) => <div data-testid="live-tiles">{snapshots.map(({ kind }) => kind).join(",")}</div>,
}));
vi.mock("../../src/dashboard/ImmediateActions", async (importOriginal) => {
  const original = await importOriginal<{ ImmediateActions: typeof ImmediateActionsComponent }>();
  return {
    ...original,
    ImmediateActions: (props: Parameters<typeof original.ImmediateActions>[0]) => {
      if (mockActions.manualResult === null) {
        const OriginalImmediateActions = original.ImmediateActions;
        return <OriginalImmediateActions {...props} />;
      }
      return <button onClick={() => {
        const observedAt = props.onActionStart?.("belabox", "check-belabox") ?? Date.now();
        if (mockActions.manualResult === "failure") {
          props.onActionFailure?.("belabox", "check-belabox", observedAt);
        } else {
          props.onActionResult?.("belabox", {
            belaboxSample: { connected: true, bitrateKbps: 2_500, sampledAt: Date.now() },
          }, observedAt);
        }
      }}>{mockActions.manualResult === "failure" ? "Record manual BELABOX failure" : "Record manual BELABOX success"}</button>;
    },
  };
});

import { LiveCockpit } from "../../src/dashboard/LiveCockpit";
import { dashboardTexts } from "../../src/dashboard/locale";
import type { PanelChannelOverview, PanelModuleState } from "../../src/panel-contract";
import { setDashboardRealtimeStatus } from "../../src/dashboard/data/realtime";
import { moduleQueryKey } from "../../src/dashboard/data/module-query";
import { renderWithQuery } from "../query-test-utils";

const channelId = "idle-cockpit-channel";
const belaboxLed = (): HTMLElement | null => document.querySelector(".live-cockpit-header__indicators .status-led:nth-child(2)");

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
  if (path.endsWith("/events")) return { entries: [], nextCursor: null };
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
  cleanup();
  mockActions.manualResult = null;
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
      `/api/channels/${channelId}/events`,
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

    expect(paths).toHaveLength(initialRequestCount + 14);
    for (const path of [
      `/api/channels/${channelId}/variables/availability`,
      `/api/channels/${channelId}/modules/chat_voting/current`,
      `/api/channels/${channelId}/modules/belabox/status`,
    ]) {
      expect(paths.filter((requestPath) => requestPath === path)).toHaveLength(1);
    }
    expect(paths.filter((requestPath) => requestPath === `/api/channels/${channelId}/events`)).toHaveLength(3);
    expect(paths.filter((requestPath) => requestPath === `/api/channels/${channelId}/modules/ads/schedule`)).toHaveLength(13);
    view.unmount();
  });

  it("keeps retrying failed revision-backed reads at the fallback interval while connected, then goes quiet", async () => {
    const counts = new Map<string, number>();
    const failing = ["/modules/chat_voting/current", "/modules/belabox/status"];
    const realSetTimeout = globalThis.setTimeout;
    const waitOnRealClock = (duration: number): Promise<void> => new Promise((resolve) => {
      realSetTimeout(resolve, duration);
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? new URL(input.url) : input instanceof URL ? input : new URL(input, window.location.href);
      const failingSuffix = failing.find((suffix) => url.pathname.endsWith(suffix));
      if (failingSuffix !== undefined) {
        const count = (counts.get(failingSuffix) ?? 0) + 1;
        counts.set(failingSuffix, count);
        // The initial load and the first fallback poll fail; the second fallback poll succeeds.
        if (count <= 2) return Promise.resolve(new Response(JSON.stringify({ error: "temporary_failure" }), { status: 503 }));
      }
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
    await act(async () => { await waitOnRealClock(50); });
    expect(failing.map((suffix) => counts.get(suffix))).toEqual([1, 1]);

    // Both queries are in error without data: the connected cockpit still polls them at the 5 s fallback.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(failing.map((suffix) => counts.get(suffix))).toEqual([2, 2]);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(failing.map((suffix) => counts.get(suffix))).toEqual([3, 3]);
    expect(view.queryClient.getQueryState(moduleQueryKey(channelId, "belabox", "status"))?.status).toBe("success");

    // Once loaded, they wait for their revision again.
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(failing.map((suffix) => counts.get(suffix))).toEqual([3, 3]);
    view.unmount();
  });

  it("hides cached tiles and their controls after their modules are disabled", async () => {
    const now = Date.now();
    const disabledModules = ["chat_voting", "timers", "votekick"].map((id) => ({ id, enabled: false })) as PanelModuleState[];
    const cachedVote = {
      vote: {
        id: "cached-vote", channelId, kind: "poll", optionCount: 2, labels: ["Yes", "No"], answerColors: [], title: "Cached ballot",
        status: "open", openedAt: new Date(now).toISOString(), closesAt: new Date(now + 60_000).toISOString(),
        requestedDurationSeconds: 60, closedAt: null, closeReason: "timer", counts: [3, 1], voterCount: 4,
      },
      counts: [3, 1], revision: 4, terms: null, moreTerms: null, hasOpenBallot: true, defaultDurationSeconds: 60,
    };
    const cachedTimer = [{ id: "cached-timer", name: "Cached timer", enabled: true, nextRunAt: new Date(now + 60_000).toISOString() }];
    const cachedVotekick = {
      running: { id: "cached-votekick", targetLogin: "cachedviewer", targetUserId: "user-1", endsAt: new Date(now + 60_000).toISOString(), yesVotes: 3, noVotes: 0, threshold: 3 },
      votekicks: [], now: new Date(now).toISOString(),
    };
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? new URL(input.url) : input instanceof URL ? input : new URL(input, window.location.href);
      paths.push(url.pathname);
      return Promise.resolve(new Response(JSON.stringify(responseBody(url.pathname)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }));
    const view = renderWithQuery(<LiveCockpit overview={overview} modules={disabledModules} modulesLoaded viewerUserId={channelId} onNavigate={() => undefined} />, {}, {
      gcTime: 600_000,
      staleTime: 600_000,
      initialData: [
        { queryKey: moduleQueryKey(channelId, "chat_voting", "live"), data: cachedVote },
        { queryKey: moduleQueryKey(channelId, "timers", "upcoming"), data: cachedTimer },
        { queryKey: moduleQueryKey(channelId, "votekick", "panel"), data: cachedVotekick },
      ],
    });

    await act(async () => { await Promise.resolve(); });
    expect(view.queryClient.getQueryData(moduleQueryKey(channelId, "chat_voting", "live"))).toBe(cachedVote);
    expect(view.queryClient.getQueryData(moduleQueryKey(channelId, "timers", "upcoming"))).toBe(cachedTimer);
    expect(view.queryClient.getQueryData(moduleQueryKey(channelId, "votekick", "panel"))).toBe(cachedVotekick);
    expect(screen.getByTestId("live-tiles").textContent).toBe("");
    expect(paths).not.toContain(`/api/channels/${channelId}/modules/chat_voting/current`);
  });

  it("keeps a later manual BELABOX check ahead of a status request that finishes afterward", async () => {
    mockActions.manualResult = "failure";
    const paths: string[] = [];
    let finishStatus: ((response: Response) => void) | undefined;
    const delayedStatus = new Promise<Response>((resolve) => { finishStatus = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? new URL(input.url) : input instanceof URL ? input : new URL(input, window.location.href);
      paths.push(url.pathname);
      if (url.pathname.endsWith("/modules/belabox/status")) return delayedStatus;
      return Promise.resolve(new Response(JSON.stringify(responseBody(url.pathname)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }));
    renderWithQuery(<LiveCockpit overview={overview} modules={modules} modulesLoaded viewerUserId={channelId} onNavigate={() => undefined} />, {}, {
      gcTime: 600_000,
      staleTime: 600_000,
    });

    await waitFor(() => expect(paths).toContain(`/api/channels/${channelId}/modules/belabox/status`));
    fireEvent.click(screen.getByRole("button", { name: "Record manual BELABOX failure" }));
    const unavailable = dashboardTexts().liveCockpit.belaboxUnavailable;
    expect(screen.getByText((text) => text.includes(unavailable)).textContent).toContain(unavailable);

    await act(async () => {
      finishStatus?.(new Response(JSON.stringify({
        configured: true,
        updatedAt: new Date().toISOString(),
        mode: "interval",
        sample: {
          at: new Date().toISOString(), connected: true, bitrateKbps: 2_500, rttMs: 1, latencyMs: 1, network: 0,
          droppedPackets: 0, phase: "healthy",
        },
        errorCode: null, polling: true, pollingDesired: true, streamId: "stream-1", belaboxStreamId: "stream-1",
        alertNotice: null, fetchFailureNotice: false, intervalSeconds: 30,
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
      await delayedStatus;
    });

    await waitFor(() => expect(screen.getByText((text) => text.includes(unavailable)).textContent).toContain(unavailable));
  });

  it("lets a later healthy status observation replace a manual failure", async () => {
    mockActions.manualResult = "failure";
    let statusCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? new URL(input.url) : input instanceof URL ? input : new URL(input, window.location.href);
      if (url.pathname.endsWith("/modules/belabox/status")) {
        statusCalls += 1;
        if (statusCalls === 1) return Promise.resolve(new Response(JSON.stringify({ error: "temporary_failure" }), { status: 503 }));
        return Promise.resolve(new Response(JSON.stringify({
          configured: true,
          updatedAt: new Date().toISOString(),
          mode: "interval",
          sample: {
            at: new Date().toISOString(), connected: true, bitrateKbps: 2_500, rttMs: 1, latencyMs: 1, network: 0,
            droppedPackets: 0, phase: "healthy",
          },
          errorCode: null, polling: true, pollingDesired: true, streamId: "stream-1", belaboxStreamId: "stream-1",
          alertNotice: null, fetchFailureNotice: false, intervalSeconds: 30,
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return Promise.resolve(new Response(JSON.stringify(responseBody(url.pathname)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }));
    const view = renderWithQuery(<LiveCockpit overview={overview} modules={modules} modulesLoaded viewerUserId={channelId} onNavigate={() => undefined} />, {}, {
      gcTime: 600_000,
      staleTime: 600_000,
    });

    const unavailable = dashboardTexts().liveCockpit.belaboxUnavailable;
    await waitFor(() => expect(screen.getByText((text) => text.includes(unavailable)).textContent).toContain(unavailable));
    fireEvent.click(screen.getByRole("button", { name: "Record manual BELABOX failure" }));

    await act(async () => {
      await view.queryClient.refetchQueries({ queryKey: moduleQueryKey(channelId, "belabox", "status"), exact: true });
    });

    await waitFor(() => expect(belaboxLed()?.textContent).toContain("2.500"));
  });

  it("lets a newer successful manual check replace a status-query error", async () => {
    mockActions.manualResult = "success";
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? new URL(input.url) : input instanceof URL ? input : new URL(input, window.location.href);
      if (url.pathname.endsWith("/modules/belabox/status")) {
        return Promise.resolve(new Response(JSON.stringify({ error: "temporary_failure" }), { status: 503 }));
      }
      return Promise.resolve(new Response(JSON.stringify(responseBody(url.pathname)), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }));
    renderWithQuery(<LiveCockpit overview={overview} modules={modules} modulesLoaded viewerUserId={channelId} onNavigate={() => undefined} />, {}, {
      gcTime: 600_000,
      staleTime: 600_000,
    });

    const unavailable = dashboardTexts().liveCockpit.belaboxUnavailable;
    await waitFor(() => expect(screen.getByText((text) => text.includes(unavailable)).textContent).toContain(unavailable));
    fireEvent.click(screen.getByRole("button", { name: "Record manual BELABOX success" }));

    await waitFor(() => expect(belaboxLed()?.textContent).toContain("2.500"));
  });

  it("retains the request timestamp when a status refetch structurally shares response data", async () => {
    mockActions.manualResult = "failure";
    const healthyStatus = {
      configured: true,
      updatedAt: new Date().toISOString(),
      mode: "interval",
      sample: {
        at: new Date().toISOString(), connected: true, bitrateKbps: 2_500, rttMs: 1, latencyMs: 1, network: 0,
        droppedPackets: 0, phase: "healthy",
      },
      errorCode: null, polling: true, pollingDesired: true, streamId: "stream-1", belaboxStreamId: "stream-1",
      alertNotice: null, fetchFailureNotice: false, intervalSeconds: 30,
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? new URL(input.url) : input instanceof URL ? input : new URL(input, window.location.href);
      const body = url.pathname.endsWith("/modules/belabox/status") ? healthyStatus : responseBody(url.pathname);
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }));
    const view = renderWithQuery(<LiveCockpit overview={overview} modules={modules} modulesLoaded viewerUserId={channelId} onNavigate={() => undefined} />, {}, {
      gcTime: 600_000,
      staleTime: 600_000,
    });

    await waitFor(() => expect(belaboxLed()?.textContent).toContain("2.500"));
    fireEvent.click(screen.getByRole("button", { name: "Record manual BELABOX failure" }));
    const unavailable = dashboardTexts().liveCockpit.belaboxUnavailable;
    await waitFor(() => expect(screen.getByText((text) => text.includes(unavailable)).textContent).toContain(unavailable));

    await act(async () => {
      await view.queryClient.refetchQueries({ queryKey: moduleQueryKey(channelId, "belabox", "status"), exact: true });
    });

    await waitFor(() => expect(belaboxLed()?.textContent).toContain("2.500"));
    expect(view.queryClient.getQueryData<{ observedAt?: number }>(moduleQueryKey(channelId, "belabox", "status"))?.observedAt).toEqual(expect.any(Number));
  });
});
