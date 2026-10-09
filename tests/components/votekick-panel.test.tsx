import { act, cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { dismissToast, toastsSnapshot } from "../../src/dashboard/ui/toast-store";
import VotekickPanel from "../../src/modules/votekick/panel";
import type { Votekick } from "../../src/modules/votekick/contracts";
import { setDashboardRealtimeStatus } from "../../src/dashboard/data/realtime";
import { jsonResponse } from "../unit/fixtures";
import { renderWithQuery as render } from "../query-test-utils";

const running: Votekick = {
  id: "ballot-a",
  targetUserId: "target-a",
  targetLogin: "sampleviewer",
  initiatorUserId: "starter-a",
  status: "running",
  threshold: 3,
  yesVotes: 1,
  noVotes: 0,
  ballotRevision: 1,
  durationSeconds: null,
  startedAt: "2026-10-04T11:00:00.000Z",
  endsAt: "2026-10-04T11:01:00.000Z",
  endedAt: null,
  liftedAt: null,
};

afterEach(() => {
  cleanup();
  setDashboardRealtimeStatus("channel-a", "offline");
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Votekick panel", () => {
  it("polls while idle and discovers a votekick started in chat", async () => {
    let hasRunningVote = false;
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({
      running: hasRunningVote ? running : null,
      votekicks: hasRunningVote ? [running] : [],
      now: "2026-10-04T11:00:00.000Z",
    })));
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><VotekickPanel channelId="channel-a" language="en" /></UiProvider>);
    expect(await screen.findByText("No votekick yet. Start one in chat with !votekick @user.")).toBeInTheDocument();

    hasRunningVote = true;
    await new Promise((resolve) => setTimeout(resolve, 2_100));

    expect(await screen.findByText("sampleviewer")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("pauses its fallback poll while realtime is connected and resumes it offline", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({ running: null, votekicks: [], now: "2026-10-04T11:00:00.000Z" })));
    vi.stubGlobal("fetch", fetcher);
    setDashboardRealtimeStatus("channel-a", "connected");
    render(<UiProvider><VotekickPanel channelId="channel-a" language="en" /></UiProvider>);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(fetcher).toHaveBeenCalledTimes(1);

    act(() => { setDashboardRealtimeStatus("channel-a", "offline"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps the cancel action disabled for viewers without operational access", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({
      running,
      votekicks: [running],
      now: "2026-10-04T11:00:00.000Z",
    }))));
    render(<UiProvider><VotekickPanel channelId="channel-a" language="en" canOperate={false} /></UiProvider>);
    expect(await screen.findByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByTestId("votekick-operation-permission-reason")).toHaveTextContent("Your channel role cannot operate votekicks.");
  });

  it("keeps the running-votekick and history boxes reserved while the countdown runs", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({
      running,
      votekicks: [running],
      now: "2026-10-04T11:00:00.000Z",
    }))));
    render(<UiProvider><VotekickPanel channelId="channel-a" language="en" /></UiProvider>);

    expect(await screen.findByTestId("votekick-running-slot")).toBeInTheDocument();
    expect(screen.getByTestId("votekick-history-list")).toBeInTheDocument();
  });

  it("shows only one persistent load toast during repeated failed refreshes", async () => {
    vi.useFakeTimers();
    const previousToastIds = new Set(toastsSnapshot().map((toast) => toast.id));
    const fetcher = vi.fn<typeof fetch>(() => Promise.reject(new Error("network unavailable")));
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><VotekickPanel channelId="channel-a" language="en" /></UiProvider>);

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000);
    });

    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(2);
    const newToasts = toastsSnapshot().filter((toast) => !previousToastIds.has(toast.id));
    expect(newToasts.filter((toast) => toast.message === "Votekicks could not be loaded.")).toHaveLength(1);
    for (const toast of newToasts) dismissToast(toast.id);
  });
});
