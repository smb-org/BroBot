import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import ChatVotingImmediateAction from "../../src/modules/chat_voting/panel/immediate-actions";
import { jsonResponse } from "../unit/fixtures";

describe("chat voting immediate action", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("loads the shared template list and starts a saved vote", async () => {
    const started = vi.fn();
    let currentVote: Record<string, unknown> | null = null;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input, init) => {
      const path = input instanceof Request
        ? new URL(input.url).pathname
        : new URL(String(input), "https://brobot.example").pathname;
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (path.endsWith("/current")) return Promise.resolve(jsonResponse({ vote: currentVote, counts: null, revision: 1, terms: null, moreTerms: null, hasOpenBallot: false, defaultDurationSeconds: 120 }));
      if (path.endsWith("/templates")) return Promise.resolve(jsonResponse({ templates: [{
        id: "template-dinner", channelId: "channel-a", shortcut: "essen", title: "Dinner", labels: ["Pizza", "Burger"],
        freeTextMode: null, durationSeconds: 120, revision: 1, legacyAlias: null, lastUsedAt: null,
        createdAt: "2026-10-04T10:00:00.000Z", updatedAt: "2026-10-04T10:00:00.000Z",
      }], count: 1, maximum: 100 }));
      if (path.endsWith("/start")) {
        started(typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null);
        currentVote = {
          id: "poll-a", channelId: "channel-a", kind: "options", optionCount: 2, labels: ["Pizza", "Burger"],
          title: "Dinner", status: "open", openedAt: "2026-10-04T10:00:00.000Z", closesAt: "2026-10-04T10:02:00.000Z",
          requestedDurationSeconds: 120, closedAt: null, closeReason: null, counts: [0, 0], voterCount: 0,
        };
        return Promise.resolve(jsonResponse({ vote: currentVote }));
      }
      return Promise.resolve(jsonResponse({ closing: true, pollId: "poll-a" }));
    }));
    render(<UiProvider><ChatVotingImmediateAction channelId="channel-a" canManage availabilityReason={null} /></UiProvider>);

    expect(await screen.findByRole("button", { name: /Dinner/u })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /Dinner/u }));
    await waitFor(() => expect(started).toHaveBeenCalledWith({ templateId: "template-dinner" }));
    expect(await screen.findByRole("button", { name: /End vote|Beenden/u })).toBeVisible();
  });
});
