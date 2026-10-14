import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import type { FaqEntry } from "../../src/modules/faq/contracts";
import FaqPanel from "../../src/modules/faq/panel";
import { jsonResponse } from "../unit/fixtures";
import { renderWithQuery } from "../query-test-utils";

const entry: FaqEntry = {
  id: "entry-1",
  name: "Greeting",
  enabled: true,
  matcher: { type: "keywords", patterns: ["hello"] },
  answerText: "Hello there!",
  minimumTier: "everyone",
  cooldownSeconds: 30,
  userCooldownSeconds: 0,
  games: [],
  chatTarget: "source_only",
  order: 0,
  revision: 1,
  lastUsedAt: null,
  createdAt: "2026-09-19T12:00:00.000Z",
  updatedAt: "2026-09-19T12:00:00.000Z",
};

const installPanelFetch = (handler?: (url: URL, method: string, init?: RequestInit) => Response | undefined) => {
  const fetcher = vi.fn<typeof fetch>((input, init) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const handled = handler?.(url, method, init);
    if (handled !== undefined) return Promise.resolve(handled);
    if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({
      timeZone: "UTC", revision: 1, location: null, locationRevision: 1,
      defaultChatTarget: "source_only", defaultChatTargetRevision: 1,
    }));
    if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
    if (url.pathname.endsWith("/entries")) return Promise.resolve(jsonResponse({ entries: [entry] }));
    if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
    return Promise.resolve(jsonResponse({}, 404));
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("FAQ panel", () => {
  it("tests only the selected draft matcher and accepts multiword keyword chips", async () => {
    const fetcher = installPanelFetch();
    renderWithQuery(<UiProvider><FaqPanel channelId="channel-a" language="de" /></UiProvider>);

    const keywordField = await screen.findByRole("textbox", { name: "Schlüsselwörter und Wortgruppen" });
    fireEvent.change(keywordField, { target: { value: "hello there" } });
    fireEvent.keyDown(keywordField, { key: "Enter" });
    expect(await screen.findByRole("button", { name: "hello there entfernen" })).toBeInTheDocument();

    const sampleField = screen.getByRole("textbox", { name: "Beispielnachricht testen" });
    fireEvent.change(sampleField, { target: { value: "when do you say hello there?" } });
    expect(screen.getByTestId("faq-test-result-slot")).toHaveTextContent("Treffer durch");
    expect(fetcher.mock.calls.some(([input]) => (input instanceof Request ? input.url : input.toString()).includes("/test"))).toBe(false);
  });

  it("saves answer, enabled state, and role threshold together with the entry revision", async () => {
    let updated: FaqEntry = entry;
    const fetcher = installPanelFetch((url, method, init) => {
      if (url.pathname.endsWith("/entries/entry-1") && method === "PATCH") {
        if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
        const body = JSON.parse(init.body) as { answerText: string; enabled: boolean; minimumTier: FaqEntry["minimumTier"]; revision: number };
        expect(body).toMatchObject({ answerText: "Welcome to the channel!", enabled: true, minimumTier: "everyone", revision: 1 });
        updated = { ...entry, answerText: body.answerText, revision: 2 };
        return jsonResponse({ entry: updated });
      }
      return undefined;
    });
    renderWithQuery(<UiProvider><FaqPanel channelId="channel-a" language="en" /></UiProvider>);

    fireEvent.change(await screen.findByRole("textbox", { name: "Answer" }), { target: { value: "Welcome to the channel!" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(updated.revision).toBe(2));
    expect(fetcher).toHaveBeenCalledWith("/api/channels/channel-a/modules/faq/entries/entry-1", expect.objectContaining({ method: "PATCH" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Save" })).toBeDisabled());
  });
});
