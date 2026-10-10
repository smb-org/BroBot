import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { ToastHost } from "../../src/dashboard/ui/Toast";
import { dismissToast, toastsSnapshot } from "../../src/dashboard/ui/toast-store";
import { ChatVotingPanel } from "../../src/modules/chat_voting/panel";
import ChatVotingImmediateAction from "../../src/modules/chat_voting/panel/immediate-actions";
import type { ChatVote, ChatVoteTemplate } from "../../src/modules/chat_voting/contracts";
import type { ChatVotingPanelState } from "../../src/modules/chat_voting/panel/service";
import { moduleQueryKey } from "../../src/dashboard/data/module-query";
import { reconcileDashboardPanelResourceRevisions, setDashboardRealtimeStatus } from "../../src/dashboard/data/realtime";
import { jsonResponse } from "../unit/fixtures";
import { renderWithQuery as render } from "../query-test-utils";

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
  getCurrent?: (signal?: AbortSignal) => ChatVotingPanelState | Promise<ChatVotingPanelState>;
  recent?: ChatVote[];
  getRecent?: (signal?: AbortSignal) => ChatVote[] | Promise<ChatVote[]>;
  getTemplates?: (signal?: AbortSignal) => ChatVoteTemplate[] | Promise<ChatVoteTemplate[]>;
  getRevisions?: () => Readonly<Record<string, number>>;
  csrfToken?: () => string;
  onCreate?: (body: Record<string, unknown>) => Response | Promise<Response>;
  onPatch?: (templateId: string, body: Record<string, unknown>, csrfToken: string) => Response | Promise<Response>;
  onStart?: (body: Record<string, unknown>) => Response | Promise<Response>;
  onClose?: () => void;
  onDelete?: (templateId: string) => Response | Promise<Response>;
}

const fetchHarness = (options: FetchHarnessOptions = {}) => {
  let templates = [...(options.templates ?? [template()])];
  const fetch = vi.fn<typeof globalThis.fetch>((input, init) => {
    const path = input instanceof Request
      ? new URL(input.url).pathname
      : new URL(String(input), "https://brobot.example").pathname;
    const method = init?.method ?? "GET";
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (path === "/api/csrf") return Promise.resolve(jsonResponse({ token: options.csrfToken?.() ?? "csrf-token" }));
    if (path.endsWith("/revisions")) return Promise.resolve(jsonResponse({ revisions: options.getRevisions?.() ?? {} }));
    if (path.endsWith("/current")) return Promise.resolve(options.getCurrent?.(signal) ?? options.current ?? currentState())
      .then((current) => jsonResponse(current));
    if (path.endsWith("/templates") && method === "GET") {
      const listed = options.getTemplates?.(signal) ?? templates;
      return Promise.resolve(listed).then((entries) => jsonResponse({ templates: entries, count: entries.length, maximum: 100 }));
    }
    if (path.endsWith("/recent")) return Promise.resolve(options.getRecent?.(signal) ?? options.recent ?? [])
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
      if (method === "DELETE") {
        return Promise.resolve(options.onDelete?.(templateId) ?? jsonResponse({ ok: true })).then((response) => {
          if (response.ok) templates = templates.filter((entry) => entry.id !== templateId);
          return response;
        });
      }
    }
    return Promise.resolve(jsonResponse({ error: "not_found" }, 404));
  });
  return fetch;
};

const mount = (fetch: typeof globalThis.fetch, language: "de" | "en" = "en") => {
  setDashboardRealtimeStatus("fictional-channel", "connected");
  vi.stubGlobal("fetch", fetch);
  return render(<UiProvider><ToastHost /><ChatVotingPanel channelId="fictional-channel" language={language} /></UiProvider>);
};

