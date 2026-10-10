import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { ToastHost } from "../../src/dashboard/ui/Toast";
import { dismissToast, toastsSnapshot } from "../../src/dashboard/ui/toast-store";
import { ChatVotingPanel } from "../../src/modules/chat_voting/panel";
import type { ChatVote, ChatVoteTemplate } from "../../src/modules/chat_voting/contracts";
import type { ChatVotingPanelState } from "../../src/modules/chat_voting/panel/service";
import { jsonResponse } from "../unit/fixtures";

const template = (overrides: Partial<ChatVoteTemplate> = {}): ChatVoteTemplate => ({
  id: "template-dinner",
  channelId: "fictional-channel",
  shortcut: null,
  title: "Dinner",
  labels: ["Pizza", "Burger"],
  freeTextMode: null,
  durationSeconds: 120,
  revision: 1,
  legacyAlias: null,
  lastUsedAt: null,
  createdAt: "2026-10-04T10:00:00.000Z",
  updatedAt: "2026-10-04T10:00:00.000Z",
  ...overrides,
});

const runningVote: ChatVote = {
  id: "poll-running",
  channelId: "fictional-channel",
  kind: "options",
  optionCount: 2,
  labels: ["Pizza", "Burger"],
  title: "Dinner",
  status: "open",
  openedAt: "2026-10-04T10:00:00.000Z",
  closesAt: "2026-10-04T10:02:00.000Z",
  requestedDurationSeconds: 120,
  closedAt: null,
  closeReason: "timer",
  counts: null,
  voterCount: null,
};

const currentState = (overrides: Partial<ChatVotingPanelState> = {}): ChatVotingPanelState => ({
  vote: null,
  counts: null,
  revision: 0,
  terms: null,
  moreTerms: null,
  hasOpenBallot: false,
  defaultDurationSeconds: 120,
  ...overrides,
});

interface FetchHarnessOptions {
  templates?: ChatVoteTemplate[];
  current?: ChatVotingPanelState;
  recent?: ChatVote[];
  getTemplates?: () => ChatVoteTemplate[];
  onPatch?: (templateId: string, body: Record<string, unknown>) => Response;
  onStart?: (body: Record<string, unknown>) => Response;
  onDelete?: (templateId: string) => Response;
}

const fetchHarness = (options: FetchHarnessOptions = {}) => {
  let templates = [...(options.templates ?? [template()])];
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
    const path = input instanceof Request
      ? new URL(input.url).pathname
      : new URL(String(input), "https://brobot.example").pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-token" }));
    if (path.endsWith("/current")) return Promise.resolve(jsonResponse(options.current ?? currentState()));
    if (path.endsWith("/templates") && method === "GET") {
      const listed = options.getTemplates?.() ?? templates;
      return Promise.resolve(jsonResponse({ templates: listed, count: listed.length, maximum: 100 }));
    }
    if (path.endsWith("/recent")) return Promise.resolve(jsonResponse({ votes: options.recent ?? [] }));
    if (path.endsWith("/start")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      return Promise.resolve(options.onStart?.(body) ?? jsonResponse({ vote: runningVote }));
    }
    if (path.endsWith("/close")) return Promise.resolve(jsonResponse({ closing: true, pollId: runningVote.id }));
    if (path.endsWith("/approve-term")) return Promise.resolve(jsonResponse({ terms: [], moreTerms: 0, revision: 2 }));
    const templatePath = /\/templates\/([^/]+)$/u.exec(path);
    if (templatePath !== null) {
      const templateId = decodeURIComponent(templatePath[1] ?? "");
      if (method === "PATCH") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
        if (options.onPatch !== undefined) return Promise.resolve(options.onPatch(templateId, body));
        const current = templates.find((entry) => entry.id === templateId);
        if (current === undefined) return Promise.resolve(jsonResponse({ error: "chat_vote_template_missing" }, 404));
        const updated = { ...current, ...body, revision: current.revision + 1, updatedAt: "2026-10-04T10:01:00.000Z" };
        templates = templates.map((entry) => entry.id === templateId ? updated : entry);
        return Promise.resolve(jsonResponse({ template: updated }));
      }
      if (method === "DELETE") return Promise.resolve(options.onDelete?.(templateId) ?? jsonResponse({ ok: true }));
    }
    return Promise.resolve(jsonResponse({ error: "not_found" }, 404));
  });
  return fetch;
};

const mount = (fetch: typeof globalThis.fetch, language: "de" | "en" = "en") => {
  vi.stubGlobal("fetch", fetch);
  return render(<UiProvider><ToastHost /><ChatVotingPanel channelId="fictional-channel" language={language} /></UiProvider>);
};

