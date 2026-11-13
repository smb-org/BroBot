import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StatisticsWordsPanel } from "../../src/modules/statistics/panel/words-panel";
import type { StatisticsSettings } from "../../src/modules/statistics/contracts";
import { foldStatisticsWord } from "../../src/modules/statistics/domain";

const words = [
  { word: "hello", count: 10, lastSeenAt: "2026-10-25T12:00:00.000Z" },
  { word: "halloween", count: 8, lastSeenAt: "2026-10-25T11:00:00.000Z" },
  { word: "hallway", count: 6, lastSeenAt: "2026-10-25T10:00:00.000Z" },
  { word: "lol", count: 5, lastSeenAt: "2026-10-25T09:00:00.000Z" },
];

const renderPanel = (sourceWords = words, initialIgnoredWords: string[] = []) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let ignoredWords = [...initialIgnoredWords];
  let wordCommand: StatisticsSettings["wordCommand"] = {
    enabled: false,
    command: "!wort",
    cooldownSeconds: 10,
    userCooldownSeconds: 30,
    minimumChatStatus: "everyone" as const,
  };
  let revision = 1;
  const fetchMock = vi.fn<typeof fetch>().mockImplementation((input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const parsedUrl = new URL(url, window.location.origin);
    if (parsedUrl.pathname.endsWith("/settings")) {
      if (init?.method === "PATCH") {
        const body = typeof init.body === "string"
          ? JSON.parse(init.body) as { settings: { ignoredWords: string[]; wordCommand: StatisticsSettings["wordCommand"] } }
          : { settings: { ignoredWords: [], wordCommand } };
        ignoredWords = body.settings.ignoredWords;
        wordCommand = body.settings.wordCommand;
        revision += 1;
      }
      return Promise.resolve(new Response(JSON.stringify({ settings: { ignoredWords, wordCommand }, revision }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }
    if (parsedUrl.pathname === "/api/csrf") {
      return Promise.resolve(new Response(JSON.stringify({ token: "csrf-test-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }
    const parameters = parsedUrl.searchParams;
    const search = foldStatisticsWord(parameters.get("search") ?? "");
    const hideFillers = parameters.get("hideFillers") !== "false";
    const page = Number(parameters.get("page") ?? "1");
    const filtered = sourceWords
      .filter(({ word }) => !hideFillers || word !== "lol")
      .filter(({ word }) => !ignoredWords.map(foldStatisticsWord).includes(foldStatisticsWord(word)))
      .filter(({ word }) => foldStatisticsWord(word).includes(search))
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
    <StatisticsWordsPanel channelId="channel-1" language="en" canManage />
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

  it("switches between total and current-stream scopes", async () => {
    const { fetchMock } = renderPanel();
    await screen.findByText("hello");
    const streamChoice = screen.getByRole("button", { name: "This stream" });
    expect(screen.getByRole("button", { name: "Total" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(streamChoice);

    await waitFor(() => expect(streamChoice.getAttribute("aria-pressed")).toBe("true"));
    expect(fetchMock.mock.calls.some(([input]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return new URL(url, window.location.origin).searchParams.get("scope") === "stream";
    })).toBe(true);
  });

  it("hides the ignore list behind a header button with the saved count and keeps the typed spelling", async () => {
    const { fetchMock } = renderPanel(words, ["gg", "xdd"]);
    await screen.findByText("hello");
    expect(screen.queryByRole("textbox", { name: "Add or remove words" })).toBeNull();
    const button = await screen.findByRole("button", { name: "Hidden · 2" });
    fireEvent.click(button);

    const entry = await screen.findByRole("textbox", { name: "Add or remove words" });
    expect(screen.getByRole("button", { name: "Remove gg" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove xdd" })).toBeTruthy();
    fireEvent.change(entry, { target: { value: "HELLO" } });
    fireEvent.keyDown(entry, { key: "Enter" });

    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    expect(screen.getByRole("button", { name: "Remove hello" })).toBeTruthy();
    expect(await screen.findByText("hello", { selector: ".statistics-words__word" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    await waitFor(() => expect(screen.queryByText("hello", { selector: ".statistics-words__word" })).toBeNull());
    expect(screen.getByRole("button", { name: "Remove hello" })).toBeTruthy();
    expect(screen.getByText("Hidden · 3")).toBeTruthy();
  });

  it("saves the word command settings explicitly", async () => {
    const { fetchMock } = renderPanel();
    await screen.findByText("hello");
    fireEvent.click(screen.getByRole("button", { name: "Command !wort" }));

    expect(screen.getByRole("textbox", { name: "Command token" })).toHaveProperty("value", "!wort");
    fireEvent.click(screen.getByRole("switch", { name: "Enable word command" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Global cooldown" }), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("combobox", { name: "Minimum chat status" }));
    const subscribers = await screen.findByRole("option", { name: "Subscribers" });
    fireEvent.pointerDown(subscribers, { pointerId: 1, pointerType: "mouse", button: 0 });
    fireEvent.click(subscribers);

    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    const saved = fetchMock.mock.calls.flatMap(([, init]) => init?.method === "PATCH" && typeof init.body === "string"
      ? [JSON.parse(init.body) as { settings: { wordCommand: StatisticsSettings["wordCommand"] } }]
      : []).at(-1);
    expect(saved?.settings.wordCommand).toMatchObject({
      enabled: true,
      command: "!wort",
      cooldownSeconds: 12,
      userCooldownSeconds: 30,
      minimumChatStatus: "subscriber",
    });
  });

  it("asks before closing the ignore dialog with unsaved changes", async () => {
    renderPanel();
    await screen.findByText("hello");
    fireEvent.click(screen.getByRole("button", { name: /^Hidden/u }));
    const entry = await screen.findByRole("textbox", { name: "Add or remove words" });
    fireEvent.change(entry, { target: { value: "gg" } });
    fireEvent.keyDown(entry, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: /^(Close|Schließen)$/u }));

    expect(await screen.findByText("Continue editing")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue editing" }));
    expect(screen.getByRole("button", { name: "Remove gg" })).toBeTruthy();
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
