import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { dismissToast, toastsSnapshot } from "../../src/dashboard/ui/toast-store";
import { ChatVotingPanel } from "../../src/modules/chat_voting/panel";
import { chatVotingModule } from "../../src/modules/chat_voting";
import { moduleQueryKey, runModuleQueryWrite } from "../../src/dashboard/data/module-query";
import { setDashboardRealtimeStatus } from "../../src/dashboard/data/realtime";
import type { ChatVotePreset } from "../../src/modules/chat_voting/contracts";
import { jsonResponse } from "../unit/fixtures";
import { renderWithQuery as render } from "../query-test-utils";

const defaultLabels: Record<ChatVotePreset, string[]> = {
  yes_no: ["Yes", "No"],
  digit_01: ["No", "Yes"],
  digit_12: ["1", "2"],
  scale_5: ["1", "2", "3", "4", "5"],
  options_n: Array.from({ length: 9 }, (_unused, index) => `Option ${String(index + 1)}`),
  free_text: [],
};

const currentState = (overrides: Record<string, unknown> = {}) => ({
  vote: null,
  counts: null,
  revision: 0,
  terms: null,
  moreTerms: null,
  hasOpenBallot: false,
  defaultDurationSeconds: 120,
  defaultLabels,
  ...overrides,
});

const openVote = {
  id: "chat-started-poll",
  channelId: "fictional-channel",
  preset: "yes_no",
  optionCount: 2,
  labels: ["Pizza", "Burger"],
  status: "open",
  openedAt: "2026-10-04T10:00:00.000Z",
  closesAt: "2026-10-04T14:00:00.000Z",
  requestedDurationSeconds: null,
  closedAt: null,
  closeReason: "limit",
  counts: null,
  voterCount: null,
} as const;

const requestPath = (input: RequestInfo | URL): string => input instanceof Request
  ? new URL(input.url).pathname
  : input instanceof URL ? input.pathname : new URL(input, "https://brobot.example").pathname;

const fetchFor = (
  readCurrent: () => unknown = () => currentState(),
  onStart: (body: unknown) => unknown = () => ({ vote: openVote }),
  onClose: () => void = () => {},
) => vi.fn<typeof fetch>((input, init) => {
  const path = requestPath(input);
  if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
  if (path.endsWith("/start")) {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null;
    return Promise.resolve(jsonResponse(onStart(body)));
  }
  if (path.endsWith("/close")) {
    onClose();
    return Promise.resolve(jsonResponse({ closing: true, pollId: openVote.id }));
  }
  if (path.endsWith("/approve-term")) return Promise.resolve(jsonResponse({ terms: [], moreTerms: 0, revision: 2 }));
  return Promise.resolve(jsonResponse(readCurrent()));
});

const selectOption = async (label: string, option: string): Promise<void> => {
  const combobox = screen.getByRole("combobox", { name: label });
  fireEvent.click(combobox);
  const listbox = await waitFor(() => {
    const id = combobox.getAttribute("aria-controls");
    const controlledListbox = id === null ? null : document.getElementById(id);
    if (controlledListbox === null) throw new Error("The Select listbox has not mounted.");
    return controlledListbox;
  });
  const optionLabel = within(listbox).getAllByText(option, { exact: true })
    .find((candidate) => candidate.closest("[data-combobox-option]") !== null);
  const optionElement = optionLabel?.closest("[data-combobox-option]");
  if (optionElement === null || optionElement === undefined) throw new Error(`The Select option ${option} is missing.`);
  fireEvent.click(optionElement);
};

