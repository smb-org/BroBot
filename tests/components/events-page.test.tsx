import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { EventsPage } from "../../src/dashboard/events/EventsPage";
import { emptyEventFilter } from "../../src/dashboard/events/model";
import type { PanelEventEntry, PanelEventsResponse } from "../../src/panel-contract";
import { dashboardDataKeys } from "../../src/dashboard/data/keys";
import { dashboardAuthenticationRequiredEvent } from "../../src/dashboard/data/events";
import { renderWithQuery } from "../query-test-utils";

const entry = (overrides: Partial<PanelEventEntry>): PanelEventEntry => ({
  eventId: "event-1",
  createdAt: "2026-09-22T10:00:00.000Z",
  moduleId: "host",
  // Distinct per entry by default -- entries sharing a `triggerId` collapse
  // into one group (`eventGroups`), and only the group's representative
  // renders as a row. Callers that want to exercise grouping override this.
  triggerId: `trigger-${overrides.eventId ?? "event-1"}`,
  code: "host.chat.failed",
  detail: "{}",
  actorUserId: null,
  actorLogin: null,
  actorDisplayName: null,
  ...overrides,
});

const requestUrl = (input: RequestInfo | URL): URL => input instanceof Request
  ? new URL(input.url)
  : input instanceof URL ? input : new URL(input, window.location.origin);

const renderPage = (entries: readonly PanelEventEntry[], filters = emptyEventFilter) => {
  const response: PanelEventsResponse = { entries: [...entries], nextCursor: null };
  return renderWithQuery(
    <UiProvider>
      <EventsPage
        channelId="kanal-a"
        filters={filters}
        moduleOptions={[]}
        onFiltersChange={() => undefined}
      />
    </UiProvider>,
    undefined,
    { initialData: [{ queryKey: dashboardDataKeys.events("kanal-a", filters), data: { pages: [response], pageParams: [null] } }] },
  );
};

/** The trigger's accessible name is "Ursache anzeigen: <row label>" (DE) or
 *  "Show cause: <row label>" (EN) -- tests that don't care about the exact
 *  label match on the language-fixed prefix. */
const causeButtonName = /^(Ursache anzeigen|Show cause):/;

class TestEventsWebSocket {
  static instances: TestEventsWebSocket[] = [];
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor() {
    TestEventsWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener !== "function") return;
    const callbacks = this.listeners.get(type) ?? new Set<(event: Event) => void>();
    callbacks.add(listener);
    this.listeners.set(type, callbacks);
  }

  private emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open(): void {
    this.emit("open", new Event("open"));
  }

  receive(data: string): void {
    this.emit("message", new MessageEvent("message", { data }));
  }

  close(): void {
    this.emit("close", new CloseEvent("close", { code: 1000, reason: "Leaving test" }));
  }

  static reset(): void {
    TestEventsWebSocket.instances = [];
  }
}

const emitEventHint = (socket: TestEventsWebSocket, id: string, event: PanelEventEntry): void => {
  socket.receive(JSON.stringify({
    version: 1,
    id,
    createdAt: event.createdAt,
    channelId: "kanal-a",
    type: "event_log.new",
    payload: { entries: [{ eventId: event.eventId, createdAt: event.createdAt, moduleId: event.moduleId, code: event.code, actorUserId: null }] },
  }));
};

const positionSpies = new Set<() => void>();

const positionEventReader = (container: HTMLElement) => {
  const feed = container.querySelector<HTMLElement>(".event-feed");
  if (feed === null) throw new Error("Event feed is missing.");
  let scrollY = 700;
  Object.defineProperty(window, "scrollY", { configurable: true, get: () => scrollY });
  Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, get: () => 5_000 });
  const feedRectSpy = vi.spyOn(feed, "getBoundingClientRect").mockImplementation(() => ({ top: scrollY === 500 ? 0 : -200 }) as DOMRect);
  const scrollToSpy = vi.spyOn(window, "scrollTo").mockImplementation(() => {
    scrollY = 500;
    window.dispatchEvent(new Event("scroll"));
  });
  positionSpies.add(() => { feedRectSpy.mockRestore(); scrollToSpy.mockRestore(); });
  return {
    away: (): void => {
      scrollY = 700;
      window.dispatchEvent(new Event("scroll"));
    },
    top: (): void => {
      scrollY = 500;
      window.dispatchEvent(new Event("scroll"));
    },
  };
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const restore of positionSpies) restore();
  positionSpies.clear();
  Object.defineProperty(window, "scrollY", { configurable: true, writable: true, value: 0 });
  Reflect.deleteProperty(document.documentElement, "scrollHeight");
  TestEventsWebSocket.reset();
  // `dashboardLanguage()` reads `navigator.language`; reset it to the suite
  // default (`tests/setup.ts`) so an English test doesn't leak into the next.
  Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });
});

