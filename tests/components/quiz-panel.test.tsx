import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import QuizPanel from "../../src/modules/quiz/panel";
import { moduleQueryKey } from "../../src/dashboard/data";
import { UiProvider } from "../../src/dashboard/ui";
import type { QuizSet } from "../../src/modules/quiz/contracts";
import { renderWithQuery } from "../query-test-utils";

const set: QuizSet = { id: "fictional-set", name: "Space", revision: 1, createdAt: "2030-01-01", updatedAt: "2030-01-01", questions: [] };

const response = (body: unknown, status = 200): Promise<Response> => Promise.resolve(Response.json(body, { status }));
const requestBody = (init: RequestInit | undefined): Record<string, unknown> => {
  if (typeof init?.body !== "string") return {};
  const parsed: unknown = JSON.parse(init.body);
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
};

const installFetch = (options: { existing?: boolean; holdUpdatedRead?: boolean } = {}) => {
  let savedSet = structuredClone(set);
  const writes: unknown[] = [];
  let releaseUpdatedRead: (() => void) | undefined;
  let markUpdatedReadStarted: (() => void) | undefined;
  const updatedReadStarted = new Promise<void>((resolve) => { markUpdatedReadStarted = resolve; });
  vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? new URL(input.url) : input instanceof URL ? input : new URL(input, window.location.href);
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/csrf") return response({ token: "fictional-token" });
    if (url.pathname.endsWith("/modules/quiz/sets") && method === "GET") return response({
      sets: options.existing ? [{
        id: set.id, name: set.name, revision: set.revision, questionCount: 0, createdAt: set.createdAt, updatedAt: set.updatedAt,
      }] : [],
      total: options.existing ? 1 : 0,
      page: 1,
    });
    if (url.pathname.endsWith("/modules/quiz/sets") && method === "POST") {
      const body = requestBody(init);
      savedSet = { ...savedSet, name: typeof body.name === "string" ? body.name : savedSet.name };
      return response({ set: savedSet }, 201);
    }
    if (url.pathname.endsWith(`/modules/quiz/sets/${set.id}`) && method === "GET") {
      if (options.holdUpdatedRead && savedSet.revision > set.revision) {
        markUpdatedReadStarted?.();
        return new Promise((resolve) => {
          releaseUpdatedRead = () => resolve(Response.json({ set: savedSet }));
        });
      }
      return response({ set: savedSet });
    }
    if (url.pathname.endsWith(`/modules/quiz/sets/${set.id}`) && method === "PUT") {
      const body = requestBody(init);
      writes.push(body);
      savedSet = {
        ...savedSet,
        name: typeof body.name === "string" ? body.name : savedSet.name,
        questions: Array.isArray(body.questions) ? body.questions as QuizSet["questions"] : savedSet.questions,
        revision: savedSet.revision + 1,
      };
      return response({ set: savedSet });
    }
    return response({ error: "route_missing" }, 404);
  }));
  return {
    writes,
    updatedReadStarted,
    releaseUpdatedRead: () => releaseUpdatedRead?.(),
  };
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("quiz set editor", () => {
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

  it("publishes the saved revision before a delayed refresh and locks edits while saving", async () => {
    const fetch = installFetch({ existing: true, holdUpdatedRead: true });
    const { queryClient } = renderWithQuery(<UiProvider><QuizPanel channelId="fictional_channel" language="en" /></UiProvider>);

    fireEvent.click(await screen.findByRole("button", { name: /Space/u }));
    const nameField = await screen.findByLabelText("Set name");
    fireEvent.change(nameField, { target: { value: "Saved space" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await fetch.updatedReadStarted;

    expect(nameField).toHaveProperty("disabled", true);
    expect(queryClient.getQueryData<QuizSet>(moduleQueryKey("fictional_channel", "quiz", `set:${set.id}`)))
      .toMatchObject({ name: "Saved space", revision: 2 });

    fetch.releaseUpdatedRead();
    await screen.findByText("Saved");
    expect(screen.getByLabelText("Set name")).toHaveProperty("value", "Saved space");
  });
});
