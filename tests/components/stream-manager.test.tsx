import type { ReactElement } from "react";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { ImmediateActions, WarningsAndErrorsFeed } from "../../src/dashboard/stream-manager";

const renderWithMantine = (element: ReactElement): ReturnType<typeof render> => render(<UiProvider>{element}</UiProvider>);

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

const ADS_ENABLED = [{ id: "ads", enabled: true }] as const;
const RAID_ENABLED = [{ id: "raid", enabled: true }] as const;
const CLIPS_ENABLED = [{ id: "clips", enabled: true }] as const;
const ALL_ACTIONS_ENABLED = [
  { id: "ads", enabled: true },
  { id: "raid", enabled: true },
  { id: "clips", enabled: true },
] as const;

const requestUrl = (input: RequestInfo | URL): URL =>
  input instanceof Request ? new URL(input.url) : new URL(String(input), window.location.origin);

class FeedWebSocket {
  static instances: FeedWebSocket[] = [];
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(readonly url: string, readonly protocols: string | string[]) {
    FeedWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener !== "function") return;
    const listeners = this.listeners.get(type) ?? new Set<(event: Event) => void>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  open(): void {
    for (const listener of this.listeners.get("open") ?? []) listener(new Event("open"));
  }

  receive(data: string): void {
    for (const listener of this.listeners.get("message") ?? []) listener(new MessageEvent("message", { data }));
  }

  close(code = 1000, reason = ""): void {
    for (const listener of this.listeners.get("close") ?? []) listener(new CloseEvent("close", { code, reason }));
  }
}

