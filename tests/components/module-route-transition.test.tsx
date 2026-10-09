import { cleanup, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const activeLoader = vi.hoisted(() => vi.fn(() => Promise.resolve({ default: () => <p>Panel geladen</p> })));

vi.mock("../../src/modules/registry", () => ({
  MODULES: [{ id: "aktiv", navigationCategory: "chat", settingsSchema: {}, defaultSettings: {}, panel: activeLoader }],
}));

import { DashboardApp } from "../../src/dashboard/main";
import { renderWithQuery as render } from "../query-test-utils";

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
    vi.unstubAllGlobals();
  });

  it("starts the panel from the cached activity state on navigation", async () => {
    const activeState = { ...channel, activeModules: [{ moduleId: "aktiv", settings: "{}" }] };
    let overviewAufrufe = 0;
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
      return response({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);
    const nav = await screen.findByRole("navigation", { name: "Hauptnavigation" });
    expect(await screen.findByRole("heading", { name: "Alpha", level: 1 })).toBeInTheDocument();
    const link = await within(nav).findByRole("link", { name: /^aktiv.*Läuft$/ });
    expect(activeLoader).not.toHaveBeenCalled();

    link.click();
    expect(activeLoader).not.toHaveBeenCalled();

    expect(await screen.findByText("Panel geladen")).toBeInTheDocument();
    expect(activeLoader).toHaveBeenCalledTimes(1);
    expect(overviewAufrufe).toBe(1);
  });
});
