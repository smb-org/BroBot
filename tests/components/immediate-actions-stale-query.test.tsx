import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImmediateActions } from "../../src/dashboard/ImmediateActions";
import { dashboardTexts } from "../../src/dashboard/locale";
import { moduleQueryKey } from "../../src/dashboard/data";
import { setDashboardRealtimeStatus } from "../../src/dashboard/data/realtime";
import { UiProvider } from "../../src/dashboard/ui";
import { renderWithQuery } from "../query-test-utils";

const channelId = "channel-stale-vote";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  setDashboardRealtimeStatus(channelId, "offline");
});

describe("immediate action shared availability query", () => {
  it("clears a cached running vote lock on refresh failure and resumes derivation after success", async () => {
    let failed = false;
    let vote: unknown = {
      id: "vote-active",
      status: "open",
      closesAt: new Date(Date.now() + 90_000).toISOString(),
    };
    const fetchMock = vi.fn((): Promise<Response> => Promise.resolve(new Response(
      JSON.stringify(failed ? { error: "unavailable" } : { vote }),
      { status: failed ? 503 : 200, headers: { "Content-Type": "application/json" } },
    )));
    vi.stubGlobal("fetch", fetchMock);
    setDashboardRealtimeStatus(channelId, "connected");

    const { queryClient } = renderWithQuery(<UiProvider><ImmediateActions
      channelId={channelId}
      streamState="online"
      role="operator"
      modules={[{ id: "chat_voting", enabled: true }]}
    /></UiProvider>);
    const startVote = await screen.findByRole<HTMLButtonElement>("button", { name: /Abstimmung starten|Start vote/u });

    await waitFor(() => expect(startVote.textContent).toMatch(/Abstimmung läuft noch|Voting is running/u));
    expect(startVote.disabled).toBe(true);

    failed = true;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: moduleQueryKey(channelId, "chat_voting", "live"), exact: true });
    });

    await waitFor(() => expect(startVote.disabled).toBe(false));
    const staleMessage = dashboardTexts().streamManager.actionAvailabilityStale;
    expect(startVote.textContent).toContain(staleMessage);

    failed = false;
    vote = null;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: moduleQueryKey(channelId, "chat_voting", "live"), exact: true });
    });

    await waitFor(() => expect(startVote.textContent).not.toContain(staleMessage));
    expect(startVote.disabled).toBe(false);
  });
});