describe("Stream Manager immediate actions", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("runs a commercial and reports success at the button, not a toast", async () => {
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (path === "/api/channels/kanal-a/modules/ads/commercial" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ length: 60, message: null, retryAfter: 480 }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    renderWithMantine(<ImmediateActions channelId="kanal-a" streamState="online" modules={ADS_ENABLED} />);

    fireEvent.click(await screen.findByRole("button", { name: /Werbung jetzt/ }));

    expect(await screen.findByText("Werbung gestartet (60s)")).toBeInTheDocument();
    expect(fetcher.mock.calls.some(([input, init]) =>
      requestUrl(input).pathname === "/api/channels/kanal-a/modules/ads/commercial" && init?.method === "POST")).toBe(true);
  });

  it("disables the commercial action and explains why for a known offline stream", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    renderWithMantine(<ImmediateActions channelId="kanal-a" streamState="offline" modules={ADS_ENABLED} />);

    const button = await screen.findByRole("button", { name: /Werbung jetzt/ });
    expect(button).toBeDisabled();
    expect(screen.getAllByText("Der Stream ist offline.")).toHaveLength(1);
    expect(button).toHaveAttribute("aria-describedby", expect.stringContaining("stream-manager-ads-availability-reason"));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps each action's control and button inside its own card, button pinned last", async () => {
    renderWithMantine(<ImmediateActions channelId="kanal-a" streamState="online" modules={ALL_ACTIONS_ENABLED} />);

    const adButton = await screen.findByRole("button", { name: /Werbung jetzt/ });
    const shoutoutButton = await screen.findByRole("button", { name: "Shoutout senden" });
    const adCard = adButton.closest(".stream-manager-action");
    const adLength = within(adCard as HTMLElement).getByRole("radiogroup");
    expect(adCard).toContainElement(adLength);
    expect(adCard?.lastElementChild).toBe(adButton);

    const shoutoutCard = shoutoutButton.closest(".stream-manager-action");
    const shoutoutLogin = screen.getByLabelText("Twitch-Name");
    expect(shoutoutCard).toContainElement(shoutoutLogin);
    expect(shoutoutCard?.lastElementChild).toBe(shoutoutButton);
    expect(shoutoutButton).toBeDisabled();
    // Exactly one helper line under the field: the reason, not the hint beside it.
    expect(screen.getByText("Bitte gib einen Twitch-Namen ein.")).toBeInTheDocument();
    expect(screen.queryByText("Twitch-Name des Kanals, den du empfiehlst.")).not.toBeInTheDocument();
    expect(within(shoutoutCard as HTMLElement).getAllByText(/Twitch-Name|Bitte gib/u).length).toBeLessThanOrEqual(2);
    expect(shoutoutButton).toHaveAttribute("aria-describedby", expect.stringContaining("stream-manager-shoutout-login-description"));
  });

  it("shows the hint instead of the reason once a login is entered, still one helper line", async () => {
    renderWithMantine(<ImmediateActions channelId="kanal-a" streamState="online" modules={RAID_ENABLED} />);

    fireEvent.change(await screen.findByLabelText("Twitch-Name"), { target: { value: "streamerin" } });

    expect(screen.getByText("Twitch-Name des Kanals, den du empfiehlst.")).toBeInTheDocument();
    expect(screen.queryByText("Bitte gib einen Twitch-Namen ein.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Shoutout senden" })).not.toHaveAttribute("aria-describedby");
  });

  it("offers all six ad lengths as a segment and runs the one that's clicked", async () => {
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (path === "/api/channels/kanal-a/modules/ads/commercial" && init?.method === "POST") {
        expect(JSON.parse(typeof init.body === "string" ? init.body : "{}") as unknown).toEqual({ length: 180 });
        return Promise.resolve(jsonResponse({ length: 180, message: null, retryAfter: 480 }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    renderWithMantine(<ImmediateActions channelId="kanal-a" streamState="online" modules={ADS_ENABLED} />);

    await screen.findByRole("heading", { name: "Werbung", level: 3 });
    const group = screen.getByRole("radiogroup", { name: "Werbedauer" });
    for (const seconds of ["30", "60", "90", "120", "150", "180"]) {
      expect(within(group).getByRole("radio", { name: `${seconds}s` })).toBeInTheDocument();
    }
    fireEvent.click(within(group).getByRole("radio", { name: "180s" }));
    fireEvent.click(await screen.findByRole("button", { name: "Werbung jetzt (180s)" }));

    expect(await screen.findByText("Werbung gestartet (180s)")).toBeInTheDocument();
  });

  it("strips a leading @ from the shoutout login and sends the bare name", async () => {
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (path === "/api/channels/kanal-a/shoutout" && init?.method === "POST") {
        expect(JSON.parse(typeof init.body === "string" ? init.body : "{}") as unknown).toEqual({ login: "streamerin" });
        return Promise.resolve(jsonResponse({ sent: true }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    renderWithMantine(<ImmediateActions channelId="kanal-a" streamState="online" modules={RAID_ENABLED} />);

    fireEvent.change(screen.getByLabelText("Twitch-Name"), { target: { value: "@streamerin" } });
    expect(screen.getByLabelText("Twitch-Name")).toHaveValue("streamerin");
    fireEvent.click(screen.getByRole("button", { name: "Shoutout senden" }));

    expect(await screen.findByText("Shoutout an streamerin gesendet")).toBeInTheDocument();
  });

  it("lays out the three actions as equal cards in one grid, each with a header icon and title", async () => {
    const { container } = renderWithMantine(<ImmediateActions channelId="kanal-a" streamState="online" modules={ALL_ACTIONS_ENABLED} />);
    await screen.findByRole("heading", { name: "Werbung", level: 3 });

    const grid = container.querySelector(".stream-manager-actions");
    const cards = grid?.querySelectorAll(":scope > .stream-manager-action");
    expect(cards).toHaveLength(3);
    const titles = Array.from(cards ?? [], (card) => card.querySelector(".stream-manager-action__header")?.textContent);
    expect(titles).toEqual(["Werbung", "Shoutout", "Clip"]);
    for (const card of cards ?? []) {
      expect(card.querySelector(".stream-manager-action__header .ui-icon")).toBeInTheDocument();
    }
  });

  it("renders the ads action card only while the ads module is enabled", async () => {
    const { container, unmount } = renderWithMantine(
      <ImmediateActions channelId="kanal-a" modules={[{ id: "ads", enabled: false }]} />,
    );
    expect(container.querySelector(".stream-manager-action__header h3")?.textContent).not.toBe("Werbung");
    unmount();

    renderWithMantine(<ImmediateActions channelId="kanal-a" modules={ADS_ENABLED} />);
    expect(await screen.findByRole("heading", { name: "Werbung", level: 3 })).toBeInTheDocument();
  });

  it("renders no action card without an enabled module contribution", () => {
    const { container } = renderWithMantine(<ImmediateActions channelId="kanal-a" streamState="online" />);
    expect(container.querySelectorAll(".stream-manager-actions > .stream-manager-action")).toHaveLength(0);
  });

  it("omits a disabled clips module action", () => {
    const { container } = renderWithMantine(
      <ImmediateActions channelId="kanal-a" streamState="online" modules={[{ id: "clips", enabled: false }]} />,
    );
    expect(container.querySelector(".stream-manager-action__header h3")?.textContent).not.toBe("Clip");
  });

  it("disables clip creation with an accessible reason while the stream is offline", () => {
    renderWithMantine(<ImmediateActions channelId="kanal-a" streamState="offline" modules={CLIPS_ENABLED} />);

    const button = screen.getByRole("button", { name: "Clip erstellen" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-describedby", expect.stringContaining("stream-manager-clips-availability-reason"));
    expect(screen.getAllByText("Der Stream ist offline.")).toHaveLength(1);
  });

  it("disables a stream-live action with a catalogue reason when stream state is unknown", async () => {
    renderWithMantine(<ImmediateActions channelId="kanal-a" modules={CLIPS_ENABLED} />);

    const button = await screen.findByRole("button", { name: "Clip erstellen" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-describedby", "stream-manager-clips-availability-reason");
    expect(screen.getByText("Der Streamstatus ist derzeit nicht verfügbar.")).toBeInTheDocument();
  });

  it("shows the matching aria-hidden Tabler icon without changing each action's accessible name", async () => {
    renderWithMantine(<ImmediateActions channelId="kanal-a" streamState="online" modules={ALL_ACTIONS_ENABLED} />);
    await screen.findByRole("button", { name: /Werbung jetzt \(60s\)/u });

    for (const [name, iconName] of [
      [/Werbung jetzt \(60s\)/u, "ad"],
      ["Shoutout senden", "shoutout"],
      ["Clip erstellen", "clip"],
    ] as const) {
      const button = screen.getByRole("button", { name });
      expect(button).toHaveAccessibleName(name);
      expect(button.querySelector("svg[aria-hidden='true']"), iconName).not.toBeNull();
      expect(button.textContent).not.toContain(iconName);
    }
  });

  it("reports a failed commercial start inline, without touching the shoutout or clip actions", async () => {
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (path === "/api/channels/kanal-a/modules/ads/commercial" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ error: "commercial_start_failed", reason: "scope_missing" }, 403));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    renderWithMantine(<ImmediateActions channelId="kanal-a" streamState="online" modules={ADS_ENABLED} />);

    fireEvent.click(await screen.findByRole("button", { name: /Werbung jetzt/ }));

    expect(await screen.findByText("Die Werbeeinblendung konnte nicht gestartet werden.")).toBeInTheDocument();
    expect(screen.queryByText("Clip erstellt")).not.toBeInTheDocument();
  });

  it("sends a shoutout by login and reports success at the button", async () => {
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (path === "/api/channels/kanal-a/shoutout" && init?.method === "POST") {
        expect(JSON.parse(typeof init.body === "string" ? init.body : "{}") as unknown).toEqual({ login: "streamerin" });
        return Promise.resolve(jsonResponse({ sent: true }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    renderWithMantine(<ImmediateActions channelId="kanal-a" streamState="online" modules={RAID_ENABLED} />);

    fireEvent.change(screen.getByLabelText("Twitch-Name"), { target: { value: "streamerin" } });
    fireEvent.click(screen.getByRole("button", { name: "Shoutout senden" }));

    expect(await screen.findByText("Shoutout an streamerin gesendet")).toBeInTheDocument();
  });

  it("shows the catalogue reason when a manual shoutout fails", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (path === "/api/channels/kanal-a/shoutout" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ error: "shoutout_send_failed", reason: "rate_limited" }, 429));
      }
      return Promise.resolve(jsonResponse({}, 404));
    }));
    renderWithMantine(<ImmediateActions channelId="kanal-a" streamState="online" modules={RAID_ENABLED} />);

    fireEvent.change(screen.getByLabelText("Twitch-Name"), { target: { value: "streamerin" } });
    fireEvent.click(screen.getByRole("button", { name: "Shoutout senden" }));

    expect(await screen.findByText("Twitch-Abklingzeit aktiv")).toBeInTheDocument();
  });

  it.each([
    ["twitch_user_not_found", "Twitch-Nutzer nicht gefunden."],
    ["twitch_user_search_failed", "Twitch-Nutzersuche ist fehlgeschlagen."],
  ])("localizes a top-level %s error when a manual shoutout fails", async (code, message) => {
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (path === "/api/channels/kanal-a/shoutout" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ error: code }, code === "twitch_user_not_found" ? 404 : 502));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    renderWithMantine(<ImmediateActions channelId="kanal-a" streamState="online" modules={RAID_ENABLED} />);

    fireEvent.change(screen.getByLabelText("Twitch-Name"), { target: { value: "streamerin" } });
    fireEvent.click(screen.getByRole("button", { name: "Shoutout senden" }));

    expect(await screen.findByText(message)).toBeInTheDocument();
  });

  it("creates a clip and offers a link to it", async () => {
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (path === "/api/channels/kanal-a/clips" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ clipId: "clip-1", editUrl: "https://clips.twitch.tv/clip-1/edit" }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    renderWithMantine(<ImmediateActions channelId="kanal-a" streamState="online" modules={CLIPS_ENABLED} />);

    fireEvent.click(screen.getByRole("button", { name: "Clip erstellen" }));

    expect(await screen.findByText("Clip erstellt")).toBeInTheDocument();
    const openClip = screen.getByRole("link", { name: "Clip öffnen (öffnet neuen Tab)" });
    expect(openClip).toHaveAccessibleName("Clip öffnen (öffnet neuen Tab)");
    expect(openClip).toHaveAttribute("href", "https://clips.twitch.tv/clip-1/edit");
    expect(openClip.querySelector("svg[aria-hidden='true']")).toBeInTheDocument();
  });

  it("ignores a second click on the same action while the first is in flight", async () => {
    let resolvePatch: ((response: Response) => void) | undefined;
    const pending = new Promise<Response>((resolve) => { resolvePatch = resolve; });
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (path === "/api/channels/kanal-a/clips" && init?.method === "POST") return pending;
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    renderWithMantine(<ImmediateActions channelId="kanal-a" streamState="online" modules={CLIPS_ENABLED} />);

    const button = screen.getByRole("button", { name: "Clip erstellen" });
    fireEvent.click(button);
    await waitFor(() => { expect(button).toBeDisabled(); });
    fireEvent.click(button);

    resolvePatch?.(jsonResponse({ clipId: "clip-1", editUrl: null }));
    await screen.findByText("Clip erstellt");

    expect(fetcher.mock.calls.filter(([input, init]) =>
      requestUrl(input).pathname === "/api/channels/kanal-a/clips" && init?.method === "POST")).toHaveLength(1);
  });
});

