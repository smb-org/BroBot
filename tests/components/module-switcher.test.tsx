import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardApp } from "../../src/dashboard/main";
import { jsonResponse } from "../unit/fixtures";

const relativeIso = (milliseconds: number): string => new Date(Date.now() + milliseconds).toISOString();

const channel = {
  channelId: "kanal-a",
  login: "kanal-a",
  displayName: "Alpha",
  role: "manager" as const,
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
  { id: "text_commands", enabled: true, settings: "{}" },
  { id: "channel_events", enabled: false, settings: "{}" },
  { id: "ads", enabled: true, settings: "{}" },
];

const requestUrl = (input: RequestInfo | URL): URL => {
  if (input instanceof Request) return new URL(input.url);
  if (input instanceof URL) return input;
  return new URL(input, window.location.origin);
};

const renderModulePage = (modules = moduleStates, channels = [channel]): void => {
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
    const path = requestUrl(input).pathname;
    if (path === "/api/channels") return jsonResponse({ channels, bot: channels[0]?.bot ?? null });
    if (path === "/api/channels/kanal-a/overview") return jsonResponse({ ...channel, activeModules: [] });
    if (path === "/api/channels/kanal-a/modules") return jsonResponse({ modules });
    return jsonResponse({}, 404);
  }));
  window.history.replaceState({}, "", "/channels/kanal-a/modules/text_commands");
  render(<DashboardApp />);
};

// The breadcrumb module switcher this file used to cover is gone -- the
// sidebar's Modules group is now how a module page is reached and left.
describe("Module navigation in the sidebar", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("lists only the active modules with icon and status, not the inactive one", async () => {
    renderModulePage();

    const nav = await screen.findByRole("navigation", { name: "Hauptnavigation" });
    const textCommandsLink = within(nav).getByRole("link", { name: "Textbefehle · Läuft" });
    expect(textCommandsLink.querySelector("svg")).toBeInTheDocument();
    expect(textCommandsLink).toHaveAttribute("title", "Textbefehle · Läuft");
    expect(textCommandsLink.querySelector(".led--dot-only")).toBeInTheDocument();
    expect(within(textCommandsLink).queryByText("Läuft", { exact: true })).not.toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Werbung · Läuft" })).toBeInTheDocument();
    expect(within(nav).queryByRole("link", { name: /Kanalereignisse/ })).not.toBeInTheDocument();
  });

  it("switches straight from the sidebar to the selected module's detail page", async () => {
    renderModulePage(moduleStates, [channel, secondChannel]);

    const nav = await screen.findByRole("navigation", { name: "Hauptnavigation" });
    fireEvent.click(within(nav).getByRole("link", { name: "Werbung · Läuft" }));

    expect(await screen.findByRole("heading", { name: "Werbung", level: 1 })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/channels/kanal-a/modules/ads");
  });

  it("the Module node leads to and is active on the module overview", async () => {
    renderModulePage();

    const nav = await screen.findByRole("navigation", { name: "Hauptnavigation" });
    const moduleLink = within(nav).getByRole("link", { name: "Module" });
    expect(moduleLink).toHaveAttribute("href", "/channels/kanal-a/modules");
    expect(moduleLink).not.toHaveAttribute("aria-current", "page");
    fireEvent.click(moduleLink);

    expect(await screen.findByRole("heading", { name: "Module", level: 1 })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/channels/kanal-a/modules");
    expect(within(nav).getByRole("link", { name: "Module" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps the module overview node and the single active module visible", async () => {
    renderModulePage([moduleStates[0] as typeof moduleStates[number]]);

    const nav = await screen.findByRole("navigation", { name: "Hauptnavigation" });
    expect(within(nav).getByRole("link", { name: "Textbefehle · Läuft" })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Module" })).toBeInTheDocument();
    expect(within(nav).getAllByRole("link", { name: "Module" })).toHaveLength(1);
  });

  it("keeps the overview route on the collapsed Module icon", async () => {
    window.sessionStorage.removeItem("brobot-dashboard-sidebar-collapsed");
    renderModulePage();

    const nav = await screen.findByRole("navigation", { name: "Hauptnavigation" });
    fireEvent.click(within(nav).getByRole("button", { name: "Seitenleiste einklappen" }));
    const moduleLink = within(nav).getByRole("link", { name: "Module" });
    expect(moduleLink).toHaveAttribute("href", "/channels/kanal-a/modules");
    expect(moduleLink).toHaveAttribute("title", "Module");
    fireEvent.click(moduleLink);

    expect(await screen.findByRole("heading", { name: "Module", level: 1 })).toBeInTheDocument();
  });
});
