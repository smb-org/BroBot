import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import QuizPanel from "../../src/modules/quiz/panel";
import { moduleQueryKey } from "../../src/dashboard/data";
import { UiProvider } from "../../src/dashboard/ui";
import { runDashboardNavigationGuards } from "../../src/dashboard/ui/navigation-guard";
import type { QuizSet } from "../../src/modules/quiz/contracts";
import { renderWithQuery } from "../query-test-utils";

const set: QuizSet = { id: "fictional-set", name: "Space", revision: 1, createdAt: "2030-01-01", updatedAt: "2030-01-01", questions: [] };
const otherSet: QuizSet = { id: "other-set", name: "Ocean", revision: 1, createdAt: "2030-01-02", updatedAt: "2030-01-02", questions: [] };

const response = (body: unknown, status = 200): Promise<Response> => Promise.resolve(Response.json(body, { status }));
const deferred = <Value,>() => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((complete) => { resolve = complete; });
  return { promise, resolve };
};
const requestBody = (init: RequestInit | undefined): Record<string, unknown> => {
  if (typeof init?.body !== "string") return {};
  const parsed: unknown = JSON.parse(init.body);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
};

const installFetch = (options: {
  existing?: boolean;
  includeOtherSet?: boolean;
  holdCreate?: boolean;
  holdUpdatedRead?: boolean;
  holdConflictReload?: boolean;
  conflictThenFailReload?: boolean;
  conflictThenRemoteReload?: boolean;
} = {}) => {
  const savedSets = new Map<string, QuizSet>();
  if (options.existing) savedSets.set(set.id, structuredClone(set));
  if (options.includeOtherSet) savedSets.set(otherSet.id, structuredClone(otherSet));
  const writes: unknown[] = [];
  let conflicted = false;
  let conflictReads = 0;
  let failedReads = 0;
  const createStarted = deferred<undefined>();
  const heldCreate = deferred<Response>();
  const conflictReloadStarted = deferred<undefined>();
  const heldConflictReload = deferred<Response>();
  const updatedReadStarted = deferred<undefined>();
  const heldUpdatedRead = deferred<Response>();
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? new URL(input.url) : input instanceof URL ? input : new URL(input, window.location.href);
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/csrf") return response({ token: "fictional-token" });
    if (url.pathname.endsWith("/modules/quiz/sets") && method === "GET") {
      const sets = [...savedSets.values()];
      return response({
        sets: sets.map(({ id, name, revision, questions, createdAt, updatedAt }) => ({
          id, name, revision, questionCount: questions.length, createdAt, updatedAt,
        })),
        total: sets.length,
        page: 1,
      });
    }
    if (url.pathname.endsWith("/modules/quiz/sets") && method === "POST") {
      const body = requestBody(init);
      const created = { ...set, id: options.existing ? "created-set" : set.id, name: typeof body.name === "string" ? body.name : set.name };
      if (options.holdCreate) {
        createStarted.resolve(undefined);
        return heldCreate.promise.then((result) => {
          savedSets.set(created.id, created);
          return result;
        });
      }
      savedSets.set(created.id, created);
      return response({ set: created }, 201);
    }
    const detailSetId = url.pathname.split("/").at(-1) ?? "";
    if (url.pathname.includes("/modules/quiz/sets/") && method === "GET") {
      if (conflicted && detailSetId === set.id) {
        if (options.conflictThenFailReload) {
          failedReads += 1;
          return response({ error: "unavailable" }, 503);
        }
        if (options.holdConflictReload && ++conflictReads > 1) {
          conflictReloadStarted.resolve(undefined);
          return heldConflictReload.promise;
        }
      }
      const savedSet = savedSets.get(detailSetId);
      if (savedSet === undefined) return response({ error: "quiz_set_not_found" }, 404);
      if (options.holdUpdatedRead && detailSetId === set.id && savedSet.revision > set.revision) {
        updatedReadStarted.resolve(undefined);
        return heldUpdatedRead.promise;
      }
      return response({ set: savedSet });
    }
    if (url.pathname.includes("/modules/quiz/sets/") && method === "PUT") {
      if (options.conflictThenFailReload) {
        conflicted = true;
        return response({ error: "quiz_set_conflict" }, 409);
      }
      if (options.holdConflictReload || options.conflictThenRemoteReload) {
        conflicted = true;
        const current = savedSets.get(detailSetId);
        if (current !== undefined) savedSets.set(detailSetId, { ...current, name: "Remote space", revision: current.revision + 1 });
        return response({ error: "quiz_set_conflict" }, 409);
      }
      const body = requestBody(init);
      writes.push(body);
      const current = savedSets.get(detailSetId);
      if (current === undefined) return response({ error: "quiz_set_not_found" }, 404);
      const savedSet = {
        ...current,
        name: typeof body.name === "string" ? body.name : current.name,
        questions: Array.isArray(body.questions) ? body.questions as QuizSet["questions"] : current.questions,
        revision: current.revision + 1,
      };
      savedSets.set(detailSetId, savedSet);
      return response({ set: savedSet });
    }
    return response({ error: "route_missing" }, 404);
  }));
  return {
    writes,
    failedReads: () => failedReads,
    createStarted: createStarted.promise,
    releaseCreate: () => heldCreate.resolve(Response.json({ set: { ...set, id: options.existing ? "created-set" : set.id, name: "New set" } }, { status: 201 })),
    conflictReloadStarted: conflictReloadStarted.promise,
    releaseConflictReload: () => heldConflictReload.resolve(Response.json({ set: savedSets.get(set.id) })),
    updatedReadStarted: updatedReadStarted.promise,
    releaseUpdatedRead: () => heldUpdatedRead.resolve(Response.json({ set: savedSets.get(set.id) })),
  };
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("quiz set editor", () => {
  it("keeps edits made to the current set while a new set is being created", async () => {
    const fetch = installFetch({ existing: true, holdCreate: true });
    renderWithQuery(<UiProvider><QuizPanel channelId="fictional_channel" language="en" /></UiProvider>);

    fireEvent.click(await screen.findByRole("button", { name: /Space/u }));
    await screen.findByLabelText("Set name");
    fireEvent.click(screen.getByRole("button", { name: "New set" }));
    await fetch.createStarted;
    expect(screen.getByRole("button", { name: "Creating set …" })).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Set name")).toHaveProperty("disabled", false);
    fireEvent.change(screen.getByLabelText("Set name"), { target: { value: "Edited space" } });

    act(() => fetch.releaseCreate());
    await waitFor(() => expect(screen.getAllByRole("button", { name: /New set/u })).toHaveLength(2));
    await screen.findByLabelText("Set name");
    expect(screen.getByLabelText("Set name")).toHaveProperty("value", "Edited space");
    expect(document.querySelector(".quiz-set-row[aria-pressed='true']")?.textContent).toContain("Space");
  });

  it("opens a normally created set in the editor", async () => {
    installFetch();
    renderWithQuery(<UiProvider><QuizPanel channelId="fictional_channel" language="en" /></UiProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "New set" }));

    expect(await screen.findByLabelText("Set name")).toHaveProperty("value", "New set");
  });

  it("keeps the newer selection and draft when a conflict reload for the previous set resolves", async () => {
    const fetch = installFetch({ existing: true, includeOtherSet: true, holdConflictReload: true });
    renderWithQuery(<UiProvider><QuizPanel channelId="fictional_channel" language="en" /></UiProvider>);

    fireEvent.click(await screen.findByRole("button", { name: /Space/u }));
    await screen.findByLabelText("Set name");
    fireEvent.change(screen.getByLabelText("Set name"), { target: { value: "Draft space" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reload" }));
    await fetch.conflictReloadStarted;
    expect(screen.getByRole("button", { name: "Reloading …" })).toHaveProperty("disabled", true);
    expect(screen.getByLabelText("Set name")).toHaveProperty("disabled", false);

    fireEvent.click(screen.getByRole("button", { name: /Ocean/u }));
    const switchDialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(switchDialog).getByRole("button", { name: "Discard and switch" }));
    await waitFor(() => expect(screen.getByLabelText("Set name")).toHaveProperty("value", "Ocean"));
    fireEvent.change(screen.getByLabelText("Set name"), { target: { value: "Edited ocean" } });

    await act(async () => {
      fetch.releaseConflictReload();
      await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    });

    expect(screen.getByLabelText("Set name")).toHaveProperty("value", "Edited ocean");
    expect(document.querySelector(".quiz-set-row[aria-pressed='true']")?.textContent).toContain("Ocean");
  });

  it("replaces the draft when a conflict reload completes for the current set", async () => {
    installFetch({ existing: true, conflictThenRemoteReload: true });
    renderWithQuery(<UiProvider><QuizPanel channelId="fictional_channel" language="en" /></UiProvider>);

    fireEvent.click(await screen.findByRole("button", { name: /Space/u }));
    await screen.findByLabelText("Set name");
    fireEvent.change(screen.getByLabelText("Set name"), { target: { value: "Draft space" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reload" }));

    await waitFor(() => expect(screen.getByLabelText("Set name")).toHaveProperty("value", "Remote space"));
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  });

  it("adds, removes, reorders questions and selects the correct option", async () => {
    installFetch();
    renderWithQuery(<UiProvider><QuizPanel channelId="fictional_channel" language="en" /></UiProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "New set" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add question" }));
    fireEvent.click(screen.getByRole("button", { name: "Add question" }));
    const questionFields = await screen.findAllByLabelText("Question text");
    const firstQuestion = questionFields.at(0);
    const secondQuestion = questionFields.at(1);
    if (firstQuestion === undefined || secondQuestion === undefined) throw new Error("Question inputs did not render.");
    fireEvent.change(firstQuestion, { target: { value: "First question?" } });
    fireEvent.change(secondQuestion, { target: { value: "Second question?" } });
    fireEvent.click(screen.getByRole("button", { name: "Move question 2 up" }));
    fireEvent.click(screen.getByRole("radio", { name: "Correct answer option 2 for question 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove question 2" }));

    expect(screen.getAllByLabelText("Question text")).toHaveLength(1);
    expect(screen.getByLabelText("Question text")).toHaveProperty("value", "Second question?");
    expect(screen.getByRole("radio", { name: "Correct answer option 2 for question 1" })).toHaveProperty("checked", true);
  });

  it("saves explicitly and discard restores the last saved draft", async () => {
    const { writes } = installFetch();
    renderWithQuery(<UiProvider><QuizPanel channelId="fictional_channel" language="en" /></UiProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "New set" }));
    fireEvent.change(await screen.findByLabelText("Set name"), { target: { value: "My set" } });
    fireEvent.click(screen.getByRole("button", { name: "Add question" }));
    fireEvent.change(screen.getByLabelText("Question text"), { target: { value: "What is frozen water?" } });
    fireEvent.change(screen.getByLabelText("Option 1"), { target: { value: "Ice" } });
    fireEvent.change(screen.getByLabelText("Option 2"), { target: { value: "Steam" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(screen.getByLabelText("Set name")).toHaveProperty("value", "New set");
    expect(screen.queryByLabelText("Question text")).toBeNull();
    fireEvent.change(screen.getByLabelText("Set name"), { target: { value: "My set" } });
    fireEvent.click(screen.getByRole("button", { name: "Add question" }));
    fireEvent.change(screen.getByLabelText("Question text"), { target: { value: "What is frozen water?" } });
    fireEvent.change(screen.getByLabelText("Option 1"), { target: { value: "Ice" } });
    fireEvent.change(screen.getByLabelText("Option 2"), { target: { value: "Steam" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ name: "My set", revision: 1, questions: [{ text: "What is frozen water?", options: ["Ice", "Steam"], correctIndex: 0 }] });
  });

  it("shows an empty option error at the option and keeps the summary in the save bar", async () => {
    const { writes } = installFetch();
    renderWithQuery(<UiProvider><QuizPanel channelId="fictional_channel" language="en" /></UiProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "New set" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add question" }));
    fireEvent.change(screen.getByLabelText("Question text"), { target: { value: "What is frozen water?" } });
    fireEvent.change(screen.getByLabelText("Option 1"), { target: { value: "Ice" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    const optionError = await screen.findByText("Must not be empty.");
    expect(screen.getByLabelText("Option 2")).toHaveProperty("ariaInvalid", "true");
    expect(screen.getByLabelText("Option 1").getAttribute("aria-invalid")).toBeNull();
    expect(screen.getByLabelText("Set name").getAttribute("aria-invalid")).toBeNull();
    expect(optionError.closest(".quiz-option-chip")).toBe(screen.getByLabelText("Option 2").closest(".quiz-option-chip"));
    expect(screen.getAllByText(/Answer options cannot be empty\./u)).toHaveLength(1);
    expect(writes).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Option 2"), { target: { value: "Steam" } });
    expect(screen.queryByText("Must not be empty.")).toBeNull();
  });

  it("shows a missing set name under the set name only", async () => {
    installFetch();
    renderWithQuery(<UiProvider><QuizPanel channelId="fictional_channel" language="en" /></UiProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "New set" }));
    fireEvent.change(await screen.findByLabelText("Set name"), { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByLabelText("Set name").getAttribute("aria-invalid")).toBe("true"));
  });

  it("keeps edits made while a save refresh is pending", async () => {
    const fetch = installFetch({ existing: true, holdUpdatedRead: true });
    const { queryClient } = renderWithQuery(<UiProvider><QuizPanel channelId="fictional_channel" language="en" /></UiProvider>);

    fireEvent.click(await screen.findByRole("button", { name: /Space/u }));
    const nameField = await screen.findByLabelText("Set name");
    fireEvent.change(nameField, { target: { value: "Saved space" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await fetch.updatedReadStarted;

    expect(nameField).toHaveProperty("disabled", false);
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    expect(queryClient.getQueryData<QuizSet>(moduleQueryKey("fictional_channel", "quiz", `set:${set.id}`)))
      .toMatchObject({ name: "Saved space", revision: 2 });

    fireEvent.change(nameField, { target: { value: "Newer space" } });
    fetch.releaseUpdatedRead();
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", false));
    expect(screen.getByLabelText("Set name")).toHaveProperty("value", "Newer space");
  });

  it("asks before dashboard navigation leaves an unsaved draft", async () => {
    installFetch({ existing: true });
    renderWithQuery(<UiProvider><QuizPanel channelId="fictional_channel" language="en" /></UiProvider>);

    fireEvent.click(await screen.findByRole("button", { name: /Space/u }));
    fireEvent.change(await screen.findByLabelText("Set name"), { target: { value: "Edited space" } });

    let navigated = false;
    act(() => runDashboardNavigationGuards(() => { navigated = true; }, () => undefined));
    const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    expect(navigated).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: "Discard and switch" }));
    await waitFor(() => expect(navigated).toBe(true));
  });

  it("keeps the draft and the conflict when the reload after a conflict fails", async () => {
    const fetch = installFetch({ existing: true, conflictThenFailReload: true });
    renderWithQuery(<UiProvider><QuizPanel channelId="fictional_channel" language="en" /></UiProvider>);

    fireEvent.click(await screen.findByRole("button", { name: /Space/u }));
    fireEvent.change(await screen.findByLabelText("Set name"), { target: { value: "Edited space" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reload" }));

    await waitFor(() => expect(fetch.failedReads()).toBeGreaterThan(0));
    const failedBeforeSettle = fetch.failedReads();
    await waitFor(() => expect(fetch.failedReads()).toBe(failedBeforeSettle));
    expect(screen.getByLabelText("Set name")).toHaveProperty("value", "Edited space");
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.getAllByText(/The set changed while you were editing it\./u).length).toBeGreaterThan(0);
  });
});