describe("Stream Manager warnings and errors feed", () => {
  afterEach(() => {
    cleanup();
    FeedWebSocket.instances = [];
    vi.unstubAllGlobals();
  });

  it("excludes ordinary channel events, limits the feed to three alerts, and links to the filtered event log", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels/kanal-a/events") {
        return Promise.resolve(jsonResponse({
          entries: [
            { eventId: "raid", createdAt: "2026-09-22T10:05:00.000Z", moduleId: "channel_events", triggerId: "t0", code: "channel_events.raid.incoming", detail: "{\"source\":\"sensitron\",\"viewers\":1}", actorUserId: null, actorLogin: null, actorDisplayName: null },
            { eventId: "ad", createdAt: "2026-09-22T10:04:00.000Z", moduleId: "ads", triggerId: "t2", code: "ads.commercial.failed", detail: "{\"reason\":\"rate_limited\"}", actorUserId: null, actorLogin: null, actorDisplayName: null },
            { eventId: "clip", createdAt: "2026-09-22T10:03:00.000Z", moduleId: "host", triggerId: "t3", code: "host.clip.failed", detail: "{}", actorUserId: null, actorLogin: null, actorDisplayName: null },
            { eventId: "warning", createdAt: "2026-09-22T10:02:00.000Z", moduleId: "raid", triggerId: "t5", code: "raid.invalid", detail: "{}", actorUserId: null, actorLogin: null, actorDisplayName: null },
            { eventId: "chat", createdAt: "2026-09-22T10:01:00.000Z", moduleId: "host", triggerId: "t4", code: "host.chat.failed", detail: "{}", actorUserId: null, actorLogin: null, actorDisplayName: null },
            { eventId: "sub", createdAt: "2026-09-22T10:00:00.000Z", moduleId: "channel_events", triggerId: "t6", code: "channel_events.chat.sub", detail: "{}", actorUserId: null, actorLogin: null, actorDisplayName: null },
          ],
          nextCursor: null,
        }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    }));

    const onNavigate = vi.fn();
    renderWithMantine(<WarningsAndErrorsFeed channelId="kanal-a" onNavigate={onNavigate} />);

    const adText = await screen.findByText("Werbeeinblendung nicht gestartet: Twitch-Abklingzeit aktiv");
    expect(screen.getByText("Raid verworfen: ungültige Daten")).toBeInTheDocument();
    expect(screen.queryByText("Chat-Nachricht fehlgeschlagen")).not.toBeInTheDocument();
    expect(screen.queryByText(/Raid von sensitron/u)).not.toBeInTheDocument();
    expect(screen.queryByText(/Sub von/u)).not.toBeInTheDocument();
    expect(screen.getByRole("list").querySelectorAll("li")).toHaveLength(3);
    const link = adText.closest("a");
    expect(link).toHaveAttribute("href", "/channels/kanal-a/events?tone=warning&tone=error");
    expect(link?.querySelector(".event-chip")).toHaveAttribute("data-tone", "error");
    expect(link?.querySelector("time")).toHaveAttribute("title", "2026-09-22T10:04:00.000Z");
    fireEvent.click(link as HTMLAnchorElement);
    expect(onNavigate).toHaveBeenCalledWith({
      kind: "channel", channelId: "kanal-a", section: "events",
      filters: { origin: null, module: null, tone: null, tones: ["warning", "error"], person: null },
    });
  });

  it("shows day labels for older entries and sorts the feed newest first", async () => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10, 20);
    const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 9, 30);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels/kanal-a/events") {
        return Promise.resolve(jsonResponse({
          entries: [
            { eventId: "older", createdAt: yesterday.toISOString(), moduleId: "raid", triggerId: "t1", code: "raid.invalid", detail: "{}", actorUserId: null, actorLogin: null, actorDisplayName: null },
            { eventId: "newer", createdAt: today.toISOString(), moduleId: "ads", triggerId: "t2", code: "ads.commercial.failed", detail: "{\"reason\":\"rate_limited\"}", actorUserId: null, actorLogin: null, actorDisplayName: null },
          ],
          nextCursor: null,
        }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    }));

    const { container } = renderWithMantine(<WarningsAndErrorsFeed channelId="kanal-a" />);

    await screen.findByText("Raid verworfen: ungültige Daten");
    const times = Array.from(container.querySelectorAll(".stream-manager-feed__time"), (time) => time.textContent);
    expect(times).toEqual(["10:20", "Gestern 09:30"]);
    expect(container.querySelector(".stream-manager-feed")?.firstElementChild).toHaveTextContent("Werbeeinblendung nicht gestartet: Twitch-Abklingzeit aktiv");
  });

  it("refreshes new warning and error entries from the event log's realtime feed", async () => {
    vi.stubGlobal("WebSocket", FeedWebSocket);
    const existing = {
      eventId: "existing",
      createdAt: "2026-09-22T10:00:00.000Z",
      moduleId: "ads",
      triggerId: "commercial",
      code: "ads.commercial.failed",
      detail: "{\"reason\":\"stream_offline\"}",
      actorUserId: null,
      actorLogin: null,
      actorDisplayName: null,
    };
    let requests = 0;
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      if (requestUrl(input).pathname === "/api/channels/kanal-a/events") {
        requests += 1;
        const next = {
          eventId: "realtime-error",
          createdAt: "2026-09-22T10:01:00.000Z",
          moduleId: "host",
          triggerId: "new-error",
          code: "host.action.failed",
          detail: "{}",
          actorUserId: null,
          actorLogin: null,
          actorDisplayName: null,
        };
        return Promise.resolve(jsonResponse({ entries: requests === 1 ? [existing] : [next, existing], nextCursor: null }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    }));

    renderWithMantine(<WarningsAndErrorsFeed channelId="kanal-a" />);

    expect(await screen.findByText("Werbeeinblendung nicht gestartet: Stream ist offline")).toBeInTheDocument();
    const socket = FeedWebSocket.instances[0];
    if (socket === undefined) throw new Error("Realtime-Socket fehlt");
    socket.open();
    socket.receive(JSON.stringify({
      version: 1,
      id: "hint-1",
      createdAt: "2026-09-22T10:01:00.000Z",
      channelId: "kanal-a",
      type: "event_log.new",
      payload: { entries: [{ eventId: "realtime-error", createdAt: "2026-09-22T10:01:00.000Z", moduleId: "host", code: "host.action.failed", actorUserId: null }] },
    }));

    expect(await screen.findByText("Aktion fehlgeschlagen")).toBeInTheDocument();
    expect(requests).toBe(2);
  });

  it("shows an empty state when there is nothing to warn about", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels/kanal-a/events") return Promise.resolve(jsonResponse({ entries: [], nextCursor: null }));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    renderWithMantine(<WarningsAndErrorsFeed channelId="kanal-a" />);

    expect(await screen.findByText("Keine Warnungen oder Fehler.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Alle im Ereignisprotokoll" })).toHaveAttribute(
      "href", "/channels/kanal-a/events?tone=warning&tone=error",
    );
  });

  it("shows the cause icon for a row with a diagnostic cause, named after that row's own text", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels/kanal-a/events") {
        return Promise.resolve(jsonResponse({
          entries: [
            { eventId: "clip", createdAt: "2026-09-22T10:03:00.000Z", moduleId: "host", triggerId: "t3", code: "host.clip.failed", detail: "{\"reason\":\"scope_missing\"}", actorUserId: null, actorLogin: null, actorDisplayName: null },
          ],
          nextCursor: null,
        }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    }));

    renderWithMantine(<WarningsAndErrorsFeed channelId="kanal-a" />);

    await screen.findByText("Clip fehlgeschlagen");
    const trigger = screen.getByRole("button", { name: "Ursache anzeigen: Clip fehlgeschlagen" });
    fireEvent.mouseEnter(trigger);
    expect(await screen.findByText("Berechtigung zum Erstellen von Clips fehlt")).toBeInTheDocument();
  });
});
