import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StatisticsStreamsPanel } from "../../src/modules/statistics/panel";
import type { StatisticsStreamDetailResponse, StatisticsStreamListResponse } from "../../src/modules/statistics/contracts";

const summary = {
  streamId: "stream-1",
  startedAt: "2026-10-24T19:00:00.000Z",
  endedAt: "2026-10-24T21:00:00.000Z",
  durationSeconds: 7_200,
  title: "A long evening",
  categories: ["Game One", "Just Chatting"],
  averageViewers: 214,
  peakViewers: 312,
  peakAt: "2026-10-24T20:15:00.000Z",
  messages: 10_075,
  averageActiveChatters: 45,
  clips: 3,
} as const;

const detail = (bitrateWindows: StatisticsStreamDetailResponse["bitrateWindows"] = []): StatisticsStreamDetailResponse => ({
  summary: { ...summary },
  windows: [
    { windowStart: "2026-10-24T19:00:00.000Z", streamId: "stream-1", messages: 80, emotes: 10, viewerCount: 200, chatters: 40, activeChatters: 30 },
    { windowStart: "2026-10-24T19:05:00.000Z", streamId: "stream-1", messages: 120, emotes: 12, viewerCount: 220, chatters: 44, activeChatters: 34 },
    { windowStart: "2026-10-24T19:10:00.000Z", streamId: "stream-1", messages: 100, emotes: 16, viewerCount: 250, chatters: 48, activeChatters: 38 },
  ],
  bitrateWindows,
  events: [
    { id: "clip-1", type: "clip", at: "2026-10-24T19:05:00.000Z", text: "First clip" },
    { id: "ad-1", type: "ad", at: "2026-10-24T19:10:00.000Z", durationSeconds: 90 },
  ],
});

const renderPanel = (
  list: StatisticsStreamListResponse,
  stream: StatisticsStreamDetailResponse = detail(),
  olderPage: StatisticsStreamListResponse = { streams: [], nextCursor: null },
) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const parsedUrl = new URL(url, window.location.origin);
    const body = parsedUrl.pathname.endsWith("/streams")
      ? parsedUrl.searchParams.has("cursor") ? olderPage : list
      : stream;
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return render(<QueryClientProvider client={queryClient}>
    <StatisticsStreamsPanel channelId="channel-1" language="en" />
  </QueryClientProvider>);
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("statistics streams page", () => {
  it("shows the dashed empty state when no streams have been collected", async () => {
    renderPanel({ streams: [], nextCursor: null });

    expect(await screen.findByText("No streams recorded yet")).toBeTruthy();
    expect(screen.getByText(/aggregate five-minute windows/iu)).toBeTruthy();
  });

  it("selects a stream, switches metrics, highlights marker events, and disables unavailable bitrate", async () => {
    renderPanel({ streams: [summary], nextCursor: null });

    const streamButton = await screen.findByRole("button", { name: /a long evening/iu });
    fireEvent.click(streamButton);
    expect(await screen.findByRole("heading", { name: "A long evening" })).toBeTruthy();
    expect(screen.getByText("10,075")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Chatter" }));
    expect(screen.getByRole("button", { name: "Chatter" }).getAttribute("aria-pressed")).toBe("true");

    const chart = document.querySelector(".statistics-chart__canvas");
    expect(chart).not.toBeNull();
    const clipMarker = within(chart as HTMLElement).getByRole("button", { name: /first clip/iu });
    fireEvent.focus(clipMarker);
    expect((await screen.findByRole("tooltip")).textContent).toContain("First clip");
    expect(screen.getByRole("listitem", { name: /first clip/iu }).getAttribute("data-highlighted")).toBe("true");

    const bitrateButton = screen.getByRole("button", { name: "Bitrate" });
    expect((bitrateButton as HTMLButtonElement).disabled).toBe(true);
    expect(bitrateButton.getAttribute("title")).toMatch(/no BELABOX measurements/iu);
  });

  it("loads an older page from the list header and appends its rows", async () => {
    const olderSummary = { ...summary, streamId: "stream-older", title: "An older evening" };
    renderPanel({ streams: [summary], nextCursor: "cursor-one" }, detail(), { streams: [olderSummary], nextCursor: null });

    expect(await screen.findByRole("button", { name: /a long evening/iu })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Load older" }));
    expect(await screen.findByRole("button", { name: /an older evening/iu })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load older" })).toBeNull();
  });
});
