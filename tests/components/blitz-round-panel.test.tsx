import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import BlitzRoundPanel from "../../src/modules/blitz_round/panel";
import { BLITZ_QUESTION_PAGE_SIZE, type BlitzQuestion, type BlitzRoundSettings } from "../../src/modules/blitz_round/contracts";
import { jsonResponse } from "../unit/fixtures";
import { renderWithQuery } from "../query-test-utils";

const initialSettings: BlitzRoundSettings = {
  prize: 50,
  answerTimeSeconds: 60,
  autoStart: false,
  autoStartIntervalMinutes: 15,
  chatTarget: null,
  startText: "Blitz round! {blitz.type}: {blitz.prompt}",
  solvedText: "Correct: {blitz.answer} · {blitz.winners}",
  timeoutText: "Time's up: {blitz.answer}",
};

const sampleQuestion: BlitzQuestion = {
  id: "fictional-question-cloud",
  kind: "scramble",
  prompt: "CLOUD",
  answers: ["CLOUD"],
  enabled: true,
  lastUsedAt: null,
  createdAt: "2030-01-01T12:00:00.000Z",
  updatedAt: "2030-01-01T12:00:00.000Z",
};

const parseUrl = (input: RequestInfo | URL): URL => input instanceof Request
  ? new URL(input.url)
  : input instanceof URL ? input : new URL(input, "https://brobot.example");

const installPanelFetch = (initialQuestions: BlitzQuestion[] = []) => {
  let questions = [...initialQuestions];
  let settings = { ...initialSettings };
  const requests = vi.fn<typeof fetch>((input, init) => {
    const url = parseUrl(input);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "fictional-csrf-token" }));
    if (url.pathname.endsWith("/modules/blitz_round/settings") && method === "GET") return Promise.resolve(jsonResponse({ settings, revision: 1 }));
    if (url.pathname.endsWith("/modules/blitz_round/settings") && method === "PATCH") {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "null") as { settings: BlitzRoundSettings };
      settings = { ...body.settings };
      return Promise.resolve(jsonResponse({ settings, revision: 2 }));
    }
    if (url.pathname.endsWith("/modules/blitz_round/questions") && method === "GET") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const start = (page - 1) * BLITZ_QUESTION_PAGE_SIZE;
      return Promise.resolve(jsonResponse({ questions: questions.slice(start, start + BLITZ_QUESTION_PAGE_SIZE), total: questions.length, page }));
    }
    if (url.pathname.endsWith("/modules/blitz_round/questions") && method === "POST") {
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "null") as Omit<BlitzQuestion, "id" | "lastUsedAt" | "createdAt" | "updatedAt">;
      const created = { ...body, id: "fictional-question-created", lastUsedAt: null, createdAt: "2030-01-01T12:00:00.000Z", updatedAt: "2030-01-01T12:00:00.000Z" };
      questions = [created, ...questions];
      return Promise.resolve(jsonResponse({ question: created }, 201));
    }
    if (url.pathname.includes("/modules/blitz_round/questions/") && method === "PATCH") {
      const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      const body = JSON.parse(typeof init?.body === "string" ? init.body : "null") as Partial<BlitzQuestion>;
      const existing = questions.find((candidate) => candidate.id === id);
      if (existing === undefined) throw new Error("question_missing");
      const updated = { ...existing, ...body };
      questions = questions.map((candidate) => candidate.id === id ? updated : candidate);
      return Promise.resolve(jsonResponse({ question: updated }));
    }
    if (url.pathname.includes("/modules/blitz_round/questions/") && method === "DELETE") {
      const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      questions = questions.filter((candidate) => candidate.id !== id);
      return Promise.resolve(jsonResponse({ removed: true }));
    }
    return Promise.resolve(jsonResponse({ error: "not_found" }, 404));
  });
  vi.stubGlobal("fetch", requests);
  return { requests, getQuestions: () => questions, getSettings: () => settings };
};

const mountPanel = () => renderWithQuery(<UiProvider><BlitzRoundPanel channelId="fictional_channel" language="en" /></UiProvider>);

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
