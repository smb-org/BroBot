import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { reconcileDashboardPanelResourceRevisions, setDashboardRealtimeStatus } from "../../src/dashboard/data/realtime";
import { ToastHost } from "../../src/dashboard/ui/Toast";
import { dismissToast, toastsSnapshot } from "../../src/dashboard/ui/toast-store";
import ChatVotingImmediateAction from "../../src/modules/chat_voting/panel/immediate-actions";
import { jsonResponse } from "../unit/fixtures";
import { renderWithQuery } from "../query-test-utils";

const render = (element: Parameters<typeof renderWithQuery>[0]) => {
  setDashboardRealtimeStatus("channel-a", "connected");
  return renderWithQuery(element);
};

describe("chat voting immediate action", () => {
  afterEach(() => { cleanup(); setDashboardRealtimeStatus("channel-a", "offline"); vi.unstubAllGlobals(); for (const toast of toastsSnapshot()) dismissToast(toast.id); });

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

  it("keeps the template order fixed after a lower row starts", async () => {
    let currentVote: Record<string, unknown> | null = null;
    const openedAt = "2026-10-04T10:00:00.000Z";
    const first = {
      id: "template-alpha", channelId: "channel-a", shortcut: null, title: "Alpha", labels: ["A", "B"],
      freeTextMode: null, durationSeconds: 120, revision: 1, legacyAlias: null, lastUsedAt: null as string | null,
      createdAt: "2026-10-04T10:00:00.000Z", updatedAt: "2026-10-04T10:00:00.000Z",
    };
    const second = { ...first, id: "template-zeta", title: "Zeta" };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const path = input instanceof Request
        ? new URL(input.url).pathname
        : new URL(String(input), "https://brobot.example").pathname;
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (path.endsWith("/current")) return Promise.resolve(jsonResponse({
        vote: currentVote, counts: null, revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 120,
      }));
      if (path.endsWith("/templates")) {
        const templates = currentVote === null ? [first, second] : [{ ...second, lastUsedAt: openedAt }, first];
        return Promise.resolve(jsonResponse({ templates, count: 2, maximum: 100 }));
      }
      if (path.endsWith("/start")) {
        currentVote = {
          id: "poll-zeta", channelId: "channel-a", kind: "options", optionCount: 2, labels: ["A", "B"],
          title: "Zeta", status: "open", openedAt, closesAt: "2026-10-04T10:02:00.000Z",
          requestedDurationSeconds: 120, closedAt: null, closeReason: "timer", counts: [0, 0], voterCount: 0,
        };
        return Promise.resolve(jsonResponse({ vote: currentVote }));
      }
      return Promise.resolve(jsonResponse({ error: "not_found" }, 404));
    }));
    render(<UiProvider><ChatVotingImmediateAction channelId="channel-a" canManage availabilityReason={null} /></UiProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /Zeta/u }));
    await waitFor(() => expect(document.querySelector(".chat-voting-template-list")).toHaveTextContent(/Running|Läuft/u));
    const titles = [...document.querySelectorAll(".chat-voting-template-list .list-row__title")].map((element) => element.textContent);
    expect(titles).toEqual(["Alpha", "Zeta"]);
  });

  it("ignores a late live response after a newer resource revision reports the vote ended", async () => {
    let resolveFirst!: (response: Response) => void;
    const first = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    let currentCalls = 0;
    let revision = 0;
    const openVote = {
      id: "poll-a", channelId: "channel-a", kind: "options", optionCount: 2, labels: ["A", "B"],
      title: "Dinner", status: "open", openedAt: "2026-10-04T10:00:00.000Z", closesAt: "2026-10-04T10:02:00.000Z",
      requestedDurationSeconds: 120, closedAt: null, closeReason: "timer", counts: [0, 0], voterCount: 0,
    };
    const closedVote = { ...openVote, status: "closed", closedAt: "2026-10-04T10:02:00.000Z" };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const path = input instanceof Request
        ? new URL(input.url).pathname
        : new URL(String(input), "https://brobot.example").pathname;
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (path.endsWith("/revisions")) return Promise.resolve(jsonResponse({ revisions: revision === 0 ? {} : { "module:chat_voting:panel": revision } }));
      if (path.endsWith("/current")) {
        currentCalls += 1;
        if (currentCalls === 1) return first;
        return Promise.resolve(jsonResponse({ vote: closedVote, counts: null, revision: 2, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 120 }));
      }
      if (path.endsWith("/templates")) return Promise.resolve(jsonResponse({ templates: [{
        id: "template-dinner", channelId: "channel-a", shortcut: null, title: "Dinner", labels: ["A", "B"],
        freeTextMode: null, durationSeconds: 120, revision: 1, legacyAlias: null, lastUsedAt: null,
        createdAt: "2026-10-04T10:00:00.000Z", updatedAt: "2026-10-04T10:00:00.000Z",
      }], count: 1, maximum: 100 }));
      return Promise.resolve(jsonResponse({ error: "not_found" }, 404));
    }));
    const view = render(<UiProvider><ChatVotingImmediateAction channelId="channel-a" canManage availabilityReason={null} /></UiProvider>);
    await waitFor(() => expect(currentCalls).toBe(1));
    revision = 1;
    await act(async () => { await reconcileDashboardPanelResourceRevisions(view.queryClient, "channel-a"); });
    await waitFor(() => expect(currentCalls).toBe(2));
    const start = await screen.findByRole("button", { name: /Dinner/u });
    await waitFor(() => expect(start).toBeEnabled());
    resolveFirst(jsonResponse({ vote: openVote, counts: [0, 0], revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 120 }));
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(start).toBeEnabled();
    expect(screen.queryByRole("button", { name: /End vote|Beenden/u })).not.toBeInTheDocument();
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

  it("refreshes saved-template running markers from panel resource revisions", async () => {
    let currentVote: Record<string, unknown> | null = null;
    let currentCalls = 0;
    let revisions: Readonly<Record<string, number>> = {};
    const openedAt = "2026-10-04T10:00:00.000Z";
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const path = input instanceof Request
        ? new URL(input.url).pathname
        : new URL(String(input), "https://brobot.example").pathname;
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (path.endsWith("/revisions")) return Promise.resolve(jsonResponse({ revisions }));
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
    const view = render(<UiProvider><ChatVotingImmediateAction channelId="channel-a" canManage availabilityReason={null} /></UiProvider>);
    await screen.findByRole("button", { name: /Dinner/u });
    await waitFor(() => expect(currentCalls).toBeGreaterThan(0));
    currentVote = {
      id: "poll-external", channelId: "channel-a", kind: "options", optionCount: 2, labels: ["Pizza", "Burger"],
      title: "Dinner", status: "open", openedAt, closesAt: "2026-10-04T10:02:00.000Z",
      requestedDurationSeconds: 120, closedAt: null, closeReason: null, counts: [0, 0], voterCount: 0,
    };
    revisions = { "module:chat_voting:panel": 1, "module:chat_voting:templates": 1 };
    await act(async () => { await reconcileDashboardPanelResourceRevisions(view.queryClient, "channel-a"); });
    await waitFor(() => expect(document.querySelector(".chat-voting-template-list")).toHaveTextContent(/Running|Läuft/u));
  });
});
