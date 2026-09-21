import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
  role: "verwalter",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: relativeIso(0) },
  moderator,
  // Ohne Chat-Abo empfaengt der Kanal keine Ereignisse; ein gesunder Kanal
  // hat deshalb eines. Fehlt es, ist das eine Warnung, kein Normalzustand.
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
 * Stellt Kanal- und Mitgliederantworten und öffnet die Mitgliederseite. Die
 * drei Zugriffstests unterscheiden sich nur in den Mitgliedsdaten; alles
 * andere ist Gerüst.
 */
const zeigeMitglieder = async (mitglieder: {
  members: unknown[];
  broadcasterCount: number;
  viewerUserId: string;
}): Promise<void> => {
  const channel = healthyChannel("kanal-a", "Alpha");
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const path = requestUrl(input).pathname;
    if (path === "/api/channels") return jsonResponse({ channels: [channel] });
    if (path.endsWith("/members")) return jsonResponse({ ...mitglieder, nextCursor: null });
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

describe("Dashboard-Grundgerüst", () => {
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
  });

  it("erkennt die kanalgebundene Systemroute", () => {
    expect(parseDashboardRoute("/channels/kanal-a/system")).toEqual({
      kind: "channel",
      channelId: "kanal-a",
      section: "system",
    });
  });

  it("erkennt die kanalgebundene Mitgliederroute", () => {
    expect(parseDashboardRoute("/channels/kanal-a/members")).toEqual({
      kind: "channel",
      channelId: "kanal-a",
      section: "members",
    });
  });

  it("erkennt die kanalgebundene Ereignisroute", () => {
    expect(parseDashboardRoute("/channels/kanal-a/events")).toEqual({
      kind: "channel",
      channelId: "kanal-a",
      section: "events",
    });
  });

  it("erkennt die Unterseite eines kanalgebundenen Moduls", () => {
    expect(parseDashboardRoute("/channels/kanal-a/modules/textbefehle")).toEqual({
      kind: "module",
      channelId: "kanal-a",
      moduleId: "textbefehle",
    });
  });

  it("behält unbekannte Modul-IDs als Modulroute für die Detailseite", () => {
    expect(parseDashboardRoute("/channels/kanal-a/modules/unbekannt")).toEqual({
      kind: "module",
      channelId: "kanal-a",
      moduleId: "unbekannt",
    });
  });

  it("verwirft eine ungültig codierte Modulroute", () => {
    expect(parseDashboardRoute("/channels/kanal-a/modules/%ZZ")).toEqual({ kind: "overview" });
  });

  it("kodiert Kanal- und Modul-ID in der Modulroute", () => {
    expect(dashboardRoutePath({ kind: "module", channelId: "kanal/a", moduleId: "text befehle" }))
      .toBe("/channels/kanal%2Fa/modules/text%20befehle");
  });

  it("zeigt Ereignisse mit Modul, Code, Detail und Akteur", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path.endsWith("/events")) return jsonResponse({
        entries: [{
          eventId: "event-1",
          createdAt: "2026-09-18T04:00:00.000Z",
          moduleId: "raid",
          code: "shoutout.unterdrueckt",
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
          code: "host.chat.gesendet",
          detail: "{}",
          actorUserId: "user-1",
          actorLogin: "alice",
          actorDisplayName: null,
        }, {
          eventId: "event-4",
          createdAt: "2026-09-18T04:03:00.000Z",
          moduleId: "chat",
          code: "host.aktion.fehler",
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
    expect(screen.getByText("Raid-Shoutout")).toBeInTheDocument();
    expect(screen.getByText("Automatisch")).toBeInTheDocument();
    expect(screen.getByText("plugin.anderes")).toHaveClass("mono");
    expect(screen.getByText("user-2")).toHaveClass("mono");
    const sentRow = screen.getByText("Chat-Nachricht gesendet").closest("tr");
    const failedRow = screen.getByText("Aktion fehlgeschlagen").closest("tr");
    expect(sentRow?.querySelector(".event-chip[data-ton='info']")).toHaveTextContent("Info");
    expect(within(sentRow as HTMLElement).getByText("Info")).toBeInTheDocument();
    expect(failedRow?.querySelector(".event-chip[data-ton='fehler']")).toHaveTextContent("Fehler");
    expect(within(failedRow as HTMLElement).getByText("Fehler")).toBeInTheDocument();
    const eventRow = screen.getByText("Shoutout unterdrückt").closest("tr");
    const unknownEventRow = screen.getByText("plugin.anderes").closest("tr");
    expect(eventRow).not.toBeNull();
    expect(unknownEventRow).not.toBeNull();
    fireEvent.keyDown(unknownEventRow as HTMLElement, { key: " " });
    expect(unknownEventRow).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByText("Unbekannt")).toHaveLength(2);
    expect(screen.getByText("kein-json")).toBeInTheDocument();
    fireEvent.keyDown(eventRow as HTMLElement, { key: "Enter" });
    expect(eventRow).toHaveAttribute("aria-selected", "true");
    expect(unknownEventRow).toHaveAttribute("aria-selected", "false");
    expect(screen.getByText("shoutout.unterdrueckt")).toBeInTheDocument();
    expect(screen.getByText(/"grund": "raid_erkannt"/)).toBeInTheDocument();
  });

  it("zeigt das Ereignis-Chip-Paar mit Familie, Stufe, Zahl und Zeit-Tooltip", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path.endsWith("/events")) return jsonResponse({
        entries: [
          { eventId: "gift", createdAt: "2026-09-18T04:00:00.000Z", moduleId: "kanalereignisse", code: "kanalereignisse.chat.community_gift", detail: '{"anzahl":5}', actorUserId: null },
          { eventId: "raid", createdAt: "2026-09-18T04:01:00.000Z", moduleId: "kanalereignisse", code: "kanalereignisse.raid.eingehend", detail: '{"zuschauer":21}', actorUserId: null },
          { eventId: "untimeout", createdAt: "2026-09-18T04:02:00.000Z", moduleId: "kanalereignisse", code: "kanalereignisse.moderation.untimeout", detail: "{}", actorUserId: null },
          { eventId: "sent", createdAt: "2026-09-18T04:03:00.000Z", moduleId: "textbefehle", code: "host.chat.gesendet", detail: "{}", actorUserId: null },
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
    expect(giftRow.querySelector(".event-chip[data-familie='gemeinschaft'][data-stufe='voll']")).toHaveTextContent("Gift");
    expect([...raidRow.querySelectorAll(".event-chip")].map((chip) => chip.textContent)).toEqual(["21", "Raid"]);
    expect(raidRow.querySelector(".event-chip[data-familie='raid'][data-stufe='voll']")).toHaveTextContent("Raid");
    expect(untimeoutRow.querySelector(".event-chip[data-familie='moderation'][data-stufe='gezeichnet']")).toHaveTextContent("Entsperrt");
    expect(sentRow.querySelector(".event-chip[data-ton='info'][data-stufe='gezeichnet']")).toHaveTextContent("Info");
    expect(sentRow.querySelector(".event-chip[data-stufe='voll']")).toBeNull();
    expect(unknownRow.querySelector(".event-chip")).toHaveTextContent("Unbekannt");
    expect(unknownRow.querySelector(".event-label > .mono")).toHaveTextContent("plugin.anderes");
    const firstCell = giftRow.querySelector("td");
    if (firstCell === null) throw new Error("Zeitspalte fehlt");
    expect(firstCell.getAttribute("title")).toBe("2026-09-18T04:00:00.000Z");
  });

  it("zeigt Abo-Stufen im Zahl-Chip als T1/T2/T3/Prime statt roh, unbekannte Werte ohne Chip", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path.endsWith("/events")) return jsonResponse({
        entries: [
          { eventId: "t1", createdAt: "2026-09-18T04:00:00.000Z", moduleId: "kanalereignisse", code: "kanalereignisse.chat.sub", detail: '{"person":"tier1","stufe":"1000"}', actorUserId: null },
          { eventId: "t2", createdAt: "2026-09-18T04:01:00.000Z", moduleId: "kanalereignisse", code: "kanalereignisse.chat.sub", detail: '{"person":"tier2","stufe":"2000"}', actorUserId: null },
          { eventId: "t3", createdAt: "2026-09-18T04:02:00.000Z", moduleId: "kanalereignisse", code: "kanalereignisse.chat.sub", detail: '{"person":"tier3","stufe":"3000"}', actorUserId: null },
          { eventId: "prime", createdAt: "2026-09-18T04:03:00.000Z", moduleId: "kanalereignisse", code: "kanalereignisse.chat.sub", detail: '{"person":"primeperson","stufe":"Prime"}', actorUserId: null },
          { eventId: "unbekannt", createdAt: "2026-09-18T04:04:00.000Z", moduleId: "kanalereignisse", code: "kanalereignisse.chat.sub", detail: '{"person":"rätselperson","stufe":"9999"}', actorUserId: null },
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

  it("erreicht Ereignisse über die Navigation und lädt die nächste Seite beim Scrollen", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const ersteSeite = {
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
    const zweiteSeite = {
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
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel] });
      if (url.pathname === "/api/channels/kanal-a/overview") return jsonResponse(overview(channel));
      if (url.pathname === "/api/channels/kanal-a/events") {
        return jsonResponse(url.searchParams.has("cursor") ? zweiteSeite : ersteSeite);
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
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText(/aktualisiert vor/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Ältere Ereignisse laden" })).not.toBeInTheDocument();
  });

  it("lädt neue Ereignisse am Anfang nach und mischt sie ein", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const alt = { eventId: "event-alt", createdAt: "2026-09-18T03:00:00.000Z", moduleId: "raid", code: "alt", detail: "{}", actorUserId: null, actorLogin: null, actorDisplayName: null };
    const neu = { eventId: "event-neu", createdAt: "2026-09-18T04:00:00.000Z", moduleId: "kanalereignisse", code: "kanalereignisse.raid.eingehend", detail: '{"zuschauer":7}', actorUserId: null, actorLogin: null, actorDisplayName: null };
    let ersteSeite = 0;
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel] });
      if (url.pathname === "/api/channels/kanal-a/modules") return jsonResponse({ modules: [] });
      if (url.pathname === "/api/channels/kanal-a/events") {
        ersteSeite += 1;
        return jsonResponse({ entries: ersteSeite === 1 ? [alt] : [neu, alt], nextCursor: null });
      }
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    expect(await screen.findByText("alt")).toBeInTheDocument();
    const socket = TestWebSocket.instances[0];
    if (socket === undefined) throw new Error("Realtime-Socket fehlt");
    socket.open();
    socket.receive(JSON.stringify({ version: 1, id: "message-1", createdAt: "2026-09-18T04:00:01.000Z", channelId: "kanal-a", type: "ereignisprotokoll.neu", payload: { entries: [{ eventId: neu.eventId, createdAt: neu.createdAt, moduleId: neu.moduleId, code: neu.code, actorUserId: null }] } }));

    expect(await screen.findByText("Raid von unbekannt mit 7 Zuschauern")).toBeInTheDocument();
    expect(ersteSeite).toBe(2);
  });

  it("hält die Liste weiter unten an und zeigt nur den Hinweis", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const alt = { eventId: "event-alt", createdAt: "2026-09-18T03:00:00.000Z", moduleId: "raid", code: "alt", detail: "{}", actorUserId: null, actorLogin: null, actorDisplayName: null };
    const neu = { eventId: "event-neu", createdAt: "2026-09-18T04:00:00.000Z", moduleId: "kanalereignisse", code: "kanalereignisse.raid.eingehend", detail: '{"zuschauer":8}', actorUserId: null, actorLogin: null, actorDisplayName: null };
    let eventRequests = 0;
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel] });
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
    const feed = document.querySelector(".ereignis-feed");
    if (feed === null) throw new Error("Ereignis-Feed fehlt");
    Object.defineProperty(feed, "getBoundingClientRect", { configurable: true, value: () => ({ top: -200 }) });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 400 });
    const socket = TestWebSocket.instances[0];
    if (socket === undefined) throw new Error("Realtime-Socket fehlt");
    socket.open();
    socket.receive(JSON.stringify({ version: 1, id: "message-lower", createdAt: "2026-09-18T04:00:01.000Z", channelId: "kanal-a", type: "ereignisprotokoll.neu", payload: { entries: [{ eventId: neu.eventId, createdAt: neu.createdAt, moduleId: neu.moduleId, code: neu.code, actorUserId: null }] } }));

    expect(await screen.findByRole("button", { name: "1 neue Ereignisse" })).toBeInTheDocument();
    expect(screen.queryByText("Raid von unbekannt mit 8 Zuschauern")).not.toBeInTheDocument();
    expect(eventRequests).toBe(1);
    expect(screen.getAllByRole("row")).toHaveLength(2);
  });

  it("springt mit dem Hinweis an den Anfang und lädt dann nach", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const alt = { eventId: "event-alt", createdAt: "2026-09-18T03:00:00.000Z", moduleId: "raid", code: "alt", detail: "{}", actorUserId: null, actorLogin: null, actorDisplayName: null };
    const neu = { eventId: "event-neu", createdAt: "2026-09-18T04:00:00.000Z", moduleId: "kanalereignisse", code: "kanalereignisse.raid.eingehend", detail: '{"zuschauer":9}', actorUserId: null, actorLogin: null, actorDisplayName: null };
    let eventRequests = 0;
    const scrollTo = vi.fn();
    Object.defineProperty(window, "scrollTo", { configurable: true, value: scrollTo });
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel] });
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
    const feed = document.querySelector(".ereignis-feed");
    if (feed === null) throw new Error("Ereignis-Feed fehlt");
    Object.defineProperty(feed, "getBoundingClientRect", { configurable: true, value: () => ({ top: -200 }) });
    Object.defineProperty(window, "scrollY", { configurable: true, value: 400 });
    const socket = TestWebSocket.instances[0];
    if (socket === undefined) throw new Error("Realtime-Socket fehlt");
    socket.open();
    socket.receive(JSON.stringify({ version: 1, id: "message-jump", createdAt: "2026-09-18T04:00:01.000Z", channelId: "kanal-a", type: "ereignisprotokoll.neu", payload: { entries: [{ eventId: neu.eventId, createdAt: neu.createdAt, moduleId: neu.moduleId, code: neu.code, actorUserId: null }] } }));

    fireEvent.click(await screen.findByRole("button", { name: "1 neue Ereignisse" }));
    expect(await screen.findByText("Raid von unbekannt mit 9 Zuschauern")).toBeInTheDocument();
    expect(eventRequests).toBe(2);
    expect(scrollTo).toHaveBeenCalledOnce();
  });

  it("verarbeitet eine doppelte Nachricht nur einmal", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const alt = { eventId: "event-alt", createdAt: "2026-09-18T03:00:00.000Z", moduleId: "raid", code: "alt", detail: "{}", actorUserId: null, actorLogin: null, actorDisplayName: null };
    const neu = { eventId: "event-neu", createdAt: "2026-09-18T04:00:00.000Z", moduleId: "kanalereignisse", code: "kanalereignisse.raid.eingehend", detail: '{"zuschauer":10}', actorUserId: null, actorLogin: null, actorDisplayName: null };
    let eventRequests = 0;
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel] });
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
    const message = JSON.stringify({ version: 1, id: "message-dupe", createdAt: "2026-09-18T04:00:01.000Z", channelId: "kanal-a", type: "ereignisprotokoll.neu", payload: { entries: [{ eventId: neu.eventId, createdAt: neu.createdAt, moduleId: neu.moduleId, code: neu.code, actorUserId: null }] } });
    socket.receive(message);
    socket.receive(message);

    expect(await screen.findByText("Raid von unbekannt mit 10 Zuschauern")).toBeInTheDocument();
    expect(eventRequests).toBe(2);
  });

  it("ignoriert unbekannte Nachrichtenarten", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    let eventRequests = 0;
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel] });
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

  it("schließt bei einem Hinweis aus einem fremden Kanal", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel] });
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
    socket.receive(JSON.stringify({ version: 1, id: "message-fremd", createdAt: "2026-09-18T04:00:01.000Z", channelId: "kanal-b", type: "ereignisprotokoll.neu", payload: { entries: [] } }));

    expect(socket.readyState).toBe(3);
    expect(await screen.findByText("Offline")).toBeInTheDocument();
  });

  it("lädt Seite 1 nach einem Wiederaufbau neu", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const alt = { eventId: "event-alt", createdAt: "2026-09-18T03:00:00.000Z", moduleId: "raid", code: "alt", detail: "{}", actorUserId: null, actorLogin: null, actorDisplayName: null };
    const neu = { eventId: "event-neu", createdAt: "2026-09-18T04:00:00.000Z", moduleId: "kanalereignisse", code: "kanalereignisse.raid.eingehend", detail: '{"zuschauer":11}', actorUserId: null, actorLogin: null, actorDisplayName: null };
    let eventRequests = 0;
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel] }));
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

  it("lädt am zugänglichen Feed-Ende nur einmal und zeigt das Ende ausdrücklich", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    let releaseSecondPage: ((response: Response) => void) | undefined;
    const ersteSeite = {
      entries: [{ eventId: "event-neu", createdAt: "2026-09-18T04:00:00.000Z", moduleId: "raid", code: "neu", detail: "{}", actorUserId: null }],
      nextCursor: "cursor-1",
    };
    const zweiteSeite = {
      entries: [{ eventId: "event-alt", createdAt: "2026-09-18T03:00:00.000Z", moduleId: "raid", code: "alt", detail: "{}", actorUserId: null }],
      nextCursor: null,
    };
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel] }));
      if (url.pathname === "/api/channels/kanal-a/modules") return Promise.resolve(jsonResponse({ modules: [] }));
      if (url.pathname === "/api/channels/kanal-a/events") {
        return url.searchParams.has("cursor")
          ? new Promise<Response>((resolve) => { releaseSecondPage = resolve; })
          : Promise.resolve(jsonResponse(ersteSeite));
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

    releaseSecondPage?.(jsonResponse(zweiteSeite));
    expect(await screen.findByText("alt")).toBeInTheDocument();
    expect(screen.getByText("Ende des Ereignisverlaufs erreicht.")).toBeInTheDocument();
  });

  it("gruppiert denselben Auslöser, zeigt den stärksten Ton und den chronologischen Verlauf", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path.endsWith("/events")) return jsonResponse({
        entries: [{
          eventId: "event-command",
          createdAt: "2026-09-18T04:00:00.000Z",
          moduleId: "textbefehle",
          triggerId: "trigger-1",
          code: "textbefehle.ausgeloest",
          detail: '{"name":"wiki","antwort":"Antwort"}',
          actorUserId: "user-1",
          actorLogin: "alice",
          actorDisplayName: "Alice",
        }, {
          eventId: "event-sent",
          createdAt: "2026-09-18T04:01:00.000Z",
          moduleId: "textbefehle",
          triggerId: "trigger-1",
          code: "host.chat.gesendet",
          detail: '{"text":"Antwort"}',
          actorUserId: "user-1",
          actorLogin: "alice",
          actorDisplayName: "Alice",
        }, {
          eventId: "event-command-red",
          createdAt: "2026-09-18T04:02:00.000Z",
          moduleId: "textbefehle",
          triggerId: "trigger-2",
          code: "textbefehle.ausgeloest",
          detail: '{"name":"fehlversuch","antwort":"Antwort"}',
          actorUserId: "user-1",
          actorLogin: "alice",
          actorDisplayName: "Alice",
        }, {
          eventId: "event-red",
          createdAt: "2026-09-18T04:03:00.000Z",
          moduleId: "textbefehle",
          triggerId: "trigger-2",
          code: "host.chat.fehlgeschlagen",
          detail: '{"text":"Antwort","grund":"rate_limited"}',
          actorUserId: "user-1",
          actorLogin: "alice",
          actorDisplayName: "Alice",
        }, {
          eventId: "event-other",
          createdAt: "2026-09-18T04:04:00.000Z",
          moduleId: "raid",
          triggerId: "trigger-3",
          code: "shoutout.unterdrueckt",
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
    expect(screen.getByText("host.chat.gesendet")).toBeInTheDocument();
    const history = screen.getByText("host.chat.gesendet").closest("li")?.parentElement;
    if (history == null) throw new Error("Verlauf fehlt");
    const historyText = history.textContent;
    expect(historyText.indexOf("textbefehle.ausgeloest")).toBeLessThan(historyText.indexOf("host.chat.gesendet"));

    const failedGroupRow = screen.getByText("Chat-Nachricht fehlgeschlagen").closest("tr");
    expect(failedGroupRow).not.toBeNull();
    fireEvent.click(failedGroupRow as HTMLElement);
    expect(failedGroupRow).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("host.chat.fehlgeschlagen")).toBeInTheDocument();
    expect(screen.getByText(/"grund": "rate_limited"/)).toBeInTheDocument();
  });

  it("zeigt den Ereignis-Leerzustand als einzelnen Satz", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path.endsWith("/events")) return jsonResponse({ entries: [], nextCursor: null });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    expect(await screen.findByText("Noch keine Ereignisse protokolliert.")).toBeInTheDocument();
  });

  it("zeigt aktive Filter, kombiniert sie und meldet einen Treffer-Leerzustand", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const channelEntry = { eventId: "channel", createdAt: "2026-09-18T04:00:00.000Z", moduleId: "kanalereignisse", code: "kanalereignisse.raid.eingehend", detail: '{"zuschauer":21}', actorUserId: null, actorLogin: null, actorDisplayName: null };
    const moduleEntry = { eventId: "module", createdAt: "2026-09-18T04:01:00.000Z", moduleId: "textbefehle", code: "textbefehle.ausgeloest", detail: '{"name":"hilfe"}', actorUserId: "person-a", actorLogin: "alice", actorDisplayName: "Alice" };
    const errorEntry = { eventId: "error", createdAt: "2026-09-18T04:02:00.000Z", moduleId: "textbefehle", code: "host.chat.fehlgeschlagen", detail: "{}", actorUserId: "person-a", actorLogin: "alice", actorDisplayName: "Alice" };
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel] }));
      if (url.pathname === "/api/channels/kanal-a/modules") return Promise.resolve(jsonResponse({ modules: [
        { id: "kanalereignisse", enabled: true, settings: "{}" },
        { id: "textbefehle", enabled: true, settings: "{}" },
        { id: "werbung", enabled: true, settings: "{}" },
      ] }));
      if (url.pathname === "/api/channels/kanal-a/events") {
        const origin = url.searchParams.get("origin");
        const module = url.searchParams.get("module");
        const tone = url.searchParams.get("tone");
        const actor = url.searchParams.get("actor");
        if (module === "werbung" && actor === "person-a") return Promise.resolve(jsonResponse({ entries: [], nextCursor: null }));
        if (origin === "channel") return Promise.resolve(jsonResponse({ entries: [channelEntry], nextCursor: null }));
        if (module === "textbefehle" && tone === "fehler") return Promise.resolve(jsonResponse({ entries: [errorEntry], nextCursor: null }));
        if (module === "textbefehle") return Promise.resolve(jsonResponse({ entries: [errorEntry, moduleEntry], nextCursor: null }));
        if (tone === "fehler") return Promise.resolve(jsonResponse({ entries: [errorEntry], nextCursor: null }));
        if (actor === "person-a") return Promise.resolve(jsonResponse({ entries: [errorEntry, moduleEntry], nextCursor: null }));
        return Promise.resolve(jsonResponse({ entries: [channelEntry, errorEntry, moduleEntry], nextCursor: null }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    expect(await screen.findByText("Raid von unbekannt mit 21 Zuschauern")).toBeInTheDocument();
    const herkunft = screen.getByRole("combobox", { name: "Herkunft" });
    const modul = screen.getByRole("combobox", { name: "Modul" });
    const ton = screen.getByRole("combobox", { name: "Ton" });
    const person = screen.getByRole("textbox", { name: "Person" });
    expect(herkunft).toBeInTheDocument();
    expect(modul).toBeInTheDocument();
    expect(ton).toBeInTheDocument();
    expect(person).toBeInTheDocument();

    fireEvent.change(herkunft, { target: { value: "kanal" } });
    expect(await screen.findByText("Raid von unbekannt mit 21 Zuschauern")).toBeInTheDocument();
    expect(screen.queryByText("Befehl !hilfe ausgeführt")).not.toBeInTheDocument();
    expect(screen.getByText(/Aktive Filter:/)).toHaveTextContent("Kanalereignisse");

    fireEvent.click(screen.getByRole("button", { name: "Filter zurücksetzen" }));
    fireEvent.change(modul, { target: { value: "textbefehle" } });
    fireEvent.change(ton, { target: { value: "fehler" } });
    expect(await screen.findByText("Chat-Nachricht fehlgeschlagen")).toBeInTheDocument();
    expect(screen.queryByText("Raid von unbekannt mit 21 Zuschauern")).not.toBeInTheDocument();
    fireEvent.change(person, { target: { value: "person-a" } });
    expect(await screen.findByText("Alice")).toBeInTheDocument();

    fireEvent.change(modul, { target: { value: "werbung" } });
    expect(await screen.findByText("Keine Ereignisse passen zu den Filtern.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Filter zurücksetzen" }));
    expect(await screen.findByText("Raid von unbekannt mit 21 Zuschauern")).toBeInTheDocument();
    expect(screen.queryByText("Keine Ereignisse passen zu den Filtern.")).not.toBeInTheDocument();
  });

  it("entprellt fünf Eingaben im Personenfilter zu genau einer weiteren Ereignisanfrage", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const eventRequests: URL[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel] }));
      if (url.pathname === "/api/channels/kanal-a/events") {
        eventRequests.push(url);
        return Promise.resolve(jsonResponse({ entries: [], nextCursor: null }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    const person = await screen.findByRole("textbox", { name: "Person" });
    const initialRequests = eventRequests.length;
    for (const value of ["a", "al", "ali", "alic", "alice"]) {
      fireEvent.change(person, { target: { value } });
    }
    expect(eventRequests).toHaveLength(initialRequests);

    // Kein `setTimeout` mit echter Wartezeit: der Test war damit von der Laufzeit
    // der Maschine abhängig und fiel in drei Läufen einmal grundlos durch.
    // `waitFor` pollt bis zur eigenen Frist und ist deshalb zuverlässig, egal
    // wie schnell oder langsam die Entprellung tatsächlich abläuft.
    await waitFor(
      () => { expect(eventRequests).toHaveLength(initialRequests + 1); },
      { timeout: 2000 },
    );
    expect(eventRequests.at(-1)?.searchParams.get("actor")).toBe("alice");
  });

  it("stellt den letzten Broadcaster nicht als entziehbar dar", async () => {
    // Der Worker würde beides ablehnen. Ein Knopf, der garantiert scheitert,
    // sieht aus wie eine Möglichkeit — man muss ihn drücken, um zu erfahren,
    // dass es keine ist. Gesperrt mit Grund statt versteckt: ein verschwundener
    // Knopf wirft die Frage auf, ob etwas kaputt ist.
    await zeigeMitglieder({
      members: [broadcaster("100", "esembe", "esembe")],
      broadcasterCount: 1,
      viewerUserId: "100",
    });

    expect(await screen.findByRole("button", { name: "Zugriff für esembe entziehen" })).toBeDisabled();
    expect(screen.getAllByText("Letzter Broadcaster")).toHaveLength(2);

    // Das Auswahlfeld bietet keinen Wert an, der abgelehnt würde.
    const rolle = screen.getByRole("combobox", { name: "Rolle für esembe" });
    expect(rolle).toBeDisabled();
    expect(within(rolle).getAllByRole("option").map((o) => o.textContent)).toEqual(["Broadcaster"]);
  });

  it("lässt den Entzug zu, sobald ein zweiter Broadcaster bleibt", async () => {
    // Gegenprobe: Die Sperre darf den erlaubten Fall nicht mitsperren.
    await zeigeMitglieder({
      members: [broadcaster("100", "esembe", "esembe"), broadcaster("200", "zweit", "Zweit")],
      broadcasterCount: 2,
      viewerUserId: "100",
    });

    expect(await screen.findByRole("button", { name: "Zugriff für esembe entziehen" })).toBeEnabled();
    expect(screen.queryByText("Letzter Broadcaster")).not.toBeInTheDocument();
  });

  it("warnt beim Entzug des eigenen Zugangs ausdrücklich vor der Aussperrung", async () => {
    const frage = vi.fn((meldung: string) => { void meldung; return false; });
    await zeigeMitglieder({
      members: [broadcaster("100", "esembe", "esembe"), broadcaster("200", "zweit", "Zweit")],
      broadcasterCount: 2,
      viewerUserId: "100",
    });
    vi.stubGlobal("confirm", frage);
    fireEvent.click(await screen.findByRole("button", { name: "Zugriff für esembe entziehen" }));

    expect(frage).toHaveBeenCalledOnce();
    expect(frage.mock.calls.at(0)?.[0] ?? "").toContain("selbst aus");

    // Fremder Eintrag: dieselbe Aktion, andere Frage.
    fireEvent.click(screen.getByRole("button", { name: "Zugriff für Zweit entziehen" }));
    expect(frage.mock.calls.at(1)?.[0] ?? "").not.toContain("selbst aus");
  });

  it("zeigt Mitgliedschaften und die Verwaltungsaktion nur für verwaltende Rollen", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const members = {
      members: [
        { userId: "100", login: "streamer", displayName: "Streamerin", profileImageUrl: "https://cdn.example/streamerin.png", role: "broadcaster", joinedAt: "2026-09-17T12:00:00.000Z" },
        { userId: "200", login: null, displayName: null, profileImageUrl: null, role: "bediener", joinedAt: "2026-09-18T12:00:00.000Z" },
      ],
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
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

    // Ein Bild, das nicht laedt, darf die Zeile nicht unbedienbar machen: der
    // Platzhalter tritt an seine Stelle, der Profillink bleibt unveraendert da.
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

    const operatorChannel = { ...channel, role: "bediener" };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [operatorChannel] });
      if (path.endsWith("/members")) return jsonResponse(members);
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/members");
    cleanup();
    render(<DashboardApp />);

    await screen.findByRole("heading", { name: "Mitglieder", level: 1 });
    expect(screen.getByRole("button", { name: "Zugriff freigeben" })).toBeDisabled();
  });

  it("behält die Semantik der Mitgliedertabelle für schmale Karten", async () => {
    await zeigeMitglieder({
      members: [{ userId: "100", login: "streamer", displayName: "Streamerin", profileImageUrl: null, role: "verwalter", joinedAt: "2026-09-17T12:00:00.000Z" }],
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
    expect(row?.querySelectorAll("td")).toHaveLength(3);
    expect(Array.from(row?.querySelectorAll("td") ?? []).every((cell) => cell.getAttribute("role") === "cell")).toBe(true);
  });

  it("zeigt dem Bediener Mitgliederaktionen deaktiviert mit Begründung", async () => {
    const channel = { ...healthyChannel("kanal-a", "Alpha"), role: "bediener" };
    const members = {
      members: [{ userId: "200", login: "moderation", displayName: "Moderation", role: "bediener", joinedAt: "2026-09-18T12:00:00.000Z" }],
      broadcasterCount: 1,
      viewerUserId: "200",
      nextCursor: null,
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path.endsWith("/members")) return jsonResponse(members);
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/members");

    render(<DashboardApp />);

    await screen.findByRole("heading", { name: "Mitglieder", level: 1 });
    const grund = "Nur Broadcaster und Verwalter dürfen Mitglieder ändern.";
    const suche = screen.getByRole("button", { name: "Suchen" });
    expect(suche).toBeDisabled();
    expect(suche).toHaveAttribute("title", grund);
    const freigeben = screen.getByRole("button", { name: "Zugriff freigeben" });
    expect(freigeben).toBeDisabled();
    expect(freigeben).toHaveAttribute("title", grund);
    expect(await screen.findByRole("combobox", { name: "Rolle für Moderation" })).toBeDisabled();
    const entziehen = screen.getByRole("button", { name: "Zugriff für Moderation entziehen" });
    expect(entziehen).toBeDisabled();
    expect(screen.getAllByText(grund).length).toBeGreaterThan(0);
  });

  it("verwirft Suchergebnis und Freigabebestätigung beim Kanalwechsel", async () => {
    const alpha = { ...healthyChannel("kanal-a", "Alpha"), role: "verwalter" };
    const beta = { ...healthyChannel("kanal-b", "Beta"), role: "bediener" };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [alpha, beta] });
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
    fireEvent.click(screen.getByRole("button", { name: "Zugriff freigeben" }));
    expect(screen.getByRole("button", { name: "Zugriff endgültig freigeben" })).toBeInTheDocument();

    act(() => {
      window.history.pushState({}, "", "/channels/kanal-b/members");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(screen.queryByText("Neue Person")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Suchen" })).toBeDisabled();
  });

  it("zeigt dem Bediener die Modulaktivierung deaktiviert mit Begründung", async () => {
    const channel = { ...healthyChannel("kanal-a", "Alpha"), role: "bediener" };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path.endsWith("/overview")) return jsonResponse(overview(channel));
      if (path.endsWith("/modules")) return jsonResponse({ modules: [{ id: "textbefehle", enabled: false, settings: "{}" }] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/modules/textbefehle");

    render(<DashboardApp />);

    await screen.findByRole("heading", { name: "Textbefehle", level: 1 });
    const grund = "Nur Broadcaster und Verwalter dürfen Module ändern.";
    const schalter = await screen.findAllByRole("switch", { name: /Textbefehle/i });
    expect(schalter).toHaveLength(2);
    schalter.forEach((element) => { expect(element).toBeDisabled(); });
    expect(screen.getAllByText(grund)).toHaveLength(2);
  });

  it("zeigt Systemzustand, bevor das Audit-Log eintrifft", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    let resolveAudit: ((response: Response) => void) | undefined;
    const auditResponse = new Promise<Response>((resolve) => { resolveAudit = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel] }));
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

  it("öffnet den ausgewählten Audit-Eintrag im Sub-Inspector", async () => {
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
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path.endsWith("/system")) return jsonResponse(system);
      if (path.endsWith("/audit-log")) return jsonResponse({ entries: [auditEntry, secondAuditEntry], nextCursor: null });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/system");

    render(<DashboardApp />);

    expect(await screen.findByRole("columnheader", { name: "Zeit" })).toBeInTheDocument();
    expect(await screen.findByText("Alice")).toBeInTheDocument();
    expect(await screen.findByText("gelöscht")).toBeInTheDocument();
    const row = screen.getByText("module.enabled").closest("tr");
    expect(row).not.toBeNull();
    expect(row).toHaveAttribute("aria-selected", "false");
    fireEvent.keyDown(row as HTMLElement, { key: "Enter" });
    expect(row).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "Vorher" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Nachher" })).toBeInTheDocument();
    expect(screen.getByText('{"enabled":false}')).toBeInTheDocument();
    const inspector = await screen.findByRole("region", { name: "Änderungsdaten" });
    expect(await within(inspector).findByText("user-1")).toBeInTheDocument();
    const secondRow = screen.getByText("module.disabled").closest("tr");
    expect(secondRow).not.toBeNull();
    fireEvent.keyDown(secondRow as HTMLElement, { key: " " });
    expect(secondRow).toHaveAttribute("aria-selected", "true");
    expect(row).toHaveAttribute("aria-selected", "false");
  });

  it("zeigt alle Abos lesbar und öffnet Meldung und Status im Sub-Inspector", async () => {
    const channel = { ...healthyChannel("kanal-a", "Alpha"), botPermissions: { missingScopes: [] } };
    const subscriptions = [
      { subscriptionType: "channel.chat.message", variant: "", version: "1", subscriptionId: "chat-1", status: "enabled", reason: null, message: null, statusCode: null, updatedAt: "2026-09-18T04:00:00.000Z" },
      { subscriptionType: "channel.raid", variant: "eingehend", version: "1", subscriptionId: "raid-in", status: "missing", reason: "subscription_replaced", message: null, statusCode: null, updatedAt: "2026-09-18T03:00:00.000Z" },
      { subscriptionType: "channel.raid", variant: "ausgehend", version: "1", subscriptionId: "raid-out", status: "error", reason: "missing_scope", message: "Scope fehlt", statusCode: 403, updatedAt: "2026-09-18T02:00:00.000Z" },
      { subscriptionType: "channel.future", variant: "", version: "9", subscriptionId: null, status: "pending", reason: "wartet", message: null, statusCode: null, updatedAt: "2026-09-18T01:00:00.000Z" },
    ];
    const systemResponse = { ...system, botPermissions: { missingScopes: [] }, subscriptions };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel] }));
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

  it("zeigt Bot-Berechtigungen auf der Kanalseite, nennt fehlende Scopes und bietet keine Autorisierung an", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      botPermissions: { missingScopes: ["user:bot", "user:read:chat"] },
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel] }));
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
    // Die Autorisierung gehört zum Betreiber-Account, nicht in die kanalbezogene Panel-Rolle.
    expect(screen.queryByRole("button", { name: /autoris/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /autoris/i })).not.toBeInTheDocument();
  });

  it("zeigt markierten Kanal mit unvollständiger Vollzustimmung samt Zustandszeile, Scopes und Zustimmungslink", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      role: "broadcaster",
      broadcasterPermissions: { missingScopes: ["channel:manage:broadcast"] },
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    expect(await screen.findByRole("article", { name: "Vollzustimmung fehlt" })).toHaveAttribute("data-status", "warning");
    const inspector = await screen.findByRole("region", { name: "Fehlende Broadcaster-Berechtigungen" });
    expect(within(inspector).getByText("channel:manage:broadcast")).toHaveClass("mono");
    const consentLink = await screen.findByRole("link", { name: "Vollzustimmung erteilen" });
    expect(consentLink).toHaveAttribute("href", "/auth/login?kanal=kanal-a");
  });

  it("zeigt für einen unmarkierten Kanal keinen Vollzustimmungszustand", async () => {
    const channel = { ...healthyChannel("kanal-a", "Alpha"), broadcasterPermissions: null };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    await screen.findByRole("heading", { name: "Alpha", level: 1 });
    expect(screen.queryByRole("article", { name: "Vollzustimmung fehlt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Vollzustimmung erteilen" })).not.toBeInTheDocument();
  });

  it("zeigt für einen vollständig zugestimmten Kanal keinen Vollzustimmungszustand", async () => {
    const channel = { ...healthyChannel("kanal-a", "Alpha"), broadcasterPermissions: { missingScopes: [] } };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    await screen.findByRole("heading", { name: "Alpha", level: 1 });
    expect(screen.queryByRole("article", { name: "Vollzustimmung fehlt" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Vollzustimmung erteilen" })).not.toBeInTheDocument();
  });

  it("zeigt Verwaltern die Vollzustimmung deaktiviert mit Begründung", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      role: "verwalter",
      broadcasterPermissions: { missingScopes: ["channel:manage:broadcast"] },
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
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

  it("zeigt vollständige Bot-Berechtigungen als gesunden Zustand mit Wort", async () => {
    const channel = { ...healthyChannel("kanal-a", "Alpha"), botPermissions: { missingScopes: [] } };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel] }));
      if (path.endsWith("/overview")) return Promise.resolve(jsonResponse({ ...channel, activeModules: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    const permissions = await screen.findByRole("article", { name: "Bot-Berechtigungen" });
    expect(permissions).toHaveAttribute("data-status", "healthy");
    expect(within(permissions).getByText("Gesund")).toBeInTheDocument();
  });

  it("fragt beim Hinzufügen ausdrücklich nach dem tatsächlichen Zugriffsumfang", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    let addRequestCount = 0;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      const path = url.pathname;
      if (path === "/api/channels/kanal-a/members" && init?.method === "POST") {
        addRequestCount += 1;
        return jsonResponse({ member: { userId: "300", login: "neue-person", displayName: "Neue Person", profileImageUrl: "https://cdn.example/neue-person.png", role: "bediener", joinedAt: "2026-09-19T00:00:00.000Z" } }, 201);
      }
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
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

  it("bricht die Hinzufügen-Bestätigung ohne POST ab und lässt sie erneut öffnen", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    let addRequestCount = 0;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels/kanal-a/members" && init?.method === "POST") addRequestCount += 1;
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel] });
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
    // Wer nur Tastatur oder Screenreader nutzt, muss die wichtigste
    // Sicherheitsabfrage des Formulars auch tatsächlich mitbekommen.
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

  it("verwirft einen verspäteten Mitglieder-Reload nach einer Mutation beim Kanalwechsel", async () => {
    const alpha = healthyChannel("kanal-a", "Alpha");
    const beta = healthyChannel("kanal-b", "Beta");
    let resolveAlphaReload: ((response: Response) => void) | undefined;
    const alphaReload = new Promise<Response>((resolve) => {
      resolveAlphaReload = resolve;
    });
    const alphaMember = { userId: "alpha-user", login: "alpha-user", displayName: "Alpha-Mitglied", profileImageUrl: null, role: "bediener", joinedAt: "2026-09-18T00:00:00.000Z" };
    const betaMember = { userId: "beta-user", login: "beta-user", displayName: "Beta-Mitglied", profileImageUrl: null, role: "bediener", joinedAt: "2026-09-18T00:00:00.000Z" };
    let memberRequestCount = 0;
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [alpha, beta] }));
      if (url.pathname === "/api/channels/kanal-a/members") {
        memberRequestCount += 1;
        if (memberRequestCount === 1) return Promise.resolve(jsonResponse({ members: [alphaMember], nextCursor: null }));
        return alphaReload;
      }
      if (url.pathname === "/api/channels/kanal-b/members") return Promise.resolve(jsonResponse({ members: [betaMember], nextCursor: null }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (url.pathname === "/api/channels/kanal-a/members/alpha-user") return Promise.resolve(jsonResponse({ member: { ...alphaMember, role: "verwalter" } }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/members");

    render(<DashboardApp />);
    await screen.findByText("Alpha-Mitglied");
    fireEvent.change(screen.getByRole("combobox", { name: "Rolle für Alpha-Mitglied" }), { target: { value: "verwalter" } });
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

  it("behält den erfolgreichen Reload-Stand gegen eine verspätete Erstantwort", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const neuerMember = { userId: "new-user", login: "new-user", displayName: "Neuer Stand", profileImageUrl: null, role: "bediener", joinedAt: "2026-09-19T00:00:00.000Z" };
    const verspäteterMember = { userId: "late-user", login: "late-user", displayName: "Verspäteter Stand", profileImageUrl: null, role: "bediener", joinedAt: "2026-09-18T00:00:00.000Z" };
    let resolveLateInitial: ((response: Response) => void) | undefined;
    const lateInitial = new Promise<Response>((resolve) => {
      resolveLateInitial = resolve;
    });
    let memberRequestCount = 0;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel] }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (url.pathname === "/api/channels/kanal-a/members/search") return Promise.resolve(jsonResponse({ user: { userId: "new-user", login: "neue-person", displayName: "Neuer Stand", profileImageUrl: null } }));
      if (url.pathname === "/api/channels/kanal-a/members" && init?.method === "POST") return Promise.resolve(jsonResponse({ member: neuerMember }, 201));
      if (url.pathname === "/api/channels/kanal-a/members") {
        memberRequestCount += 1;
        if (memberRequestCount === 1) return lateInitial;
        return Promise.resolve(jsonResponse({ members: [neuerMember], broadcasterCount: 1, viewerUserId: "new-user", nextCursor: null }));
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
      resolveLateInitial?.(jsonResponse({ members: [verspäteterMember], broadcasterCount: 1, viewerUserId: "late-user", nextCursor: null }));
      await Promise.resolve();
    });

    expect(within(screen.getByRole("table")).getByText("Neuer Stand")).toBeInTheDocument();
    expect(screen.queryByText("Verspäteter Stand")).not.toBeInTheDocument();
  });

  it("sperrt die Pagination während eines laufenden Mitglieder-Reloads", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const ersterMember = { userId: "first-user", login: "first-user", displayName: "Erster Stand", profileImageUrl: null, role: "bediener", joinedAt: "2026-09-18T00:00:00.000Z" };
    const reloadMember = { userId: "reload-user", login: "reload-user", displayName: "Reload-Stand", profileImageUrl: null, role: "bediener", joinedAt: "2026-09-19T00:00:00.000Z" };
    let resolveReload: ((response: Response) => void) | undefined;
    const reload = new Promise<Response>((resolve) => {
      resolveReload = resolve;
    });
    let memberRequestCount = 0;
    let paginationRequestCount = 0;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel] }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (url.pathname === "/api/channels/kanal-a/members/first-user" && init?.method === "PATCH") return Promise.resolve(jsonResponse({ member: { ...ersterMember, role: "verwalter" } }));
      if (url.pathname === "/api/channels/kanal-a/members" && url.search !== "") {
        paginationRequestCount += 1;
        return Promise.resolve(jsonResponse({ members: [], broadcasterCount: 1, viewerUserId: "first-user", nextCursor: null }));
      }
      if (url.pathname === "/api/channels/kanal-a/members") {
        memberRequestCount += 1;
        if (memberRequestCount === 1) return Promise.resolve(jsonResponse({ members: [ersterMember], broadcasterCount: 1, viewerUserId: "first-user", nextCursor: "cursor-1" }));
        return reload;
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/members");

    render(<DashboardApp />);
    await screen.findByText("Erster Stand");
    fireEvent.change(screen.getByRole("combobox", { name: "Rolle für Erster Stand" }), { target: { value: "verwalter" } });
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

  it("setzt den Pagination-Zustand nach einem Reload während der Pagination zurück", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const ersterMember = { userId: "first-user", login: "first-user", displayName: "Erster Stand", profileImageUrl: null, role: "bediener", joinedAt: "2026-09-18T00:00:00.000Z" };
    const reloadMember = { userId: "reload-user", login: "reload-user", displayName: "Reload-Stand", profileImageUrl: null, role: "bediener", joinedAt: "2026-09-19T00:00:00.000Z" };
    const latePageMember = { userId: "late-page-user", login: "late-page-user", displayName: "Verspätete Seite", profileImageUrl: null, role: "bediener", joinedAt: "2026-09-17T00:00:00.000Z" };
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
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel] }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (url.pathname === "/api/channels/kanal-a/members/first-user" && init?.method === "PATCH") return Promise.resolve(jsonResponse({ member: { ...ersterMember, role: "verwalter" } }));
      if (url.pathname === "/api/channels/kanal-a/members" && url.search === "?cursor=cursor-1") return nextPage;
      if (url.pathname === "/api/channels/kanal-a/members") {
        memberRequestCount += 1;
        if (memberRequestCount === 1) return Promise.resolve(jsonResponse({ members: [ersterMember], broadcasterCount: 1, viewerUserId: "first-user", nextCursor: "cursor-1" }));
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

    fireEvent.change(screen.getByRole("combobox", { name: "Rolle für Erster Stand" }), { target: { value: "verwalter" } });
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

  it("lädt die nächste Mitglieder-Seite mit dem gelieferten Cursor nach", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel] }));
      if (url.pathname === "/api/channels/kanal-a/members" && url.search === "") {
        return Promise.resolve(jsonResponse({ members: [{ userId: "user-1", login: "erste", displayName: "Erste Person", profileImageUrl: null, role: "bediener", joinedAt: "2026-09-18T00:00:00.000Z" }], nextCursor: "cursor-1" }));
      }
      if (url.pathname === "/api/channels/kanal-a/members" && url.search === "?cursor=cursor-1") {
        return Promise.resolve(jsonResponse({ members: [{ userId: "user-2", login: "zweite", displayName: "Zweite Person", profileImageUrl: null, role: "bediener", joinedAt: "2026-09-18T00:00:00.000Z" }], nextCursor: null }));
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

  it("zeigt bei leerer Modulregistry eine sinnvolle leere Modulfläche", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path.endsWith("/overview")) return jsonResponse(overview(channel));
      if (path.endsWith("/system")) return jsonResponse(system);
      if (path.endsWith("/audit-log")) return jsonResponse(audit);
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    expect(await screen.findByText("Keine Module aktiv.")).toBeInTheDocument();
  });

  it("verweist in der Kanalübersicht auf aktive Module statt ihre Formulare einzubetten", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const aktivesModul = { ...overview(channel), activeModules: [{ moduleId: "textbefehle", settings: "{}" }] };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path === "/api/channels/kanal-a/overview") return jsonResponse(aktivesModul);
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    const link = await screen.findByRole("link", { name: /Textbefehle ·/ });
    expect(link).toHaveAttribute("href", "/channels/kanal-a/modules/textbefehle");
    expect(screen.queryByRole("heading", { name: "Befehl anlegen" })).not.toBeInTheDocument();
  });

  it("erreicht ein aktives Modul über seine eigene Unterseite", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const aktivesModul = { ...overview(channel), activeModules: [{ moduleId: "textbefehle", settings: "{}" }] };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path === "/api/channels/kanal-a/overview") return jsonResponse(aktivesModul);
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/modules/textbefehle");

    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Textbefehle", level: 1 })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Befehl anlegen" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Module" }).some((link) => link.getAttribute("href") === "/channels/kanal-a/modules")).toBe(true);
  });

  it("zeigt im Kopf Anzeigename, Twitch-ID und den beschrifteten Modulschalter", async () => {
    const channel = { ...healthyChannel("26876135", "Esembe"), login: "esembe" };
    const zweiterKanal = healthyChannel("987654", "ZweiteRinne");
    const aktivesModul = { ...overview(channel), activeModules: [{ moduleId: "textbefehle", settings: "{}" }] };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel, zweiterKanal] });
      if (path === "/api/channels/26876135/overview") return jsonResponse(aktivesModul);
      if (path === "/api/channels/26876135/modules") return jsonResponse({ modules: [{ id: "textbefehle", enabled: true, settings: "{}" }] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/26876135/modules/textbefehle");

    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Textbefehle", level: 1 })).toBeInTheDocument();
    const channelButton = screen.getByRole("button", { name: "Kanal auswählen: Esembe" });
    fireEvent.click(channelButton);
    expect(within(screen.getByRole("listbox")).getByRole("option", { name: /Esembe/ })).toHaveTextContent("26876135");
    const headerSwitch = await screen.findByRole("switch", { name: "Textbefehle · Läuft" });
    expect(headerSwitch).toHaveTextContent("Textbefehle · Läuft");
  });

  it("lädt die Kanalübersicht nach dem Einschalten neu und zeigt die Modulansicht", async () => {
    const channel = { ...healthyChannel("kanal-a", "Alpha"), role: "broadcaster" as const };
    let overviewAufrufe = 0;
    let modulesAufrufe = 0;
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel] });
      if (url.pathname === "/api/channels/kanal-a/overview") {
        overviewAufrufe += 1;
        return jsonResponse(overviewAufrufe === 1 ? overview(channel) : {
          ...overview(channel),
          activeModules: [{ moduleId: "textbefehle", settings: "{}" }],
        });
      }
      if (url.pathname === "/api/channels/kanal-a/modules" && init?.method === undefined) {
        modulesAufrufe += 1;
        return jsonResponse({ modules: [{ id: "textbefehle", enabled: modulesAufrufe > 1, settings: "{}" }] });
      }
      if (url.pathname === "/api/csrf") return jsonResponse({ token: "csrf-token" });
      if (url.pathname === "/api/channels/kanal-a/modules/textbefehle" && init?.method === "PATCH") {
        return jsonResponse({ module: { id: "textbefehle", enabled: true, settings: "{}" } });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/modules/textbefehle");

    render(<DashboardApp />);

    const switcher = await screen.findByRole("switch", { name: "Textbefehle · Aus" });
    fireEvent.click(switcher);

    expect(await screen.findByRole("button", { name: "Befehl anlegen" })).toBeInTheDocument();
    expect(overviewAufrufe).toBe(2);
    expect(fetcher.mock.calls.filter(([input]) => requestUrl(input).pathname === "/api/channels/kanal-a/overview")).toHaveLength(2);
  });

  it("öffnet den Kanalumschalter per Enter und Pfeil ab, bewegt den Fokus und schließt ohne Auswahl per Escape", async () => {
    const alpha = healthyChannel("kanal-a", "Alpha");
    const beta = healthyChannel("kanal-b", "Beta");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [alpha, beta] });
      if (path.endsWith("/overview")) return jsonResponse(overview(path.includes("kanal-b") ? beta : alpha));
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    await screen.findByRole("heading", { name: "Alpha", level: 1 });
    const button = screen.getByRole("button", { name: "Kanal auswählen: Alpha" });
    expect(button).toHaveAttribute("aria-expanded", "false");

    fireEvent.keyDown(button, { key: "Enter" });
    const listbox = screen.getByRole("listbox");
    const options = within(listbox).getAllByRole("option");
    const [firstOption, secondOption] = options;
    if (firstOption === undefined || secondOption === undefined) throw new Error("Der Kanalumschalter braucht zwei Optionen.");
    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(document.activeElement).toBe(firstOption);
    expect(firstOption).toHaveAttribute("aria-selected", "true");
    expect(secondOption).toHaveAttribute("aria-selected", "false");
    expect(within(firstOption).getByText("Gesund")).toBeInTheDocument();
    expect(within(firstOption).getByText("kanal-a")).toHaveClass("mono");

    fireEvent.keyDown(firstOption, { key: "ArrowDown" });
    expect(document.activeElement).toBe(secondOption);
    expect(secondOption).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(secondOption, { key: "End" });
    expect(document.activeElement).toBe(secondOption);
    fireEvent.keyDown(secondOption, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(button).toHaveFocus();
    expect(window.location.pathname).toBe("/channels/kanal-a");

    fireEvent.keyDown(button, { key: "ArrowDown" });
    const reopenedOptions = within(screen.getByRole("listbox")).getAllByRole("option");
    const [reopenedFirstOption, reopenedSecondOption] = reopenedOptions;
    if (reopenedFirstOption === undefined || reopenedSecondOption === undefined) throw new Error("Der wieder geöffnete Kanalumschalter braucht zwei Optionen.");
    expect(document.activeElement).toBe(reopenedFirstOption);
    fireEvent.keyDown(reopenedFirstOption, { key: "ArrowDown" });
    fireEvent.keyDown(reopenedSecondOption, { key: "Enter" });
    await waitFor(() => expect(window.location.pathname).toBe("/channels/kanal-b"));
    expect(screen.getByRole("button", { name: "Kanal auswählen: Beta" })).toHaveFocus();

    fireEvent.keyDown(screen.getByRole("button", { name: "Kanal auswählen: Beta" }), { key: "ArrowDown" });
    const tabOptions = within(screen.getByRole("listbox")).getAllByRole("option");
    const tabOption = tabOptions[1];
    if (tabOption === undefined) throw new Error("Der Kanalumschalter braucht eine zweite Option.");
    fireEvent.keyDown(tabOption, { key: "Tab" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Abmelden" })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("button", { name: "Kanal auswählen: Beta" }), { key: "ArrowDown" });
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("hält alle Optionen offen, ohne dass die Brotkrume die Liste beschneidet", async () => {
    const channels = [
      healthyChannel("kanal-a", "Alpha"),
      healthyChannel("kanal-b", "Beta"),
      healthyChannel("kanal-c", "Gamma"),
    ];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels });
      if (path.endsWith("/overview")) return jsonResponse(overview(channels[0] as typeof channels[number]));
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    await screen.findByRole("heading", { name: "Alpha", level: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Kanal auswählen: Alpha" }));

    const listbox = screen.getByRole("listbox");
    expect(within(listbox).getAllByRole("option")).toHaveLength(3);
    expect(within(listbox).getByRole("option", { name: /Gamma/ })).toBeInTheDocument();

    const breadcrumb = screen.getByRole("navigation", { name: "Brotkrume" });
    // jsdom injiziert die importierte CSS-Datei nicht und berechnet keine
    // Layoutrechtecke; DOM-Struktur und die zugehoerige Regel halten deshalb
    // fest, dass alle Optionen existieren und nichts abschneidet.
    const styles = readFileSync(resolve(process.cwd(), "src/dashboard/styles.css"), "utf8");
    const breadcrumbRule = styles.match(/\.topbar__breadcrumb\s*\{[^}]*\}/)?.[0];
    expect(breadcrumb).toBeInTheDocument();
    expect(breadcrumbRule).toBeDefined();
    expect(breadcrumbRule).not.toMatch(/overflow\s*:\s*hidden/);
  });

  it("markiert Bereichs- und Modulsegment als separat ausblendbare Teile der Brotkrume", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path.endsWith("/overview")) return jsonResponse({ ...overview(channel), activeModules: [{ moduleId: "textbefehle", settings: "{}" }] });
      if (path.endsWith("/modules")) return jsonResponse({ modules: [{ id: "textbefehle", enabled: true, settings: "{}" }] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/modules/textbefehle");

    render(<DashboardApp />);

    const breadcrumb = screen.getByRole("navigation", { name: "Brotkrume" });
    await screen.findByRole("heading", { name: "Textbefehle", level: 1 });
    // jsdom berechnet keine CSS-Layouts; die Regression wird deshalb über die
    // eigene DOM-Klasse und die dazugehörige schmale CSS-Regel abgesichert.
    expect(breadcrumb.querySelector(".topbar__breadcrumb-area")).toBeInTheDocument();
    expect(breadcrumb.querySelector(".topbar__breadcrumb-module")).toBeInTheDocument();
    const styles = readFileSync(resolve(process.cwd(), "src/dashboard/styles.css"), "utf8");
    expect(styles).toMatch(/\.topbar__breadcrumb-area[\s\S]*?display:\s*none/);
    expect(styles).toMatch(/\.topbar__breadcrumb-module[\s\S]*?display:\s*none/);
  });

  it("lässt das Kanalsegment bei genau einem Kanal ohne Bedienelement", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path.endsWith("/overview")) return jsonResponse(overview(channel));
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    await screen.findByRole("heading", { name: "Alpha", level: 1 });
    expect(screen.queryByRole("button", { name: /Kanal auswählen/ })).not.toBeInTheDocument();
    const segment = document.querySelector(".topbar__channel-segment--static");
    expect(segment).toHaveTextContent("Alpha");
    expect(segment).not.toHaveAttribute("aria-haspopup");
  });

  it("zeigt die Brotkrume und die fünf Einträge der Schiene auf allen Bereichen und der Moduldetailseite", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const activeModuleOverview = { ...overview(channel), activeModules: [{ moduleId: "textbefehle", settings: "{}" }] };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path.endsWith("/overview")) return jsonResponse(path.includes("modules/textbefehle") ? activeModuleOverview : overview(channel));
      if (path.endsWith("/system")) return jsonResponse(system);
      if (path.endsWith("/audit-log")) return jsonResponse(audit);
      if (path.endsWith("/members")) return jsonResponse({ members: [], broadcasterCount: 1, viewerUserId: "viewer", nextCursor: null });
      if (path.endsWith("/modules")) return jsonResponse({ modules: [{ id: "textbefehle", enabled: true, settings: "{}" }] });
      if (path.endsWith("/events")) return jsonResponse({ entries: [], nextCursor: null });
      return jsonResponse({}, 404);
    }));

    const pages = [
      { path: "/", heading: "Übersicht", current: "BroBot" },
      { path: "/channels/kanal-a", heading: "Alpha", current: "Kanal" },
      { path: "/channels/kanal-a/system", heading: "System", current: "System" },
      { path: "/channels/kanal-a/members", heading: "Mitglieder", current: "Mitglieder" },
      { path: "/channels/kanal-a/modules", heading: "Module", current: "Module" },
      { path: "/channels/kanal-a/events", heading: "Ereignisse", current: "Ereignisse" },
      { path: "/channels/kanal-a/modules/textbefehle", heading: "Textbefehle", current: "Textbefehle" },
    ];

    for (const page of pages) {
      cleanup();
      window.history.replaceState({}, "", page.path);
      render(<DashboardApp />);
      await screen.findByRole("heading", { name: page.heading, level: 1 });
      const breadcrumb = screen.getByRole("navigation", { name: "Brotkrume" });
      expect(breadcrumb.querySelectorAll('[aria-current="page"]')).toHaveLength(1);
      expect(breadcrumb.querySelector('[aria-current="page"]')).toHaveTextContent(page.current);
      expect(within(screen.getByRole("navigation", { name: "Hauptnavigation" })).getAllByRole("link")).toHaveLength(5);
      if (page.path === "/") {
        expect(breadcrumb).toHaveTextContent("BroBot");
        expect(breadcrumb.querySelector('[aria-current="page"]')).toHaveTextContent("BroBot");
        expect(screen.getByRole("link", { name: "BroBot" })).toHaveAttribute("aria-current", "page");
      } else {
        expect(breadcrumb.querySelector(".topbar__channel-segment--static")).toHaveTextContent("Alpha");
      }
    }
  });

  it("führt die Marke als fokussierbaren Link auf die Kanalliste", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
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

  it("mountet beim Wechsel zur Modulroute nicht den alten Übersichtsstand", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const aktivesModul = { ...overview(channel), activeModules: [{ moduleId: "textbefehle", settings: "{}" }] };
    const deaktiviertesModul = overview(channel);
    let overviewAufrufe = 0;
    let loeseZweiteAntwortAuf!: (response: Response) => void;
    const zweiteAntwort = new Promise<Response>((resolve) => { loeseZweiteAntwortAuf = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path === "/api/channels/kanal-a/overview") {
        overviewAufrufe += 1;
        return overviewAufrufe === 1 ? jsonResponse(aktivesModul) : zweiteAntwort;
      }
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);
    const link = await screen.findByRole("link", { name: /Textbefehle ·/ });
    link.click();

    expect(screen.queryByRole("heading", { name: "Befehl anlegen" })).not.toBeInTheDocument();
    loeseZweiteAntwortAuf(jsonResponse(deaktiviertesModul));
    expect(await screen.findByText("Module werden geladen …")).toBeInTheDocument();
    expect(screen.queryByText("Das Modul „Textbefehle“ ist in diesem Kanal nicht aktiv.")).not.toBeInTheDocument();
  });

  it("meldet ein deaktiviertes Modul auf seiner Unterseite verständlich", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path === "/api/channels/kanal-a/overview") return jsonResponse(overview(channel));
      if (path === "/api/channels/kanal-a/modules") return jsonResponse({ modules: [{ id: "textbefehle", enabled: false, settings: "{}" }] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/modules/textbefehle");

    render(<DashboardApp />);

    expect(await screen.findByText("Das Modul „Textbefehle“ ist ausgeschaltet.")).toBeInTheDocument();
  });

  it("meldet ein unbekanntes Modul auf seiner Unterseite verständlich", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path === "/api/channels/kanal-a/overview") return jsonResponse(overview(channel));
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/modules/unbekannt");

    render(<DashboardApp />);

    expect(await screen.findByText("Das Modul „unbekannt“ ist nicht bekannt.")).toBeInTheDocument();
  });

  it("zeigt einen Kanal ohne Broadcaster-OAuth neutral und erreicht dessen Overview und System", async () => {
    const channel = { ...healthyChannel("kanal-a", "Alpha"), broadcasterConnection: "not_connected" };
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path === "/api/channels/kanal-a/overview") return jsonResponse({ ...overview(channel), broadcasterConnection: "not_connected" });
      if (path === "/api/channels/kanal-a/system") return jsonResponse({ ...system, broadcasterConnection: "not_connected" });
      if (path.endsWith("/audit-log")) return jsonResponse(audit);
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/");

    render(<DashboardApp />);
    const channelTaste = await screen.findByRole("link", { name: /Alpha/ });
    expect(screen.getByText("1 Kanal freigegeben")).toBeInTheDocument();
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

  it("zeigt einen fehlenden Moderatorstatus als roten Fehlerzustand", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      moderator: { isModerator: false, checkedAt: "2026-09-18T02:00:00.000Z", reason: "moderator_entfernt" },
      lastError: { source: "moderator", reason: "moderator_entfernt", at: "2026-09-18T02:00:00.000Z" },
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    const moderatorCard = await screen.findByRole("article", { name: "Moderatorstatus" });
    expect(moderatorCard).toHaveAttribute("data-status", "error");
    expect(moderatorCard).toHaveTextContent("Moderatorrolle fehlt");
  });

  it("zeigt das betroffene Abo im letzten Fehler auf Deutsch und Englisch", async () => {
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
    const zeigeKanal = async (): Promise<void> => {
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
        const path = requestUrl(input).pathname;
        if (path === "/api/channels") return jsonResponse({ channels: [channel] });
        if (path.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
        return jsonResponse({}, 404);
      }));
      window.history.replaceState({}, "", "/channels/kanal-a");
      render(<DashboardApp />);
      await screen.findByRole("heading", { name: "Alpha", level: 1 });
    };

    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });
    await zeigeKanal();
    expect(screen.getByText(/Moderationsereignisse: Forbidden/)).toBeInTheDocument();
    expect(screen.getByText(/Keine Berechtigung\./)).toBeInTheDocument();
    expect(screen.getByText(/HTTP 403/)).toBeInTheDocument();

    cleanup();
    vi.unstubAllGlobals();
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    await zeigeKanal();
    expect(screen.getByText(/Moderation events: Forbidden/)).toBeInTheDocument();
    cleanup();
    vi.unstubAllGlobals();
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });
  });

  it("zeigt fehlende Broadcaster-Zustimmung als Warnung und nur dem Broadcaster den Weg zur Nachforderung", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      channelBotConsent: "missing",
      lastError: null,
    };
    const zeigeKanal = (angezeigterKanal: typeof channel): void => {
      vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
        const path = requestUrl(input).pathname;
        if (path === "/api/channels") return jsonResponse({ channels: [angezeigterKanal] });
        if (path.endsWith("/overview")) return jsonResponse({ ...angezeigterKanal, activeModules: [] });
        return jsonResponse({}, 404);
      }));
      window.history.replaceState({}, "", "/channels/kanal-a");
      render(<DashboardApp />);
    };

    zeigeKanal(channel);

    expect((await screen.findAllByText("Broadcaster-Zustimmung fehlt")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Der Broadcaster muss Twitch erneut autorisieren.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Broadcaster-Zustimmung anfordern" })).toBeDisabled();

    cleanup();
    const broadcasterChannel = { ...channel, role: "broadcaster" };
    zeigeKanal(broadcasterChannel);

    const action = await screen.findByRole("link", { name: "Broadcaster-Zustimmung anfordern" });
    expect(action).toHaveAttribute("href", "/auth/channels/kanal-a/channel-bot");
    expect(screen.getByRole("article", { name: "Chat-Zustimmung" })).toHaveAttribute("data-status", "warning");
  });

  it("zeigt die letzte Moderatorprüfung und die Aktion nur für berechtigte Rollen", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      role: "verwalter",
      moderator: { isModerator: false, checkedAt: "2026-09-18T02:00:00.000Z", reason: "moderator_entfernt" },
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path.endsWith("/overview")) return jsonResponse({ ...channel, activeModules: [] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);

    await screen.findByRole("article", { name: "Moderatorstatus" });
    expect(within(screen.getByRole("article", { name: "Moderatorstatus" })).getByText("moderator_entfernt")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Moderatorstatus prüfen" })).toBeInTheDocument();

    cleanup();
    const operatorChannel = { ...channel, role: "bediener" };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [operatorChannel] });
      if (path.endsWith("/overview")) return jsonResponse({ ...operatorChannel, activeModules: [] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");
    render(<DashboardApp />);

    await screen.findByRole("article", { name: "Moderatorstatus" });
    expect(screen.getByRole("button", { name: "Moderatorstatus prüfen" })).toBeDisabled();
    expect(screen.getByText("Nur Broadcaster und Verwalter dürfen den Moderatorstatus prüfen.")).toBeInTheDocument();
  });

  it("zeigt während und nach der manuellen Prüfung eine Rückmeldung", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      role: "broadcaster",
      moderator: { isModerator: false, checkedAt: "2026-09-18T02:00:00.000Z", reason: "moderator_entfernt" },
    };
    let resolveCheck!: (response: Response) => void;
    const check = new Promise<Response>((resolve) => { resolveCheck = resolve; });
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel] }));
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

    // Gesunde Zustände bleiben sichtbar und tragen weiterhin eine grüne LED.
    await waitFor(() => expect(screen.getAllByText(/Letzte Prüfung:/).length).toBeGreaterThanOrEqual(1));
    expect(screen.getByRole("article", { name: "Moderatorstatus" })).toHaveAttribute("data-status", "healthy");
    expect(screen.getAllByText(/Letzte Prüfung:/).length).toBeGreaterThanOrEqual(1);
  });

  it("reaktiviert die Moderatorprüfung nach Ablauf der Sperrzeit", async () => {
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
        if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel] }));
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

  it("zeigt Twitch-Fehler an und behält den bisherigen Moderatorstand", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      moderator: { isModerator: true, checkedAt: "2026-09-18T02:00:00.000Z", reason: null },
    };
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel] }));
      if (url.pathname === "/api/channels/kanal-a/overview") return Promise.resolve(jsonResponse({ ...channel, activeModules: [] }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (url.pathname === "/api/channels/kanal-a/moderator-status") return Promise.resolve(jsonResponse({ error: "Twitch ist vorübergehend nicht erreichbar." }, 502));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);
    fireEvent.click(await screen.findByRole("button", { name: "Moderatorstatus prüfen" }));

    expect(await screen.findByText("Twitch ist vorübergehend nicht erreichbar.", { selector: "p" })).toBeInTheDocument();
    expect(screen.queryByText("Nicht geprüft")).not.toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Moderatorstatus" })).toHaveAttribute("data-status", "healthy");
  });

  it("zeigt fehlende Token-Ablaufdaten nicht als gültig oder gesund", async () => {
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
      if (path === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel] }));
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

  it("zeigt einen funktionierenden Kanal mit drei Stunden Restlaufzeit als gesund", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel] }));
      if (path.endsWith("/overview")) return Promise.resolve(jsonResponse({ ...channel, activeModules: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));
    window.history.replaceState({}, "", "/");

    render(<DashboardApp />);

    const channelTaste = await screen.findByRole("link", { name: /Alpha/ });
    expect(channelTaste).toHaveAttribute("data-status", "green");
    expect(within(channelTaste).getByText("Gesund", { selector: "span" })).toBeInTheDocument();
    expect(within(channelTaste).queryByText("Warnung")).not.toBeInTheDocument();

    // Gesunde Zustände bleiben auf der Kanalseite sichtbar.
    fireEvent.click(screen.getByRole("link", { name: /Alpha/ }));
    await screen.findByRole("heading", { name: "Alpha", level: 1 });
    expect(screen.getByRole("article", { name: "Token-Zustand" })).toHaveAttribute("data-status", "healthy");
    expect(screen.getByRole("article", { name: "Bot-Account" })).toHaveAttribute("data-status", "healthy");
  });

  it("bleibt gesund, solange der Ablauf nur turnusmäßig näherrückt", async () => {
    // Bei vierstündigen Twitch-Tokens und stündlichem Cron steht jedes Token
    // regelmäßig bis zu einer Stunde im Erneuerungsfenster. Das ist der
    // Normalfall und darf nicht warnen — sonst warnt die Anzeige alle vier
    // Stunden knapp eine Stunde lang und verliert ihre Aussagekraft.
    const basis = healthyChannel("kanal-a", "Alpha");
    const channel = {
      ...basis,
      // Der letzte Lauf liegt VOR dem Zeitpunkt, ab dem erneuert werden muss.
      bot: { ...basis.bot, updatedAt: relativeIso(-45 * 60 * 1000) },
      tokens: {
        ...basis.tokens,
        botExpiresAt: relativeIso(30 * 60 * 1000),
        loginExpiresAt: relativeIso(30 * 60 * 1000),
      },
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel] }));
      if (path.endsWith("/overview")) return Promise.resolve(jsonResponse({ ...channel, activeModules: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));
    window.history.replaceState({}, "", "/");

    render(<DashboardApp />);

    const channelTaste = await screen.findByRole("link", { name: /Alpha/ });
    expect(channelTaste).toHaveAttribute("data-status", "green");
    expect(within(channelTaste).queryByText("Erneuerung überfällig")).not.toBeInTheDocument();
  });

  it("warnt, wenn ein Wartungslauf das fällige Token nicht erneuert hat", async () => {
    // Gleiche Restlaufzeit wie oben — aber der Cron ist seitdem gelaufen und
    // hat nichts erneuert. Das ist der Fall, der tatsächlich kaputt ist.
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
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel] }));
      if (path.endsWith("/overview")) return Promise.resolve(jsonResponse({ ...channel, activeModules: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));
    window.history.replaceState({}, "", "/");

    render(<DashboardApp />);

    const channelTaste = await screen.findByRole("link", { name: /Alpha/ });
    expect(channelTaste).toHaveAttribute("data-status", "amber");
    expect(within(channelTaste).getByText("Erneuerung überfällig", { selector: "span" })).toBeInTheDocument();
  });

  it("warnt bei einem seit mehr als einem Wartungsintervall veralteten Lauf", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      bot: { status: "connected", reason: null, updatedAt: relativeIso(-(60 * 60 * 1000 + 1)) },
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel] }));
      if (path.endsWith("/overview")) return Promise.resolve(jsonResponse({ ...channel, activeModules: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));
    window.history.replaceState({}, "", "/");

    render(<DashboardApp />);

    const channelTaste = await screen.findByRole("link", { name: /Alpha/ });
    expect(channelTaste).toHaveAttribute("data-status", "amber");
    expect(within(channelTaste).getByText("Wartung überfällig", { selector: "span" })).toBeInTheDocument();
  });

  it("verwirft beim Kanalwechsel den alten Datenstand vor der neuen Antwort", async () => {
    const alpha = healthyChannel("kanal-a", "Alpha");
    const beta = healthyChannel("kanal-b", "Beta");
    let resolveAlpha: ((response: Response) => void) | undefined;
    const alphaResponse = new Promise<Response>((resolve) => {
      resolveAlpha = resolve;
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return Promise.resolve(jsonResponse({ channels: [alpha, beta] }));
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

  it("verwirft beim Kanalwechsel eine verspätete, unterscheidbare Systemantwort", async () => {
    const alpha = healthyChannel("kanal-a", "Alpha");
    const beta = healthyChannel("kanal-b", "Beta");
    let resolveAlphaSystem: ((response: Response) => void) | undefined;
    const alphaSystem = new Promise<Response>((resolve) => {
      resolveAlphaSystem = resolve;
    });
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [alpha, beta] }));
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

  it("mischt eine verspätete Audit-Antwort nicht in den nächsten Kanal", async () => {
    const alpha = healthyChannel("kanal-a", "Alpha");
    const beta = healthyChannel("kanal-b", "Beta");
    let resolveAlphaAudit: ((response: Response) => void) | undefined;
    const alphaAudit = new Promise<Response>((resolve) => {
      resolveAlphaAudit = resolve;
    });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [alpha, beta] }));
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

  it("führt bei einer mit 401 abgewiesenen Abmeldung zur Anmeldung und entfernt geschützte Daten", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel] });
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

  it("bleibt bei einer mit 403 abgewiesenen Abmeldung angemeldet und meldet den Fehler", async () => {
    // 403 heisst, dass das CSRF-Token nicht passte — der Worker hat die Session
    // nicht widerrufen. Wer hier zur Anmeldung fuehrt, meldet eine Abmeldung,
    // die nicht stattgefunden hat: nach einem Neuladen ist der Nutzer wieder da.
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel] });
      if (url.pathname === "/api/csrf") return jsonResponse({ token: "csrf-token" });
      if (url.pathname === "/auth/logout" && init?.method === "POST") return jsonResponse({}, 403);
      if (url.pathname.endsWith("/overview")) return jsonResponse(overview(channel));
      return jsonResponse({}, 404);
    }));

    render(<DashboardApp />);
    await screen.findByRole("heading", { name: "Übersicht", level: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Abmelden" })).toBeEnabled();
    });
    expect(screen.queryByRole("heading", { name: "Anmeldung erforderlich", level: 1 }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Übersicht", level: 1 })).toBeInTheDocument();
  });

  it("holt vor dem Logout den CSRF-Token und sendet ihn im Header", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return jsonResponse({ channels: [channel] });
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

  it("ordnet die Abonnementliste und ihren Inspector als direkte Bereichskinder an", async () => {
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
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path.endsWith("/system")) return jsonResponse({ ...system, subscriptions });
      if (path.endsWith("/audit-log")) return jsonResponse(audit);
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/system");

    render(<DashboardApp />);

    const row = (await screen.findByText("Chat-Nachrichten")).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(row as HTMLElement);
    const bereich = screen.getByRole("region", { name: "Abonnements" });
    expect(bereich.children).toHaveLength(2);
    expect(bereich.children[0]).toHaveClass("inspektor-bereich__liste");
    expect(bereich.children[1]).toHaveClass("sub-inspector");
  });

  it("ordnet Audit-Liste und Inspector als direkte Bereichskinder an", async () => {
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
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path.endsWith("/system")) return jsonResponse(system);
      if (path.endsWith("/audit-log")) return jsonResponse({ entries: [entry], nextCursor: null });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/system");

    render(<DashboardApp />);

    const row = (await screen.findByText("module.enabled")).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(row as HTMLElement);
    const bereich = screen.getByRole("heading", { name: "Audit-Log" }).closest("section");
    if (bereich === null) throw new Error("Audit-Bereich fehlt");
    expect(bereich.children).toHaveLength(2);
    expect(bereich.children[0]).toHaveClass("inspektor-bereich__liste");
    expect(bereich.children[1]).toHaveClass("sub-inspector");
  });

  it("behält die Audit-Auswahl beim erneuten Nachladen bestehen", async () => {
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
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path.endsWith("/system")) return jsonResponse(system);
      if (path.endsWith("/audit-log")) {
        auditRequests += 1;
        return auditRequests === 1 ? jsonResponse({ entries: [entry], nextCursor: null }) : reload;
      }
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/system");

    render(<DashboardApp />);

    const row = (await screen.findByText("module.enabled")).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(row as HTMLElement);
    expect(await screen.findByRole("region", { name: "Änderungsdaten" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("link", { name: "System" }));
    await waitFor(() => expect(auditRequests).toBe(2));
    resolveReload?.(jsonResponse({ entries: [entry], nextCursor: null }));

    const restoredRow = (await screen.findAllByRole("row", { name: /module.enabled/ }))[0];
    expect(restoredRow).toBeDefined();
    expect(restoredRow).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByRole("region", { name: "Änderungsdaten" })).toBeInTheDocument();
  });

  it("ordnet Ereignisliste und Vorgangs-Inspector als direkte Bereichskinder an", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const entry = {
      eventId: "event-1",
      createdAt: "2026-09-18T04:00:00.000Z",
      moduleId: "textbefehle",
      triggerId: "trigger-1",
      code: "textbefehle.ausgeloest",
      detail: '{"name":"wiki","antwort":"Antwort"}',
      actorUserId: "user-1",
      actorLogin: "alice",
      actorDisplayName: "Alice",
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path.endsWith("/events")) return jsonResponse({ entries: [entry], nextCursor: null });
      if (path.endsWith("/modules")) return jsonResponse({ modules: [] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    const row = (await screen.findByText("Befehl !wiki ausgeführt")).closest("tr");
    expect(row).not.toBeNull();
    fireEvent.click(row as HTMLElement);
    const bereich = screen.getByRole("heading", { name: "Ereignisprotokoll" }).closest("section");
    if (bereich === null) throw new Error("Ereignis-Bereich fehlt");
    expect(bereich.children).toHaveLength(2);
    expect(bereich.children[0]).toHaveClass("inspektor-bereich__liste");
    expect(bereich.children[1]).toHaveClass("sub-inspector");
  });

  it("behält den Ereignis-Vorgang beim erneuten Nachladen bestehen", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const entry = {
      eventId: "event-1",
      createdAt: "2026-09-18T04:00:00.000Z",
      moduleId: "textbefehle",
      triggerId: "trigger-1",
      code: "textbefehle.ausgeloest",
      detail: '{"name":"wiki","antwort":"Antwort"}',
      actorUserId: "user-1",
      actorLogin: "alice",
      actorDisplayName: "Alice",
    };
    let eventRequests = 0;
    let resolveReload: ((response: Response) => void) | undefined;
    const reload = new Promise<Response>((resolve) => { resolveReload = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
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

  it("zeigt die beiden Scope-Listen als gewöhnliche Bereiche ohne Inspector-Klasse", async () => {
    const channel = {
      ...healthyChannel("kanal-a", "Alpha"),
      botPermissions: { missingScopes: ["user:bot"] },
      broadcasterPermissions: { missingScopes: ["channel:manage:broadcast"] },
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
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

  it("schließt den Abonnement-Inspector per Taste und Escape mit Fokus auf der Zeile", async () => {
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
      if (path === "/api/channels") return jsonResponse({ channels: [channel, beta] });
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
    fireEvent.click(screen.getByRole("button", { name: "Kanal auswählen: Alpha" }));
    const option = within(screen.getByRole("listbox", { name: "Kanal auswählen" })).getByRole("option", { name: /Alpha/ });
    fireEvent.keyDown(option, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Kanal auswählen" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Abo-Details" })).toBeInTheDocument();
  });

  it("schließt den Audit-Inspector per Taste und Escape mit Fokus auf der Zeile", async () => {
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
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path.endsWith("/system")) return jsonResponse(system);
      if (path.endsWith("/audit-log")) return jsonResponse({ entries: [entry], nextCursor: null });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/system");

    render(<DashboardApp />);

    const row = (await screen.findByText("module.enabled")).closest("tr");
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

  it("schließt den Ereignis-Inspector per Taste und Escape mit Fokus auf der Zeile", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const entry = {
      eventId: "event-1",
      createdAt: "2026-09-18T04:00:00.000Z",
      moduleId: "textbefehle",
      triggerId: "trigger-1",
      code: "textbefehle.ausgeloest",
      detail: '{"name":"wiki","antwort":"Antwort"}',
      actorUserId: "user-1",
      actorLogin: "alice",
      actorDisplayName: "Alice",
    };
    vi.stubGlobal("WebSocket", TestWebSocket);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
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
});
