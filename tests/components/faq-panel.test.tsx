import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import type { FaqEntry } from "../../src/modules/faq/contracts";
import FaqPanel from "../../src/modules/faq/panel";
import { jsonResponse } from "../unit/fixtures";

const entry: FaqEntry = {
  id: "entry-1",
  name: "Greeting",
  enabled: true,
  matcher: { type: "keywords", patterns: ["hello"] },
  answerBlock: "greeting",
  cooldownSeconds: 30,
  games: [],
  chatTarget: "source_only",
  order: 0,
  revision: 1,
  lastUsedAt: null,
  createdAt: "2026-09-19T12:00:00.000Z",
  updatedAt: "2026-09-19T12:00:00.000Z",
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FAQ panel", () => {
  it("keeps the existing-entry switch available to operators", async () => {
    let enabled = true;
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      if (url.pathname.endsWith("/entries/entry-1/enabled") && method === "PATCH") {
        const body = typeof init?.body === "string" ? JSON.parse(init.body) as { enabled: boolean } : { enabled };
        enabled = body.enabled;
        return Promise.resolve(jsonResponse({ entry: { ...entry, enabled, revision: 2 } }));
      }
      if (url.pathname.endsWith("/entries")) return Promise.resolve(jsonResponse({ entries: [{ ...entry, enabled }] }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);

    render(<UiProvider><FaqPanel channelId="channel-a" language="de" canManage={false} /></UiProvider>);
    const enabledSwitch = await screen.findByRole("switch", { name: "Greeting: Aktiviert" });
    expect(enabledSwitch).toBeEnabled();

    fireEvent.click(enabledSwitch);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      "/api/channels/channel-a/modules/faq/entries/entry-1/enabled",
      expect.objectContaining({ method: "PATCH" }),
    ));
    expect(await screen.findByRole("switch", { name: "Greeting: Deaktiviert" })).toBeEnabled();
  });
});
