import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardApp } from "../../src/dashboard/main";

const antwort = (inhalt: unknown, status = 200): Response => new Response(JSON.stringify(inhalt), {
  status,
  headers: { "Content-Type": "application/json" },
});

const anfrageUrl = (input: RequestInfo | URL): URL => {
  if (input instanceof Request) return new URL(input.url);
  if (input instanceof URL) return input;
  return new URL(input, window.location.origin);
};

const kanal = {
  channelId: "123",
  login: "alpha_login",
  displayName: "Alpha",
  fullConsent: true,
  memberCounts: { broadcaster: 1, manager: 1, operator: 0 },
  broadcasterConnected: false,
};

const mitglieder = {
  members: [
    { userId: "123", login: "alpha_login", displayName: "Alpha", profileImageUrl: null, role: "broadcaster", joinedAt: "2026-09-19T12:00:00.000Z" },
    { userId: "456", login: "helfer", displayName: "Helfer", profileImageUrl: null, role: "manager", joinedAt: "2026-09-19T13:00:00.000Z" },
  ],
  nextCursor: null,
  broadcasterCount: 1,
  viewerUserId: "999",
};

const richteBetreiberEin = (
  betreiber: boolean,
  audit: { entries: unknown[]; nextCursor: string | null } = { entries: [], nextCursor: null },
): ReturnType<typeof vi.fn<typeof fetch>> => {
  const fetcher = vi.fn<typeof fetch>((input) => {
    const url = anfrageUrl(input);
    if (url.pathname === "/api/channels") return Promise.resolve(antwort({ channels: [], platformAdmin: betreiber }));
    if (url.pathname === "/api/platform") return Promise.resolve(antwort({ channels: [kanal] }));
    if (url.pathname === "/api/platform/audit") return Promise.resolve(antwort(audit));
    if (url.pathname === "/api/platform/channels/123/members") return Promise.resolve(antwort(mitglieder));
    return Promise.resolve(antwort({}, 404));
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("Betreiberebene", () => {
  it("zeigt ohne Betreiberfreigabe weder Navigation noch Betreiberroute", async () => {
    richteBetreiberEin(false);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Noch kein Kanal freigegeben", level: 2 })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
    expect(screen.queryByRole("link", { name: "Betreiber" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Betreiberebene", level: 1 })).not.toBeInTheDocument();
  });

  it("bietet Broadcaster in keinem Rollenauswahlfeld an", async () => {
    richteBetreiberEin(true);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    const zeile = await screen.findByRole("row", { name: /alpha_login/ });
    fireEvent.click(zeile);
    const rolle = await screen.findByRole("combobox", { name: "Rolle: Helfer" });

    expect(within(rolle).queryByRole("option", { name: "Broadcaster" })).not.toBeInTheDocument();
    expect(screen.queryAllByRole("option", { name: "Broadcaster" })).toHaveLength(0);
  });

  it("fragt vor dem Entfernen eines Mitglieds nach und handelt noch nicht", async () => {
    const fetcher = richteBetreiberEin(true);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    fireEvent.click(await screen.findByRole("row", { name: /alpha_login/ }));
    const helferZeile = await screen.findByRole("row", { name: /Helfer/ });
    const entfernen = within(helferZeile).getByRole("button", { name: "Entfernen" });
    fireEvent.click(entfernen);

    expect(await screen.findByRole("alertdialog", { name: /Zugriff für Helfer wirklich entfernen/ })).toBeInTheDocument();
    expect(fetcher.mock.calls.some(([input, init]) => anfrageUrl(input).pathname.endsWith("/members/456") && init?.method === "DELETE")).toBe(false);
  });

  it("zeigt den Entfernen-Knopf der Broadcaster-Zeile deaktiviert mit Begründung", async () => {
    richteBetreiberEin(true);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    fireEvent.click(await screen.findByRole("row", { name: /alpha_login/ }));
    const broadcasterZeile = await screen.findByRole("row", { name: /Alpha/ });
    const entfernen = within(broadcasterZeile).getByRole("button", { name: "Entfernen" });

    expect(entfernen).toBeDisabled();
    expect(entfernen).toHaveAttribute("title", "Die Broadcaster-Rolle kann der Betreiber nicht entfernen.");
    expect(entfernen).toHaveAccessibleDescription("Die Broadcaster-Rolle kann der Betreiber nicht entfernen.");
  });

  it("setzt den Einladungslink aus dem Login des gewählten Kanals zusammen", async () => {
    richteBetreiberEin(true);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    fireEvent.click(await screen.findByRole("row", { name: /alpha_login/ }));
    const link = await screen.findByRole("textbox", { name: "Einladungslink" });

    expect(link).toHaveValue("http://localhost:3000/auth/login?channel=alpha_login");
  });

  it("zeigt im Betreiber-Audit den Anzeigenamen und bei fehlender Auflösung die ID", async () => {
    richteBetreiberEin(true, {
      entries: [{
        auditId: "audit-1",
        actorUserId: "26876135",
        actorLogin: "esembe",
        actorDisplayName: "Esembe",
        actorKind: "platform_admin",
        createdAt: "2026-09-18T00:00:00.000Z",
        channelId: "123",
        moduleId: null,
        action: "kanal.freigegeben",
        before: "{}",
        after: "{}",
      }, {
        auditId: "audit-2",
        actorUserId: "gelöscht",
        actorLogin: null,
        actorDisplayName: null,
        actorKind: "platform_admin",
        createdAt: "2026-09-18T00:00:01.000Z",
        channelId: "123",
        moduleId: null,
        action: "kanal.vollzustimmung_geaendert",
        before: "{}",
        after: "{}",
      }],
      nextCursor: null,
    });
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    const audit = await screen.findByRole("region", { name: "Betreiber-Audit" });
    expect(await within(audit).findByText("Betreiber · Esembe")).toBeInTheDocument();
    expect(await within(audit).findByText("Betreiber · gelöscht")).toBeInTheDocument();
    expect(within(audit).queryByText("Betreiber · 26876135")).not.toBeInTheDocument();
  });

  it("zeigt den Einladungslink nur im Editor des gewählten Kanals", async () => {
    richteBetreiberEin(true);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    const übersicht = await screen.findByRole("region", { name: "Kanalübersicht" });
    expect(within(übersicht).queryByRole("textbox", { name: "Einladungslink" })).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("row", { name: /alpha_login/ }));
    const editor = await within(übersicht).findByRole("region", { name: "Kanal bearbeiten: Alpha" });
    expect(await within(editor).findByRole("textbox", { name: "Einladungslink" })).toBeInTheDocument();
    expect(within(übersicht).getByRole("region", { name: "Einladungslink" })).toContainElement(within(editor).getByRole("textbox", { name: "Einladungslink" }));
  });

  it("ordnet Kanalübersicht und Kanal-Inspector als direkte Bereichskinder an", async () => {
    richteBetreiberEin(true);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    const row = await screen.findByRole("row", { name: /alpha_login/ });
    fireEvent.click(row);
    const bereich = screen.getByRole("region", { name: "Kanalübersicht" });
    expect(bereich.children).toHaveLength(2);
    expect(bereich.children[0]).toHaveClass("inspektor-bereich__liste");
    expect(bereich.children[1]).toHaveClass("sub-inspector");
  });

  it("schließt den Betreiber-Kanal-Inspector per Taste und Escape mit Fokus auf der Zeile", async () => {
    richteBetreiberEin(true);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    const row = await screen.findByRole("row", { name: /alpha_login/ });
    row.focus();
    fireEvent.click(row);
    expect(row).toHaveFocus();
    await screen.findByRole("region", { name: "Kanal bearbeiten: Alpha" });
    const closeButton = screen.getByRole("button", { name: "Schließen" });
    closeButton.focus();
    fireEvent.click(closeButton);
    expect(screen.queryByRole("region", { name: "Kanal bearbeiten: Alpha" })).not.toBeInTheDocument();
    expect(row).toHaveAttribute("aria-selected", "false");
    expect(row).toHaveFocus();

    fireEvent.click(row);
    const reopenedInspector = await screen.findByRole("region", { name: "Kanal bearbeiten: Alpha" });
    expect(reopenedInspector).toBeInTheDocument();
    expect(row).toHaveFocus();
    const reopenedCloseButton = within(reopenedInspector).getByRole("button", { name: "Schließen" });
    reopenedCloseButton.focus();
    fireEvent.keyDown(reopenedCloseButton, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Kanal bearbeiten: Alpha" })).not.toBeInTheDocument();
    expect(row).toHaveFocus();
  });

  it("öffnet die Kanalfreigabe in der Inspektorspalte und wechselt ohne Doppelbelegung", async () => {
    richteBetreiberEin(true);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    const bereich = await screen.findByRole("region", { name: "Kanalübersicht" });
    expect(bereich.children).toHaveLength(1);
    const plus = within(bereich).getByRole("button", { name: "Kanal freigeben" });
    fireEvent.click(plus);
    const freigabe = await screen.findByRole("region", { name: "Kanal freigeben" });
    expect(bereich.children).toHaveLength(2);

    const row = await screen.findByRole("row", { name: /alpha_login/ });
    fireEvent.click(row);
    expect(screen.queryByRole("region", { name: "Kanal freigeben" })).not.toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Kanal bearbeiten: Alpha" })).toBeInTheDocument();

    fireEvent.click(plus);
    expect(screen.queryByRole("region", { name: "Kanal bearbeiten: Alpha" })).not.toBeInTheDocument();
    const reopenedFreigabe = await screen.findByRole("region", { name: "Kanal freigeben" });
    expect(row).toHaveAttribute("aria-selected", "false");

    fireEvent.click(within(reopenedFreigabe).getByRole("button", { name: "Schließen" }));
    expect(screen.queryByRole("region", { name: "Kanal freigeben" })).not.toBeInTheDocument();
    expect(plus).toHaveFocus();

    fireEvent.click(plus);
    const escapedFreigabe = await screen.findByRole("region", { name: "Kanal freigeben" });
    fireEvent.keyDown(escapedFreigabe, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Kanal freigeben" })).not.toBeInTheDocument();
    expect(plus).toHaveFocus();
    expect(freigabe).not.toBeInTheDocument();
  });

  it("gibt einen Kanal weiterhin über das geöffnete Formular frei", async () => {
    const freigegeben = { ...kanal };
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url = anfrageUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(antwort({ channels: [], platformAdmin: true }));
      if (url.pathname === "/api/platform") return Promise.resolve(antwort({ channels: [freigegeben] }));
      if (url.pathname === "/api/platform/audit") return Promise.resolve(antwort({ entries: [], nextCursor: null }));
      if (url.pathname === "/api/platform/channels/123/members") return Promise.resolve(antwort(mitglieder));
      if (url.pathname === "/api/platform/users") return Promise.resolve(antwort({ user: { userId: "789", login: "beta_login", displayName: "Beta" } }));
      if (url.pathname === "/api/csrf") return Promise.resolve(antwort({ token: "csrf" }));
      if (url.pathname === "/api/platform/channels" && init?.method === "POST") return Promise.resolve(antwort({ channel: freigegeben }));
      return Promise.resolve(antwort({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/betreiber");

    render(<DashboardApp />);

    const plus = await screen.findByRole("button", { name: "Kanal freigeben" });
    fireEvent.click(plus);
    const freigabe = await screen.findByRole("region", { name: "Kanal freigeben" });
    fireEvent.change(within(freigabe).getByRole("textbox", { name: "Twitch-Login" }), { target: { value: "beta_login" } });
    fireEvent.click(within(freigabe).getByRole("button", { name: "Nutzer suchen" }));
    expect(await within(freigabe).findByText(/Beta/)).toBeInTheDocument();
    fireEvent.click(within(freigabe).getByRole("button", { name: "Kanal freigeben" }));
    fireEvent.click(await within(freigabe).findByRole("button", { name: "Endgültig freigeben" }));

    await waitFor(() => expect(fetcher.mock.calls.some(([input, init]) => anfrageUrl(input).pathname === "/api/platform/channels" && init?.method === "POST")).toBe(true));
  });
});
