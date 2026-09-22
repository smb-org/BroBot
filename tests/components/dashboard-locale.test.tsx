import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardApp } from "../../src/dashboard/main";

describe("Panel-Dokumentensprache", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });
  });

  it("setzt lang passend zur gewählten Browsersprache", async () => {
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ channels: [] })))));

    render(<DashboardApp />);

    await waitFor(() => expect(document.documentElement.lang).toBe("en"));
  });

  it("rendert Abo- und Berechtigungszustände auf Englisch", async () => {
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    const channel = {
      channelId: "kanal-a", login: "alpha", displayName: "Alpha", role: "manager",
      broadcasterConnection: "connected", channelBotConsent: "granted",
      bot: { status: "connected", reason: null, updatedAt: "2026-09-18T04:00:00.000Z" },
      botPermissions: { missingScopes: [] }, moderator: { isModerator: true, checkedAt: "2026-09-18T04:00:00.000Z", reason: null },
      chatSubscription: { status: "enabled", subscriptionId: "chat-1", reason: null, updatedAt: "2026-09-18T04:00:00.000Z" },
      tokens: { botExpiresAt: "2099-09-19T00:00:00.000Z", loginStatus: "connected", loginReason: null, loginExpiresAt: "2099-09-19T00:00:00.000Z" },
      lastError: null,
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), window.location.origin);
      if (url.pathname === "/api/channels") return Promise.resolve(new Response(JSON.stringify({ channels: [channel] }), { status: 200 }));
      if (url.pathname.endsWith("/system")) return Promise.resolve(new Response(JSON.stringify({
        broadcasterConnection: "connected", bot: channel.bot, botPermissions: { missingScopes: [] }, chatSubscription: channel.chatSubscription,
        subscriptions: [{ subscriptionType: "channel.raid", variant: "incoming", version: "1", subscriptionId: "raid-1", status: "enabled", reason: null, message: null, statusCode: null, updatedAt: "2026-09-18T04:00:00.000Z" }], tokens: channel.tokens,
      }), { status: 200 }));
      if (url.pathname.endsWith("/audit-log")) return Promise.resolve(new Response(JSON.stringify({ entries: [], nextCursor: null }), { status: 200 }));
      return Promise.resolve(new Response("{}", { status: 404 }));
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/system");

    render(<DashboardApp />);

    expect(await screen.findByRole("columnheader", { name: "Subscription" })).toBeInTheDocument();
    expect(screen.getByText("Incoming raids")).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Bot permissions" })).toHaveAttribute("data-status", "healthy");
  });
});