describe("saved chat voting panel", () => {
  const initialWidth = window.innerWidth;

  afterEach(() => {
    cleanup();
    setDashboardRealtimeStatus("fictional-channel", "offline");
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

  it("notifies once per live-state outage and again after the state recovers", async () => {
    let unavailable = false;
    const fetcher = fetchHarness({ getCurrent: () => {
      if (unavailable) throw new Error("state unavailable");
      return currentState();
    } });
    const view = mount(fetcher);
    expect(await screen.findByText("No vote yet")).toBeInTheDocument();
    const key = { queryKey: moduleQueryKey("fictional-channel", "chat_voting", "panel"), exact: true };
    const refresh = async (): Promise<void> => {
      await act(async () => { await view.queryClient.refetchQueries(key, { throwOnError: true }).catch(() => undefined); });
    };

    unavailable = true;
    await refresh();
    await refresh();
    expect(view.queryClient.getQueryState(key.queryKey)?.status).toBe("error");
    expect(toastsSnapshot().filter((toast) => toast.message === "The vote could not be loaded.")).toHaveLength(1);

    unavailable = false;
    await refresh();
    unavailable = true;
    await refresh();
    expect(toastsSnapshot().filter((toast) => toast.message === "The vote could not be loaded.")).toHaveLength(2);
  });

  it("does not notify or latch an outage when live, saved, or recent reads are canceled", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    let phase: "initial" | "cancel" | "failure" = "initial";
    const reads = { current: 0, templates: 0, recent: 0 };
    const abortOnSignal = <Value,>(signal: AbortSignal | undefined): Promise<Value> => new Promise((_resolve, reject) => {
      if (signal === undefined) {
        reject(new Error("The query did not provide an abort signal."));
        return;
      }
      const abort = (): void => { reject(new DOMException("Aborted", "AbortError")); };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    const read = <Value,>(resource: keyof typeof reads, signal: AbortSignal | undefined, value: Value): Value | Promise<Value> => {
      const count = ++reads[resource];
      if (phase === "cancel" && count > 1) return abortOnSignal<Value>(signal);
      if (phase === "failure" && count > 2) throw new Error(`${resource} unavailable`);
      return value;
    };
    const view = mount(fetchHarness({
      getCurrent: (signal) => read("current", signal, currentState()),
      getTemplates: (signal) => read("templates", signal, [template()]),
      getRecent: (signal) => read("recent", signal, []),
    }));
    await screen.findByRole("textbox", { name: "Question" });
    fireEvent.click(screen.getByRole("radio", { name: "Recent" }));
    await waitFor(() => expect(reads.recent).toBe(2));

    phase = "cancel";
    const previousReads = { ...reads };
    const keys = ["panel", "templates", "recent"].map((part) => moduleQueryKey("fictional-channel", "chat_voting", part));
    await act(async () => {
      for (const queryKey of keys) void view.queryClient.refetchQueries({ queryKey, exact: true });
      await waitFor(() => expect(reads).toEqual({
        current: previousReads.current + 1,
        templates: previousReads.templates + 1,
        recent: previousReads.recent + 1,
      }));
    });
    await act(async () => {
      await Promise.all(keys.map((queryKey) => view.queryClient.cancelQueries({ queryKey, exact: true })));
    });
    expect(toastsSnapshot().filter((toast) => toast.tone === "error")).toHaveLength(0);

    phase = "failure";
    await act(async () => {
      await Promise.all(keys.map((queryKey) => view.queryClient.refetchQueries({ queryKey, exact: true }, { throwOnError: true }).catch(() => undefined)));
    });
    expect(toastsSnapshot().map((toast) => toast.message)).toEqual(expect.arrayContaining([
      "The vote could not be loaded.",
      "Saved votes could not be loaded.",
      "Recent votes could not be loaded.",
    ]));
  });

  it("does not report a template read canceled by a successful save", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    let templateReads = 0;
    let canceledReads = 0;
    let failNextRead = false;
    const view = mount(fetchHarness({ getTemplates: (signal) => {
      templateReads += 1;
      if (templateReads === 2) return new Promise<ChatVoteTemplate[]>((_resolve, reject) => {
        const abort = (): void => {
          canceledReads += 1;
          reject(new DOMException("Aborted", "AbortError"));
        };
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });
      if (failNextRead) {
        failNextRead = false;
        throw new Error("Saved votes are unavailable.");
      }
      return [template()];
    } }));
    await screen.findByRole("textbox", { name: "Question" });
    const key = { queryKey: moduleQueryKey("fictional-channel", "chat_voting", "templates"), exact: true };
    await act(async () => {
      void view.queryClient.refetchQueries(key);
      await waitFor(() => expect(templateReads).toBe(2));
    });

    fireEvent.change(screen.getByRole("textbox", { name: "Question" }), { target: { value: "Saved after cancel" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(templateReads).toBe(3));
    await waitFor(() => expect(canceledReads).toBe(1));
    expect(toastsSnapshot().some((toast) => toast.message === "Saved votes could not be loaded.")).toBe(false);

    failNextRead = true;
    await act(async () => { await view.queryClient.refetchQueries(key, { throwOnError: true }).catch(() => undefined); });
    expect(toastsSnapshot().filter((toast) => toast.message === "Saved votes could not be loaded.")).toHaveLength(1);
  });

  it("refreshes the live, saved, recent, and immediate-action views from panel resource revisions", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    let current = currentState();
    let templates: ChatVoteTemplate[] = [];
    let recent: ChatVote[] = [];
    let revisions: Readonly<Record<string, number>> = {};
    const fetcher = fetchHarness({
      getCurrent: () => current,
      getTemplates: () => templates,
      getRecent: () => recent,
      getRevisions: () => revisions,
    });
    setDashboardRealtimeStatus("fictional-channel", "connected");
    vi.stubGlobal("fetch", fetcher);
    const view = render(<UiProvider><ToastHost />
      <ChatVotingPanel channelId="fictional-channel" language="en" />
      <ChatVotingImmediateAction channelId="fictional-channel" availabilityReason={null} />
    </UiProvider>);

    expect(await screen.findByText("No saved votes yet")).toBeInTheDocument();
    const recentMode = screen.getAllByRole("radio", { name: "Recent" })[0];
    if (recentMode === undefined) throw new Error("The Recent view control is missing.");
    fireEvent.click(recentMode);
    expect(await screen.findByText("No vote has run yet")).toBeInTheDocument();
    const requestCount = (suffix: string): number => fetcher.mock.calls.filter(([input]) =>
      new URL(input instanceof Request ? input.url : String(input), "https://brobot.example").pathname.endsWith(suffix)).length;
    await waitFor(() => expect(requestCount("/recent")).toBeGreaterThan(0));
    const currentReads = requestCount("/current");
    const templateReads = requestCount("/templates");
    const recentReads = requestCount("/recent");

    current = currentState({ vote: runningVote, counts: [2, 1] });
    templates = [template({ title: "Updated dinner", revision: 2 })];
    recent = [{ ...runningVote, id: "poll-completed", title: "Completed dinner", status: "closed", closedAt: "2026-10-04T10:02:00.000Z", counts: [3, 1], voterCount: 4 }];
    revisions = {
      "module:chat_voting:panel": 1,
      "module:chat_voting:templates": 1,
      "module:chat_voting:recent": 1,
    };
    await act(async () => { await reconcileDashboardPanelResourceRevisions(view.queryClient, "fictional-channel"); });

    await waitFor(() => expect(requestCount("/current")).toBeGreaterThan(currentReads));
    await waitFor(() => expect(requestCount("/templates")).toBeGreaterThan(templateReads));
    await waitFor(() => expect(requestCount("/recent")).toBeGreaterThan(recentReads));
    await waitFor(() => expect(view.queryClient.getQueryData(moduleQueryKey("fictional-channel", "chat_voting", "panel")))
      .toMatchObject({ vote: { id: runningVote.id, status: "open" } }));
    expect(view.container.querySelector(".chat-voting-live")).toHaveTextContent("Dinner");
    expect(view.container.querySelector(".chat-voting-template-list")).toHaveTextContent("Updated dinner");
    expect(view.container.querySelector(".chat-voting-immediate")).toHaveTextContent("Dinner");
    expect(view.container.querySelector(".chat-voting-recent-list")).toHaveTextContent("Completed dinner");
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
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeEnabled());
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

  it("ignores a delayed conflict reload after replacing the template inspector", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    const first = template({ id: "template-a", title: "Template A" });
    const second = template({ id: "template-b", title: "Template B" });
    const latestFirst = { ...first, title: "Updated Template A", revision: 2 };
    let deferNextRead = false;
    let resolveReload: ((templates: ChatVoteTemplate[]) => void) | undefined;
    const patches: { id: string; body: Record<string, unknown> }[] = [];
    mount(fetchHarness({
      templates: [first, second],
      getTemplates: () => {
        if (!deferNextRead) return [first, second];
        deferNextRead = false;
        return new Promise<ChatVoteTemplate[]>((resolve) => { resolveReload = resolve; });
      },
      onPatch: (id, body) => {
        patches.push({ id, body });
        if (patches.length === 1) return jsonResponse({ error: "chat_vote_template_conflict" }, 409);
        return jsonResponse({ template: { ...second, title: String(body.title), revision: 2 } });
      },
    }));
    const question = await screen.findByRole("textbox", { name: "Question" });
    fireEvent.change(question, { target: { value: "Unsaved Template A" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("button", { name: "Reload" });

    deferNextRead = true;
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(resolveReload).toBeTypeOf("function"));
    if (resolveReload === undefined) throw new Error("The conflict reload did not start.");
    const completeReload = resolveReload;
    const secondLink = [...document.querySelectorAll<HTMLAnchorElement>(".chat-voting-template-list .list-row__link")]
      .find((link) => link.textContent.includes("Template B"));
    if (secondLink === undefined) throw new Error("Template B is missing from the saved list.");
    fireEvent.click(secondLink);
    const discardDialog = await screen.findByRole("dialog", { name: "Discard changes?" });
    fireEvent.click(within(discardDialog).getByRole("button", { name: "Discard changes" }));
    const secondQuestion = await screen.findByRole("textbox", { name: "Question" });
    await waitFor(() => expect(secondQuestion).toHaveValue("Template B"));
    fireEvent.change(secondQuestion, { target: { value: "Unsaved Template B" } });

    await act(async () => {
      completeReload([latestFirst, second]);
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches).toEqual([
      { id: "template-a", body: { title: "Unsaved Template A", shortcut: null, labels: ["Pizza", "Burger"], freeTextMode: null, durationSeconds: 120, revision: 1 } },
      { id: "template-b", body: { title: "Unsaved Template B", shortcut: null, labels: ["Pizza", "Burger"], freeTextMode: null, durationSeconds: 120, revision: 1 } },
    ]);
  });

  it("confirms deletion and removes the saved row", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    let deletedId = "";
    mount(fetchHarness({ onDelete: (id) => { deletedId = id; return jsonResponse({ ok: true }); } }));
    await screen.findByRole("textbox", { name: "Question" });
    fireEvent.click(screen.getByRole("button", { name: "Actions for “Dinner”" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete vote", hidden: true }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("Delete “Dinner”?");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete vote" }));
    await waitFor(() => expect(deletedId).toBe("template-dinner"));
    await waitFor(() => expect(screen.queryByText("Dinner", { selector: ".list-row__title" })).not.toBeInTheDocument());
  });

  it("keeps a delayed deletion from switching away from another editor draft", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    const templates = [
      template({ id: "template-a", title: "Template A" }),
      template({ id: "template-b", title: "Template B" }),
      template({ id: "template-c", title: "Template C" }),
    ];
    let resolveDelete!: (response: Response) => void;
    const pendingDelete = new Promise<Response>((resolve) => { resolveDelete = resolve; });
    mount(fetchHarness({ templates, onDelete: () => pendingDelete }));
    await screen.findByRole("textbox", { name: "Question" });
    fireEvent.click(screen.getByRole("button", { name: "Actions for “Template A”" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete vote", hidden: true }));
    const dialog = await screen.findByRole("dialog", { name: "Delete “Template A”?" });
    const confirm = within(dialog).getByRole("button", { name: "Delete vote" });
    const cancel = within(dialog).getByRole("button", { name: "Cancel" });
    fireEvent.click(confirm);
    await waitFor(() => {
      expect(confirm).toBeDisabled();
      expect(cancel).toBeDisabled();
    });

    const templateCLink = [...document.querySelectorAll<HTMLAnchorElement>(".chat-voting-template-list .list-row__link")]
      .find((link) => link.textContent.includes("Template C"));
    if (templateCLink === undefined) throw new Error("Template C is missing from the saved list.");
    fireEvent.click(templateCLink);
    const question = await screen.findByRole("textbox", { name: "Question" });
    await waitFor(() => expect(question).toHaveValue("Template C"));
    fireEvent.change(question, { target: { value: "Unsaved draft on C" } });

    resolveDelete(jsonResponse({ ok: true }));
    await waitFor(() => expect(screen.queryByText("Template A", { selector: ".list-row__title" })).not.toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "Question" })).toHaveValue("Unsaved draft on C");
    expect(document.querySelector(".ui-save-bar__status")).toHaveTextContent("Unsaved changes");
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

  it("keeps the newest live state when revision invalidation supersedes an in-flight read", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    let resolveFirst!: (state: ChatVotingPanelState) => void;
    const first = new Promise<ChatVotingPanelState>((resolve) => { resolveFirst = resolve; });
    let currentCalls = 0;
    let revisions: Readonly<Record<string, number>> = {};
    const closedVote: ChatVote = { ...runningVote, status: "closed", closedAt: "2026-10-04T10:02:00.000Z" };
    const view = mount(fetchHarness({ getRevisions: () => revisions, getCurrent: () => {
      currentCalls += 1;
      return currentCalls === 1 ? first : currentState({ vote: closedVote });
    } }));
    await waitFor(() => expect(currentCalls).toBe(1));
    revisions = { "module:chat_voting:panel": 1 };
    await act(async () => { await reconcileDashboardPanelResourceRevisions(view.queryClient, "fictional-channel"); });
    await waitFor(() => expect(currentCalls).toBe(2));
    const start = await screen.findByRole("button", { name: "Start vote" });
    await waitFor(() => expect(start).toBeEnabled());
    resolveFirst(currentState({ vote: runningVote }));
    await new Promise((resolve) => window.setTimeout(resolve, 20));
    expect(start).toBeEnabled();
    expect(screen.queryByRole("button", { name: "End vote" })).not.toBeInTheDocument();
  });

  it("clears a stale template error after a later resource revision succeeds", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    let templateCalls = 0;
    let revisions: Readonly<Record<string, number>> = {};
    const view = mount(fetchHarness({
      getRevisions: () => revisions,
      getTemplates: () => {
        templateCalls += 1;
        if (templateCalls === 2) throw new Error("temporary template read failure");
        return [template({ title: templateCalls > 2 ? "Updated dinner" : "Dinner" })];
      },
    }));
    await screen.findByRole("button", { name: "Start “Dinner”" });
    await waitFor(() => expect(templateCalls).toBe(1));
    revisions = { "module:chat_voting:templates": 1 };
    await act(async () => { await reconcileDashboardPanelResourceRevisions(view.queryClient, "fictional-channel"); });
    await waitFor(() => expect(templateCalls).toBe(2));
    expect(document.querySelector(".chat-voting-list .stale")).toBeInTheDocument();

    revisions = { "module:chat_voting:templates": 2 };
    await act(async () => { await reconcileDashboardPanelResourceRevisions(view.queryClient, "fictional-channel"); });
    await waitFor(() => expect(templateCalls).toBe(3));
    await waitFor(() => expect(document.querySelector(".chat-voting-list .stale")).not.toBeInTheDocument());
    expect(document.querySelector(".chat-voting-template-list")).toHaveTextContent("Updated dinner");
  });

  it("accepts a refreshed template snapshot after guarded reselection", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    let revisions: Readonly<Record<string, number>> = {};
    let started = false;
    const refreshed = template({
      title: "Updated by another moderator",
      labels: ["Fresh yes", "Fresh no"],
      durationSeconds: 300,
      revision: 2,
    });
    const view = mount(fetchHarness({
      getRevisions: () => revisions,
      getTemplates: () => revisions["module:chat_voting:templates"] === undefined ? [template()] : [refreshed],
      onStart: () => { started = true; return jsonResponse({ vote: runningVote }); },
    }));
    await screen.findByRole("textbox", { name: "Question" });
    revisions = { "module:chat_voting:templates": 1 };
    await act(async () => { await reconcileDashboardPanelResourceRevisions(view.queryClient, "fictional-channel"); });
    await waitFor(() => expect(document.querySelector(".chat-voting-template-list")).toHaveTextContent(refreshed.title));

    fireEvent.click(screen.getByRole("link", { name: /Updated by another moderator/u }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Question" })).toHaveValue(refreshed.title));
    expect(screen.getByRole("textbox", { name: "Answer 1" })).toHaveValue("Fresh yes");
    expect(screen.getByRole("spinbutton", { name: "Seconds" })).toHaveValue("300");
    expect(screen.getByRole("radio", { name: "5 min" })).toBeChecked();
    const start = screen.getByRole("button", { name: "Start vote" });
    expect(start).toBeEnabled();
    fireEvent.click(start);
    await waitFor(() => expect(started).toBe(true));
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

  it("merges a delayed template start into the latest revision without regressing usage time", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    let revisions: Readonly<Record<string, number>> = {};
    let serverTemplate = template();
    let markStartRequested!: () => void;
    const startRequested = new Promise<void>((resolve) => { markStartRequested = resolve; });
    let resolveStart!: (response: Response) => void;
    const pendingStart = new Promise<Response>((resolve) => { resolveStart = resolve; });
    const refreshed = template({
      title: "Updated during start",
      labels: ["Newest yes", "Newest no"],
      durationSeconds: 300,
      revision: 2,
      lastUsedAt: "2030-01-01T12:30:00.000Z",
    });
    const view = mount(fetchHarness({
      getRevisions: () => revisions,
      getTemplates: () => [serverTemplate],
      onStart: () => { markStartRequested(); return pendingStart; },
    }));
    await screen.findByRole("textbox", { name: "Question" });
    fireEvent.click(screen.getByRole("button", { name: "Start vote" }));
    await startRequested;

    serverTemplate = refreshed;
    revisions = { "module:chat_voting:templates": 1 };
    await act(async () => { await reconcileDashboardPanelResourceRevisions(view.queryClient, "fictional-channel"); });
    await waitFor(() => expect(document.querySelector(".chat-voting-template-list")).toHaveTextContent(refreshed.title));

    const startedVote = { ...runningVote, openedAt: "2030-01-01T12:00:00.000Z", closesAt: "2030-01-01T12:05:00.000Z" };
    resolveStart(jsonResponse({ vote: startedVote }));
    await waitFor(() => {
      const templates = view.queryClient.getQueryData<{ templates: ChatVoteTemplate[] }>(moduleQueryKey("fictional-channel", "chat_voting", "templates"))?.templates;
      expect(templates?.[0]).toMatchObject({
        title: "Updated during start",
        labels: ["Newest yes", "Newest no"],
        durationSeconds: 300,
        revision: 2,
        lastUsedAt: "2030-01-01T12:30:00.000Z",
      });
    });
  });

  it("refreshes template usage from resource revisions after a vote starts in chat", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    const closedVote = { ...runningVote, status: "closed" as const, closedAt: "2026-10-04T10:02:00.000Z" };
    let current = currentState({ vote: closedVote });
    let serverTemplate = template();
    let revisions: Readonly<Record<string, number>> = {};
    const view = mount(fetchHarness({ getRevisions: () => revisions, getCurrent: () => current, getTemplates: () => [serverTemplate] }));
    fireEvent.click(await screen.findByRole("link", { name: /Dinner/u }));
    await screen.findByRole("textbox", { name: "Question" });
    current = currentState({ vote: runningVote, counts: [0, 0] });
    serverTemplate = { ...serverTemplate, lastUsedAt: runningVote.openedAt };
    revisions = { "module:chat_voting:panel": 1, "module:chat_voting:templates": 1 };
    await act(async () => { await reconcileDashboardPanelResourceRevisions(view.queryClient, "fictional-channel"); });
    await waitFor(() => expect(document.querySelector(".chat-voting-template-list")).toHaveTextContent("Running"));
    expect(document.querySelector(".chat-voting-template-list .list-row__action button")).toBeNull();
    expect(screen.getByText("Changes apply from the next start.")).toBeInTheDocument();
  });

  it("reloads Recent after a vote closes and each time the view is reopened", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
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
    let revisions: Readonly<Record<string, number>> = {};
    const view = mount(fetchHarness({
      getRevisions: () => revisions,
      getCurrent: () => current,
      getRecent: () => { recentRequests += 1; return current.vote?.status === "closed" ? [completedVote] : []; },
      onClose: () => { current = currentState({ vote: completedVote }); },
    }));
    fireEvent.click(await screen.findByRole("radio", { name: "Recent" }));
    expect(await screen.findByText("No vote has run yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Saved" }));
    current = currentState({ vote: runningVote });
    revisions = { "module:chat_voting:panel": 1 };
    await act(async () => { await reconcileDashboardPanelResourceRevisions(view.queryClient, "fictional-channel"); });
    await screen.findByRole("button", { name: "End vote" });
    fireEvent.click(await screen.findByRole("button", { name: "End vote" }));
    await waitFor(() => expect(current.vote?.status).toBe("closed"));
    fireEvent.click(screen.getByRole("radio", { name: "Recent" }));
    await waitFor(() => expect(recentRequests).toBeGreaterThanOrEqual(2));
    expect(await screen.findByText("Dinner", { selector: ".list-row__title" })).toBeInTheDocument();
    expect(recentRequests).toBeGreaterThanOrEqual(2);
  });

  it("refreshes an open Recent view when the recent resource revision changes", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    const previousClosedVote: ChatVote = { ...runningVote, id: "poll-previous", status: "closed", closedAt: "2026-10-04T10:01:00.000Z" };
    const newlyClosedVote: ChatVote = { ...runningVote, id: "poll-new", title: "Lunch", status: "closed", closedAt: "2026-10-04T10:02:00.000Z" };
    let current = currentState();
    let recentRequests = 0;
    let revisions: Readonly<Record<string, number>> = {};
    const view = mount(fetchHarness({
      getRevisions: () => revisions,
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
    revisions = { "module:chat_voting:panel": 1, "module:chat_voting:recent": 1 };
    await act(async () => { await reconcileDashboardPanelResourceRevisions(view.queryClient, "fictional-channel"); });
    expect(await screen.findByText("Lunch", { selector: ".list-row__title" })).toBeInTheDocument();
    expect(recentRequests).toBeGreaterThan(previousRequestCount);
  });

  it("does not let an in-flight Recent response undo history invalidation", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    const staleVote: ChatVote = { ...runningVote, id: "poll-stale", title: "Stale", status: "closed", closedAt: "2026-10-04T10:01:00.000Z" };
    const latestVote: ChatVote = { ...runningVote, id: "poll-latest", title: "Latest", status: "closed", closedAt: "2026-10-04T10:02:00.000Z" };
    let current = currentState();
    let recentRequests = 0;
    let revisions: Readonly<Record<string, number>> = {};
    let resolveStale!: (votes: ChatVote[]) => void;
    const staleResponse = new Promise<ChatVote[]>((resolve) => { resolveStale = resolve; });
    const view = mount(fetchHarness({
      getRevisions: () => revisions,
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
    revisions = { "module:chat_voting:panel": 1, "module:chat_voting:recent": 1 };
    await act(async () => { await reconcileDashboardPanelResourceRevisions(view.queryClient, "fictional-channel"); });
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
