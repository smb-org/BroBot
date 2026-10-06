import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import TimersPanel from "../../src/modules/timers/panel";
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

    render(<UiProvider><TimersPanel channelId="channel-a" language="en" /></UiProvider>);

    expect(await screen.findByTestId("timers-list-slot")).toBeInTheDocument();
  });
});
