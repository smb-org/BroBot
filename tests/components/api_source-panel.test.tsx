import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { moduleQueryKey } from "../../src/dashboard/data";
import { UiProvider } from "../../src/dashboard/ui";
import { apiSourcePanelTexts } from "../../src/modules/api_source/panel/locale";
import ApiSourcePanel from "../../src/modules/api_source/panel";
import type { ApiSource } from "../../src/modules/api_source/contracts";
import { jsonResponse } from "../unit/fixtures";
import { renderWithQuery } from "../query-test-utils";

const makeSource = (overrides: Partial<ApiSource> = {}): ApiSource => ({
  name: "sunset",
  url: "https://api.example.test/sunset",
  expression: "$.original",
  revision: 1,
  updatedAt: "2026-10-01T12:00:00.000Z",
  lastFetchedAt: null,
  lastStatus: null,
  lastError: null,
  ...overrides,
});

const sourceFetch = (read: () => ApiSource[], onPatch?: (body: unknown) => Response): ReturnType<typeof vi.fn<typeof fetch>> =>
  vi.fn<typeof fetch>((input, init) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
    if (url.pathname.endsWith("/sources") && method === "GET") return Promise.resolve(jsonResponse({ sources: read() }));
    if (url.pathname.includes("/sources/") && method === "PATCH") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null;
      return Promise.resolve(onPatch?.(body) ?? jsonResponse({ source: makeSource() }));
    }
    return Promise.resolve(jsonResponse({}, 404));
  });

const renderPanel = (fetcher: typeof fetch, canManage = true) => {
  vi.stubGlobal("fetch", fetcher);
  return renderWithQuery(
    <UiProvider><ApiSourcePanel channelId="kanal-a" language="en" canManage={canManage} /></UiProvider>,
    undefined,
    { gcTime: 600_000 },
  );
};

const inputUrl = (input: RequestInfo | URL): string =>
  input instanceof Request ? input.url : input instanceof URL ? input.href : input;

