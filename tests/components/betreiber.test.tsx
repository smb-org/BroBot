import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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
  vollzustimmung: true,
  memberCounts: { broadcaster: 1, verwalter: 1, bediener: 0 },
  broadcasterConnected: false,
};

const mitglieder = {
  members: [
    { userId: "123", login: "alpha_login", displayName: "Alpha", profileImageUrl: null, role: "broadcaster", joinedAt: "2026-09-19T12:00:00.000Z" },
    { userId: "456", login: "helfer", displayName: "Helfer", profileImageUrl: null, role: "verwalter", joinedAt: "2026-09-19T13:00:00.000Z" },
  ],
  nextCursor: null,
  broadcasterCount: 1,
  viewerUserId: "999",
};

const richteBetreiberEin = (betreiber: boolean): ReturnType<typeof vi.fn<typeof fetch>> => {
  const fetcher = vi.fn<typeof fetch>((input) => {
    const url = anfrageUrl(input);
    if (url.pathname === "/api/channels") return Promise.resolve(antwort({ channels: [], betreiber }));
    if (url.pathname === "/api/betreiber") return Promise.resolve(antwort({ channels: [kanal] }));
    if (url.pathname === "/api/betreiber/audit") return Promise.resolve(antwort({ entries: [], nextCursor: null }));
    if (url.pathname === "/api/betreiber/kanaele/123/mitglieder") return Promise.resolve(antwort(mitglieder));
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
    expect(fetcher.mock.calls.some(([input, init]) => anfrageUrl(input).pathname.endsWith("/mitglieder/456") && init?.method === "DELETE")).toBe(false);
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

    expect(link).toHaveValue("http://localhost:3000/auth/login?kanal=alpha_login");
  });
});
