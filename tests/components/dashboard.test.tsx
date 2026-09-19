import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DashboardApp } from "../../src/dashboard/main";
import { parseDashboardRoute } from "../../src/dashboard/router";

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

  it("erkennt die kanalgebundene Ereignisroute", () => {
    expect(parseDashboardRoute("/channels/kanal-a/events")).toEqual({
      kind: "channel",
      channelId: "kanal-a",
      section: "events",
    });
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
        }],
        nextCursor: null,
      });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/events");

    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Ereignisse", level: 1 })).toBeInTheDocument();
    expect(screen.getByText("shoutout.unterdrueckt")).toBeInTheDocument();
    expect(screen.getByText("raid")).toBeInTheDocument();
    expect(screen.getByText("Automatisch")).toBeInTheDocument();
    expect(screen.getByText('{"grund":"raid_erkannt"}')).toBeInTheDocument();
  });

  it("erreicht Ereignisse über die Navigation und lädt die nächste Seite", async () => {
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
    expect(screen.getByText("neu")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Ältere Ereignisse laden" }));
    expect(await screen.findByText("alt")).toBeInTheDocument();
    expect(screen.getByText("Alice")).toBeInTheDocument();
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

    expect(screen.getByRole("button", { name: "Zugriff für esembe entziehen" })).toBeDisabled();
    expect(screen.getByText("Letzter Broadcaster")).toBeInTheDocument();

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

    expect(screen.getByRole("button", { name: "Zugriff für esembe entziehen" })).toBeEnabled();
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
    fireEvent.click(screen.getByRole("button", { name: "Zugriff für esembe entziehen" }));

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
    expect(screen.getByText("Streamerin")).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Zugriff freigeben" })).toBeDisabled();
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
    expect(screen.getByRole("combobox", { name: "Rolle für Moderation" })).toBeDisabled();
    const entziehen = screen.getByRole("button", { name: "Zugriff für Moderation entziehen" });
    expect(entziehen).toBeDisabled();
    expect(screen.getAllByText(grund).length).toBeGreaterThan(0);
  });

  it("zeigt dem Bediener die Modulaktivierung deaktiviert mit Begründung", async () => {
    const channel = { ...healthyChannel("kanal-a", "Alpha"), role: "bediener" };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path.endsWith("/modules")) return jsonResponse({ modules: [{ id: "raid", enabled: false, settings: "{}" }] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/modules");

    render(<DashboardApp />);

    await screen.findByRole("heading", { name: "Module", level: 1 });
    const schalter = await screen.findByRole("checkbox", { name: "raid aktivieren" });
    const grund = "Nur Broadcaster und Verwalter dürfen Module ändern.";
    expect(schalter).toBeDisabled();
    expect(schalter).toHaveAttribute("title", grund);
    expect(screen.getByText(grund)).toBeInTheDocument();
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
    expect(screen.getByText("Nicht verbunden")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Alpha", level: 2 }).closest("article"))
      .not.toHaveAttribute("data-status", "error");

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
    expect(screen.queryByRole("link", { name: "Broadcaster-Zustimmung anfordern" })).not.toBeInTheDocument();

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
    expect(screen.getByText(/Letzte Prüfung:/)).toBeInTheDocument();
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
    expect(screen.queryByRole("button", { name: "Moderatorstatus prüfen" })).not.toBeInTheDocument();
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

    // Nach erfolgreicher Prüfung ist der Kanal gesund; die Moderatorzeile
    // verschwindet deshalb. Beweis für den neuen Stand ist die aktualisierte
    // Prüfzeit neben der Aktion.
    await waitFor(() => expect(screen.getByText(/Letzte Prüfung:/)).toBeInTheDocument());
    expect(screen.queryByRole("article", { name: "Moderatorstatus" })).not.toBeInTheDocument();
    expect(screen.getByText(/Letzte Prüfung:/)).toBeInTheDocument();
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
    expect(screen.queryByRole("article", { name: "Moderatorstatus" })).not.toBeInTheDocument();
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

    const channelHeading = await screen.findByRole("heading", { name: "Alpha", level: 2 });
    const channelCard = channelHeading.closest("article");
    expect(channelCard).not.toBeNull();
    expect(channelCard).toHaveAttribute("data-status", "healthy");
    expect(within(channelCard as HTMLElement).getByText("Gesund", { selector: "span" })).toBeInTheDocument();
    expect(within(channelCard as HTMLElement).queryByText("Warnung")).not.toBeInTheDocument();

    // Auf der Kanalseite ist Gesundheit die Abwesenheit von Meldungen: keine
    // Zustandszeile erscheint, der Inhalt beginnt sofort. Die Werte selbst
    // stehen weiterhin vollständig auf der Systemseite.
    fireEvent.click(screen.getByRole("link", { name: /Alpha/ }));
    await screen.findByRole("heading", { name: "Alpha", level: 1 });
    expect(screen.queryByRole("article", { name: "Token-Zustand" })).not.toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Bot-Account" })).not.toBeInTheDocument();
    expect(screen.queryByText("Warnung")).not.toBeInTheDocument();
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

    const channelHeading = await screen.findByRole("heading", { name: "Alpha", level: 2 });
    const channelCard = channelHeading.closest("article");
    expect(channelCard).not.toBeNull();
    expect(channelCard).toHaveAttribute("data-status", "healthy");
    expect(within(channelCard as HTMLElement).queryByText("Erneuerung überfällig")).not.toBeInTheDocument();
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

    const channelHeading = await screen.findByRole("heading", { name: "Alpha", level: 2 });
    const channelCard = channelHeading.closest("article");
    expect(channelCard).not.toBeNull();
    expect(channelCard).toHaveAttribute("data-status", "warning");
    expect(within(channelCard as HTMLElement).getByText("Erneuerung überfällig", { selector: "span" })).toBeInTheDocument();
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

    const channelHeading = await screen.findByRole("heading", { name: "Alpha", level: 2 });
    const channelCard = channelHeading.closest("article");
    expect(channelCard).not.toBeNull();
    expect(channelCard).toHaveAttribute("data-status", "warning");
    expect(within(channelCard as HTMLElement).getByText("Wartung überfällig", { selector: "span" })).toBeInTheDocument();
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
    await screen.findByRole("heading", { name: "Alpha", level: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Abmelden" })).toBeEnabled();
    });
    expect(screen.queryByRole("heading", { name: "Anmeldung erforderlich", level: 1 }))
      .not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Alpha", level: 2 })).toBeInTheDocument();
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
