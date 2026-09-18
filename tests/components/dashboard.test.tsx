import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardApp } from "../../src/dashboard/main";
import { parseDashboardRoute } from "../../src/dashboard/router";

const moderator = {
  isModerator: true,
  checkedAt: "2026-09-18T02:00:00.000Z",
  reason: null,
};

const healthyChannel = (channelId: string, displayName: string) => ({
  channelId,
  login: channelId,
  displayName,
  role: "verwalter",
  broadcasterConnection: "connected",
  bot: { status: "connected", reason: null, updatedAt: "2026-09-18T01:00:00.000Z" },
  moderator,
  tokens: {
    botExpiresAt: "2099-09-19T00:00:00.000Z",
    loginStatus: "connected",
    loginReason: null,
    loginExpiresAt: "2099-09-19T00:00:00.000Z",
  },
  lastError: null,
});

const overview = (channel: ReturnType<typeof healthyChannel>) => ({
  ...channel,
  activeModules: [],
});

const system = {
  broadcasterConnection: "connected",
  bot: { status: "connected", reason: null, updatedAt: "2026-09-18T01:00:00.000Z" },
  tokens: {
    botExpiresAt: "2099-09-19T00:00:00.000Z",
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

const requestUrl = (input: RequestInfo | URL): URL => {
  if (input instanceof Request) return new URL(input.url);
  if (input instanceof URL) return input;
  return new URL(input, window.location.origin);
};

describe("Dashboard-Grundgerüst", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
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

  it("zeigt Mitgliedschaften und die Verwaltungsaktion nur für verwaltende Rollen", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const members = {
      members: [
        { userId: "100", login: "streamer", displayName: "Streamerin", role: "broadcaster", joinedAt: "2026-09-17T12:00:00.000Z" },
        { userId: "200", login: null, displayName: null, role: "bediener", joinedAt: "2026-09-18T12:00:00.000Z" },
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
    expect(screen.getByText("Streamerin")).toBeInTheDocument();
    expect(screen.getByText("@streamer")).toBeInTheDocument();
    expect(screen.queryByText("100")).not.toBeInTheDocument();
    expect(screen.getByText("Nicht auflösbar")).toBeInTheDocument();
    expect(screen.getByText("Twitch-ID 200")).toBeInTheDocument();
    expect(screen.getByText(/17\.09\.2026/), "Beitrittszeitpunkt wird angezeigt").toBeInTheDocument();
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
    expect(screen.queryByRole("button", { name: "Zugriff freigeben" })).not.toBeInTheDocument();
  });

  it("fragt beim Hinzufügen ausdrücklich nach dem tatsächlichen Zugriffsumfang", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const fetcher = vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path === "/api/channels/kanal-a/members") return jsonResponse({ members: [] });
      if (path === "/api/channels/kanal-a/members/search") return jsonResponse({ user: { userId: "300", login: "neue-person", displayName: "Neue Person" } });
      if (path === "/api/csrf") return jsonResponse({ token: "csrf-token" });
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal("confirm", confirmMock);
    window.history.replaceState({}, "", "/channels/kanal-a/members");

    render(<DashboardApp />);
    await screen.findByRole("heading", { name: "Mitglieder", level: 1 });
    fireEvent.change(screen.getByLabelText("Twitch-Name"), { target: { value: "neue-person" } });
    fireEvent.click(screen.getByRole("button", { name: "Suchen" }));
    await screen.findByText("Neue Person");
    fireEvent.click(screen.getByRole("button", { name: "Zugriff freigeben" }));

    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining("keinerlei Beziehung zum Kanal"));
    expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining("Mitgliederliste"));
  });

  it("verwirft einen verspäteten Mitglieder-Reload nach einer Mutation beim Kanalwechsel", async () => {
    const alpha = healthyChannel("kanal-a", "Alpha");
    const beta = healthyChannel("kanal-b", "Beta");
    let resolveAlphaReload: ((response: Response) => void) | undefined;
    const alphaReload = new Promise<Response>((resolve) => {
      resolveAlphaReload = resolve;
    });
    const alphaMember = { userId: "alpha-user", login: "alpha-user", displayName: "Alpha-Mitglied", role: "bediener", joinedAt: "2026-09-18T00:00:00.000Z" };
    const betaMember = { userId: "beta-user", login: "beta-user", displayName: "Beta-Mitglied", role: "bediener", joinedAt: "2026-09-18T00:00:00.000Z" };
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

  it("lädt die nächste Mitglieder-Seite mit dem gelieferten Cursor nach", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void init;
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel] }));
      if (url.pathname === "/api/channels/kanal-a/members" && url.search === "") {
        return Promise.resolve(jsonResponse({ members: [{ userId: "user-1", login: "erste", displayName: "Erste Person", role: "bediener", joinedAt: "2026-09-18T00:00:00.000Z" }], nextCursor: "cursor-1" }));
      }
      if (url.pathname === "/api/channels/kanal-a/members" && url.search === "?cursor=cursor-1") {
        return Promise.resolve(jsonResponse({ members: [{ userId: "user-2", login: "zweite", displayName: "Zweite Person", role: "bediener", joinedAt: "2026-09-18T00:00:00.000Z" }], nextCursor: null }));
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
    await screen.findByRole("heading", { name: "Alpha", level: 2 });
    expect(screen.getByText("Nicht verbunden")).toHaveAttribute("data-status", "neutral");

    fireEvent.click(screen.getByRole("link", { name: /Alpha/ }));
    await screen.findByRole("heading", { name: "Alpha", level: 1 });
    expect(screen.getByRole("article", { name: "Broadcaster-OAuth" })).toHaveAttribute("data-status", "neutral");

    fireEvent.click(screen.getByRole("link", { name: "System" }));
    await screen.findByRole("heading", { name: "System", level: 1 });
    expect(screen.getByRole("article", { name: "Broadcaster-OAuth" })).toHaveAttribute("data-status", "neutral");
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

    const warning = await screen.findByText("Moderatorrolle fehlt");
    expect(warning.closest("[data-status]")).toHaveAttribute("data-status", "error");
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
    expect(within(tokenCard).getByText("Nicht geprüft", { selector: "strong" })).toBeInTheDocument();
    expect(within(tokenCard).queryByText("Gültig")).not.toBeInTheDocument();
    expect(within(tokenCard).queryByText("Gesund")).not.toBeInTheDocument();
    expect(tokenCard.querySelector('[data-status="healthy"]')).toBeNull();
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
    expect(await screen.findByText("beta-system")).toBeInTheDocument();

    await act(async () => {
      resolveAlphaSystem?.(jsonResponse(systemFor("alpha-system")));
      await Promise.resolve();
    });
    expect(screen.getByText("beta-system")).toBeInTheDocument();
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

  it("führt bei einer mit 403 abgewiesenen Abmeldung zur Anmeldung und entfernt geschützte Daten", async () => {
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
    await screen.findByRole("heading", { name: "Alpha", level: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));

    await screen.findByRole("heading", { name: "Anmeldung erforderlich", level: 1 });
    expect(screen.queryByRole("heading", { name: "Alpha", level: 2 })).not.toBeInTheDocument();
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
    await screen.findByRole("heading", { name: "Alpha", level: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));

    await waitFor(() => {
      const logoutCall = fetcher.mock.calls.find((call) => requestUrl(call[0]).pathname === "/auth/logout");
      expect(logoutCall).toBeDefined();
      expect(logoutCall?.[1]?.method).toBe("POST");
      expect(new Headers(logoutCall?.[1]?.headers).get("X-CSRF-Token")).toBe("csrf-token");
    });
  });
});
