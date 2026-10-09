import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
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
    fireEvent.change(await screen.findByRole("textbox", { name: "HTTPS URL" }), {
      target: { value: "https://api.example.test/changed" },
    });

    serverSource = makeSource({ expression: "$.remote", revision: 2, updatedAt: "2026-10-02T12:00:00.000Z" });
    await act(async () => {
      await view.queryClient.invalidateQueries({ queryKey: moduleQueryKey("kanal-a", "api_source", "sources") });
    });
    expect(screen.getByRole("textbox", { name: "JSONata expression (optional)" })).toHaveValue("$.original");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(patchBody).toEqual({
      url: "https://api.example.test/changed",
      expression: "$.original",
      revision: 1,
    }));
    expect(await screen.findByText(apiSourcePanelTexts("en").conflict)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "JSONata expression (optional)" })).toHaveValue("$.original");
    expect(view.queryClient.getQueryData<ApiSource[]>(moduleQueryKey("kanal-a", "api_source", "sources"))?.[0]).toMatchObject({
      expression: "$.remote",
      revision: 2,
    });
  });
});
