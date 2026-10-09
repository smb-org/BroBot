import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { moduleQueryKey } from "../../src/dashboard/data";
import type { FaqEntry } from "../../src/modules/faq/contracts";
import FaqPanel from "../../src/modules/faq/panel";
import { jsonResponse } from "../unit/fixtures";
import { renderWithQuery } from "../query-test-utils";

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
  it("reserves the result area for FAQ match tests", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      if (url.pathname.endsWith("/entries")) return Promise.resolve(jsonResponse({ entries: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    }));
    renderWithQuery(<UiProvider><FaqPanel channelId="channel-a" language="de" /></UiProvider>);

    expect(await screen.findByTestId("faq-test-result-slot")).toBeInTheDocument();
  });

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

    renderWithQuery(<UiProvider><FaqPanel channelId="channel-a" language="de" canManage={false} /></UiProvider>);
    expect(screen.getByRole("button", { name: "FAQ-Eintrag anlegen" })).toBeDisabled();
    expect(screen.getByText("Nur Broadcaster und Verwalter dürfen FAQ-Einträge bearbeiten.")).toBeInTheDocument();
    const enabledSwitch = await screen.findByRole("switch", { name: "Greeting: Aktiviert" });
    expect(enabledSwitch).toBeEnabled();

    fireEvent.click(enabledSwitch);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      "/api/channels/channel-a/modules/faq/entries/entry-1/enabled",
      expect.objectContaining({ method: "PATCH" }),
    ));
    expect(await screen.findByRole("switch", { name: "Greeting: Deaktiviert" })).toBeEnabled();
  });

  it("reuses warm FAQ data when the panel is mounted again", async () => {
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      if (url.pathname.endsWith("/entries")) return Promise.resolve(jsonResponse({ entries: [entry] }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);

    const view = renderWithQuery(
      <UiProvider><FaqPanel channelId="channel-a" language="en" /></UiProvider>,
      {},
      { gcTime: 600_000, staleTime: 600_000 },
    );
    expect(await screen.findByText("Greeting")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);

    view.rerender(<UiProvider>{null}</UiProvider>);
    view.rerender(<UiProvider><FaqPanel channelId="channel-a" language="en" /></UiProvider>);

    expect(await screen.findByText("Greeting")).toBeInTheDocument();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps a committed FAQ revision when the post-save refresh fails and offers retry", async () => {
    let enabled = true;
    let revision = 1;
    let entryReads = 0;
    let refreshFails = false;
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      if (url.pathname.endsWith("/entries/entry-1/enabled") && method === "PATCH") {
        if (typeof init?.body !== "string") throw new Error("Expected the FAQ enable request to have a JSON body.");
        const body = JSON.parse(init.body) as { enabled: boolean; revision: number };
        expect(body.revision).toBe(1);
        enabled = body.enabled;
        revision = 2;
        refreshFails = true;
        return Promise.resolve(jsonResponse({ entry: { ...entry, enabled, revision } }));
      }
      if (url.pathname.endsWith("/entries")) {
        entryReads += 1;
        if (entryReads > 1 && refreshFails) return Promise.resolve(jsonResponse({ error: "temporarily unavailable" }, 503));
        return Promise.resolve(jsonResponse({ entries: [{ ...entry, enabled, revision }] }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);

    const { queryClient } = renderWithQuery(
      <UiProvider><FaqPanel channelId="channel-a" language="en" /></UiProvider>,
      {},
      { gcTime: 600_000, staleTime: 600_000 },
    );
    fireEvent.click(await screen.findByRole("switch", { name: "Greeting: Enabled" }));

    expect(await screen.findByRole("switch", { name: "Greeting: Disabled" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("FAQ entries could not be loaded.")).toBeInTheDocument());
    expect(entryReads).toBeGreaterThan(1);
    expect(queryClient.getQueryData<{ entries: FaqEntry[] }>(moduleQueryKey("channel-a", "faq", "panel"))?.entries[0])
      .toMatchObject({ enabled: false, revision: 2 });
    const retryButton = screen.getByRole("button", { name: /Retry|Erneut versuchen/u });
    refreshFails = false;
    fireEvent.click(retryButton);
    await waitFor(() => expect(screen.queryByText("FAQ entries could not be loaded.")).not.toBeInTheDocument());
    expect(screen.getByRole("switch", { name: "Greeting: Disabled" })).toBeInTheDocument();
    expect(entryReads).toBeGreaterThan(2);
  });
});
