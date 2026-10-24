import { useEffect } from "react";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const activeLoader = vi.hoisted(() => vi.fn(() => Promise.resolve({ default: () => <p>Panel geladen</p> })));
const pendingLoader = vi.hoisted(() => vi.fn(() => Promise.resolve({ default: () => <p>Target panel loaded</p> })));
// Panel loads are memoized per module, so each held-panel test needs its own target module.
const pendingBackLoader = vi.hoisted(() => vi.fn(() => Promise.resolve({ default: () => <p>Target panel loaded</p> })));

vi.mock("../../src/modules/registry", () => ({
  MODULES: [
    { id: "aktiv", navigationCategory: "chat", settingsSchema: {}, defaultSettings: {}, panel: activeLoader },
    { id: "pending", navigationCategory: "chat", settingsSchema: {}, defaultSettings: {}, panel: pendingLoader },
    { id: "pendingback", navigationCategory: "chat", settingsSchema: {}, defaultSettings: {}, panel: pendingBackLoader },
  ],
}));

import { DashboardApp } from "../../src/dashboard/main";
import { queryKeys } from "../../src/dashboard/data/keys";
import { setDashboardRealtimeStatus } from "../../src/dashboard/data/realtime";
import { dashboardRoutePath, useDashboardRoute, type DashboardRoute } from "../../src/dashboard/router";
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

const routeCommits: string[] = [];
let navigateFromProbe: (route: DashboardRoute) => void = () => undefined;

const DashboardRouteProbe = (): React.JSX.Element => {
  const [route, navigate] = useDashboardRoute();
  useEffect(() => { navigateFromProbe = navigate; }, [navigate]);
  useEffect(() => {
    routeCommits.push(`${dashboardRoutePath(route)}|${window.location.pathname}${window.location.search}`);
  }, [route]);
  return <p>{dashboardRoutePath(route)}</p>;
};

const flushRouteTask = async (): Promise<void> => {
  await act(async () => {
    await new Promise<void>((resolve) => { window.setTimeout(resolve, 0); });
  });
};

