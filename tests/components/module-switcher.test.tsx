import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardApp } from "../../src/dashboard/main";

const relativeIso = (milliseconds: number): string => new Date(Date.now() + milliseconds).toISOString();

const channel = {
  channelId: "kanal-a",
  login: "kanal-a",
  displayName: "Alpha",
  role: "verwalter" as const,
  broadcasterConnection: "connected" as const,
  channelBotConsent: "granted" as const,
  bot: { status: "connected" as const, reason: null, updatedAt: relativeIso(0) },
  moderator: { isModerator: true, checkedAt: "2026-09-18T02:00:00.000Z", reason: null },
  chatSubscription: { status: "enabled" as const, subscriptionId: "abo-1", reason: null, updatedAt: relativeIso(0) },
  tokens: {
    botExpiresAt: relativeIso(3 * 60 * 60 * 1000),
    loginStatus: "connected" as const,
    loginReason: null,
    loginExpiresAt: relativeIso(3 * 60 * 60 * 1000),
  },
  lastError: null,
};

const secondChannel = { ...channel, channelId: "kanal-b", login: "kanal-b", displayName: "Beta" };

const moduleStates = [
  { id: "textbefehle", enabled: true, settings: "{}" },
  { id: "kanalereignisse", enabled: false, settings: "{}" },
  { id: "werbung", enabled: true, settings: "{}" },
];

const requestUrl = (input: RequestInfo | URL): URL => {
  if (input instanceof Request) return new URL(input.url);
  if (input instanceof URL) return input;
  return new URL(input, window.location.origin);
};

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

const renderModulePage = (modules = moduleStates, channels = [channel]): void => {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const path = requestUrl(input).pathname;
    if (path === "/api/channels") return jsonResponse({ channels });
    if (path === "/api/channels/kanal-a/overview") return jsonResponse({ ...channel, activeModules: [] });
    if (path === "/api/channels/kanal-a/modules") return jsonResponse({ modules });
    return jsonResponse({}, 404);
  }));
  window.history.replaceState({}, "", "/channels/kanal-a/modules/textbefehle");
  render(<DashboardApp />);
};

describe("Modulumschalter in der Brotkrume", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("öffnet die Module des Kanals mit Symbol und Zustandstext", async () => {
    renderModulePage();

    await screen.findByRole("switch", { name: "Textbefehle · Läuft" });
    const button = screen.getByRole("button", { name: "Modul auswählen: Textbefehle" });
    fireEvent.click(button);

    const listbox = screen.getByRole("listbox", { name: "Modul auswählen" });
    expect(within(listbox).getAllByRole("option")).toHaveLength(3);
    expect(within(listbox).getByRole("option", { name: /Textbefehle/ })).toHaveTextContent("Läuft");
    expect(within(listbox).getByRole("option", { name: /Kanalereignisse/ })).toHaveTextContent("Aus");
    expect(within(listbox).getByRole("option", { name: /Werbung/ })).toHaveTextContent("Läuft");
    expect(within(listbox).queryByRole("option", { name: "Modulübersicht" })).not.toBeInTheDocument();
    expect(within(listbox).getByRole("option", { name: /Textbefehle/ }).querySelector("svg")).toBeInTheDocument();
  });

  it("wechselt aus der Liste direkt auf die gewählte Moduldetailseite", async () => {
    renderModulePage(moduleStates, [channel, secondChannel]);

    await screen.findByRole("switch", { name: "Textbefehle · Läuft" });
    fireEvent.click(screen.getByRole("button", { name: "Modul auswählen: Textbefehle" }));
    const option = screen.getByRole("option", { name: /Kanalereignisse/ });
    fireEvent.mouseDown(option);
    fireEvent.click(option);

    expect(await screen.findByRole("heading", { name: "Kanalereignisse", level: 1 })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/channels/kanal-a/modules/kanalereignisse");
  });

  it("führt das Segment Module zur Modulübersicht", async () => {
    renderModulePage();

    await screen.findByRole("switch", { name: "Textbefehle · Läuft" });
    const moduleLink = within(screen.getByRole("navigation", { name: "Brotkrume" })).getByRole("link", { name: "Module" });
    expect(moduleLink).toHaveAttribute("href", "/channels/kanal-a/modules");
    fireEvent.click(moduleLink);

    expect(await screen.findByRole("heading", { name: "Module", level: 1 })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/channels/kanal-a/modules");
  });

  it("bleibt bei genau einem Modul ohne Aufklapp-Merkmal stehen", async () => {
    renderModulePage([moduleStates[0] as typeof moduleStates[number]]);

    await screen.findByRole("switch", { name: "Textbefehle · Läuft" });
    expect(screen.queryByRole("button", { name: /Modul auswählen/ })).not.toBeInTheDocument();
    expect(within(screen.getByRole("navigation", { name: "Brotkrume" })).getByRole("link", { name: "Module" })).toBeInTheDocument();
    expect(document.querySelector(".topbar__breadcrumb-module")).toHaveTextContent("Textbefehle");
    expect(document.querySelector(".topbar__channel-chevron")).not.toBeInTheDocument();
  });

  it("schließt den Modulumschalter mit Escape und gibt den Fokus zurück", async () => {
    renderModulePage();

    await screen.findByRole("switch", { name: "Textbefehle · Läuft" });
    const button = screen.getByRole("button", { name: "Modul auswählen: Textbefehle" });
    fireEvent.keyDown(button, { key: "Enter" });
    const selectedOption = screen.getByRole("option", { name: /Textbefehle/ });
    expect(selectedOption).toHaveFocus();

    fireEvent.keyDown(selectedOption, { key: "Escape" });
    expect(screen.queryByRole("listbox", { name: "Modul auswählen" })).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });
});
