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
    // The banner says it once; the dashed placeholders stay silent.
    expect(screen.getAllByText("No streams in this period")).toHaveLength(1);
    const placeholders = document.querySelectorAll(".statistics-trends__empty");
    expect(placeholders).toHaveLength(3);
    placeholders.forEach((placeholder) => { expect(placeholder.textContent).toBe(""); });
  });

  it("shows a neutral label instead of a percentage when the previous period is empty", async () => {
    const none = { streams: 0, streamHours: 0, averageViewers: null, messagesPerMinute: null };
    const { unmount } = renderPanel({ ...trends(), previousKpis: none });

    expect(await screen.findAllByText("new")).toHaveLength(2);
    expect(document.body.textContent).not.toContain("∞");
    unmount();

    renderPanel({ ...trends(0), previousKpis: none });
    await screen.findByText("No streams in this period", { selector: "strong" });
    expect(document.querySelectorAll(".statistics-trends__delta")).toHaveLength(4);
    document.querySelectorAll(".statistics-trends__delta").forEach((delta) => { expect(delta.textContent).toBe("–"); });
  });

  it("makes dense heatmap cells keyboard reachable and describes the focused cell in a fixed line", async () => {
    renderPanel({
      ...trends(),
      heatmap: [
        { weekday: 2, hour: 6, averageViewers: 90, streams: 1 },
        { weekday: 4, hour: 19, averageViewers: 262, streams: 3 },
        { weekday: 6, hour: 22, averageViewers: 120, streams: 1 },
      ],
    });
    const grid = await screen.findByRole("grid", { name: "Weekday × start hour" });
    const cells = within(grid).getAllByRole("gridcell");

    expect(cells.filter((cell) => cell.tabIndex === 0)).toHaveLength(1);
    expect(cells.every((cell) => cell.textContent === "")).toBe(true);
    const start = within(grid).getByRole("gridcell", { name: "Wed 06:00: avg 90 viewers" });
    fireEvent.focus(start);
    expect(document.querySelector(".statistics-trends__heat-detail")?.textContent).toBe("Wed 06:00: avg 90 viewers · 1 Streams");

    fireEvent.keyDown(start, { key: "ArrowRight" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Wed 07:00: no stream");
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Thu 07:00: no stream");
    expect(document.querySelector(".statistics-trends__heat-detail")?.textContent).toBe("Thu 07:00: no stream");
    fireEvent.mouseEnter(within(grid).getByRole("gridcell", { name: "Fri 19:00: avg 262 viewers" }));
    expect(document.querySelector(".statistics-trends__heat-detail")?.textContent).toBe("Fri 19:00: avg 262 viewers · 3 Streams");
  });

  it("keeps the loaded range and the chosen sort while another range loads", async () => {
    const { fetchMock } = renderPanel();
    const categoryTable = await screen.findByRole("table", { name: "Categories" });
    fireEvent.click(within(categoryTable).getByRole("button", { name: "Category" }));
    expect(within(categoryTable).getByRole("columnheader", { name: "Category" }).getAttribute("aria-sort")).toBe("ascending");

    const body = { ...trends(), weeks: 4 };
    let finish: (response: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "4 weeks" }));

    expect(await screen.findByRole("status", { name: "Updating…" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Categories" })).toBe(categoryTable);
    finish(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
    await waitFor(() => expect(screen.queryByRole("status", { name: "Updating…" })).toBeNull());
    expect(within(screen.getByRole("table", { name: "Categories" })).getByRole("columnheader", { name: "Category" }).getAttribute("aria-sort")).toBe("ascending");
  });

  it("formats every tick of the hours axis with the same precision", async () => {
    renderPanel();
    const chart = await screen.findByRole("img", { name: "Weekly activity" });

    const ticks = [...chart.querySelectorAll("text")].map((text) => text.textContent);
    expect(ticks).toContain("3");
    expect(ticks.some((tick) => /^\d+\.\d$/u.test(tick))).toBe(false);
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
