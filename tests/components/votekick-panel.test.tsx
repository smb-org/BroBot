import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import VotekickPanel from "../../src/modules/votekick/panel";
import type { Votekick } from "../../src/modules/votekick/contracts";
import { jsonResponse } from "../unit/fixtures";

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
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Votekick panel", () => {
  it("polls while idle and discovers a votekick started in chat", async () => {
    vi.useFakeTimers();
    let hasRunningVote = false;
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({
      running: hasRunningVote ? running : null,
      votekicks: hasRunningVote ? [running] : [],
      now: "2026-10-04T11:00:00.000Z",
    })));
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><VotekickPanel channelId="channel-a" language="en" /></UiProvider>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByText("No votekick is running.")).toBeInTheDocument();

    hasRunningVote = true;
    await act(async () => {
      vi.advanceTimersByTime(2000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText("sampleviewer")).toBeInTheDocument();
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
  });
});
