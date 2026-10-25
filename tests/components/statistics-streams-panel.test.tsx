import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { moduleQueryKey } from "../../src/dashboard/data/module-query";
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
  options: { detailStatus?: number; olderStatus?: number; settingsStatus?: number; settingsPending?: boolean; timeZone?: string; cachedDetail?: boolean } = {},
) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (options.cachedDetail === true) {
    queryClient.setQueryData(moduleQueryKey("channel-1", "statistics", "stream:stream-1"), stream);
  }
  const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const parsedUrl = new URL(url, window.location.origin);
    const settings = {
      timeZone: options.timeZone ?? "UTC",
      revision: 1,
      location: null,
      locationRevision: 1,
      defaultChatTarget: "chat" as const,
      defaultChatTargetRevision: 1,
    };
    const response = parsedUrl.pathname.endsWith("/settings")
      ? { body: options.settingsStatus !== undefined && options.settingsStatus >= 400 ? { error: "settings_failed" } : settings, status: options.settingsStatus ?? 200 }
      : parsedUrl.pathname.endsWith("/streams")
        ? parsedUrl.searchParams.has("cursor")
          ? { body: options.olderStatus !== undefined && options.olderStatus >= 400 ? { error: "older_failed" } : olderPage, status: options.olderStatus ?? 200 }
          : { body: list, status: 200 }
        : { body: options.detailStatus !== undefined && options.detailStatus >= 400 ? { error: "detail_failed" } : stream, status: options.detailStatus ?? 200 };
    if (parsedUrl.pathname.endsWith("/settings") && options.settingsPending === true) return new Promise<Response>(() => {});
    return Promise.resolve(new Response(JSON.stringify(response.body), { status: response.status, headers: { "Content-Type": "application/json" } }));
  });
  vi.stubGlobal("fetch", fetchMock);
  const rendered = render(<QueryClientProvider client={queryClient}>
    <StatisticsStreamsPanel channelId="channel-1" language="en" />
  </QueryClientProvider>);
  return { ...rendered, queryClient, fetchMock };
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

  it("shows a retryable error in the inspector after a detail request fails", async () => {
    renderPanel({ streams: [summary], nextCursor: null }, detail(), undefined, { detailStatus: 500 });

    fireEvent.click(await screen.findByRole("button", { name: /a long evening/iu }));

    expect(await screen.findByRole("heading", { name: "Could not load stream history." })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.queryByText("Loading stream history …")).toBeNull();
  });

  it("keeps cached detail visible and shows refresh feedback when a refresh fails", async () => {
    renderPanel({ streams: [summary], nextCursor: null }, detail(), undefined, { detailStatus: 500, cachedDetail: true });

    expect(await screen.findByRole("heading", { name: "A long evening" })).toBeTruthy();
    const alert = await screen.findByRole("alert");

    expect(within(alert).getByText("Could not load stream history.")).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.getByText("10,075")).toBeTruthy();
  });

  it("keeps older-page errors in the header status slot", async () => {
    renderPanel({ streams: [summary], nextCursor: "cursor-one" }, detail(), { streams: [], nextCursor: null }, { olderStatus: 500 });

    fireEvent.click(await screen.findByRole("button", { name: "Load older" }));
    const alert = await screen.findByRole("alert");

    expect(alert.closest("header")).not.toBeNull();
    expect(within(alert).getByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("formats list, event, and chart times in the channel time zone", async () => {
    renderPanel({ streams: [summary], nextCursor: null }, detail(), undefined, { timeZone: "Europe/Berlin" });
    const expectedStart = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" })
      .format(new Date(summary.startedAt));
    const expectedEvent = new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Berlin" })
      .format(new Date("2026-10-24T19:05:00.000Z"));

    fireEvent.click(await screen.findByRole("button", { name: new RegExp(expectedStart.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u") }));

    expect(await screen.findByText(expectedEvent, { selector: "time" })).toBeTruthy();
    const chart = document.querySelector(".statistics-chart__canvas");
    expect(chart).not.toBeNull();
    expect(within(chart as HTMLElement).getAllByText(expectedStart).length).toBeGreaterThan(0);
  });

  it("reserves timestamp text while channel settings are unresolved", async () => {
    renderPanel({ streams: [summary], nextCursor: null }, detail(), undefined, { settingsPending: true });

    const streamButton = await screen.findByRole("button", { name: /a long evening/iu });
    const rowTimestamp = streamButton.querySelector(".statistics-streams__row-date");

    expect(rowTimestamp?.textContent).toBe("");
    expect(rowTimestamp?.querySelector("[aria-hidden='true']")).not.toBeNull();
    expect(document.querySelector(".statistics-inspector__event time")).toBeNull();
  });

  it("labels browser-zone timestamps when channel settings fail", async () => {
    renderPanel({ streams: [summary], nextCursor: null }, detail(), undefined, { settingsStatus: 500 });

    const streamButton = await screen.findByRole("button", { name: /a long evening/iu });
    const date = streamButton.querySelector(".statistics-streams__row-date");

    expect(date?.getAttribute("title")).toContain("Using browser time zone");
    fireEvent.click(streamButton);
    const eventTime = await screen.findByRole("heading", { name: "A long evening" });
    expect(eventTime.closest("section")?.querySelector(".statistics-inspector__event time")?.getAttribute("title"))
      .toContain("Using browser time zone");
  });

  it("rebuilds the loaded pages in order when a refresh finds a new stream", async () => {
    const streamsFrom = (first: number, last: number) => Array.from({ length: last - first + 1 }, (_, index) => ({
      ...summary,
      streamId: `stream-${String(first + index)}`,
      title: `Evening ${String(first + index)}`,
    }));
    const list: StatisticsStreamListResponse = { streams: streamsFrom(1, 20), nextCursor: "cursor-one" };
    const olderPage: StatisticsStreamListResponse = { streams: streamsFrom(21, 40), nextCursor: null };
    const { queryClient } = renderPanel(list, detail(), olderPage);

    fireEvent.click(await screen.findByRole("button", { name: "Load older" }));
    expect(await screen.findByRole("button", { name: /evening 40,/iu })).toBeTruthy();

    // A new stream shifts every page boundary by one before the refresh.
    list.streams = [{ ...summary, streamId: "stream-new", title: "Evening new" }, ...streamsFrom(1, 19)];
    olderPage.streams = streamsFrom(20, 40);
    await queryClient.refetchQueries();

    expect(await screen.findByRole("button", { name: /evening new,/iu })).toBeTruthy();
    expect(screen.getByRole("button", { name: /evening 20,/iu })).toBeTruthy();
    expect(document.querySelectorAll(".statistics-streams__row")).toHaveLength(41);
  });

  it("hides the average line and label when every primary-series value is null", async () => {
    const loadedDetail = detail();
    const allNullViewers = { ...loadedDetail, windows: loadedDetail.windows.map((window) => ({ ...window, viewerCount: null })) };
    renderPanel({ streams: [summary], nextCursor: null }, allNullViewers);

    fireEvent.click(await screen.findByRole("button", { name: /a long evening/iu }));

    const legend = document.querySelector(".statistics-chart__legend");
    expect(legend).not.toBeNull();
    expect(within(legend as HTMLElement).queryByText(/Ø\s*0/u)).toBeNull();
    expect(legend?.querySelector(".is-dashed")).toBeNull();
    expect(document.querySelector(".statistics-chart__canvas line[stroke-dasharray='5 4']")).toBeNull();
  });
});
