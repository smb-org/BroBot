import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { ToastHost } from "../../src/dashboard/ui/Toast";
import { dismissToast, toastsSnapshot } from "../../src/dashboard/ui/toast-store";
import ChatVotingImmediateAction from "../../src/modules/chat_voting/panel/immediate-actions";
import { jsonResponse } from "../unit/fixtures";

describe("chat voting immediate action", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); for (const toast of toastsSnapshot()) dismissToast(toast.id); });

  it("loads the shared template list and starts a saved vote", async () => {
    const started = vi.fn();
    let currentVote: Record<string, unknown> | null = null;
    const savedTemplate = {
      id: "template-dinner", channelId: "channel-a", shortcut: "essen", title: "Dinner", labels: ["Pizza", "Burger"],
      freeTextMode: null, durationSeconds: 120, revision: 1, legacyAlias: null, lastUsedAt: null as string | null,
      createdAt: "2026-10-04T10:00:00.000Z", updatedAt: "2026-10-04T10:00:00.000Z",
    };
    let serverTemplate = savedTemplate;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input, init) => {
      const path = input instanceof Request
        ? new URL(input.url).pathname
        : new URL(String(input), "https://brobot.example").pathname;
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (path.endsWith("/current")) return Promise.resolve(jsonResponse({ vote: currentVote, counts: null, revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 120 }));
      if (path.endsWith("/templates")) return Promise.resolve(jsonResponse({ templates: [serverTemplate], count: 1, maximum: 100 }));
      if (path.endsWith("/start")) {
        started(typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null);
        currentVote = {
          id: "poll-a", channelId: "channel-a", kind: "options", optionCount: 2, labels: ["Pizza", "Burger"],
          title: "Dinner", status: "open", openedAt: "2026-10-04T10:00:00.000Z", closesAt: "2026-10-04T10:02:00.000Z",
          requestedDurationSeconds: 120, closedAt: null, closeReason: null, counts: [0, 0], voterCount: 0,
        };
        serverTemplate = { ...serverTemplate, lastUsedAt: "2026-10-04T10:00:00.000Z" };
        return Promise.resolve(jsonResponse({ vote: currentVote }));
      }
      return Promise.resolve(jsonResponse({ closing: true, pollId: "poll-a" }));
    }));
    render(<UiProvider><ChatVotingImmediateAction channelId="channel-a" canManage availabilityReason={null} /></UiProvider>);

    expect(await screen.findByRole("button", { name: /Dinner/u })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Dinner/u }));
    await waitFor(() => expect(started).toHaveBeenCalledWith({ templateId: "template-dinner" }));
    expect(await screen.findByRole("button", { name: /End vote|Beenden/u })).toBeVisible();
    await waitFor(() => expect(document.querySelector(".chat-voting-template-list")).toHaveTextContent(/Running|Läuft/u));
    expect(document.querySelector(".chat-voting-template-list .list-row__action button")).toBeNull();
  });

  it("allows operators to use Start and reports server authorization failures as a toast", async () => {
    const attempted = vi.fn();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const path = input instanceof Request
        ? new URL(input.url).pathname
        : new URL(String(input), "https://brobot.example").pathname;
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (path.endsWith("/current")) return Promise.resolve(jsonResponse({ vote: null, counts: null, revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 120 }));
      if (path.endsWith("/templates")) return Promise.resolve(jsonResponse({ templates: [{
        id: "template-dinner", channelId: "channel-a", shortcut: "essen", title: "Dinner", labels: ["Pizza", "Burger"],
        freeTextMode: null, durationSeconds: 120, revision: 1, legacyAlias: null, lastUsedAt: null,
        createdAt: "2026-10-04T10:00:00.000Z", updatedAt: "2026-10-04T10:00:00.000Z",
      }], count: 1, maximum: 100 }));
      if (path.endsWith("/start")) {
        attempted();
        return Promise.resolve(jsonResponse({ error: "chat_voting_not_authorized" }, 403));
      }
      return Promise.resolve(jsonResponse({ error: "not_found" }, 404));
    }));
    render(<UiProvider><ToastHost /><ChatVotingImmediateAction channelId="channel-a" canManage={false} availabilityReason={null} /></UiProvider>);

    const start = await screen.findByRole("button", { name: /Dinner/u });
    expect(start).toBeEnabled();
    fireEvent.click(start);
    await waitFor(() => expect(attempted).toHaveBeenCalledOnce());
    expect(await screen.findByText(/The vote could not be started\.|Die Abstimmung konnte nicht gestartet werden\./u)).toBeInTheDocument();
  });

  it("allows operators to use End and reports server authorization failures as a toast", async () => {
    const attempted = vi.fn();
    const currentVote = {
      id: "poll-a", channelId: "channel-a", kind: "options", optionCount: 2, labels: ["Pizza", "Burger"],
      title: "Dinner", status: "open", openedAt: "2026-10-04T10:00:00.000Z", closesAt: "2026-10-04T10:02:00.000Z",
      requestedDurationSeconds: 120, closedAt: null, closeReason: null, counts: [0, 0], voterCount: 0,
    };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const path = input instanceof Request
        ? new URL(input.url).pathname
        : new URL(String(input), "https://brobot.example").pathname;
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (path.endsWith("/current")) return Promise.resolve(jsonResponse({ vote: currentVote, counts: [0, 0], revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 120 }));
      if (path.endsWith("/templates")) return Promise.resolve(jsonResponse({ templates: [], count: 0, maximum: 100 }));
      if (path.endsWith("/close")) {
        attempted();
        return Promise.resolve(jsonResponse({ error: "chat_voting_not_authorized" }, 403));
      }
      return Promise.resolve(jsonResponse({ error: "not_found" }, 404));
    }));
    render(<UiProvider><ToastHost /><ChatVotingImmediateAction channelId="channel-a" canManage={false} availabilityReason={null} /></UiProvider>);

    fireEvent.click(await screen.findByRole("button", { name: /End vote|Beenden/u }));
    await waitFor(() => expect(attempted).toHaveBeenCalledOnce());
    expect(await screen.findByText(/The vote could not be ended\.|Die Abstimmung konnte nicht beendet werden\./u)).toBeInTheDocument();
  });

  it("refreshes saved-template running markers when polling sees an external start", async () => {
    let currentVote: Record<string, unknown> | null = null;
    let currentCalls = 0;
    const openedAt = "2026-10-04T10:00:00.000Z";
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const path = input instanceof Request
        ? new URL(input.url).pathname
        : new URL(String(input), "https://brobot.example").pathname;
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (path.endsWith("/current")) {
        currentCalls += 1;
        return Promise.resolve(jsonResponse({ vote: currentVote, counts: null, revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 120 }));
      }
      if (path.endsWith("/templates")) return Promise.resolve(jsonResponse({ templates: [{
        id: "template-dinner", channelId: "channel-a", shortcut: "essen", title: "Dinner", labels: ["Pizza", "Burger"],
        freeTextMode: null, durationSeconds: 120, revision: 1, legacyAlias: null,
        lastUsedAt: currentVote === null ? null : openedAt,
        createdAt: "2026-10-04T10:00:00.000Z", updatedAt: "2026-10-04T10:00:00.000Z",
      }], count: 1, maximum: 100 }));
      return Promise.resolve(jsonResponse({ error: "not_found" }, 404));
    }));
    render(<UiProvider><ChatVotingImmediateAction channelId="channel-a" canManage availabilityReason={null} /></UiProvider>);
    await screen.findByRole("button", { name: /Dinner/u });
    await waitFor(() => expect(currentCalls).toBeGreaterThan(0));
    currentVote = {
      id: "poll-external", channelId: "channel-a", kind: "options", optionCount: 2, labels: ["Pizza", "Burger"],
      title: "Dinner", status: "open", openedAt, closesAt: "2026-10-04T10:02:00.000Z",
      requestedDurationSeconds: 120, closedAt: null, closeReason: null, counts: [0, 0], voterCount: 0,
    };
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(document.querySelector(".chat-voting-template-list")).toHaveTextContent(/Running|Läuft/u));
  });
});
