import { cleanup, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import TimersPanel from "../../src/modules/timers/panel";
import { renderWithQuery } from "../query-test-utils";
import { jsonResponse } from "../unit/fixtures";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Timers panel", () => {
  it("keeps a reserved list area when no timers are configured", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/timers")) return Promise.resolve(jsonResponse({ timers: [] }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    renderWithQuery(<UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>);

    expect(await screen.findByTestId("timers-list-slot")).toBeInTheDocument();
  });

  it("shows cached timers immediately when the panel is mounted again", async () => {
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/timers")) return Promise.resolve(jsonResponse({ timers: [{
        id: "timer-1", name: "Greeting timer", enabled: true, blockName: "greeting", chatTarget: "source_only",
        trigger: { type: "interval", minutes: 30 }, revision: 1, nextRunAt: null, nextRunStreamId: null,
        lastRunAt: null, createdAt: "2026-09-19T12:00:00.000Z", updatedAt: "2026-09-19T12:00:00.000Z",
      }] }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);

    const view = renderWithQuery(
      <UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>,
      {},
      { gcTime: 600_000, staleTime: 600_000 },
    );
    expect(await screen.findByText("Greeting timer")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(3);

    view.rerender(<UiProvider>{null}</UiProvider>);
    view.rerender(<UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>);

    expect(screen.getByText("Greeting timer")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("keeps the create action visible and disabled for operators", () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/timers")) return Promise.resolve(jsonResponse({ timers: [] }));
      if (url.pathname.endsWith("/event-time-sources")) return Promise.resolve(jsonResponse({ sources: [] }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));

    renderWithQuery(<UiProvider><TimersPanel channelId="channel-a" language="en" canManage={false} /></UiProvider>);

    expect(screen.getByRole("button", { name: "Create timer" })).toBeDisabled();
    expect(screen.getByText("Only broadcasters and managers can edit timers.")).toBeInTheDocument();
  });
});
