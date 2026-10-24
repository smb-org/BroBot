import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const activeLoader = vi.hoisted(() => vi.fn(() => Promise.resolve({ default: () => <p>Panel geladen</p> })));
const pendingLoader = vi.hoisted(() => vi.fn(() => Promise.resolve({ default: () => <p>Target panel loaded</p> })));

vi.mock("../../src/modules/registry", () => ({
  MODULES: [
    { id: "aktiv", navigationCategory: "chat", settingsSchema: {}, defaultSettings: {}, panel: activeLoader },
    { id: "pending", navigationCategory: "chat", settingsSchema: {}, defaultSettings: {}, panel: pendingLoader },
  ],
}));

import { DashboardApp } from "../../src/dashboard/main";
import { queryKeys } from "../../src/dashboard/data/keys";
import { setDashboardRealtimeStatus } from "../../src/dashboard/data/realtime";
import { renderWithQuery as render } from "../query-test-utils";

const idleCallbackPropertyNames = ["requestIdleCallback", "cancelIdleCallback"] as const;
const originalIdleCallbackProperties = idleCallbackPropertyNames.map((name) => [name, Object.getOwnPropertyDescriptor(window, name)] as const);

const channel = {
  channelId: "kanal-a",
  login: "kanal-a",
  displayName: "Alpha",
  role: "manager",
  broadcasterConnection: "connected",
  channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-09-19T12:00:00.000Z" },
  moderator: { isModerator: true, checkedAt: "2026-09-19T12:00:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "abo-1", reason: null, updatedAt: "2026-09-19T12:00:00.000Z" },
  tokens: {
    botExpiresAt: "2099-09-19T00:00:00.000Z",
    loginStatus: "connected",
    loginReason: null,
    loginExpiresAt: "2099-09-19T00:00:00.000Z",
  },
  lastError: null,
};

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

describe("Module route during client-side navigation", () => {
  afterEach(() => {
    cleanup();
    setDashboardRealtimeStatus("kanal-a", "offline");
    vi.unstubAllGlobals();
    for (const [name, descriptor] of originalIdleCallbackProperties) {
      if (descriptor === undefined) Reflect.deleteProperty(window, name);
      else Object.defineProperty(window, name, descriptor);
    }
  });

  it("starts the panel from the cached activity state on navigation", async () => {
    const idleCallbackScheduled = vi.fn(() => 1);
    Object.defineProperty(window, "requestIdleCallback", { configurable: true, value: idleCallbackScheduled });
    Object.defineProperty(window, "cancelIdleCallback", { configurable: true, value: () => undefined });

    const activeState = { ...channel, activeModules: [{ moduleId: "aktiv", settings: "{}" }] };
    let overviewAufrufe = 0;
    const unmockedRequests: string[] = [];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), window.location.origin).pathname;
      if (path === "/api/channels") return response({ channels: [channel], bot: channel.bot });
      if (path === "/api/channels/kanal-a/overview") {
        overviewAufrufe += 1;
        return response(activeState);
      }
      if (path === "/api/channels/kanal-a/modules") {
        return response({ modules: [{ id: "aktiv", enabled: true, settings: "{}" }] });
      }
      if (path === "/api/channels/kanal-a/system") {
        return response({
          broadcasterConnection: channel.broadcasterConnection,
          bot: channel.bot,
          botPermissions: null,
          broadcasterPermissions: null,
          chatSubscription: channel.chatSubscription,
          tokens: channel.tokens,
        });
      }
      if (path === "/api/channels/kanal-a/events") return response({ entries: [], nextCursor: null });
      if (path === "/api/channels/kanal-a/overlays") return response({ overlays: [] });
      if (path === "/api/channels/kanal-a/settings") return response({ timeZone: "Europe/Berlin", revision: 1, location: null, locationRevision: 1 });
      if (path === "/api/channels/kanal-a/broadcast") return response({ title: "", game: null, manageScopeAvailable: true });
      unmockedRequests.push(path);
      return response({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    const rendered = render(<DashboardApp />, undefined, { panelRevisions: {} });
    expect(await screen.findByRole("heading", { name: "Alpha", level: 1 })).toBeInTheDocument();
    const modeSwitcher = screen.getByRole("group", { name: "Einrichten" });
    fireEvent.click(within(modeSwitcher).getByRole("button", { name: "Einrichten" }));
    const nav = await screen.findByRole("navigation", { name: "Hauptnavigation" });
    const link = await within(nav).findByRole("link", { name: /^aktiv.*Läuft$/ });
    await waitFor(() => expect(rendered.queryClient.getQueryData(queryKeys.channel("kanal-a", "overview"))).toEqual(activeState));
    expect(idleCallbackScheduled).toHaveBeenCalled();
    expect(activeLoader).not.toHaveBeenCalled();

    fireEvent.click(link);

    expect(await screen.findByText("Panel geladen")).toBeInTheDocument();
    expect(activeLoader).toHaveBeenCalledTimes(1);
    expect(overviewAufrufe).toBe(1);
    expect(unmockedRequests).toEqual([]);
  });

  it("keeps the current module visible when realtime status updates during a pending route transition", async () => {
    const idleCallbackScheduled = vi.fn(() => 1);
    Object.defineProperty(window, "requestIdleCallback", { configurable: true, value: idleCallbackScheduled });
    Object.defineProperty(window, "cancelIdleCallback", { configurable: true, value: () => undefined });

    let releasePanel: (() => void) | undefined;
    let panelResolved = false;
    pendingLoader.mockImplementation(() => new Promise((resolve) => {
      releasePanel = () => {
        panelResolved = true;
        resolve({ default: () => <p>Target panel loaded</p> });
      };
    }));

    const activeState = {
      ...channel,
      activeModules: [
        { moduleId: "aktiv", settings: "{}" },
        { moduleId: "pending", settings: "{}" },
      ],
    };
    const moduleStates = [
      { id: "aktiv", enabled: true, settings: "{}" },
      { id: "pending", enabled: true, settings: "{}" },
    ];
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), window.location.origin).pathname;
      if (path === "/api/channels") return response({ channels: [channel], bot: channel.bot });
      if (path === "/api/channels/kanal-a/overview") return response(activeState);
      if (path === "/api/channels/kanal-a/modules") return response({ modules: moduleStates });
      if (path === "/api/channels/kanal-a/system") return response({
        broadcasterConnection: channel.broadcasterConnection,
        bot: channel.bot,
        botPermissions: null,
        broadcasterPermissions: null,
        chatSubscription: channel.chatSubscription,
        tokens: channel.tokens,
      });
      if (path === "/api/channels/kanal-a/events") return response({ entries: [], nextCursor: null });
      if (path === "/api/channels/kanal-a/overlays") return response({ overlays: [] });
      if (path === "/api/channels/kanal-a/settings") return response({ timeZone: "Europe/Berlin", revision: 1, location: null, locationRevision: 1 });
      if (path === "/api/channels/kanal-a/broadcast") return response({ title: "", game: null, manageScopeAvailable: true });
      return response({}, 404);
    }));
    setDashboardRealtimeStatus("kanal-a", "offline");
    window.history.replaceState({}, "", "/channels/kanal-a/modules/aktiv");

    const rendered = render(<DashboardApp />, undefined, { panelRevisions: {} });
    expect(await screen.findByText("Panel geladen")).toBeInTheDocument();
    const nav = await screen.findByRole("navigation", { name: "Hauptnavigation" });
    const targetLink = within(nav).getByRole("link", { name: /pending.*Läuft/u });

    fireEvent.mouseEnter(targetLink);
    await waitFor(() => expect(pendingLoader).toHaveBeenCalledTimes(1));
    expect(panelResolved).toBe(false);

    act(() => {
      targetLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      setDashboardRealtimeStatus("kanal-a", "reconnecting");
    });

    expect(window.location.pathname).toBe("/channels/kanal-a/modules/pending");
    expect(pendingLoader).toHaveBeenCalledTimes(1);
    expect(panelResolved).toBe(false);
    expect(rendered.container.querySelector(".module-view-fallback")).toBeNull();
    expect(screen.getByText("Panel geladen")).toBeInTheDocument();

    releasePanel?.();
    expect(await screen.findByText("Target panel loaded")).toBeInTheDocument();
  });
});