describe("chat voting live panel", () => {
  afterEach(() => {
    cleanup();
    setDashboardRealtimeStatus("fictional-channel", "offline");
    for (const toast of toastsSnapshot()) dismissToast(toast.id);
    vi.unstubAllGlobals();
  });

  it("explains how to start a vote when there is no result yet", async () => {
    vi.stubGlobal("fetch", fetchFor());
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    expect(await screen.findByText("No vote yet. Start one in chat with !vote yesno [question].")).toBeInTheDocument();
  });

  it("has no type selector and offers yes/no, answer labels, free text, and duration controls", async () => {
    vi.stubGlobal("fetch", fetchFor());
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    expect(await screen.findByRole("textbox", { name: "Question" })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Vote type" })).not.toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Number of answers" })).toHaveValue("0");
    expect(screen.queryByRole("textbox", { name: "Label for option 1" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Duration" })).toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "Seconds" })).not.toBeInTheDocument();

    const optionCount = screen.getByRole("spinbutton", { name: "Number of answers" });
    fireEvent.change(optionCount, { target: { value: "2" } });
    expect(screen.getByRole("textbox", { name: "Label for option 1" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "Free text" }));
    expect(screen.getByRole("radiogroup", { name: "Counting mode" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Counting mode" })).toHaveTextContent("Whole message");
    expect(screen.queryByRole("spinbutton", { name: "Number of answers" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Label for option 1" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Free text" }));
    expect(screen.getByRole("spinbutton", { name: "Number of answers" })).toHaveValue("2");

    await selectOption("Duration", "Custom …");
    expect(screen.getByRole("spinbutton", { name: "Seconds" })).toBeInTheDocument();
  });

  it("notifies once per state outage even when identical state recovers", async () => {
    setDashboardRealtimeStatus("fictional-channel", "connected");
    let readState: "success" | "error" = "success";
    const fetcher = fetchFor(() => {
      if (readState === "error") throw new Error("state unavailable");
      return currentState();
    });
    vi.stubGlobal("fetch", fetcher);
    const view = render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);
    expect(await screen.findByText("No vote yet. Start one in chat with !vote yesno [question].")).toBeInTheDocument();
    const key = { queryKey: moduleQueryKey("fictional-channel", "chat_voting", "panel"), exact: true };
    const refresh = async (): Promise<void> => {
      await act(async () => { await view.queryClient.refetchQueries(key, { throwOnError: true }).catch(() => undefined); });
    };

    readState = "error";
    await refresh();
    await refresh();
    expect(fetcher.mock.calls.filter(([input]) => requestPath(input).endsWith("/current"))).toHaveLength(3);
    expect(view.queryClient.getQueryState(key.queryKey)?.status).toBe("error");
    expect(toastsSnapshot().filter((toast) => toast.message === "The vote could not be loaded.")).toHaveLength(1);

    readState = "success";
    await refresh();
    readState = "error";
    await refresh();
    expect(toastsSnapshot().filter((toast) => toast.message === "The vote could not be loaded.")).toHaveLength(2);
  });

  it("sends edited answer labels for this vote", async () => {
    let startPayload: unknown;
    let started = false;
    vi.stubGlobal("fetch", fetchFor(
      () => currentState(started ? { vote: { ...openVote, labels: ["Pizza", "Burger"] }, counts: [0, 0] } : {}),
      (body) => { startPayload = body; started = true; return { vote: { ...openVote, labels: ["Pizza", "Burger"] } }; },
    ));
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    const count = await screen.findByRole("spinbutton", { name: "Number of answers" });
    fireEvent.change(count, { target: { value: "2" } });
    const yes = await screen.findByRole("textbox", { name: "Label for option 1" });
    const no = screen.getByRole("textbox", { name: "Label for option 2" });
    fireEvent.change(yes, { target: { value: "Pizza" } });
    fireEvent.change(no, { target: { value: "Burger" } });
    fireEvent.click(screen.getByRole("button", { name: "Start vote" }));

    await waitFor(() => expect(startPayload).toEqual({ kind: "options", optionCount: 2, labels: ["Pizza", "Burger"], durationSeconds: 120 }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Label for option 1" })).toHaveValue("Pizza"));
    expect(screen.getByRole("textbox", { name: "Label for option 2" })).toHaveValue("Burger");
  });

  it("uses saved default labels and duration for the next vote", async () => {
    setDashboardRealtimeStatus("fictional-channel", "connected");
    let serverState = currentState();
    let startPayload: unknown;
    vi.stubGlobal("fetch", fetchFor(
      () => serverState,
      (body) => { startPayload = body; return { vote: openVote }; },
    ));
    const view = render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    expect(await screen.findByRole("textbox", { name: "Label for option 1" })).toHaveAttribute("placeholder", "Yes");
    serverState = currentState({
      defaultDurationSeconds: 300,
      defaultLabels: { ...defaultLabels, yes_no: ["Approve", "Reject"] },
    });

    await act(async () => {
      await runModuleQueryWrite(view.queryClient, "fictional-channel", "chat_voting", "settings", () => Promise.resolve({}), {
        baselineRevision: 1,
        updateCache: (_current, result) => result,
        relatedParts: (chatVotingModule.settingsEditorRelatedParts ?? []).map((part) => ({ moduleId: chatVotingModule.id, part })),
      });
    });

    expect(await screen.findByRole("textbox", { name: "Label for option 1" })).toHaveAttribute("placeholder", "Approve");
    fireEvent.click(screen.getByRole("button", { name: "Start vote" }));
    await waitFor(() => expect(startPayload).toEqual({ preset: "yes_no", durationSeconds: 300, labels: ["Approve", "Reject"] }));
  });

  it("sends a trimmed question and enforces its 80-code-point limit", async () => {
    let startPayload: unknown;
    vi.stubGlobal("fetch", fetchFor(undefined, (body) => {
      startPayload = body;
      return { vote: openVote };
    }));
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    const question = await screen.findByRole("textbox", { name: "Question" });
    fireEvent.change(question, { target: { value: "  Pizza today?  " } });
    expect(screen.getByRole("button", { name: "Start vote" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Start vote" }));
    await waitFor(() => expect(startPayload).toMatchObject({ title: "Pizza today?" }));

    cleanup();
    startPayload = undefined;
    vi.stubGlobal("fetch", fetchFor(undefined, (body) => {
      startPayload = body;
      return { vote: openVote };
    }));
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);
    const emojiQuestion = "😀".repeat(81);
    const emojiField = await screen.findByRole("textbox", { name: "Question" });
    fireEvent.change(emojiField, { target: { value: emojiQuestion } });
    expect(screen.getAllByText("81/80").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Start vote" })).toBeDisabled();
    expect(startPayload).toBeUndefined();
  });

  it("keeps the draft question separate from a running vote", async () => {
    const titledVote = { ...openVote, title: "Pizza today?" };
    vi.stubGlobal("fetch", fetchFor(() => currentState({ vote: titledVote, counts: [4, 2], hasOpenBallot: true })));
    const { container } = render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    const question = await screen.findByText("Pizza today?", { selector: ".chat-voting-result__question" });
    expect(question.compareDocumentPosition(container.querySelector(".chat-voting-results") as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Question" })).toHaveValue("");
  });

  it("keeps the one draft intact after start, end, and a component re-render", async () => {
    let started = false;
    let closed = false;
    const startedVote = { ...openVote, title: "Started question?" };
    const readCurrent = () => currentState(started ? {
      vote: closed ? { ...startedVote, status: "closed", closedAt: "2026-10-04T10:03:00.000Z" } : startedVote,
      counts: [0, 0],
    } : {});
    vi.stubGlobal("fetch", fetchFor(
      readCurrent,
      () => { started = true; return { vote: startedVote }; },
      () => { closed = true; },
    ));
    const view = render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    fireEvent.change(await screen.findByRole("textbox", { name: "Question" }), { target: { value: "Draft question?" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Number of answers" }), { target: { value: "2" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Label for option 1" }), { target: { value: "Coffee" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Label for option 2" }), { target: { value: "Tea" } });
    fireEvent.click(screen.getByRole("button", { name: "Start vote" }));

    await screen.findByRole("button", { name: "End vote" });
    expect(screen.getByRole("textbox", { name: "Question" })).toHaveValue("Draft question?");
    expect(screen.getByRole("textbox", { name: "Label for option 1" })).toHaveValue("Coffee");
    expect(screen.getByRole("textbox", { name: "Label for option 2" })).toHaveValue("Tea");
    fireEvent.click(screen.getByRole("button", { name: "End vote" }));

    await screen.findByRole("button", { name: "Start vote" });
    expect(screen.getByRole("textbox", { name: "Question" })).toHaveValue("Draft question?");
    expect(screen.getByRole("textbox", { name: "Label for option 1" })).toHaveValue("Coffee");
    expect(screen.getByRole("textbox", { name: "Label for option 2" })).toHaveValue("Tea");
    view.rerender(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);
    expect(screen.getByRole("textbox", { name: "Question" })).toHaveValue("Draft question?");
    expect(screen.getByRole("textbox", { name: "Label for option 1" })).toHaveValue("Coffee");
    expect(screen.getByRole("textbox", { name: "Label for option 2" })).toHaveValue("Tea");
  });

  it("uses localized yes/no defaults when there are no answer labels", async () => {
    let startPayload: unknown;
    vi.stubGlobal("fetch", fetchFor(undefined, (body) => {
      startPayload = body;
      return { vote: openVote };
    }));
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    await screen.findByRole("button", { name: "Start vote" });
    expect(screen.getByText("With no answers, chat votes with 1 for yes and 2 for no.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Start vote" }));

    await waitFor(() => expect(startPayload).toEqual({ kind: "yes_no", labels: ["Yes", "No"], durationSeconds: 120 }));
  });

  it("starts free-text voting when the hidden answer count is invalid", async () => {
    let startPayload: unknown;
    vi.stubGlobal("fetch", fetchFor(undefined, (body) => {
      startPayload = body;
      return { vote: openVote };
    }));
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    const answerCount = await screen.findByRole("spinbutton", { name: "Number of answers" });
    fireEvent.change(answerCount, { target: { value: "1" } });
    expect(screen.getByRole("button", { name: "Start vote" })).toBeDisabled();
    fireEvent.click(screen.getByRole("switch", { name: "Free text" }));
    expect(screen.queryByRole("spinbutton", { name: "Number of answers" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start vote" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Start vote" }));

    await waitFor(() => expect(startPayload).toEqual({ kind: "free_text", durationSeconds: 120, textMode: "first_word" }));
  });

  it("counts emoji labels in code points in the field and start validation", async () => {
    let startPayload: unknown;
    vi.stubGlobal("fetch", fetchFor(undefined, (body) => {
      startPayload = body;
      return { vote: openVote };
    }));
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    const count = await screen.findByRole("spinbutton", { name: "Number of answers" });
    fireEvent.change(count, { target: { value: "2" } });
    const emojiLabel = "😀".repeat(17);
    fireEvent.change(await screen.findByRole("textbox", { name: "Label for option 1" }), { target: { value: emojiLabel } });
    expect(screen.getByText("17/32")).toBeInTheDocument();
    const start = screen.getByRole("button", { name: "Start vote" });
    expect(start).toBeEnabled();
    fireEvent.click(start);
    await waitFor(() => expect(startPayload).toMatchObject({ labels: [emojiLabel, "2"] }));
  });

  it("shows invalid duration and option-count reasons in the fixed hint and field", async () => {
    vi.stubGlobal("fetch", fetchFor());
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    await screen.findByRole("button", { name: "Start vote" });
    const optionCount = screen.getByRole("spinbutton", { name: "Number of answers" });
    fireEvent.change(optionCount, { target: { value: "1" } });
    const hint = screen.getByTestId("chat-voting-hint-slot");
    expect(hint).toHaveTextContent("Enter 0 or a number from 2 to 9.");
    expect(optionCount.closest(".ui-number-field__stepper")).toHaveTextContent("Enter 0 or a number from 2 to 9.");
    expect(screen.getByRole("button", { name: "Start vote" })).toBeDisabled();

    await selectOption("Duration", "Custom …");
    const duration = screen.getByRole("spinbutton", { name: "Seconds" });
    fireEvent.change(duration, { target: { value: "" } });
    expect(hint).toHaveTextContent("Enter a duration from 1 to 14,400 seconds.");
    expect(duration.closest(".ui-number-field__stepper")).toHaveTextContent("Enter a duration from 1 to 14,400 seconds.");
    expect(screen.getByRole("button", { name: "Start vote" })).toBeDisabled();
  });

  it("locks the configuration to the running vote and keeps the stop action available", async () => {
    vi.stubGlobal("fetch", fetchFor(() => currentState({ vote: openVote, counts: [4, 2], hasOpenBallot: true })));
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    expect(await screen.findByRole("textbox", { name: "Question" })).toHaveValue("");
    expect(screen.getByRole("spinbutton", { name: "Number of answers" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "End vote" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "End vote" })).toHaveAttribute("style");
    expect(screen.getByTestId("chat-voting-hint-slot")).toHaveTextContent("Locked while a vote or votekick is running.");
  });

  it("keeps five free-text result rows, including empty slots", async () => {
    const vote = {
      ...openVote,
      preset: "free_text",
      optionCount: 0,
      labels: [],
      textMode: "first_word",
      status: "open",
      counts: [],
      textResults: null,
      moreTerms: null,
    };
    vi.stubGlobal("fetch", fetchFor(() => currentState({ vote, terms: [], moreTerms: 0, hasOpenBallot: true })));
    const { container } = render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    expect(await screen.findByRole("button", { name: "End vote" })).toBeInTheDocument();
    expect(container.querySelectorAll(".chat-voting-results__term-row")).toHaveLength(5);
    expect(container.querySelectorAll(".chat-voting-results__empty-slot")).toHaveLength(5);
    expect(container.querySelector(".chat-voting-result__meta")).toHaveTextContent("0 votes · since");
    expect(screen.queryByText("More terms: —")).not.toBeInTheDocument();
  });

  it("sends failed start actions to a persistent error toast", async () => {
    const previousIds = new Set(toastsSnapshot().map((toast) => toast.id));
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const path = input instanceof Request
        ? new URL(input.url).pathname
        : new URL(String(input), "https://brobot.example").pathname;
      return Promise.resolve(path === "/api/csrf"
        ? jsonResponse({ token: "csrf-token" })
        : path.endsWith("/start")
          ? jsonResponse({ error: "start_failed" }, 500)
          : jsonResponse(currentState()));
    }));
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Start vote" }));
    await waitFor(() => expect(toastsSnapshot().some((toast) => !previousIds.has(toast.id) && toast.message === "The vote could not be started.")).toBe(true));
    expect(screen.getByTestId("chat-voting-hint-slot")).not.toHaveTextContent("The vote could not be started.");
    const errorToasts = toastsSnapshot().filter((toast) => !previousIds.has(toast.id));
    for (const toast of errorToasts) dismissToast(toast.id);
  });
});