describe("EventsPage failure cause icon", () => {
  it("keeps the realtime socket open when filters change", async () => {
    class FakeWebSocket {
      static instances: FakeWebSocket[] = [];
      readonly close = vi.fn();

      constructor() {
        FakeWebSocket.instances.push(this);
      }

      addEventListener(): void {}
    }
    FakeWebSocket.instances = [];
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const fetcher = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ entries: [entry({ eventId: "socket-test" })], nextCursor: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    vi.stubGlobal("fetch", fetcher);

    function Harness() {
      const [filters, setFilters] = useState(emptyEventFilter);
      const isChannelFilter = filters.origin === "channel";
      return <>
        <button type="button" onClick={() => { setFilters(isChannelFilter ? emptyEventFilter : { ...emptyEventFilter, origin: "channel" }); }}>Change filter</button>
        <EventsPage channelId="kanal-a" filters={filters} moduleOptions={[]} onFiltersChange={setFilters} />
      </>;
    }

    const view = renderWithQuery(<UiProvider><Harness /></UiProvider>);
    expect(await screen.findByText("Chat-Nachricht fehlgeschlagen")).toBeVisible();
    expect(FakeWebSocket.instances).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Change filter" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.close).not.toHaveBeenCalled();
    view.unmount();
    expect(FakeWebSocket.instances[0]?.close).toHaveBeenCalledTimes(1);
  });

  it("does not show another filter's rows while the selected query loads", async () => {
    const initialEntry = entry({ eventId: "all-events" });
    const filteredEntry = entry({ eventId: "channel-events", code: "channel_events.chat.sub", detail: "{\"person\":\"new-subscriber\",\"tier\":\"1000\"}" });
    let releaseFilteredResponse: (response: Response) => void = () => { throw new Error("The filtered request has not started."); };
    const filteredResponse = new Promise<Response>((resolve) => { releaseFilteredResponse = resolve; });
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = requestUrl(input);
      return url.searchParams.get("origin") === "channel"
        ? filteredResponse
        : Promise.resolve(new Response(JSON.stringify({ entries: [initialEntry], nextCursor: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
    });
    vi.stubGlobal("fetch", fetcher);

    function Harness() {
      const [filters, setFilters] = useState(emptyEventFilter);
      const isChannelFilter = filters.origin === "channel";
      return <>
        <button type="button" onClick={() => { setFilters(isChannelFilter ? emptyEventFilter : { ...emptyEventFilter, origin: "channel" }); }}>Change filter</button>
        <EventsPage channelId="kanal-a" filters={filters} moduleOptions={[]} onFiltersChange={setFilters} />
      </>;
    }

    const view = renderWithQuery(<UiProvider><Harness /></UiProvider>, undefined, { gcTime: 600_000 });
    expect(await screen.findByText("Chat-Nachricht fehlgeschlagen")).toBeVisible();
    const firstRow = view.container.querySelector(".event-table tbody tr");
    if (!(firstRow instanceof HTMLTableRowElement)) throw new Error("Initial event row is missing.");
    fireEvent.click(firstRow);
    expect(screen.getByRole("region", { name: "Detail" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Change filter" }));
    expect(screen.queryByRole("region", { name: "Detail" })).not.toBeInTheDocument();

    expect(screen.queryByText("Chat-Nachricht fehlgeschlagen")).not.toBeInTheDocument();
    expect(view.container.querySelectorAll(".event-table tbody tr")).toHaveLength(0);

    releaseFilteredResponse(new Response(JSON.stringify({ entries: [filteredEntry], nextCursor: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    expect(await screen.findByText("Sub von new-subscriber")).toBeVisible();
    expect(screen.queryByText("Chat-Nachricht fehlgeschlagen")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Change filter" }));
    expect(screen.getByText("Chat-Nachricht fehlgeschlagen")).toBeVisible();
    expect(fetcher).toHaveBeenCalledTimes(3);
    view.unmount();
  });

  it("revalidates a hinted filter after switching away during its activation refresh", async () => {
    const filtersA = { ...emptyEventFilter, module: "channel_events" };
    const filtersB = { ...emptyEventFilter, module: "host" };
    const oldRaid = entry({ eventId: "switch-old", moduleId: "channel_events", code: "channel_events.raid.incoming", detail: '{"source":"switchold","viewers":1}' });
    const newRaid = entry({ eventId: "switch-new", createdAt: "2026-09-22T10:01:00.000Z", moduleId: "channel_events", code: "channel_events.raid.incoming", detail: '{"source":"switchnew","viewers":2}' });
    const hostEntry = entry({ eventId: "switch-host" });
    let channelRequests = 0;
    const json = (entries: readonly PanelEventEntry[]) => Promise.resolve(new Response(JSON.stringify({ entries, nextCursor: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const fetcher = vi.fn((input: RequestInfo | URL, options?: RequestInit): Promise<Response> => {
      if (requestUrl(input).searchParams.get("module") !== "channel_events") return json([hostEntry]);
      channelRequests += 1;
      if (channelRequests === 1) {
        return new Promise<Response>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
      }
      return json([newRaid, oldRaid]);
    });
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("WebSocket", TestEventsWebSocket);
    function Harness() {
      const [showHost, setShowHost] = useState(false);
      return <>
        <button type="button" onClick={() => { setShowHost(!showHost); }}>Toggle filter</button>
        <EventsPage channelId="kanal-a" filters={showHost ? filtersB : filtersA} moduleOptions={[]} onFiltersChange={() => undefined} />
      </>;
    }
    const rendered = renderWithQuery(<UiProvider><Harness /></UiProvider>, undefined, {
      gcTime: 600_000,
      staleTime: 30_000,
      initialData: [
        { queryKey: dashboardDataKeys.events("kanal-a", filtersA), data: { pages: [{ entries: [oldRaid], nextCursor: null }], pageParams: [null] } },
        { queryKey: dashboardDataKeys.events("kanal-a", filtersB), data: { pages: [{ entries: [hostEntry], nextCursor: null }], pageParams: [null] } },
      ],
    });
    await waitFor(() => expect(channelRequests).toBe(1));
    const position = positionEventReader(rendered.container);
    act(() => { position.away(); });
    const socket = TestEventsWebSocket.instances[0];
    if (socket === undefined) throw new Error("Realtime socket was not created.");
    socket.open();
    emitEventHint(socket, "switch-filter-hint", newRaid);

    fireEvent.click(screen.getByRole("button", { name: "Toggle filter" }));
    expect(await screen.findByText("Chat-Nachricht fehlgeschlagen")).toBeVisible();
    await waitFor(() => expect(rendered.queryClient.isFetching()).toBe(0));
    fireEvent.click(screen.getByRole("button", { name: "Toggle filter" }));

    expect(screen.getByText(/Raid von switchold/u)).toBeVisible();
    expect(rendered.container.querySelector(".skeleton")).not.toBeInTheDocument();
    expect(await screen.findByText(/Raid von switchnew/u)).toBeVisible();
    expect(channelRequests).toBe(2);
    rendered.unmount();
  });

  it("shows cached events on return and revalidates to pick up events received while away", async () => {
    const json = (entries: PanelEventEntry[]) => Promise.resolve(new Response(JSON.stringify({ entries, nextCursor: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    const oldEntry = entry({ eventId: "old-event" });
    const newEntry = entry({ eventId: "new-event", code: "channel_events.chat.sub", detail: "{\"person\":\"late-subscriber\",\"tier\":\"1000\"}" });
    let serverEntries = [oldEntry];
    const fetcher = vi.fn(() => json(serverEntries));
    vi.stubGlobal("fetch", fetcher);
    const page = (
      <UiProvider>
        <EventsPage channelId="kanal-a" filters={emptyEventFilter} moduleOptions={[]} onFiltersChange={() => undefined} />
      </UiProvider>
    );

    // Production cache lifetime: gcTime keeps the data, the default staleTime (30 s) applies.
    const view = renderWithQuery(page, undefined, { gcTime: 600_000 });
    expect(await screen.findByText("Chat-Nachricht fehlgeschlagen")).toBeVisible();
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Leave the page; the server gets a new event and no hint reaches the page.
    view.unmount();
    serverEntries = [newEntry, oldEntry];

    const returned = renderWithQuery(page, undefined, { gcTime: 600_000, queryClient: view.queryClient });
    // Cached rows are visible at once, without a skeleton.
    expect(screen.getByText("Chat-Nachricht fehlgeschlagen")).toBeVisible();
    expect(returned.container.querySelector(".skeleton")).not.toBeInTheDocument();
    expect(await screen.findByText("Sub von late-subscriber")).toBeVisible();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("freezes cached rows as soon as the reader leaves the top during activation refresh", async () => {
    const cachedEntry = entry({ eventId: "activation-cached" });
    const refreshedEntry = entry({
      eventId: "activation-new",
      createdAt: "2026-09-22T10:01:00.000Z",
      moduleId: "channel_events",
      code: "channel_events.raid.incoming",
      detail: '{"source":"activationraid","viewers":2}',
    });
    let releaseRefresh: ((response: Response) => void) | undefined;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { releaseRefresh = resolve; }));
    vi.stubGlobal("fetch", fetcher);
    const rendered = renderWithQuery(
      <UiProvider><EventsPage channelId="kanal-a" filters={emptyEventFilter} moduleOptions={[]} onFiltersChange={() => undefined} /></UiProvider>,
      undefined,
      {
        gcTime: 600_000,
        staleTime: 30_000,
        initialData: [{
          queryKey: dashboardDataKeys.events("kanal-a", emptyEventFilter),
          data: { pages: [{ entries: [cachedEntry], nextCursor: null }], pageParams: [null] },
        }],
      },
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const position = positionEventReader(rendered.container);
    act(() => { position.away(); });

    act(() => {
      releaseRefresh?.(new Response(JSON.stringify({ entries: [refreshedEntry, cachedEntry], nextCursor: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    });
    await waitFor(() => expect(rendered.queryClient.isFetching()).toBe(0));

    expect(screen.getByText("Chat-Nachricht fehlgeschlagen")).toBeVisible();
    expect(screen.queryByText(/Raid von activationraid/u)).not.toBeInTheDocument();
    const notice = screen.getByRole("button", { name: /1 neue Ereignisse/u });
    expect(notice).toBeVisible();

    fireEvent.click(notice);
    expect(await screen.findByText(/Raid von activationraid/u)).toBeVisible();
    expect(rendered.container.querySelector(".realtime-feed__notice-slot")).toHaveAttribute("data-pending", "false");
    rendered.unmount();
  });

  it("keeps cached events visible and offers Retry after a background failure", async () => {
    const cachedEntry = entry({ eventId: "cached-event" });
    const refreshedEntry = entry({
      eventId: "recovered-event",
      moduleId: "channel_events",
      code: "channel_events.raid.incoming",
      detail: '{"source":"recoveredraid","viewers":2}',
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "internal_error" }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ entries: [refreshedEntry], nextCursor: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetcher);

    const rendered = renderWithQuery(
      <UiProvider><EventsPage channelId="kanal-a" filters={emptyEventFilter} moduleOptions={[]} onFiltersChange={() => undefined} /></UiProvider>,
      undefined,
      {
        gcTime: 600_000,
        staleTime: 30_000,
        initialData: [{
          queryKey: dashboardDataKeys.events("kanal-a", emptyEventFilter),
          data: { pages: [{ entries: [cachedEntry], nextCursor: null }], pageParams: [null] },
        }],
      },
    );

    // The revalidation on mount fails; the cached rows stay.
    expect(screen.getByText("Chat-Nachricht fehlgeschlagen")).toBeVisible();
    await waitFor(() => { expect(rendered.container.querySelector(".list-toolbar__query-error")).not.toBeEmptyDOMElement(); });
    expect(screen.getByText("Chat-Nachricht fehlgeschlagen")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));

    expect(await screen.findByText("Raid von recoveredraid mit 2 Zuschauern")).toBeVisible();
    expect(rendered.container.querySelector(".list-toolbar__query-error")).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("refetches when a realtime hint arrives during an uncached first load", async () => {
    const initialEntry = entry({ eventId: "initial-event" });
    const hinted = entry({
      eventId: "hinted-event",
      moduleId: "channel_events",
      code: "channel_events.raid.incoming",
      detail: '{"source":"coldhint","viewers":1}',
    });
    const responses: Array<(response: Response) => void> = [];
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { responses.push(resolve); }));
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("WebSocket", TestEventsWebSocket);
    const rendered = renderWithQuery(
      <UiProvider><EventsPage channelId="kanal-a" filters={emptyEventFilter} moduleOptions={[]} onFiltersChange={() => undefined} /></UiProvider>,
      undefined,
      { gcTime: 600_000 },
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    const socket = TestEventsWebSocket.instances[0];
    if (socket === undefined) throw new Error("Realtime socket was not created.");
    socket.open();
    socket.receive(JSON.stringify({
      version: 1,
      id: "cold-hint-message",
      createdAt: hinted.createdAt,
      channelId: "kanal-a",
      type: "event_log.new",
      payload: { entries: [{ eventId: hinted.eventId, createdAt: hinted.createdAt, moduleId: hinted.moduleId, code: hinted.code, actorUserId: null }] },
    }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const json = (entries: PanelEventEntry[]) => new Response(JSON.stringify({ entries, nextCursor: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    responses[0]?.(json([initialEntry]));
    responses[1]?.(json([initialEntry, hinted]));
    expect(await screen.findByText(/Raid von coldhint/u)).toBeVisible();
    rendered.unmount();
  });

  it("invalidates again when a second realtime hint arrives during a delayed refresh", async () => {
    const initialEntry = entry({ eventId: "initial-event" });
    const firstHint = entry({
      eventId: "first-hint-event",
      moduleId: "channel_events",
      code: "channel_events.raid.incoming",
      detail: '{"source":"firsthint","viewers":1}',
    });
    const secondHint = entry({
      eventId: "second-hint-event",
      moduleId: "channel_events",
      code: "channel_events.raid.incoming",
      detail: '{"source":"secondhint","viewers":2}',
    });
    const refreshResponses: Array<(response: Response) => void> = [];
    let mounted = false;
    const fetcher = vi.fn((): Promise<Response> => {
      if (!mounted) {
        // The revalidation on mount answers at once with the cached rows.
        mounted = true;
        return Promise.resolve(new Response(JSON.stringify({ entries: [initialEntry], nextCursor: null }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      return new Promise<Response>((resolve) => { refreshResponses.push(resolve); });
    });
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("WebSocket", TestEventsWebSocket);

    const rendered = renderWithQuery(
      <UiProvider><EventsPage channelId="kanal-a" filters={emptyEventFilter} moduleOptions={[]} onFiltersChange={() => undefined} /></UiProvider>,
      undefined,
      {
        gcTime: 600_000,
        staleTime: 30_000,
        initialData: [{
          queryKey: dashboardDataKeys.events("kanal-a", emptyEventFilter),
          data: { pages: [{ entries: [initialEntry], nextCursor: null }], pageParams: [null] },
        }],
      },
    );
    expect(screen.getByText("Chat-Nachricht fehlgeschlagen")).toBeVisible();
    await waitFor(() => { expect(rendered.queryClient.isFetching()).toBe(0); });
    fetcher.mockClear();
    const socket = TestEventsWebSocket.instances[0];
    if (socket === undefined) throw new Error("Realtime socket was not created.");
    socket.open();
    const sendHint = (id: string, event: PanelEventEntry): void => {
      socket.receive(JSON.stringify({
        version: 1,
        id,
        createdAt: event.createdAt,
        channelId: "kanal-a",
        type: "event_log.new",
        payload: { entries: [{ eventId: event.eventId, createdAt: event.createdAt, moduleId: event.moduleId, code: event.code, actorUserId: null }] },
      }));
    };

    sendHint("first-hint-message", firstHint);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    sendHint("second-hint-message", secondHint);
    // The second hint only marks a trailing refresh; it starts once the first one settles.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fetcher).toHaveBeenCalledTimes(1);

    refreshResponses[0]?.(new Response(JSON.stringify({ entries: [initialEntry, firstHint], nextCursor: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    refreshResponses[1]?.(new Response(JSON.stringify({ entries: [initialEntry, firstHint, secondHint], nextCursor: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    expect(await screen.findByText(/Raid von firsthint/u)).toBeVisible();
    expect(await screen.findByText(/Raid von secondhint/u)).toBeVisible();
    expect(fetcher).toHaveBeenCalledTimes(2);
    rendered.unmount();
  });

  it.each(["hint", "retry", "reconnect", "automatic refetch"] as const)(
    "keeps event rows fixed while scrolled away when %s delivers newer data",
    async (cause) => {
      const oldEntry = entry({ eventId: "frozen-old" });
      const newEntry = entry({
        eventId: "frozen-new",
        createdAt: "2026-09-22T10:01:00.000Z",
        moduleId: "channel_events",
        code: "channel_events.raid.incoming",
        detail: '{"source":"frozen","viewers":2}',
      });
      const additionalEntry = entry({
        eventId: "frozen-added",
        createdAt: "2026-09-22T10:00:30.000Z",
        moduleId: "channel_events",
        code: "channel_events.raid.incoming",
        detail: '{"source":"alsofrozen","viewers":1}',
      });
      const response = (entries: readonly PanelEventEntry[]) => new Response(JSON.stringify({ entries, nextCursor: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
      let serverEntries: readonly PanelEventEntry[] = [oldEntry];
      let rejectNextRequest = false;
      const fetcher = vi.fn((): Promise<Response> => {
        if (rejectNextRequest) {
          rejectNextRequest = false;
          return Promise.reject(new Error("temporary network failure"));
        }
        return Promise.resolve(response(serverEntries));
      });
      vi.stubGlobal("fetch", fetcher);
      vi.stubGlobal("WebSocket", TestEventsWebSocket);
      const queryKey = dashboardDataKeys.events("kanal-a", emptyEventFilter);
      const rendered = renderWithQuery(
        <UiProvider><EventsPage channelId="kanal-a" filters={emptyEventFilter} moduleOptions={[]} onFiltersChange={() => undefined} /></UiProvider>,
        undefined,
        {
          gcTime: 600_000,
          staleTime: 30_000,
          initialData: [{ queryKey, data: { pages: [{ entries: [oldEntry], nextCursor: null }], pageParams: [null] } }],
        },
      );
      await waitFor(() => expect(rendered.queryClient.isFetching()).toBe(0));
      const position = positionEventReader(rendered.container);
      act(() => { position.away(); });
      const socket = TestEventsWebSocket.instances[0];
      if (socket === undefined) throw new Error("Realtime socket was not created.");
      socket.open();
      serverEntries = [newEntry, additionalEntry, oldEntry];
      fetcher.mockClear();

      if (cause === "hint") {
        emitEventHint(socket, "frozen-hint", newEntry);
        await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      } else if (cause === "retry") {
        const query = rendered.queryClient.getQueryCache().find({ queryKey });
        if (query === undefined) throw new Error("Events query was not created.");
        query.setOptions({ ...query.options, retry: 1, retryDelay: 0 });
        rejectNextRequest = true;
        await act(async () => { await rendered.queryClient.invalidateQueries({ queryKey, exact: true }); });
      } else if (cause === "reconnect") {
        socket.close();
        socket.open();
        await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      } else {
        await act(async () => { await rendered.queryClient.invalidateQueries({ queryKey, exact: true }); });
      }

      await waitFor(() => expect(rendered.queryClient.isFetching()).toBe(0));
      expect(screen.getByText("Chat-Nachricht fehlgeschlagen")).toBeVisible();
      expect(screen.queryByText(/Raid von frozen/u)).not.toBeInTheDocument();
      expect(screen.queryByText(/Raid von alsofrozen/u)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /2 neue Ereignisse/u })).toBeVisible();
      rendered.unmount();
    },
  );

  it.each(["notice click", "manual scroll"] as const)("shows refreshed events at the top by %s", async (action) => {
    const oldEntry = entry({ eventId: "top-old" });
    const newEntry = entry({
      eventId: "top-new",
      createdAt: "2026-09-22T10:01:00.000Z",
      moduleId: "channel_events",
      code: "channel_events.raid.incoming",
      detail: '{"source":"topjump","viewers":2}',
    });
    const additionalEntry = entry({
      eventId: "top-added",
      createdAt: "2026-09-22T10:00:30.000Z",
      moduleId: "channel_events",
      code: "channel_events.raid.incoming",
      detail: '{"source":"alsojump","viewers":1}',
    });
    let serverEntries: readonly PanelEventEntry[] = [oldEntry];
    const fetcher = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ entries: serverEntries, nextCursor: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("WebSocket", TestEventsWebSocket);
    const queryKey = dashboardDataKeys.events("kanal-a", emptyEventFilter);
    const rendered = renderWithQuery(
      <UiProvider><EventsPage channelId="kanal-a" filters={emptyEventFilter} moduleOptions={[]} onFiltersChange={() => undefined} /></UiProvider>,
      undefined,
      {
        gcTime: 600_000,
        staleTime: 30_000,
        initialData: [{ queryKey, data: { pages: [{ entries: [oldEntry], nextCursor: null }], pageParams: [null] } }],
      },
    );
    await waitFor(() => expect(rendered.queryClient.isFetching()).toBe(0));
    fetcher.mockClear();
    const position = positionEventReader(rendered.container);
    act(() => { position.away(); });
    serverEntries = [newEntry, additionalEntry, oldEntry];
    const socket = TestEventsWebSocket.instances[0];
    if (socket === undefined) throw new Error("Realtime socket was not created.");
    socket.open();
    emitEventHint(socket, `top-hint-${action}`, newEntry);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(rendered.queryClient.isFetching()).toBe(0));
    const refreshedEvents = rendered.queryClient.getQueryData<{ pages: { entries: PanelEventEntry[] }[] }>(queryKey);
    expect(refreshedEvents?.pages.flatMap((page) => page.entries).map((event) => event.eventId)).toEqual([
      "top-new",
      "top-added",
      "top-old",
    ]);
    expect(screen.getByText("Chat-Nachricht fehlgeschlagen")).toBeVisible();
    expect(screen.queryByText(/Raid von topjump/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/Raid von alsojump/u)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /2 neue Ereignisse/u })).toBeVisible();

    if (action === "notice click") fireEvent.click(screen.getByRole("button", { name: /2 neue Ereignisse/u }));
    else act(() => { position.top(); });

    expect(await screen.findByText(/Raid von topjump/u)).toBeVisible();
    expect(await screen.findByText(/Raid von alsojump/u)).toBeVisible();
    expect(screen.getByText("Chat-Nachricht fehlgeschlagen")).toBeVisible();
    expect(rendered.container.querySelector(".realtime-feed__notice-slot")).toHaveAttribute("data-pending", "false");
    rendered.unmount();
  });

  it.each([
    ["an older timestamp", "late-older-time", "2026-09-22T10:00:59.000Z"],
    ["a lower id at the same timestamp", "a-late-id", "2026-09-22T10:01:00.000Z"],
  ] as const)("announces an unseen event with %s while the displayed rows stay frozen", async (_description, lateEventId, lateCreatedAt) => {
    const newest = entry({ eventId: "z-newest", createdAt: "2026-09-22T10:01:00.000Z" });
    const oldest = entry({ eventId: "oldest", createdAt: "2026-09-22T10:00:00.000Z" });
    const late = entry({
      eventId: lateEventId,
      createdAt: lateCreatedAt,
      moduleId: "channel_events",
      code: "channel_events.raid.incoming",
      detail: `{"source":"${lateEventId}","viewers":2}`,
    });
    let serverEntries: readonly PanelEventEntry[] = [newest, oldest];
    const fetcher = vi.fn(() => Promise.resolve(new Response(JSON.stringify({ entries: serverEntries, nextCursor: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })));
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("WebSocket", TestEventsWebSocket);
    const queryKey = dashboardDataKeys.events("kanal-a", emptyEventFilter);
    const rendered = renderWithQuery(
      <UiProvider><EventsPage channelId="kanal-a" filters={emptyEventFilter} moduleOptions={[]} onFiltersChange={() => undefined} /></UiProvider>,
      undefined,
      {
        gcTime: 600_000,
        staleTime: 30_000,
        initialData: [{ queryKey, data: { pages: [{ entries: [newest, oldest], nextCursor: null }], pageParams: [null] } }],
      },
    );
    await waitFor(() => expect(rendered.queryClient.isFetching()).toBe(0));
    const position = positionEventReader(rendered.container);
    act(() => { position.away(); });
    const rowsBefore = Array.from(rendered.container.querySelectorAll(".event-table tbody tr"), (row) => row.textContent);
    serverEntries = [late, newest, oldest];
    const socket = TestEventsWebSocket.instances[0];
    if (socket === undefined) throw new Error("Realtime socket was not created.");
    socket.open();
    emitEventHint(socket, `hint-${lateEventId}`, late);

    await waitFor(() => {
      const data = rendered.queryClient.getQueryData<{ pages: Array<{ entries: PanelEventEntry[] }> }>(queryKey);
      expect(data?.pages.flatMap((page) => page.entries).some((candidate) => candidate.eventId === late.eventId)).toBe(true);
    });

    expect(Array.from(rendered.container.querySelectorAll(".event-table tbody tr"), (row) => row.textContent)).toEqual(rowsBefore);
    expect(screen.queryByText(new RegExp(lateEventId, "u"))).not.toBeInTheDocument();
    const notice = screen.getByRole("button", { name: /1 neue Ereignisse/u });
    expect(notice).toBeVisible();
    fireEvent.click(notice);
    expect(await screen.findByText(new RegExp(`Raid von ${lateEventId}`, "u"))).toBeVisible();
    rendered.unmount();
  });

  it("appends loaded older event rows without moving the frozen rows", async () => {
    const newest = entry({ eventId: "page-newest", createdAt: "2026-09-22T10:00:00.000Z" });
    const older = entry({ eventId: "page-older", createdAt: "2026-09-22T09:00:00.000Z" });
    const oldest = entry({
      eventId: "page-oldest",
      createdAt: "2026-09-22T08:00:00.000Z",
      moduleId: "channel_events",
      code: "channel_events.raid.incoming",
      detail: '{"source":"oldestpage","viewers":1}',
    });
    const olderDuplicate = entry({
      eventId: "page-older-duplicate",
      triggerId: newest.triggerId,
      createdAt: "2026-09-22T07:30:00.000Z",
      moduleId: "channel_events",
      code: "channel_events.raid.incoming",
      detail: '{"source":"olderduplicate","viewers":1}',
    });
    const response = (entries: readonly PanelEventEntry[], nextCursor: string | null) => new Response(JSON.stringify({ entries, nextCursor }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const fetcher = vi.fn((input: RequestInfo | URL) => Promise.resolve(
      requestUrl(input).searchParams.get("cursor") === "cursor-2"
        ? response([oldest, olderDuplicate], null)
        : requestUrl(input).searchParams.get("cursor") === "cursor-1"
          ? response([older], "cursor-2")
          : response([newest], "cursor-1"),
    ));
    vi.stubGlobal("fetch", fetcher);
    const queryKey = dashboardDataKeys.events("kanal-a", emptyEventFilter);
    const rendered = renderWithQuery(
      <UiProvider><EventsPage channelId="kanal-a" filters={emptyEventFilter} moduleOptions={[]} onFiltersChange={() => undefined} /></UiProvider>,
      undefined,
      {
        gcTime: 600_000,
        staleTime: 30_000,
        initialData: [{
          queryKey,
          data: {
            pages: [{ entries: [newest], nextCursor: "cursor-1" }, { entries: [older], nextCursor: "cursor-2" }],
            pageParams: [null, "cursor-1"],
          },
        }],
      },
    );
    await waitFor(() => expect(rendered.queryClient.isFetching()).toBe(0));
    const position = positionEventReader(rendered.container);
    act(() => { position.away(); });
    const before = Array.from(rendered.container.querySelectorAll(".event-table tbody tr"), (row) => row.textContent);

    fireEvent.click(screen.getByRole("button", { name: "Ältere Ereignisse laden" }));
    expect(await screen.findByText(/Raid von oldestpage/u)).toBeInTheDocument();
    const after = Array.from(rendered.container.querySelectorAll(".event-table tbody tr"), (row) => row.textContent);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after).toHaveLength(before.length + 1);
    expect(rendered.container.querySelector(".realtime-feed__notice-slot")).toHaveAttribute("data-pending", "false");
    rendered.unmount();
  });

  it("appends older-day rows after the frozen day sections", async () => {
    const previousDayError = new Date(2026, 8, 21, 23, 55).toISOString();
    const todayInfo = new Date(2026, 8, 22, 0, 5).toISOString();
    const todayOther = new Date(2026, 8, 22, 0, 3).toISOString();
    const olderTime = new Date(2026, 8, 21, 22, 0).toISOString();
    const crossMidnightInfo = entry({
      eventId: "cross-midnight-info",
      triggerId: "cross-midnight-trigger",
      createdAt: todayInfo,
      moduleId: "channel_events",
      code: "channel_events.chat.sub",
      detail: '{"person":"midnight-sub","tier":"1000"}',
    });
    const crossMidnightError = entry({
      eventId: "cross-midnight-error",
      triggerId: "cross-midnight-trigger",
      createdAt: previousDayError,
      code: "host.chat.failed",
    });
    const todayEntry = entry({
      eventId: "today-entry",
      createdAt: todayOther,
      moduleId: "channel_events",
      code: "channel_events.chat.sub",
      detail: '{"person":"today-sub","tier":"1000"}',
    });
    const olderEntry = entry({
      eventId: "older-day-entry",
      createdAt: olderTime,
      moduleId: "channel_events",
      code: "channel_events.raid.incoming",
      detail: '{"source":"olderday","viewers":1}',
    });
    const response = (entries: readonly PanelEventEntry[], nextCursor: string | null) => new Response(JSON.stringify({ entries, nextCursor }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const fetcher = vi.fn((input: RequestInfo | URL) => Promise.resolve(
      requestUrl(input).searchParams.get("cursor") === "older-cursor"
        ? response([olderEntry], null)
        : response([crossMidnightInfo, crossMidnightError, todayEntry], "older-cursor"),
    ));
    vi.stubGlobal("fetch", fetcher);
    const queryKey = dashboardDataKeys.events("kanal-a", emptyEventFilter);
    const rendered = renderWithQuery(
      <UiProvider><EventsPage channelId="kanal-a" filters={emptyEventFilter} moduleOptions={[]} onFiltersChange={() => undefined} /></UiProvider>,
      undefined,
      {
        gcTime: 600_000,
        staleTime: 30_000,
        initialData: [{
          queryKey,
          data: { pages: [{ entries: [crossMidnightInfo, crossMidnightError, todayEntry], nextCursor: "older-cursor" }], pageParams: [null] },
        }],
      },
    );
    await waitFor(() => expect(rendered.queryClient.isFetching()).toBe(0));
    const position = positionEventReader(rendered.container);
    act(() => { position.away(); });
    const rowLabels = (): string[] => Array.from(
      rendered.container.querySelectorAll<HTMLElement>(".event-table__primary .event-table__text"),
      (label) => label.textContent,
    );
    const before = rowLabels();
    expect(before).toEqual(["Chat-Nachricht fehlgeschlagen", "Sub von today-sub"]);

    fireEvent.click(screen.getByRole("button", { name: "Ältere Ereignisse laden" }));
    await screen.findByText(/Raid von olderday/u);
    expect(rowLabels()).toEqual([...before, expect.stringMatching(/Raid von olderday/u)]);
    rendered.unmount();
  });

  it("shows a filter's refreshed cached data when returning to that filter while scrolled away", async () => {
    const filtersA = { ...emptyEventFilter, module: "channel_events" };
    const filtersB = { ...emptyEventFilter, module: "host" };
    const oldRaid = entry({ eventId: "roundtrip-old", moduleId: "channel_events", code: "channel_events.raid.incoming", detail: '{"source":"oldroundtrip","viewers":1}' });
    const newRaid = entry({ eventId: "roundtrip-new", createdAt: "2026-09-22T10:01:00.000Z", moduleId: "channel_events", code: "channel_events.raid.incoming", detail: '{"source":"newroundtrip","viewers":2}' });
    const hostEntry = entry({ eventId: "roundtrip-host" });
    let serverHasNewRaid = false;
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const module = requestUrl(input).searchParams.get("module");
      const entries = module === "channel_events"
        ? serverHasNewRaid ? [newRaid, oldRaid] : [oldRaid]
        : [hostEntry];
      return Promise.resolve(new Response(JSON.stringify({ entries, nextCursor: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    });
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("WebSocket", TestEventsWebSocket);
    function Harness() {
      const [showHost, setShowHost] = useState(false);
      const filters = showHost ? filtersB : filtersA;
      return <>
        <button type="button" onClick={() => { setShowHost(!showHost); }}>Toggle filter</button>
        <EventsPage channelId="kanal-a" filters={filters} moduleOptions={[]} onFiltersChange={() => undefined} />
      </>;
    }
    const rendered = renderWithQuery(<UiProvider><Harness /></UiProvider>, undefined, {
      gcTime: 600_000,
      staleTime: 30_000,
      initialData: [
        { queryKey: dashboardDataKeys.events("kanal-a", filtersA), data: { pages: [{ entries: [oldRaid], nextCursor: null }], pageParams: [null] } },
        { queryKey: dashboardDataKeys.events("kanal-a", filtersB), data: { pages: [{ entries: [hostEntry], nextCursor: null }], pageParams: [null] } },
      ],
    });
    await waitFor(() => expect(rendered.queryClient.isFetching()).toBe(0));
    const position = positionEventReader(rendered.container);
    act(() => { position.away(); });
    TestEventsWebSocket.instances[0]?.open();
    fireEvent.click(screen.getByRole("button", { name: "Toggle filter" }));
    expect(await screen.findByText("Chat-Nachricht fehlgeschlagen")).toBeVisible();
    await waitFor(() => expect(rendered.queryClient.isFetching()).toBe(0));
    serverHasNewRaid = true;
    const socket = TestEventsWebSocket.instances[0];
    if (socket === undefined) throw new Error("Realtime socket was not created.");
    emitEventHint(socket, "roundtrip-hint", newRaid);
    await new Promise((resolve) => setTimeout(resolve, 150));
    fireEvent.click(screen.getByRole("button", { name: "Toggle filter" }));

    await waitFor(() => {
      const data = rendered.queryClient.getQueryData<{ pages: Array<{ entries: PanelEventEntry[] }> }>(dashboardDataKeys.events("kanal-a", filtersA));
      expect(data?.pages[0]?.entries[0]?.eventId).toBe("roundtrip-new");
    });
    expect(await screen.findByText(/Raid von newroundtrip/u)).toBeVisible();
    expect(screen.queryByText("Chat-Nachricht fehlgeschlagen")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /neue Ereignisse/u })).not.toBeInTheDocument();
    rendered.unmount();
  });

  it("updates three cached pages during a hint storm with at most one refresh in flight", async () => {
    vi.useFakeTimers();
    try {
      const raid = (id: string, source: string, minute: number) => entry({
        eventId: id,
        moduleId: "channel_events",
        code: "channel_events.raid.incoming",
        detail: `{"source":"${source}","viewers":1}`,
        createdAt: `2026-09-22T10:0${String(minute)}:00.000Z`,
      });
      const live = raid("live", "stormraid", 9);
      const pageEntries = [raid("p1", "pageone", 3), raid("p2", "pagetwo", 2), raid("p3", "pagethree", 1)];
      const nextCursors: Array<string | null> = ["c1", "c2", null];
      let serverHasLive = false;
      let inFlight = 0;
      let maxInFlight = 0;
      const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> => {
        const cursor = requestUrl(input).searchParams.get("cursor");
        const index = cursor === null ? 0 : cursor === "c1" ? 1 : 2;
        const entries = index === 0 && serverHasLive ? [live, pageEntries[0] as PanelEventEntry] : [pageEntries[index] as PanelEventEntry];
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        return new Promise<Response>((resolve) => {
          setTimeout(() => {
            inFlight -= 1;
            resolve(new Response(JSON.stringify({ entries, nextCursor: nextCursors[index] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }));
          }, 80);
        });
      });
      vi.stubGlobal("fetch", fetcher);
      vi.stubGlobal("WebSocket", TestEventsWebSocket);
      const rendered = renderWithQuery(
        <UiProvider><EventsPage channelId="kanal-a" filters={emptyEventFilter} moduleOptions={[]} onFiltersChange={() => undefined} /></UiProvider>,
        undefined,
        {
          gcTime: 600_000,
          staleTime: 30_000,
          initialData: [{
            queryKey: dashboardDataKeys.events("kanal-a", emptyEventFilter),
            data: {
              pages: pageEntries.map((page, index) => ({ entries: [page], nextCursor: nextCursors[index] ?? null })),
              pageParams: [null, "c1", "c2"],
            },
          }],
        },
      );
      // Let the revalidation on mount finish before the storm starts.
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      maxInFlight = 0;
      const socket = TestEventsWebSocket.instances[0];
      if (socket === undefined) throw new Error("Realtime socket was not created.");
      socket.open();
      serverHasLive = true;
      for (let index = 0; index < 12; index += 1) {
        socket.receive(JSON.stringify({
          version: 1,
          id: `storm-${String(index)}`,
          createdAt: live.createdAt,
          channelId: "kanal-a",
          type: "event_log.new",
          payload: { entries: [{ eventId: live.eventId, createdAt: live.createdAt, moduleId: live.moduleId, code: live.code, actorUserId: null }] },
        }));
        await act(async () => { await vi.advanceTimersByTimeAsync(150); });
      }
      // Hints are still arriving (faster than a full refetch) and the rows are already fresh.
      expect(screen.getByText(/Raid von stormraid/u)).toBeVisible();
      expect(maxInFlight).toBeLessThanOrEqual(1);
      rendered.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refetches a cached inactive filter that a hint matched while another filter was shown", async () => {
    const filtersA = { ...emptyEventFilter, module: "channel_events" };
    const filtersB = { ...emptyEventFilter, module: "host" };
    const oldRaid = entry({ eventId: "old", moduleId: "channel_events", code: "channel_events.raid.incoming", detail: '{"source":"oldraid","viewers":1}' });
    const newRaid = entry({ eventId: "new", moduleId: "channel_events", code: "channel_events.raid.incoming", detail: '{"source":"newraid","viewers":2}' });
    const hostEntry = entry({ eventId: "host-one" });
    let serverHasNewRaid = false;
    const fetcher = vi.fn((input: RequestInfo | URL) => Promise.resolve(new Response(JSON.stringify({
      entries: requestUrl(input).searchParams.get("module") === "channel_events" ? (serverHasNewRaid ? [newRaid, oldRaid] : [oldRaid]) : [hostEntry],
      nextCursor: null,
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("WebSocket", TestEventsWebSocket);
    function Harness() {
      const [showB, setShowB] = useState(false);
      const filters = showB ? filtersB : filtersA;
      return <>
        <button type="button" onClick={() => { setShowB(!showB); }}>Toggle filter</button>
        <EventsPage channelId="kanal-a" filters={filters} moduleOptions={[]} onFiltersChange={() => undefined} />
      </>;
    }
    const rendered = renderWithQuery(<UiProvider><Harness /></UiProvider>, undefined, {
      gcTime: 600_000,
      staleTime: 30_000,
      initialData: [
        { queryKey: dashboardDataKeys.events("kanal-a", filtersA), data: { pages: [{ entries: [oldRaid], nextCursor: null }], pageParams: [null] } },
        { queryKey: dashboardDataKeys.events("kanal-a", filtersB), data: { pages: [{ entries: [hostEntry], nextCursor: null }], pageParams: [null] } },
      ],
    });
    await waitFor(() => { expect(fetcher).toHaveBeenCalled(); });
    await waitFor(() => { expect(rendered.queryClient.isFetching()).toBe(0); });
    fetcher.mockClear();
    serverHasNewRaid = true;
    const socket = TestEventsWebSocket.instances[0];
    if (socket === undefined) throw new Error("Realtime socket was not created.");
    socket.open();
    fireEvent.click(screen.getByRole("button", { name: "Toggle filter" }));
    expect(screen.getByText("Chat-Nachricht fehlgeschlagen")).toBeVisible();
    await waitFor(() => { expect(rendered.queryClient.isFetching()).toBe(0); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockClear();
    socket.receive(JSON.stringify({
      version: 1,
      id: "only-a-hint",
      createdAt: newRaid.createdAt,
      channelId: "kanal-a",
      type: "event_log.new",
      payload: { entries: [{ eventId: newRaid.eventId, createdAt: newRaid.createdAt, moduleId: newRaid.moduleId, code: newRaid.code, actorUserId: null }] },
    }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Toggle filter" }));
    expect(await screen.findByText(/Raid von newraid/u)).toBeVisible();
    rendered.unmount();
  });

  it("serializes realtime refreshes with pagination and keeps refreshed events", async () => {
    const firstEntry = entry({ eventId: "first-page", code: "host.chat.failed" });
    const liveEntry = entry({
      eventId: "live-event",
      moduleId: "channel_events",
      code: "channel_events.raid.incoming",
      detail: '{"source":"freshraid","viewers":2}',
    });
    const olderEntry = entry({ eventId: "older-page", code: "host.chat.failed", createdAt: "2026-09-21T10:00:00.000Z" });
    let releaseRefresh: ((response: Response) => void) | undefined;
    let releaseNextPage: ((response: Response) => void) | undefined;
    let firstPageRequests = 0;
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = requestUrl(input);
      if (url.searchParams.has("cursor")) {
        return new Promise<Response>((resolve) => { releaseNextPage = resolve; });
      }
      firstPageRequests += 1;
      if (firstPageRequests === 1) {
        return Promise.resolve(new Response(JSON.stringify({ entries: [firstEntry], nextCursor: "cursor-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }
      return new Promise<Response>((resolve) => { releaseRefresh = resolve; });
    });
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("WebSocket", TestEventsWebSocket);

    const view = renderWithQuery(
      <UiProvider><EventsPage channelId="kanal-a" filters={emptyEventFilter} moduleOptions={[]} onFiltersChange={() => undefined} /></UiProvider>,
      undefined,
      { gcTime: 600_000 },
    );
    expect(await screen.findByText("Chat-Nachricht fehlgeschlagen")).toBeVisible();
    const socket = TestEventsWebSocket.instances[0];
    if (socket === undefined) throw new Error("Realtime socket was not created.");
    socket.open();
    socket.receive(JSON.stringify({
      version: 1,
      id: "live-event-message",
      createdAt: liveEntry.createdAt,
      channelId: "kanal-a",
      type: "event_log.new",
      payload: { entries: [{ eventId: liveEntry.eventId, createdAt: liveEntry.createdAt, moduleId: liveEntry.moduleId, code: liveEntry.code, actorUserId: null }] },
    }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    const refreshRows = view.container.querySelector(".event-feed [aria-busy]");
    const refreshBusyState = refreshRows?.getAttribute("aria-busy");
    fireEvent.click(screen.getByRole("button", { name: "Ältere Ereignisse laden" }));
    const paginationStarted = releaseNextPage !== undefined;
    releaseRefresh?.(new Response(JSON.stringify({ entries: [liveEntry, firstEntry], nextCursor: "cursor-1" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    if (paginationStarted) {
      releaseNextPage?.(new Response(JSON.stringify({ entries: [olderEntry], nextCursor: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }

    await waitFor(() => expect(screen.getByText("Raid von freshraid mit 2 Zuschauern")).toBeVisible());
    expect(refreshBusyState).toBe("true");
    view.unmount();
  });

  it("dispatches the shared authentication-required event when a realtime refresh returns 401", async () => {
    const initialEntry = entry({ eventId: "cached-event" });
    const fetcher = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = requestUrl(input);
      if (url.pathname.endsWith("/events") && fetcher.mock.calls.length === 1) {
        return Promise.resolve(new Response(JSON.stringify({ entries: [initialEntry], nextCursor: null }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }));
      }
      return Promise.resolve(new Response(JSON.stringify({ error: "session_expired" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }));
    });
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("WebSocket", TestEventsWebSocket);
    const onAuthenticationRequired = vi.fn();
    window.addEventListener(dashboardAuthenticationRequiredEvent, onAuthenticationRequired);

    const view = renderWithQuery(
      <UiProvider><EventsPage channelId="kanal-a" filters={emptyEventFilter} moduleOptions={[]} onFiltersChange={() => undefined} /></UiProvider>,
    );
    expect(await screen.findByText("Chat-Nachricht fehlgeschlagen")).toBeVisible();
    TestEventsWebSocket.instances[0]?.open();
    TestEventsWebSocket.instances[0]?.receive(JSON.stringify({
      version: 1,
      id: "expired-event-message",
      createdAt: "2026-09-22T10:00:00.000Z",
      channelId: "kanal-a",
      type: "event_log.new",
      payload: { entries: [{ eventId: "new-event", createdAt: "2026-09-22T10:00:00.000Z", moduleId: "host", code: "host.chat.failed", actorUserId: null }] },
    }));

    await waitFor(() => expect(onAuthenticationRequired).toHaveBeenCalledTimes(1));
    window.removeEventListener(dashboardAuthenticationRequiredEvent, onAuthenticationRequired);
    view.unmount();
  });

  it("uses the audit page person search placeholder", () => {
    renderPage([]);

    expect(screen.getByRole("textbox", { name: "Person" })).toHaveAttribute("placeholder", "Login oder ID, z. B. beispielnutzer");
  });

  it("shows the cause icon only on warning/error rows whose diagnostic detail carries a cause", () => {
    renderPage([
      entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" }),
      entry({ eventId: "no-cause", code: "host.action.failed", detail: "{}" }),
      // An info-tone row with a `reason` key still gets no icon -- the tone
      // guard runs before the cause lookup, not just when there's nothing
      // to show.
      entry({ eventId: "info-row", code: "channel_events.chat.sub", detail: "{\"tier\":\"1000\",\"reason\":\"rate_limited\"}" }),
    ]);

    expect(screen.getAllByRole("button", { name: causeButtonName })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Ursache anzeigen: Chat-Nachricht fehlgeschlagen" })).toBeInTheDocument();
  });

  it("shows the localized cause in a popover on hover, without opening the inspector", async () => {
    renderPage([entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" })]);

    const trigger = screen.getByRole("button", { name: causeButtonName });
    fireEvent.mouseEnter(trigger);

    expect(await screen.findByText("Twitch-Abklingzeit aktiv")).toBeInTheDocument();
    expect(screen.queryByText("Vorgang")).not.toBeInTheDocument();
  });

  it("shows the cause on keyboard focus", async () => {
    renderPage([entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" })]);

    const trigger = screen.getByRole("button", { name: causeButtonName });
    fireEvent.focus(trigger);

    expect(await screen.findByText("Twitch-Abklingzeit aktiv")).toBeInTheDocument();
  });

  it("opens on click, the same way it does on tap", async () => {
    renderPage([entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" })]);

    const trigger = screen.getByRole("button", { name: causeButtonName });
    fireEvent.click(trigger);

    expect(await screen.findByText("Twitch-Abklingzeit aktiv")).toBeInTheDocument();
  });

  it("dismisses on Escape", async () => {
    renderPage([entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" })]);

    const trigger = screen.getByRole("button", { name: causeButtonName });
    fireEvent.focus(trigger);
    expect(await screen.findByText("Twitch-Abklingzeit aktiv")).toBeInTheDocument();

    fireEvent.keyDown(trigger, { key: "Escape", code: "Escape" });
    await waitFor(() => { expect(screen.queryByText("Twitch-Abklingzeit aktiv")).not.toBeInTheDocument(); });
  });

  it("stays open while the pointer moves from the trigger to the dropdown", async () => {
    renderPage([entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" })]);

    const trigger = screen.getByRole("button", { name: causeButtonName });
    fireEvent.mouseEnter(trigger);
    const content = await screen.findByText("Twitch-Abklingzeit aktiv");
    // jsdom never resolves Mantine's open transition, so the dropdown stays
    // `display: none` inline and `getByRole("tooltip")` (which filters
    // hidden elements) can't see it -- reach it via the text node instead.
    const dropdown = content.closest("[role='tooltip']");
    if (dropdown === null) throw new Error("dropdown missing");

    // Leaving the trigger for the dropdown before the close delay elapses
    // must not close it -- this is the pointer-transition case a plain
    // `onMouseLeave` on the trigger alone gets wrong.
    fireEvent.mouseLeave(trigger);
    fireEvent.mouseEnter(dropdown);
    expect(screen.getByText("Twitch-Abklingzeit aktiv")).toBeInTheDocument();

    fireEvent.mouseLeave(dropdown);
    await waitFor(() => { expect(screen.queryByText("Twitch-Abklingzeit aktiv")).not.toBeInTheDocument(); });
  });

  it("stays open when the mouse leaves while the trigger still has keyboard focus", () => {
    vi.useFakeTimers();
    try {
      renderPage([entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" })]);

      const trigger = screen.getByRole("button", { name: causeButtonName });
      // Hover and focus together, e.g. a mouse click that both hovers and
      // focuses the button -- then only the hover ends.
      fireEvent.mouseEnter(trigger);
      fireEvent.focus(trigger);
      // Mantine mounts the dropdown a tick after `opened` flips, via its own
      // (now fake) timer -- advance past it before the content is queryable.
      vi.advanceTimersByTime(50);
      expect(screen.getByText("Twitch-Abklingzeit aktiv")).toBeInTheDocument();

      fireEvent.mouseLeave(trigger);
      // Past the close delay: a mouseleave-only close would have fired by
      // now, but focus is still active, so it must stay open.
      vi.advanceTimersByTime(1000);
      expect(screen.getByText("Twitch-Abklingzeit aktiv")).toBeInTheDocument();

      // Losing focus too, with hover already gone, closes it -- checked via
      // `aria-describedby` (this component's own `opened` state, updated
      // synchronously) rather than the dropdown's removal from the DOM:
      // Mantine's exit transition never resolves in jsdom (no real
      // `transitionend`), so the node lingers there regardless.
      fireEvent.blur(trigger);
      expect(trigger).not.toHaveAttribute("aria-describedby");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears its pending close timer on unmount instead of leaving it running", () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(window, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(window, "clearTimeout");
    try {
      const { unmount } = renderPage([entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" })]);

      const trigger = screen.getByRole("button", { name: causeButtonName });
      fireEvent.mouseEnter(trigger);
      vi.advanceTimersByTime(50);
      expect(screen.getByText("Twitch-Abklingzeit aktiv")).toBeInTheDocument();

      // A hover-out schedules exactly one delayed close.
      setTimeoutSpy.mockClear();
      fireEvent.mouseLeave(trigger);
      expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
      const closeTimerId: unknown = setTimeoutSpy.mock.results[0]?.value;

      // Unmounting before it fires must cancel that specific timer, not
      // leave it running against an unmounted component. (React 18+ no
      // longer warns to console.error on a state update after unmount, so
      // that can't be used to detect a missing cleanup here -- this checks
      // the timer directly instead.)
      unmount();
      expect(clearTimeoutSpy).toHaveBeenCalledWith(closeTimerId);
    } finally {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not open the inspector when the cause icon is clicked", () => {
    renderPage([entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" })]);

    const trigger = screen.getByRole("button", { name: causeButtonName });
    fireEvent.click(trigger);

    expect(screen.queryByText("Vorgang")).not.toBeInTheDocument();
    const row = trigger.closest("tr");
    expect(row).toHaveAttribute("aria-selected", "false");
  });

  it("renders a legacy German reason value from before issue #191's rename correctly", () => {
    // Rows persisted before the rename still carry the old value for up to
    // 14 days (event log retention) -- `eventDetail` migrates it before any
    // formatter sees it.
    renderPage([entry({ eventId: "legacy", moduleId: "raid", code: "raid.invalid", detail: "{\"reason\":\"ziel_ungueltig\"}" })]);

    expect(screen.getByText("Raid verworfen: Ziel ungültig")).toBeInTheDocument();
    expect(screen.queryByText(/ziel_ungueltig/)).not.toBeInTheDocument();
  });

  it("normalizes a legacy reason in the inspector's technical details too, not just the row", () => {
    renderPage([entry({ eventId: "legacy", moduleId: "raid", code: "raid.invalid", detail: "{\"reason\":\"ziel_ungueltig\"}" })]);

    fireEvent.click(screen.getByText("Raid verworfen: Ziel ungültig").closest("tr") as HTMLElement);
    const technicalDetails = document.querySelector(".event-detail-json");
    expect(technicalDetails).not.toBeNull();
    expect(technicalDetails?.textContent).toContain("target_invalid");
    expect(technicalDetails?.textContent).not.toContain("ziel_ungueltig");
  });

  it("still falls back to the raw stored string in technical details for malformed detail JSON", () => {
    renderPage([entry({ eventId: "malformed", moduleId: "host", code: "host.action.failed", detail: "not json" })]);

    fireEvent.click(screen.getByText("Aktion fehlgeschlagen").closest("tr") as HTMLElement);
    const technicalDetails = document.querySelector(".event-detail-json");
    expect(technicalDetails?.textContent).toBe("not json");
  });

  it("leaves a moderation event's free-text reason untouched even when it equals an old legacy value", () => {
    // "abgeschaltet" is only a legacy machine-code value for ads.skipped,
    // raid.invalid, and shoutout.suppressed (issue #191) -- a moderator's
    // own ban reason happening to be that word is unrelated content and
    // must not be rewritten to "disabled".
    renderPage([entry({
      eventId: "moderation-ban", moduleId: "channel_events", code: "channel_events.moderation.ban",
      detail: "{\"person\":\"chattyfan\",\"moderator\":\"mod1\",\"reason\":\"abgeschaltet\"}",
    })]);

    expect(screen.getByText("chattyfan gebannt von mod1: abgeschaltet")).toBeInTheDocument();
    expect(screen.queryByText(/disabled/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("chattyfan gebannt von mod1: abgeschaltet").closest("tr") as HTMLElement);
    const technicalDetails = document.querySelector(".event-detail-json");
    expect(technicalDetails?.textContent).toContain("abgeschaltet");
    expect(technicalDetails?.textContent).not.toContain("disabled");
  });

  it("hides the icon when the row's own event text already spells the cause out", () => {
    renderPage([
      // "ads.commercial.failed" already renders "... Twitch hat den Start
      // abgelehnt" inline -- the popover would just repeat it.
      entry({ eventId: "spelled-out", moduleId: "ads", code: "ads.commercial.failed", detail: "{\"reason\":\"twitch_error\"}" }),
      // "host.clip.failed" stays generic ("Clip fehlgeschlagen") regardless
      // of the reason, so the icon still earns its place.
      entry({ eventId: "still-hidden", moduleId: "host", code: "host.clip.failed", detail: "{\"reason\":\"twitch_error\"}" }),
    ]);

    expect(screen.getAllByRole("button", { name: causeButtonName })).toHaveLength(1);
    expect(screen.getByText(/Werbeeinblendung nicht gestartet: Twitch hat den Start abgelehnt/)).toBeInTheDocument();
  });

  it("shows the icon for an uncatalogued shoutout cause and quotes Twitch's own message in the popover (issue #201)", async () => {
    // Producer-shaped: `sendShoutout` (worker/shoutout.ts) never actually
    // emits a raw `http_<status>` cause -- an unclassified status falls
    // back to its own catalogued "twitch_error", and the Helix-sourced
    // message lands under `twitchMessage`, not `message`.
    renderPage([entry({
      eventId: "shoutout-twitch-error", moduleId: "host", code: "host.shoutout.failed",
      detail: "{\"cause\":\"twitch_error\",\"twitchMessage\":\"The broadcaster is not streaming live or does not have one or more viewers.\"}",
    })]);

    expect(screen.getByText("Shoutout fehlgeschlagen: Twitch hat den Shoutout abgelehnt")).toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: causeButtonName });
    fireEvent.mouseEnter(trigger);

    expect(await screen.findByText("Twitch hat den Shoutout abgelehnt")).toBeInTheDocument();
    expect(await screen.findByText("Twitch: The broadcaster is not streaming live or does not have one or more viewers.")).toBeInTheDocument();
  });

  it("still shows the icon for a legacy-shaped shoutout row with a raw http_<status> cause (staging has old rows like this)", async () => {
    // Rows written before `sendShoutout` normalized every status also
    // predate the `twitchMessage` rename -- the Twitch text they carry is
    // still under the old `message` key. `detail.cause` here isn't one of
    // `SHOUTOUT_FAILURE_REASONS` either way, so the row shows nothing but
    // "Shoutout fehlgeschlagen", full stop.
    renderPage([entry({
      eventId: "shoutout-legacy-http-400", moduleId: "host", code: "host.shoutout.failed",
      detail: "{\"cause\":\"http_400\",\"message\":\"The broadcaster is not streaming live or does not have one or more viewers.\"}",
    })]);

    expect(screen.getByText("Shoutout fehlgeschlagen")).toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: causeButtonName });
    fireEvent.mouseEnter(trigger);

    expect(await screen.findByText("The broadcaster is not streaming live or does not have one or more viewers.")).toBeInTheDocument();
  });

  it("shows the icon for a catalogued ads.commercial.failed cause when Twitch also supplied its own message (issue #201)", async () => {
    // Producer-shaped: `commercialReasonFor` (modules/ads/adapters/
    // commercial.ts) falls back to "twitch_error" for an unclassified
    // status, and its Helix-sourced message lands under `twitchMessage`.
    // The row only ever shows the generic catalogued phrase -- Twitch's
    // own, more specific explanation never appears anywhere else.
    renderPage([entry({
      eventId: "commercial-twitch-error", moduleId: "ads", code: "ads.commercial.failed",
      detail: "{\"reason\":\"twitch_error\",\"twitchMessage\":\"The broadcaster is not streaming live or does not have one or more viewers.\"}",
    })]);

    const trigger = screen.getByRole("button", { name: causeButtonName });
    fireEvent.mouseEnter(trigger);

    expect(await screen.findByText("Twitch hat den Start abgelehnt")).toBeInTheDocument();
    expect(await screen.findByText("Twitch: The broadcaster is not streaming live or does not have one or more viewers.")).toBeInTheDocument();
  });

  it("labels a local error message neutrally instead of as Twitch's, when the producer's own exception put it there (issue #201)", async () => {
    // `startCommercial`'s own `getAppAccessToken` failure puts the caught
    // exception's message under the generic `message` key, not `twitchMessage`
    // -- Twitch never said this, so the popover must not claim it did.
    renderPage([entry({
      eventId: "commercial-local-error", moduleId: "ads", code: "ads.commercial.failed",
      detail: "{\"reason\":\"app_token_unavailable\",\"message\":\"fetch failed: connection refused\"}",
    })]);

    const trigger = screen.getByRole("button", { name: causeButtonName });
    fireEvent.mouseEnter(trigger);

    expect(await screen.findByText("App-Token nicht verfügbar")).toBeInTheDocument();
    expect(await screen.findByText("Details: fetch failed: connection refused")).toBeInTheDocument();
    expect(screen.queryByText(/^Twitch:/)).not.toBeInTheDocument();
  });

  it("renders a long unbroken diagnostic message inside the wrapping popover container (issue #201)", async () => {
    // No spaces at all -- exactly the shape a fixed-width popover can't
    // break on without `overflow-wrap: anywhere` (see `.event-cause` in
    // styles.css, which carries the actual wrapping and max-height/scroll
    // rules -- a jsdom component test has no layout engine to assert the
    // computed style against, so the Playwright visual check covers the
    // rendered result; this checks the message reaches that container
    // intact). Under the 300-char ingestion cap, so this exercises the
    // layout wiring, not the cap itself (see `tests/unit/event-log.test.ts`
    // for that).
    const longUnbrokenMessage = "a".repeat(280);
    renderPage([entry({
      eventId: "shoutout-long-message", moduleId: "host", code: "host.shoutout.failed",
      detail: `{"cause":"twitch_error","twitchMessage":"${longUnbrokenMessage}"}`,
    })]);

    const trigger = screen.getByRole("button", { name: causeButtonName });
    fireEvent.mouseEnter(trigger);

    const messageLine = await screen.findByText(`Twitch: ${longUnbrokenMessage}`);
    expect(messageLine.closest(".event-cause")).not.toBeNull();
  });

  it("hides the icon for host.announcement.failed and uses the shared shoutout catalog wording in the row", () => {
    renderPage([entry({
      eventId: "announcement-failed", moduleId: "host", code: "host.announcement.failed",
      detail: "{\"reason\":\"not_moderator\",\"outcome\":\"not_sent\"}",
    })]);

    expect(screen.queryByRole("button", { name: causeButtonName })).not.toBeInTheDocument();
    expect(screen.getByText("Ankündigung nicht möglich (Der Bot ist kein Moderator in diesem Kanal) — nicht gesendet")).toBeInTheDocument();
  });

  it("localizes an uncatalogued http_<status> reason in the row instead of leaking it raw (host.announcement.failed)", () => {
    renderPage([entry({
      eventId: "announcement-http", moduleId: "host", code: "host.announcement.failed",
      detail: "{\"reason\":\"http_500\",\"outcome\":\"not_sent\"}",
    })]);

    expect(screen.getByText("Ankündigung nicht möglich (Twitch antwortete mit Fehler 500) — nicht gesendet")).toBeInTheDocument();
    expect(screen.queryByText(/http_500/)).not.toBeInTheDocument();
  });

  it("shows Twitch's own message in the row once dispatch preserves it, instead of the generic http_<status> fallback (issue #201)", () => {
    // dispatch.ts used to drop sendChatAnnouncement's `twitchMessage` in
    // both fallback paths, keeping only `status` -- this is that value
    // reaching the row through `eventCauseText`'s own message fallback.
    renderPage([entry({
      eventId: "announcement-twitch-message", moduleId: "host", code: "host.announcement.failed",
      detail: "{\"reason\":\"http_500\",\"outcome\":\"not_sent\",\"twitchMessage\":\"Malformed announcement request.\"}",
    })]);

    expect(screen.getByText("Ankündigung nicht möglich (Malformed announcement request.) — nicht gesendet")).toBeInTheDocument();
    expect(screen.queryByText(/Twitch antwortete mit Fehler 500/)).not.toBeInTheDocument();
    // Already folded into the row -- no separate icon needed.
    expect(screen.queryByRole("button", { name: causeButtonName })).not.toBeInTheDocument();
  });

  it("uses the clip catalog's wording, not the shoutout one, for host.clip.failed", async () => {
    renderPage([entry({ eventId: "clip-failed", moduleId: "host", code: "host.clip.failed", detail: "{\"reason\":\"scope_missing\"}" })]);

    const trigger = screen.getByRole("button", { name: "Ursache anzeigen: Clip fehlgeschlagen" });
    fireEvent.mouseEnter(trigger);

    expect(await screen.findByText("Berechtigung zum Erstellen von Clips fehlt")).toBeInTheDocument();
    expect(screen.queryByText("Berechtigung zum Senden des Shoutouts fehlt")).not.toBeInTheDocument();
  });

  it("follows the browser language for both the cause text and the trigger's accessible name", async () => {
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    renderPage([entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" })]);

    const trigger = screen.getByRole("button", { name: "Show cause: Chat message failed" });
    fireEvent.mouseEnter(trigger);

    expect(await screen.findByText("Twitch cooldown is active")).toBeInTheDocument();
  });

  it("shows a localized label for the host module instead of the raw id (issue #201)", () => {
    renderPage([entry({ eventId: "host-row", moduleId: "host", code: "host.clip.failed", detail: "{}" })]);

    // Once in the module column, once in the mobile meta line -- both read
    // the same `moduleLabel`.
    expect(screen.getAllByText("System").length).toBeGreaterThan(0);
    expect(screen.queryByText("host")).not.toBeInTheDocument();
  });

  it("renders just the generic label when a chat notification's type is missing, without a doubled placeholder (issue #201)", () => {
    renderPage([entry({
      eventId: "chat-unknown", moduleId: "channel_events", code: "channel_events.chat.unknown", detail: "{}",
    })]);

    expect(screen.getByText("Unbekannte Chat-Benachrichtigung")).toBeInTheDocument();
    expect(screen.queryByText(/unbekannt$/)).not.toBeInTheDocument();
  });

  it("still shows the notice type when a chat notification's type is present but unhandled", () => {
    renderPage([entry({
      eventId: "chat-unknown-typed", moduleId: "channel_events", code: "channel_events.chat.unknown", detail: "{\"art\":\"charity_donation\"}",
    })]);

    expect(screen.getByText("Unbekannte Chat-Benachrichtigung: charity_donation")).toBeInTheDocument();
  });

  it("still opens the inspector when the row itself is clicked", () => {
    renderPage([entry({ eventId: "with-cause", code: "host.chat.failed", detail: "{\"reason\":\"rate_limited\"}" })]);

    const trigger = screen.getByRole("button", { name: causeButtonName });
    const row = trigger.closest("tr");
    if (row === null) throw new Error("row missing");
    fireEvent.click(row);

    expect(row).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByText("Vorgang").length).toBeGreaterThan(0);
  });
});
