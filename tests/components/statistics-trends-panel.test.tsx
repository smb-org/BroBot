import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StatisticsTrendsPanel } from "../../src/modules/statistics/panel/trends";
import type { StatisticsTrendsResponse } from "../../src/modules/statistics/contracts";

const trends = (streams = 2): StatisticsTrendsResponse => ({
  weeks: 12,
  timeZone: "Europe/Berlin",
  range: { start: "2026-08-03T12:00:00.000Z", end: "2026-10-26T12:00:00.000Z" },
  previousRange: { start: "2026-05-11T12:00:00.000Z", end: "2026-08-03T12:00:00.000Z" },
  kpis: { streams, streamHours: streams === 0 ? 0 : 12.5, averageViewers: streams === 0 ? null : 205, messagesPerMinute: streams === 0 ? null : 14.6 },
  previousKpis: { streams: 1, streamHours: 8, averageViewers: 189, messagesPerMinute: 14.3 },
  weekly: [
    { weekStart: "2026-10-12", isoWeek: 42, averageViewers: 203, streamHours: 9 },
    { weekStart: "2026-10-19", isoWeek: 43, averageViewers: streams === 0 ? null : 198, streamHours: streams === 0 ? 0 : 8.5 },
  ],
  heatmap: streams === 0 ? [] : [{ weekday: 5, hour: 19, averageViewers: 205, streams: 2 }],
  categories: streams === 0 ? [] : [
    { name: "A category", streams: 1, streamHours: 0.5, averageViewers: 150, messagesPerMinute: 12 },
    { name: "B category", streams: 1, streamHours: 2, averageViewers: 250, messagesPerMinute: 18 },
  ],
});

const renderPanel = (result: StatisticsTrendsResponse = trends()) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const parsedUrl = new URL(url, window.location.origin);
    const body = { ...result, weeks: Number(parsedUrl.searchParams.get("weeks") ?? 12) as 4 | 12 | 52 };
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  });
  vi.stubGlobal("fetch", fetchMock);
  const rendered = render(<QueryClientProvider client={queryClient}>
    <StatisticsTrendsPanel channelId="channel-1" language="en" />
  </QueryClientProvider>);
  return { ...rendered, fetchMock };
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("statistics trends page", () => {
  it("switches between 4, 12, and 52 week ranges", async () => {
    const { fetchMock } = renderPanel();

    expect((await screen.findByRole("button", { name: "12 weeks" })).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "4 weeks" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("weeks=4"), expect.anything()));
    expect(screen.getByRole("button", { name: "4 weeks" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "52 weeks" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("shows a dashed empty state when the range has no streams", async () => {
    renderPanel(trends(0));

    expect(await screen.findByText("No streams in this period", { selector: "strong" })).toBeTruthy();
    expect(document.querySelectorAll(".statistics-trends__empty").length).toBeGreaterThanOrEqual(2);
  });

  it("sorts category rows and exposes the current order with aria-sort", async () => {
    renderPanel();
    const categoryTable = await screen.findByRole("table", { name: "Categories" });
    const body = within(categoryTable).getAllByRole("row").slice(1);

    expect(body[0]?.textContent).toContain("B category");
    fireEvent.click(within(categoryTable).getByRole("button", { name: "Category" }));

    expect(within(categoryTable).getByRole("columnheader", { name: "Category" }).getAttribute("aria-sort")).toBe("ascending");
    expect(within(categoryTable).getAllByRole("row")[1]?.textContent).toContain("A category");
    fireEvent.click(within(categoryTable).getByRole("button", { name: "Category" }));
    expect(within(categoryTable).getByRole("columnheader", { name: "Category" }).getAttribute("aria-sort")).toBe("descending");
    expect(within(categoryTable).getAllByRole("row")[1]?.textContent).toContain("B category");
  });
});
