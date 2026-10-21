import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { LiveCockpitTiles } from "../../src/dashboard/LiveCockpitParts";
import { dashboardTexts } from "../../src/dashboard/locale";
import VoteActionContent from "../../src/modules/chat_voting/panel/action-content";
import type { ModuleLiveTileSnapshot } from "../../src/modules/contract";
import { jsonResponse } from "../unit/fixtures";
import { renderWithQuery as render } from "../query-test-utils";

const requestUrl = (input: RequestInfo | URL): URL => input instanceof Request
  ? new URL(input.url)
  : input instanceof URL ? input : new URL(input, "https://brobot.example");

describe("live cockpit voting actions", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("uses singular and plural vote labels in both cockpit languages", () => {
    const german = dashboardTexts("de").liveCockpit;
    const english = dashboardTexts("en").liveCockpit;

    expect(german.voteTotal("1")).toBe("1 Stimme gesamt");
    expect(german.voteTotal("2")).toBe("2 Stimmen gesamt");
    expect(german.voteOptionCount("1", "100")).toBe("1 Stimme · 100 %");
    expect(german.voteOptionCount("2", "50")).toBe("2 Stimmen · 50 %");
    expect(english.voteTotal("1")).toBe("1 vote total");
    expect(english.voteTotal("2")).toBe("2 votes total");
    expect(english.voteOptionCount("1", "100")).toBe("1 vote · 100%");
    expect(english.voteOptionCount("2", "50")).toBe("2 votes · 50%");
  });

  it("lets operators approve free-text terms and lift a completed votekick timeout", async () => {
    const requests = vi.fn<typeof fetch>((input) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-live" }));
      if (url.pathname.endsWith("/approve-term")) {
        return Promise.resolve(jsonResponse({ terms: [{ term: "pizza", count: 2, approved: true }], moreTerms: 0, revision: 4 }));
      }
      if (url.pathname.endsWith("/ballot-recent/lift")) return Promise.resolve(jsonResponse({ liftedAt: "2030-01-01T12:00:00.000Z" }));
      return Promise.resolve(jsonResponse({ error: "not_found" }, 404));
    });
    vi.stubGlobal("fetch", requests);
    const snapshots: ModuleLiveTileSnapshot[] = [
      {
        kind: "vote", id: "poll-free-text", title: "Lunch?", options: [{ label: "pizza", count: 2, approved: false, color: "#2ed3a3" }],
        totalVotes: 2, closesAt: "2030-01-01T12:02:00.000Z", canExtend: true,
      },
      { kind: "votekick_recent", id: "ballot-recent", target: "viewer-a", endedAt: "2030-01-01T12:00:00.000Z" },
    ];
    render(<UiProvider><LiveCockpitTiles
      channelId="channel-a"
      role="operator"
      snapshots={snapshots}
      loading={false}
      failed={false}
      now={Date.parse("2030-01-01T12:00:30.000Z")}
      timeZone="Europe/Berlin"
      onMessage={() => undefined}
      onRefresh={() => undefined}
    /></UiProvider>);

    expect((screen.getByTestId("live-vote-tile").querySelector(".live-vote-tile__track > span") as HTMLElement).style.backgroundColor).toBe("rgb(46, 211, 163)");

    fireEvent.click(screen.getByRole("button", { name: /Begriff freigeben.*pizza/u }));
    await waitFor(() => expect(requests.mock.calls.some(([input, init]) => requestUrl(input).pathname.endsWith("/approve-term") && init?.method === "POST")).toBe(true));
    const approvalBody = requests.mock.calls.find(([input]) => requestUrl(input).pathname.endsWith("/approve-term"))?.[1]?.body;
    expect(JSON.parse(approvalBody as string)).toEqual({ pollId: "poll-free-text", term: "pizza" });

    fireEvent.click(screen.getByRole("button", { name: /Timeout aufheben/u }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Timeout aufheben/u }));
    await waitFor(() => expect(requests.mock.calls.some(([input, init]) => requestUrl(input).pathname.endsWith("/ballot-recent/lift") && init?.method === "POST")).toBe(true));
  });

  it("offers only saved votes enabled for the cockpit start dialog", async () => {
    const now = "2030-01-01T12:00:00.000Z";
    const offered = {
      id: "offered", channelId: "channel-a", shortcut: "offered", title: "Cockpit vote", resultText: "{vote.result}",
      labels: ["Yes", "No"], answerColors: ["#5b8cff", "#ff9f43"], offerInCockpit: true, freeTextMode: null,
      durationSeconds: 60, revision: 1, legacyAlias: null, lastUsedAt: null, createdAt: now, updatedAt: now,
    };
    const chatOnly = { ...offered, id: "chat-only", shortcut: "chat", title: "Chat-only vote", offerInCockpit: false };
    const requests = vi.fn<typeof fetch>((input) => {
      if (requestUrl(input).pathname.endsWith("/templates")) {
        return Promise.resolve(jsonResponse({ templates: [offered, chatOnly], count: 2, maximum: 100 }));
      }
      return Promise.resolve(jsonResponse({ error: "not_found" }, 404));
    });
    vi.stubGlobal("fetch", requests);
    render(<UiProvider><VoteActionContent channelId="channel-a" language="en" /></UiProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Saved" }));
    const chooser = await screen.findByRole("combobox", { name: "Vote" });
    fireEvent.click(chooser);
    expect(await screen.findByRole("option", { name: "Cockpit vote" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Chat-only vote" })).not.toBeInTheDocument();
  });
});
