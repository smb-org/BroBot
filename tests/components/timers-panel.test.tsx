import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { moduleQueryKey } from "../../src/dashboard/data";
import TimersPanel from "../../src/modules/timers/panel";
import { renderWithQuery } from "../query-test-utils";
import { jsonResponse } from "../unit/fixtures";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Timers panel", () => {
  it("keeps live and offline interval rows visible with an explicit save action", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/timers")) return Promise.resolve(jsonResponse({ timers: [] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({
        timeZone: "UTC", revision: 1, location: null, locationRevision: 1,
        defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
      }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    renderWithQuery(<UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Create timer" }));

    expect(screen.getByRole("switch", { name: "Live" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Offline" })).not.toBeChecked();
    expect(screen.getByText("offline off")).toBeInTheDocument();
    expect(screen.getAllByRole("spinbutton", { name: "Minutes" })).toHaveLength(1);
    expect(screen.getAllByRole("spinbutton", { name: "Minimum chat messages" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "Offline" }));
    expect(screen.queryByText("offline off")).not.toBeInTheDocument();
    expect(screen.getAllByRole("spinbutton", { name: "Minutes" })).toHaveLength(2);
    expect(screen.getAllByRole("spinbutton", { name: "Minimum chat messages" })).toHaveLength(2);
  });

  it("offers the channel-default inheritance option when creating a timer", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/timers")) return Promise.resolve(jsonResponse({ timers: [] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({
        timeZone: "UTC", revision: 1, location: null, locationRevision: 1,
        defaultChatTarget: "all_chats", defaultChatTargetRevision: 1,
      }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    renderWithQuery(<UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Create timer" }));
    fireEvent.click(await screen.findByRole("button", { name: "Chat target" }));

    expect(await screen.findByRole("radio", { name: /Kanaleinstellung verwenden \(Alle Chats\)|Use channel default \(All chats\)/u, hidden: true })).toBeInTheDocument();
  });

  it("keeps a reserved list area when no timers are configured", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/timers")) return Promise.resolve(jsonResponse({ timers: [] }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    renderWithQuery(<UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>);

    expect(await screen.findByTestId("timers-list-slot")).toBeInTheDocument();
  });

  it("shows cached timers immediately when the panel is mounted again", async () => {
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/timers")) return Promise.resolve(jsonResponse({ timers: [{
        id: "timer-1", name: "Greeting timer", enabled: true, messageText: "Hello there!", chatTarget: "source_only",
        trigger: { type: "interval", live: { minutes: 30 } }, revision: 1, nextRunAt: null, nextRunStreamId: null, nextRunState: null,
        lastRunAt: null, createdAt: "2026-09-19T12:00:00.000Z", updatedAt: "2026-09-19T12:00:00.000Z",
      }] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({
        timeZone: "UTC", revision: 1, location: null, locationRevision: 1,
        defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
      }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);

    const view = renderWithQuery(
      <UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>,
      {},
      { gcTime: 600_000, staleTime: 600_000 },
    );
    expect(await screen.findByText("Greeting timer")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(4);

    view.rerender(<UiProvider>{null}</UiProvider>);
    view.rerender(<UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>);

    expect(screen.getByText("Greeting timer")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("keeps a committed timer revision when the post-save refresh fails and offers retry", async () => {
    let enabled = true;
    let revision = 1;
    let timerReads = 0;
    let refreshFails = false;
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      if (url.pathname.endsWith("/timers/timer-1/enabled") && method === "PATCH") {
        if (typeof init?.body !== "string") throw new Error("Expected the timer enable request to have a JSON body.");
        const body = JSON.parse(init.body) as { enabled: boolean; revision: number };
        expect(body.revision).toBe(1);
        enabled = body.enabled;
        revision = 2;
        refreshFails = true;
        return Promise.resolve(jsonResponse({ timer: {
          id: "timer-1", name: "Greeting timer", enabled, messageText: "Hello there!", chatTarget: "source_only",
          trigger: { type: "interval", live: { minutes: 30 } }, revision, nextRunAt: null, nextRunStreamId: null, nextRunState: null,
          lastRunAt: null, createdAt: "2026-09-19T12:00:00.000Z", updatedAt: "2026-09-19T12:00:00.000Z",
        } }));
      }
      if (url.pathname.endsWith("/timers")) {
        timerReads += 1;
        if (timerReads > 1 && refreshFails) return Promise.resolve(jsonResponse({ error: "temporarily unavailable" }, 503));
        return Promise.resolve(jsonResponse({ timers: [{
          id: "timer-1", name: "Greeting timer", enabled, messageText: "Hello there!", chatTarget: "source_only",
          trigger: { type: "interval", live: { minutes: 30 } }, revision, nextRunAt: null, nextRunStreamId: null, nextRunState: null,
          lastRunAt: null, createdAt: "2026-09-19T12:00:00.000Z", updatedAt: "2026-09-19T12:00:00.000Z",
        }] }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);

    const { queryClient } = renderWithQuery(
      <UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>,
      {},
      { gcTime: 600_000, staleTime: 600_000 },
    );
    fireEvent.click(await screen.findByRole("switch", { name: "Greeting timer: Enabled" }));

    expect(await screen.findByRole("switch", { name: "Greeting timer: Disabled" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Timers could not be loaded.")).toBeInTheDocument());
    expect(timerReads).toBeGreaterThan(1);
    expect(queryClient.getQueryData<{ timers: { enabled: boolean; revision: number }[] }>(moduleQueryKey("channel-a", "timers", "panel"))?.timers[0])
      .toMatchObject({ enabled: false, revision: 2 });
    const retryButton = screen.getByRole("button", { name: /Retry|Erneut versuchen/u });
    refreshFails = false;
    fireEvent.click(retryButton);
    await waitFor(() => expect(screen.queryByText("Timers could not be loaded.")).not.toBeInTheDocument());
    expect(screen.getByRole("switch", { name: "Greeting timer: Disabled" })).toBeInTheDocument();
    expect(timerReads).toBeGreaterThan(2);
  });

  it("keeps the create action visible and disabled for operators", () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/timers")) return Promise.resolve(jsonResponse({ timers: [] }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    renderWithQuery(<UiProvider><TimersPanel channelId="channel-a" language="en" canManage={false} /></UiProvider>);

    expect(screen.getByRole("button", { name: "Create timer" })).toBeDisabled();
    expect(screen.getByText("Only broadcasters and managers can edit timers.")).toBeInTheDocument();
  });
});
