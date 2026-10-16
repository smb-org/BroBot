import { cleanup, fireEvent, screen } from "@testing-library/react";
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

    fireEvent.click(await screen.findByRole("button", { name: "Create source" }));

    expect(await screen.findByRole("dialog", { name: "Create data source" })).toBeInTheDocument();
  });

  it("shows operators why API sources are read-only and keeps edit actions unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({ sources: [{
      name: "weather", url: "https://example.com/weather", expression: "$.temperature", revision: 2,
      updatedAt: "2026-10-01T12:00:00.000Z",
    }] }))));
    renderWithQuery(<UiProvider><ApiSourcePanel channelId="channel-a" language="en" canManage={false} /></UiProvider>);

    fireEvent.click(await screen.findByRole("button", { name: /weather/u }));

    expect(screen.getByText("Operators can view data sources but cannot change them.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create source" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit source" })).toBeDisabled();
  });

  it.each([
    ["name", "forecast", ["forecast"]],
    ["hostname", "weather.example", ["forecast"]],
    ["path", "/current", ["live"]],
    ["full URL", "https://api.test/v1/current?city=1", ["live"]],
    ["no match", "nothing-here", []],
  ])("searches by %s", async (_case, term, expected) => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse({ sources: [
      { name: "forecast", url: "https://weather.example/v1/daily", expression: "$.t", revision: 1, updatedAt: "2026-10-01T12:00:00.000Z" },
      { name: "live", url: "https://api.test/v1/current?city=1", expression: "$.t", revision: 1, updatedAt: "2026-10-01T12:00:00.000Z" },
    ] }))));
    renderWithQuery(<UiProvider><ApiSourcePanel channelId="channel-a" language="en" canManage /></UiProvider>);
    await screen.findByRole("button", { name: /forecast/u });

    fireEvent.change(screen.getByLabelText("Search data sources"), { target: { value: term } });

    for (const name of ["forecast", "live"]) {
      const row = screen.queryByRole("button", { name: new RegExp(name, "u") });
      if (expected.includes(name)) expect(row).toBeInTheDocument();
      else expect(row).not.toBeInTheDocument();
    }
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