describe("Module route during client-side navigation", () => {
  afterEach(() => {
    cleanup();
    setDashboardRealtimeStatus("kanal-a", "offline");
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    routeCommits.length = 0;
    navigateFromProbe = () => undefined;
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

  /** Renders the "aktiv" module with the target module's panel chunk preloaded but held. */
  const renderWithHeldPanel = async (targetId: string, loader: typeof pendingLoader) => {
    const idleCallbackScheduled = vi.fn(() => 1);
    Object.defineProperty(window, "requestIdleCallback", { configurable: true, value: idleCallbackScheduled });
    Object.defineProperty(window, "cancelIdleCallback", { configurable: true, value: () => undefined });

    let releasePanel: (() => void) | undefined;
    let panelResolved = false;
    loader.mockImplementation(() => new Promise((resolve) => {
      releasePanel = () => {
        panelResolved = true;
        resolve({ default: () => <p>Target panel loaded</p> });
      };
    }));

    const activeState = {
      ...channel,
      activeModules: [
        { moduleId: "aktiv", settings: "{}" },
        { moduleId: targetId, settings: "{}" },
      ],
    };
    const moduleStates = [
      { id: "aktiv", enabled: true, settings: "{}" },
      { id: targetId, enabled: true, settings: "{}" },
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
    window.history.replaceState({ __brobotRouteIndex: 1 }, "", "/channels/kanal-a/modules/aktiv");

    const rendered = render(<DashboardApp />, undefined, { panelRevisions: {} });
    expect(await screen.findByText("Panel geladen")).toBeInTheDocument();
    const nav = await screen.findByRole("navigation", { name: "Hauptnavigation" });
    const targetLink = within(nav).getByRole("link", { name: new RegExp(`${targetId}\\b.*Läuft`, "u") });

    fireEvent.mouseEnter(targetLink);
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(1));
    expect(panelResolved).toBe(false);
    return { rendered, targetLink, panelResolved: () => panelResolved, releasePanel: () => { releasePanel?.(); } };
  };

  it("keeps the current module visible when a realtime update arrives during a pending click transition", async () => {
    const { rendered, targetLink, panelResolved, releasePanel } = await renderWithHeldPanel("pending", pendingLoader);

    act(() => {
      targetLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      setDashboardRealtimeStatus("kanal-a", "reconnecting");
    });

    expect(window.location.pathname).toBe("/channels/kanal-a/modules/pending");
    expect(pendingLoader).toHaveBeenCalledTimes(1);
    expect(panelResolved()).toBe(false);
    expect(rendered.container.querySelector(".module-view-fallback")).toBeNull();
    expect(screen.getByText("Panel geladen")).toBeInTheDocument();

    releasePanel();
    expect(await screen.findByText("Target panel loaded")).toBeInTheDocument();
  });

  it("keeps the current module visible when native Back targets a pending panel", async () => {
    const { rendered, panelResolved, releasePanel } = await renderWithHeldPanel("pendingback", pendingBackLoader);

    act(() => {
      window.history.replaceState({ __brobotRouteIndex: 0 }, "", "/channels/kanal-a/modules/pendingback");
      window.dispatchEvent(new PopStateEvent("popstate"));
      setDashboardRealtimeStatus("kanal-a", "reconnecting");
    });

    expect(window.location.pathname).toBe("/channels/kanal-a/modules/pendingback");
    expect(pendingBackLoader).toHaveBeenCalledTimes(1);
    expect(panelResolved()).toBe(false);
    await flushRouteTask();
    expect(rendered.container.querySelector(".module-view-fallback")).toBeNull();
    expect(screen.getByText("Panel geladen")).toBeInTheDocument();

    releasePanel();
    expect(await screen.findByText("Target panel loaded")).toBeInTheDocument();
  });

  it("commits only the final location after rapid Back and Forward events", async () => {
    const systemPath = "/channels/kanal-a/system";
    window.history.replaceState({ __brobotRouteIndex: 1 }, "", systemPath);

    render(<DashboardRouteProbe />);
    expect(await screen.findByText(systemPath)).toBeInTheDocument();
    routeCommits.length = 0;

    act(() => {
      window.history.replaceState({ __brobotRouteIndex: 0 }, "", "/channels/kanal-a/modules/aktiv");
      window.dispatchEvent(new PopStateEvent("popstate"));
      window.history.replaceState({ __brobotRouteIndex: 1 }, "", systemPath);
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await flushRouteTask();

    expect(screen.getByText(systemPath)).toBeInTheDocument();
    expect(routeCommits).toEqual([`${systemPath}|${systemPath}`]);
  });

  it("cancels the scheduled popstate route update when a programmatic navigation supersedes it", async () => {
    const systemPath = "/channels/kanal-a/system";
    window.history.replaceState({ __brobotRouteIndex: 1 }, "", systemPath);

    render(<DashboardRouteProbe />);
    expect(await screen.findByText(systemPath)).toBeInTheDocument();
    routeCommits.length = 0;

    act(() => {
      window.history.replaceState({ __brobotRouteIndex: 0 }, "", "/channels/kanal-a/modules/aktiv");
      window.dispatchEvent(new PopStateEvent("popstate"));
      navigateFromProbe({ kind: "platform" });
    });
    await flushRouteTask();

    expect(window.location.pathname).toBe("/platform");
    expect(screen.getByText("/platform")).toBeInTheDocument();
    expect(routeCommits).toEqual(["/platform|/platform"]);
  });

  it("cancels the scheduled popstate route update when the router unmounts", async () => {
    const systemPath = "/channels/kanal-a/system";
    window.history.replaceState({ __brobotRouteIndex: 1 }, "", systemPath);
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    const rendered = render(<DashboardRouteProbe />);
    expect(await screen.findByText(systemPath)).toBeInTheDocument();
    const firstPopstateTimer = setTimeoutSpy.mock.calls.length;
    act(() => {
      window.history.replaceState({ __brobotRouteIndex: 0 }, "", "/channels/kanal-a/modules/aktiv");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(setTimeoutSpy.mock.results[firstPopstateTimer]?.value).toBeDefined();

    rendered.unmount();

    expect(clearTimeoutSpy).toHaveBeenCalledWith(setTimeoutSpy.mock.results[firstPopstateTimer]?.value);
    expect(routeCommits).toEqual([`${systemPath}|${systemPath}`]);
  });
});
