import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardApp } from "../../src/dashboard/main";
import { dashboardRoutePath, parseDashboardRoute } from "../../src/dashboard/router";
import { jsonResponse } from "../unit/fixtures";

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
  streamState: "offline" as "online" | "offline" | null,
  streamStartedAt: null as string | null,
  controls: {
    mute: { active: false, until: null as string | null, mode: null as "timed" | "until_stream_end" | "unlimited" | null },
    pause: { active: false, until: null as string | null, mode: null as "timed" | "until_stream_end" | "unlimited" | null },
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

type DashboardRoute = (url: URL) => Response | Promise<Response> | undefined;

const stubDashboardFetch = (
  route: DashboardRoute,
  channels: Array<{ bot?: unknown }> = [healthyChannel("kanal-a", "Alpha")],
) => {
  const fetcher = vi.fn((input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url.pathname === "/api/channels") {
      return jsonResponse({ channels, bot: channels[0]?.bot });
    }
    return route(url) ?? jsonResponse({}, 404);
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};

const stubEventFeedFetch = (
  eventResponse: (url: URL) => Response | Promise<Response>,
  channel = healthyChannel("kanal-a", "Alpha"),
) => stubDashboardFetch((url) => {
  if (url.pathname === `/api/channels/${channel.channelId}/modules`) return jsonResponse({ modules: [] });
  if (url.pathname === `/api/channels/${channel.channelId}/events`) return eventResponse(url);
}, [channel]);

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
  stubDashboardFetch((url) => {
    if (url.pathname.endsWith("/members")) return jsonResponse({ ...members, nextCursor: null });
  }, [channel]);
  window.history.replaceState({}, "", "/channels/kanal-a/members");
  render(<DashboardApp />);
  await screen.findByRole("heading", { name: "Mitglieder", level: 1 });
};

const showChannelOverview = async (channel: ReturnType<typeof healthyChannel>): Promise<void> => {
  stubDashboardFetch((url) => {
    if (url.pathname === `/api/channels/${channel.channelId}/overview`) return jsonResponse(overview(channel));
    if (url.pathname === `/api/channels/${channel.channelId}/modules`) return jsonResponse({ modules: [] });
  }, [channel]);
  window.history.replaceState({}, "", `/channels/${channel.channelId}/overview`);
  render(<DashboardApp />);
  await screen.findByRole("combobox", { name: "Kanal auswählen" });
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

  it("recognizes the channel-bound audit route", () => {
    expect(parseDashboardRoute("/channels/kanal-a/audit")).toEqual({
      kind: "channel",
      channelId: "kanal-a",
      section: "audit",
    });
  });

  it("keeps multiple event tones in a deep link", () => {
    const route = parseDashboardRoute("/channels/kanal-a/events", "?tone=warning&tone=error");
    expect(route).toMatchObject({
      kind: "channel",
      section: "events",
      filters: { origin: null, module: null, tone: null, tones: ["warning", "error"], person: null },
    });
    expect(dashboardRoutePath(route)).toBe("/channels/kanal-a/events?tone=warning&tone=error");
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
    stubDashboardFetch((url) => {
      if (url.pathname.endsWith("/events")) return jsonResponse({
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
    }, [channel]);
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
    expect(eventRow?.querySelector("td:nth-child(2)")).toHaveTextContent("Shoutout");
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
    stubDashboardFetch((url) => {
      if (url.pathname.endsWith("/events")) return jsonResponse({
        entries: [
          { eventId: "today", createdAt: "2026-09-18T04:00:00.000Z", moduleId: "raid", code: "raid.shoutout", detail: "{}", actorUserId: null },
          { eventId: "yesterday", createdAt: "2026-09-17T04:00:00.000Z", moduleId: "raid", code: "raid.outgoing", detail: "{}", actorUserId: null },
        ],
        nextCursor: null,
      });
    }, [channel]);
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    const headings = (await screen.findAllByRole("heading", { level: 3 })).map((heading) => heading.textContent);
    expect(headings).toEqual(["18.09.2026", "17.09.2026"]);
    expect(screen.getAllByRole("table")).toHaveLength(2);
  });

  it("shows the event chip pair with family, tier, number and time tooltip", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    stubDashboardFetch((url) => {
      if (url.pathname.endsWith("/events")) return jsonResponse({
        entries: [
          { eventId: "gift", createdAt: "2026-09-18T04:00:00.000Z", moduleId: "channel_events", code: "channel_events.chat.community_gift", detail: '{"count":5}', actorUserId: null },
          { eventId: "raid", createdAt: "2026-09-18T04:01:00.000Z", moduleId: "channel_events", code: "channel_events.raid.incoming", detail: '{"viewers":21}', actorUserId: null },
          { eventId: "untimeout", createdAt: "2026-09-18T04:02:00.000Z", moduleId: "channel_events", code: "channel_events.moderation.untimeout", detail: "{}", actorUserId: null },
          { eventId: "sent", createdAt: "2026-09-18T04:03:00.000Z", moduleId: "text_commands", code: "host.chat.sent", detail: "{}", actorUserId: null },
          { eventId: "unknown", createdAt: "2026-09-18T04:04:00.000Z", moduleId: "plugin", code: "plugin.anderes", detail: "kein-json", actorUserId: null },
        ],
        nextCursor: null,
      });
    }, [channel]);
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
    stubDashboardFetch((url) => {
      if (url.pathname.endsWith("/events")) return jsonResponse({
        entries: [
          { eventId: "t1", createdAt: "2026-09-18T04:00:00.000Z", moduleId: "channel_events", code: "channel_events.chat.sub", detail: '{"person":"tier1","tier":"1000"}', actorUserId: null },
          { eventId: "t2", createdAt: "2026-09-18T04:01:00.000Z", moduleId: "channel_events", code: "channel_events.chat.sub", detail: '{"person":"tier2","tier":"2000"}', actorUserId: null },
          { eventId: "t3", createdAt: "2026-09-18T04:02:00.000Z", moduleId: "channel_events", code: "channel_events.chat.sub", detail: '{"person":"tier3","tier":"3000"}', actorUserId: null },
          { eventId: "prime", createdAt: "2026-09-18T04:03:00.000Z", moduleId: "channel_events", code: "channel_events.chat.sub", detail: '{"person":"primeperson","tier":"Prime"}', actorUserId: null },
          { eventId: "unbekannt", createdAt: "2026-09-18T04:04:00.000Z", moduleId: "channel_events", code: "channel_events.chat.sub", detail: '{"person":"rätselperson","tier":"9999"}', actorUserId: null },
        ],
        nextCursor: null,
      });
    }, [channel]);
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
    stubEventFeedFetch(() => {
      firstPage += 1;
      return jsonResponse({ entries: firstPage === 1 ? [alt] : [neu, alt], nextCursor: null });
    }, channel);
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

  it("shows an incoming raid with default filters and inserts new raid hints from realtime", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const incomingRaid = {
      eventId: "channel-raid",
      createdAt: "2026-09-18T04:00:00.000Z",
      moduleId: "channel_events",
      triggerId: "raid-trigger",
      code: "channel_events.raid.incoming",
      detail: '{"source":"raider_b","viewers":1}',
      actorUserId: null,
      actorLogin: null,
      actorDisplayName: null,
    };
    const raidAction = {
      eventId: "module-raid",
      createdAt: incomingRaid.createdAt,
      moduleId: "raid",
      triggerId: incomingRaid.triggerId,
      code: "raid.shoutout",
      detail: '{"viewers":1,"threshold":5}',
      actorUserId: null,
      actorLogin: null,
      actorDisplayName: null,
    };
    const newRaid = { ...incomingRaid, eventId: "channel-raid-live", createdAt: "2026-09-18T04:01:00.000Z", detail: '{"source":"freshraid","viewers":2}' };
    let eventRequests = 0;
    vi.stubGlobal("WebSocket", TestWebSocket);
    const fetcher = stubEventFeedFetch(() => {
      eventRequests += 1;
      return jsonResponse({ entries: eventRequests === 1 ? [raidAction, incomingRaid] : [newRaid, raidAction, incomingRaid], nextCursor: null });
    }, channel);
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    expect(await screen.findByText("Raid von raider_b mit 1 Zuschauern")).toBeInTheDocument();
    const initialRequest = fetcher.mock.calls.map(([input]) => requestUrl(input)).find((url) => url.pathname.endsWith("/events"));
    expect(initialRequest?.search).toBe("");
    const socket = TestWebSocket.instances[0];
    if (socket === undefined) throw new Error("Realtime-Socket fehlt");
    socket.open();
    socket.receive(JSON.stringify({
      version: 1,
      id: "raid-hint",
      createdAt: newRaid.createdAt,
      channelId: "kanal-a",
      type: "event_log.new",
      payload: { entries: [{ eventId: newRaid.eventId, createdAt: newRaid.createdAt, moduleId: "channel_events", code: newRaid.code, actorUserId: null }] },
    }));

    expect(await screen.findByText("Raid von freshraid mit 2 Zuschauern")).toBeInTheDocument();
    expect(eventRequests).toBe(2);
  });

  it("keeps the list further down and shows only the notice", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const alt = { eventId: "event-alt", createdAt: "2026-09-18T03:00:00.000Z", moduleId: "raid", code: "alt", detail: "{}", actorUserId: null, actorLogin: null, actorDisplayName: null };
    const neu = { eventId: "event-neu", createdAt: "2026-09-18T04:00:00.000Z", moduleId: "channel_events", code: "channel_events.raid.incoming", detail: '{"viewers":8}', actorUserId: null, actorLogin: null, actorDisplayName: null };
    let eventRequests = 0;
    vi.stubGlobal("WebSocket", TestWebSocket);
    stubEventFeedFetch(() => {
      eventRequests += 1;
      return jsonResponse({ entries: [alt], nextCursor: null });
    }, channel);
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
    stubEventFeedFetch(() => {
      eventRequests += 1;
      return jsonResponse({ entries: eventRequests === 1 ? [alt] : [neu, alt], nextCursor: null });
    }, channel);
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
    stubEventFeedFetch(() => {
      eventRequests += 1;
      return jsonResponse({ entries: eventRequests === 1 ? [alt] : [neu, alt], nextCursor: null });
    }, channel);
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
    stubEventFeedFetch(() => {
      eventRequests += 1;
      return jsonResponse({ entries: [], nextCursor: null });
    }, channel);
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
    stubEventFeedFetch(() => jsonResponse({ entries: [], nextCursor: null }), channel);
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
    stubEventFeedFetch(() => {
      eventRequests += 1;
      return Promise.resolve(jsonResponse({ entries: eventRequests === 1 ? [alt] : [neu, alt], nextCursor: null }));
    }, channel);
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
    stubDashboardFetch((url) => {
      if (url.pathname.endsWith("/events")) return jsonResponse({
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
    }, [channel]);
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
    stubDashboardFetch((url) => {
      if (url.pathname.endsWith("/events")) return jsonResponse({ entries: [], nextCursor: null });
    }, [channel]);
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

    expect(await screen.findByRole("button", { name: "Entziehen" })).toBeDisabled();
    expect(screen.getAllByText("Letzter Broadcaster")).toHaveLength(1);
    expect(document.querySelector(".member-avatar-placeholder")).toHaveTextContent("E");

    // The role choice offers no value that would be rejected.
    const rollen = screen.getByRole("radiogroup", { name: "Rolle für esembe" });
    expect(within(rollen).getAllByRole("radio")).toHaveLength(1);
    expect(within(rollen).getByRole("radio", { name: /Broadcaster/ })).toBeDisabled();
  });

  it("allows revocation once a second broadcaster remains", async () => {
    // Control check: the lock must not also lock the permitted case.
    await showMembers({
      members: [broadcaster("100", "esembe", "esembe"), broadcaster("200", "zweit", "Zweit")],
      broadcasterCount: 2,
      viewerUserId: "100",
    });
    fireEvent.click(await screen.findByRole("row", { name: /esembe/ }));

    expect(await screen.findByRole("button", { name: "Entziehen" })).toBeEnabled();
    expect(screen.queryByText("Letzter Broadcaster")).not.toBeInTheDocument();
  });

  it("explicitly warns about lockout when revoking one's own access", async () => {
    await showMembers({
      members: [broadcaster("100", "esembe", "esembe"), broadcaster("200", "zweit", "Zweit")],
      broadcasterCount: 2,
      viewerUserId: "100",
    });
    fireEvent.click(await screen.findByRole("row", { name: /esembe/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Entziehen" }));

    const ownDialog = await screen.findByRole("dialog");
    expect(ownDialog).toHaveTextContent("selbst aus");
    fireEvent.click(within(ownDialog).getByRole("button", { name: "Abbrechen" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    // Someone else's entry: same action, different question.
    fireEvent.click(screen.getByRole("row", { name: /Zweit/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Entziehen" }));
    const otherDialog = await screen.findByRole("dialog");
    expect(otherDialog).not.toHaveTextContent("selbst aus");
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
    expect(screen.getByRole("button", { name: "Zugriff vergeben" })).toBeEnabled();

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
    expect(screen.getByRole("button", { name: "Zugriff vergeben" })).toBeDisabled();
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
    const reason = "Nur Broadcaster und Verwalter dürfen Mitglieder ändern.";
    const grantAccess = screen.getByRole("button", { name: "Zugriff vergeben" });
    expect(grantAccess).toBeDisabled();
    expect(grantAccess.closest("span")).toHaveAttribute("title", reason);
    // A locked whole form is read as a properties list (ADR 0006 addendum),
    // not a form with disabled fields -- there is no role choice and no
    // remove action to disable, only the one reason line above the values.
    fireEvent.click(await screen.findByRole("row", { name: /Moderation/ }));
    const editor = await screen.findByRole("region", { name: "Mitglied bearbeiten: Moderation" });
    expect(within(editor).getByText(reason)).toBeInTheDocument();
    expect(within(editor).queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(within(editor).queryByRole("combobox")).not.toBeInTheDocument();
    expect(within(editor).queryByRole("button", { name: "Entziehen" })).not.toBeInTheDocument();
    expect(within(editor).getAllByText("Moderation").length).toBeGreaterThan(0);
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
    fireEvent.click(await screen.findByRole("button", { name: "Zugriff vergeben" }));
    const search = await screen.findByRole("textbox", { name: "Twitch-Name" });
    fireEvent.change(search, { target: { value: "neue-person" } });
    fireEvent.click(screen.getByRole("button", { name: "Suchen" }));
    expect(await screen.findByText("Neue Person")).toBeInTheDocument();
    const grantAccess = screen.getByRole("button", { name: "Zugriff freigeben" });
    expect(grantAccess).toHaveAccessibleName("Zugriff freigeben");
    fireEvent.click(grantAccess);
    expect(await screen.findByRole("button", { name: "Zugriff endgültig freigeben" })).toBeInTheDocument();

    act(() => {
      window.history.pushState({}, "", "/channels/kanal-b/members");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(screen.queryByText("Neue Person")).not.toBeInTheDocument());
    // The route switched to the operator's channel: even the plus button
    // that would reopen the grant editor is disabled there.
    expect(screen.getByRole("button", { name: "Zugriff vergeben" })).toBeDisabled();
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

  it("loads system state without requesting the audit log", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname.endsWith("/system")) return Promise.resolve(jsonResponse(system));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/system");

    render(<DashboardApp />);

    expect(await screen.findByRole("article", { name: "Bot-Account" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Audit-Log" })).not.toBeInTheDocument();
    expect(fetcher.mock.calls.some(([input]) => requestUrl(input).pathname.endsWith("/audit-log"))).toBe(false);
  });

  it("loads the standalone audit page", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname.endsWith("/audit-log")) return Promise.resolve(jsonResponse(audit));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/audit");

    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Audit-Log", level: 1 })).toBeInTheDocument();
    expect(fetcher.mock.calls.some(([input]) => requestUrl(input).pathname.endsWith("/audit-log"))).toBe(true);
    expect(fetcher.mock.calls.some(([input]) => requestUrl(input).pathname.endsWith("/system"))).toBe(false);
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
    window.history.replaceState({}, "", "/channels/kanal-a/audit");

    render(<DashboardApp />);

    expect(await screen.findByRole("columnheader", { name: "Zeit" })).toBeInTheDocument();
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(await screen.findByText("gelöscht")).toBeInTheDocument();
    const row = screen.getByText("Modul aktiviert").closest("tr");
    expect(row).not.toBeNull();
    expect(row).toHaveAttribute("aria-selected", "false");
    fireEvent.keyDown(row as HTMLElement, { key: "Enter" });
    expect(row).toHaveAttribute("aria-selected", "true");
    const inspector = await screen.findByRole("region", { name: "Änderungsdaten" });
    // #181 item 2: the inspector shows the display name like the table, the
    // raw id only as a tooltip -- not "user-1" as visible text.
    expect(await within(inspector).findByText("Alice")).toBeInTheDocument();
    expect(within(inspector).getByText("Alice")).toHaveAttribute("title", "user-1");
    // #181 item 3: a diff of the one changed field, not raw JSON blocks.
    expect(within(inspector).getByText("Aktiv")).toBeInTheDocument();
    expect(within(inspector).getByText("Nein")).toBeInTheDocument();
    expect(within(inspector).getByText("Ja")).toBeInTheDocument();
    expect(within(inspector).queryByText('{"enabled":false}')).not.toBeInTheDocument();
    fireEvent.click(within(inspector).getByText("Technische Details"));
    const rawBlocks = inspector.querySelectorAll("pre");
    expect(Array.from(rawBlocks).map((pre) => pre.textContent.trim())).toEqual(['{\n  "enabled": false\n}', '{\n  "enabled": true\n}']);
    const secondRow = screen.getByText("Modul deaktiviert").closest("tr");
    expect(secondRow).not.toBeNull();
    fireEvent.keyDown(secondRow as HTMLElement, { key: " " });
    expect(secondRow).toHaveAttribute("aria-selected", "true");
    expect(row).toHaveAttribute("aria-selected", "false");
  });

  it("labels a module.enabled entry's settings diff with the module's own field catalogue, not the raw key", async () => {
    // #187 review: `module.enabled` carries settings too (first enable, or a
    // re-enable resetting to defaults) -- its diff needs the module's own
    // field labels just like `*.settings_changed`, not raw keys like "leadSeconds".
    const channel = healthyChannel("kanal-a", "Alpha");
    const auditEntry = {
      auditId: "audit-1",
      actorUserId: "user-1",
      actorLogin: "alice",
      actorDisplayName: "Alice",
      createdAt: "2026-09-18T04:00:00.000Z",
      moduleId: "ads",
      action: "module.enabled",
      before: "null",
      after: JSON.stringify({ channelId: "kanal-a", moduleId: "ads", enabled: true, settings: JSON.stringify({ prewarning: true, leadSeconds: 60 }) }),
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (path.endsWith("/system")) return jsonResponse(system);
      if (path.endsWith("/audit-log")) return jsonResponse({ entries: [auditEntry], nextCursor: null });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/audit");

    render(<DashboardApp />);

    const row = await screen.findByText("Modul aktiviert: Werbung");
    fireEvent.click(row);
    const inspector = await screen.findByRole("region", { name: "Änderungsdaten" });
    expect(await within(inspector).findByText("Vorlaufzeit")).toBeInTheDocument();
    expect(within(inspector).queryByText("leadSeconds")).not.toBeInTheDocument();
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
    stubDashboardFetch((url) => {
      if (url.pathname.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
    }, [channel]);
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
    stubDashboardFetch((url) => {
      if (url.pathname.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
    }, [channel]);
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
    stubDashboardFetch((url) => {
      if (url.pathname.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
    }, [channel]);
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    await screen.findByRole("heading", { name: "Alpha", level: 1 });
    expect(screen.queryByRole("article", { name: "Vollzustimmung fehlt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Vollzustimmung erteilen" })).not.toBeInTheDocument();
  });

  it("shows no full-consent state for a fully consented channel", async () => {
    const channel = { ...healthyChannel("kanal-a", "Alpha"), broadcasterPermissions: { missingScopes: [] } };
    stubDashboardFetch((url) => {
      if (url.pathname.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
    }, [channel]);
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
    stubDashboardFetch((url) => {
      if (url.pathname.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
    }, [channel]);
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    await screen.findByRole("article", { name: "Vollzustimmung fehlt" });
    const button = await screen.findByRole("button", { name: "Vollzustimmung erteilen" });
    expect(button).toBeDisabled();
    expect(screen.getAllByText("Nur der Broadcaster kann die Vollzustimmung erteilen.").length).toBeGreaterThan(0);
  });

  it("shows full bot permissions as a healthy state with a word", async () => {
    const channel = { ...healthyChannel("kanal-a", "Alpha"), botPermissions: { missingScopes: [] } };
    stubDashboardFetch((url) => {
      if (url.pathname.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
    }, [channel]);
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
    fireEvent.click(screen.getByRole("button", { name: "Zugriff vergeben" }));
    fireEvent.change(screen.getByLabelText("Twitch-Name"), { target: { value: "neue-person" } });
    fireEvent.click(screen.getByRole("button", { name: "Suchen" }));
    await screen.findByText("Neue Person");

    const profileLink = screen.getByRole("link", { name: "twitch.tv/neue-person" });
    expect(profileLink).toHaveAttribute("target", "_blank");
    expect(profileLink.getAttribute("rel")?.split(/\s+/)).toEqual(expect.arrayContaining(["noopener", "noreferrer"]));
    expect(document.querySelector("img.member-avatar")).toHaveAttribute("src", "https://cdn.example/neue-person.png");

    fireEvent.click(screen.getByRole("button", { name: "Zugriff freigeben" }));

    const confirmation = await screen.findByRole("dialog");
    expect(confirmation).toHaveTextContent("Neue Person");
    expect(confirmation).toHaveTextContent("keinerlei Beziehung zum Kanal");
    expect(confirmation).toHaveTextContent("Mitgliederliste");
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
    fireEvent.click(screen.getByRole("button", { name: "Zugriff vergeben" }));
    fireEvent.change(screen.getByLabelText("Twitch-Name"), { target: { value: "neue-person" } });
    fireEvent.click(screen.getByRole("button", { name: "Suchen" }));
    await screen.findByText("Neue Person");
    fireEvent.click(screen.getByRole("button", { name: "Zugriff freigeben" }));
    const dialog = await screen.findByRole("dialog");
    // Anyone using only a keyboard or a screen reader must actually notice
    // the form's most important safety prompt -- Cancel starts focused, so
    // an accidental Enter never grants access by itself.
    expect(screen.getByRole("button", { name: "Abbrechen" })).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(addRequestCount).toBe(0);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Zugriff freigeben" }));
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));

    expect(addRequestCount).toBe(0);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Zugriff freigeben" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
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
    const roleGroup = screen.getByRole("radiogroup", { name: "Rolle für Alpha-Mitglied" });
    fireEvent.click(within(roleGroup).getByRole("radio", { name: /Verwalter/ }));
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "Zugriff vergeben" }));
    await screen.findByLabelText("Twitch-Name");

    fireEvent.change(screen.getByLabelText("Twitch-Name"), { target: { value: "neue-person" } });
    fireEvent.click(screen.getByRole("button", { name: "Suchen" }));
    await screen.findByText("Neuer Stand");
    fireEvent.click(screen.getByRole("button", { name: "Zugriff freigeben" }));
    fireEvent.click(await screen.findByRole("button", { name: "Zugriff endgültig freigeben" }));
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
    const roleGroup = screen.getByRole("radiogroup", { name: "Rolle für Erster Stand" });
    fireEvent.click(within(roleGroup).getByRole("radio", { name: /Verwalter/ }));
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
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
    const roleGroup = screen.getByRole("radiogroup", { name: "Rolle für Erster Stand" });
    fireEvent.click(within(roleGroup).getByRole("radio", { name: /Verwalter/ }));
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
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

  it("lists every registered module and presents clips as active by default", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    stubDashboardFetch((url) => {
      if (url.pathname.endsWith("/overview")) return jsonResponse(overview(channel));
      if (url.pathname.endsWith("/system")) return jsonResponse(system);
      if (url.pathname.endsWith("/audit-log")) return jsonResponse(audit);
      if (url.pathname === "/api/channels/kanal-a/modules") return jsonResponse({ modules: [{ id: "clips", enabled: true, settings: "{}" }] });
    }, [channel]);
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    expect(await screen.findByRole("switch", { name: "Textbefehle" })).not.toBeChecked();
    expect(screen.getByRole("switch", { name: "Clips" })).toBeChecked();
    expect(screen.queryByText("Keine Module aktiv.")).not.toBeInTheDocument();
  });

  it("uses module state folded into the channel payload without a second module request", async () => {
    const modules = [{ id: "text_commands", enabled: true, settings: "{}" }];
    const channel = { ...healthyChannel("kanal-a", "Alpha"), modules };
    const channelOverview = { ...overview(channel), modules, activeModules: [{ moduleId: "text_commands", settings: "{}" }] };
    const requested: string[] = [];
    stubDashboardFetch((url) => {
      requested.push(url.pathname);
      if (url.pathname.endsWith("/overview")) return jsonResponse(channelOverview);
    }, [channel]);
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    expect(await within(screen.getByRole("main")).findByRole("link", { name: /Textbefehle/ })).toBeInTheDocument();
    expect(requested).not.toContain("/api/channels/kanal-a/modules");
  });

  it("does not request system data on Variables or Overlays pages", async () => {
    const channel = { ...healthyChannel("kanal-a", "Alpha"), modules: [] };
    const requested: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      requested.push(url.pathname);
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot });
      if (url.pathname === "/api/channels/kanal-a/variables") return jsonResponse({ variables: [], maximum: 25 });
      if (url.pathname === "/api/channels/kanal-a/overlays") return jsonResponse({ overlays: [], maximum: 20 });
      return jsonResponse({}, 404);
    }));

    window.history.replaceState({}, "", "/channels/kanal-a/variables");
    render(<DashboardApp />);
    expect(await screen.findByRole("heading", { name: "Kanalvariablen", level: 1 })).toBeInTheDocument();
    expect(requested).not.toContain("/api/channels/kanal-a/system");

    cleanup();
    requested.length = 0;
    window.history.replaceState({}, "", "/channels/kanal-a/overlay-links");
    render(<DashboardApp />);
    expect(await screen.findByRole("heading", { name: "Overlays", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Overlays" })).toBeInTheDocument();
    await waitFor(() => { expect(window.location.pathname).toBe("/channels/kanal-a/overlays"); });
    expect(requested).not.toContain("/api/channels/kanal-a/system");
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

  it("shows the stored live duration, offline state, and unknown state in the header", async () => {
    const liveChannel = {
      ...healthyChannel("kanal-a", "Alpha"),
      streamState: "online" as const,
      streamStartedAt: relativeIso(-83 * 60 * 1000),
    };
    await showChannelOverview(liveChannel);
    expect(screen.getByText("Live · 1:23 h")).toBeInTheDocument();
    expect(document.querySelector(".dashboard-header__stream")).toHaveAttribute("data-state", "live");

    cleanup();
    await showChannelOverview(healthyChannel("kanal-a", "Alpha"));
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(document.querySelector(".dashboard-header__stream")).toHaveAttribute("data-state", "offline");

    cleanup();
    await showChannelOverview({ ...healthyChannel("kanal-a", "Alpha"), streamState: null });
    expect(screen.getByText("Status unbekannt")).toBeInTheDocument();
    expect(document.querySelector(".dashboard-header__stream")).toHaveAttribute("data-state", "unknown");
  });

  it("shows mute time remaining and the paused state beside the stream status", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      controls: {
        mute: { active: true, until: relativeIso(15 * 60 * 1000), mode: "timed" as const },
        pause: { active: true, until: null, mode: "unlimited" as const },
      },
    };
    await showChannelOverview(channel);

    expect(screen.getByText("Stumm · 15 min")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stummschaltung aufheben" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Automatische Aktionen fortsetzen" })).toBeInTheDocument();
    expect(document.querySelector(".dashboard-header__control-state .ui-icon")).toBeInTheDocument();
    expect(screen.getByText("Pausiert")).toBeInTheDocument();
  });

  it("keeps a control edit's fresher overview state against an older, slower reconnect reload", async () => {
    const pausedChannel = {
      ...healthyChannel("kanal-a", "Alpha"),
      controls: {
        mute: { active: false, until: null as string | null, mode: null as "timed" | "until_stream_end" | "unlimited" | null },
        pause: { active: true, until: null, mode: "unlimited" as const },
      },
    };
    const resumedControls = { ...pausedChannel.controls, pause: { active: false, until: null, mode: null } };
    let resolveReconnectReload: ((response: Response) => void) | undefined;
    const reconnectReload = new Promise<Response>((resolve) => { resolveReconnectReload = resolve; });
    let overviewRequestCount = 0;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [pausedChannel], bot: pausedChannel.bot }));
      if (url.pathname === "/api/channels/kanal-a/modules") return Promise.resolve(jsonResponse({ modules: [] }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (url.pathname === "/api/channels/kanal-a/controls/pause" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ controls: resumedControls }));
      }
      if (url.pathname === "/api/channels/kanal-a/overview") {
        overviewRequestCount += 1;
        // 1st: initial mount load. 2nd: the reconnect reload, held open so it
        // resolves after the control edit's own refresh below (3rd). 3rd: the
        // control edit's refresh, resolved immediately with the new state.
        if (overviewRequestCount === 1) return Promise.resolve(jsonResponse(overview(pausedChannel)));
        if (overviewRequestCount === 2) return reconnectReload;
        return Promise.resolve(jsonResponse(overview({ ...pausedChannel, controls: resumedControls })));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/overview");

    render(<DashboardApp />);
    await screen.findByRole("button", { name: "Automatische Aktionen fortsetzen" });

    act(() => {
      window.dispatchEvent(new CustomEvent("brobot:realtime-connected", { detail: { channelId: "kanal-a" } }));
    });
    await waitFor(() => { expect(overviewRequestCount).toBe(2); });

    fireEvent.click(screen.getByRole("button", { name: "Automatische Aktionen fortsetzen" }));
    await screen.findByRole("button", { name: "Automatische Aktionen pausieren" });
    await waitFor(() => { expect(overviewRequestCount).toBe(3); });

    await act(async () => {
      resolveReconnectReload?.(jsonResponse(overview(pausedChannel)));
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Automatische Aktionen pausieren" })).toBeInTheDocument();
  });

  it("keeps a control edit's fresher overview state against a slower initial overview load", async () => {
    const pausedChannel = {
      ...healthyChannel("kanal-a", "Alpha"),
      controls: {
        mute: { active: false, until: null as string | null, mode: null as "timed" | "until_stream_end" | "unlimited" | null },
        pause: { active: true, until: null, mode: "unlimited" as const },
      },
    };
    const resumedControls = { ...pausedChannel.controls, pause: { active: false, until: null, mode: null } };
    let resolveInitialLoad: ((response: Response) => void) | undefined;
    const initialLoad = new Promise<Response>((resolve) => { resolveInitialLoad = resolve; });
    let overviewRequestCount = 0;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [pausedChannel], bot: pausedChannel.bot }));
      if (url.pathname === "/api/channels/kanal-a/modules") return Promise.resolve(jsonResponse({ modules: [] }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (url.pathname === "/api/channels/kanal-a/controls/pause" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ controls: resumedControls }));
      }
      if (url.pathname === "/api/channels/kanal-a/overview") {
        overviewRequestCount += 1;
        // 1st: the initial mount load, held open so it resolves after the
        // control edit's own refresh below (2nd), which resolves immediately
        // with the new state.
        if (overviewRequestCount === 1) return initialLoad;
        return Promise.resolve(jsonResponse(overview({ ...pausedChannel, controls: resumedControls })));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/overview");

    render(<DashboardApp />);
    // The pause control comes from the channel list, so it's available
    // before the (held-back) initial overview fetch resolves.
    fireEvent.click(await screen.findByRole("button", { name: "Automatische Aktionen fortsetzen" }));
    await screen.findByRole("button", { name: "Automatische Aktionen pausieren" });
    await waitFor(() => { expect(overviewRequestCount).toBe(2); });

    // The stale initial response arrives last and must not overwrite the
    // control edit's newer state.
    await act(async () => {
      resolveInitialLoad?.(jsonResponse(overview(pausedChannel)));
      await Promise.resolve();
    });

    expect(screen.getByRole("button", { name: "Automatische Aktionen pausieren" })).toBeInTheDocument();
  });

  it("shows an offline stream-end control as pending and keeps its disable action available", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      controls: {
        mute: { active: false, pending: true, until: null, mode: "until_stream_end" as const },
        pause: { active: false, until: null, mode: null },
      },
    };
    await showChannelOverview(channel);

    expect(screen.getByText("Gilt ab dem nächsten Stream")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stummschaltung aufheben" })).toBeInTheDocument();
  });

  it("reloads channel state on visibility change and every three minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T09:00:00.000Z"));
    const channel = healthyChannel("kanal-a", "Alpha");
    let channelCalls = 0;
    let overviewCalls = 0;
    let modulesCalls = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") {
        channelCalls += 1;
        return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      }
      if (path === "/api/channels/kanal-a/overview") {
        overviewCalls += 1;
        return Promise.resolve(jsonResponse(overview(channel)));
      }
      if (path === "/api/channels/kanal-a/modules") {
        modulesCalls += 1;
        return Promise.resolve(jsonResponse({ modules: [] }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/overview");

    render(<DashboardApp />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect([channelCalls, overviewCalls, modulesCalls]).toEqual([1, 1, 1]);

    fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect([channelCalls, overviewCalls, modulesCalls]).toEqual([2, 2, 2]);

    await act(async () => { await vi.advanceTimersByTimeAsync(3 * 60 * 1000); });
    expect([channelCalls, overviewCalls, modulesCalls]).toEqual([3, 3, 3]);
  });

  it("shows stale token expiry as neutral, reloads, then marks server-confirmed expiry red", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T09:00:00.000Z"));
    const freshExpiry = "2026-09-23T09:00:01.000Z";
    const freshChannel = {
      ...healthyChannel("kanal-a", "Alpha"),
      tokens: { ...healthyChannel("kanal-a", "Alpha").tokens, botExpiresAt: freshExpiry, loginExpiresAt: freshExpiry },
    };
    const expiredChannel = {
      ...freshChannel,
      tokens: { ...freshChannel.tokens, botExpiresAt: "2026-09-23T09:00:00.000Z", loginExpiresAt: "2026-09-23T09:00:00.000Z" },
    };
    let channelCalls = 0;
    let overviewCalls = 0;
    let resolveChannelReload: ((response: Response) => void) | undefined;
    let resolveOverviewReload: ((response: Response) => void) | undefined;
    const pendingChannelReload = new Promise<Response>((resolve) => { resolveChannelReload = resolve; });
    const pendingOverviewReload = new Promise<Response>((resolve) => { resolveOverviewReload = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") {
        channelCalls += 1;
        return channelCalls === 1
          ? Promise.resolve(jsonResponse({ channels: [freshChannel], bot: freshChannel.bot }))
          : pendingChannelReload;
      }
      if (path === "/api/channels/kanal-a/overview") {
        overviewCalls += 1;
        return overviewCalls === 1
          ? Promise.resolve(jsonResponse(overview(freshChannel)))
          : pendingOverviewReload;
      }
      if (path === "/api/channels/kanal-a/modules") return Promise.resolve(jsonResponse({ modules: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/overview");

    render(<DashboardApp />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(channelCalls).toBe(1);
    expect(overviewCalls).toBe(1);
    expect(screen.getByRole("combobox", { name: "Kanal auswählen" })).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getAllByText("wird aktualisiert").length).toBeGreaterThanOrEqual(1);
    expect(channelCalls).toBe(2);
    expect(overviewCalls).toBe(2);

    await act(async () => {
      resolveChannelReload?.(jsonResponse({ channels: [expiredChannel], bot: expiredChannel.bot }));
      resolveOverviewReload?.(jsonResponse(overview(expiredChannel)));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getAllByText("Abgelaufen").length).toBeGreaterThanOrEqual(1);
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
        return jsonResponse({ modules: [
          { id: "text_commands", enabled: modulesCalls > 1, settings: "{}" },
          { id: "ads", enabled: true, settings: "{}" },
        ] });
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
    fireEvent.click(await screen.findByRole("switch", { name: "Shoutout" }));
    await waitFor(() => { expect(modulesCalls).toBe(3); });
    expect(await screen.findByRole("switch", { name: "Shoutout" })).toBeChecked();

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
    expect(screen.getByRole("switch", { name: "Shoutout" })).toBeChecked();
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
        return jsonResponse({ modules: [
          { id: "text_commands", enabled: modulesCalls > 1, settings: "{}" },
          { id: "ads", enabled: true, settings: "{}" },
          { id: "raid", enabled: true, settings: "{}" },
          { id: "clips", enabled: true, settings: "{}" },
        ] });
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
    expect(await screen.findByRole("button", { name: "Clip erstellen" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Shoutout senden" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Werbung jetzt/ })).toBeInTheDocument();

    // Warnings/errors feed needs no interaction to show.
    expect(await screen.findByText("Werbeeinblendung nicht gestartet: Twitch-Abklingzeit aktiv")).toBeInTheDocument();
  });

  it("uses the overview stream state for Spotlight actions", async () => {
    const channel = { ...healthyChannel("kanal-a", "Alpha"), streamState: "offline" as const };
    const freshOverview = { ...overview(channel), streamState: "online" as const, streamStartedAt: "2026-09-23T11:30:00.000Z" };
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/channels/kanal-a/overview") return Promise.resolve(jsonResponse(freshOverview));
      if (url.pathname === "/api/channels/kanal-a/modules" && init?.method === undefined) {
        return Promise.resolve(jsonResponse({ modules: [{ id: "clips", enabled: true, settings: "{}" }] }));
      }
      if (url.pathname === "/api/channels/kanal-a/modules/text_commands/commands") return Promise.resolve(jsonResponse({ commands: [] }));
      if (url.pathname === "/api/channels/kanal-a/members") return Promise.resolve(jsonResponse({ members: [], broadcasterCount: 0, viewerUserId: "user-1", nextCursor: null }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (url.pathname === "/api/channels/kanal-a/clips" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ clipId: null, editUrl: null }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/overview");

    const { container } = render(<DashboardApp />);

    await waitFor(() => {
      expect(container.querySelector(".dashboard-header__stream")).toHaveAttribute("data-state", "live");
    });
    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "clip" } });
    fireEvent.click(await within(screen.getByRole("dialog")).findByText("Clip erstellen"));

    await waitFor(() => {
      expect(fetcher.mock.calls.some(([input, init]) =>
        requestUrl(input).pathname === "/api/channels/kanal-a/clips" && init?.method === "POST")).toBe(true);
    });
  });

  it("updates stored stream status from the panel realtime socket", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      modules: [],
      controls: {
        mute: { active: false, until: null, mode: null },
        pause: { active: false, pending: true, until: null, mode: "until_stream_end" as const },
      },
    };
    vi.stubGlobal("WebSocket", TestWebSocket);
    stubDashboardFetch((url) => {
      if (url.pathname === "/api/channels/kanal-a/system") return jsonResponse(system);
    }, [channel]);
    window.history.replaceState({}, "", "/channels/kanal-a/system");

    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "System", level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(TestWebSocket.instances).toHaveLength(1));
    const socket = TestWebSocket.instances[0];
    if (socket === undefined) throw new Error("Realtime-Socket fehlt");
    socket.open();
    const channelDataAge = document.querySelector(".dashboard-header__status .data-age:not(.dashboard-header__stream-age)")?.textContent;
    const changedAt = relativeIso(1_000);
    socket.receive(JSON.stringify({
      version: 1,
      id: "stream-state-panel-1",
      createdAt: new Date().toISOString(),
      channelId: "kanal-a",
      type: "stream.state.changed",
      payload: {
        state: "online",
        startedAt: relativeIso(-60 * 60 * 1000),
        changedAt,
        checkedAt: changedAt,
        controls: {
          mute: { active: false, until: null, mode: null },
          pause: { active: true, until: null, mode: "until_stream_end" },
        },
      },
    }));

    expect(await screen.findByText(/^Live ·/)).toBeInTheDocument();
    expect(document.querySelector(".dashboard-header__stream")).toHaveAttribute("data-state", "live");
    expect(screen.getByText(/^Zustand geprüft/)).toBeInTheDocument();
    expect(screen.getByText(/^Pausiert ·/)).toBeInTheDocument();
    expect(screen.queryByText("Gilt ab dem nächsten Stream")).not.toBeInTheDocument();
    expect(document.querySelector(".dashboard-header__status .data-age:not(.dashboard-header__stream-age)")?.textContent).toBe(channelDataAge);

    socket.receive(JSON.stringify({
      version: 1,
      id: "stream-state-panel-old",
      createdAt: new Date().toISOString(),
      channelId: "kanal-a",
      type: "stream.state.changed",
      payload: { state: "offline", startedAt: null, changedAt: relativeIso(-1_000), checkedAt: relativeIso(-1_000) },
    }));
    expect(document.querySelector(".dashboard-header__stream")).toHaveAttribute("data-state", "live");
  });

  it("keeps a newer realtime stream update when an older channels refresh finishes later", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      streamStateChangedAt: relativeIso(-10_000),
      streamStateCheckedAt: relativeIso(-10_000),
      controls: {
        mute: { active: false, until: null, mode: null },
        pause: { active: false, pending: true, until: null, mode: "until_stream_end" as const },
      },
    };
    let channelsCalls = 0;
    let resolveDelayedChannels: ((response: Response) => void) | undefined;
    const delayedChannels = new Promise<Response>((resolve) => { resolveDelayedChannels = resolve; });
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") {
        channelsCalls += 1;
        return channelsCalls === 1
          ? Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }))
          : delayedChannels;
      }
      if (path === "/api/channels/kanal-a/overview") return Promise.resolve(jsonResponse(overview(channel)));
      if (path === "/api/channels/kanal-a/modules") return Promise.resolve(jsonResponse({ modules: [] }));
      if (path === "/api/channels/kanal-a/events") return Promise.resolve(jsonResponse({ entries: [], nextCursor: null }));
      return Promise.resolve(jsonResponse({}, 404));
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/overview");

    render(<DashboardApp />);
    expect(await screen.findByRole("heading", { name: "Alpha", level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(TestWebSocket.instances).toHaveLength(1));
    const socket = TestWebSocket.instances[0];
    if (socket === undefined) throw new Error("Realtime-Socket fehlt");
    socket.open();
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(channelsCalls).toBe(2));

    const changedAt = relativeIso(1_000);
    socket.receive(JSON.stringify({
      version: 1,
      id: "stream-state-newer-than-http",
      createdAt: new Date().toISOString(),
      channelId: "kanal-a",
      type: "stream.state.changed",
      payload: {
        state: "online",
        startedAt: relativeIso(-60 * 60 * 1000),
        changedAt,
        checkedAt: changedAt,
        controls: {
          mute: { active: false, until: null, mode: null },
          pause: { active: true, until: null, mode: "until_stream_end" },
        },
      },
    }));
    expect(await screen.findByText(/^Live ·/)).toBeInTheDocument();

    await act(async () => {
      resolveDelayedChannels?.(jsonResponse({ channels: [channel], bot: channel.bot }));
      await delayedChannels;
    });

    expect(document.querySelector(".dashboard-header__stream")).toHaveAttribute("data-state", "live");
    expect(screen.getByText(/^Pausiert ·/)).toBeInTheDocument();
    expect(screen.queryByText("Gilt ab dem nächsten Stream")).not.toBeInTheDocument();
  });

  it("keeps a newer realtime stream and control update when an older overview finishes later", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      streamStateChangedAt: relativeIso(-10_000),
      streamStateCheckedAt: relativeIso(-10_000),
    };
    let resolveOverview: ((response: Response) => void) | undefined;
    const delayedOverview = new Promise<Response>((resolve) => { resolveOverview = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (path === "/api/channels/kanal-a/overview") return delayedOverview;
      if (path === "/api/channels/kanal-a/modules") return Promise.resolve(jsonResponse({ modules: [] }));
      if (path === "/api/channels/kanal-a/events") return Promise.resolve(jsonResponse({ entries: [], nextCursor: null }));
      return Promise.resolve(jsonResponse({}, 404));
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/overview");

    render(<DashboardApp />);
    expect(await screen.findByText("Alpha — kanal-a")).toBeInTheDocument();
    const changedAt = relativeIso(1_000);
    window.dispatchEvent(new CustomEvent("brobot:realtime", {
      detail: {
        version: 1,
        id: "stream-state-newer-than-overview",
        createdAt: new Date().toISOString(),
        channelId: "kanal-a",
        type: "stream.state.changed",
        payload: {
          state: "online",
          startedAt: relativeIso(-60 * 60 * 1000),
          changedAt,
          checkedAt: changedAt,
          controls: {
            mute: { active: false, until: null, mode: null },
            pause: { active: true, until: null, mode: "until_stream_end" },
          },
        },
      },
    }));
    expect(await screen.findByText(/^Pausiert ·/)).toBeInTheDocument();

    await act(async () => {
      resolveOverview?.(jsonResponse(overview(channel)));
      await delayedOverview;
    });

    await waitFor(() => expect(document.querySelector(".dashboard-header__stream")).toHaveAttribute("data-state", "live"));
    expect(screen.getByText(/^Pausiert ·/)).toBeInTheDocument();
    expect(screen.queryByText("Gilt ab dem nächsten Stream")).not.toBeInTheDocument();
  });

  it("reconciles the channel overview when its realtime socket connects", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      streamStateCheckedAt: "2026-09-24T12:00:00.000Z",
      streamStateChangedAt: "2026-09-24T11:00:00.000Z",
    };
    vi.stubGlobal("WebSocket", TestWebSocket);
    const fetcher = stubDashboardFetch((url) => {
      if (url.pathname.endsWith("/overview")) return jsonResponse(overview(channel));
      if (url.pathname.endsWith("/modules")) return jsonResponse({ modules: [] });
      if (url.pathname.endsWith("/events")) return jsonResponse({ entries: [], nextCursor: null });
    }, [channel]);
    window.history.replaceState({}, "", "/channels/kanal-a/overview");

    render(<DashboardApp />);

    await screen.findByRole("heading", { name: "Alpha", level: 1 });
    await waitFor(() => expect(TestWebSocket.instances).toHaveLength(1));
    const socket = TestWebSocket.instances[0];
    if (socket === undefined) throw new Error("Realtime-Socket fehlt");
    socket.open();

    await waitFor(() => {
      expect(fetcher.mock.calls.filter(([input]) => requestUrl(input).pathname.endsWith("/overview"))).toHaveLength(2);
    });
  });

  it("closes an open Spotlight when the route changes channels, then loads the new channel's results", async () => {
    const alpha = healthyChannel("kanal-a", "Alpha");
    const beta = healthyChannel("kanal-b", "Beta");
    const command = (channelId: string, name: string) => ({
      channelId,
      name,
      text: "Test",
      kind: "text",
      enabled: true,
      minimumTier: "everyone",
      cooldownSeconds: 5,
      lastUsedAt: null,
      createdAt: "2026-09-19T00:00:00.000Z",
      updatedAt: "2026-09-19T00:00:00.000Z",
    });
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [alpha, beta], bot: alpha.bot });
      if (path.endsWith("/system")) return jsonResponse(system);
      if (path.endsWith("/modules")) return jsonResponse({ modules: [] });
      if (path.endsWith("/modules/text_commands/commands")) {
        const channelId = path.includes("kanal-b") ? "kanal-b" : "kanal-a";
        return jsonResponse({ commands: [command(channelId, channelId === "kanal-a" ? "alphaonly" : "betaonly")] });
      }
      if (path.endsWith("/variables")) return jsonResponse({ variables: [], count: 0, maximum: 20 });
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/system");

    render(<DashboardApp />);
    await screen.findByRole("heading", { name: "System", level: 1 });
    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    await screen.findByRole("dialog");
    expect(await screen.findByText("!alphaonly")).toBeInTheDocument();

    act(() => {
      window.history.pushState({}, "", "/channels/kanal-b/system");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => {
      expect(fetcher.mock.calls.some(([input]) => requestUrl(input).pathname === "/api/channels/kanal-b/system")).toBe(true);
    });
    await waitFor(() => { expect(screen.queryByRole("dialog")).not.toBeInTheDocument(); });

    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    await screen.findByRole("dialog");
    expect(await screen.findByText("!betaonly")).toBeInTheDocument();
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
      { path: "/channels/kanal-a/audit", heading: "Audit-Log", currentLink: "Audit-Log" },
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
      for (const label of ["Ereignisse", "Kanal", "System", "Mitglieder", "Audit-Log"]) {
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

  it.each([false, true])("keeps rendered sidebar and Spotlight page ids in sync (platform admin: %s)", async (platformAdmin) => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel], bot: channel.bot, platformAdmin });
      if (path.endsWith("/system")) return jsonResponse(system);
      if (path.endsWith("/modules")) return jsonResponse({ modules: [] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/system");

    render(<DashboardApp />);
    await screen.findByRole("heading", { name: "System", level: 1 });
    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    const dialog = await screen.findByRole("dialog");

    const sidebar = screen.getByRole("navigation", { name: "Hauptnavigation" });
    const sidebarPageIds = Array.from(sidebar.querySelectorAll<HTMLElement>("[data-nav-page-id]"), (entry) => entry.dataset.navPageId)
      .filter((id): id is string => id !== undefined);
    const spotlightPageIds = Array.from(dialog.querySelectorAll<HTMLElement>("[data-spotlight-item-id^='page:']"), (action) => action.dataset.spotlightItemId?.slice("page:".length))
      .filter((id): id is string => id !== undefined);
    expect(spotlightPageIds).toEqual(sidebarPageIds);

    fireEvent.keyDown(document.body, { key: "Escape" });
  });

  it("does not retain a variable Spotlight selection when guarded navigation is canceled", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const activeModuleOverview = { ...overview(channel), activeModules: [{ moduleId: "text_commands", settings: "{}" }] };
    const command = {
      channelId: "kanal-a", name: "hallo", text: "Hallo {user}", kind: "text", enabled: true,
      minimumTier: "everyone", cooldownSeconds: 5, aliases: [], userCooldownSeconds: 15,
      streamCondition: "online", responseType: "reply", variableAction: null, useCount: 0,
      lastUsedAt: null, createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z", revision: 1,
    };
    const variable = {
      channelId: "kanal-a", name: "counter", value: 5, description: "", resetOnStreamStart: false,
      createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z", usages: [],
    };
    stubDashboardFetch((url) => {
      if (url.pathname.endsWith("/overview")) return jsonResponse(activeModuleOverview);
      if (url.pathname.endsWith("/modules")) return jsonResponse({ modules: [{ id: "text_commands", enabled: true, settings: "{}" }] });
      if (url.pathname.endsWith("/modules/text_commands/commands")) return jsonResponse({ commands: [command], variables: [] });
      if (url.pathname.endsWith("/variables")) return jsonResponse({ variables: [variable], count: 1, maximum: 25 });
    }, [channel]);
    window.history.replaceState({}, "", "/channels/kanal-a/modules/text_commands");

    render(<DashboardApp />);
    fireEvent.click(await screen.findByRole("row", { name: /!hallo/i }));
    const response = await screen.findByRole("textbox", { name: "Antwort" });
    fireEvent.change(response, { target: { value: "Nicht gespeicherter Entwurf" } });

    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByPlaceholderText("Suchen oder Aktion ausführen …"), { target: { value: "counter" } });
    fireEvent.click(await screen.findByText("{var.counter}"));

    const firstGuard = await screen.findByRole("dialog", { name: "Ungespeicherte Änderungen" });
    fireEvent.click(within(firstGuard).getByRole("button", { name: "Weiter bearbeiten" }));
    expect(window.location.pathname).toBe("/channels/kanal-a/modules/text_commands");
    expect(screen.getByRole("textbox", { name: "Antwort" })).toHaveValue("Nicht gespeicherter Entwurf");

    const navigation = screen.getByRole("navigation", { name: "Hauptnavigation" });
    fireEvent.click(within(navigation).getByRole("link", { name: "Variablen" }));
    const secondGuard = await screen.findByRole("dialog", { name: "Ungespeicherte Änderungen" });
    fireEvent.click(within(secondGuard).getByRole("button", { name: "Verwerfen und wechseln" }));

    expect(await screen.findByRole("heading", { name: "Kanalvariablen", level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole("row", { name: /counter/i })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
  });

  it("keeps a successful Spotlight variable selection scoped to its target channel", async () => {
    const alpha = healthyChannel("kanal-a", "Alpha");
    const beta = healthyChannel("kanal-b", "Beta");
    const makeVariable = (channelId: string) => ({
      channelId, name: "counter", value: 5, description: "", resetOnStreamStart: false,
      createdAt: "2026-09-19T00:00:00.000Z", updatedAt: "2026-09-19T00:00:00.000Z", usages: [],
    });
    let alphaVariableRequests = 0;
    stubDashboardFetch((url) => {
      if (url.pathname.endsWith("/overview")) return jsonResponse(overview(url.pathname.includes("kanal-b") ? beta : alpha));
      if (url.pathname.endsWith("/modules")) return jsonResponse({ modules: [] });
      if (url.pathname === "/api/channels/kanal-a/variables") {
        alphaVariableRequests += 1;
        return alphaVariableRequests === 1
          ? jsonResponse({ variables: [makeVariable("kanal-a")], count: 1, maximum: 25 })
          : new Promise<Response>(() => {});
      }
      if (url.pathname === "/api/channels/kanal-b/variables") {
        return jsonResponse({ variables: [makeVariable("kanal-b")], count: 1, maximum: 25 });
      }
      if (url.pathname.endsWith("/commands")) return jsonResponse({ commands: [] });
    }, [alpha, beta]);
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);
    await screen.findByRole("heading", { name: "Alpha", level: 1 });
    fireEvent.keyDown(document.body, { key: "k", metaKey: true });
    await screen.findByRole("dialog");
    fireEvent.change(screen.getByPlaceholderText("Suchen oder Aktion ausführen …"), { target: { value: "counter" } });
    fireEvent.click(await screen.findByText("{var.counter}"));
    await waitFor(() => expect(alphaVariableRequests).toBe(2));

    const channelSelect = screen.getByRole("combobox", { name: "Kanal auswählen" });
    fireEvent.click(channelSelect);
    fireEvent.click(screen.getByRole("option", { name: "Beta — kanal-b", hidden: true }));
    await waitFor(() => expect(window.location.pathname).toBe("/channels/kanal-b"));
    const navigation = screen.getByRole("navigation", { name: "Hauptnavigation" });
    fireEvent.click(within(navigation).getByRole("link", { name: "Variablen" }));

    expect(await screen.findByRole("row", { name: /counter/i })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Name" })).not.toBeInTheDocument();
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
    stubDashboardFetch((url) => {
      if (url.pathname === "/api/channels/kanal-a/overview") return jsonResponse(overview(channel));
      if (url.pathname === "/api/channels/kanal-a/modules") return jsonResponse({ modules: [{ id: "text_commands", enabled: false, settings: "{}" }] });
    }, [channel]);
    window.history.replaceState({}, "", "/channels/kanal-a/modules/text_commands");

    render(<DashboardApp />);

    expect(await screen.findByText("Das Modul „Textbefehle“ ist ausgeschaltet.")).toBeInTheDocument();
  });

  it("reports an unknown module understandably on its subpage", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    stubDashboardFetch((url) => {
      if (url.pathname === "/api/channels/kanal-a/overview") return jsonResponse(overview(channel));
    }, [channel]);
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
    stubDashboardFetch((url) => {
      if (url.pathname === "/api/channels/kanal-a/overview") return jsonResponse(overview(channel));
      if (url.pathname === "/api/channels/kanal-a/modules") return jsonResponse({ modules: [{ id: "channel_events", enabled: true, mandatory: true, settings: "{}" }] });
    }, [channel]);
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
    stubDashboardFetch((url) => {
      if (url.pathname.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
    }, [channel]);
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
      stubDashboardFetch((url) => {
      if (url.pathname.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
    }, [channel]);
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
    stubDashboardFetch((url) => {
      if (url.pathname.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
    }, [channel]);
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
    stubDashboardFetch((url) => {
      if (url.pathname.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
    }, [channel]);
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
    stubDashboardFetch((url) => {
      if (url.pathname.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
    }, [channel, secondChannel]);
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
    stubDashboardFetch((url) => {
      if (url.pathname.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
    }, [channel, secondChannel]);
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
    stubDashboardFetch((url) => {
      if (url.pathname.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
    }, [channel, secondChannel]);
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
    stubDashboardFetch((url) => {
      if (url.pathname.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
    }, [channel, secondChannel]);
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
      if (url.pathname === "/api/channels/kanal-a/audit-log") return alphaAudit;
      if (url.pathname === "/api/channels/kanal-b/audit-log") return Promise.resolve(jsonResponse({
        entries: [{ auditId: "audit-b-1", actorUserId: "user-1", createdAt: "2026-09-18T04:00:00.000Z", action: "beta-erster", before: "{}", after: "{}" }],
        nextCursor: null,
      }));
      return Promise.resolve(jsonResponse({}, 404));
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/audit");

    render(<DashboardApp />);
    await waitFor(() => expect(resolveAlphaAudit).toBeTypeOf("function"));

    act(() => {
      window.history.pushState({}, "", "/channels/kanal-b/audit");
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
    window.history.replaceState({}, "", "/channels/kanal-a/audit");

    render(<DashboardApp />);

    const list = await screen.findByRole("region", { name: "Audit-Log" });
    expect(screen.queryByRole("region", { name: "Änderungsdaten" })).not.toBeInTheDocument();

    const row = (await screen.findByText("Modul aktiviert")).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(row as HTMLElement);

    expect(list).toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Änderungsdaten" })).toBeInTheDocument();
  });

  it("reloads audit data when returning from the system page", async () => {
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
    window.history.replaceState({}, "", "/channels/kanal-a/audit");

    render(<DashboardApp />);

    const row = (await screen.findByText("Modul aktiviert")).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(row as HTMLElement);
    expect(await screen.findByRole("region", { name: "Änderungsdaten" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("link", { name: "System" }));
    await screen.findByRole("heading", { name: "System", level: 1 });
    expect(auditRequests).toBe(1);
    fireEvent.click(await screen.findByRole("link", { name: "Audit-Log" }));
    await waitFor(() => expect(auditRequests).toBe(2));
    resolveReload?.(jsonResponse({ entries: [entry], nextCursor: null }));

    const restoredRow = (await screen.findAllByRole("row", { name: /Modul aktiviert/ }))[0];
    expect(restoredRow).toBeDefined();
    expect(restoredRow).toHaveAttribute("aria-selected", "false");
    expect(screen.queryByRole("region", { name: "Änderungsdaten" })).not.toBeInTheDocument();
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
    stubDashboardFetch((url) => {
      if (url.pathname.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
    }, [channel]);
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
    window.history.replaceState({}, "", "/channels/kanal-a/audit");

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
    stubDashboardFetch((url) => {
      if (url.pathname === "/api/channels/kanal-a/overview") return jsonResponse(overview(channel));
      if (url.pathname === "/api/channels/kanal-a/modules") return jsonResponse({ modules: [] });
    }, [channel]);
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
