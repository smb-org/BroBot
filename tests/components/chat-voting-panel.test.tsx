import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { dismissToast, toastsSnapshot } from "../../src/dashboard/ui/toast-store";
import { ChatVotingPanel } from "../../src/modules/chat_voting/panel";
import type { ChatVotePreset } from "../../src/modules/chat_voting/contracts";
import { jsonResponse } from "../unit/fixtures";

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

const fetchFor = (
  readCurrent: () => unknown = () => currentState(),
  onStart: (body: unknown) => unknown = () => ({ vote: openVote }),
) => vi.fn<typeof fetch>((input, init) => {
  const path = input instanceof Request
    ? new URL(input.url).pathname
    : new URL(String(input), "https://brobot.example").pathname;
  if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
  if (path.endsWith("/start")) {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null;
    return Promise.resolve(jsonResponse(onStart(body)));
  }
  if (path.endsWith("/close")) return Promise.resolve(jsonResponse({ closing: true, pollId: openVote.id }));
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
    vi.unstubAllGlobals();
  });

  it("groups vote types and explains the exact chat input in the options", async () => {
    vi.stubGlobal("fetch", fetchFor());
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    const type = await screen.findByRole("combobox", { name: "Vote type" });
    expect(type).toHaveValue("Yes / No");
    expect(type.closest(".ui-select")).toHaveTextContent("Chat types 1 or 2. Each person’s latest vote counts.");
    fireEvent.click(type);
    const listboxId = type.getAttribute("aria-controls");
    const listbox = listboxId === null ? null : document.getElementById(listboxId);
    expect(listbox).not.toBeNull();
    if (listbox === null) throw new Error("The type listbox has not mounted.");
    expect(listbox).toHaveTextContent("Two options");
    expect(listbox).toHaveTextContent("Yes / NoChat types 1 or 2");
    expect(listbox).toHaveTextContent("0 / 1Chat types 0 or 1");
    expect(listbox).toHaveTextContent("1 / 2Chat types 1 or 2 · custom labels");
    expect(listbox).toHaveTextContent("Multiple options");
    expect(listbox).toHaveTextContent("Free textChat types a word · top 5 are counted");
  });

  it("renders only the selected preset fields and keeps one duration select", async () => {
    vi.stubGlobal("fetch", fetchFor());
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    expect(await screen.findByRole("textbox", { name: "Label for option 1" })).toHaveAttribute("placeholder", "Yes");
    expect(screen.queryByRole("spinbutton", { name: "Number of options" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Counting mode" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Duration" })).toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "Seconds" })).not.toBeInTheDocument();

    await selectOption("Vote type", "Options 2–9");
    expect(screen.getByRole("spinbutton", { name: "Number of options" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Label for option 1" })).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Counting mode" })).not.toBeInTheDocument();

    await selectOption("Vote type", "Free text");
    expect(screen.getByRole("radiogroup", { name: "Counting mode" })).toBeInTheDocument();
    expect(screen.getByRole("radiogroup", { name: "Counting mode" })).toHaveTextContent("Whole message");
    expect(screen.queryByRole("spinbutton", { name: "Number of options" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Label for option 1" })).not.toBeInTheDocument();

    await selectOption("Duration", "Custom …");
    expect(screen.getByRole("spinbutton", { name: "Seconds" })).toBeInTheDocument();
  });

  it("sends edited labels for this vote while leaving the defaults in settings", async () => {
    let startPayload: unknown;
    let started = false;
    vi.stubGlobal("fetch", fetchFor(
      () => currentState(started ? { vote: { ...openVote, labels: ["Pizza", "Burger"] }, counts: [0, 0] } : {}),
      (body) => { startPayload = body; started = true; return { vote: { ...openVote, labels: ["Pizza", "Burger"] } }; },
    ));
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    const yes = await screen.findByRole("textbox", { name: "Label for option 1" });
    const no = screen.getByRole("textbox", { name: "Label for option 2" });
    fireEvent.change(yes, { target: { value: "Pizza" } });
    fireEvent.change(no, { target: { value: "Burger" } });
    fireEvent.click(screen.getByRole("button", { name: "Start vote" }));

    await waitFor(() => expect(startPayload).toEqual({ preset: "yes_no", durationSeconds: 120, labels: ["Pizza", "Burger"] }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Label for option 1" })).toHaveValue("Pizza"));
    expect(screen.getByRole("textbox", { name: "Label for option 2" })).toHaveValue("Burger");
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

  it("shows the running question above its result", async () => {
    const titledVote = { ...openVote, title: "Pizza today?" };
    vi.stubGlobal("fetch", fetchFor(() => currentState({ vote: titledVote, counts: [4, 2], hasOpenBallot: true })));
    const { container } = render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    const question = await screen.findByText("Pizza today?", { selector: ".chat-voting-result__question" });
    expect(question.compareDocumentPosition(container.querySelector(".chat-voting-results") as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Question" })).toHaveValue("Pizza today?");
  });

  it("uses inline key labels for 0/1 and submits the default for an untouched field", async () => {
    let startPayload: unknown;
    vi.stubGlobal("fetch", fetchFor(undefined, (body) => {
      startPayload = body;
      return { vote: openVote };
    }));
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    await screen.findByRole("button", { name: "Start vote" });
    await selectOption("Vote type", "0 / 1");
    const zero = screen.getByRole("textbox", { name: "Label for option 0" });
    const one = screen.getByRole("textbox", { name: "Label for option 1" });
    expect(zero).toHaveAttribute("placeholder", "No");
    expect(one).toHaveAttribute("placeholder", "Yes");
    expect(zero.closest(".mantine-TextInput-root")).toHaveClass("ui-field--prefixed");
    fireEvent.change(zero, { target: { value: "Nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Start vote" }));

    await waitFor(() => expect(startPayload).toEqual({ preset: "digit_01", durationSeconds: 120, labels: ["Nope", "Yes"] }));
  });

  it("counts emoji labels in code points in the field and start validation", async () => {
    let startPayload: unknown;
    vi.stubGlobal("fetch", fetchFor(undefined, (body) => {
      startPayload = body;
      return { vote: openVote };
    }));
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    const emojiLabel = "😀".repeat(17);
    fireEvent.change(await screen.findByRole("textbox", { name: "Label for option 1" }), { target: { value: emojiLabel } });
    expect(screen.getByText("17/32")).toBeInTheDocument();
    const start = screen.getByRole("button", { name: "Start vote" });
    expect(start).toBeEnabled();
    fireEvent.click(start);
    await waitFor(() => expect(startPayload).toMatchObject({ labels: [emojiLabel, "No"] }));
  });

  it("shows invalid duration and option-count reasons in the fixed hint and field", async () => {
    vi.stubGlobal("fetch", fetchFor());
    render(<UiProvider><ChatVotingPanel channelId="fictional-channel" language="en" /></UiProvider>);

    await screen.findByRole("button", { name: "Start vote" });
    await selectOption("Vote type", "Options 2–9");
    const optionCount = screen.getByRole("spinbutton", { name: "Number of options" });
    fireEvent.change(optionCount, { target: { value: "" } });
    const hint = screen.getByTestId("chat-voting-hint-slot");
    expect(hint).toHaveTextContent("Enter a number from 2 to 9.");
    expect(optionCount.closest(".ui-number-field__stepper")).toHaveTextContent("Enter a number from 2 to 9.");
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

    expect(await screen.findByRole("textbox", { name: "Label for option 1" })).toHaveValue("Pizza");
    expect(screen.getByRole("combobox", { name: "Vote type" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Label for option 2" })).toHaveValue("Burger");
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
