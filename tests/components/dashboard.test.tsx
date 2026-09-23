import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardApp } from "../../src/dashboard/main";
import { dashboardRoutePath, parseDashboardRoute } from "../../src/dashboard/router";

const moderator = {
  isModerator: true,
  checkedAt: "2026-09-18T02:00:00.000Z",
  reason: null,
};

const relativeIso = (milliseconds: number): string => new Date(Date.now() + milliseconds).toISOString();

const healthyChannel = (channelId: string, displayName: string) => ({
  channelId,
  login: channelId,
  displayName,
  role: "manager",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: relativeIso(0) },
  moderator,
  // Without a chat subscription the channel receives no events; a healthy
  // channel therefore has one. If it's missing, that's a warning, not the
  // normal state.
  chatSubscription: { status: "enabled", subscriptionId: "abo-1", reason: null, updatedAt: relativeIso(0) },
  tokens: {
    botExpiresAt: relativeIso(3 * 60 * 60 * 1000),
    loginStatus: "connected",
    loginReason: null,
    loginExpiresAt: relativeIso(3 * 60 * 60 * 1000),
  },
  lastError: null,
});

const overview = (channel: ReturnType<typeof healthyChannel>) => ({
  ...channel,
  activeModules: [],
});

const system = {
  broadcasterConnection: "connected",
  bot: { status: "connected", reason: null, updatedAt: relativeIso(0) },
  tokens: {
    botExpiresAt: relativeIso(3 * 60 * 60 * 1000),
    loginStatus: "connected",
    loginReason: null,
    loginExpiresAt: "2099-09-19T00:00:00.000Z",
  },
};

const systemFor = (reason: string) => ({
  ...system,
  bot: { ...system.bot, reason },
});

const audit = { entries: [], nextCursor: null };

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

/**
 * Provides channel and member responses and opens the members page. The
 * three access tests differ only in their member data; everything else is
 * scaffolding.
 */
const showMembers = async (members: {
  members: unknown[];
  broadcasterCount: number;
  viewerUserId: string;
}): Promise<void> => {
  const channel = healthyChannel("kanal-a", "Alpha");
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const path = requestUrl(input).pathname;
    if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
    if (path.endsWith("/members")) return jsonResponse({ ...members, nextCursor: null });
    return jsonResponse({}, 404);
  }));
  window.history.replaceState({}, "", "/channels/kanal-a/members");
  render(<DashboardApp />);
  await screen.findByRole("heading", { name: "Mitglieder", level: 1 });
};

const broadcaster = (userId: string, login: string, displayName: string) => ({
  userId, login, displayName, profileImageUrl: null, role: "broadcaster", joinedAt: "2026-09-17T12:00:00.000Z",
});

const requestUrl = (input: RequestInfo | URL): URL => {
  if (input instanceof Request) return new URL(input.url);
  if (input instanceof URL) return input;
  return new URL(input, window.location.origin);
};

class TestWebSocket {
  static instances: TestWebSocket[] = [];
  readonly url: string;
  readonly protocols: string | string[];
  readyState = 0;
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(url: string, protocols: string | string[]) {
    this.url = url;
    this.protocols = protocols;
    TestWebSocket.instances.push(this);
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
    this.readyState = 1;
    this.emit("open", new Event("open"));
  }

  receive(data: string): void {
    this.emit("message", new MessageEvent("message", { data }));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close", new CloseEvent("close", { code, reason, wasClean: true }));
  }

  static reset(): void {
    TestWebSocket.instances = [];
  }
}

