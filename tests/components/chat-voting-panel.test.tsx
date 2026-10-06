import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  requestedDurationSeconds: null,
  closedAt: null,
  closeReason: "limit",
  counts: null,
  voterCount: null,
} as const;

const closingVote = { ...openVote, closeReason: "manual" } as const;
const optionsCustomVote = {
  ...openVote,
  preset: "options_n",
  optionCount: 3,
  labels: ["Option 1", "Option 2", "Option 3"],
  closeReason: "timer",
  closesAt: "2026-10-04T10:01:30.000Z",
  requestedDurationSeconds: 90,
} as const;
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

  it("configures type and duration without starting until the explicit start action", async () => {
    let startPayload: unknown;
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const path = input instanceof Request
        ? new URL(input.url).pathname
        : new URL(String(input), "https://brobot.example").pathname;
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (path.endsWith("/start")) {
        startPayload = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null;
        return Promise.resolve(jsonResponse({ vote: openVote }));
      }
      return Promise.resolve(jsonResponse({
        vote: null,
        counts: null,
        revision: 0,
        hasOpenBallot: false,
        defaultDurationSeconds: 120,
      }));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    const type = await screen.findByRole("radiogroup", { name: "Vote type" });
    const duration = screen.getByRole("radiogroup", { name: "Duration" });
    expect(within(duration).getByRole("radio", { name: "2 min" })).toBeChecked();

    for (const name of ["Yes / No", "Scale 1–5", "Options 2–9", "Scale 1–5"]) {
      fireEvent.click(within(type).getByRole("radio", { name }));
    }
    for (const name of ["Open", "1 min", "2 min", "5 min", "Custom", "5 min"]) {
      fireEvent.click(within(duration).getByRole("radio", { name }));
    }
    expect(fetcher.mock.calls.some(([input]) => {
      const path = input instanceof Request
        ? new URL(input.url).pathname
        : new URL(String(input), "https://brobot.example").pathname;
      return path.endsWith("/start");
    })).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    await waitFor(() => expect(startPayload).toEqual({ preset: "scale_5", durationSeconds: 300 }));
  });

  it("uses a non-preset saved auto-close duration as the custom default", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({
      vote: null, counts: null, revision: 0, hasOpenBallot: false, defaultDurationSeconds: 90,
    }))));
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    const duration = await screen.findByRole("radiogroup", { name: "Duration" });
    expect(within(duration).getByRole("radio", { name: "Custom" })).toBeChecked();
    expect(screen.getByRole("spinbutton", { name: "Custom duration" })).toHaveValue("90");
  });

  it("resets a successful start to the saved default even before a refresh observes the vote", async () => {
    let startPayload: unknown;
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const path = input instanceof Request
        ? new URL(input.url).pathname
        : new URL(String(input), "https://brobot.example").pathname;
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (path.endsWith("/start")) {
        startPayload = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null;
        return Promise.resolve(jsonResponse({ vote: { ...openVote, requestedDurationSeconds: 60 } }));
      }
      return Promise.resolve(jsonResponse({
        vote: null,
        counts: null,
        revision: 0,
        hasOpenBallot: false,
        defaultDurationSeconds: 120,
      }));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    const duration = await screen.findByRole("radiogroup", { name: "Duration" });
    fireEvent.click(within(duration).getByRole("radio", { name: "1 min" }));
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(startPayload).toEqual({ preset: "yes_no", durationSeconds: 60 }));
    expect(within(duration).getByRole("radio", { name: "2 min" })).toBeChecked();
  });

  it("tracks saved default changes while the idle duration draft is untouched", async () => {
    let defaultDurationSeconds = 120;
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({
      vote: null,
      counts: null,
      revision: 0,
      hasOpenBallot: false,
      defaultDurationSeconds,
    })));
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    const duration = await screen.findByRole("radiogroup", { name: "Duration" });
    expect(within(duration).getByRole("radio", { name: "2 min" })).toBeChecked();
    defaultDurationSeconds = 300;
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(within(duration).getByRole("radio", { name: "5 min" })).toBeChecked());

    fireEvent.click(within(duration).getByRole("radio", { name: "1 min" }));
    defaultDurationSeconds = 600;
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(within(duration).getByRole("radio", { name: "1 min" })).toBeChecked();
  });

  it("keeps configuration visible and disables it while a vote is running", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({
      vote: openVote,
      counts: [4, 2],
      revision: 6,
      hasOpenBallot: true,
      defaultDurationSeconds: 0,
    }))));
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    const type = await screen.findByRole("radiogroup", { name: "Vote type" });
    const duration = screen.getByRole("radiogroup", { name: "Duration" });
    expect(within(type).getByRole("radio", { name: "Yes / No" })).toBeDisabled();
    expect(within(duration).getByRole("radio", { name: "Open" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Stop" })).toBeEnabled();
    expect(screen.queryByText("Configuration is locked while a vote or votekick is running.")).not.toBeInTheDocument();
  });

  it("shows the stored duration of an active timed vote", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({
      vote: optionsCustomVote,
      counts: [4, 2, 0],
      revision: 6,
      hasOpenBallot: true,
      defaultDurationSeconds: 120,
    }))));
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    const type = await screen.findByRole("radiogroup", { name: "Vote type" });
    const duration = screen.getByRole("radiogroup", { name: "Duration" });
    expect(within(type).getByRole("radio", { name: "Options 2–9" })).toBeChecked();
    expect(within(duration).getByRole("radio", { name: "Custom" })).toBeChecked();
    expect(screen.getByRole("spinbutton", { name: "Custom duration" })).toHaveValue("90");
    expect(screen.queryByText("Choose a valid duration between 0 and 14400 seconds.")).not.toBeInTheDocument();
  });

  it("keeps the idle next-vote draft separate from the active vote configuration", async () => {
    let current: unknown = { vote: null, counts: null, revision: 0, hasOpenBallot: false, defaultDurationSeconds: 120 };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(current))));
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    const type = await screen.findByRole("radiogroup", { name: "Vote type" });
    let duration = screen.getByRole("radiogroup", { name: "Duration" });
    fireEvent.click(within(type).getByRole("radio", { name: "Scale 1–5" }));
    fireEvent.click(within(duration).getByRole("radio", { name: "5 min" }));

    current = {
      vote: optionsCustomVote,
      counts: [4, 2, 0],
      revision: 1,
      hasOpenBallot: true,
      defaultDurationSeconds: 120,
    };
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(within(type).getByRole("radio", { name: "Options 2–9" })).toBeChecked());
    duration = screen.getByRole("radiogroup", { name: "Duration" });
    expect(within(duration).getByRole("radio", { name: "Custom" })).toBeChecked();
    expect(screen.getByRole("spinbutton", { name: "Custom duration" })).toHaveValue("90");
    expect(within(type).getByRole("radio", { name: "Options 2–9" })).toBeDisabled();

    current = {
      vote: { ...optionsCustomVote, status: "closed", closedAt: "2026-10-04T10:01:30.000Z", counts: [4, 2, 0], voterCount: 6 },
      counts: [4, 2, 0],
      revision: 2,
      hasOpenBallot: false,
      defaultDurationSeconds: 120,
    };
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(within(type).getByRole("radio", { name: "Scale 1–5" })).toBeChecked());
    duration = screen.getByRole("radiogroup", { name: "Duration" });
    expect(within(duration).getByRole("radio", { name: "5 min" })).toBeChecked();
    expect(within(type).getByRole("radio", { name: "Scale 1–5" })).toBeEnabled();
  });

  it("discovers a chat-started vote from an idle panel on refresh", async () => {
    let current: unknown = { vote: null, counts: null, revision: 0, hasOpenBallot: false, defaultDurationSeconds: 0 };
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(current)));
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    expect(await screen.findByText("There is no vote in progress.")).toBeInTheDocument();
    expect(screen.getByText("Ready")).toBeInTheDocument();
    current = { vote: openVote, counts: [4, 2], revision: 6, hasOpenBallot: true, defaultDurationSeconds: 0 };
    fireEvent(document, new Event("visibilitychange"));

    expect(await screen.findByRole("button", { name: "Stop" })).toBeInTheDocument();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("heading", { name: "Voting" })).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText("· open")).toBeInTheDocument();
    expect(screen.getByText("Yes")).toBeInTheDocument();
    expect(screen.getByText("4")).toBeInTheDocument();
    expect(screen.getByText("67%")).toBeInTheDocument();
    expect(screen.getByText("33%")).toBeInTheDocument();
  });

  it("keeps one reserved hint slot above the voting action", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({
      vote: null, counts: null, revision: 0, hasOpenBallot: false, defaultDurationSeconds: 120,
    }))));
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    expect(await screen.findByRole("button", { name: "Start" })).toBeInTheDocument();
    expect(screen.getByTestId("chat-voting-hint-slot")).toBeInTheDocument();
  });

  it.each([
    ["running", openVote, [4, 2], "Running", "· open", true],
    ["manual close requested for an open vote", closingVote, [4, 2], "Running", "· open", true],
    ["manual close requested for a timed vote", { ...openVote, requestedDurationSeconds: 90, closeReason: "manual", closesAt: "2026-10-04T10:01:30.000Z" }, [4, 2], "Running", "· ends 10:01 AM", true],
    ["closed", closedVote, [7, 3], "Closed", null, false],
  ] as const)("renders one matching %s status in the stable card", async (_name, vote, counts, status, detail, canStop) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({
      vote,
      counts,
      revision: 6,
      hasOpenBallot: vote.status === "open",
      defaultDurationSeconds: 0,
    }))));
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    expect(await screen.findByRole("heading", { name: "Voting" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading")).toHaveLength(1);
    expect(screen.getByText(status)).toBeInTheDocument();
    if (detail !== null) expect(screen.getByText(detail)).toBeInTheDocument();
    if (canStop) expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    else expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: /Yes: 7 votes, 70 percent|Yes: 4 votes, 67 percent/ })).toBeInTheDocument();
  });

  it.each([
    [openVote, "Läuft"],
    [closedVote, "Beendet"],
  ] as const)("renders German status copy for %s", async (vote, status) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({
      vote,
      counts: vote.status === "closed" ? [7, 3] : [4, 2],
      revision: 6,
      hasOpenBallot: vote.status === "open",
      defaultDurationSeconds: 0,
    }))));
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="de" /></UiProvider>);

    expect(await screen.findByRole("heading", { name: "Abstimmung" })).toBeInTheDocument();
    expect(screen.getByText(status)).toBeInTheDocument();
  });

  it("disables all start choices with a reason while another module owns the ballot", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({
      vote: null,
      counts: null,
      revision: 0,
      hasOpenBallot: true,
      defaultDurationSeconds: 0,
    }))));
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    const type = await screen.findByRole("radiogroup", { name: "Vote type" });
    const duration = screen.getByRole("radiogroup", { name: "Duration" });
    expect(within(type).getByRole("radio", { name: "Yes / No" })).toBeDisabled();
    expect(within(type).getByRole("radio", { name: "Options 2–9" })).toBeDisabled();
    expect(within(duration).getByRole("radio", { name: "Open" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    expect(screen.getByText("Configuration is locked while a vote or votekick is running.")).toBeInTheDocument();
  });

  it("does not leave a stale closing message beside a closed result", async () => {
    let current: unknown = {
      vote: { ...openVote, closeReason: "timer", closesAt: "2026-10-04T10:05:00.000Z" },
      counts: [4, 2], revision: 6, hasOpenBallot: true, defaultDurationSeconds: 120,
    };
    const fetcher = vi.fn<typeof fetch>((input) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (path.endsWith("/close")) {
        current = { vote: closedVote, counts: [7, 3], revision: 7, hasOpenBallot: false, defaultDurationSeconds: 120 };
        return Promise.resolve(jsonResponse({ closing: true, pollId: closedVote.id }));
      }
      return Promise.resolve(jsonResponse(current));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));

    expect(await screen.findByRole("heading", { name: "Voting" })).toBeInTheDocument();
    expect(screen.getByText("Closed")).toBeInTheDocument();
    expect(screen.queryByText("Closing")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Yes: 7 votes, 70 percent" })).toBeInTheDocument();
    expect(within(screen.getByRole("radiogroup", { name: "Duration" })).getByRole("radio", { name: "2 min" })).toBeChecked();
  });

  it.each([2, 9] as const)("sends the options-start payload with boundary count %i", async (optionCount) => {
    let startPayload: unknown;
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const path = input instanceof Request
        ? new URL(input.url).pathname
        : new URL(String(input), "https://brobot.example").pathname;
      if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
      if (path.endsWith("/start")) {
        startPayload = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null;
        return Promise.resolve(jsonResponse({ vote: {
          ...openVote,
          preset: "options_n",
          optionCount,
          labels: Array.from({ length: optionCount }, (_unused, index) => `Option ${String(index + 1)}`),
        } }));
      }
      return Promise.resolve(jsonResponse({ vote: null, counts: null, revision: 0, hasOpenBallot: false, defaultDurationSeconds: 0 }));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    const type = await screen.findByRole("radiogroup", { name: "Vote type" });
    fireEvent.click(within(type).getByRole("radio", { name: "Options 2–9" }));
    const options = screen.getByRole("spinbutton", { name: "Number of options" });
    fireEvent.change(options, { target: { value: String(optionCount) } });
    fireEvent.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(startPayload).toEqual({ preset: "options_n", optionCount, durationSeconds: 0 }));
  });

  it.each([1, 10] as const)("does not send an options-start payload for count %i", async (optionCount) => {
    const fetcher = vi.fn<typeof fetch>((input) => {
      const path = input instanceof Request
        ? new URL(input.url).pathname
        : new URL(String(input), "https://brobot.example").pathname;
      return Promise.resolve(path === "/api/csrf"
        ? jsonResponse({ token: "csrf-token" })
        : jsonResponse({ vote: null, counts: null, revision: 0, hasOpenBallot: false, defaultDurationSeconds: 0 }));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    const type = await screen.findByRole("radiogroup", { name: "Vote type" });
    fireEvent.click(within(type).getByRole("radio", { name: "Options 2–9" }));
    const options = screen.getByRole("spinbutton", { name: "Number of options" });
    fireEvent.change(options, { target: { value: String(optionCount) } });

    expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
    expect(fetcher.mock.calls.some(([input]) => {
      const path = input instanceof Request
        ? new URL(input.url).pathname
        : new URL(String(input), "https://brobot.example").pathname;
      return path.endsWith("/start");
    })).toBe(false);
  });

  it.each([
    ["de", "Deine Kanalrolle darf Abstimmungen nur ansehen.", "Abstimmungstyp", "Starten"],
    ["en", "Your channel role can only view votes.", "Vote type", "Start"],
  ] as const)("keeps %s operation controls visible with a localized role reason", async (language, reason, typeLabel, startLabel) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({
      vote: null, counts: null, revision: 0, hasOpenBallot: false, defaultDurationSeconds: 0,
    }))));
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language={language} canOperate={false} /></UiProvider>);

    const type = await screen.findByRole("radiogroup", { name: typeLabel });
    expect(within(type).getAllByRole("radio").every((control) => control.hasAttribute("disabled"))).toBe(true);
    expect(screen.getByRole("button", { name: startLabel })).toBeDisabled();
    expect(screen.getByText(reason)).toBeInTheDocument();
  });

  it.each([
    ["idle", null, null, false],
    ["running", openVote, [4, 2], true],
    ["running with optional fields", optionsCustomVote, [4, 2, 0], true],
    ["closed", closedVote, [7, 3], false],
  ] as const)("reserves the same fixed result area while %s", async (_case, vote, counts, hasOpenBallot) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({
      vote, counts, revision: 6, hasOpenBallot, defaultDurationSeconds: 0,
    }))));
    const { container } = render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    await screen.findByRole("heading", { name: "Voting" });
    expect(container.querySelector<HTMLElement>(".chat-voting-result-area")).toHaveStyle({ height: "calc(var(--s10) * 7)" });
    const reservedFields = Array.from(container.querySelectorAll<HTMLElement>(".chat-voting-configuration__field-slot"));
    expect(reservedFields).toHaveLength(2);
    expect(reservedFields.map((field) => field.style.height)).toEqual([
      "calc(var(--s10) + var(--s6))",
      "calc(var(--s10) + var(--s6))",
    ]);
  });
});
