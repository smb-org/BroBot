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
    expect(screen.getByText(/aktualisiert vor/)).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Zeit" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Ereignis" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Modul" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Wer" })).toBeInTheDocument();
    expect(screen.getByText("Shoutout unterdrückt")).toBeInTheDocument();
    expect(screen.getByText("raid")).toBeInTheDocument();
    expect(screen.getByText("Automatisch")).toBeInTheDocument();
    expect(screen.getByText("plugin.anderes")).toHaveClass("mono");
    expect(screen.getByText("user-2")).toHaveClass("mono");
    const sentRow = screen.getByText("Chat-Nachricht gesendet").closest("tr");
    const failedRow = screen.getByText("Aktion fehlgeschlagen").closest("tr");
    expect(sentRow?.querySelector(".led")).toHaveAttribute("data-status", "green");
    expect(within(sentRow as HTMLElement).getByText("Info")).toBeInTheDocument();
    expect(failedRow?.querySelector(".led")).toHaveAttribute("data-status", "red");
    expect(within(failedRow as HTMLElement).getByText("Fehler")).toBeInTheDocument();
    const eventRow = screen.getByText("Shoutout unterdrückt").closest("tr");
    const unknownEventRow = screen.getByText("plugin.anderes").closest("tr");
    expect(eventRow).not.toBeNull();
    expect(unknownEventRow).not.toBeNull();
    fireEvent.keyDown(unknownEventRow as HTMLElement, { key: " " });
    expect(unknownEventRow).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Unbekannt")).toBeInTheDocument();
    expect(screen.getByText("kein-json")).toBeInTheDocument();
    fireEvent.keyDown(eventRow as HTMLElement, { key: "Enter" });
    expect(eventRow).toHaveAttribute("aria-selected", "true");
    expect(unknownEventRow).toHaveAttribute("aria-selected", "false");
    expect(screen.getByText("shoutout.unterdrueckt")).toBeInTheDocument();
    expect(screen.getByText(/"grund": "raid_erkannt"/)).toBeInTheDocument();
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
    expect(screen.getByText(/aktualisiert vor/)).toBeInTheDocument();
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

    const table = screen.getByRole("table");
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
    expect(screen.getByRole("combobox", { name: "Rolle für Moderation" })).toBeDisabled();
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
      createdAt: "2026-09-18T04:00:00.000Z",
      action: "module.enabled",
      before: "{\"enabled\":false}",
      after: "{\"enabled\":true}",
    };
    const secondAuditEntry = {
      auditId: "audit-2",
      actorUserId: "user-1",
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
    const row = screen.getByText("module.enabled").closest("tr");
    expect(row).not.toBeNull();
    expect(row).toHaveAttribute("aria-selected", "false");
    fireEvent.keyDown(row as HTMLElement, { key: "Enter" });
    expect(row).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("heading", { name: "Vorher" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Nachher" })).toBeInTheDocument();
    expect(screen.getByText('{"enabled":false}')).toBeInTheDocument();
    const secondRow = screen.getByText("module.disabled").closest("tr");
    expect(secondRow).not.toBeNull();
    fireEvent.keyDown(secondRow as HTMLElement, { key: " " });
    expect(secondRow).toHaveAttribute("aria-selected", "true");
    expect(row).toHaveAttribute("aria-selected", "false");
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
    await waitFor(() => expect(resolveLateInitial).toBeTypeOf("function"));

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
    await waitFor(() => expect(resolveReload).toBeTypeOf("function"));

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
    await waitFor(() => expect(resolveNextPage).toBeTypeOf("function"));

    fireEvent.change(screen.getByRole("combobox", { name: "Rolle für Erster Stand" }), { target: { value: "verwalter" } });
    await waitFor(() => expect(resolveReload).toBeTypeOf("function"));
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
    expect(await screen.findByRole("heading", { name: "Befehl anlegen" })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Module" }).some((link) => link.getAttribute("href") === "/channels/kanal-a/modules")).toBe(true);
  });

  it("zeigt im Kopf Anzeigename, Twitch-ID und den beschrifteten Modulschalter", async () => {
    const channel = { ...healthyChannel("26876135", "Esembe"), login: "esembe" };
    const aktivesModul = { ...overview(channel), activeModules: [{ moduleId: "textbefehle", settings: "{}" }] };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path === "/api/channels/26876135/overview") return jsonResponse(aktivesModul);
      if (path === "/api/channels/26876135/modules") return jsonResponse({ modules: [{ id: "textbefehle", enabled: true, settings: "{}" }] });
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/26876135/modules/textbefehle");

    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Textbefehle", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Esembe" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Esembe · esembe" })).not.toBeInTheDocument();
    expect(screen.getByText("26876135")).toBeInTheDocument();
    const headerSwitch = await screen.findByRole("switch", { name: "Textbefehle · Läuft" });
    expect(headerSwitch).toHaveTextContent("Textbefehle · Läuft");
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
    expect(await screen.findByText("Das Modul „Textbefehle“ ist in diesem Kanal nicht aktiv.")).toBeInTheDocument();
  });

  it("meldet ein deaktiviertes Modul auf seiner Unterseite verständlich", async () => {
    const channel = healthyChannel("kanal-a", "Alpha");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = requestUrl(input).pathname;
      if (path === "/api/channels") return jsonResponse({ channels: [channel] });
      if (path === "/api/channels/kanal-a/overview") return jsonResponse(overview(channel));
      return jsonResponse({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/modules/textbefehle");

    render(<DashboardApp />);

    expect(await screen.findByText("Das Modul „Textbefehle“ ist in diesem Kanal nicht aktiv.")).toBeInTheDocument();
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

    const moderatorCard = await screen.findByRole("article", { name: "Moderatorstatus" });
    expect(moderatorCard).toHaveAttribute("data-status", "error");
    expect(moderatorCard).toHaveTextContent("Moderatorrolle fehlt");
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
});
