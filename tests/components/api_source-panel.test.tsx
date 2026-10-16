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

const renderPanel = (fetcher: typeof fetch) => {
  vi.stubGlobal("fetch", fetcher);
  return renderWithQuery(
    <UiProvider><ApiSourcePanel channelId="kanal-a" language="en" canManage /></UiProvider>,
    undefined,
    { gcTime: 600_000 },
  );
};

describe("API source panel query lifecycle", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows cached sources immediately when returning to the module", async () => {
    const fetcher = sourceFetch(() => [makeSource()]);
    const view = renderPanel(fetcher);
    expect(await screen.findByRole("button", { name: "sunset" })).toBeInTheDocument();

    view.rerender(<UiProvider><div /></UiProvider>);
    view.rerender(<UiProvider><ApiSourcePanel channelId="kanal-a" language="en" canManage /></UiProvider>);

    expect(screen.getByRole("button", { name: "sunset" })).toBeInTheDocument();
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
    expect(await screen.findByRole("button", { name: "sunset" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "sunset" }));
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
    expect(await screen.findByRole("button", { name: "sunset" })).toBeInTheDocument();

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

    fireEvent.click(screen.getByRole("button", { name: "sunset" }));
    fireEvent.click(screen.getByRole("button", { name: "Edit source" }));

    expect(await screen.findByRole("textbox", { name: "Web address" })).toHaveValue(
      "https://recreated.example.test/recreated-generation",
    );
    expect(screen.getByRole("textbox", { name: "Value from the response" })).toHaveValue("$.recreated");
    expect(view.queryClient.getQueryData<ApiSource[]>(moduleQueryKey("kanal-a", "api_source", "sources"))?.[0])
      .toMatchObject({ revision: 1, expression: "$.recreated" });
  });

  it("tests the unsaved editor draft and keeps a reserved result area", async () => {
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (url.pathname.endsWith("/sources") && method === "GET") return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/sources/test") && method === "POST") return Promise.resolve(jsonResponse({
        status: "ok",
        httpStatus: 200,
        bytes: 15,
        json: { temperature: 21 },
        value: "21",
      }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    renderPanel(fetcher);

    fireEvent.click(await screen.findByRole("button", { name: "Create source" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Web address" }), {
      target: { value: "https://api.example.test/weather" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Value from the response" }), {
      target: { value: "$.temperature" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    const resultArea = screen.getByTestId("api-source-test-result");
    const reservedHeight = getComputedStyle(resultArea).height;

    fireEvent.click(screen.getByRole("button", { name: "Test" }));

    expect(await screen.findByText(/21/u)).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledWith("/api/channels/kanal-a/modules/api_source/sources/test", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ url: "https://api.example.test/weather", expression: "$.temperature" }),
    }));
    expect(getComputedStyle(resultArea).height).toBe(reservedHeight);
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

    expect(await screen.findByRole("button", { name: "sunset" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "sunset" }));

    expect(await screen.findByText("The response is not valid JSON.")).toBeInTheDocument();
    expect(document.querySelector(".api-source-panel__row-status")).toBeInTheDocument();
  });
});
