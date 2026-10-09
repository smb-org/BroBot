import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import ApiSourcePanel from "../../src/modules/api_source/panel";
import { jsonResponse } from "../unit/fixtures";
import { renderWithQuery } from "../query-test-utils";

describe("API source panel", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens the add-source editor in a dialog", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({ sources: [] }))));
    renderWithQuery(<UiProvider><ApiSourcePanel channelId="channel-a" language="en" canManage /></UiProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Add source" }));

    expect(await screen.findByRole("dialog", { name: "Create source" })).toBeInTheDocument();
  });

  it("shows operators why an existing API source is read-only inside its dialog", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({ sources: [{
      name: "weather", url: "https://example.com/weather", expression: "$.temperature", revision: 2,
      updatedAt: "2026-10-01T12:00:00.000Z",
    }] }))));
    renderWithQuery(<UiProvider><ApiSourcePanel channelId="channel-a" language="en" canManage={false} /></UiProvider>);

    fireEvent.click(await screen.findByRole("button", { name: /weather/u }));

    const dialog = await screen.findByRole("dialog", { name: "Edit source" });
    expect(within(dialog).getByText("Operators can read API sources but cannot define them.")).toBeInTheDocument();
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveAttribute("readonly");
    expect(within(dialog).getByRole("textbox", { name: "HTTPS URL" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows cached API sources immediately when the panel is mounted again", async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({ sources: [{
      name: "weather", url: "https://example.com/weather", expression: "$.temperature", revision: 2,
      updatedAt: "2026-10-01T12:00:00.000Z",
    }] })));
    vi.stubGlobal("fetch", fetcher);

    const view = renderWithQuery(
      <UiProvider><ApiSourcePanel channelId="channel-a" language="en" canManage /></UiProvider>,
      {},
      { gcTime: 600_000, staleTime: 600_000 },
    );
    expect(await screen.findByRole("button", { name: /weather/u })).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(1);

    view.rerender(<UiProvider>{null}</UiProvider>);
    view.rerender(<UiProvider><ApiSourcePanel channelId="channel-a" language="en" canManage /></UiProvider>);

    expect(screen.getByRole("button", { name: /weather/u })).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
