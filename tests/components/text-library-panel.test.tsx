import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { jsonResponse } from "../unit/fixtures";
import TextLibraryPanel from "../../src/modules/text_library/panel";

const initialLanguage = Object.getOwnPropertyDescriptor(window.navigator, "language");

const libraryFetcher = (blocks: readonly Record<string, unknown>[] = []): ReturnType<typeof vi.fn<typeof fetch>> => vi.fn<typeof fetch>((input) => {
  const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
  if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
  if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({ timeZone: "UTC", revision: 1 }));
  if (url.pathname.endsWith("/template-preview")) return Promise.resolve(jsonResponse({ text: "", diagnostics: [] }));
  return Promise.resolve(jsonResponse({
    blocks,
    categories: [{ id: "social", catalogKey: "social", customName: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
    settings: { revision: 1, graphRevision: 1, updatedAt: "2026-01-01T00:00:00.000Z" },
    usages: {},
    reservedNames: [],
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (initialLanguage !== undefined) Object.defineProperty(window.navigator, "language", initialLanguage);
});

describe("Text library panel layout slots", () => {
  it("keeps the heading and disabled toolbar mounted while loading and after a load failure", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.reject(new Error("offline"))));
    render(<MantineProvider><TextLibraryPanel channelId="channel-a" language="en" /></MantineProvider>);

    expect(screen.getByRole("heading", { level: 2, name: "Text blocks" })).toBeInTheDocument();
    const addButton = screen.getByRole("button", { name: "Add text block" });
    expect(addButton).toBeDisabled();
    expect(document.querySelector(".list-toolbar__status")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector(".ui-load-state")).toHaveAttribute("data-status", "error"));
    expect(screen.getByRole("heading", { level: 2, name: "Text blocks" })).toBeInTheDocument();
    expect(addButton).toBeDisabled();
  });

  it.each([
    { browserLanguage: "de-DE", panelLanguage: "en" as const, search: "Search text blocks", clear: "Clear search", usage: "0 of 200 text blocks used" },
    { browserLanguage: "en-US", panelLanguage: "de" as const, search: "Textbausteine suchen", clear: "Suche leeren", usage: "0 von 200 Textbausteine belegt" },
  ])("uses $panelLanguage for common toolbar text when the browser is $browserLanguage", async ({ browserLanguage, panelLanguage, search, clear, usage }) => {
    Object.defineProperty(window.navigator, "language", { configurable: true, value: browserLanguage });
    vi.stubGlobal("fetch", libraryFetcher());
    render(<MantineProvider><TextLibraryPanel channelId="channel-a" language={panelLanguage} /></MantineProvider>);
    await screen.findByTestId("text-library-list-slot");

    expect(await screen.findByRole("textbox", { name: search })).toBeInTheDocument();
    expect(document.querySelector(".list-toolbar__search .ui-field__clear")).toHaveAttribute("aria-label", clear);
    expect(document.querySelector(".list-toolbar__usage")).toHaveTextContent(usage);
  });

  it("keeps creation visible and states the operator lock", async () => {
    vi.stubGlobal("fetch", libraryFetcher());
    render(<MantineProvider><TextLibraryPanel channelId="channel-a" language="en" canManage={false} /></MantineProvider>);
    await screen.findByTestId("text-library-list-slot");

    const addButton = await screen.findByRole("button", { name: "Add text block" });
    expect(addButton).toBeDisabled();
    const reasonId = addButton.getAttribute("aria-describedby");
    expect(reasonId).not.toBeNull();
    const reason = document.getElementById(reasonId as string);
    expect(reason).toBeVisible();
    expect(reason).toHaveTextContent("Only broadcasters and managers may add text blocks.");
    expect(reason).not.toHaveAttribute("aria-hidden");
  });

  it("disables creation at the block limit with a visible reason", async () => {
    const blocks = Array.from({ length: 200 }, (_, index) => ({
      name: `block_${String(index + 1)}`,
      categoryId: "social",
      variants: [{ id: `variant_${String(index + 1)}`, conditions: {}, texts: ["Hello"] }],
      revision: 1,
    }));
    vi.stubGlobal("fetch", libraryFetcher(blocks));
    render(<MantineProvider><TextLibraryPanel channelId="channel-a" language="en" /></MantineProvider>);
    await screen.findByTestId("text-library-list-slot");

    const addButton = await screen.findByRole("button", { name: "Add text block" });
    expect(addButton).toBeDisabled();
    const reasonId = addButton.getAttribute("aria-describedby");
    expect(reasonId).not.toBeNull();
    const reason = document.getElementById(reasonId as string);
    expect(reason).toBeVisible();
    expect(reason).toHaveTextContent("200 of 200 used: limit reached.");
    expect(reason).not.toHaveAttribute("aria-hidden");
  });

  it("keeps the preview, warning, and usage areas mounted for an empty draft", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({ timeZone: "UTC", revision: 1 }));
      if (url.pathname.endsWith("/template-preview")) return Promise.resolve(jsonResponse({ text: "", diagnostics: [] }));
      return Promise.resolve(jsonResponse({
        blocks: [],
        categories: [{ id: "social", catalogKey: "social", customName: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
        settings: { revision: 1, graphRevision: 1, updatedAt: "2026-01-01T00:00:00.000Z" },
        usages: {},
        reservedNames: [],
      }));
    }));

    render(<MantineProvider><TextLibraryPanel channelId="channel-a" language="en" /></MantineProvider>);
    await screen.findByTestId("text-library-list-slot");
    fireEvent.click(await screen.findByRole("button", { name: "Add text block" }));

    await waitFor(() => {
      expect(screen.getByTestId("text-library-preview-slot")).toBeInTheDocument();
      expect(screen.getByTestId("text-library-warning-slot")).toBeInTheDocument();
      expect(screen.getByTestId("text-library-usage-slot")).toBeInTheDocument();
    });
  });
});
