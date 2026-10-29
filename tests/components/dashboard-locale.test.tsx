import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardApp } from "../../src/dashboard/main";
import { renderWithQuery as render } from "../query-test-utils";

describe("Panel document language", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });
  });

  it("sets lang to match the selected browser language", async () => {
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ channels: [] })))));

    render(<DashboardApp />);

    await waitFor(() => expect(document.documentElement.lang).toBe("en"));
  });

  it("renders subscription and permission states in English", async () => {
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    const channel = {
      channelId: "kanal-a", login: "alpha", displayName: "Alpha", role: "manager",
      broadcasterConnection: "connected", channelBotConsent: "granted",
      bot: { status: "connected", reason: null, updatedAt: "2026-09-18T04:00:00.000Z" },
      botPermissions: { missingScopes: [] }, moderator: { isModerator: true, checkedAt: "2026-09-18T04:00:00.000Z", reason: null },
      chatSubscription: { status: "missing", subscriptionId: "chat-1", reason: "verification_pending", updatedAt: "2026-09-18T04:00:00.000Z" },
      tokens: { botExpiresAt: "2099-09-19T00:00:00.000Z", loginStatus: "connected", loginReason: null, loginExpiresAt: "2099-09-19T00:00:00.000Z" },
      lastError: null,
    };
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), window.location.origin);
      if (url.pathname === "/api/channels") return Promise.resolve(new Response(JSON.stringify({ channels: [channel], bot: channel.bot }), { status: 200 }));
      if (url.pathname.endsWith("/system")) return Promise.resolve(new Response(JSON.stringify({
        broadcasterConnection: "connected", bot: channel.bot, botPermissions: { missingScopes: [] }, chatSubscription: channel.chatSubscription, chatSubscriptionNeeded: true,
        subscriptions: [
          { subscriptionType: "channel.raid", variant: "incoming", version: "1", subscriptionId: "raid-1", status: "enabled", reason: null, message: null, statusCode: null, updatedAt: "2026-09-18T04:00:00.000Z" },
          { subscriptionType: "channel.future-verification", variant: "", version: "1", subscriptionId: "verification-1", status: "missing", reason: "verification_pending", message: null, statusCode: null, updatedAt: "2026-09-18T03:00:00.000Z" },
        ], tokens: channel.tokens,
      }), { status: 200 }));
      if (url.pathname.endsWith("/audit-log")) return Promise.resolve(new Response(JSON.stringify({ entries: [], nextCursor: null }), { status: 200 }));
      return Promise.resolve(new Response("{}", { status: 404 }));
    }));
    window.history.replaceState({}, "", "/channels/kanal-a/system");

    render(<DashboardApp />);

    expect(await screen.findByRole("columnheader", { name: "Subscription" })).toBeInTheDocument();
    expect(screen.getByText("Incoming raids")).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Bot permissions" })).toHaveAttribute("data-status", "healthy");
    expect(screen.getByRole("article", { name: "Chat subscription" })).toHaveAttribute("data-status", "neutral");
    expect(screen.getByRole("article", { name: "Chat subscription" }).querySelector(".status-led")).toHaveAttribute("aria-label", "Verification pending");
    const verificationPending = screen.getByText("channel.future-verification").closest("tr");
    expect(verificationPending?.querySelector(".status-led")).toHaveAttribute("data-status", "off");
    expect(verificationPending?.querySelector(".status-led")).toHaveAttribute("aria-label", "Verification pending");
    expect(verificationPending).toHaveTextContent("Verification pending");
    expect(verificationPending).not.toHaveTextContent("verification_pending");
  });
});