describe("API source panel query lifecycle", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows cached sources immediately when returning to the module", async () => {
    const fetcher = sourceFetch(() => [makeSource()]);
    const view = renderPanel(fetcher);
    expect(await screen.findByRole("button", { name: /sunset/u })).toBeInTheDocument();

    view.rerender(<UiProvider><div /></UiProvider>);
    view.rerender(<UiProvider><ApiSourcePanel channelId="kanal-a" language="en" canManage /></UiProvider>);

    expect(screen.getByRole("button", { name: /sunset/u })).toBeInTheDocument();
    expect(document.querySelector(".ui-load-state")).not.toHaveAttribute("data-status", "loading");
  });

  it("submits the draft's opening revision after a background refresh and keeps the remote edit on conflict", async () => {
    let serverSource = makeSource();
    let patchBody: unknown;
    const fetcher = sourceFetch(
      () => [serverSource],
      (body) => {
        patchBody = body;
        return jsonResponse({ error: "api_source_conflict" }, 409);
      },
    );
    const view = renderPanel(fetcher);
    expect(await screen.findByRole("button", { name: /sunset/u })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /sunset/u }));
    fireEvent.click(screen.getByRole("button", { name: "Edit source" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Web address" }), {
      target: { value: "https://api.example.test/changed" },
    });

    serverSource = makeSource({ expression: "$.remote", revision: 2, updatedAt: "2026-10-02T12:00:00.000Z" });
    await act(async () => {
      await view.queryClient.invalidateQueries({ queryKey: moduleQueryKey("kanal-a", "api_source", "sources") });
    });
    expect(screen.getByRole("textbox", { name: "Value from the response" })).toHaveValue("$.original");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(patchBody).toEqual({
      url: "https://api.example.test/changed",
      expression: "$.original",
      revision: 1,
    }));
    expect(await screen.findByText(apiSourcePanelTexts("en").conflict)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Value from the response" })).toHaveValue("$.original");
    expect(view.queryClient.getQueryData<ApiSource[]>(moduleQueryKey("kanal-a", "api_source", "sources"))?.[0]).toMatchObject({
      expression: "$.remote",
      revision: 2,
    });
  });

  it("accepts a recreated source with a lower revision after a warm-cache refresh", async () => {
    let serverSource = makeSource({
      url: "https://api.example.test/deleted-generation",
      expression: "$.deleted",
      revision: 4,
    });
    const fetcher = sourceFetch(() => [serverSource]);
    const view = renderPanel(fetcher);
    expect(await screen.findByRole("button", { name: /sunset/u })).toBeInTheDocument();

    serverSource = makeSource({
      url: "https://recreated.example.test/recreated-generation",
      expression: "$.recreated",
      revision: 1,
      updatedAt: "2026-10-03T12:00:00.000Z",
    });
    await act(async () => {
      await view.queryClient.refetchQueries({
        queryKey: moduleQueryKey("kanal-a", "api_source", "sources"),
        exact: true,
      });
    });
    expect(await screen.findByText("recreated.example.test")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /sunset/u }));
    fireEvent.click(screen.getByRole("button", { name: "Edit source" }));

    expect(await screen.findByRole("textbox", { name: "Web address" })).toHaveValue(
      "https://recreated.example.test/recreated-generation",
    );
    expect(screen.getByRole("textbox", { name: "Value from the response" })).toHaveValue("$.recreated");
    expect(view.queryClient.getQueryData<ApiSource[]>(moduleQueryKey("kanal-a", "api_source", "sources"))?.[0])
      .toMatchObject({ revision: 1, expression: "$.recreated" });
  });

  it("tests the unsaved editor draft", async () => {
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (url.pathname.endsWith("/sources") && method === "GET") return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/sources/test") && method === "POST") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as { expression?: unknown } : {};
        const value = body.expression === "$.temperature" ? "21" : "sunny";
        return Promise.resolve(jsonResponse({
          status: "ok",
          httpStatus: 200,
          bytes: 15,
          json: { temperature: 21, weather: { status: "sunny" } },
          value,
        }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    renderPanel(fetcher);

    fireEvent.click(await screen.findByRole("button", { name: "Create source" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Web address" }), {
      target: { value: "https://api.example.test/weather" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Value from the response" }), {
      target: { value: "$.weather.status" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const resultArea = screen.getByTestId("api-source-test-result");
    expect(resultArea).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Test" }));

    expect(await screen.findByRole("treeitem", { name: /status.*String.*sunny/u })).toBeInTheDocument();
    const temperature = screen.getByRole("treeitem", { name: /temperature/u });
    const temperatureRow = temperature.querySelector(".api-source-json-tree__item");
    if (!(temperatureRow instanceof HTMLElement)) throw new Error("Temperature tree row is missing.");
    fireEvent.click(temperatureRow);
    expect(screen.getByRole("textbox", { name: "Value from the response" })).toHaveValue("$.temperature");
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    expect(await screen.findByText("21", { selector: ".api-source-panel__test-result-value code" })).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith("/api/channels/kanal-a/modules/api_source/sources/test", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ url: "https://api.example.test/weather", expression: "$.weather.status" }),
    }));
    expect(fetcher).toHaveBeenLastCalledWith("/api/channels/kanal-a/modules/api_source/sources/test", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ url: "https://api.example.test/weather", expression: "$.temperature" }),
    }));
  });

  it("requires a test attempt before naming a source and shows the typed test failure", async () => {
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (url.pathname.endsWith("/sources") && method === "GET") return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/sources/test") && method === "POST") return Promise.resolve(jsonResponse({
        status: "error",
        reason: "timeout",
        httpStatus: 504,
      }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    renderPanel(fetcher);

    fireEvent.click(await screen.findByRole("button", { name: "Create source" }));
    const dialog = await screen.findByRole("dialog", { name: "Create data source" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Web address" }), {
      target: { value: "https://api.example.test/weather" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Value from the response" }), {
      target: { value: "$.temperature" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));

    fireEvent.click(within(dialog).getByRole("button", { name: "Test" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("The endpoint did not respond in time.");
    expect(within(dialog).getByRole("tree", { name: "Sample response as a JSON tree" })).toBeInTheDocument();
    expect(within(dialog).getByText("Run a test to inspect the response.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Continue" })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue" }));
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toBeInTheDocument();
  });

  it("marks a source with its localized last failure reason", async () => {
    const fetcher = sourceFetch(() => [makeSource({
      lastFetchedAt: "2026-10-12T08:30:00.000Z",
      lastStatus: "error",
      lastError: "invalid_json",
    })]);
    renderPanel(fetcher);

    expect(await screen.findByRole("button", { name: /sunset/u })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /sunset/u }));

    expect(await screen.findByText("The response is not valid JSON.")).toBeInTheDocument();
    expect(document.querySelector(".api-source-panel__row-status")).toBeInTheDocument();
  });

  it("keeps the operator reason accessible on the disabled create action without showing a second reason", async () => {
    const fetcher = sourceFetch(() => []);
    renderPanel(fetcher, false);

    const create = await screen.findByRole("button", { name: "Create source" });
    expect(create).toBeDisabled();
    const reasonId = create.getAttribute("aria-describedby");
    expect(reasonId).not.toBeNull();
    const reason = document.getElementById(reasonId ?? "");
    expect(reason).toHaveTextContent("Operators can view data sources but cannot change them.");
    expect(reason).toHaveClass("sr-only");
  });

  it("includes each source status in its accessible list name", async () => {
    const fetcher = sourceFetch(() => [makeSource({ lastStatus: "error", lastError: "timeout" })]);
    renderPanel(fetcher);

    expect(await screen.findByRole("button", { name: /sunset.*Error/u })).toBeInTheDocument();
  });

  it("disables an open editor and its actions when management permission is removed", async () => {
    const fetcher = sourceFetch(() => [makeSource()]);
    const view = renderPanel(fetcher);
    fireEvent.click(await screen.findByRole("button", { name: /sunset/u }));
    fireEvent.click(screen.getByRole("button", { name: "Edit source" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit source" });

    view.rerender(<UiProvider><ApiSourcePanel channelId="kanal-a" language="en" canManage={false} /></UiProvider>);

    expect(within(dialog).getByRole("textbox", { name: "Web address" })).toBeDisabled();
    expect(within(dialog).getByRole("textbox", { name: "Value from the response" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Test" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Delete source" })).toBeDisabled();
    expect(screen.getAllByText(apiSourcePanelTexts("en").readOnlyReason)).toHaveLength(1);
  });

  it("submits each source-creation step with Enter or Ctrl+Enter", async () => {
    const created = makeSource({ name: "weather", url: "https://api.example.test/weather", expression: "$.temperature" });
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (url.pathname.endsWith("/sources") && method === "GET") return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/sources/test") && method === "POST") return Promise.resolve(jsonResponse({
        status: "ok", httpStatus: 200, bytes: 15, json: { temperature: 21 }, value: "21",
      }));
      if (url.pathname.endsWith("/sources") && method === "POST") return Promise.resolve(jsonResponse({ source: created }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    renderPanel(fetcher);

    fireEvent.click(await screen.findByRole("button", { name: "Create source" }));
    const dialog = await screen.findByRole("dialog", { name: "Create data source" });
    const form = dialog.querySelector("form");
    expect(form).not.toBeNull();
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Web address" }), {
      target: { value: "https://api.example.test/weather" },
    });
    fireEvent.submit(form as HTMLFormElement);
    expect(within(dialog).getByText("Step 2 of 4")).toBeInTheDocument();

    const expression = within(dialog).getByRole("textbox", { name: "Value from the response" });
    fireEvent.change(expression, { target: { value: "$.temperature" } });
    fireEvent.keyDown(expression, { key: "Enter", ctrlKey: true });
    expect(within(dialog).getByText("Step 3 of 4")).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("button", { name: "Test" }));
    await waitFor(() => { expect(within(dialog).getByRole("status")).toHaveTextContent("Success · HTTP 200"); });
    fireEvent.submit(form as HTMLFormElement);
    expect(within(dialog).getByText("Step 4 of 4")).toBeInTheDocument();

    const name = within(dialog).getByRole("textbox", { name: "Name" });
    expect(name).toBeRequired();
    fireEvent.keyDown(name, { key: "Enter", ctrlKey: true });
    fireEvent.submit(form as HTMLFormElement);
    expect(fetcher.mock.calls.some(([input, init]) => inputUrl(input).endsWith("/sources") && init?.method === "POST")).toBe(false);

    fireEvent.change(name, { target: { value: "weather" } });
    fireEvent.keyDown(name, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(fetcher.mock.calls.some(([input, init]) => inputUrl(input).endsWith("/sources") && init?.method === "POST")).toBe(true));
  });
});
