import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { LiveCockpitTiles } from "../../src/dashboard/LiveCockpitParts";
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
        kind: "vote", id: "poll-free-text", title: "Lunch?", options: [{ label: "pizza", count: 2, approved: false }],
        totalVotes: 2, closesAt: "2030-01-01T12:02:00.000Z", canExtend: true,
      },
      { kind: "votekick_recent", id: "ballot-recent", target: "viewer-a", endedAt: "2030-01-01T12:00:00.000Z" },
    ];
    render(<UiProvider><LiveCockpitTiles
      channelId="channel-a"
      role="operator"
      snapshots={snapshots}
      failedModules={[]}
      adsEnabled={false}
      loading={false}
      failed={false}
      now={Date.parse("2030-01-01T12:00:30.000Z")}
      timeZone="Europe/Berlin"
      onMessage={() => undefined}
      onRefresh={() => undefined}
    /></UiProvider>);

    fireEvent.click(screen.getByRole("button", { name: /Begriff freigeben.*pizza/u }));
    await waitFor(() => expect(requests.mock.calls.some(([input, init]) => requestUrl(input).pathname.endsWith("/approve-term") && init?.method === "POST")).toBe(true));
    const approvalBody = requests.mock.calls.find(([input]) => requestUrl(input).pathname.endsWith("/approve-term"))?.[1]?.body;
    expect(JSON.parse(approvalBody as string)).toEqual({ pollId: "poll-free-text", term: "pizza" });

    fireEvent.click(screen.getByRole("button", { name: /Timeout aufheben/u }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: /Timeout aufheben/u }));
    await waitFor(() => expect(requests.mock.calls.some(([input, init]) => requestUrl(input).pathname.endsWith("/ballot-recent/lift") && init?.method === "POST")).toBe(true));
  });
});
