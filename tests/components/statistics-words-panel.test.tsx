import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StatisticsWordsPanel } from "../../src/modules/statistics/panel/words-panel";

const words = [
  { word: "hello", count: 10, lastSeenAt: "2026-10-25T12:00:00.000Z" },
  { word: "halloween", count: 8, lastSeenAt: "2026-10-25T11:00:00.000Z" },
  { word: "hallway", count: 6, lastSeenAt: "2026-10-25T10:00:00.000Z" },
  { word: "lol", count: 5, lastSeenAt: "2026-10-25T09:00:00.000Z" },
];

const renderPanel = (sourceWords = words) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const fetchMock = vi.fn<typeof fetch>().mockImplementation((input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const parsedUrl = new URL(url, window.location.origin);
    const parameters = parsedUrl.searchParams;
    const search = (parameters.get("search") ?? "").normalize("NFKC").toLowerCase();
    const hideFillers = parameters.get("hideFillers") !== "false";
    const page = Number(parameters.get("page") ?? "1");
    const filtered = sourceWords
      .filter(({ word }) => !hideFillers || word !== "lol")
      .filter(({ word }) => word.includes(search))
      .sort((left, right) => right.count - left.count || left.word.localeCompare(right.word));
    const totalCount = sourceWords.reduce((sum, word) => sum + word.count, 0);
    const response = {
      words: filtered.slice((page - 1) * 100, page * 100).map((word, index) => ({
        ...word,
        rank: (page - 1) * 100 + index + 1,
        share: word.count / totalCount,
      })),
      page,
      pageSize: 100,
      total: filtered.length,
      totalPages: Math.ceil(filtered.length / 100),
      totalCount,
      maxCount: Math.max(0, ...sourceWords.map(({ count }) => count)),
    };
    return Promise.resolve(new Response(JSON.stringify(response), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
  });
  vi.stubGlobal("fetch", fetchMock);
  const rendered = render(<QueryClientProvider client={queryClient}>
    <StatisticsWordsPanel channelId="channel-1" language="en" />
  </QueryClientProvider>);
  return { ...rendered, queryClient, fetchMock };
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("statistics words page", () => {
  it("shows a dashed empty state when a channel has no stored words", async () => {
    const { container } = renderPanel([]);

    expect(await screen.findByText("No words recorded yet")).toBeTruthy();
    expect(container.querySelector(".statistics-words__empty")).not.toBeNull();
  });

  it("labels the mobile last-seen time for screen readers", async () => {
    const { container } = renderPanel();
    await screen.findByText("hello");

    expect(container.querySelector(".statistics-words__word-last-seen")?.getAttribute("aria-label")).toMatch(/^Last seen:/u);
  });

  it("debounces case-insensitive search requests and shows matching words", async () => {
    const { fetchMock } = renderPanel();
    await screen.findByText("hello");
    const initialCalls = fetchMock.mock.calls.length;
    fireEvent.change(screen.getByRole("textbox", { name: "Search words" }), { target: { value: "HALL" } });

    expect(fetchMock.mock.calls).toHaveLength(initialCalls);
    expect(await screen.findByText("1–2 of 2")).toBeTruthy();
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return new URL(url, window.location.origin).searchParams.get("search") === "HALL";
    })).toBe(true));
  });

  it("starts with filler words hidden and reloads when the toggle is cleared", async () => {
    const { fetchMock } = renderPanel();
    await screen.findByText("hello");
    expect(screen.getByRole("switch", { name: "Hide filler words" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByText("lol")).toBeNull();

    fireEvent.click(screen.getByRole("switch", { name: "Hide filler words" }));

    expect(await screen.findByText("lol")).toBeTruthy();
    await waitFor(() => expect(fetchMock.mock.calls.some(([input]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return new URL(url, window.location.origin).searchParams.get("hideFillers") === "false";
    })).toBe(true));
  });

  it("loads the next page and updates the visible range", async () => {
    const manyWords = Array.from({ length: 101 }, (_unused, index) => ({
      word: `word-${String(index).padStart(3, "0")}`,
      count: 200 - index,
      lastSeenAt: "2026-10-25T12:00:00.000Z",
    }));
    // The search debounce is armed on mount. Fire it right after the click, the worst case for a slow runner,
    // so a debounce that resets the page would be caught every time and not only when the machine is slow.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderPanel(manyWords);
      await screen.findByText("word-000");
      const next = screen.getByRole("button", { name: "Next page" });
      await waitFor(() => expect(next.hasAttribute("disabled")).toBe(false));

      fireEvent.click(next);
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    } finally {
      vi.useRealTimers();
    }

    expect(await screen.findByText("word-100")).toBeTruthy();
    expect(screen.getByText("101–101 of 101")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Previous page" }).hasAttribute("disabled")).toBe(false);
  });
});
