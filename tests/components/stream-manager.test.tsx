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

const requestUrl = (input: RequestInfo | URL): URL =>
  input instanceof Request ? new URL(input.url) : new URL(String(input), window.location.origin);

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
    renderWithMantine(<ImmediateActions channelId="kanal-a" />);

    fireEvent.click(screen.getByRole("button", { name: /Werbung jetzt/ }));

    expect(await screen.findByText("Werbung gestartet (60s)")).toBeInTheDocument();
    expect(fetcher.mock.calls.some(([input, init]) =>
      requestUrl(input).pathname === "/api/channels/kanal-a/modules/ads/commercial" && init?.method === "POST")).toBe(true);
  });

  it("keeps each action's control and button inside its own card, button pinned last", () => {
    renderWithMantine(<ImmediateActions channelId="kanal-a" />);

    const adButton = screen.getByRole("button", { name: /Werbung jetzt/ });
    const adCard = adButton.closest(".stream-manager-action");
    const adLength = within(adCard as HTMLElement).getByRole("radiogroup");
    expect(adCard).toContainElement(adLength);
    expect(adCard?.lastElementChild).toBe(adButton);

    const shoutoutButton = screen.getByRole("button", { name: "Shoutout senden" });
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

  it("shows the hint instead of the reason once a login is entered, still one helper line", () => {
    renderWithMantine(<ImmediateActions channelId="kanal-a" />);

    fireEvent.change(screen.getByLabelText("Twitch-Name"), { target: { value: "streamerin" } });

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
    renderWithMantine(<ImmediateActions channelId="kanal-a" />);

    const group = screen.getByRole("radiogroup", { name: "Werbedauer" });
    for (const seconds of ["30", "60", "90", "120", "150", "180"]) {
      expect(within(group).getByRole("radio", { name: `${seconds}s` })).toBeInTheDocument();
    }
    fireEvent.click(within(group).getByRole("radio", { name: "180s" }));
    fireEvent.click(screen.getByRole("button", { name: "Werbung jetzt (180s)" }));

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
    renderWithMantine(<ImmediateActions channelId="kanal-a" />);

    fireEvent.change(screen.getByLabelText("Twitch-Name"), { target: { value: "@streamerin" } });
    expect(screen.getByLabelText("Twitch-Name")).toHaveValue("streamerin");
    fireEvent.click(screen.getByRole("button", { name: "Shoutout senden" }));

    expect(await screen.findByText("Shoutout an streamerin gesendet")).toBeInTheDocument();
  });

  it("lays out the three actions as equal cards in one grid, each with a header icon and title", () => {
    const { container } = renderWithMantine(<ImmediateActions channelId="kanal-a" />);

    const grid = container.querySelector(".stream-manager-actions");
    const cards = grid?.querySelectorAll(":scope > .stream-manager-action");
    expect(cards).toHaveLength(3);
    const titles = Array.from(cards ?? [], (card) => card.querySelector(".stream-manager-action__header")?.textContent);
    expect(titles).toEqual(["Werbung", "Shoutout", "Clip"]);
    for (const card of cards ?? []) {
      expect(card.querySelector(".stream-manager-action__header .ui-icon")).toBeInTheDocument();
    }
  });

  it("shows the matching aria-hidden Tabler icon without changing each action's accessible name", () => {
    renderWithMantine(<ImmediateActions channelId="kanal-a" />);

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
    renderWithMantine(<ImmediateActions channelId="kanal-a" />);

    fireEvent.click(screen.getByRole("button", { name: /Werbung jetzt/ }));

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
    renderWithMantine(<ImmediateActions channelId="kanal-a" />);

    fireEvent.change(screen.getByLabelText("Twitch-Name"), { target: { value: "streamerin" } });
    fireEvent.click(screen.getByRole("button", { name: "Shoutout senden" }));

    expect(await screen.findByText("Shoutout an streamerin gesendet")).toBeInTheDocument();
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
    renderWithMantine(<ImmediateActions channelId="kanal-a" />);

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
    renderWithMantine(<ImmediateActions channelId="kanal-a" />);

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
    vi.unstubAllGlobals();
  });

  it("uses event rows and links each warning or error to the event log", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels/kanal-a/events") {
        return Promise.resolve(jsonResponse({
          entries: [
            { eventId: "1", createdAt: "2026-09-22T10:00:00.000Z", moduleId: "host", triggerId: "t1", code: "host.chat.sent", detail: "{}", actorUserId: null, actorLogin: null, actorDisplayName: null },
            { eventId: "2", createdAt: "2026-09-22T10:01:00.000Z", moduleId: "ads", triggerId: "t2", code: "ads.commercial.failed", detail: "{\"reason\":\"rate_limited\"}", actorUserId: null, actorLogin: null, actorDisplayName: null },
            { eventId: "3", createdAt: "2026-09-22T10:02:00.000Z", moduleId: "raid", triggerId: "t3", code: "raid.invalid", detail: "{}", actorUserId: null, actorLogin: null, actorDisplayName: null },
          ],
          nextCursor: null,
        }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    }));

    const onNavigate = vi.fn();
    renderWithMantine(<WarningsAndErrorsFeed channelId="kanal-a" onNavigate={onNavigate} />);

    const adText = await screen.findByText("Werbeeinblendung nicht gestartet: rate_limited");
    expect(screen.getByText("Raid verworfen: ungültige Daten")).toBeInTheDocument();
    expect(screen.queryByText("Chat-Nachricht gesendet")).not.toBeInTheDocument();
    const link = adText.closest("a");
    expect(link).toHaveAttribute("href", "/channels/kanal-a/events");
    expect(link?.querySelector(".event-chip")).toHaveAttribute("data-tone", "error");
    expect(link?.querySelector("time")).toHaveAttribute("title", "2026-09-22T10:01:00.000Z");
    fireEvent.click(link as HTMLAnchorElement);
    expect(onNavigate).toHaveBeenCalledWith({ kind: "channel", channelId: "kanal-a", section: "events" });
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
    expect(container.querySelector(".stream-manager-feed")?.firstElementChild).toHaveTextContent("Werbeeinblendung nicht gestartet: rate_limited");
  });

  it("shows an empty state when there is nothing to warn about", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels/kanal-a/events") return Promise.resolve(jsonResponse({ entries: [], nextCursor: null }));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    renderWithMantine(<WarningsAndErrorsFeed channelId="kanal-a" />);

    expect(await screen.findByText("Keine Warnungen oder Fehler.")).toBeInTheDocument();
  });
});
