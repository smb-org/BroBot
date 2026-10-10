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
  getCurrent?: () => ChatVotingPanelState | Promise<ChatVotingPanelState>;
  recent?: ChatVote[];
  getRecent?: () => ChatVote[] | Promise<ChatVote[]>;
  getTemplates?: () => ChatVoteTemplate[] | Promise<ChatVoteTemplate[]>;
  csrfToken?: () => string;
  onCreate?: (body: Record<string, unknown>) => Response | Promise<Response>;
  onPatch?: (templateId: string, body: Record<string, unknown>, csrfToken: string) => Response | Promise<Response>;
  onStart?: (body: Record<string, unknown>) => Response;
  onClose?: () => void;
  onDelete?: (templateId: string) => Response;
}

const fetchHarness = (options: FetchHarnessOptions = {}) => {
  let templates = [...(options.templates ?? [template()])];
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
    const path = input instanceof Request
      ? new URL(input.url).pathname
      : new URL(String(input), "https://brobot.example").pathname;
    const method = init?.method ?? "GET";
    if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: options.csrfToken?.() ?? "csrf-token" }));
    if (path.endsWith("/current")) return Promise.resolve(options.getCurrent?.() ?? options.current ?? currentState())
      .then((current) => jsonResponse(current));
    if (path.endsWith("/templates") && method === "GET") {
      const listed = options.getTemplates?.() ?? templates;
      return Promise.resolve(listed).then((entries) => jsonResponse({ templates: entries, count: entries.length, maximum: 100 }));
    }
    if (path.endsWith("/recent")) return Promise.resolve(options.getRecent?.() ?? options.recent ?? [])
      .then((votes) => jsonResponse({ votes }));
    if (path.endsWith("/templates") && method === "POST") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      if (options.onCreate !== undefined) return Promise.resolve(options.onCreate(body));
      const created = template({ id: "created-template", title: typeof body.title === "string" ? body.title : "", labels: Array.isArray(body.labels) ? body.labels as string[] : [], revision: 1 });
      templates = [created, ...templates];
      return Promise.resolve(jsonResponse({ template: created }, 201));
    }
    if (path.endsWith("/start")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      return Promise.resolve(options.onStart?.(body) ?? jsonResponse({ vote: runningVote }));
    }
    if (path.endsWith("/close")) { options.onClose?.(); return Promise.resolve(jsonResponse({ closing: true, pollId: runningVote.id })); }
    if (path.endsWith("/approve-term")) return Promise.resolve(jsonResponse({ terms: [], moreTerms: 0, revision: 2 }));
    const templatePath = /\/templates\/([^/]+)$/u.exec(path);
    if (templatePath !== null) {
      const templateId = decodeURIComponent(templatePath[1] ?? "");
      if (method === "PATCH") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
        if (options.onPatch !== undefined) {
          return Promise.resolve(options.onPatch(templateId, body, new Headers(init?.headers).get("X-CSRF-Token") ?? ""));
        }
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
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
    for (const toast of toastsSnapshot()) dismissToast(toast.id);
  });

  it("shows the saved-vote empty state and the create action", async () => {
    const view = mount(fetchHarness({ templates: [] }));
    expect(await screen.findByText("No saved votes yet")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Create vote" })).not.toHaveLength(0);
    expect(view.container.querySelector(".chat-voting-live")).toBeInTheDocument();
  });

  it("keeps a new draft local and retains edits made while its first Save is pending", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    let resolveCreate!: (response: Response) => void;
    const pendingCreate = new Promise<Response>((resolve) => { resolveCreate = resolve; });
    let submitted: Record<string, unknown> | null = null;
    mount(fetchHarness({ templates: [], onCreate: (body) => { submitted = body; return pendingCreate; } }));
    const createButtons = await screen.findAllByRole("button", { name: "Create vote" });
    const createButton = createButtons.at(0);
    if (createButton === undefined) throw new Error("The create action is missing.");
    fireEvent.click(createButton);
    const question = await screen.findByRole("textbox", { name: "Question" });
    fireEvent.change(question, { target: { value: "First title" } });
    expect(submitted).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(submitted).toMatchObject({ title: "First title" }));
    fireEvent.change(question, { target: { value: "Edit while saving" } });
    resolveCreate(jsonResponse({ template: template({ id: "created-template", title: "First title", revision: 1 }) }, 201));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Question" })).toHaveValue("Edit while saving"));
    expect(screen.getByRole("textbox", { name: "Question" })).toBe(question);
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("keeps quick-template changes local until Save", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    let saved: Record<string, unknown> | null = null;
    mount(fetchHarness({ onPatch: (_id, body) => {
      saved = body;
      return jsonResponse({ template: template({ labels: body.labels as string[], revision: 2 }) });
    } }));
    const pizza = await screen.findByRole("textbox", { name: "Answer 1" });
    expect(pizza).toHaveValue("Pizza");
    fireEvent.click(screen.getByRole("button", { name: "1–5" }));
    expect(await screen.findByRole("textbox", { name: "Answer 5" })).toHaveValue("5");
    expect(saved).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(saved).toMatchObject({ labels: ["1", "2", "3", "4", "5"] }));
  });

  it("keeps an invalid shortcut and other edits local until Save validation", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    const patches: Record<string, unknown>[] = [];
    const view = mount(fetchHarness({ onPatch: (_id, body) => {
      patches.push(body);
      return jsonResponse({ template: { ...template({ title: "Lunch?", revision: 2 }), shortcut: "lunch" } });
    } }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Question" }), { target: { value: "Lunch?" } });
    const shortcut = screen.getByRole("textbox", { name: "Shortcut" });
    fireEvent.change(shortcut, { target: { value: "Bad!" } });
    expect(shortcut).toBeInvalid();
    expect(patches).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(view.container).toHaveTextContent("Use a–z first");
    expect(patches).toHaveLength(0);
    fireEvent.change(shortcut, { target: { value: "lunch" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toMatchObject({ title: "Lunch?", shortcut: "lunch", labels: ["Pizza", "Burger"] });
  });

  it("shows a server shortcut conflict in the field and keeps the full local draft", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    const patches: Record<string, unknown>[] = [];
    mount(fetchHarness({ onPatch: (_id, body) => {
      patches.push(body);
      return jsonResponse({ error: "chat_vote_template_shortcut_conflict" }, 409);
    } }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Question" }), { target: { value: "Lunch?" } });
    fireEvent.change(await screen.findByRole("textbox", { name: "Shortcut" }), { target: { value: "essen" } });
    expect(patches).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(screen.getByRole("textbox", { name: "Shortcut" })).toBeInvalid();
    expect(screen.getByRole("textbox", { name: "Question" })).toHaveValue("Lunch?");
    expect(screen.getByRole("textbox", { name: "Answer 2" })).toHaveValue("Burger");
  });

  it("does not start a stale draft if it changes while the save is pending", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    let resolveFirstSave!: (response: Response) => void;
    const firstSave = new Promise<Response>((resolve) => { resolveFirstSave = resolve; });
    const patches: Record<string, unknown>[] = [];
    let started = false;
    mount(fetchHarness({
      onPatch: (_id, body) => {
        patches.push(body);
        return patches.length === 1
          ? firstSave
          : jsonResponse({ template: template({ title: "Dinner", revision: 3 }) });
      },
      onStart: () => { started = true; return jsonResponse({ vote: runningVote }); },
    }));
    const question = await screen.findByRole("textbox", { name: "Question" });
    fireEvent.change(question, { target: { value: "Dinner B" } });
    fireEvent.click(screen.getByRole("button", { name: "Start vote" }));
    await waitFor(() => expect(patches).toHaveLength(1));
    fireEvent.change(question, { target: { value: "Newer local edit" } });
    resolveFirstSave(jsonResponse({ template: template({ title: "Dinner B", revision: 2 }) }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Question" })).toHaveValue("Newer local edit"));
    expect(started).toBe(false);
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ title: "Dinner B", revision: 1 });
  });

  it("saves an unsaved draft before starting it", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    let serverTemplate = template();
    const order: string[] = [];
    const patches: Record<string, unknown>[] = [];
    mount(fetchHarness({
      onPatch: (_id, body) => {
        patches.push(body);
        order.push("save");
        serverTemplate = { ...serverTemplate, ...body, revision: serverTemplate.revision + 1 };
        return jsonResponse({ template: serverTemplate });
      },
      onStart: () => { order.push("start"); return jsonResponse({ vote: runningVote }); },
    }));
    const question = await screen.findByRole("textbox", { name: "Question" });
    fireEvent.change(question, { target: { value: "Saved before Start" } });
    fireEvent.click(screen.getByRole("button", { name: "Start vote" }));
    await waitFor(() => expect(order).toEqual(["save", "start"]));
    expect(patches[0]).toMatchObject({ title: "Saved before Start", revision: 1 });
  });

  it("refetches an invalidated CSRF token and retries an active mutation once", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    const patches: string[] = [];
    let tokenRequests = 0;
    mount(fetchHarness({
      csrfToken: () => ++tokenRequests === 1 ? "initial-csrf-token" : "refreshed-csrf-token",
      onPatch: (_id, _body, token) => {
        patches.push(token);
        return patches.length === 1
          ? jsonResponse({ error: "csrf_invalid" }, 403)
          : jsonResponse({ template: template({ title: "Recovered save", revision: 2 }) });
      },
    }));
    const question = await screen.findByRole("textbox", { name: "Question" });
    fireEvent.change(question, { target: { value: "Recovered save" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches).toHaveLength(2), { timeout: 2_000 });
    expect(patches[1]).toBe("refreshed-csrf-token");
    expect(patches[0]).not.toBe(patches[1]);
  });

  it("reloads the server version after an explicit save conflicts and preserves the focused caret", async () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(requested).toBe(true), { timeout: 2_000 });
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(document.activeElement).toBe(question));
    expect(question).toHaveValue("Lunch?");
    expect(question).toHaveProperty("selectionStart", 2);
    expect(view.container).not.toHaveTextContent("Changed elsewhere – reload");
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

  it("ignores a slow live-state response after a newer poll has completed", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    let resolveFirst!: (state: ChatVotingPanelState) => void;
    const first = new Promise<ChatVotingPanelState>((resolve) => { resolveFirst = resolve; });
    let currentCalls = 0;
    const closedVote: ChatVote = { ...runningVote, status: "closed", closedAt: "2026-10-04T10:02:00.000Z" };
    mount(fetchHarness({ getCurrent: () => {
      currentCalls += 1;
      return currentCalls === 1 ? first : currentState({ vote: closedVote });
    } }));
    await waitFor(() => expect(currentCalls).toBe(1));
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(currentCalls).toBe(2));
    const start = await screen.findByRole("button", { name: "Start vote" });
    await waitFor(() => expect(start).toBeEnabled());
    resolveFirst(currentState({ vote: runningVote }));
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(start).toBeEnabled();
    expect(screen.queryByRole("button", { name: "End vote" })).not.toBeInTheDocument();
  });

  it("does not let an older template-usage response clear a newer running marker", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    const firstOpenedAt = "2026-10-04T10:00:00.000Z";
    const secondOpenedAt = "2026-10-04T10:01:00.000Z";
    let current = currentState();
    let currentCalls = 0;
    let templateCalls = 0;
    let resolveOldUsage!: (templates: ChatVoteTemplate[]) => void;
    let resolveLatestUsage!: (templates: ChatVoteTemplate[]) => void;
    const oldUsage = new Promise<ChatVoteTemplate[]>((resolve) => { resolveOldUsage = resolve; });
    const latestUsage = new Promise<ChatVoteTemplate[]>((resolve) => { resolveLatestUsage = resolve; });
    const fetch = fetchHarness({
      getCurrent: () => { currentCalls += 1; return current; },
      getTemplates: () => {
        templateCalls += 1;
        if (templateCalls === 2) return oldUsage;
        if (templateCalls === 3) return latestUsage;
        return [template()];
      },
    });
    mount(fetch);
    await screen.findByRole("button", { name: "Start “Dinner”" });
    const firstVote: ChatVote = { ...runningVote, id: "poll-first", openedAt: firstOpenedAt };
    current = currentState({ vote: firstVote });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(templateCalls).toBe(2));

    current = currentState();
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(currentCalls).toBeGreaterThan(2));
    const start = screen.getByRole("button", { name: "Start “Dinner”" });
    await waitFor(() => expect(start).toBeEnabled());
    const secondVote: ChatVote = { ...runningVote, id: "poll-second", openedAt: secondOpenedAt };
    current = currentState({ vote: secondVote });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(templateCalls).toBe(3));
    resolveLatestUsage([template({ lastUsedAt: secondOpenedAt })]);
    await waitFor(() => expect(document.querySelector(".chat-voting-template-list")).toHaveTextContent("Running"));
    resolveOldUsage([template({ lastUsedAt: firstOpenedAt })]);
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(document.querySelector(".chat-voting-template-list")).toHaveTextContent("Running");
  });

  it("clears a usage-refresh error after a later usage refresh succeeds", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    let current = currentState();
    let currentCalls = 0;
    let templateCalls = 0;
    const openedAt = "2026-10-04T10:00:00.000Z";
    mount(fetchHarness({
      getCurrent: () => { currentCalls += 1; return current; },
      getTemplates: () => {
        templateCalls += 1;
        if (templateCalls === 2) return Promise.reject(new Error("temporary usage refresh failure"));
        return [template({ lastUsedAt: templateCalls > 2 ? openedAt : null })];
      },
    }));
    await screen.findByRole("button", { name: "Start “Dinner”" });
    await waitFor(() => expect(templateCalls).toBe(1));
    current = currentState({ vote: runningVote });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(currentCalls).toBeGreaterThan(1));
    await waitFor(() => expect(templateCalls).toBe(2));
    expect(document.querySelector(".chat-voting-list .stale")).toBeInTheDocument();

    current = currentState();
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(currentCalls).toBeGreaterThan(2));
    current = currentState({ vote: { ...runningVote, id: "poll-next", openedAt: "2026-10-04T10:01:00.000Z" } });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(templateCalls).toBe(3));
    await waitFor(() => expect(document.querySelector(".chat-voting-list .stale")).not.toBeInTheDocument());
  });

  it("can enter Custom duration from a preset and return to it after choosing another preset", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    mount(fetchHarness({ templates: [template({ durationSeconds: 120 })] }));
    const seconds = await screen.findByRole("spinbutton", { name: "Seconds" });
    expect(seconds).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "Custom" }));
    expect(seconds).toBeEnabled();
    fireEvent.change(seconds, { target: { value: "150" } });
    fireEvent.change(seconds, { target: { value: "120" } });
    expect(seconds).toBeEnabled();
    expect(screen.getByRole("radio", { name: "Custom" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "2 min" }));
    expect(seconds).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "Custom" }));
    expect(seconds).toBeEnabled();
  });

  it("synchronizes duration mode after a conflict reload", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    const latest = template({ durationSeconds: 300, revision: 2 });
    mount(fetchHarness({
      templates: [template()],
      getTemplates: () => [latest],
      onPatch: () => jsonResponse({ error: "chat_vote_template_conflict" }, 409),
    }));
    const seconds = await screen.findByRole("spinbutton", { name: "Seconds" });
    fireEvent.click(screen.getByRole("radio", { name: "Custom" }));
    fireEvent.change(seconds, { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.getByRole("radio", { name: "5 min" })).toBeChecked());
    expect(seconds).toHaveValue("300");
    expect(seconds).toBeDisabled();
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
    let current = currentState();
    let serverTemplates = templates;
    mount(fetchHarness({ templates, getCurrent: () => current, getTemplates: () => serverTemplates, onStart: () => {
      started = true;
      current = currentState({ vote: runningVote, counts: [0, 0] });
      serverTemplates = templates.map((entry) => entry.id === templates[0]?.id ? { ...entry, lastUsedAt: runningVote.openedAt } : entry);
      return jsonResponse({ vote: runningVote });
    } }));
    const play = await screen.findByRole("button", { name: "Start “Dinner”" });
    fireEvent.click(play);
    await waitFor(() => expect(started).toBe(true));
    await waitFor(() => expect(document.querySelector(".chat-voting-template-list")).toHaveTextContent("Running"));
    expect(document.querySelector(".chat-voting-template-list .list-row:first-child .list-row__action button")).toBeNull();
    const titles = [...document.querySelectorAll(".chat-voting-template-list .list-row__title")].map((element) => element.textContent);
    expect(titles).toEqual(["Dinner", "Breakfast"]);
  });

  it("refreshes template usage when polling observes a vote started from chat", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const closedVote = { ...runningVote, status: "closed" as const, closedAt: "2026-10-04T10:02:00.000Z" };
    let current = currentState({ vote: closedVote });
    let serverTemplate = template();
    mount(fetchHarness({ getCurrent: () => current, getTemplates: () => [serverTemplate] }));
    fireEvent.click(await screen.findByRole("link", { name: /Dinner/u }));
    await screen.findByRole("textbox", { name: "Question" });
    current = currentState({ vote: runningVote, counts: [0, 0] });
    serverTemplate = { ...serverTemplate, lastUsedAt: runningVote.openedAt };
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(document.querySelector(".chat-voting-template-list")).toHaveTextContent("Running"));
    expect(document.querySelector(".chat-voting-template-list .list-row__action button")).toBeNull();
    expect(screen.getByText("Changes apply from the next start.")).toBeInTheDocument();
  });

  it("reloads Recent after a vote closes and each time the view is reopened", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const completedVote: ChatVote = {
      ...runningVote,
      id: "poll-completed",
      status: "closed",
      closedAt: "2026-10-04T10:02:00.000Z",
      counts: [3, 1],
      voterCount: 4,
    };
    let current = currentState();
    let recentRequests = 0;
    mount(fetchHarness({
      getCurrent: () => current,
      getRecent: () => { recentRequests += 1; return current.vote?.status === "closed" ? [completedVote] : []; },
      onClose: () => { current = currentState({ vote: completedVote }); },
    }));
    fireEvent.click(await screen.findByRole("radio", { name: "Recent" }));
    expect(await screen.findByText("No vote has run yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Saved" }));
    current = currentState({ vote: runningVote });
    document.dispatchEvent(new Event("visibilitychange"));
    fireEvent.click(await screen.findByRole("button", { name: "End vote" }));
    await waitFor(() => expect(current.vote?.status).toBe("closed"));
    fireEvent.click(screen.getByRole("radio", { name: "Recent" }));
    await waitFor(() => expect(recentRequests).toBeGreaterThanOrEqual(2));
    expect(await screen.findByText("Dinner", { selector: ".list-row__title" })).toBeInTheDocument();
    expect(recentRequests).toBeGreaterThanOrEqual(2);
  });

  it("refreshes an open Recent view when polling first sees a different closed vote", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const previousClosedVote: ChatVote = { ...runningVote, id: "poll-previous", status: "closed", closedAt: "2026-10-04T10:01:00.000Z" };
    const newlyClosedVote: ChatVote = { ...runningVote, id: "poll-new", title: "Lunch", status: "closed", closedAt: "2026-10-04T10:02:00.000Z" };
    let current = currentState();
    let recentRequests = 0;
    mount(fetchHarness({
      getCurrent: () => current,
      getRecent: () => {
        recentRequests += 1;
        return current.vote?.id === newlyClosedVote.id ? [newlyClosedVote, previousClosedVote] : [previousClosedVote];
      },
    }));
    fireEvent.click(await screen.findByRole("radio", { name: "Recent" }));
    await waitFor(() => expect(recentRequests).toBeGreaterThan(0));
    expect(await screen.findByText("Dinner", { selector: ".list-row__title" })).toBeInTheDocument();
    const previousRequestCount = recentRequests;
    current = currentState({ vote: newlyClosedVote });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(await screen.findByText("Lunch", { selector: ".list-row__title" })).toBeInTheDocument();
    expect(recentRequests).toBeGreaterThan(previousRequestCount);
  });

  it("does not let an in-flight Recent response undo history invalidation", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const staleVote: ChatVote = { ...runningVote, id: "poll-stale", title: "Stale", status: "closed", closedAt: "2026-10-04T10:01:00.000Z" };
    const latestVote: ChatVote = { ...runningVote, id: "poll-latest", title: "Latest", status: "closed", closedAt: "2026-10-04T10:02:00.000Z" };
    let current = currentState();
    let recentRequests = 0;
    let resolveStale!: (votes: ChatVote[]) => void;
    const staleResponse = new Promise<ChatVote[]>((resolve) => { resolveStale = resolve; });
    mount(fetchHarness({
      getCurrent: () => current,
      getRecent: () => {
        recentRequests += 1;
        return recentRequests === 1 ? staleResponse : [latestVote];
      },
    }));
    await waitFor(() => expect(document.querySelector(".chat-voting-live")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("radio", { name: "Recent" }));
    await waitFor(() => expect(recentRequests).toBe(1));
    current = currentState({ vote: latestVote });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(await screen.findByText("Latest", { selector: ".list-row__title" })).toBeInTheDocument();
    resolveStale([staleVote]);
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(screen.getByText("Latest", { selector: ".list-row__title" })).toBeInTheDocument();
    expect(screen.queryByText("Stale", { selector: ".list-row__title" })).not.toBeInTheDocument();
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
