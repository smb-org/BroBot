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

describe("chat voting live panel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("discovers a chat-started vote from an idle panel on refresh", async () => {
    let current: unknown = { vote: null, counts: null, revision: 0 };
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(current)));
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    expect(await screen.findByText("There is no vote in progress.")).toBeInTheDocument();
    current = { vote: openVote, counts: [4, 2], revision: 6 };
    fireEvent(document, new Event("visibilitychange"));

    expect(await screen.findByRole("button", { name: "Close vote" })).toBeInTheDocument();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
  });
});
