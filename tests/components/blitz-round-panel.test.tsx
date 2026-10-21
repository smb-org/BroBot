import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { runDashboardNavigationGuards } from "../../src/dashboard/ui/navigation-guard";
import BlitzRoundPanel from "../../src/modules/blitz_round/panel";
import { BLITZ_QUESTION_PAGE_SIZE, type BlitzQuestion, type BlitzQuestionPage, type BlitzRoundSettings } from "../../src/modules/blitz_round/contracts";
import { jsonResponse } from "../unit/fixtures";
import { renderWithQuery } from "../query-test-utils";

const initialSettings: BlitzRoundSettings = {
  prize: 50,
  answerTimeSeconds: 60,
  chatTarget: null,
  startText: "Blitz round! {blitz.type}: {blitz.prompt}",
  solvedText: "Correct: {blitz.answer} · {blitz.winners}",
  timeoutText: "Time's up: {blitz.answer}",
};

const sampleQuestion: BlitzQuestion = {
  id: "fictional-question-cloud",
  revision: 1,
  kind: "scramble",
  prompt: "CLOUD",
  answers: ["CLOUD"],
  enabled: true,
  lastUsedAt: null,
  createdAt: "2030-01-01T12:00:00.000Z",
  updatedAt: "2030-01-01T12:00:00.000Z",
};

const secondQuestion: BlitzQuestion = {
  ...sampleQuestion,
  id: "fictional-question-moon",
  prompt: "MOON",
  answers: ["MOON"],
};

const parseUrl = (input: RequestInfo | URL): URL => input instanceof Request
  ? new URL(input.url)
  : input instanceof URL ? input : new URL(input, "https://brobot.example");

const installPanelFetch = (initialQuestions: BlitzQuestion[] = [], postGate?: Promise<void>, stalePatch = false, settingsConflict = false, patchDeleted = false, settingsPatchGate?: Promise<void>, failQuestionListAfterDelete = false, options: { failPostDeleteQuestionLists?: number; postDeleteQuestionListGate?: Promise<void>; failQuestionPage?: number; failQuestionPageRequests?: number } = {}) => {
  let questions = [...initialQuestions];
  let questionDeleted = false;
  let shouldFailQuestionListAfterDelete = failQuestionListAfterDelete;
  let failedPostDeleteQuestionLists = 0;
  let failedRequestedPageLists = 0;
  let postDeleteQuestionListRequests = 0;
  let finishPostDeleteQuestionList!: () => void;
  const postDeleteQuestionListFinished = new Promise<void>((resolve) => { finishPostDeleteQuestionList = resolve; });
  let settings = { ...initialSettings };
  let settingsRevision = 1;
  let conflictPending = settingsConflict;
  const submittedSettingsRevisions: number[] = [];
  const submittedQuestionRevisions: number[] = [];
  const submittedDeleteRevisions: number[] = [];
  const requests = vi.fn<typeof fetch>((input, init) => {
    const url = parseUrl(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "fictional-csrf-token" }));
    if (url.pathname.endsWith("/modules/blitz_round/settings") && method === "GET") return Promise.resolve(jsonResponse({ settings, revision: settingsRevision }));
    if (url.pathname.endsWith("/modules/blitz_round/settings") && method === "PATCH") {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "null") as { revision: number; settings: BlitzRoundSettings };
      submittedSettingsRevisions.push(body.revision);
      const patch = (): Response => {
        if (conflictPending) {
          conflictPending = false;
          settings = { ...settings, prize: 80 };
          settingsRevision = 2;
          return jsonResponse({ error: "module_settings_changed_concurrently" }, 409);
        }
        if (body.revision !== settingsRevision) return jsonResponse({ error: "module_settings_changed_concurrently" }, 409);
        settings = { ...body.settings };
        settingsRevision += 1;
        return jsonResponse({ settings, revision: settingsRevision });
      };
      return settingsPatchGate === undefined
        ? Promise.resolve(patch())
        : settingsPatchGate.then(patch);
    }
    if (url.pathname.includes("/modules/blitz_round/questions/") && method === "GET") {
      const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      const question = questions.find((candidate) => candidate.id === id);
      return Promise.resolve(question === undefined ? jsonResponse({ error: "question_not_found" }, 404) : jsonResponse({ question }));
    }
    if (url.pathname.endsWith("/modules/blitz_round/questions") && method === "GET") {
      const page = Number(url.searchParams.get("page") ?? "1");
      if (shouldFailQuestionListAfterDelete && questionDeleted) return Promise.resolve(jsonResponse({ error: "question_list_failed" }, 503));
      if (questionDeleted && failedPostDeleteQuestionLists < (options.failPostDeleteQuestionLists ?? 0)) {
        failedPostDeleteQuestionLists += 1;
        return Promise.resolve(jsonResponse({ error: "question_list_failed" }, 503));
      }
      if (page === options.failQuestionPage && failedRequestedPageLists < (options.failQuestionPageRequests ?? 0)) {
        failedRequestedPageLists += 1;
        return Promise.resolve(jsonResponse({ error: "question_list_failed" }, 503));
      }
      const needle = (url.searchParams.get("q") ?? "").trim().toLocaleLowerCase("de-DE");
      const matches = questions.filter((question) => `${question.prompt} ${question.answers.join(" ")}`.toLocaleLowerCase("de-DE").includes(needle));
      const start = (page - 1) * BLITZ_QUESTION_PAGE_SIZE;
      const snapshot = { questions: matches.slice(start, start + BLITZ_QUESTION_PAGE_SIZE), total: matches.length, page };
      const response = (): Response => jsonResponse(snapshot);
      const shouldDelay = questionDeleted && options.postDeleteQuestionListGate !== undefined && postDeleteQuestionListRequests++ === 0;
      if (shouldDelay) {
        const gate = options.postDeleteQuestionListGate;
        if (gate !== undefined) return gate.then(() => { finishPostDeleteQuestionList(); return response(); });
      }
      return Promise.resolve(response());
    }
    if (url.pathname.endsWith("/modules/blitz_round/questions") && method === "POST") {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "null") as Omit<BlitzQuestion, "id" | "revision" | "lastUsedAt" | "createdAt" | "updatedAt">;
      const created = { ...body, id: "fictional-question-created", revision: 1, lastUsedAt: null, createdAt: "2030-01-01T12:00:00.000Z", updatedAt: "2030-01-01T12:00:00.000Z" };
      questions = [created, ...questions];
      return (postGate ?? Promise.resolve()).then(() => jsonResponse({ question: created }, 201));
    }
    if (url.pathname.includes("/modules/blitz_round/questions/") && method === "PATCH") {
      const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "null") as Partial<BlitzQuestion>;
      if (typeof body.revision === "number") submittedQuestionRevisions.push(body.revision);
      const existing = questions.find((candidate) => candidate.id === id);
      if (patchDeleted) {
        questions = questions.filter((candidate) => candidate.id !== id);
        return Promise.resolve(jsonResponse({ error: "question_deleted" }, 409));
      }
      if (existing === undefined) throw new Error("question_missing");
      if (stalePatch) {
        const latest = { ...existing, prompt: "MOON", answers: ["MOON"], revision: existing.revision + 1 };
        questions = questions.map((candidate) => candidate.id === id ? latest : candidate);
        return Promise.resolve(jsonResponse({ error: "question_conflict", current: latest }, 409));
      }
      if (body.revision !== existing.revision) {
        return Promise.resolve(jsonResponse({ error: "question_conflict", current: existing }, 409));
      }
      const updated = { ...existing, ...body, revision: existing.revision + 1 };
      questions = questions.map((candidate) => candidate.id === id ? updated : candidate);
      return Promise.resolve(jsonResponse({ question: updated }));
    }
    if (url.pathname.includes("/modules/blitz_round/questions/") && method === "DELETE") {
      const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      const revision = Number(url.searchParams.get("revision") ?? "0");
      submittedDeleteRevisions.push(revision);
      const existing = questions.find((candidate) => candidate.id === id);
      if (existing === undefined) return Promise.resolve(jsonResponse({ error: "question_not_found" }, 404));
      if (revision !== existing.revision) return Promise.resolve(jsonResponse({ error: "question_conflict", current: existing }, 409));
      questions = questions.filter((candidate) => candidate.id !== id);
      questionDeleted = true;
      return Promise.resolve(jsonResponse({ removed: true }));
    }
    return Promise.resolve(jsonResponse({ error: "not_found" }, 404));
  });
  vi.stubGlobal("fetch", requests);
  return { requests, getQuestions: () => questions, deleteQuestion: (id: string) => { questions = questions.filter((question) => question.id !== id); }, setFailQuestionListAfterDelete: (fails: boolean) => { shouldFailQuestionListAfterDelete = fails; }, getSettings: () => settings, getSettingsRevision: () => settingsRevision, submittedSettingsRevisions, submittedQuestionRevisions, submittedDeleteRevisions, postDeleteQuestionListFinished };
};