describe("saved chat voting panel", () => {
  const initialWidth = window.innerWidth;

  afterEach(() => {
    cleanup();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: initialWidth });
    vi.unstubAllGlobals();
    for (const toast of toastsSnapshot()) dismissToast(toast.id);
  });

  it("shows the saved-vote empty state and the create action", async () => {
    const view = mount(fetchHarness({ templates: [] }));
    expect(await screen.findByText("No saved votes yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Create vote" })).not.toHaveLength(0);
    expect(view.container.querySelector(".chat-voting-live")).toBeInTheDocument();
  });

  it("replaces answers with a quick template and restores the old answers from the toast", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    mount(fetchHarness());
    const pizza = await screen.findByRole("textbox", { name: "Answer 1" });
    expect(pizza).toHaveValue("Pizza");
    fireEvent.click(screen.getByRole("button", { name: "1–5" }));
    expect(await screen.findByRole("textbox", { name: "Answer 5" })).toHaveValue("5");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("textbox", { name: "Answer 1" })).toHaveValue("Pizza");
    expect(screen.getByRole("textbox", { name: "Answer 2" })).toHaveValue("Burger");
    dismissToast(toastsSnapshot().at(-1)?.id ?? -1);
  });

  it("keeps an invalid shortcut local while autosaving other fields", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    let saved: Record<string, unknown> | null = null;
    const view = mount(fetchHarness({ onPatch: (_id, body) => { saved = body; return jsonResponse({ template: { ...template({ title: "Lunch?", revision: 2 }), shortcut: null } }); } }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Question" }), { target: { value: "Lunch?" } });
    const shortcut = screen.getByRole("textbox", { name: "Shortcut" });
    fireEvent.change(shortcut, { target: { value: "Bad!" } });
    expect(shortcut).toBeInvalid();
    await waitFor(() => expect(saved).not.toBeNull(), { timeout: 2_000 });
    expect(saved).toMatchObject({ title: "Lunch?", shortcut: null, labels: ["Pizza", "Burger"] });
    expect(view.container).toHaveTextContent("Use a–z first");
  });

  it("reloads on a revision conflict and preserves the focused field caret when its value is unchanged", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    let requested = false;
    const latest = template({ title: "Lunch?", revision: 2 });
    const fetch = fetchHarness({
      templates: [template()],
      getTemplates: () => requested ? [latest] : [template()],
      onPatch: () => { requested = true; return jsonResponse({ error: "chat_vote_template_conflict" }, 409); },
    });
    const view = mount(fetch);
    const question = await screen.findByRole("textbox", { name: "Question" });
    if (!(question instanceof HTMLInputElement)) throw new Error("The question field is not an input.");
    question.focus();
    fireEvent.change(question, { target: { value: "Lunch?" } });
    const setSelectionRange = Reflect.get(question, "setSelectionRange");
    if (typeof setSelectionRange !== "function") throw new Error("The question field cannot select text.");
    Reflect.apply(setSelectionRange, question, [2, 4]);
    await waitFor(() => expect(requested).toBe(true), { timeout: 2_000 });
    await screen.findByText("“Lunch?” changed elsewhere and was reloaded.");
    await waitFor(() => expect(document.activeElement).toBe(question));
    expect(question).toHaveValue("Lunch?");
    expect(question).toHaveProperty("selectionStart", 2);
    expect(view.container).toHaveTextContent("Changed elsewhere – reloaded");
  });

  it("confirms deletion and removes the saved row", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    let deletedId = "";
    mount(fetchHarness({ onDelete: (id) => { deletedId = id; return jsonResponse({ ok: true }); } }));
    await screen.findByRole("textbox", { name: "Question" });
    fireEvent.click(screen.getByRole("button", { name: "Delete vote" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Delete “Dinner”?");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete vote" }));
    await waitFor(() => expect(deletedId).toBe("template-dinner"));
    await waitFor(() => expect(screen.queryByText("Dinner", { selector: ".list-row__title" })).not.toBeInTheDocument());
  });

  it("shows the shared start lock reason in the inspector footer", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    mount(fetchHarness({
      templates: [template({ lastUsedAt: runningVote.openedAt })],
      current: currentState({ vote: runningVote, counts: [3, 1], hasOpenBallot: true }),
    }));
    const start = await screen.findByRole("button", { name: "Start vote" });
    expect(start).toBeDisabled();
    expect(screen.getByText("A vote is running", { selector: ".chat-voting-editor__start-reason" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "End vote" })).toBeEnabled();
  });

  it("opens a read-only inspector for recent results and offers repeat", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    const recentVote: ChatVote = {
      ...runningVote,
      id: "poll-finished",
      status: "closed",
      openedAt: "2026-10-04T10:00:00.000Z",
      closedAt: "2026-10-04T10:02:00.000Z",
      closeReason: "timer",
      counts: [3, 1],
      voterCount: 4,
    };
    mount(fetchHarness({ recent: [recentVote] }));
    fireEvent.click(await screen.findByRole("radio", { name: "Recent" }));
    expect(await screen.findByRole("button", { name: "Again" })).toBeInTheDocument();
    expect(screen.getByText("Pizza", { selector: ".chat-voting-results__label" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Again" })).toBeEnabled();
  });

  it("keeps the saved order fixed in the session after a template starts", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    const templates = [template(), template({ id: "template-breakfast", title: "Breakfast", shortcut: "morgen" })];
    let started = false;
    mount(fetchHarness({ templates, onStart: () => { started = true; return jsonResponse({ vote: runningVote }); } }));
    const play = await screen.findByRole("button", { name: "Start “Dinner”" });
    fireEvent.click(play);
    await waitFor(() => expect(started).toBe(true));
    const titles = [...document.querySelectorAll(".chat-voting-template-list .list-row__title")].map((element) => element.textContent);
    expect(titles).toEqual(["Dinner", "Breakfast"]);
  });

  it("opens the inspector below 1280px only after a row is selected", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1100 });
    mount(fetchHarness());
    expect(await screen.findByText("Dinner", { selector: ".list-row__title" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Question" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: /Dinner/u }));
    expect(await screen.findByRole("textbox", { name: "Question" })).toBeInTheDocument();
  });
});