describe("Dashboard skeleton", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    Object.defineProperty(window, "scrollY", { configurable: true, value: 0 });
    TestWebSocket.reset();
  });

  afterEach(() => {
    cleanup();
    TestWebSocket.reset();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });
  });

  it("recognizes the channel-bound system route", () => {
    expect(parseDashboardRoute("/channels/kanal-a/system")).toEqual({
      kind: "channel",
      channelId: "kanal-a",
      section: "system",
    });
  });

  it("recognizes the channel-bound members route", () => {
    expect(parseDashboardRoute("/channels/kanal-a/members")).toEqual({
      kind: "channel",
      channelId: "kanal-a",
      section: "members",
    });
  });

  it("recognizes the channel-bound events route", () => {
    expect(parseDashboardRoute("/channels/kanal-a/events")).toEqual({
      kind: "channel",
      channelId: "kanal-a",
      section: "events",
    });
  });

  it("recognizes the subpage of a channel-bound module", () => {
    expect(parseDashboardRoute("/channels/kanal-a/modules/text_commands")).toEqual({
      kind: "module",
      channelId: "kanal-a",
      moduleId: "text_commands",
    });
  });

  it("keeps unknown module IDs as a module route for the detail page", () => {
    expect(parseDashboardRoute("/channels/kanal-a/modules/unbekannt")).toEqual({
      kind: "module",
      channelId: "kanal-a",
      moduleId: "unbekannt",
    });
  });

  it("discards an invalidly encoded module route", () => {
    expect(parseDashboardRoute("/channels/kanal-a/modules/%ZZ")).toEqual({ kind: "overview" });
  });

  it("encodes channel and module ID in the module route", () => {
    expect(dashboardRoutePath({ kind: "module", channelId: "kanal/a", moduleId: "text befehle" }))
      .toBe("/channels/kanal%2Fa/modules/text%20befehle");
  });

  it("parses both /platform and the pre-rename /betreiber into the platform route", () => {
    expect(parseDashboardRoute("/platform")).toEqual({ kind: "platform" });
    expect(parseDashboardRoute("/betreiber")).toEqual({ kind: "platform" });
  });

  it("only ever emits /platform for the platform route", () => {
    expect(dashboardRoutePath({ kind: "platform" })).toBe("/platform");
  });

  it("shows events with module, code, detail and actor", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/events")) return jsonResponse({
        entries: [{
          eventId: "event-1",
          createdAt: "2026-09-18T04:00:00.000Z",
          moduleId: "raid",
          code: "shoutout.suppressed",
          detail: '{"grund":"raid_erkannt"}',
          actorUserId: null,
        }, {
          eventId: "event-2",
          createdAt: "2026-09-18T04:01:00.000Z",
          moduleId: "unbekanntes-modul",
          code: "plugin.anderes",
          detail: "kein-json",
          actorUserId: "user-2",
          actorLogin: null,
          actorDisplayName: null,
        }, {
          eventId: "event-3",
          createdAt: "2026-09-18T04:02:00.000Z",
          moduleId: "chat",
          code: "host.chat.sent",
          detail: "{}",
          actorUserId: "user-1",
          actorLogin: "alice",
          actorDisplayName: null,
        }, {
          eventId: "event-4",
          createdAt: "2026-09-18T04:03:00.000Z",
          moduleId: "chat",
          code: "host.action.failed",
          detail: "{}",
          actorUserId: "user-1",
          actorLogin: "alice",
          actorDisplayName: null,
        }],
        nextCursor: null,
      });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Ereignisse", level: 1 })).toBeInTheDocument();
    expect(await screen.findByText(/aktualisiert vor/)).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Zeit" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Ereignis" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Modul" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Wer" })).toBeInTheDocument();
    expect(screen.getByText("Shoutout unterdrückt")).toBeInTheDocument();
    const eventRow = screen.getByText("Shoutout unterdrückt").closest("tr");
    const unknownEvent = screen.getByText("plugin.anderes", { selector: ".event-table__text" });
    const unknownRow = unknownEvent.closest("tr");
    expect(eventRow?.querySelector("td:nth-child(2)")).toHaveTextContent("Raid-Shoutout");
    expect(eventRow?.querySelector("td:nth-child(3)")).toHaveTextContent("Automatisch");
    expect(unknownEvent).toHaveClass("mono");
    expect(unknownRow?.querySelector("td:nth-child(2)")).toHaveClass("mono");
    expect(unknownRow?.querySelector("td:nth-child(3)")).toHaveTextContent("user-2");
    expect(unknownRow?.querySelector("td:nth-child(3) .mono")).toBeInTheDocument();
    const sentRow = screen.getByText("Chat-Nachricht gesendet").closest("tr");
    const failedRow = screen.getByText("Aktion fehlgeschlagen").closest("tr");
    expect(sentRow?.querySelector(".event-chip[data-tone='info']")).toHaveTextContent("Info");
    expect(within(sentRow as HTMLElement).getByText("Info")).toBeInTheDocument();
    expect(failedRow?.querySelector(".event-chip[data-tone='error']")).toHaveTextContent("Fehler");
    expect(within(failedRow as HTMLElement).getByText("Fehler")).toBeInTheDocument();
    const unknownEventRow = unknownRow;
    expect(eventRow).not.toBeNull();
    expect(unknownEventRow).not.toBeNull();
    fireEvent.keyDown(unknownEventRow as HTMLElement, { key: " " });
    expect(unknownEventRow).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByText("Unbekannt")).toHaveLength(2);
    expect(screen.getByText("kein-json")).toBeInTheDocument();
    fireEvent.keyDown(eventRow as HTMLElement, { key: "Enter" });
    expect(eventRow).toHaveAttribute("aria-selected", "true");
    expect(unknownEventRow).toHaveAttribute("aria-selected", "false");
    expect(screen.getByText("shoutout.suppressed")).toBeInTheDocument();
    expect(screen.getByText(/"grund": "raid_erkannt"/)).toBeInTheDocument();
    const displayedTime = eventRow?.querySelector("td:last-child time");
    expect(displayedTime).toHaveTextContent(/^04:00$/);
    expect(displayedTime).toHaveAttribute("title", "2026-09-18T04:00:00.000Z");
  });

  it("groups rows by day, newest day first, each with its own table", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/events")) return jsonResponse({
        entries: [
          { eventId: "today", createdAt: "2026-09-18T04:00:00.000Z", moduleId: "raid", code: "raid.shoutout", detail: "{}", actorUserId: null },
          { eventId: "yesterday", createdAt: "2026-09-17T04:00:00.000Z", moduleId: "raid", code: "raid.outgoing", detail: "{}", actorUserId: null },
        ],
        nextCursor: null,
      });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    const headings = (await screen.findAllByRole("heading", { level: 3 })).map((heading) => heading.textContent);
    expect(headings).toEqual(["18.09.2026", "17.09.2026"]);
    expect(screen.getAllByRole("table")).toHaveLength(2);
  });

  it("shows the event chip pair with family, tier, number and time tooltip", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/events")) return jsonResponse({
        entries: [
          { eventId: "gift", createdAt: "2026-09-18T04:00:00.000Z", moduleId: "channel_events", code: "channel_events.chat.community_gift", detail: '{"count":5}', actorUserId: null },
          { eventId: "raid", createdAt: "2026-09-18T04:01:00.000Z", moduleId: "channel_events", code: "channel_events.raid.incoming", detail: '{"viewers":21}', actorUserId: null },
          { eventId: "untimeout", createdAt: "2026-09-18T04:02:00.000Z", moduleId: "channel_events", code: "channel_events.moderation.untimeout", detail: "{}", actorUserId: null },
          { eventId: "sent", createdAt: "2026-09-18T04:03:00.000Z", moduleId: "text_commands", code: "host.chat.sent", detail: "{}", actorUserId: null },
          { eventId: "unknown", createdAt: "2026-09-18T04:04:00.000Z", moduleId: "plugin", code: "plugin.anderes", detail: "kein-json", actorUserId: null },
        ],
        nextCursor: null,
      });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    const giftRow = (await screen.findByText("Community-Gift von unbekannt für 5 Subs")).closest("tr");
    const raidRow = (await screen.findByText("Raid von unbekannt mit 21 Zuschauern")).closest("tr");
    const untimeoutRow = (await screen.findByText("unbekannt aus dem Timeout genommen von unbekannt")).closest("tr");
    const sentRow = (await screen.findByText("Chat-Nachricht gesendet")).closest("tr");
    const unknownRow = (await screen.findByText("plugin.anderes")).closest("tr");
    if (giftRow === null || raidRow === null || untimeoutRow === null || sentRow === null || unknownRow === null) {
      throw new Error("Ereigniszeile fehlt");
    }

    expect([...giftRow.querySelectorAll(".event-chip")].map((chip) => chip.textContent)).toEqual(["5x", "Gift"]);
    expect(giftRow.querySelector(".event-chip[data-family='community'][data-tier='full']")).toHaveTextContent("Gift");
    expect([...raidRow.querySelectorAll(".event-chip")].map((chip) => chip.textContent)).toEqual(["21", "Raid"]);
    expect(raidRow.querySelector(".event-chip[data-family='raid'][data-tier='full']")).toHaveTextContent("Raid");
    expect(untimeoutRow.querySelector(".event-chip[data-family='moderation'][data-tier='outlined']")).toHaveTextContent("Entsperrt");
    expect(sentRow.querySelector(".event-chip[data-tone='info'][data-tier='outlined']")).toHaveTextContent("Info");
    expect(sentRow.querySelector(".event-chip[data-tier='full']")).toBeNull();
    expect(unknownRow.querySelector(".event-chip")).toHaveTextContent("Unbekannt");
    expect(unknownRow.querySelector(".event-label > .mono")).toHaveTextContent("plugin.anderes");
    const timeCell = giftRow.querySelector("td:last-child");
    if (timeCell === null) throw new Error("Zeitspalte fehlt");
    expect(timeCell.getAttribute("title")).toBe("2026-09-18T04:00:00.000Z");
  });

  it("shows subscription tiers in the number chip as T1/T2/T3/Prime instead of raw, unknown values without a chip", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/events")) return jsonResponse({
        entries: [
          { eventId: "t1", createdAt: "2026-09-18T04:00:00.000Z", moduleId: "channel_events", code: "channel_events.chat.sub", detail: '{"person":"tier1","tier":"1000"}', actorUserId: null },
          { eventId: "t2", createdAt: "2026-09-18T04:01:00.000Z", moduleId: "channel_events", code: "channel_events.chat.sub", detail: '{"person":"tier2","tier":"2000"}', actorUserId: null },
          { eventId: "t3", createdAt: "2026-09-18T04:02:00.000Z", moduleId: "channel_events", code: "channel_events.chat.sub", detail: '{"person":"tier3","tier":"3000"}', actorUserId: null },
          { eventId: "prime", createdAt: "2026-09-18T04:03:00.000Z", moduleId: "channel_events", code: "channel_events.chat.sub", detail: '{"person":"primeperson","tier":"Prime"}', actorUserId: null },
          { eventId: "unbekannt", createdAt: "2026-09-18T04:04:00.000Z", moduleId: "channel_events", code: "channel_events.chat.sub", detail: '{"person":"rätselperson","tier":"9999"}', actorUserId: null },
        ],
        nextCursor: null,
      });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    const t1Row = (await screen.findByText("Sub von tier1")).closest("tr");
    const t2Row = (await screen.findByText("Sub von tier2")).closest("tr");
    const t3Row = (await screen.findByText("Sub von tier3")).closest("tr");
    const primeRow = (await screen.findByText("Sub von primeperson")).closest("tr");
    const unbekanntRow = (await screen.findByText("Sub von rätselperson")).closest("tr");
    if (t1Row === null || t2Row === null || t3Row === null || primeRow === null || unbekanntRow === null) {
      throw new Error("Ereigniszeile fehlt");
    }

    expect([...t1Row.querySelectorAll(".event-chip")].map((chip) => chip.textContent)).toEqual(["T1", "Abo"]);
    expect([...t2Row.querySelectorAll(".event-chip")].map((chip) => chip.textContent)).toEqual(["T2", "Abo"]);
    expect([...t3Row.querySelectorAll(".event-chip")].map((chip) => chip.textContent)).toEqual(["T3", "Abo"]);
    expect([...primeRow.querySelectorAll(".event-chip")].map((chip) => chip.textContent)).toEqual(["Prime", "Abo"]);
    expect([...unbekanntRow.querySelectorAll(".event-chip")].map((chip) => chip.textContent)).toEqual(["Abo"]);
  });

  it("reaches events via navigation and loads the next page on scroll", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const firstPage = {
      entries: [{
        eventId: "event-neu",
        createdAt: "2026-09-18T04:00:00.000Z",
        moduleId: "raid",
        code: "neu",
        detail: "{}",
        actorUserId: null,
      }],
      nextCursor: "cursor-1",
    };
    const secondPage = {
      entries: [{
        eventId: "event-alt",
        createdAt: "2026-09-18T03:00:00.000Z",
        moduleId: "raid",
        code: "alt",
        detail: "{}",
        actorUserId: "user-1",
        actorLogin: "alice",
        actorDisplayName: "Alice",
      }],
      nextCursor: null,
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (url.pathname === "/api/channels/kanal-a/overview") return jsonResponse(overview(channel));
      if (url.pathname === "/api/channels/kanal-a/events") {
        return jsonResponse(url.searchParams.has("cursor") ? secondPage : firstPage);
      }
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    const eventsLink = await screen.findByRole("link", { name: "Ereignisse" });
    fireEvent.click(eventsLink);
    expect(await screen.findByRole("heading", { name: "Ereignisse", level: 1 })).toBeInTheDocument();
    expect(await screen.findByText("neu")).toBeInTheDocument();

    Object.defineProperty(window, "innerHeight", { configurable: true, value: 100 });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 900 });
    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 1000 });
    fireEvent.scroll(window);
    expect(await screen.findByText("alt")).toBeInTheDocument();
    expect(screen.getAllByText("Alice").length).toBeGreaterThan(0);
    expect(screen.getByText(/aktualisiert vor/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ältere Ereignisse laden" })).not.toBeInTheDocument();
  });

  it("loads new events at the top and merges them in", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const alt = { eventId: "event-alt", createdAt: "2026-09-18T03:00:00.000Z", moduleId: "raid", code: "alt", detail: "{}", actorUserId: null, actorLogin: null, actorDisplayName: null };
    const neu = { eventId: "event-neu", createdAt: "2026-09-18T04:00:00.000Z", moduleId: "channel_events", code: "channel_events.raid.incoming", detail: '{"viewers":7}', actorUserId: null, actorLogin: null, actorDisplayName: null };
    let firstPage = 0;
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (url.pathname === "/api/channels/kanal-a/modules") return jsonResponse({ modules: [] });
      if (url.pathname === "/api/channels/kanal-a/events") {
        firstPage += 1;
        return jsonResponse({ entries: firstPage === 1 ? [alt] : [neu, alt], nextCursor: null });
      }
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    expect(await screen.findByText("alt")).toBeInTheDocument();
    const socket = TestWebSocket.instances[0];
    if (socket === undefined) throw new Error("Realtime-Socket fehlt");
    socket.open();
    socket.receive(JSON.stringify({ version: 1, id: "message-1", createdAt: "2026-09-18T04:00:01.000Z", channelId: "kanal-a", type: "event_log.new", payload: { entries: [{ eventId: neu.eventId, createdAt: neu.createdAt, moduleId: neu.moduleId, code: neu.code, actorUserId: null }] } }));

    expect(await screen.findByText("Raid von unbekannt mit 7 Zuschauern")).toBeInTheDocument();
    expect(firstPage).toBe(2);
  });

  it("keeps the list further down and shows only the notice", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const alt = { eventId: "event-alt", createdAt: "2026-09-18T03:00:00.000Z", moduleId: "raid", code: "alt", detail: "{}", actorUserId: null, actorLogin: null, actorDisplayName: null };
    const neu = { eventId: "event-neu", createdAt: "2026-09-18T04:00:00.000Z", moduleId: "channel_events", code: "channel_events.raid.incoming", detail: '{"viewers":8}', actorUserId: null, actorLogin: null, actorDisplayName: null };
    let eventRequests = 0;
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (url.pathname === "/api/channels/kanal-a/modules") return jsonResponse({ modules: [] });
      if (url.pathname === "/api/channels/kanal-a/events") {
        eventRequests += 1;
        return jsonResponse({ entries: [alt], nextCursor: null });
      }
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    expect(await screen.findByText("alt")).toBeInTheDocument();
    const feed = document.querySelector(".event-feed");
    if (feed === null) throw new Error("Ereignis-Feed fehlt");
    Object.defineProperty(feed, "getBoundingClientRect", { configurable: true, value: () => ({ top: -200 }) });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 400 });
    const socket = TestWebSocket.instances[0];
    if (socket === undefined) throw new Error("Realtime-Socket fehlt");
    socket.open();
    socket.receive(JSON.stringify({ version: 1, id: "message-lower", createdAt: "2026-09-18T04:00:01.000Z", channelId: "kanal-a", type: "event_log.new", payload: { entries: [{ eventId: neu.eventId, createdAt: neu.createdAt, moduleId: neu.moduleId, code: neu.code, actorUserId: null }] } }));

    expect(await screen.findByRole("button", { name: "1 neue Ereignisse" })).toBeInTheDocument();
    expect(screen.queryByText("Raid von unbekannt mit 8 Zuschauern")).not.toBeInTheDocument();
    expect(eventRequests).toBe(1);
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });

  it("jumps to the top via the notice and then loads more", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const alt = { eventId: "event-alt", createdAt: "2026-09-18T03:00:00.000Z", moduleId: "raid", code: "alt", detail: "{}", actorUserId: null, actorLogin: null, actorDisplayName: null };
    const neu = { eventId: "event-neu", createdAt: "2026-09-18T04:00:00.000Z", moduleId: "channel_events", code: "channel_events.raid.incoming", detail: '{"viewers":9}', actorUserId: null, actorLogin: null, actorDisplayName: null };
    let eventRequests = 0;
    const scrollTo = vi.fn();
    Object.defineProperty(window, "scrollTo", { configurable: true, value: scrollTo });
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (url.pathname === "/api/channels/kanal-a/modules") return jsonResponse({ modules: [] });
      if (url.pathname === "/api/channels/kanal-a/events") {
        eventRequests += 1;
        return jsonResponse({ entries: eventRequests === 1 ? [alt] : [neu, alt], nextCursor: null });
      }
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    expect(await screen.findByText("alt")).toBeInTheDocument();
    const feed = document.querySelector(".event-feed");
    if (feed === null) throw new Error("Ereignis-Feed fehlt");
    Object.defineProperty(feed, "getBoundingClientRect", { configurable: true, value: () => ({ top: -200 }) });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 400 });
    const socket = TestWebSocket.instances[0];
    if (socket === undefined) throw new Error("Realtime-Socket fehlt");
    socket.open();
    socket.receive(JSON.stringify({ version: 1, id: "message-jump", createdAt: "2026-09-18T04:00:01.000Z", channelId: "kanal-a", type: "event_log.new", payload: { entries: [{ eventId: neu.eventId, createdAt: neu.createdAt, moduleId: neu.moduleId, code: neu.code, actorUserId: null }] } }));

    const newEventsNotice = await screen.findByRole("button", { name: "1 neue Ereignisse" });
    expect(newEventsNotice).toHaveAccessibleName("1 neue Ereignisse");
    expect(newEventsNotice.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    fireEvent.click(newEventsNotice);
    expect(await screen.findByText("Raid von unbekannt mit 9 Zuschauern")).toBeInTheDocument();
    expect(eventRequests).toBe(2);
    expect(scrollTo).toHaveBeenCalledOnce();
  });

  it("processes a duplicate message only once", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const alt = { eventId: "event-alt", createdAt: "2026-09-18T03:00:00.000Z", moduleId: "raid", code: "alt", detail: "{}", actorUserId: null, actorLogin: null, actorDisplayName: null };
    const neu = { eventId: "event-neu", createdAt: "2026-09-18T04:00:00.000Z", moduleId: "channel_events", code: "channel_events.raid.incoming", detail: '{"viewers":10}', actorUserId: null, actorLogin: null, actorDisplayName: null };
    let eventRequests = 0;
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (url.pathname === "/api/channels/kanal-a/modules") return jsonResponse({ modules: [] });
      if (url.pathname === "/api/channels/kanal-a/events") {
        eventRequests += 1;
        return jsonResponse({ entries: eventRequests === 1 ? [alt] : [neu, alt], nextCursor: null });
      }
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    expect(await screen.findByText("alt")).toBeInTheDocument();
    const socket = TestWebSocket.instances[0];
    if (socket === undefined) throw new Error("Realtime-Socket fehlt");
    socket.open();
    const message = JSON.stringify({ version: 1, id: "message-dupe", createdAt: "2026-09-18T04:00:01.000Z", channelId: "kanal-a", type: "event_log.new", payload: { entries: [{ eventId: neu.eventId, createdAt: neu.createdAt, moduleId: neu.moduleId, code: neu.code, actorUserId: null }] } });
    socket.receive(message);
    socket.receive(message);

    expect(await screen.findByText("Raid von unbekannt mit 10 Zuschauern")).toBeInTheDocument();
    expect(eventRequests).toBe(2);
  });

  it("ignores unknown message types", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    let eventRequests = 0;
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (url.pathname === "/api/channels/kanal-a/modules") return jsonResponse({ modules: [] });
      if (url.pathname === "/api/channels/kanal-a/events") {
        eventRequests += 1;
        return jsonResponse({ entries: [], nextCursor: null });
      }
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    expect(await screen.findByText("Noch keine Ereignisse protokolliert.")).toBeInTheDocument();
    const socket = TestWebSocket.instances[0];
    if (socket === undefined) throw new Error("Realtime-Socket fehlt");
    socket.open();
    socket.receive(JSON.stringify({ version: 1, id: "message-unbekannt", createdAt: "2026-09-18T04:00:01.000Z", channelId: "kanal-a", type: "neues.modul", payload: { entries: [{ eventId: "ignored", createdAt: "2026-09-18T04:00:01.000Z", moduleId: "raid", code: "neu", actorUserId: null }] } }));

    expect(eventRequests).toBe(1);
    expect(screen.queryByRole("button", { name: /neue Ereignisse/ })).not.toBeInTheDocument();
  });

  it("closes the connection on a message from a foreign channel", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (url.pathname === "/api/channels/kanal-a/modules") return jsonResponse({ modules: [] });
      if (url.pathname === "/api/channels/kanal-a/events") return jsonResponse({ entries: [], nextCursor: null });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    expect(await screen.findByText("Noch keine Ereignisse protokolliert.")).toBeInTheDocument();
    const socket = TestWebSocket.instances[0];
    if (socket === undefined) throw new Error("Realtime-Socket fehlt");
    socket.open();
    socket.receive(JSON.stringify({ version: 1, id: "message-fremd", createdAt: "2026-09-18T04:00:01.000Z", channelId: "kanal-b", type: "event_log.new", payload: { entries: [] } }));

    expect(socket.readyState).toBe(3);
    expect(await screen.findByText("Offline")).toBeInTheDocument();
  });

  it("reloads page 1 after a reconnect", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const alt = { eventId: "event-alt", createdAt: "2026-09-18T03:00:00.000Z", moduleId: "raid", code: "alt", detail: "{}", actorUserId: null, actorLogin: null, actorDisplayName: null };
    const neu = { eventId: "event-neu", createdAt: "2026-09-18T04:00:00.000Z", moduleId: "channel_events", code: "channel_events.raid.incoming", detail: '{"viewers":11}', actorUserId: null, actorLogin: null, actorDisplayName: null };
    let eventRequests = 0;
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/channels/kanal-a/modules") return Promise.resolve(jsonResponse({ modules: [] }));
      if (url.pathname === "/api/channels/kanal-a/events") {
        eventRequests += 1;
        return Promise.resolve(jsonResponse({ entries: eventRequests === 1 ? [alt] : [neu, alt], nextCursor: null }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    expect(await screen.findByText("alt")).toBeInTheDocument();
    const socket = TestWebSocket.instances[0];
    if (socket === undefined) throw new Error("Realtime-Socket fehlt");
    socket.open();
    socket.close(1006, "Abbruch");
    await act(async () => { await new Promise<void>((resolve) => { setTimeout(resolve, 300); }); });
    const rebuiltSocket = TestWebSocket.instances[1];
    if (rebuiltSocket === undefined) throw new Error("Reconnect-Socket fehlt");
    rebuiltSocket.open();

    expect(await screen.findByText("Raid von unbekannt mit 11 Zuschauern")).toBeInTheDocument();
    expect(eventRequests).toBe(2);
  });

  it("loads only once when the feed end is reached and shows the end explicitly", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    let releaseSecondPage: ((response: Response) => void) | undefined;
    const firstPage = {
      entries: [{ eventId: "event-neu", createdAt: "2026-09-18T04:00:00.000Z", moduleId: "raid", code: "neu", detail: "{}", actorUserId: null }],
      nextCursor: "cursor-1",
    };
    const secondPage = {
      entries: [{ eventId: "event-alt", createdAt: "2026-09-18T03:00:00.000Z", moduleId: "raid", code: "alt", detail: "{}", actorUserId: null }],
      nextCursor: null,
    };
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/channels/kanal-a/modules") return Promise.resolve(jsonResponse({ modules: [] }));
      if (url.pathname === "/api/channels/kanal-a/events") {
        return url.searchParams.has("cursor")
          ? new Promise<Response>((resolve) => { releaseSecondPage = resolve; })
          : Promise.resolve(jsonResponse(firstPage));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    expect(await screen.findByText("neu")).toBeInTheDocument();
    const feedEnd = screen.getByLabelText("Am Ende werden ältere Ereignisse nachgeladen.");
    fireEvent.focus(feedEnd);
    fireEvent.keyDown(feedEnd, { key: "Enter" });
    const eventRequests = fetcher.mock.calls.filter(([input]) => requestUrl(input).pathname.endsWith("/events"));
    expect(eventRequests).toHaveLength(2);
    expect(await screen.findByText("Ältere Ereignisse werden geladen …")).toBeInTheDocument();

    releaseSecondPage?.(jsonResponse(secondPage));
    expect(await screen.findByText("alt")).toBeInTheDocument();
    expect(screen.getByText("Ende des Ereignisverlaufs erreicht.")).toBeInTheDocument();
  });

  it("groups the same trigger, shows the strongest tone and the chronological history", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/events")) return jsonResponse({
        entries: [{
          eventId: "event-command",
          createdAt: "2026-09-18T04:00:00.000Z",
          moduleId: "text_commands",
          triggerId: "trigger-1",
          code: "text_commands.triggered",
          detail: '{"name":"wiki","response":"Antwort"}',
          actorUserId: "user-1",
          actorLogin: "alice",
          actorDisplayName: "Alice",
        }, {
          eventId: "event-sent",
          createdAt: "2026-09-18T04:01:00.000Z",
          moduleId: "text_commands",
          triggerId: "trigger-1",
          code: "host.chat.sent",
          detail: '{"text":"Antwort"}',
          actorUserId: "user-1",
          actorLogin: "alice",
          actorDisplayName: "Alice",
        }, {
          eventId: "event-command-red",
          createdAt: "2026-09-18T04:02:00.000Z",
          moduleId: "text_commands",
          triggerId: "trigger-2",
          code: "text_commands.triggered",
          detail: '{"name":"fehlversuch","response":"Antwort"}',
          actorUserId: "user-1",
          actorLogin: "alice",
          actorDisplayName: "Alice",
        }, {
          eventId: "event-red",
          createdAt: "2026-09-18T04:03:00.000Z",
          moduleId: "text_commands",
          triggerId: "trigger-2",
          code: "host.chat.failed",
          detail: '{"text":"Antwort","grund":"rate_limited"}',
          actorUserId: "user-1",
          actorLogin: "alice",
          actorDisplayName: "Alice",
        }, {
          eventId: "event-other",
          createdAt: "2026-09-18T04:04:00.000Z",
          moduleId: "raid",
          triggerId: "trigger-3",
          code: "shoutout.suppressed",
          detail: '{"grund":"raid_erkannt"}',
          actorUserId: null,
          actorLogin: null,
          actorDisplayName: null,
        }],
        nextCursor: null,
      });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    expect(await screen.findByText("Befehl !wiki ausgeführt")).toBeInTheDocument();
    expect(await screen.findByText("Chat-Nachricht fehlgeschlagen")).toBeInTheDocument();
    expect(screen.getByText("Shoutout unterdrückt")).toBeInTheDocument();
    expect(screen.queryByText("Chat-Nachricht gesendet")).not.toBeInTheDocument();
    expect(screen.getAllByRole("row")).toHaveLength(4);

    const groupRow = screen.getByText("Befehl !wiki ausgeführt").closest("tr");
    expect(groupRow).not.toBeNull();
    expect(groupRow).toHaveAttribute("aria-selected", "false");
    fireEvent.keyDown(groupRow as HTMLElement, { key: "Enter" });

    expect(groupRow).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("host.chat.sent")).toBeInTheDocument();
    const history = screen.getByText("host.chat.sent").closest("li")?.parentElement;
    if (history == null) throw new Error("Verlauf fehlt");
    const historyText = history.textContent;
    expect(historyText.indexOf("text_commands.triggered")).toBeLessThan(historyText.indexOf("host.chat.sent"));

    const failedGroupRow = screen.getByText("Chat-Nachricht fehlgeschlagen").closest("tr");
    expect(failedGroupRow).not.toBeNull();
    fireEvent.click(failedGroupRow as HTMLElement);
    expect(failedGroupRow).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("host.chat.failed")).toBeInTheDocument();
    expect(screen.getByText(/"grund": "rate_limited"/)).toBeInTheDocument();
  });

  it("shows the events empty state as a single sentence", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/events")) return jsonResponse({ entries: [], nextCursor: null });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    expect(await screen.findByText("Noch keine Ereignisse protokolliert.")).toBeInTheDocument();
  });

  it("shows a connection-lost state with a retry action when the first page fails to load", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    let eventAttempts = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/events")) {
        eventAttempts += 1;
        return eventAttempts === 1 ? jsonResponse({}, 500) : jsonResponse({ entries: [], nextCursor: null });
      }
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    expect(await screen.findByText("Verbindung unterbrochen. Die Ereignisse konnten nicht geladen werden.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Erneut versuchen" }));
    expect(await screen.findByText("Noch keine Ereignisse protokolliert.")).toBeInTheDocument();
    expect(eventAttempts).toBe(2);
  });

  it("shows participant roles, a copyable id, and puts the raw detail behind a technical-details disclosure", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(navigator, "clipboard", { value: clipboard, configurable: true });
    const entry = {
      eventId: "event-1",
      createdAt: "2026-09-18T04:00:00.000Z",
      moduleId: "channel_events",
      triggerId: "trigger-1",
      code: "channel_events.moderation.ban",
      detail: '{"person":"troll","moderator":"alice","reason":"spam"}',
      actorUserId: "user-1",
      actorLogin: "alice",
      actorDisplayName: "Alice",
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/events")) return jsonResponse({ entries: [entry], nextCursor: null });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    const row = (await screen.findByText(/gebannt von alice/)).closest("tr");
    if (row === null) throw new Error("Ereignis-Zeile fehlt");
    fireEvent.click(row);

    const inspector = await screen.findByRole("region", { name: "Detail" });
    const inspectorHeading = within(inspector).getByRole("heading", { name: "Vorgang" });
    expect(inspectorHeading).toHaveAttribute("title", "trigger-1");
    expect(inspectorHeading).not.toHaveTextContent("trigger-1");
    // Event text and chip come before the internal code, both inside and outside the inspector.
    const historyHeading = within(inspector).getByText(/gebannt von alice/).closest(".event-history__heading");
    if (historyHeading === null) throw new Error("Verlaufskopf fehlt");
    const headingText = historyHeading.textContent;
    expect(headingText.indexOf("gebannt")).toBeLessThan(headingText.indexOf("channel_events.moderation.ban"));

    expect(within(inspector).getByText("Auslöser")).toBeInTheDocument();
    expect(within(inspector).getByText("Alice")).toBeInTheDocument();
    expect(within(inspector).getByText("Moderator")).toBeInTheDocument();
    expect(within(inspector).getByText("Betroffene Person")).toBeInTheDocument();
    expect(within(inspector).getByText("troll")).toBeInTheDocument();

    // The raw detail JSON sits behind a disclosure, not open by default.
    const disclosure = inspector.querySelector("details");
    if (disclosure === null) throw new Error("Technische Details fehlen");
    expect(disclosure.open).toBe(false);
    expect(within(inspector).getByText("Technische Details")).toBeInTheDocument();
    expect(inspector.querySelector(".inspector-section__heading button[aria-label='ID kopieren']")).toBeNull();
    expect(disclosure.contains(within(inspector).getByRole("button", { name: "ID kopieren" }))).toBe(true);

    fireEvent.click(within(inspector).getByText("Technische Details"));
    fireEvent.click(within(inspector).getByRole("button", { name: "ID kopieren" }));
    expect(clipboard.writeText).toHaveBeenCalledWith("trigger-1");
    expect(await within(inspector).findByRole("button", { name: "Kopiert" })).toBeInTheDocument();
  });

  it("shows active filters, combines them, and reports a no-results empty state", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const channelEntry = { eventId: "channel", createdAt: "2026-09-18T04:00:00.000Z", moduleId: "channel_events", code: "channel_events.raid.incoming", detail: '{"viewers":21}', actorUserId: null, actorLogin: null, actorDisplayName: null };
    const moduleEntry = { eventId: "module", createdAt: "2026-09-18T04:01:00.000Z", moduleId: "text_commands", code: "text_commands.triggered", detail: '{"name":"hilfe"}', actorUserId: "person-a", actorLogin: "alice", actorDisplayName: "Alice" };
    const errorEntry = { eventId: "error", createdAt: "2026-09-18T04:02:00.000Z", moduleId: "text_commands", code: "host.chat.failed", detail: "{}", actorUserId: "person-a", actorLogin: "alice", actorDisplayName: "Alice" };
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/channels/kanal-a/modules") return Promise.resolve(jsonResponse({ modules: [
        { id: "channel_events", enabled: true, settings: "{}" },
        { id: "text_commands", enabled: true, settings: "{}" },
        { id: "ads", enabled: true, settings: "{}" },
      ] }));
      if (url.pathname === "/api/channels/kanal-a/events") {
        const origin = url.searchParams.get("origin");
        const module = url.searchParams.get("module");
        const tone = url.searchParams.get("tone");
        const actor = url.searchParams.get("actor");
        if (module === "ads" && actor === "person-a") return Promise.resolve(jsonResponse({ entries: [], nextCursor: null }));
        if (origin === "channel") return Promise.resolve(jsonResponse({ entries: [channelEntry], nextCursor: null }));
        if (module === "text_commands" && tone === "error") return Promise.resolve(jsonResponse({ entries: [errorEntry], nextCursor: null }));
        if (module === "text_commands") return Promise.resolve(jsonResponse({ entries: [errorEntry, moduleEntry], nextCursor: null }));
        if (tone === "error") return Promise.resolve(jsonResponse({ entries: [errorEntry], nextCursor: null }));
        if (actor === "person-a") return Promise.resolve(jsonResponse({ entries: [errorEntry, moduleEntry], nextCursor: null }));
        return Promise.resolve(jsonResponse({ entries: [channelEntry, errorEntry, moduleEntry], nextCursor: null }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    expect(await screen.findByText("Raid von unbekannt mit 21 Zuschauern")).toBeInTheDocument();
    const herkunftGroup = screen.getByRole("group", { name: "Herkunft" });
    const tonGroup = screen.getByRole("group", { name: "Ton" });
    const module = screen.getByRole("combobox", { name: "Modul" });
    const person = screen.getByRole("textbox", { name: "Person" });
    expect(herkunftGroup).toBeInTheDocument();
    expect(module).toBeInTheDocument();
    expect(tonGroup).toBeInTheDocument();
    expect(person).toBeInTheDocument();

    fireEvent.click(within(herkunftGroup).getByRole("radio", { name: "Kanalereignisse" }));
    expect(await screen.findByText("Raid von unbekannt mit 21 Zuschauern")).toBeInTheDocument();
    expect(screen.queryByText("Befehl !hilfe ausgeführt")).not.toBeInTheDocument();
    expect(screen.getByText(/Aktive Filter:/)).toHaveTextContent("Kanalereignisse");

    fireEvent.click(screen.getAllByRole("button", { name: "Filter zurücksetzen" })[0] as HTMLElement);
    // The sidebar's module list refetches on every navigate() -- including
    // the reset above -- so its options can briefly be empty; wait for them
    // rather than opening the dropdown mid-fetch.
    await waitFor(() => { expect(screen.getByRole("option", { name: "Textbefehle", hidden: true })).toBeInTheDocument(); });
    fireEvent.click(module);
    fireEvent.click(screen.getByRole("option", { name: "Textbefehle", hidden: true }));
    fireEvent.click(within(tonGroup).getByRole("radio", { name: "Fehler" }));
    expect(await screen.findByText("Chat-Nachricht fehlgeschlagen")).toBeInTheDocument();
    expect(screen.queryByText("Raid von unbekannt mit 21 Zuschauern")).not.toBeInTheDocument();
    fireEvent.change(person, { target: { value: "person-a" } });
    expect((await screen.findAllByText("Alice")).length).toBeGreaterThan(0);

    fireEvent.click(module);
    fireEvent.click(screen.getByRole("option", { name: "Werbung", hidden: true }));
    expect(await screen.findByText("Keine Ereignisse passen zu den Filtern.")).toBeInTheDocument();
    await waitFor(() => { expect(screen.getByRole("option", { name: "Alle Module", hidden: true })).toBeInTheDocument(); });
    fireEvent.click(module);
    fireEvent.click(screen.getByRole("option", { name: "Alle Module", hidden: true }));
    await waitFor(() => {
      const filters = new URLSearchParams(window.location.search);
      expect(filters.has("module")).toBe(false);
      expect(filters.get("tone")).toBe("error");
      expect(filters.get("actor")).toBe("person-a");
    });
    expect(await screen.findByText("Chat-Nachricht fehlgeschlagen")).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Filter zurücksetzen" })[0] as HTMLElement);
    expect(await screen.findByText("Raid von unbekannt mit 21 Zuschauern")).toBeInTheDocument();
    expect(screen.queryByText("Keine Ereignisse passen zu den Filtern.")).not.toBeInTheDocument();
  });

  it("debounces five inputs in the person filter into exactly one more events request", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const eventRequests: URL[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/channels/kanal-a/events") {
        eventRequests.push(url);
        return Promise.resolve(jsonResponse({ entries: [], nextCursor: null }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    const person = await screen.findByRole("textbox", { name: "Person" });
    expect(person).toHaveAccessibleName("Person");
    expect(person.closest(".mantine-Input-wrapper")?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    const initialRequests = eventRequests.length;
    for (const value of ["a", "al", "ali", "alic", "alice"]) {
      fireEvent.change(person, { target: { value } });
    }
    expect(eventRequests).toHaveLength(initialRequests);

    // No `setTimeout` with a real wait: the test was then dependent on the
    // machine's speed and failed once in three runs for no reason.
    // `waitFor` polls until its own deadline and is therefore reliable, no
    // matter how fast or slow the debounce actually runs.
    await waitFor(
      () => { expect(eventRequests).toHaveLength(initialRequests + 1); },
      { timeout: 2000 },
    );
    expect(eventRequests.at(-1)?.searchParams.get("actor")).toBe("alice");
  });

  it("does not present the last broadcaster as revocable", async () => {
    // The worker would reject both. A button that's guaranteed to fail looks
    // like an option — you have to press it to find out it isn't one.
    // Disabled with a reason instead of hidden: a vanished button raises the
    // question of whether something is broken.
    await showMembers({
      members: [broadcaster("100", "esembe", "esembe")],
      broadcasterCount: 1,
      viewerUserId: "100",
    });
    fireEvent.click(await screen.findByRole("row", { name: /esembe/ }));

    expect(await screen.findByRole("button", { name: "Zugriff für esembe entziehen" })).toBeDisabled();
    expect(screen.getAllByText("Letzter Broadcaster")).toHaveLength(1);
    expect(document.querySelector(".member-avatar-placeholder")).toHaveTextContent("E");

    // The select field offers no value that would be rejected.
    const rolle = screen.getByRole("combobox", { name: "Rolle für esembe" });
    expect(rolle).toBeDisabled();
    expect(rolle).toHaveAccessibleDescription("Letzter Broadcaster");
    expect(screen.getAllByRole("option", { hidden: true }).map((o) => o.textContent)).toContain("Broadcaster");
  });

  it("allows revocation once a second broadcaster remains", async () => {
    // Control check: the lock must not also lock the permitted case.
    await showMembers({
      members: [broadcaster("100", "esembe", "esembe"), broadcaster("200", "zweit", "Zweit")],
      broadcasterCount: 2,
      viewerUserId: "100",
    });
    fireEvent.click(await screen.findByRole("row", { name: /esembe/ }));

    expect(await screen.findByRole("button", { name: "Zugriff für esembe entziehen" })).toBeEnabled();
    expect(screen.queryByText("Letzter Broadcaster")).not.toBeInTheDocument();
  });

  it("explicitly warns about lockout when revoking one's own access", async () => {
    const frage = vi.fn((message: string) => { void message; return false; });
    await showMembers({
      members: [broadcaster("100", "esembe", "esembe"), broadcaster("200", "zweit", "Zweit")],
      broadcasterCount: 2,
      viewerUserId: "100",
    });
    vi.stubGlobal("confirm", frage);
    fireEvent.click(await screen.findByRole("row", { name: /esembe/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Zugriff für esembe entziehen" }));

    expect(frage).toHaveBeenCalledOnce();
    expect(frage.mock.calls.at(0)?.[0] ?? "").toContain("selbst aus");

    // Someone else's entry: same action, different question.
    fireEvent.click(screen.getByRole("row", { name: /Zweit/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Zugriff für Zweit entziehen" }));
    expect(frage.mock.calls.at(1)?.[0] ?? "").not.toContain("selbst aus");
  });

  it("shows memberships and the management action only for managing roles", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const members = {
      members: [
        { userId: "100", login: "streamer", displayName: "Streamerin", profileImageUrl: "https://cdn.example/streamerin.png", role: "broadcaster", joinedAt: "2026-09-17T12:00:00.000Z" },
        { userId: "200", login: null, displayName: null, profileImageUrl: null, role: "operator", joinedAt: "2026-09-18T12:00:00.000Z" },
      ],
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/members")) return jsonResponse(members);
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/members");

    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Mitglieder", level: 1 })).toBeInTheDocument();
    expect(await screen.findByText("Streamerin")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "twitch.tv/streamer" }))
      .toHaveAttribute("href", "https://twitch.tv/streamer");
    const avatarImage = document.querySelector("img.member-avatar");
    expect(avatarImage).toHaveAttribute("src", "https://cdn.example/streamerin.png");
    expect(document.querySelector(".member-avatar-placeholder")).toBeInTheDocument();

    // An image that fails to load must not make the row unusable: the
    // placeholder takes its place, the profile link stays unchanged.
    fireEvent.error(avatarImage as Element);
    expect(document.querySelector("img.member-avatar")).not.toBeInTheDocument();
    expect(document.querySelectorAll(".member-avatar-placeholder")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "twitch.tv/streamer" }))
      .toHaveAttribute("href", "https://twitch.tv/streamer");

    expect(screen.queryByText("100")).not.toBeInTheDocument();
    expect(screen.getByText("Nicht auflösbar")).toBeInTheDocument();
    expect(screen.getByText("Twitch-ID 200")).toBeInTheDocument();
    expect(screen.getByText(/17\.09\.2026|Sep 17, 2026/), "Beitrittszeitpunkt wird angezeigt").toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Suchen" })).toBeInTheDocument();

    const operatorChannel = { ...channel, role: "operator" };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [operatorChannel], bot: operatorChannel.bot });
      if (path.endsWith("/members")) return jsonResponse(members);
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/members");
    cleanup();
    render(<DashboardApp />);

    await screen.findByRole("heading", { name: "Mitglieder", level: 1 });
    expect(screen.getByRole("button", { name: "Zugriff freigeben" })).toBeDisabled();
  });

  it("keeps the members table's semantics for narrow cards", async () => {
    await showMembers({
      members: [{ userId: "100", login: "streamer", displayName: "Streamerin", profileImageUrl: null, role: "manager", joinedAt: "2026-09-17T12:00:00.000Z" }],
      broadcasterCount: 1,
      viewerUserId: "100",
    });

    const table = await screen.findByRole("table");
    expect(table.querySelector("thead")).toHaveClass("sr-only");
    expect(screen.getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Rolle" })).toBeInTheDocument();

    const row = table.querySelector("tbody tr");
    expect(row).toHaveAttribute("role", "row");
    expect(row?.querySelector("th[scope='row']")).toHaveAttribute("role", "rowheader");
    expect(row?.querySelectorAll("td")).toHaveLength(2);
    expect(Array.from(row?.querySelectorAll("td") ?? []).every((cell) => cell.getAttribute("role") === "cell")).toBe(true);
  });

  it("shows the operator member actions disabled with a reason", async () => {
    const channel = { ...healthyChannel("kanal-a", "Alpha"), role: "operator" };
    const members = {
      members: [{ userId: "200", login: "moderation", displayName: "Moderation", role: "operator", joinedAt: "2026-09-18T12:00:00.000Z" }],
      broadcasterCount: 1,
      viewerUserId: "200",
      nextCursor: null,
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/members")) return jsonResponse(members);
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/members");

    render(<DashboardApp />);

    await screen.findByRole("heading", { name: "Mitglieder", level: 1 });
    const memberSearch = screen.getByRole("textbox", { name: "Twitch-Name" });
    expect(memberSearch).toHaveAccessibleName("Twitch-Name");
    expect(memberSearch.closest(".mantine-Input-wrapper")?.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    const reason = "Nur Broadcaster und Verwalter dürfen Mitglieder ändern.";
    const search = screen.getByRole("button", { name: "Suchen" });
    expect(search).toBeDisabled();
    expect(search).toHaveAttribute("title", reason);
    const freigeben = screen.getByRole("button", { name: "Zugriff freigeben" });
    expect(freigeben).toBeDisabled();
    expect(freigeben).toHaveAttribute("title", reason);
    fireEvent.click(await screen.findByRole("row", { name: /Moderation/ }));
    expect(await screen.findByRole("combobox", { name: "Rolle für Moderation" })).toBeDisabled();
    const entziehen = screen.getByRole("button", { name: "Zugriff für Moderation entziehen" });
    expect(entziehen).toHaveAccessibleName("Zugriff für Moderation entziehen");
    expect(entziehen.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(entziehen).toBeDisabled();
    expect(screen.getAllByText(reason).length).toBeGreaterThan(0);
  });

  it("discards search result and access-grant confirmation on channel switch", async () => {
    const alpha = { ...healthyChannel("kanal-a", "Alpha"), role: "manager" };
    const beta = { ...healthyChannel("kanal-b", "Beta"), role: "operator" };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [alpha, beta], bot: alpha.bot });
      if (path === "/api/channels/kanal-a/members/search") return jsonResponse({ user: {
        userId: "300", login: "neue-person", displayName: "Neue Person", profileImageUrl: null,
      } });
      if (path === "/api/channels/kanal-a/members") return jsonResponse({ members: [], broadcasterCount: 1, viewerUserId: "100", nextCursor: null });
      if (path === "/api/channels/kanal-b/members") return jsonResponse({ members: [], broadcasterCount: 1, viewerUserId: "200", nextCursor: null });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/members");

    render(<DashboardApp />);
    const search = await screen.findByRole("textbox", { name: "Twitch-Name" });
    fireEvent.change(search, { target: { value: "neue-person" } });
    fireEvent.click(screen.getByRole("button", { name: "Suchen" }));
    expect(await screen.findByText("Neue Person")).toBeInTheDocument();
    const grantAccess = screen.getByRole("button", { name: "Zugriff freigeben" });
    expect(grantAccess).toHaveAccessibleName("Zugriff freigeben");
    expect(grantAccess.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    fireEvent.click(grantAccess);
    expect(screen.getByRole("button", { name: "Zugriff endgültig freigeben" })).toBeInTheDocument();

    act(() => {
      window.history.pushState({}, "", "/channels/kanal-b/members");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(screen.queryByText("Neue Person")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Suchen" })).toBeDisabled();
  });

  it("shows the operator module activation disabled with a reason", async () => {
    const channel = { ...healthyChannel("kanal-a", "Alpha"), role: "operator" };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/overview")) return jsonResponse(overview(channel));
      if (path.endsWith("/modules")) return jsonResponse({ modules: [{ id: "text_commands", enabled: false, settings: "{}" }] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/modules/text_commands");

    render(<DashboardApp />);

    await screen.findByRole("heading", { name: "Textbefehle", level: 1 });
    const reason = "Nur Broadcaster und Verwalter dürfen Module ändern.";
    const schalter = await screen.findAllByRole("switch", { name: /Textbefehle/i });
    expect(schalter).toHaveLength(1);
    schalter.forEach((element) => { expect(element).toBeDisabled(); });
    expect(screen.getAllByText(reason)).toHaveLength(1);
  });

  it("shows system state before the audit log arrives", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    let resolveAudit: ((response: Response) => void) | undefined;
    const auditResponse = new Promise<Response>((resolve) => { resolveAudit = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname.endsWith("/system")) return Promise.resolve(jsonResponse(system));
      if (url.pathname.endsWith("/audit-log")) return auditResponse;
      return Promise.resolve(jsonResponse({}, 404));
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/system");

    render(<DashboardApp />);

    expect(await screen.findByRole("article", { name: "Bot-Account" })).toBeInTheDocument();
    expect(screen.getByText("Audit-Log wird geladen …")).toBeInTheDocument();
    resolveAudit?.(jsonResponse(audit));
    await waitFor(() => expect(screen.queryByText("Audit-Log wird geladen …")).not.toBeInTheDocument());
  });

  it("opens the selected audit entry in the sub-inspector", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const auditEntry = {
      auditId: "audit-1",
      actorUserId: "user-1",
      actorLogin: "alice",
      actorDisplayName: "Alice",
      createdAt: "2026-09-18T04:00:00.000Z",
      action: "module.enabled",
      before: "{\"enabled\":false}",
      after: "{\"enabled\":true}",
    };
    const secondAuditEntry = {
      auditId: "audit-2",
      actorUserId: "gelöscht",
      actorLogin: null,
      actorDisplayName: null,
      createdAt: "2026-09-18T03:00:00.000Z",
      action: "module.disabled",
      before: "{\"enabled\":true}",
      after: "{\"enabled\":false}",
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/system")) return jsonResponse(system);
      if (path.endsWith("/audit-log")) return jsonResponse({ entries: [auditEntry, secondAuditEntry], nextCursor: null });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/system");

    render(<DashboardApp />);

    expect(await screen.findByRole("columnheader", { name: "Zeit" })).toBeInTheDocument();
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(await screen.findByText("gelöscht")).toBeInTheDocument();
    const row = screen.getByText("Modul aktiviert").closest("tr");
    expect(row).not.toBeNull();
    expect(row).toHaveAttribute("aria-selected", "false");
    fireEvent.keyDown(row as HTMLElement, { key: "Enter" });
    expect(row).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "Vorher" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Nachher" })).toBeInTheDocument();
    expect(screen.getByText('{"enabled":false}')).toBeInTheDocument();
    const inspector = await screen.findByRole("region", { name: "Änderungsdaten" });
    expect(await within(inspector).findByText("user-1")).toBeInTheDocument();
    const secondRow = screen.getByText("Modul deaktiviert").closest("tr");
    expect(secondRow).not.toBeNull();
    fireEvent.keyDown(secondRow as HTMLElement, { key: " " });
    expect(secondRow).toHaveAttribute("aria-selected", "true");
    expect(row).toHaveAttribute("aria-selected", "false");
  });

  it("shows all subscriptions legibly and opens message and status in the sub-inspector", async () => {
    const channel = { ...healthyChannel("kanal-a", "Alpha"), botPermissions: { missingScopes: [] } };
    const subscriptions = [
      { subscriptionType: "channel.chat.message", variant: "", version: "1", subscriptionId: "chat-1", status: "enabled", reason: null, message: null, statusCode: null, updatedAt: "2026-09-18T04:00:00.000Z" },
      { subscriptionType: "channel.raid", variant: "incoming", version: "1", subscriptionId: "raid-in", status: "missing", reason: "subscription_replaced", message: null, statusCode: null, updatedAt: "2026-09-18T03:00:00.000Z" },
      { subscriptionType: "channel.raid", variant: "outgoing", version: "1", subscriptionId: "raid-out", status: "error", reason: "missing_scope", message: "Scope fehlt", statusCode: 403, updatedAt: "2026-09-18T02:00:00.000Z" },
      { subscriptionType: "channel.future", variant: "", version: "9", subscriptionId: null, status: "pending", reason: "wartet", message: null, statusCode: null, updatedAt: "2026-09-18T01:00:00.000Z" },
    ];
    const systemResponse = { ...system, botPermissions: { missingScopes: [] }, subscriptions };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (path.endsWith("/system")) return Promise.resolve(jsonResponse(systemResponse));
      if (path.endsWith("/audit-log")) return Promise.resolve(jsonResponse(audit));
      return Promise.resolve(jsonResponse({}, 404));
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/system");

    render(<DashboardApp />);

    expect(await screen.findByRole("columnheader", { name: "Abo" })).toBeInTheDocument();
    expect(screen.getByText("Chat-Nachrichten")).toBeInTheDocument();
    expect(screen.getByText("Eingehende Raids")).toBeInTheDocument();
    expect(screen.getByText("Ausgehende Raids")).toBeInTheDocument();
    expect(screen.getByText("Chat-Nachrichten").closest("tr")?.querySelector(".led")).toHaveAttribute("data-status", "green");
    expect(screen.getByText("Eingehende Raids").closest("tr")?.querySelector(".led")).toHaveAttribute("data-status", "amber");
    expect(screen.getByText("Ausgehende Raids").closest("tr")?.querySelector(".led")).toHaveAttribute("data-status", "red");
    const unknown = screen.getByText("channel.future");
    expect(unknown).toHaveClass("mono");
    expect(screen.getByText("Ausstehend")).toBeInTheDocument();
    expect(screen.getByText("missing_scope")).toBeInTheDocument();

    const outgoing = screen.getByText("Ausgehende Raids").closest("tr");
    expect(outgoing).not.toBeNull();
    fireEvent.keyDown(outgoing as HTMLElement, { key: "Enter" });
    expect(outgoing).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("channel.raid")).toBeInTheDocument();
    expect(screen.getByText("Scope fehlt")).toBeInTheDocument();
    expect(screen.getByText("403")).toBeInTheDocument();
  });

  it("shows bot permissions on the channel page, names missing scopes, and offers no authorization", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      botPermissions: { missingScopes: ["user:bot", "user:read:chat"] },
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (path.endsWith("/overview")) return Promise.resolve(jsonResponse({ ...channel, activeModules: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    const permissions = await screen.findByRole("article", { name: "Bot-Berechtigungen" });
    expect(permissions).toHaveAttribute("data-status", "warning");
    expect(within(permissions).getByText("2 fehlen")).toBeInTheDocument();
    expect(screen.getByText("Der Betreiber muss die Anwendung neu autorisieren.")).toBeInTheDocument();
    expect(screen.getByText("user:bot")).toHaveClass("mono");
    expect(screen.getByText("user:read:chat")).toHaveClass("mono");
    // Authorization belongs to the platform account, not to the channel-scoped panel role.
    expect(screen.queryByRole("button", { name: /autoris/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /autoris/i })).not.toBeInTheDocument();
  });

  it("shows a flagged channel with incomplete full consent, including status row, scopes, and consent link", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      role: "broadcaster",
      broadcasterPermissions: { missingScopes: ["channel:manage:broadcast"] },
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    expect(await screen.findByRole("article", { name: "Vollzustimmung fehlt" })).toHaveAttribute("data-status", "warning");
    const inspector = await screen.findByRole("region", { name: "Fehlende Broadcaster-Berechtigungen" });
    expect(within(inspector).getByText("channel:manage:broadcast")).toHaveClass("mono");
    const consentLink = await screen.findByRole("link", { name: "Vollzustimmung erteilen" });
    expect(consentLink).toHaveAttribute("href", "/auth/login?channel=kanal-a");
  });

  it("shows no full-consent state for an unflagged channel", async () => {
    const channel = { ...healthyChannel("kanal-a", "Alpha"), broadcasterPermissions: null };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    await screen.findByRole("heading", { name: "Alpha", level: 1 });
    expect(screen.queryByRole("article", { name: "Vollzustimmung fehlt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Vollzustimmung erteilen" })).not.toBeInTheDocument();
  });

  it("shows no full-consent state for a fully consented channel", async () => {
    const channel = { ...healthyChannel("kanal-a", "Alpha"), broadcasterPermissions: { missingScopes: [] } };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    await screen.findByRole("heading", { name: "Alpha", level: 1 });
    expect(screen.queryByRole("article", { name: "Vollzustimmung fehlt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Vollzustimmung erteilen" })).not.toBeInTheDocument();
  });

  it("shows managers full consent disabled with a reason", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      role: "manager",
      broadcasterPermissions: { missingScopes: ["channel:manage:broadcast"] },
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    await screen.findByRole("article", { name: "Vollzustimmung fehlt" });
    const button = await screen.findByRole("button", { name: "Vollzustimmung erteilen" });
    expect(button).toBeDisabled();
    expect(screen.getAllByText("Nur der Broadcaster kann die Vollzustimmung erteilen.").length).toBeGreaterThan(0);
  });

  it("shows full bot permissions as a healthy state with a word", async () => {
    const channel = { ...healthyChannel("kanal-a", "Alpha"), botPermissions: { missingScopes: [] } };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (path.endsWith("/overview")) return Promise.resolve(jsonResponse({ ...channel, activeModules: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    const permissions = await screen.findByRole("article", { name: "Bot-Berechtigungen" });
    expect(permissions).toHaveAttribute("data-status", "healthy");
    expect(within(permissions).getByText("Gesund")).toBeInTheDocument();
  });

  it("explicitly asks for the actual access scope when adding", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    let addRequestCount = 0;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const path = url.pathname;
      if (path === "/api/channels/kanal-a/members" && init?.method === "POST") {
        addRequestCount += 1;
        return jsonResponse({ member: { userId: "300", login: "neue-person", displayName: "Neue Person", profileImageUrl: "https://cdn.example/neue-person.png", role: "operator", joinedAt: "2026-09-19T00:00:00.000Z" } }, 201);
      }
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path === "/api/channels/kanal-a/members") return jsonResponse({ members: [] });
      if (path === "/api/channels/kanal-a/members/search") return jsonResponse({ user: { userId: "300", login: "neue-person", displayName: "Neue Person", profileImageUrl: "https://cdn.example/neue-person.png" } });
      if (path === "/api/csrf") return jsonResponse({ token: "csrf-token" });
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/members");

    render(<DashboardApp />);
    await screen.findByRole("heading", { name: "Mitglieder", level: 1 });
    fireEvent.change(screen.getByLabelText("Twitch-Name"), { target: { value: "neue-person" } });
    fireEvent.click(screen.getByRole("button", { name: "Suchen" }));
    await screen.findByText("Neue Person");
    fireEvent.click(screen.getByRole("button", { name: "Zugriff freigeben" }));

    const profileLink = screen.getByRole("link", { name: "twitch.tv/neue-person" });
    expect(profileLink).toHaveAttribute("target", "_blank");
    expect(profileLink.getAttribute("rel")?.split(/\s+/)).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));

    const confirmation = screen.getByRole("alertdialog");
    expect(confirmation).toHaveTextContent("Neue Person");
    expect(confirmation).toHaveTextContent("keinerlei Beziehung zum Kanal");
    expect(confirmation).toHaveTextContent("Mitgliederliste");
    expect(confirmation.querySelector("img.member-avatar")).toHaveAttribute("src", "https://cdn.example/neue-person.png");
    expect(addRequestCount).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Zugriff endgültig freigeben" }));
    await waitFor(() => expect(addRequestCount).toBe(1));
  });

  it("cancels the add confirmation without a POST and allows reopening it", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    let addRequestCount = 0;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels/kanal-a/members" && init?.method === "POST") addRequestCount += 1;
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (url.pathname === "/api/channels/kanal-a/members") return jsonResponse({ members: [] });
      if (url.pathname === "/api/channels/kanal-a/members/search") return jsonResponse({ user: { userId: "300", login: "neue-person", displayName: "Neue Person", profileImageUrl: null } });
      if (url.pathname === "/api/csrf") return jsonResponse({ token: "csrf-token" });
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/members");

    render(<DashboardApp />);
    await screen.findByRole("heading", { name: "Mitglieder", level: 1 });
    fireEvent.change(screen.getByLabelText("Twitch-Name"), { target: { value: "neue-person" } });
    fireEvent.click(screen.getByRole("button", { name: "Suchen" }));
    await screen.findByText("Neue Person");
    fireEvent.click(screen.getByRole("button", { name: "Zugriff freigeben" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.querySelector(".member-avatar-placeholder")).toBeInTheDocument();
    // Anyone using only a keyboard or a screen reader must actually notice
    // the form's most important safety prompt.
    expect(screen.getByRole("button", { name: "Zugriff endgültig freigeben" })).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(addRequestCount).toBe(0);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Zugriff freigeben" }));
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));

    expect(addRequestCount).toBe(0);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Zugriff freigeben" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("discards a late member reload after a mutation during a channel switch", async () => {
    const alpha = healthyChannel("kanal-a", "Alpha");
    const beta = healthyChannel("kanal-b", "Beta");
    let resolveAlphaReload: ((response: Response) => void) | undefined;
    const alphaReload = new Promise<Response>((resolve) => {
      resolveAlphaReload = resolve;
    });
    const alphaMember = { userId: "alpha-user", login: "alpha-user", displayName: "Alpha-Mitglied", profileImageUrl: null, role: "operator", joinedAt: "2026-09-18T00:00:00.000Z" };
    const betaMember = { userId: "beta-user", login: "beta-user", displayName: "Beta-Mitglied", profileImageUrl: null, role: "operator", joinedAt: "2026-09-18T00:00:00.000Z" };
    let memberRequestCount = 0;
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [alpha, beta], bot: alpha.bot }));
      if (url.pathname === "/api/channels/kanal-a/members") {
        memberRequestCount += 1;
        if (memberRequestCount === 1) return Promise.resolve(jsonResponse({ members: [alphaMember], nextCursor: null }));
        return alphaReload;
      }
      if (url.pathname === "/api/channels/kanal-b/members") return Promise.resolve(jsonResponse({ members: [betaMember], nextCursor: null }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (url.pathname === "/api/channels/kanal-a/members/alpha-user") return Promise.resolve(jsonResponse({ member: { ...alphaMember, role: "manager" } }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/members");

    render(<DashboardApp />);
    await screen.findByText("Alpha-Mitglied");
    fireEvent.click(screen.getByRole("row", { name: /Alpha-Mitglied/ }));
    const roleSelect = screen.getByRole("combobox", { name: "Rolle für Alpha-Mitglied" });
    fireEvent.click(roleSelect);
    fireEvent.click(screen.getByRole("option", { name: "Verwalter", hidden: true }));
    await waitFor(() => expect(resolveAlphaReload).toBeTypeOf("function"));

    act(() => {
      window.history.pushState({}, "", "/channels/kanal-b/members");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(await screen.findByText("Beta-Mitglied")).toBeInTheDocument();

    await act(async () => {
      resolveAlphaReload?.(jsonResponse({
        members: [{ ...alphaMember, displayName: "Verspätetes Alpha-Mitglied" }],
        nextCursor: null,
      }));
      await Promise.resolve();
    });

    expect(screen.getByText("Beta-Mitglied")).toBeInTheDocument();
    expect(screen.queryByText("Verspätetes Alpha-Mitglied")).not.toBeInTheDocument();
  });

  it("keeps the successful reload state against a late initial response", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const newMember = { userId: "new-user", login: "new-user", displayName: "Neuer Stand", profileImageUrl: null, role: "operator", joinedAt: "2026-09-19T00:00:00.000Z" };
    const delayedMember = { userId: "late-user", login: "late-user", displayName: "Verspäteter Stand", profileImageUrl: null, role: "operator", joinedAt: "2026-09-18T00:00:00.000Z" };
    let resolveLateInitial: ((response: Response) => void) | undefined;
    const lateInitial = new Promise<Response>((resolve) => {
      resolveLateInitial = resolve;
    });
    let memberRequestCount = 0;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (url.pathname === "/api/channels/kanal-a/members/search") return Promise.resolve(jsonResponse({ user: { userId: "new-user", login: "neue-person", displayName: "Neuer Stand", profileImageUrl: null } }));
      if (url.pathname === "/api/channels/kanal-a/members" && init?.method === "POST") return Promise.resolve(jsonResponse({ member: newMember }, 201));
      if (url.pathname === "/api/channels/kanal-a/members") {
        memberRequestCount += 1;
        if (memberRequestCount === 1) return lateInitial;
        return Promise.resolve(jsonResponse({ members: [newMember], broadcasterCount: 1, viewerUserId: "new-user", nextCursor: null }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/members");

    render(<DashboardApp />);
    await screen.findByLabelText("Twitch-Name");

    fireEvent.change(screen.getByLabelText("Twitch-Name"), { target: { value: "neue-person" } });
    fireEvent.click(screen.getByRole("button", { name: "Suchen" }));
    await screen.findByText("Neuer Stand");
    fireEvent.click(screen.getByRole("button", { name: "Zugriff freigeben" }));
    fireEvent.click(screen.getByRole("button", { name: "Zugriff endgültig freigeben" }));
    await waitFor(() => expect(memberRequestCount).toBe(2));
    expect(within(screen.getByRole("table")).getByText("Neuer Stand")).toBeInTheDocument();

    await act(async () => {
      resolveLateInitial?.(jsonResponse({ members: [delayedMember], broadcasterCount: 1, viewerUserId: "late-user", nextCursor: null }));
      await Promise.resolve();
    });

    expect(within(screen.getByRole("table")).getByText("Neuer Stand")).toBeInTheDocument();
    expect(screen.queryByText("Verspäteter Stand")).not.toBeInTheDocument();
  });

  it("locks pagination while a member reload is in progress", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const ersterMember = { userId: "first-user", login: "first-user", displayName: "Erster Stand", profileImageUrl: null, role: "operator", joinedAt: "2026-09-18T00:00:00.000Z" };
    const reloadMember = { userId: "reload-user", login: "reload-user", displayName: "Reload-Stand", profileImageUrl: null, role: "operator", joinedAt: "2026-09-19T00:00:00.000Z" };
    let resolveReload: ((response: Response) => void) | undefined;
    const reload = new Promise<Response>((resolve) => {
      resolveReload = resolve;
    });
    let memberRequestCount = 0;
    let paginationRequestCount = 0;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (url.pathname === "/api/channels/kanal-a/members/first-user" && init?.method === "PATCH") return Promise.resolve(jsonResponse({ member: { ...ersterMember, role: "manager" } }));
      if (url.pathname === "/api/channels/kanal-a/members" && url.search !== "") {
        paginationRequestCount += 1;
        return Promise.resolve(jsonResponse({ members: [], broadcasterCount: 1, viewerUserId: "first-user", nextCursor: null }));
      }
      if (url.pathname === "/api/channels/kanal-a/members") {
        memberRequestCount += 1;
        if (memberRequestCount === 1) return Promise.resolve(jsonResponse({ members: [ersterMember], broadcasterCount: 1, viewerUserId: "someone-else", nextCursor: "cursor-1" }));
        return reload;
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/members");

    render(<DashboardApp />);
    await screen.findByText("Erster Stand");
    fireEvent.click(screen.getByRole("row", { name: /Erster Stand/ }));
    const roleSelect = screen.getByRole("combobox", { name: "Rolle für Erster Stand" });
    fireEvent.click(roleSelect);
    fireEvent.click(screen.getByRole("option", { name: "Verwalter", hidden: true }));
    await waitFor(() => {
      expect(memberRequestCount).toBe(2);
    });

    const more = screen.getByRole("button", { name: "Weitere Mitglieder laden" });
    expect(more).toBeDisabled();
    fireEvent.click(more);
    expect(paginationRequestCount).toBe(0);

    await act(async () => {
      resolveReload?.(jsonResponse({ members: [reloadMember], broadcasterCount: 1, viewerUserId: "reload-user", nextCursor: "cursor-reload" }));
      await Promise.resolve();
    });

    expect(screen.getByText("Reload-Stand")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Weitere Mitglieder laden" })).toBeEnabled();
  });

  it("resets pagination state after a reload during pagination", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const ersterMember = { userId: "first-user", login: "first-user", displayName: "Erster Stand", profileImageUrl: null, role: "operator", joinedAt: "2026-09-18T00:00:00.000Z" };
    const reloadMember = { userId: "reload-user", login: "reload-user", displayName: "Reload-Stand", profileImageUrl: null, role: "operator", joinedAt: "2026-09-19T00:00:00.000Z" };
    const latePageMember = { userId: "late-page-user", login: "late-page-user", displayName: "Verspätete Seite", profileImageUrl: null, role: "operator", joinedAt: "2026-09-17T00:00:00.000Z" };
    let resolveNextPage: ((response: Response) => void) | undefined;
    const nextPage = new Promise<Response>((resolve) => {
      resolveNextPage = resolve;
    });
    let resolveReload: ((response: Response) => void) | undefined;
    const reload = new Promise<Response>((resolve) => {
      resolveReload = resolve;
    });
    let memberRequestCount = 0;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (url.pathname === "/api/channels/kanal-a/members/first-user" && init?.method === "PATCH") return Promise.resolve(jsonResponse({ member: { ...ersterMember, role: "manager" } }));
      if (url.pathname === "/api/channels/kanal-a/members" && url.search === "?cursor=cursor-1") return nextPage;
      if (url.pathname === "/api/channels/kanal-a/members") {
        memberRequestCount += 1;
        if (memberRequestCount === 1) return Promise.resolve(jsonResponse({ members: [ersterMember], broadcasterCount: 1, viewerUserId: "someone-else", nextCursor: "cursor-1" }));
        return reload;
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/members");

    render(<DashboardApp />);
    await screen.findByText("Erster Stand");
    fireEvent.click(screen.getByRole("button", { name: "Weitere Mitglieder laden" }));
    await waitFor(() => {
      expect(fetcher.mock.calls.some(([reqInput]) => requestUrl(reqInput).search === "?cursor=cursor-1")).toBe(true);
    });

    fireEvent.click(screen.getByRole("row", { name: /Erster Stand/ }));
    const roleSelect = screen.getByRole("combobox", { name: "Rolle für Erster Stand" });
    fireEvent.click(roleSelect);
    fireEvent.click(screen.getByRole("option", { name: "Verwalter", hidden: true }));
    await waitFor(() => {
      expect(memberRequestCount).toBe(2);
    });
    expect(screen.getByRole("button", { name: "Weitere Mitglieder laden" })).toBeDisabled();

    await act(async () => {
      resolveReload?.(jsonResponse({ members: [reloadMember], broadcasterCount: 1, viewerUserId: "reload-user", nextCursor: "cursor-reload" }));
      await Promise.resolve();
    });

    expect(screen.getByText("Reload-Stand")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Weitere Mitglieder laden" })).toBeEnabled();

    await act(async () => {
      resolveNextPage?.(jsonResponse({ members: [latePageMember], broadcasterCount: 1, viewerUserId: "first-user", nextCursor: null }));
      await Promise.resolve();
    });
    expect(screen.getByText("Reload-Stand")).toBeInTheDocument();
    expect(screen.queryByText("Verspätete Seite")).not.toBeInTheDocument();
  });

  it("loads the next members page using the supplied cursor", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/channels/kanal-a/members" && url.search === "") {
        return Promise.resolve(jsonResponse({ members: [{ userId: "user-1", login: "erste", displayName: "Erste Person", profileImageUrl: null, role: "operator", joinedAt: "2026-09-18T00:00:00.000Z" }], nextCursor: "cursor-1" }));
      }
      if (url.pathname === "/api/channels/kanal-a/members" && url.search === "?cursor=cursor-1") {
        return Promise.resolve(jsonResponse({ members: [{ userId: "user-2", login: "zweite", displayName: "Zweite Person", profileImageUrl: null, role: "operator", joinedAt: "2026-09-18T00:00:00.000Z" }], nextCursor: null }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/members");

    render(<DashboardApp />);
    await screen.findByText("Erste Person");
    fireEvent.click(screen.getByRole("button", { name: "Weitere Mitglieder laden" }));

    expect(await screen.findByText("Zweite Person")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith(
      new URL("/api/channels/kanal-a/members?cursor=cursor-1", window.location.origin),
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(fetcher.mock.calls.at(-1)?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("lists every registered module as a switchable row on the overview, even with none active", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/overview")) return jsonResponse(overview(channel));
      if (path.endsWith("/system")) return jsonResponse(system);
      if (path.endsWith("/audit-log")) return jsonResponse(audit);
      if (path === "/api/channels/kanal-a/modules") return jsonResponse({ modules: [] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    expect(await screen.findByRole("switch", { name: "Textbefehle" })).not.toBeChecked();
    expect(screen.queryByText("Keine Module aktiv.")).not.toBeInTheDocument();
  });

  it("puts Stream Manager actions and warnings before modules and the compact healthy state", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      chatSubscriptionNeeded: true,
      botPermissions: { missingScopes: [] },
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path === "/api/channels/kanal-a/overview") return jsonResponse(overview(channel));
      if (path === "/api/channels/kanal-a/modules") return jsonResponse({ modules: [] });
      if (path === "/api/channels/kanal-a/events") return jsonResponse({ entries: [], nextCursor: null });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    const actions = await screen.findByRole("region", { name: "Sofortaktionen" });
    const warnings = await screen.findByRole("region", { name: "Warnungen und Fehler" });
    const modules = await screen.findByRole("region", { name: "Module" });
    const state = document.querySelector("details.channel-state-checks");
    expect(state).not.toBeNull();
    expect(actions.compareDocumentPosition(warnings) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(warnings.compareDocumentPosition(modules) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(modules.compareDocumentPosition(state as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(state).not.toHaveAttribute("open");
    expect(within(state as HTMLElement).getByText("Alles in Ordnung · 8 Prüfungen")).toBeInTheDocument();
  });

  it("lists unhealthy channel checks prominently and keeps the moderator recheck with its row", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      chatSubscriptionNeeded: true,
      botPermissions: { missingScopes: [] },
      moderator: { ...moderator, isModerator: false },
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path === "/api/channels/kanal-a/overview") return jsonResponse(overview(channel));
      if (path === "/api/channels/kanal-a/modules") return jsonResponse({ modules: [] });
      if (path === "/api/channels/kanal-a/events") return jsonResponse({ entries: [], nextCursor: null });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    const state = await screen.findByText("1 auffällige Prüfung · 8 Prüfungen");
    const details = state.closest("details");
    expect(details).toHaveAttribute("open");
    const moderatorRow = within(details as HTMLElement).getByRole("article", { name: "Moderatorstatus" });
    expect(within(moderatorRow).getByRole("button", { name: "Moderatorstatus prüfen" })).toBeInTheDocument();
  });

  it("links to active modules in the channel overview instead of embedding their forms", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const activeModule = { ...overview(channel), activeModules: [{ moduleId: "text_commands", settings: "{}" }] };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path === "/api/channels/kanal-a/overview") return jsonResponse(activeModule);
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    const link = await within(screen.getByRole("main")).findByRole("link", { name: /Textbefehle/ });
    expect(link).toHaveAttribute("href", "/channels/kanal-a/modules/text_commands");
    expect(screen.queryByRole("heading", { name: "Befehl anlegen" })).not.toBeInTheDocument();
  });

  it("reaches an active module via its own subpage", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const activeModule = { ...overview(channel), activeModules: [{ moduleId: "text_commands", settings: "{}" }] };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path === "/api/channels/kanal-a/overview") return jsonResponse(activeModule);
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/modules/text_commands");

    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Textbefehle", level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Befehl anlegen" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Module" }).some((link) => link.getAttribute("href") === "/channels/kanal-a/modules")).toBe(true);
  });

  it("shows the channel identity in the header and only one module switch on the page", async () => {
    const channel = { ...healthyChannel("26876135", "Esembe"), login: "esembe" };
    const secondChannel = healthyChannel("987654", "ZweiteRinne");
    const activeModule = { ...overview(channel), activeModules: [{ moduleId: "text_commands", settings: "{}" }] };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel, secondChannel], bot: channel.bot });
      if (path === "/api/channels/26876135/overview") return jsonResponse(activeModule);
      if (path === "/api/channels/26876135/modules") return jsonResponse({ modules: [{ id: "text_commands", enabled: true, settings: "{}" }] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/26876135/modules/text_commands");

    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Textbefehle", level: 1 })).toBeInTheDocument();
    const channelSelect = screen.getByRole("combobox", { name: "Kanal auswählen" });
    expect(channelSelect).toHaveValue("Esembe — 26876135");
    fireEvent.click(channelSelect);
    // jsdom does no real layout, so Floating UI's `hide` middleware always
    // treats the dropdown's reference as clipped and renders it `display:
    // none` -- present, but invisible to an ordinary role query.
    expect(screen.getByRole("option", { name: "Esembe — 26876135", hidden: true })).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Textbefehle · Läuft" })).not.toBeInTheDocument();
    expect(await screen.findByRole("switch", { name: "Textbefehle: Läuft" })).toBeChecked();
    expect(screen.queryByText("text_commands", { exact: true })).not.toBeInTheDocument();
  });

  it("reloads the channel overview after enabling and shows the module view", async () => {
    const channel = { ...healthyChannel("kanal-a", "Alpha"), role: "broadcaster" as const };
    let overviewAufrufe = 0;
    let modulesCalls = 0;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (url.pathname === "/api/channels/kanal-a/overview") {
        overviewAufrufe += 1;
        return jsonResponse(overviewAufrufe === 1 ? overview(channel) : {
          ...overview(channel),
          activeModules: [{ moduleId: "text_commands", settings: "{}" }],
        });
      }
      if (url.pathname === "/api/channels/kanal-a/modules" && init?.method === undefined) {
        modulesCalls += 1;
        return jsonResponse({ modules: [{ id: "text_commands", enabled: modulesCalls > 1, settings: "{}" }] });
      }
      if (url.pathname === "/api/csrf") return jsonResponse({ token: "csrf-token" });
      if (url.pathname === "/api/channels/kanal-a/modules/text_commands" && init?.method === "PATCH") {
        return jsonResponse({ module: { id: "text_commands", enabled: true, settings: "{}" } });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/modules/text_commands");

    render(<DashboardApp />);

    const switcher = await screen.findByRole("switch", { name: "Textbefehle: Aus" });
    fireEvent.click(switcher);

    expect(await screen.findByRole("button", { name: "Befehl anlegen" })).toBeInTheDocument();
    expect(overviewAufrufe).toBe(2);
    expect(fetcher.mock.calls.filter(([input]) => requestUrl(input).pathname === "/api/channels/kanal-a/overview")).toHaveLength(2);
  });

  it("doesn't let a late reload response overwrite a newer module toggle", async () => {
    const channel = { ...healthyChannel("kanal-a", "Alpha"), role: "manager" as const };
    let modulesCalls = 0;
    let resolveFirstReload: ((response: Response) => void) | undefined;
    const firstReload = new Promise<Response>((resolve) => { resolveFirstReload = resolve; });
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (url.pathname === "/api/channels/kanal-a/overview") return jsonResponse(overview(channel));
      if (url.pathname === "/api/csrf") return jsonResponse({ token: "csrf-token" });
      if (url.pathname === "/api/channels/kanal-a/modules" && init?.method === undefined) {
        modulesCalls += 1;
        // The first reload (after enabling text_commands) is held back; the
        // second (after enabling raid) resolves immediately with both
        // modules already on. The stale first response, reflecting only the
        // first toggle, must lose once it does arrive.
        if (modulesCalls === 2) return firstReload;
        return jsonResponse({
          modules: [
            { id: "text_commands", enabled: modulesCalls > 1, settings: "{}" },
            { id: "raid", enabled: modulesCalls > 2, settings: "{}" },
          ],
        });
      }
      if (url.pathname === "/api/channels/kanal-a/modules/text_commands" && init?.method === "PATCH") {
        return jsonResponse({ module: { id: "text_commands", enabled: true, settings: "{}" } });
      }
      if (url.pathname === "/api/channels/kanal-a/modules/raid" && init?.method === "PATCH") {
        return jsonResponse({ module: { id: "raid", enabled: true, settings: "{}" } });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/modules");

    render(<DashboardApp />);

    fireEvent.click(await screen.findByRole("switch", { name: "Textbefehle" }));
    fireEvent.click(await screen.findByRole("switch", { name: "Raid-Shoutout" }));
    await waitFor(() => { expect(modulesCalls).toBe(3); });
    expect(await screen.findByRole("switch", { name: "Raid-Shoutout" })).toBeChecked();

    // The held-back first reload arrives last, describing an older state.
    resolveFirstReload?.(jsonResponse({
      modules: [
        { id: "text_commands", enabled: true, settings: "{}" },
        { id: "raid", enabled: false, settings: "{}" },
      ],
    }));

    // Give the stale response a chance to apply before asserting it didn't.
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByRole("switch", { name: "Raid-Shoutout" })).toBeChecked();
  });

  it("is the Stream Manager after sign-in: module toggle, immediate actions, and the warnings feed together, no page change", async () => {
    const channel = { ...healthyChannel("kanal-a", "Alpha"), role: "manager" as const };
    let modulesCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (url.pathname === "/api/channels/kanal-a/overview") return jsonResponse(overview(channel));
      if (url.pathname === "/api/channels/kanal-a/events") {
        return jsonResponse({
          entries: [{ eventId: "1", createdAt: relativeIso(0), moduleId: "ads", triggerId: "t1", code: "ads.commercial.failed", detail: "{\"reason\":\"rate_limited\"}", actorUserId: null, actorLogin: null, actorDisplayName: null }],
          nextCursor: null,
        });
      }
      if (url.pathname === "/api/channels/kanal-a/modules" && init?.method === undefined) {
        modulesCalls += 1;
        return jsonResponse({ modules: [{ id: "text_commands", enabled: modulesCalls > 1, settings: "{}" }] });
      }
      if (url.pathname === "/api/csrf") return jsonResponse({ token: "csrf-token" });
      if (url.pathname === "/api/channels/kanal-a/modules/text_commands" && init?.method === "PATCH") {
        return jsonResponse({ module: { id: "text_commands", enabled: true, settings: "{}" } });
      }
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    // Module toggle, without navigating away from the overview.
    const moduleSwitch = await screen.findByRole("switch", { name: "Textbefehle" });
    fireEvent.click(moduleSwitch);
    await waitFor(() => { expect(screen.getByRole("switch", { name: "Textbefehle" })).toBeChecked(); });
    expect(window.location.pathname).toBe("/channels/kanal-a");

    // Immediate actions section is present and reachable.
    expect(screen.getByRole("button", { name: "Clip erstellen" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Shoutout senden" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Werbung jetzt/ })).toBeInTheDocument();

    // Warnings/errors feed needs no interaction to show.
    expect(await screen.findByText("Werbeeinblendung nicht gestartet: rate_limited")).toBeInTheDocument();
  });

  it("switches channels through the header select and moves the route", async () => {
    const alpha = healthyChannel("kanal-a", "Alpha");
    const beta = healthyChannel("kanal-b", "Beta");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [alpha, beta], bot: alpha.bot });
      if (path.endsWith("/overview")) return jsonResponse(overview(path.includes("kanal-b") ? beta : alpha));
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    await screen.findByRole("heading", { name: "Alpha", level: 1 });
    const select = screen.getByRole("combobox", { name: "Kanal auswählen" });
    expect(select).toHaveValue("Alpha — kanal-a");

    fireEvent.click(select);
    fireEvent.click(screen.getByRole("option", { name: "Beta — kanal-b", hidden: true }));

    await waitFor(() => expect(window.location.pathname).toBe("/channels/kanal-b"));
    expect(await screen.findByRole("heading", { name: "Beta", level: 1 })).toBeInTheDocument();
  });

  it("shows every group's entries and marks the current page's sidebar entry as current on every area and the module detail page", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const secondChannel = healthyChannel("kanal-b", "Beta");
    const activeModuleOverview = { ...overview(channel), activeModules: [{ moduleId: "text_commands", settings: "{}" }] };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel, secondChannel], bot: channel.bot });
      if (path.endsWith("/overview")) return jsonResponse(path.includes("modules/text_commands") ? activeModuleOverview : overview(channel));
      if (path.endsWith("/system")) return jsonResponse(system);
      if (path.endsWith("/audit-log")) return jsonResponse(audit);
      if (path.endsWith("/members")) return jsonResponse({ members: [], broadcasterCount: 1, viewerUserId: "viewer", nextCursor: null });
      if (path.endsWith("/modules")) return jsonResponse({ modules: [{ id: "text_commands", enabled: true, settings: "{}" }] });
      if (path.endsWith("/events")) return jsonResponse({ entries: [], nextCursor: null });
      return jsonResponse({}, 404);
    }));

    const pages = [
      { path: "/", heading: "Übersicht", currentLink: null },
      { path: "/channels/kanal-a", heading: "Alpha", currentLink: "Kanal" },
      { path: "/channels/kanal-a/system", heading: "System", currentLink: "System" },
      { path: "/channels/kanal-a/members", heading: "Mitglieder", currentLink: "Mitglieder" },
      { path: "/channels/kanal-a/modules", heading: "Module", currentLink: "Module" },
      { path: "/channels/kanal-a/events", heading: "Ereignisse", currentLink: "Ereignisse" },
      { path: "/channels/kanal-a/modules/text_commands", heading: "Textbefehle", currentLink: "Textbefehle · Läuft" },
    ];

    for (const page of pages) {
      cleanup();
      window.history.replaceState({}, "", page.path);
      render(<DashboardApp />);
      await screen.findByRole("heading", { name: page.heading, level: 1 });
      const nav = screen.getByRole("navigation", { name: "Hauptnavigation" });
      for (const label of ["Ereignisse", "Kanal", "System", "Mitglieder"]) {
        expect(within(nav).getByRole("link", { name: label })).toBeInTheDocument();
      }
      expect(within(nav).getByRole("link", { name: "Module" })).toBeInTheDocument();
      if (page.currentLink === null) {
        expect(within(nav).queryByRole("link", { current: "page" })).not.toBeInTheDocument();
      } else {
        const currentLink = within(nav).getByRole("link", { current: "page" });
        expect(currentLink).toHaveAccessibleName(page.currentLink);
        if (page.currentLink === "Textbefehle · Läuft") {
          const led = currentLink.querySelector(".led--dot-only");
          expect(led?.querySelector(".led__dot")).toBeInTheDocument();
          expect(led).toHaveAttribute("title", "Läuft");
          expect(led).toHaveAttribute("aria-hidden", "true");
        }
      }
    }
  });

  it("the brand acts as a focusable link to the channel list", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const secondChannel = healthyChannel("kanal-b", "Beta");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel, secondChannel], bot: channel.bot });
      if (path.endsWith("/overview")) return jsonResponse(overview(channel));
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    await screen.findByRole("heading", { name: "Alpha", level: 1 });
    const brand = screen.getByRole("link", { name: "BroBot" });
    expect(brand).toHaveAttribute("href", "/");
    fireEvent.click(brand);
    expect(window.location.pathname).toBe("/");
  });

  it("does not mount the old overview state when switching to the module route", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const activeModule = { ...overview(channel), activeModules: [{ moduleId: "text_commands", settings: "{}" }] };
    const inactiveModule = overview(channel);
    let overviewAufrufe = 0;
    let resolveSecondResponse!: (response: Response) => void;
    const secondResponse = new Promise<Response>((resolve) => { resolveSecondResponse = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path === "/api/channels/kanal-a/overview") {
        overviewAufrufe += 1;
        return overviewAufrufe === 1 ? jsonResponse(activeModule) : secondResponse;
      }
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);
    const link = await within(screen.getByRole("main")).findByRole("link", { name: /Textbefehle/ });
    link.click();

    expect(screen.queryByRole("heading", { name: "Befehl anlegen" })).not.toBeInTheDocument();
    resolveSecondResponse(jsonResponse(inactiveModule));
    expect(await screen.findByText("Module werden geladen …")).toBeInTheDocument();
    expect(screen.queryByText("Das Modul „Textbefehle“ ist in diesem Kanal nicht aktiv.")).not.toBeInTheDocument();
  });

  it("reports a disabled module understandably on its subpage", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path === "/api/channels/kanal-a/overview") return jsonResponse(overview(channel));
      if (path === "/api/channels/kanal-a/modules") return jsonResponse({ modules: [{ id: "text_commands", enabled: false, settings: "{}" }] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/modules/text_commands");

    render(<DashboardApp />);

    expect(await screen.findByText("Das Modul „Textbefehle“ ist ausgeschaltet.")).toBeInTheDocument();
  });

  it("reports an unknown module understandably on its subpage", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path === "/api/channels/kanal-a/overview") return jsonResponse(overview(channel));
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/modules/unbekannt");

    render(<DashboardApp />);

    expect(await screen.findByText("Das Modul „unbekannt“ ist nicht bekannt.")).toBeInTheDocument();
  });

  it("shows a channel without broadcaster OAuth neutrally and reaches its overview and system pages", async () => {
    const channel = { ...healthyChannel("kanal-a", "Alpha"), broadcasterConnection: "not_connected" };
    const secondChannel = healthyChannel("kanal-b", "Beta");
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel, secondChannel], bot: channel.bot });
      if (path === "/api/channels/kanal-a/overview") return jsonResponse({ ...overview(channel), broadcasterConnection: "not_connected" });
      if (path === "/api/channels/kanal-a/system") return jsonResponse({ ...system, broadcasterConnection: "not_connected" });
      if (path.endsWith("/audit-log")) return jsonResponse(audit);
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/");

    render(<DashboardApp />);
    const channelTaste = await screen.findByRole("link", { name: /Alpha/ });
    expect(screen.getByRole("link", { name: /Beta/ })).toBeInTheDocument();
    expect(screen.queryByText("Keine Verbindung")).not.toBeInTheDocument();
    expect(channelTaste).toHaveAccessibleName(/Alpha ·/);
    expect(channelTaste).toHaveAttribute("data-status", "green");

    fireEvent.click(screen.getByRole("link", { name: /Alpha/ }));
    await screen.findByRole("heading", { name: "Alpha", level: 1 });
    expect(screen.getByRole("article", { name: "Broadcaster-OAuth" })).toHaveAttribute("data-status", "neutral");

    fireEvent.click(screen.getByRole("link", { name: "System" }));
    await screen.findByRole("heading", { name: "System", level: 1 });
    expect(await screen.findByRole("article", { name: "Broadcaster-OAuth" })).toHaveAttribute("data-status", "neutral");
  });

  it("shows mandatory module state as always active without a switch", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path === "/api/channels/kanal-a/overview") return jsonResponse(overview(channel));
      if (path === "/api/channels/kanal-a/modules") return jsonResponse({ modules: [{ id: "channel_events", enabled: true, mandatory: true, settings: "{}" }] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/modules/channel_events");

    render(<DashboardApp />);

    expect(screen.queryByRole("switch", { name: "Kanalereignisse · Läuft" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "Kanalereignisse: Läuft" })).not.toBeInTheDocument();
    const status = await screen.findByText("Läuft · immer aktiv");
    expect(status.closest(".module-locked-status")).toHaveAttribute("title", "Kanalereignisse sind immer aktiv.");
    expect(screen.queryByText("channel_events", { exact: true })).not.toBeInTheDocument();
    expect(screen.queryByText("Module werden geladen …")).not.toBeInTheDocument();
  });

  it("shows chat as not needed when no active module reads it, even if no subscription row exists", async () => {
    const channel = { ...healthyChannel("kanal-a", "Alpha"), chatSubscription: null, chatSubscriptionNeeded: false };
    const overviewState = { ...channel, activeModules: [] };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path === "/api/channels/kanal-a/overview") return jsonResponse(overviewState);
      if (path === "/api/channels/kanal-a/modules") return jsonResponse({ modules: [] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    const chatRow = await screen.findByRole("article", { name: "Chat-Abo" });
    expect(chatRow).toHaveAttribute("data-status", "neutral");
    expect(chatRow).toHaveTextContent("Nicht benötigt — kein aktives Modul liest den Chat");
  });

  it.each([
    ["de-DE", "pending_adoption", "Wird übernommen"],
    ["de-DE", "moderator_required", "Wartet auf Moderatorstatus des Bots"],
    ["en-US", "pending_adoption", "Being adopted"],
    ["en-US", "moderator_required", "Waiting for the bot's moderator status"],
  ])("shows %s EventSub reason %s as neutral, not as an error", async (browserLanguage, reason, expected) => {
    const channel = { ...healthyChannel("kanal-a", "Alpha"), chatSubscription: { status: "missing", subscriptionId: null, reason, updatedAt: relativeIso(0) }, chatSubscriptionNeeded: true };
    const overviewState = { ...channel, activeModules: [] };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path === "/api/channels/kanal-a/overview") return jsonResponse(overviewState);
      if (path === "/api/channels/kanal-a/modules") return jsonResponse({ modules: [] });
      return jsonResponse({}, 404);
    }));
    Object.defineProperty(window.navigator, "language", { value: browserLanguage, configurable: true });
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    const chatRow = await screen.findByRole("article", { name: browserLanguage === "de-DE" ? "Chat-Abo" : "Chat subscription" });
    expect(chatRow).toHaveAttribute("data-status", "neutral");
    expect(chatRow).toHaveTextContent(expected);
    expect(await screen.findByRole("article", { name: browserLanguage === "de-DE" ? "Letzter Fehler" : "Last error" })).toHaveAttribute("data-status", "healthy");
  });

  it("shows a missing moderator status as a red error state", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      moderator: { isModerator: false, checkedAt: "2026-09-18T02:00:00.000Z", reason: "moderator_entfernt" },
      lastError: { source: "moderator", reason: "moderator_entfernt", at: "2026-09-18T02:00:00.000Z" },
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    const moderatorCard = await screen.findByRole("article", { name: "Moderatorstatus" });
    expect(moderatorCard).toHaveAttribute("data-status", "error");
    expect(moderatorCard).toHaveTextContent("Moderatorrolle fehlt");
  });

  it("shows the affected subscription in the last error in German and English", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      lastError: {
        source: "eventsub",
        reason: "Forbidden",
        message: "Keine Berechtigung.",
        status: 403,
        subscriptionType: "channel.moderate",
        subscriptionVariant: "",
        at: "2026-09-18T02:00:00.000Z",
      },
    };
    const showChannel = async (): Promise<void> => {
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
        const path = requestUrl(input).pathname;
        if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
        if (path.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
        return jsonResponse({}, 404);
      }));
      window.history.replaceState({}, "", "/channels/kanal-a");
      render(<DashboardApp />);
      await screen.findByRole("heading", { name: "Alpha", level: 1 });
    };

    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });
    await showChannel();
    expect(screen.getByText(/Moderationsereignisse: Forbidden/)).toBeInTheDocument();
    expect(screen.getByText(/Keine Berechtigung\./)).toBeInTheDocument();
    expect(screen.getByText(/HTTP 403/)).toBeInTheDocument();

    cleanup();
    vi.unstubAllGlobals();
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    await showChannel();
    expect(screen.getByText(/Moderation events: Forbidden/)).toBeInTheDocument();
    cleanup();
    vi.unstubAllGlobals();
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });
  });

  it("shows missing broadcaster consent as a warning and offers the reauthorization path only to the broadcaster", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      channelBotConsent: "missing",
      lastError: null,
    };
    const showChannel = (displayedChannel: typeof channel): void => {
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
        const path = requestUrl(input).pathname;
        if (path === "/api/channels") return jsonResponse({ channels: [displayedChannel], bot: displayedChannel.bot });
        if (path.endsWith("/overview")) return jsonResponse({ ...displayedChannel, activeModules: [] });
        return jsonResponse({}, 404);
      }));
      window.history.replaceState({}, "", "/channels/kanal-a");
      render(<DashboardApp />);
    };

    showChannel(channel);

    expect((await screen.findAllByText("Broadcaster-Zustimmung fehlt")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Der Broadcaster muss Twitch erneut autorisieren.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Broadcaster-Zustimmung anfordern" })).toBeDisabled();

    cleanup();
    const broadcasterChannel = { ...channel, role: "broadcaster" };
    showChannel(broadcasterChannel);

    const action = await screen.findByRole("link", { name: "Broadcaster-Zustimmung anfordern" });
    expect(action).toHaveAttribute("href", "/auth/channels/kanal-a/channel-bot");
    expect(screen.getByRole("article", { name: "Chat-Zustimmung" })).toHaveAttribute("data-status", "warning");
  });

  it("shows the last moderator check and the action only for authorized roles", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      role: "manager",
      moderator: { isModerator: false, checkedAt: "2026-09-18T02:00:00.000Z", reason: "moderator_entfernt" },
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    await screen.findByRole("article", { name: "Moderatorstatus" });
    expect(within(screen.getByRole("article", { name: "Moderatorstatus" })).getByText("moderator_entfernt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Moderatorstatus prüfen" })).toBeInTheDocument();

    cleanup();
    const operatorChannel = { ...channel, role: "operator" };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [operatorChannel], bot: operatorChannel.bot });
      if (path.endsWith("/overview")) return jsonResponse({ ...operatorChannel, activeModules: [] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");
    render(<DashboardApp />);

    await screen.findByRole("article", { name: "Moderatorstatus" });
    expect(screen.getByRole("button", { name: "Moderatorstatus prüfen" })).toBeDisabled();
    expect(screen.getByText("Nur Broadcaster und Verwalter dürfen den Moderatorstatus prüfen.")).toBeInTheDocument();
  });

  it("shows feedback during and after the manual check", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      role: "broadcaster",
      moderator: { isModerator: false, checkedAt: "2026-09-18T02:00:00.000Z", reason: "moderator_entfernt" },
    };
    let resolveCheck!: (response: Response) => void;
    const check = new Promise<Response>((resolve) => { resolveCheck = resolve; });
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/channels/kanal-a/overview") return Promise.resolve(jsonResponse({ ...channel, activeModules: [] }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (url.pathname === "/api/channels/kanal-a/moderator-status") return check;
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);
    const button = await screen.findByRole("button", { name: "Moderatorstatus prüfen" });
    fireEvent.click(button);

    expect(await screen.findByRole("button", { name: "Prüfung läuft …" })).toBeDisabled();
    resolveCheck(jsonResponse({
      moderator: { isModerator: true, checkedAt: "2026-09-18T04:00:00.000Z", reason: null },
      nextAllowedAt: "2026-09-18T04:05:00.000Z",
    }));

    // Healthy states stay visible and keep a green LED.
    await waitFor(() => expect(screen.getAllByText(/Letzte Prüfung:/).length).toBeGreaterThanOrEqual(1));
    expect(screen.getByRole("article", { name: "Moderatorstatus" })).toHaveAttribute("data-status", "healthy");
    expect(screen.getAllByText(/Letzte Prüfung:/).length).toBeGreaterThanOrEqual(1);
  });

  it("reactivates the moderator check after the lockout period expires", async () => {
    vi.useFakeTimers();
    try {
      const channel = {
        ...healthyChannel("kanal-a", "Alpha"),
        role: "broadcaster",
        moderator: { isModerator: true, checkedAt: "2026-09-18T02:00:00.000Z", reason: null },
      };
      const nextAllowedAt = new Date(Date.now() + 5000).toISOString();
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
        const url = requestUrl(input);
        if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
        if (url.pathname === "/api/channels/kanal-a/overview") return Promise.resolve(jsonResponse({ ...channel, activeModules: [] }));
        if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
        if (url.pathname === "/api/channels/kanal-a/moderator-status") return Promise.resolve(jsonResponse({
          moderator: { isModerator: true, checkedAt: "2026-09-18T04:00:00.000Z", reason: null },
          nextAllowedAt,
        }));
        return Promise.resolve(jsonResponse({}, 404));
      }));
      window.history.replaceState({}, "", "/channels/kanal-a");

      render(<DashboardApp />);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
      const button = screen.getByRole("button", { name: "Moderatorstatus prüfen" });
      fireEvent.click(button);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
      expect(button).toBeDisabled();

      act(() => { vi.advanceTimersByTime(5000); });
      expect(button).toBeEnabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows Twitch errors and keeps the previous moderator state", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      moderator: { isModerator: true, checkedAt: "2026-09-18T02:00:00.000Z", reason: null },
    };
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/channels/kanal-a/overview") return Promise.resolve(jsonResponse({ ...channel, activeModules: [] }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (url.pathname === "/api/channels/kanal-a/moderator-status") return Promise.resolve(jsonResponse({ error: "moderator_status_check_failed" }, 502));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Moderatorstatus prüfen" }));

    expect(await screen.findByText("Moderatorstatus konnte nicht gelesen werden.", { selector: "p" })).toBeInTheDocument();
    expect(screen.queryByText("Nicht geprüft")).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Moderatorstatus" })).toHaveAttribute("data-status", "healthy");
  });

  it("does not show missing token expiry dates as valid or healthy", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      tokens: {
        botExpiresAt: null,
        loginStatus: "connected",
        loginReason: null,
        loginExpiresAt: "2099-09-19T00:00:00.000Z",
      },
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (path.endsWith("/overview")) return Promise.resolve(jsonResponse({ ...channel, activeModules: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    const tokenCard = await screen.findByRole("article", { name: "Token-Zustand" });
    expect(tokenCard).toHaveAttribute("data-status", "neutral");
    expect(within(tokenCard).getByText("Nicht geprüft")).toBeInTheDocument();
    expect(within(tokenCard).queryByText("Gültig")).not.toBeInTheDocument();
    expect(within(tokenCard).queryByText("Gesund")).not.toBeInTheDocument();
    expect(tokenCard.querySelector('[data-status="healthy"]')).toBeNull();
  });

  it("shows a working channel with three hours remaining as healthy", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const secondChannel = healthyChannel("kanal-b", "Beta");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel, secondChannel], bot: channel.bot }));
      if (path.endsWith("/overview")) return Promise.resolve(jsonResponse({ ...channel, activeModules: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));
    window.history.replaceState({}, "", "/");

    render(<DashboardApp />);

    const channelTaste = await screen.findByRole("link", { name: /Alpha/ });
    expect(channelTaste).toHaveAttribute("data-status", "green");
    expect(within(channelTaste).getByText("Gesund", { selector: "span" })).toBeInTheDocument();
    expect(within(channelTaste).queryByText("Warnung")).not.toBeInTheDocument();

    // Healthy states stay visible on the channel page.
    fireEvent.click(screen.getByRole("link", { name: /Alpha/ }));
    await screen.findByRole("heading", { name: "Alpha", level: 1 });
    expect(screen.getByRole("article", { name: "Token-Zustand" })).toHaveAttribute("data-status", "healthy");
    expect(screen.getByRole("article", { name: "Bot-Account" })).toHaveAttribute("data-status", "healthy");
  });

  it("stays healthy as long as expiry is only approaching on its regular cycle", async () => {
    // With four-hour Twitch tokens and an hourly cron, every token regularly
    // sits in the renewal window for up to an hour. That's the normal case
    // and must not warn — otherwise the display warns for nearly an hour
    // every four hours and loses its meaning.
    const basis = healthyChannel("kanal-a", "Alpha");
    const channel = {
      ...basis,
      // The last run happened BEFORE the point at which renewal becomes due.
      bot: { ...basis.bot, updatedAt: relativeIso(-45 * 60 * 1000) },
      tokens: {
        ...basis.tokens,
        botExpiresAt: relativeIso(30 * 60 * 1000),
        loginExpiresAt: relativeIso(30 * 60 * 1000),
      },
    };
    const secondChannel = healthyChannel("kanal-b", "Beta");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel, secondChannel], bot: channel.bot }));
      if (path.endsWith("/overview")) return Promise.resolve(jsonResponse({ ...channel, activeModules: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));
    window.history.replaceState({}, "", "/");

    render(<DashboardApp />);

    const channelTaste = await screen.findByRole("link", { name: /Alpha/ });
    expect(channelTaste).toHaveAttribute("data-status", "green");
    expect(within(channelTaste).queryByText("Erneuerung überfällig")).not.toBeInTheDocument();
  });

  it("warns when a maintenance run failed to renew the due token", async () => {
    // Same remaining time as above — but the cron has run since then and
    // renewed nothing. This is the case that's actually broken.
    const basis = healthyChannel("kanal-a", "Alpha");
    const channel = {
      ...basis,
      bot: { ...basis.bot, updatedAt: relativeIso(-5 * 60 * 1000) },
      tokens: {
        ...basis.tokens,
        botExpiresAt: relativeIso(30 * 60 * 1000),
        loginExpiresAt: relativeIso(30 * 60 * 1000),
      },
    };
    const secondChannel = healthyChannel("kanal-b", "Beta");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel, secondChannel], bot: channel.bot }));
      if (path.endsWith("/overview")) return Promise.resolve(jsonResponse({ ...channel, activeModules: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));
    window.history.replaceState({}, "", "/");

    render(<DashboardApp />);

    const channelTaste = await screen.findByRole("link", { name: /Alpha/ });
    expect(channelTaste).toHaveAttribute("data-status", "amber");
    expect(within(channelTaste).getByText("Erneuerung überfällig", { selector: "span" })).toBeInTheDocument();
  });

  it("warns on a run stale by more than one maintenance interval", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      bot: { status: "connected", reason: null, updatedAt: relativeIso(-(60 * 60 * 1000 + 1)) },
    };
    const secondChannel = healthyChannel("kanal-b", "Beta");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel, secondChannel], bot: channel.bot }));
      if (path.endsWith("/overview")) return Promise.resolve(jsonResponse({ ...channel, activeModules: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));
    window.history.replaceState({}, "", "/");

    render(<DashboardApp />);

    const channelTaste = await screen.findByRole("link", { name: /Alpha/ });
    expect(channelTaste).toHaveAttribute("data-status", "amber");
    expect(within(channelTaste).getByText("Wartung überfällig", { selector: "span" })).toBeInTheDocument();
  });

  it("discards the old data state before the new response on a channel switch", async () => {
    const alpha = healthyChannel("kanal-a", "Alpha");
    const beta = healthyChannel("kanal-b", "Beta");
    let resolveAlpha: ((response: Response) => void) | undefined;
    const alphaResponse = new Promise<Response>((resolve) => {
      resolveAlpha = resolve;
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return Promise.resolve(jsonResponse({ channels: [alpha, beta], bot: alpha.bot }));
      if (path === "/api/channels/kanal-a/overview") return alphaResponse;
      if (path === "/api/channels/kanal-b/overview") return Promise.resolve(jsonResponse(overview(beta)));
      if (path.endsWith("/system")) return Promise.resolve(jsonResponse(system));
      if (path.endsWith("/audit-log")) return Promise.resolve(jsonResponse(audit));
      return Promise.resolve(jsonResponse({}, 404));
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);
    await waitFor(() => expect(resolveAlpha).toBeTypeOf("function"));

    act(() => {
      window.history.pushState({}, "", "/channels/kanal-b");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(screen.queryByRole("heading", { name: "Alpha", level: 1 })).not.toBeInTheDocument();
    expect(screen.queryByText("moderator_entfernt")).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Beta", level: 1 })).toBeInTheDocument();

    await act(async () => {
      resolveAlpha?.(jsonResponse(overview(alpha)));
      await Promise.resolve();
    });
    expect(screen.getByRole("heading", { name: "Beta", level: 1 })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Alpha", level: 1 })).not.toBeInTheDocument();
  });

  it("discards a late, distinguishable system response on a channel switch", async () => {
    const alpha = healthyChannel("kanal-a", "Alpha");
    const beta = healthyChannel("kanal-b", "Beta");
    let resolveAlphaSystem: ((response: Response) => void) | undefined;
    const alphaSystem = new Promise<Response>((resolve) => {
      resolveAlphaSystem = resolve;
    });
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [alpha, beta], bot: alpha.bot }));
      if (url.pathname === "/api/channels/kanal-a/system") return alphaSystem;
      if (url.pathname === "/api/channels/kanal-b/system") return Promise.resolve(jsonResponse(systemFor("beta-system")));
      if (url.pathname.endsWith("/audit-log")) return Promise.resolve(jsonResponse(audit));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/system");

    render(<DashboardApp />);
    await waitFor(() => expect(resolveAlphaSystem).toBeTypeOf("function"));

    act(() => {
      window.history.pushState({}, "", "/channels/kanal-b/system");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect((await screen.findAllByText("beta-system")).length).toBeGreaterThanOrEqual(1);

    await act(async () => {
      resolveAlphaSystem?.(jsonResponse(systemFor("alpha-system")));
      await Promise.resolve();
    });
    expect(screen.getAllByText("beta-system").length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("alpha-system")).not.toBeInTheDocument();
  });

  it("does not merge a late audit response into the next channel", async () => {
    const alpha = healthyChannel("kanal-a", "Alpha");
    const beta = healthyChannel("kanal-b", "Beta");
    let resolveAlphaAudit: ((response: Response) => void) | undefined;
    const alphaAudit = new Promise<Response>((resolve) => {
      resolveAlphaAudit = resolve;
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [alpha, beta], bot: alpha.bot }));
      if (url.pathname.endsWith("/system")) return Promise.resolve(jsonResponse(system));
      if (url.pathname === "/api/channels/kanal-a/audit-log") return alphaAudit;
      if (url.pathname === "/api/channels/kanal-b/audit-log") return Promise.resolve(jsonResponse({
        entries: [{ auditId: "audit-b-1", actorUserId: "user-1", createdAt: "2026-09-18T04:00:00.000Z", action: "beta-erster", before: "{}", after: "{}" }],
        nextCursor: null,
      }));
      return Promise.resolve(jsonResponse({}, 404));
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/system");

    render(<DashboardApp />);
    await waitFor(() => expect(resolveAlphaAudit).toBeTypeOf("function"));

    act(() => {
      window.history.pushState({}, "", "/channels/kanal-b/system");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await screen.findByText("beta-erster");

    await act(async () => {
      resolveAlphaAudit?.(jsonResponse({
        entries: [{ auditId: "audit-a-1", actorUserId: "user-1", createdAt: "2026-09-18T03:00:00.000Z", action: "alpha-verspätet", before: "{}", after: "{}" }],
        nextCursor: null,
      }));
      await Promise.resolve();
    });
    expect(screen.getByText("beta-erster")).toBeInTheDocument();
    expect(screen.queryByText("alpha-verspätet")).not.toBeInTheDocument();
  });

  it("leads to sign-in and removes protected data when logout is rejected with 401", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (url.pathname === "/api/csrf") return jsonResponse({}, 401);
      if (url.pathname.endsWith("/overview")) return jsonResponse(overview(channel));
      return jsonResponse({}, 404);
    }));

    window.history.replaceState({}, "", "/channels/kanal-a");
    render(<DashboardApp />);
    await screen.findByRole("heading", { name: "Alpha", level: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));

    await screen.findByRole("heading", { name: "Anmeldung erforderlich", level: 1 });
    expect(screen.queryByRole("heading", { name: "Alpha", level: 1 })).not.toBeInTheDocument();
  });

  it("stays signed in and reports the error when logout is rejected with 403", async () => {
    // 403 means the CSRF token didn't match — the worker did not revoke the
    // session. Redirecting to sign-in here would report a logout that never
    // happened: after a reload the user is back.
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (url.pathname === "/api/csrf") return jsonResponse({ token: "csrf-token" });
      if (url.pathname === "/auth/logout" && init?.method === "POST") return jsonResponse({}, 403);
      if (url.pathname.endsWith("/overview")) return jsonResponse(overview(channel));
      return jsonResponse({}, 404);
    }));

    window.history.replaceState({}, "", "/channels/kanal-a");
    render(<DashboardApp />);
    await screen.findByRole("heading", { name: "Alpha", level: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Abmelden" })).toBeEnabled();
    });
    expect(screen.queryByRole("heading", { name: "Anmeldung erforderlich", level: 1 }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Alpha", level: 1 })).toBeInTheDocument();
  });

  it("fetches the CSRF token before logout and sends it in the header", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (url.pathname === "/api/csrf") return jsonResponse({ token: "csrf-token" });
      if (url.pathname === "/auth/logout" && init?.method === "POST") return new Response(null, { status: 204 });
      if (url.pathname.endsWith("/overview")) return jsonResponse(overview(channel));
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetcher);

    render(<DashboardApp />);
    await screen.findByRole("heading", { name: "Übersicht", level: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));

    await waitFor(() => {
      const logoutCall = fetcher.mock.calls.find((call) => requestUrl(call[0]).pathname === "/auth/logout");
      expect(logoutCall).toBeDefined();
      expect(logoutCall?.[1]?.method).toBe("POST");
      expect(new Headers(logoutCall?.[1]?.headers).get("X-CSRF-Token")).toBe("csrf-token");
    });
  });

  it("arranges the subscriptions list and its inspector as direct region children", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const subscriptions = [{
      subscriptionType: "channel.chat.message",
      variant: "",
      version: "1",
      subscriptionId: "chat-1",
      status: "enabled",
      reason: null,
      message: null,
      statusCode: null,
      updatedAt: "2026-09-18T04:00:00.000Z",
    }];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/system")) return jsonResponse({ ...system, subscriptions });
      if (path.endsWith("/audit-log")) return jsonResponse(audit);
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/system");

    render(<DashboardApp />);

    const row = (await screen.findByText("Chat-Nachrichten")).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(row as HTMLElement);
    const section = screen.getByRole("region", { name: "Abonnements" });
    expect(section.children).toHaveLength(2);
    expect(section.children[0]).toHaveClass("inspector-section__list");
    expect(section.children[1]).toHaveClass("sub-inspector");
  });

  it("shows the audit inspector only once an entry is selected, alongside the list", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const entry = {
      auditId: "audit-1",
      actorUserId: "user-1",
      actorLogin: "alice",
      actorDisplayName: "Alice",
      createdAt: "2026-09-18T04:00:00.000Z",
      action: "module.enabled",
      before: "{}",
      after: "{}",
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/system")) return jsonResponse(system);
      if (path.endsWith("/audit-log")) return jsonResponse({ entries: [entry], nextCursor: null });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/system");

    render(<DashboardApp />);

    const list = await screen.findByRole("region", { name: "Audit-Log" });
    expect(screen.queryByRole("region", { name: "Änderungsdaten" })).not.toBeInTheDocument();

    const row = (await screen.findByText("Modul aktiviert")).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(row as HTMLElement);

    expect(list).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Änderungsdaten" })).toBeInTheDocument();
  });

  it("keeps the audit selection intact across a reload", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const entry = {
      auditId: "audit-1",
      actorUserId: "user-1",
      actorLogin: "alice",
      actorDisplayName: "Alice",
      createdAt: "2026-09-18T04:00:00.000Z",
      action: "module.enabled",
      before: "{\"enabled\":false}",
      after: "{\"enabled\":true}",
    };
    let auditRequests = 0;
    let resolveReload: ((response: Response) => void) | undefined;
    const reload = new Promise<Response>((resolve) => { resolveReload = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/system")) return jsonResponse(system);
      if (path.endsWith("/audit-log")) {
        auditRequests += 1;
        return auditRequests === 1 ? jsonResponse({ entries: [entry], nextCursor: null }) : reload;
      }
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/system");

    render(<DashboardApp />);

    const row = (await screen.findByText("Modul aktiviert")).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(row as HTMLElement);
    expect(await screen.findByRole("region", { name: "Änderungsdaten" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("link", { name: "System" }));
    await waitFor(() => expect(auditRequests).toBe(2));
    resolveReload?.(jsonResponse({ entries: [entry], nextCursor: null }));

    const restoredRow = (await screen.findAllByRole("row", { name: /Modul aktiviert/ }))[0];
    expect(restoredRow).toBeDefined();
    expect(restoredRow).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("region", { name: "Änderungsdaten" })).toBeInTheDocument();
  });

  it("shows the incident inspector only once an event is selected, alongside the list", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const entry = {
      eventId: "event-1",
      createdAt: "2026-09-18T04:00:00.000Z",
      moduleId: "text_commands",
      triggerId: "trigger-1",
      code: "text_commands.triggered",
      detail: '{"name":"wiki","response":"Antwort"}',
      actorUserId: "user-1",
      actorLogin: "alice",
      actorDisplayName: "Alice",
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/events")) return jsonResponse({ entries: [entry], nextCursor: null });
      if (path.endsWith("/modules")) return jsonResponse({ modules: [] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    const list = await screen.findByRole("region", { name: "Ereignisprotokoll" });
    expect(screen.queryByRole("region", { name: "Detail" })).not.toBeInTheDocument();

    const row = (await screen.findByText("Befehl !wiki ausgeführt")).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(row as HTMLElement);

    expect(list).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Detail" })).toBeInTheDocument();
  });

  it("keeps the event incident intact across a reload", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const entry = {
      eventId: "event-1",
      createdAt: "2026-09-18T04:00:00.000Z",
      moduleId: "text_commands",
      triggerId: "trigger-1",
      code: "text_commands.triggered",
      detail: '{"name":"wiki","response":"Antwort"}',
      actorUserId: "user-1",
      actorLogin: "alice",
      actorDisplayName: "Alice",
    };
    let eventRequests = 0;
    let resolveReload: ((response: Response) => void) | undefined;
    const reload = new Promise<Response>((resolve) => { resolveReload = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/events")) {
        eventRequests += 1;
        return eventRequests === 1 ? jsonResponse({ entries: [entry], nextCursor: null }) : reload;
      }
      if (path.endsWith("/modules")) return jsonResponse({ modules: [] });
      return jsonResponse({}, 404);
    }));
    vi.stubGlobal("WebSocket", TestWebSocket);
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    const row = (await screen.findByText("Befehl !wiki ausgeführt")).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(row as HTMLElement);
    expect(await screen.findByRole("region", { name: "Detail" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("link", { name: "Ereignisse" }));
    await waitFor(() => expect(eventRequests).toBe(2));
    resolveReload?.(jsonResponse({ entries: [entry], nextCursor: null }));

    const restoredRow = (await screen.findAllByRole("row", { name: /Befehl !wiki ausgeführt/ }))[0];
    expect(restoredRow).toBeDefined();
    expect(restoredRow).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("region", { name: "Detail" })).toBeInTheDocument();
  });

  it("shows both scope lists as ordinary regions without the inspector class", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      botPermissions: { missingScopes: ["user:bot"] },
      broadcasterPermissions: { missingScopes: ["channel:manage:broadcast"] },
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    const botScopes = await screen.findByRole("region", { name: "Fehlende Bot-Berechtigungen" });
    const broadcasterScopes = await screen.findByRole("region", { name: "Fehlende Broadcaster-Berechtigungen" });
    expect(botScopes).not.toHaveClass("sub-inspector");
    expect(broadcasterScopes).not.toHaveClass("sub-inspector");
  });

  it("closes the subscription inspector by button and Escape, returning focus to the row", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const beta = healthyChannel("kanal-b", "Beta");
    const subscription = {
      subscriptionType: "channel.chat.message",
      variant: "",
      version: "1",
      subscriptionId: "chat-1",
      status: "enabled",
      reason: null,
      message: null,
      statusCode: null,
      updatedAt: "2026-09-18T04:00:00.000Z",
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel, beta], bot: channel.bot });
      if (path.endsWith("/system")) return jsonResponse({ ...system, subscriptions: [subscription] });
      if (path.endsWith("/audit-log")) return jsonResponse(audit);
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/system");

    render(<DashboardApp />);

    const row = (await screen.findByText("Chat-Nachrichten")).closest("tr");
    if (row === null) throw new Error("Abo-Zeile fehlt");
    row.focus();
    fireEvent.click(row);
    expect(row).toHaveFocus();
    await screen.findByRole("region", { name: "Abo-Details" });
    const closeButton = screen.getByRole("button", { name: "Schließen" });
    closeButton.focus();
    fireEvent.click(closeButton);
    expect(screen.queryByRole("region", { name: "Abo-Details" })).not.toBeInTheDocument();
    expect(row).toHaveAttribute("aria-selected", "false");
    expect(row).toHaveFocus();

    fireEvent.click(row);
    const reopenedInspector = await screen.findByRole("region", { name: "Abo-Details" });
    expect(reopenedInspector).toBeInTheDocument();
    expect(row).toHaveFocus();
    const reopenedCloseButton = within(reopenedInspector).getByRole("button", { name: "Schließen" });
    reopenedCloseButton.focus();
    fireEvent.keyDown(reopenedCloseButton, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Abo-Details" })).not.toBeInTheDocument();
    expect(row).toHaveFocus();

    fireEvent.click(row);
    expect(await screen.findByRole("region", { name: "Abo-Details" })).toBeInTheDocument();
    const channelSelect = screen.getByRole("combobox", { name: "Kanal auswählen" });
    fireEvent.click(channelSelect);
    expect(screen.getByRole("option", { name: "Alpha — kanal-a", hidden: true })).toBeInTheDocument();
    fireEvent.keyDown(channelSelect, { key: "Escape" });
    expect(screen.queryByRole("option", { name: "Alpha — kanal-a" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Abo-Details" })).toBeInTheDocument();
  });

  it("closes the audit inspector by button and Escape, returning focus to the row", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const entry = {
      auditId: "audit-1",
      actorUserId: "user-1",
      actorLogin: "alice",
      actorDisplayName: "Alice",
      createdAt: "2026-09-18T04:00:00.000Z",
      action: "module.enabled",
      before: "{}",
      after: "{}",
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/system")) return jsonResponse(system);
      if (path.endsWith("/audit-log")) return jsonResponse({ entries: [entry], nextCursor: null });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/system");

    render(<DashboardApp />);

    const row = (await screen.findByText("Modul aktiviert")).closest("tr");
    if (row === null) throw new Error("Audit-Zeile fehlt");
    row.focus();
    fireEvent.click(row);
    expect(row).toHaveFocus();
    await screen.findByRole("region", { name: "Änderungsdaten" });
    const closeButton = screen.getByRole("button", { name: "Schließen" });
    closeButton.focus();
    fireEvent.click(closeButton);
    expect(screen.queryByRole("region", { name: "Änderungsdaten" })).not.toBeInTheDocument();
    expect(row).toHaveFocus();

    fireEvent.click(row);
    const reopenedInspector = await screen.findByRole("region", { name: "Änderungsdaten" });
    expect(reopenedInspector).toBeInTheDocument();
    expect(row).toHaveFocus();
    const reopenedCloseButton = within(reopenedInspector).getByRole("button", { name: "Schließen" });
    reopenedCloseButton.focus();
    fireEvent.keyDown(reopenedCloseButton, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Änderungsdaten" })).not.toBeInTheDocument();
    expect(row).toHaveFocus();
  });

  it("closes the event inspector by button and Escape, returning focus to the row", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const entry = {
      eventId: "event-1",
      createdAt: "2026-09-18T04:00:00.000Z",
      moduleId: "text_commands",
      triggerId: "trigger-1",
      code: "text_commands.triggered",
      detail: '{"name":"wiki","response":"Antwort"}',
      actorUserId: "user-1",
      actorLogin: "alice",
      actorDisplayName: "Alice",
    };
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/events")) return jsonResponse({ entries: [entry], nextCursor: null });
      if (path.endsWith("/modules")) return jsonResponse({ modules: [] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    const row = (await screen.findByText("Befehl !wiki ausgeführt")).closest("tr");
    if (row === null) throw new Error("Ereignis-Zeile fehlt");
    row.focus();
    fireEvent.click(row);
    expect(row).toHaveFocus();
    await screen.findByRole("region", { name: "Detail" });
    const closeButton = screen.getByRole("button", { name: "Schließen" });
    closeButton.focus();
    fireEvent.click(closeButton);
    expect(screen.queryByRole("region", { name: "Detail" })).not.toBeInTheDocument();
    expect(row).toHaveFocus();

    fireEvent.click(row);
    const reopenedInspector = await screen.findByRole("region", { name: "Detail" });
    expect(reopenedInspector).toBeInTheDocument();
    expect(row).toHaveFocus();
    const reopenedCloseButton = within(reopenedInspector).getByRole("button", { name: "Schließen" });
    reopenedCloseButton.focus();
    fireEvent.keyDown(reopenedCloseButton, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Detail" })).not.toBeInTheDocument();
    expect(row).toHaveFocus();
  });

  describe("blocking states (#159)", () => {
    it("asks a platform admin to switch to the bot account without offering bot consent", async () => {
      const channel = { ...healthyChannel("kanal-a", "Alpha"), bot: { status: "revoked", reason: "authorization_revoked", updatedAt: relativeIso(0) } };
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
        const path = requestUrl(input).pathname;
        if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot, platformAdmin: true, viewerIsBot: false, botLogin: "brobot" });
        return jsonResponse({}, 404);
      }));
      window.history.replaceState({}, "", "/channels/kanal-a");

      const { container } = render(<DashboardApp />);

      expect(await screen.findByRole("heading", { name: "Der Bot ist nicht angemeldet", level: 1 })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Mit Bot-Account anmelden" })).toBeInTheDocument();
      expect(screen.getByText(/@brobot/)).toBeInTheDocument();
      expect(screen.getByText(/nicht dein eigenes Konto/)).toBeInTheDocument();
      expect(container.querySelector('a[href="/auth/bot/login"]')).toBeNull();
      expect(screen.queryByText("Wende dich an den Betreiber der Installation.")).not.toBeInTheDocument();
    });

    it("lets the bot viewer connect itself", async () => {
      const channel = { ...healthyChannel("kanal-a", "Alpha"), bot: null };
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
        const path = requestUrl(input).pathname;
        if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: null, platformAdmin: false, viewerIsBot: true, botLogin: "brobot" });
        return jsonResponse({}, 404);
      }));
      window.history.replaceState({}, "", "/channels/kanal-a");

      render(<DashboardApp />);

      expect(await screen.findByRole("button", { name: "Bot verbinden" })).toBeInTheDocument();
      expect(screen.getByText(/als Bot-Konto angemeldet/)).toBeInTheDocument();
      expect(screen.queryByText("Wende dich an den Betreiber der Installation.")).not.toBeInTheDocument();
    });

    it("blocks a channel page without an action for a broadcaster or manager when the bot is not signed in", async () => {
      const channel = { ...healthyChannel("kanal-a", "Alpha"), bot: null };
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
        const path = requestUrl(input).pathname;
        if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot, platformAdmin: false });
        return jsonResponse({}, 404);
      }));
      window.history.replaceState({}, "", "/channels/kanal-a");

      render(<DashboardApp />);

      expect(await screen.findByRole("heading", { name: "Der Bot ist nicht angemeldet", level: 1 })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Bot verbinden" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Mit Bot-Account anmelden" })).not.toBeInTheDocument();
      expect(screen.getByText("Wende dich an den Betreiber der Installation.")).toBeInTheDocument();
    });

    it("shows a neutral, non-outage state for a channel not released to this account", async () => {
      const other = healthyChannel("kanal-b", "Beta");
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
        const path = requestUrl(input).pathname;
        if (path === "/api/channels") return jsonResponse({ channels: [other], bot: other.bot, platformAdmin: false });
        return jsonResponse({}, 404);
      }));
      window.history.replaceState({}, "", "/channels/kanal-a");

      render(<DashboardApp />);

      expect(await screen.findByRole("heading", { name: "Kanal nicht freigegeben", level: 1 })).toBeInTheDocument();
      expect(screen.getByText("Nur der Betreiber kann diesen Kanal für dein Konto freigeben.")).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Der Bot ist nicht angemeldet" })).not.toBeInTheDocument();
    });

    it("keeps the system page reachable, without the blocking state, while the bot is not signed in", async () => {
      const channel = { ...healthyChannel("kanal-a", "Alpha"), bot: { status: "revoked", reason: "authorization_revoked", updatedAt: relativeIso(0) } };
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
        const path = requestUrl(input).pathname;
        if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot, platformAdmin: true });
        if (path.endsWith("/system")) return jsonResponse(systemFor("authorization_revoked"));
        if (path.endsWith("/audit-log")) return jsonResponse(audit);
        return jsonResponse({}, 404);
      }));
      window.history.replaceState({}, "", "/channels/kanal-a/system");

      render(<DashboardApp />);

      expect(await screen.findByRole("heading", { name: "System", level: 1 })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Der Bot ist nicht angemeldet" })).not.toBeInTheDocument();
    });

  it("shows the bot account switch action on a fresh, zero-channel installation for a platform admin", async () => {
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
        const path = requestUrl(input).pathname;
        if (path === "/api/channels") return jsonResponse({ channels: [], bot: null, platformAdmin: true, viewerIsBot: false, botLogin: "brobot" });
        return jsonResponse({}, 404);
      }));
      window.history.replaceState({}, "", "/");

      render(<DashboardApp />);

      expect(await screen.findByRole("heading", { name: "Der Bot ist nicht angemeldet", level: 1 })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Mit Bot-Account anmelden" })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Übersicht" })).not.toBeInTheDocument();
    });

    it("shows the bot state without an action on the overview of a fresh, zero-channel installation for a broadcaster or manager", async () => {
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
        const path = requestUrl(input).pathname;
        if (path === "/api/channels") return jsonResponse({ channels: [], bot: null, platformAdmin: false });
        return jsonResponse({}, 404);
      }));
      window.history.replaceState({}, "", "/");

      render(<DashboardApp />);

      expect(await screen.findByRole("heading", { name: "Der Bot ist nicht angemeldet", level: 1 })).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Bot verbinden" })).not.toBeInTheDocument();
      expect(screen.getByText("Wende dich an den Betreiber der Installation.")).toBeInTheDocument();
    });

    it("shows the empty overview after the bot account connects without channel membership", async () => {
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
        const path = requestUrl(input).pathname;
        if (path === "/api/channels") return jsonResponse({
          channels: [],
          bot: { status: "connected", reason: null, updatedAt: relativeIso(0) },
          platformAdmin: false,
          viewerIsBot: true,
          botLogin: "brobot",
        });
        return jsonResponse({}, 404);
      }));
      window.history.replaceState({}, "", "/");

      render(<DashboardApp />);

      expect(await screen.findByRole("heading", { name: "Übersicht", level: 1 })).toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Noch kein Kanal freigegeben", level: 2 })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Der Bot ist nicht angemeldet" })).not.toBeInTheDocument();
    });

    it("lets the bot state win over channel-not-released -- installation-wide beats per-viewer", async () => {
      const other = healthyChannel("kanal-b", "Beta");
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
        const path = requestUrl(input).pathname;
        if (path === "/api/channels") return jsonResponse({ channels: [other], bot: null, platformAdmin: false });
        return jsonResponse({}, 404);
      }));
      window.history.replaceState({}, "", "/channels/kanal-a");

      render(<DashboardApp />);

      expect(await screen.findByRole("heading", { name: "Der Bot ist nicht angemeldet", level: 1 })).toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "Kanal nicht freigegeben" })).not.toBeInTheDocument();
    });
  });

  it("replaces the landing route with the only accessible channel overview", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path === "/api/channels/kanal-a/overview") return jsonResponse(overview(channel));
      if (path === "/api/channels/kanal-a/modules") return jsonResponse({ modules: [] });
      return jsonResponse({}, 404);
    }));
    const replaceState = vi.spyOn(window.history, "replaceState");
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Alpha", level: 1 })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/channels/kanal-a");
    expect(replaceState).toHaveBeenCalledWith({}, "", "/channels/kanal-a");
    replaceState.mockRestore();
  });

  it("keeps the channel list at the landing route when several channels are accessible", async () => {
    const alpha = healthyChannel("kanal-a", "Alpha");
    const beta = healthyChannel("kanal-b", "Beta");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [alpha, beta], bot: alpha.bot });
      return jsonResponse({}, 404);
    }));
    const replaceState = vi.spyOn(window.history, "replaceState");
    window.history.replaceState({}, "", "/");

    render(<DashboardApp />);

    expect(await screen.findByRole("link", { name: /Alpha/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Beta/ })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
    expect(replaceState).not.toHaveBeenCalledWith({}, "", expect.stringMatching(/^\/channels\//));
    replaceState.mockRestore();
  });
});