const mountPanel = (channelId = "fictional_channel", queryClient?: QueryClient) => renderWithQuery(
  <UiProvider><BlitzRoundPanel channelId={channelId} language="en" /></UiProvider>,
  undefined,
  queryClient === undefined ? undefined : { queryClient },
);

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Blitz Round collection panel", () => {
  it("shows an empty pool hint and a visible create action [protects=empty pools expose exactly one primary create action and explanatory copy; fails_when=the empty state duplicates the create action or omits its hint; no_claim=does not test the persisted D1 seed pool]", async () => {
    installPanelFetch();
    mountPanel();

    expect(await screen.findByText("Add a word scramble or quiz question so chat can join in.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "New question" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: /^Save$/u })).toBeDisabled();
  });

  it("matches umlauts in question search [protects=lowercase umlaut searches return prompts and answers with uppercase umlauts; fails_when=the search drops or miscases the umlaut and hides its match; no_claim=the dashboard request uses an in-memory API stub rather than D1]", async () => {
    const bearQuestion: BlitzQuestion = {
      ...sampleQuestion,
      id: "fictional-question-bear",
      kind: "quiz",
      prompt: "Which animal is a B\u00c4R?",
      answers: ["B\u00c4R"],
    };
    const unrelatedQuestion: BlitzQuestion = { ...secondQuestion, prompt: "MOONLIGHT", answers: ["MOONLIGHT"] };
    const api = installPanelFetch([bearQuestion, unrelatedQuestion]);
    mountPanel();
    await screen.findByRole("button", { name: /Which animal is a B\u00c4R\?/u });
    fireEvent.change(screen.getByRole("textbox", { name: "Search questions" }), { target: { value: "b\u00e4r" } });

    expect(await screen.findByRole("button", { name: /Which animal is a B\u00c4R\?/u })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /MOONLIGHT/u })).not.toBeInTheDocument();
    expect(api.requests.mock.calls.some(([input]) => parseUrl(input as RequestInfo).searchParams.get("q") === "b\u00e4r")).toBe(true);
  });

  it("shows only the word for scramble while preserving the answer slot [protects=scramble has a Word field and no redundant accepted-answer control, with the same reserved answer slot across types; fails_when=the word is labelled Solution, answers remain exposed, or the slot is removed; no_claim=DOM assertions do not measure browser layout]", async () => {
    installPanelFetch([sampleQuestion]);
    mountPanel();
    expect(await screen.findByRole("textbox", { name: "Word" })).toHaveValue("CLOUD");
    expect(screen.queryByRole("textbox", { name: "Accepted answers" })).not.toBeInTheDocument();
    const slot = document.querySelector(".blitz-panel__answers");
    expect(slot).toBeInTheDocument();
    expect(slot).toBeEmptyDOMElement();
    fireEvent.click(screen.getByRole("button", { name: "Quiz" }));
    expect(screen.getByRole("textbox", { name: "Accepted answers" })).toBeInTheDocument();
    expect(document.querySelector(".blitz-panel__answers")).toBe(slot);
  });

  it("shows a field error for an accepted answer that normalizes to empty [protects=punctuation-only quiz answers remain in the accepted-answer field with visible validation feedback; fails_when=the answer is committed without an error or its rejection is shown on another field; no_claim=does not test matching after a round starts]", async () => {
    installPanelFetch([sampleQuestion]);
    mountPanel();
    await screen.findByRole("textbox", { name: "Word" });
    fireEvent.click(screen.getByRole("button", { name: "Quiz" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Question" }), { target: { value: "Which star?" } });
    const answers = screen.getByRole("textbox", { name: "Accepted answers" });
    fireEvent.change(answers, { target: { value: "?" } });
    fireEvent.keyDown(answers, { key: "Enter" });

    expect(answers).toHaveValue("?");
    expect(within(screen.getByRole("group", { name: "Accepted answers" })).getByRole("alert"))
      .toHaveTextContent("Each answer must contain 1 to 60 characters and be unique.");
  });

  it("keeps question edits local until explicit save [protects=type, prompt, answers and enabled state save together; fails_when=edits are posted before Save or an invalid draft is accepted; no_claim=does not test authorization guards on the route]", async () => {
    const api = installPanelFetch([sampleQuestion]);
    mountPanel();
    await screen.findByRole("button", { name: /Word scramble.*CLOUD/u });

    fireEvent.click(screen.getByRole("button", { name: "New question" }));
    fireEvent.click(screen.getByRole("button", { name: /^Quiz$/u }));
    fireEvent.change(screen.getByRole("textbox", { name: "Question" }), { target: { value: "Which star is closest?" } });
    const answers = screen.getByRole("textbox", { name: "Accepted answers" });
    fireEvent.change(answers, { target: { value: "Sun" } });
    fireEvent.keyDown(answers, { key: "Enter" });
    expect(api.requests.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /^Save$/u }));
    await waitFor(() => expect(api.getQuestions().some((entry) => entry.prompt === "Which star is closest?")).toBe(true));
    expect(api.getQuestions().find((entry) => entry.prompt === "Which star is closest?")?.answers).toEqual(["Sun"]);
  });

  it("saves a new question before completing guarded navigation to settings [protects=New question to edit to Settings to Save persists and then opens Settings; fails_when=the editor remount clears the draft guard before its pending navigation completes; no_claim=HTTP is mocked and does not verify production authentication]", async () => {
    const api = installPanelFetch();
    mountPanel();
    await screen.findByText("Add a word scramble or quiz question so chat can join in.");

    fireEvent.click(screen.getByRole("button", { name: "New question" }));
    fireEvent.click(screen.getByRole("button", { name: "Quiz" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Question" }), { target: { value: "Which star is closest?" } });
    const answers = screen.getByRole("textbox", { name: "Accepted answers" });
    fireEvent.change(answers, { target: { value: "Sun" } });
    fireEvent.keyDown(answers, { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    const guard = await screen.findByRole("dialog", { name: "Save changes?" });
    fireEvent.click(within(guard).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(api.getQuestions().some((entry) => entry.prompt === "Which star is closest?")).toBe(true));
    expect(await screen.findByText("Round settings", { exact: true })).toBeInTheDocument();
  });

  it("locks settings confirmation during a delayed PATCH and shares its save [protects=Save-and-switch keeps Discard disabled while the settings PATCH is pending and repeated Save clicks issue one request; fails_when=Discard navigates away during the pending write or two PATCH requests race; no_claim=the delayed PATCH is an in-memory HTTP stub and does not test network cancellation]", async () => {
    let releasePatch!: () => void;
    const patchGate = new Promise<void>((resolve) => { releasePatch = resolve; });
    const api = installPanelFetch([], undefined, false, false, false, patchGate);
    mountPanel();
    await screen.findByText("Add a word scramble or quiz question so chat can join in.");
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByText("Round settings", { exact: true });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Prize" }), { target: { value: "75" } });
    const settingsBack = screen.getAllByRole("button", { name: "Back to questions" }).at(-1);
    if (settingsBack === undefined) throw new Error("The settings back button was not found.");
    fireEvent.click(settingsBack);
    const guard = await screen.findByRole("dialog", { name: "Save changes?" });
    const save = within(guard).getByRole("button", { name: /^Save$/u });
    act(() => {
      fireEvent.click(save);
      fireEvent.click(save);
    });
    await waitFor(() => expect(api.requests.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1));

    const discard = within(guard).getByRole("button", { name: "Discard" });
    expect(discard).toBeDisabled();
    discard.click();
    expect(screen.getByRole("dialog", { name: "Save changes?" })).toBeInTheDocument();
    expect(api.getSettings().prize).toBe(50);

    act(() => { releasePatch(); });
    await waitFor(() => expect(api.getSettings().prize).toBe(75));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Save changes?" })).not.toBeInTheDocument());
    expect(api.requests.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  });

  it("guards dashboard navigation while a question draft is unsaved [protects=dashboard navigation waits for question draft confirmation and the editor unregisters its guard on unmount; fails_when=the dashboard proceeds without confirmation or a removed editor still intercepts navigation; no_claim=the route transition is exercised through the production navigation guard registry]", async () => {
    installPanelFetch([sampleQuestion]);
    const view = mountPanel();
    await screen.findByRole("textbox", { name: "Word" });
    fireEvent.change(screen.getByRole("textbox", { name: "Word" }), { target: { value: "STONE" } });

    let navigations = 0;
    const navigate = (): void => { navigations += 1; };
    act(() => { runDashboardNavigationGuards(navigate, () => undefined); });
    expect(navigations).toBe(0);
    const confirmation = await screen.findByRole("dialog", { name: "Save changes?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Keep editing" }));
    expect(navigations).toBe(0);
    expect(screen.getByRole("textbox", { name: "Word" })).toHaveValue("STONE");

    act(() => { runDashboardNavigationGuards(navigate, () => undefined); });
    fireEvent.click(within(screen.getByRole("dialog", { name: "Save changes?" })).getByRole("button", { name: "Discard" }));
    expect(navigations).toBe(1);
    expect(screen.getByRole("textbox", { name: "Word" })).toHaveValue("CLOUD");

    view.unmount();
    act(() => { runDashboardNavigationGuards(navigate, () => undefined); });
    expect(navigations).toBe(2);
  });

  it("guards dashboard navigation while settings are unsaved [protects=dashboard navigation waits for settings draft confirmation and the editor unregisters its guard on unmount; fails_when=the dashboard proceeds without confirmation or a removed settings editor still intercepts navigation; no_claim=the route transition is exercised through the production navigation guard registry]", async () => {
    installPanelFetch([sampleQuestion]);
    const view = mountPanel();
    await screen.findByRole("button", { name: /Word scramble.*CLOUD/u });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const prize = await screen.findByRole("spinbutton", { name: "Prize" });
    fireEvent.change(prize, { target: { value: "75" } });

    let navigations = 0;
    const navigate = (): void => { navigations += 1; };
    act(() => { runDashboardNavigationGuards(navigate, () => undefined); });
    expect(navigations).toBe(0);
    const confirmation = await screen.findByRole("dialog", { name: "Save changes?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Keep editing" }));
    expect(navigations).toBe(0);
    expect(screen.getByRole("spinbutton", { name: "Prize" })).toHaveValue(75);

    act(() => { runDashboardNavigationGuards(navigate, () => undefined); });
    fireEvent.click(within(screen.getByRole("dialog", { name: "Save changes?" })).getByRole("button", { name: "Discard" }));
    expect(navigations).toBe(1);
    expect(screen.getByRole("spinbutton", { name: "Prize" })).toHaveValue(50);

    view.unmount();
    act(() => { runDashboardNavigationGuards(navigate, () => undefined); });
    expect(navigations).toBe(2);
  });

  it("keeps a requested existing question selected after saving another question [protects=save-and-switch finishes on the requested existing destination; fails_when=the saved question overrides the pending destination; no_claim=HTTP is mocked and does not verify production authentication]", async () => {
    installPanelFetch([sampleQuestion, secondQuestion]);
    mountPanel();
    await screen.findByRole("button", { name: /Word scramble.*CLOUD/u });

    fireEvent.change(screen.getByRole("textbox", { name: "Word" }), { target: { value: "STONE" } });
    fireEvent.click(screen.getByRole("button", { name: /Word scramble.*MOON/u }));
    const guard = await screen.findByRole("dialog", { name: "Save changes?" });
    fireEvent.click(within(guard).getByRole("button", { name: "Save" }));

    const requestedQuestion = await screen.findByRole("button", { name: /Word scramble.*MOON/u });
    await waitFor(() => expect(requestedQuestion).toHaveAttribute("aria-current", "true"));
    expect(screen.getByRole("textbox", { name: "Word" })).toHaveValue("MOON");
  });

  it("keeps an existing question selected after saving a new question [protects=save-and-switch from a new draft finishes on the requested existing destination; fails_when=the newly saved question replaces the pending destination; no_claim=HTTP is mocked and does not verify production authentication]", async () => {
    installPanelFetch([sampleQuestion]);
    mountPanel();
    await screen.findByRole("button", { name: /Word scramble.*CLOUD/u });

    fireEvent.click(screen.getByRole("button", { name: "New question" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Word" }), { target: { value: "STONE" } });
    fireEvent.click(screen.getByRole("button", { name: /Word scramble.*CLOUD/u }));
    const guard = await screen.findByRole("dialog", { name: "Save changes?" });
    fireEvent.click(within(guard).getByRole("button", { name: "Save" }));

    const requestedQuestion = await screen.findByRole("button", { name: /Word scramble.*CLOUD/u });
    await waitFor(() => expect(requestedQuestion).toHaveAttribute("aria-current", "true"));
    expect(screen.getByRole("textbox", { name: "Word" })).toHaveValue("CLOUD");
  });

  it("reselects the initially selected question without restoring its stale revision [protects=clicking the initially selected row with its detail closed keeps the editor draft and later saves use revisions 1 then 2; fails_when=the row click queues its captured snapshot so the next PATCH reuses revision 1; no_claim=question responses use an in-memory HTTP stub and do not verify production authentication or D1 isolation]", async () => {
    const api = installPanelFetch([sampleQuestion]);
    mountPanel();
    const selectedRow = await screen.findByRole("button", { name: /Word scramble.*CLOUD/u });
    fireEvent.change(screen.getByRole("textbox", { name: "Word" }), { target: { value: "STORM" } });
    fireEvent.click(selectedRow);
    const reselectOpenedSaveGuard = screen.queryByRole("dialog", { name: "Save changes?" }) !== null;

    const firstGuard = screen.queryByRole("dialog", { name: "Save changes?" });
    if (firstGuard === null) fireEvent.click(screen.getByRole("button", { name: /^Save$/u }));
    else fireEvent.click(within(firstGuard).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(api.submittedQuestionRevisions).toHaveLength(1));

    fireEvent.change(screen.getByRole("textbox", { name: "Word" }), { target: { value: "RIVER" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/u }));

    await waitFor(() => expect(api.submittedQuestionRevisions).toHaveLength(2));
    expect(api.submittedQuestionRevisions).toEqual([1, 2]);
    expect(reselectOpenedSaveGuard).toBe(false);
    expect(document.querySelector(".collection-page__detail .page-header__title-row")?.textContent).toContain("RIVER");
  });

  it("sends one create when Save is clicked twice in the unsaved-changes dialog [protects=an in-flight save-and-switch cannot re-enter question creation; fails_when=two POST requests create duplicate questions; no_claim=the HTTP response is held in memory and production request retries are not exercised]", async () => {
    let releasePost!: () => void;
    const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
    const api = installPanelFetch([], postGate);
    mountPanel();
    await screen.findByText("Add a word scramble or quiz question so chat can join in.");

    fireEvent.click(screen.getByRole("button", { name: "New question" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Word" }), { target: { value: "STONE" } });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const guard = await screen.findByRole("dialog", { name: "Save changes?" });
    const save = within(guard).getByRole("button", { name: "Save" });
    act(() => {
      fireEvent.click(save);
      fireEvent.click(save);
    });

    expect(save).toBeDisabled();
    await waitFor(() => expect(api.requests.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(api.requests.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
    releasePost();
    expect(await screen.findByText("Round settings", { exact: true })).toBeInTheDocument();
  });

  it("keeps a conflicted question draft until the manager chooses reload [protects=stale edits show the fixed save-bar reload action without replacing local text; fails_when=the failed save loses the draft or offers no reload at the fixed save area; no_claim=the simulated conflict uses a local HTTP stub and does not verify D1 transaction isolation]", async () => {
    const api = installPanelFetch([sampleQuestion], undefined, true);
    mountPanel();
    await screen.findByRole("button", { name: /Word scramble.*CLOUD/u });
    const field = screen.getByRole("textbox", { name: "Word" });
    fireEvent.change(field, { target: { value: "STONE" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("This question changed while you were editing it. Reload the saved version before continuing.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Word" })).toHaveValue("STONE");
    expect(screen.getByRole("button", { name: "Reload question" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload question" }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Word" })).toHaveValue("MOON"));
    expect(api.getQuestions()[0]?.revision).toBe(2);
  });

  it("recovers a deleted question after conflict reload and keeps the draft [protects=a 404 during conflict reload enters save-as-new recovery with the typed draft intact; fails_when=reload treats question_not_found as a generic load error or removes the draft recovery choices; no_claim=the manager deletion is simulated by the component HTTP stub and does not exercise concurrent D1 writes]", async () => {
    const api = installPanelFetch([sampleQuestion], undefined, true);
    mountPanel();
    await screen.findByRole("button", { name: /Word scramble.*CLOUD/u });
    fireEvent.change(screen.getByRole("textbox", { name: "Word" }), { target: { value: "STONE" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("This question changed while you were editing it. Reload the saved version before continuing.");

    api.deleteQuestion(sampleQuestion.id);
    fireEvent.click(screen.getByRole("button", { name: "Reload question" }));

    expect(await screen.findByText("This question was deleted elsewhere. Save your draft as a new question or discard it.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Word" })).toHaveValue("STONE");
    expect(screen.getByRole("button", { name: "Save as new question" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save as new question" }));

    await waitFor(() => expect(api.getQuestions().some((question) => question.prompt === "STONE")).toBe(true));
  });

  it("reloads a conflicted question by id when it falls beyond the first page [protects=question conflict recovery fetches the selected entity independently of pagination; fails_when=reload searches only page one and leaves a stale draft that cannot continue; no_claim=the paginated question list and HTTP responses use an in-memory stub]", async () => {
    const questions = Array.from({ length: 26 }, (_, index): BlitzQuestion => ({
      ...sampleQuestion,
      id: `fictional-question-${String(index + 1).padStart(2, "0")}`,
      kind: "quiz",
      prompt: `Which planet is number ${String(index + 1)}?`,
      answers: ["Saturn"],
    }));
    const api = installPanelFetch(questions, undefined, true);
    mountPanel();
    await screen.findByRole("button", { name: /Which planet is number 1\?/u });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await screen.findByRole("button", { name: /Which planet is number 26\?/u });
    fireEvent.click(screen.getByRole("button", { name: /Which planet is number 26\?/u }));
    fireEvent.change(screen.getByRole("textbox", { name: "Question" }), { target: { value: "Which planet has rings?" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByText("This question changed while you were editing it. Reload the saved version before continuing.");

    fireEvent.click(screen.getByRole("button", { name: "Reload question" }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Question" })).toHaveValue("MOON"));
    expect(api.requests.mock.calls.some(([input]) => parseUrl(input as RequestInfo).pathname.endsWith("/fictional-question-26"))).toBe(true);
  });

  it("starts a clean draft after saving while switching to New question [protects=each new-question session has independent editor state; fails_when=the New question editor key is reused and shows the just-saved draft; no_claim=the create request is served by an in-memory HTTP stub]", async () => {
    installPanelFetch();
    mountPanel();
    await screen.findByText("Add a word scramble or quiz question so chat can join in.");
    fireEvent.click(screen.getByRole("button", { name: "New question" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Word" }), { target: { value: "STONE" } });
    fireEvent.click(screen.getByRole("button", { name: "New question" }));
    const guard = await screen.findByRole("dialog", { name: "Save changes?" });
    fireEvent.click(within(guard).getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Save changes?" })).not.toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "Word" })).toHaveValue("");
  });

  it("keeps settings drafts through a conflict and saves with the reloaded revision [protects=the settings conflict choice preserves local edits and reload adopts the latest server revision; fails_when=conflict hides recovery, discards the draft, or retries with the stale revision; no_claim=concurrent saves are simulated by an in-memory HTTP stub]", async () => {
    const api = installPanelFetch([sampleQuestion], undefined, false, true);
    mountPanel();
    await screen.findByRole("button", { name: /Word scramble.*CLOUD/u });
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const prize = await screen.findByRole("spinbutton", { name: "Prize" });
    fireEvent.change(prize, { target: { value: "75" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/u }));

    expect(await screen.findByText("Round settings changed elsewhere. Load the saved version before continuing.")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Prize" })).toHaveValue(75);
    fireEvent.click(screen.getByRole("button", { name: "Load server settings" }));
    await waitFor(() => expect(screen.getByRole("spinbutton", { name: "Prize" })).toHaveValue(80));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Prize" }), { target: { value: "90" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/u }));

    await waitFor(() => expect(api.getSettings().prize).toBe(90));
    expect(api.submittedSettingsRevisions).toEqual([1, 2]);
    expect(api.getSettingsRevision()).toBe(3);
  });

  it("offers save as new when the edited question was deleted elsewhere [protects=deleted question conflicts retain the draft and expose fixed-place save-as-new and discard choices; fails_when=PATCH deletion shows only a generic error or loses the draft; no_claim=deletion and recreation are simulated by an in-memory HTTP stub]", async () => {
    const api = installPanelFetch([sampleQuestion], undefined, false, false, true);
    mountPanel();
    await screen.findByRole("button", { name: /Word scramble.*CLOUD/u });
    fireEvent.change(screen.getByRole("textbox", { name: "Word" }), { target: { value: "STONE" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("This question was deleted elsewhere. Save your draft as a new question or discard it.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Word" })).toHaveValue("STONE");
    expect(screen.getByRole("button", { name: "Save as new question" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save as new question" }));

    await waitFor(() => expect(api.getQuestions().some((question) => question.prompt === "STONE")).toBe(true));
  });

  it("selects the first remaining question after deleting the only item on the last page [protects=deleting question 26 from a 26-question pool clamps to page 1 and selects its first question; fails_when=the panel remains on invalid page 2 or shows an empty detail; no_claim=the paginated repository is mocked]", async () => {
    const questions = Array.from({ length: 26 }, (_, index): BlitzQuestion => ({
      ...sampleQuestion,
      id: `fictional-question-${String(index + 1).padStart(2, "0")}`,
      kind: "quiz",
      prompt: `Which planet is number ${String(index + 1)}?`,
      answers: ["Saturn"],
    }));
    const api = installPanelFetch(questions);
    mountPanel();
    await screen.findByRole("button", { name: /Which planet is number 1\?/u });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    const lastQuestion = await screen.findByRole("button", { name: /Which planet is number 26\?/u });
    fireEvent.click(lastQuestion);
    fireEvent.click(document.querySelector(".page-header__overflow-trigger") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirmation = await screen.findByRole("dialog", { name: "Delete this question?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(screen.getByText("Page 1 of 1")).toBeInTheDocument());
    const firstQuestion = await screen.findByRole("button", { name: /Which planet is number 1\?/u });
    expect(firstQuestion).toHaveAttribute("aria-current", "true");
    expect(api.getQuestions()).toHaveLength(25);
  });

  it("keeps a committed deletion hidden while cached list data awaits retry [protects=a successful DELETE filters the deleted row from view, selects a remaining question, and shows the list error with retry while cached list data stays untouched; fails_when=the deleted row remains visible or cache contents are manually edited; no_claim=HTTP responses use an in-memory stub and do not verify production authentication or database behavior]", async () => {
    const api = installPanelFetch([sampleQuestion, secondQuestion], undefined, false, false, false, undefined, true);
    const view = mountPanel();
    await screen.findByRole("button", { name: /Word scramble.*CLOUD/u });
    view.queryClient.setQueryData(["channel", "fictional_channel", "module", "blitz_round", "questions:1:cloud"], {
      questions: [sampleQuestion], total: 1, page: 1,
    } satisfies BlitzQuestionPage);

    fireEvent.click(document.querySelector(".page-header__overflow-trigger") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirmation = await screen.findByRole("dialog", { name: "Delete this question?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("The question pool could not be loaded.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
    expect(api.getQuestions()).toEqual([secondQuestion]);
    expect(screen.getByRole("textbox", { name: "Word" })).toHaveValue("MOON");
    expect(screen.queryByRole("button", { name: /Word scramble.*CLOUD/u })).not.toBeInTheDocument();
    const cachedLists = view.queryClient.getQueryCache().findAll({
      predicate: (query) => query.queryKey[0] === "channel" && query.queryKey[1] === "fictional_channel" &&
        query.queryKey[2] === "module" && query.queryKey[3] === "blitz_round" &&
        typeof query.queryKey[4] === "string" && query.queryKey[4].startsWith("questions:"),
    });
    expect(cachedLists.some((query) => view.queryClient.getQueryData<BlitzQuestionPage>(query.queryKey)?.questions.some((question) => question.id === sampleQuestion.id))).toBe(true);

    api.setFailQuestionListAfterDelete(false);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Word" })).toHaveValue("MOON"));
  });

  it("keeps a deleted question excluded across a failed refresh and panel remount [protects=after deleting A with a failed refresh, remounting against the warm cache selects B and a successful refetch leaves B in the editor; fails_when=A is selected again after remount or remains in the editor after refetch; no_claim=the paginated cache and API responses use an in-memory HTTP stub]", async () => {
    const channelId = "blitz_deleted_remount_channel";
    const api = installPanelFetch([sampleQuestion, secondQuestion], undefined, false, false, false, undefined, true);
    const firstMount = mountPanel(channelId);
    await screen.findByRole("textbox", { name: "Word" });

    fireEvent.click(document.querySelector(".page-header__overflow-trigger") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirmation = await screen.findByRole("dialog", { name: "Delete this question?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("The question pool could not be loaded.")).toBeInTheDocument();
    expect(api.getQuestions()).toEqual([secondQuestion]);

    firstMount.unmount();
    const remount = mountPanel(channelId, firstMount.queryClient);
    await screen.findByRole("button", { name: "Reload" });
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Word" })).toHaveValue("MOON"));

    api.setFailQuestionListAfterDelete(false);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(remount.queryClient.getQueryData<BlitzQuestionPage>([
      "channel", channelId, "module", "blitz_round", "questions:1:",
    ])?.questions).toEqual([secondQuestion]));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Word" })).toHaveValue("MOON"));
    expect(screen.queryByRole("button", { name: /Word scramble.*CLOUD/u })).not.toBeInTheDocument();
    remount.unmount();
  });

  it("shows recovery and keeps previous-page navigation after an uncached page fails [protects=with 26 questions, a failed first request for page 2 shows Reload while Previous stays enabled and can return to page 1; fails_when=page 1 silently replaces the failed request and hides Reload or disables Previous; no_claim=the paginated API and one failed page response use an in-memory HTTP stub]", async () => {
    const questions = Array.from({ length: 26 }, (_, index): BlitzQuestion => ({
      ...sampleQuestion,
      id: `fictional-question-${String(index + 1).padStart(2, "0")}`,
      kind: "quiz",
      prompt: `Which planet is number ${String(index + 1)}?`,
      answers: ["Saturn"],
    }));
    installPanelFetch(questions, undefined, false, false, false, undefined, false, {
      failQuestionPage: 2,
      failQuestionPageRequests: 1,
    });
    mountPanel();
    await screen.findByRole("button", { name: /Which planet is number 1\?/u });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    expect(await screen.findByText("The question pool could not be loaded.")).toBeInTheDocument();
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await screen.findByRole("button", { name: /Which planet is number 26\?/u });
    fireEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(await screen.findByText("Page 1 of 2")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /Which planet is number 1\?/u })).toBeInTheDocument();
  });

  it("keeps a saved question revision after a delayed delete refresh [protects=deleting A, saving B during its delayed list refresh, and reselecting B preserves B's saved contents and revision; fails_when=the delayed response overwrites B's revision so the next save conflicts; no_claim=the stale response and successful writes are simulated by an in-memory HTTP stub]", async () => {
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const thirdQuestion: BlitzQuestion = { ...sampleQuestion, id: "fictional-question-stone", prompt: "STONE", answers: ["STONE"] };
    const api = installPanelFetch([sampleQuestion, secondQuestion, thirdQuestion], undefined, false, false, false, undefined, false, {
      postDeleteQuestionListGate: refreshGate,
    });
    const view = mountPanel();
    await screen.findByRole("button", { name: /Word scramble.*CLOUD/u });

    fireEvent.click(document.querySelector(".page-header__overflow-trigger") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirmation = await screen.findByRole("dialog", { name: "Delete this question?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Delete" }));

    try {
      await waitFor(() => expect(api.getQuestions()).toHaveLength(2));
      await waitFor(() => expect(api.requests.mock.calls.filter(([input, init]) => {
        const url = parseUrl(input);
        return url.pathname.endsWith("/modules/blitz_round/questions") && (init?.method ?? "GET") === "GET";
      })).toHaveLength(2));
      fireEvent.change(screen.getByRole("textbox", { name: "Word" }), { target: { value: "STORM" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => expect(api.getQuestions().find((question) => question.id === secondQuestion.id)).toMatchObject({ prompt: "STORM", revision: 2 }));

      await act(async () => { releaseRefresh(); await api.postDeleteQuestionListFinished; });
      await waitFor(() => expect(view.queryClient.isFetching()).toBe(0));
      fireEvent.click(screen.getByRole("button", { name: /Word scramble.*STONE/u }));
      fireEvent.click(screen.getByRole("button", { name: /Word scramble.*(?:MOON|STORM)/u }));
      expect(screen.getByRole("textbox", { name: "Word" })).toHaveValue("STORM");
      fireEvent.change(screen.getByRole("textbox", { name: "Word" }), { target: { value: "RIVER" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => expect(api.getQuestions().find((question) => question.id === secondQuestion.id)).toMatchObject({ prompt: "RIVER", revision: 3 }));
      expect(api.submittedQuestionRevisions).toEqual([1, 2]);
    } finally {
      act(() => { releaseRefresh(); });
    }
  });

  it("keeps a newer selection and draft when the post-delete refresh finishes [protects=deleting A then selecting and editing C during a delayed refresh leaves C selected with its draft; fails_when=the stale delete refresh selects B or replaces C's draft; no_claim=the delayed list response is simulated by an in-memory HTTP stub]", async () => {
    let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const thirdQuestion: BlitzQuestion = { ...sampleQuestion, id: "fictional-question-stone", prompt: "STONE", answers: ["STONE"] };
    const api = installPanelFetch([sampleQuestion, secondQuestion, thirdQuestion], undefined, false, false, false, undefined, false, {
      postDeleteQuestionListGate: refreshGate,
    });
    mountPanel();
    await screen.findByRole("button", { name: /Word scramble.*CLOUD/u });

    fireEvent.click(document.querySelector(".page-header__overflow-trigger") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirmation = await screen.findByRole("dialog", { name: "Delete this question?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Delete" }));

    try {
      await waitFor(() => expect(api.getQuestions()).toHaveLength(2));
      await waitFor(() => expect(api.requests.mock.calls.filter(([input, init]) => {
        const url = parseUrl(input);
        return url.pathname.endsWith("/modules/blitz_round/questions") && (init?.method ?? "GET") === "GET";
      })).toHaveLength(2));
      fireEvent.click(screen.getByRole("button", { name: /Word scramble.*STONE/u }));
      fireEvent.change(screen.getByRole("textbox", { name: "Word" }), { target: { value: "STORM" } });
      act(() => { releaseRefresh(); });

      await waitFor(() => expect(screen.getByRole("button", { name: /Word scramble.*STONE/u })).toHaveAttribute("aria-current", "true"));
      expect(screen.getByRole("textbox", { name: "Word" })).toHaveValue("STORM");
    } finally {
      act(() => { releaseRefresh(); });
    }
  });

  it("clamps to the remaining page when retrying a failed delete refresh [protects=after deleting question 26 and one failed page-2 refresh, a successful retry derives page 1 and loads the remaining questions; fails_when=retry leaves the panel on an invalid page after refreshed data reports one page; no_claim=the paginated repository is simulated by an in-memory HTTP stub]", async () => {
    const questions = Array.from({ length: 26 }, (_, index): BlitzQuestion => ({
      ...sampleQuestion,
      id: `fictional-question-${String(index + 1).padStart(2, "0")}`,
      kind: "quiz",
      prompt: `Which planet is number ${String(index + 1)}?`,
      answers: ["Saturn"],
    }));
    const api = installPanelFetch(questions, undefined, false, false, false, undefined, false, { failPostDeleteQuestionLists: 1 });
    mountPanel();
    await screen.findByRole("button", { name: /Which planet is number 1\?/u });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(await screen.findByRole("button", { name: /Which planet is number 26\?/u }));
    fireEvent.click(document.querySelector(".page-header__overflow-trigger") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirmation = await screen.findByRole("dialog", { name: "Delete this question?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("The question pool could not be loaded.")).toBeInTheDocument();
    expect(screen.getByText("Page 2 of 2")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));

    await waitFor(() => expect(screen.getByText("Page 1 of 1")).toBeInTheDocument());
    expect(await screen.findByRole("button", { name: /Which planet is number 1\?/u })).toHaveAttribute("aria-current", "true");
    expect(api.getQuestions()).toHaveLength(25);
  });

  it("keeps a new draft while a failed last-page delete refresh retries and derives page one [protects=after deleting question 26, editing the generated new-question draft, and retrying a failed refresh, the panel shows page 1 of 1 with 25 rows and retains the draft; fails_when=retry leaves page 2 of 1 empty or replaces the draft; no_claim=the paginated API and failed response are simulated by an in-memory HTTP stub]", async () => {
    const questions = Array.from({ length: 26 }, (_, index): BlitzQuestion => ({
      ...sampleQuestion,
      id: `fictional-question-${String(index + 1).padStart(2, "0")}`,
      kind: "quiz",
      prompt: `Which planet is number ${String(index + 1)}?`,
      answers: ["Saturn"],
    }));
    const api = installPanelFetch(questions, undefined, false, false, false, undefined, false, { failPostDeleteQuestionLists: 1 });
    mountPanel();
    await screen.findByRole("button", { name: /Which planet is number 1\?/u });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(await screen.findByRole("button", { name: /Which planet is number 26\?/u }));
    fireEvent.click(document.querySelector(".page-header__overflow-trigger") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const confirmation = await screen.findByRole("dialog", { name: "Delete this question?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Delete" }));

    expect(await screen.findByText("The question pool could not be loaded.")).toBeInTheDocument();
    const draft = screen.getByRole("textbox", { name: "Word" });
    fireEvent.change(draft, { target: { value: "STERN" } });
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));

    await waitFor(() => expect(screen.getByText("Page 1 of 1")).toBeInTheDocument());
    expect(screen.getByRole("textbox", { name: "Word" })).toHaveValue("STERN");
    expect(screen.getAllByRole("button", { name: /Which planet is number/u })).toHaveLength(25);
    expect(api.getQuestions()).toHaveLength(25);
  });

  it("keeps delete intent through saving a question draft [protects=edit existing question to Delete to Save opens confirmation for the saved revision and confirming deletes it; fails_when=the revision-keyed editor remount drops the pending delete or DELETE uses a stale revision; no_claim=the component uses an in-memory HTTP stub and does not verify production authentication or D1 isolation]", async () => {
    const api = installPanelFetch([sampleQuestion]);
    mountPanel();
    await screen.findByRole("textbox", { name: "Word" });
    fireEvent.change(screen.getByRole("textbox", { name: "Word" }), { target: { value: "STORM" } });
    fireEvent.click(document.querySelector(".page-header__overflow-trigger") as HTMLButtonElement);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    const saveGuard = await screen.findByRole("dialog", { name: "Save changes?" });
    fireEvent.click(within(saveGuard).getByRole("button", { name: "Save" }));

    const deleteConfirmation = await screen.findByRole("dialog", { name: "Delete this question?" });
    expect(document.querySelector(".blitz-panel__detail input")).toHaveValue("STORM");
    expect(api.getQuestions()[0]).toMatchObject({ id: sampleQuestion.id, prompt: "STORM", revision: 2 });
    fireEvent.click(within(deleteConfirmation).getByRole("button", { name: "Delete" }));

    await waitFor(() => expect(api.getQuestions()).toHaveLength(0));
    expect(api.submittedQuestionRevisions).toEqual([1]);
    expect(api.submittedDeleteRevisions).toEqual([2]);
  });

  it("shows the scramble limit while keeping quiz prompts at 120 characters [protects=scramble word field uses a 16-character limit and quiz prompt uses 120; fails_when=the scramble field advertises a limit its validator rejects; no_claim=does not measure translated glyph widths]", async () => {
    installPanelFetch([sampleQuestion]);
    mountPanel();
    const word = await screen.findByRole("textbox", { name: "Word" });
    expect((word as HTMLInputElement).value).toBe("CLOUD");
    expect(screen.getByText("5 / 16")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Quiz" }));
    const prompt = screen.getByRole("textbox", { name: "Question" });
    expect((prompt as HTMLInputElement).value).toBe("CLOUD");
    expect(screen.getByText("5 / 120")).toBeTruthy();
  });

  it("shows round settings in the detail area and saves them explicitly [protects=prize settings remain drafts until the settings save action; fails_when=settings mutate without Save or the saved revision is not refreshed; no_claim=does not test alarm scheduling after the D1 write]", async () => {
    const api = installPanelFetch([sampleQuestion]);
    mountPanel();
    await screen.findByRole("button", { name: /Word scramble.*CLOUD/u });
    fireEvent.click(screen.getByRole("button", { name: /^Settings$/u }));
    expect(await screen.findByText("Round settings", { exact: true })).toBeInTheDocument();

    fireEvent.change(screen.getByRole("spinbutton", { name: "Prize" }), { target: { value: "75" } });
    expect(api.getSettings().prize).toBe(50);
    fireEvent.click(screen.getByRole("button", { name: /^Save$/u }));
    await waitFor(() => expect(api.getSettings().prize).toBe(75));
    await waitFor(() => expect(document.querySelector(".ui-save-bar__status")).toHaveTextContent("Saved"));
  });
});
