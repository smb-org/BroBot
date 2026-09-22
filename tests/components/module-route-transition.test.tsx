import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const activeLoader = vi.hoisted(() => vi.fn(() => Promise.resolve({ default: () => <p>Panel geladen</p> })));

vi.mock("../../src/modules/registry", () => ({
  MODULES: [{ id: "aktiv", settingsSchema: {}, defaultSettings: {}, panel: activeLoader }],
}));

import { DashboardApp } from "../../src/dashboard/main";

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

describe("Modulroute beim clientseitigen Wechsel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("startet das Panel erst nach der neuen Aktivitätsprüfung", async () => {
    const activeState = { ...channel, activeModules: [{ moduleId: "aktiv", settings: "{}" }] };
    const inactiveState = { ...channel, activeModules: [] };
    let overviewAufrufe = 0;
    let resolveSecondResponse!: (value: Response) => void;
    const secondResponse = new Promise<Response>((resolve) => { resolveSecondResponse = resolve; });
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), window.location.origin).pathname;
      if (path === "/api/channels") return response({ channels: [channel] });
      if (path === "/api/channels/kanal-a/overview") {
        overviewAufrufe += 1;
        return overviewAufrufe === 1 ? response(activeState) : secondResponse;
      }
      return response({}, 404);
    }));
    window.history.replaceState({}, "", "/channels/kanal-a");

    render(<DashboardApp />);
    const link = await screen.findByRole("link", { name: /^aktiv · Läuft$/ });
    expect(activeLoader).not.toHaveBeenCalled();

    link.click();
    expect(activeLoader).not.toHaveBeenCalled();

    resolveSecondResponse(response(inactiveState));
    expect(await screen.findByText("Module werden geladen …")).toBeInTheDocument();
    expect(screen.queryByText("Das Modul „aktiv“ ist in diesem Kanal nicht aktiv.")).not.toBeInTheDocument();
    expect(activeLoader).not.toHaveBeenCalled();
  });
});
