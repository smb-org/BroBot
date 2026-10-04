import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { ChatVotingPanel } from "../../src/modules/chat_voting/panel";
import { jsonResponse } from "../unit/fixtures";

const openVote = {
  id: "chat-started-poll",
  channelId: "fictional-channel",
  preset: "yes_no",
  optionCount: 2,
  labels: ["Yes", "No"],
  status: "open",
  openedAt: "2026-10-04T10:00:00.000Z",
  closesAt: "2026-10-04T14:00:00.000Z",
  closedAt: null,
  closeReason: "limit",
  counts: null,
  voterCount: null,
} as const;

const closingVote = { ...openVote, closeReason: "manual" } as const;
const closedVote = {
  ...openVote,
  status: "closed",
  closeReason: "manual",
  counts: [7, 3],
  voterCount: 10,
  closedAt: "2026-10-04T10:05:00.000Z",
} as const;

describe("chat voting live panel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("discovers a chat-started vote from an idle panel on refresh", async () => {
    let current: unknown = { vote: null, counts: null, revision: 0, hasOpenBallot: false };
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(current)));
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    expect(await screen.findByText("There is no vote in progress.")).toBeInTheDocument();
    current = { vote: openVote, counts: [4, 2], revision: 6, hasOpenBallot: true };
    fireEvent(document, new Event("visibilitychange"));

    expect(await screen.findByRole("button", { name: "Close vote" })).toBeInTheDocument();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("heading", { name: "Vote in progress" })).toBeInTheDocument();
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("67%")).toBeInTheDocument();
    expect(screen.getByText("33%")).toBeInTheDocument();
  });

  it.each([
    ["running", openVote, [4, 2], "Vote in progress", "Live", true],
    ["closing", closingVote, [4, 2], "Closing vote", "Closing", false],
    ["closed", closedVote, [7, 3], "Vote results", "Closed", false],
  ] as const)("renders one matching %s status and title", async (_name, vote, counts, title, status, canClose) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({
      vote,
      counts,
      revision: 6,
      hasOpenBallot: vote.status === "open",
    }))));
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
    expect(screen.getByText(status)).toBeInTheDocument();
    if (canClose) expect(screen.getByRole("button", { name: "Close vote" })).toBeInTheDocument();
    else expect(screen.queryByRole("button", { name: "Close vote" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Yes: 7 votes, 70 percent|Yes: 4 votes, 67 percent/ })).toBeInTheDocument();
  });

  it("disables all start choices with a reason while another module owns the ballot", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({
      vote: null,
      counts: null,
      revision: 0,
      hasOpenBallot: true,
    }))));
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    const yesNo = await screen.findByRole("button", { name: "Yes / No" });
    const scale = screen.getByRole("button", { name: "Scale 1–5" });
    const options = screen.getByRole("button", { name: "Start options vote" });
    expect(yesNo).toBeDisabled();
    expect(scale).toBeDisabled();
    expect(options).toBeDisabled();
    expect(screen.getByText("A vote or votekick is already in progress. Start another after it ends.")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Number of options" })).toBeDisabled();
  });

  it("does not leave a stale closing message beside a closed result", async () => {
    let current: unknown = { vote: openVote, counts: [4, 2], revision: 6, hasOpenBallot: true };
    const fetcher = vi.fn<typeof fetch>((input) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (path.endsWith("/close")) {
        current = { vote: closedVote, counts: [7, 3], revision: 7, hasOpenBallot: false };
        return Promise.resolve(jsonResponse({ closing: true, pollId: closedVote.id }));
      }
      return Promise.resolve(jsonResponse(current));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Close vote" }));

    expect(await screen.findByRole("heading", { name: "Vote results" })).toBeInTheDocument();
    expect(screen.getByText("Closed")).toBeInTheDocument();
    expect(screen.queryByText("Closing")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Yes: 7 votes, 70 percent" })).toBeInTheDocument();
  });
});
