import type { ReactElement } from "react";

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    expect(screen.getByRole("link", { name: "Clip öffnen" })).toHaveAttribute("href", "https://clips.twitch.tv/clip-1/edit");
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

  it("shows only warning and error events, with no interactive row", async () => {
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

    renderWithMantine(<WarningsAndErrorsFeed channelId="kanal-a" />);

    expect(await screen.findByText("Werbeeinblendung nicht gestartet: rate_limited")).toBeInTheDocument();
    expect(screen.getByText("Raid verworfen: ungültige Daten")).toBeInTheDocument();
    expect(screen.queryByText("Chat-Nachricht gesendet")).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("row")).not.toBeInTheDocument();
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
