import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MantineProvider } from "@mantine/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { jsonResponse } from "../unit/fixtures";
import { renderWithQuery } from "../query-test-utils";
import TextLibraryPanel from "../../src/modules/text_library/panel";

const initialLanguage = Object.getOwnPropertyDescriptor(window.navigator, "language");

const libraryFetcher = (
  blocks: readonly Record<string, unknown>[] = [],
  usages: Record<string, unknown> = {},
): ReturnType<typeof vi.fn<typeof fetch>> => vi.fn<typeof fetch>((input) => {
  const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
  if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
  if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
  if (url.pathname.endsWith("/settings")) return Promise.resolve(jsonResponse({ timeZone: "UTC", revision: 1 }));
  if (url.pathname.endsWith("/template-preview")) return Promise.resolve(jsonResponse({ text: "", diagnostics: [] }));
  return Promise.resolve(jsonResponse({
    blocks,
    categories: [{ id: "social", catalogKey: "social", customName: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
    settings: { revision: 1, graphRevision: 1, updatedAt: "2026-01-01T00:00:00.000Z" },
    usages,
    reservedNames: [],
  }));
});

const waitForLibraryLoad = async (): Promise<void> => {
  await waitFor(() => expect(document.querySelector(".collection-page__list-content .ui-load-state")).not.toBeInTheDocument());
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  if (initialLanguage !== undefined) Object.defineProperty(window.navigator, "language", initialLanguage);
});

describe("Text library panel layout slots", () => {
  it("keeps the heading and disabled toolbar mounted while loading and after a load failure", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.reject(new Error("offline"))));
    renderWithQuery(<MantineProvider><TextLibraryPanel channelId="channel-a" language="en" /></MantineProvider>);

    expect(screen.getByRole("heading", { level: 1, name: "Text blocks" })).toBeInTheDocument();
    const addButton = screen.getByRole("button", { name: "Add text block" });
    expect(addButton).toBeDisabled();
    expect(document.querySelector(".list-toolbar__status")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector(".collection-page__list-content .ui-load-state")).toHaveAttribute("data-status", "error"));
    expect(screen.getByRole("heading", { level: 1, name: "Text blocks" })).toBeInTheDocument();
    expect(addButton).toBeDisabled();
  });

  it.each([
    { browserLanguage: "de-DE", panelLanguage: "en" as const, search: "Search text blocks", clear: "Clear search", usage: "0 of 200 text blocks used" },
    { browserLanguage: "en-US", panelLanguage: "de" as const, search: "Textbausteine suchen", clear: "Suche leeren", usage: "0 von 200 Textbausteinen belegt" },
  ])("uses $panelLanguage for common toolbar text when the browser is $browserLanguage", async ({ browserLanguage, panelLanguage, search, clear, usage }) => {
    Object.defineProperty(window.navigator, "language", { configurable: true, value: browserLanguage });
    vi.stubGlobal("fetch", libraryFetcher());
    renderWithQuery(<MantineProvider><TextLibraryPanel channelId="channel-a" language={panelLanguage} /></MantineProvider>);
    await waitFor(() => expect(document.querySelector(".list-toolbar__usage")).toHaveTextContent(usage));

    const searchInput = document.querySelector<HTMLInputElement>(".text-library__list-toolbar .ui-field__input--search");
    expect(searchInput).toHaveAttribute("aria-label", search);
    expect(document.querySelector(".list-toolbar__search .ui-field__clear")).toHaveAttribute("aria-label", clear);
    expect(document.querySelector(".list-toolbar__usage")).toHaveTextContent(usage);
  });

  it("keeps creation visible and disabled without a truncated operator reason", async () => {
    vi.stubGlobal("fetch", libraryFetcher());
    renderWithQuery(<MantineProvider><TextLibraryPanel channelId="channel-a" language="en" canManage={false} /></MantineProvider>);
    await waitForLibraryLoad();

    const addButton = await screen.findByRole("button", { name: "Add text block" });
    expect(addButton).toBeDisabled();
    expect(addButton).not.toHaveAttribute("aria-describedby");
    expect(document.querySelector(".list-toolbar__reason")).not.toBeInTheDocument();
  });

  it("keeps the create action before the filters in the list toolbar", async () => {
    vi.stubGlobal("fetch", libraryFetcher());
    renderWithQuery(<MantineProvider><TextLibraryPanel channelId="channel-a" language="en" /></MantineProvider>);
    await waitForLibraryLoad();

    const row = document.querySelector(".text-library__list-toolbar .list-toolbar__row");
    expect(row).not.toBeNull();
    expect(Array.from(row?.children ?? []).map((child) => child.classList[0])).toEqual([
      "list-toolbar__search",
      "list-toolbar__create",
      "list-toolbar__filters",
    ]);
  });

  it("disables creation at the block limit with a visible reason", async () => {
    const blocks = Array.from({ length: 200 }, (_, index) => ({
      name: `block_${String(index + 1)}`,
      categoryId: "social",
      games: [],
      variants: [{ id: `variant_${String(index + 1)}`, conditions: {}, texts: ["Hello"] }],
      revision: 1,
    }));
    vi.stubGlobal("fetch", libraryFetcher(blocks));
    renderWithQuery(<MantineProvider><TextLibraryPanel channelId="channel-a" language="en" /></MantineProvider>);
    await screen.findByRole("button", { name: /\{text\.block_1\}/u });

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

    renderWithQuery(<MantineProvider><TextLibraryPanel channelId="channel-a" language="en" /></MantineProvider>);
    await screen.findByRole("heading", { level: 1, name: "Text blocks" });
    await waitForLibraryLoad();
    fireEvent.click(await screen.findByRole("button", { name: "Add text block" }));

    await waitFor(() => {
      expect(screen.getByTestId("text-library-preview-slot")).toBeInTheDocument();
      expect(screen.getByTestId("text-library-warning-slot")).toBeInTheDocument();
      expect(screen.getByTestId("text-library-usage-slot")).toBeInTheDocument();
    });
  });

  it("keeps a resolved text-block preview when an unrelated name edit is discarded", async () => {
    const block = {
      name: "welcome",
      categoryId: "social",
      games: [],
      variants: [{ id: "default", conditions: {}, texts: ["Hello {user}"] }],
      revision: 1,
    };
    const fallback = libraryFetcher([block]);
    let previewCalls = 0;
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/template-preview")) {
        previewCalls += 1;
        return Promise.resolve(jsonResponse({ text: "Hello Alice", diagnostics: [] }));
      }
      return fallback(input, init);
    }));
    renderWithQuery(<MantineProvider><TextLibraryPanel channelId="channel-a" language="en" /></MantineProvider>);

    const nameField = await screen.findByRole("textbox", { name: "Name" });
    expect(await screen.findByText("Hello Alice")).toBeInTheDocument();
    expect(previewCalls).toBe(1);

    fireEvent.change(nameField, { target: { value: "welcome_updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    await waitFor(() => expect(nameField).toHaveValue("welcome"));
    expect(screen.getByText("Hello Alice")).toBeInTheDocument();
    expect(previewCalls).toBe(1);
  });

  it("shows the selected text block as read-only properties for operators", async () => {
    vi.stubGlobal("fetch", libraryFetcher([{
      name: "welcome",
      categoryId: "social",
      games: [],
      variants: [{ id: "default", conditions: {}, texts: ["Welcome to chat"] }],
      revision: 1,
    }]));
    renderWithQuery(<MantineProvider><TextLibraryPanel channelId="channel-a" language="en" canManage={false} /></MantineProvider>);

    expect(await screen.findByRole("button", { name: /\{text\.welcome\}/u })).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector(".text-library__read-only-properties")).toBeInTheDocument());
    expect(document.querySelector(".text-library__read-only-properties")).toHaveTextContent("welcome");
    expect(document.querySelector(".text-library__read-only-properties")).toHaveTextContent("Welcome to chat");
    expect(document.querySelector(".page-header__lock")).toHaveTextContent("Only broadcasters and managers can change text blocks and categories.");
    expect(document.querySelectorAll(".page-header__lock")).toHaveLength(1);
    expect(document.querySelector(".text-library__editor .lock-reason")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    const deleteItem = screen.getByRole("menuitem", { name: "Delete" });
    expect(deleteItem).toHaveAttribute("aria-disabled", "true");
    expect(deleteItem).toHaveAccessibleDescription("Broadcasters and managers only");
  });

  it("guards deleting a text block while its draft has unsaved changes", async () => {
    vi.stubGlobal("fetch", libraryFetcher([{
      name: "welcome",
      categoryId: "social",
      games: [],
      variants: [{ id: "default", conditions: {}, texts: ["Welcome to chat"] }],
      revision: 1,
    }]));
    renderWithQuery(<MantineProvider><TextLibraryPanel channelId="channel-a" language="en" /></MantineProvider>);

    const nameField = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(nameField, { target: { value: "welcome_updated" } });
    fireEvent.click(screen.getByRole("button", { name: /\{text\.welcome\}/u }));
    expect(screen.queryByRole("heading", { name: "Unsaved changes" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("welcome_updated");
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));

    expect(await screen.findByRole("heading", { name: "Unsaved changes" })).toBeInTheDocument();
    expect(screen.getByText("This text block has unsaved changes. What would you like to do?")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Delete text block “welcome”?" })).not.toBeInTheDocument();
    expect(nameField).toHaveValue("welcome_updated");

    fireEvent.click(screen.getByRole("button", { name: "Continue editing" }));
    expect(screen.queryByRole("heading", { name: "Unsaved changes" })).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("welcome_updated");
  });

  it("shows blocked deletion details in the overflow menu and opens the usage dialog", async () => {
    vi.stubGlobal("fetch", libraryFetcher([{
      name: "welcome",
      categoryId: "social",
      games: [],
      variants: [{ id: "default", conditions: {}, texts: ["Welcome to chat"] }],
      revision: 1,
    }], { welcome: [{ kind: "timer", label: "Welcome timer" }, { kind: "faq", label: "Welcome FAQ" }] }));
    renderWithQuery(<MantineProvider><TextLibraryPanel channelId="channel-a" language="en" /></MantineProvider>);

    await screen.findByRole("textbox", { name: "Name" });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));

    const deleteItem = screen.getByRole("menuitem", { name: "Delete" });
    expect(deleteItem).toHaveAttribute("aria-disabled", "true");
    expect(deleteItem).toHaveAccessibleDescription("Used in 2 places");
    fireEvent.click(screen.getByRole("menuitem", { name: "Show usage" }));

    expect(await screen.findByRole("heading", { name: "Uses of “welcome” prevent deletion" })).toBeInTheDocument();
    const usageDialog = screen.getByRole("dialog");
    expect(within(usageDialog).getAllByText("Welcome timer").length).toBeGreaterThan(0);
    expect(within(usageDialog).getAllByText("Welcome FAQ").length).toBeGreaterThan(0);
  });

  it("uses neutral copy in the usage dialog when a text block has no usages", async () => {
    vi.stubGlobal("fetch", libraryFetcher([{
      name: "welcome",
      categoryId: "social",
      games: [],
      variants: [{ id: "default", conditions: {}, texts: ["Welcome to chat"] }],
      revision: 1,
    }]));
    renderWithQuery(<MantineProvider><TextLibraryPanel channelId="channel-a" language="en" /></MantineProvider>);

    await screen.findByRole("textbox", { name: "Name" });
    fireEvent.click(screen.getByRole("button", { name: "More actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Show usage" }));

    expect(await screen.findByRole("heading", { name: "Usage of “welcome”" })).toBeInTheDocument();
    const usageDialog = screen.getByRole("dialog");
    expect(within(usageDialog).getByText("This lists the places where the text block is used.")).toBeInTheDocument();
    expect(within(usageDialog).getByText("No usages yet.")).toBeInTheDocument();
    expect(screen.queryByText("This text block is in use. Remove all listed uses before deleting it.")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Uses of “welcome” prevent deletion" })).not.toBeInTheDocument();
  });

  it("does not treat a rename collision as a revision conflict", async () => {
    const block = {
      name: "welcome",
      categoryId: "social",
      games: [],
      variants: [{ id: "default", conditions: {}, texts: ["Welcome to chat"] }],
      revision: 1,
    };
    const fallback = libraryFetcher([block]);
    const fetchMock = vi.fn<typeof fetch>((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      const method = init?.method ?? "GET";
      if (url.pathname.endsWith("/blocks/welcome") && method === "PATCH") {
        return Promise.resolve(jsonResponse({ error: "text_library_block_exists" }, 409));
      }
      return fallback(input);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderWithQuery(<MantineProvider><TextLibraryPanel channelId="channel-a" language="en" /></MantineProvider>);

    const nameField = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(nameField, { target: { value: "another_name" } });
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    await waitFor(() => expect(saveButton).toBeEnabled());
    fireEvent.click(saveButton);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/blocks/welcome"), expect.objectContaining({ method: "PATCH" })));

    await waitFor(() => expect(saveButton).toBeEnabled());
    expect(saveButton).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Discard" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reload" })).not.toBeInTheDocument();
  });

  it("reloads a revision conflict from the server after the automatic refresh fails", async () => {
    const originalBlock = {
      name: "welcome",
      categoryId: "social",
      games: [],
      variants: [{ id: "default", conditions: {}, texts: ["Welcome to chat"] }],
      revision: 1,
    };
    const updatedBlock = {
      ...originalBlock,
      variants: [{ id: "default", conditions: {}, texts: ["Welcome from the server"] }],
      revision: 2,
    };
    let currentBlock = originalBlock;
    let libraryReads = 0;
    const fallback = libraryFetcher([originalBlock]);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      const method = init?.method ?? "GET";
      if (url.pathname.endsWith("/blocks/welcome") && method === "PATCH") {
        currentBlock = updatedBlock;
        return Promise.resolve(jsonResponse({ error: "text_library_block_conflict" }, 409));
      }
      if (url.pathname.endsWith("/library")) {
        libraryReads += 1;
        if (libraryReads === 2) return Promise.resolve(jsonResponse({ error: "temporarily unavailable" }, 503));
        return Promise.resolve(jsonResponse({
          blocks: [currentBlock],
          categories: [{ id: "social", catalogKey: "social", customName: null, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }],
          settings: { revision: currentBlock.revision, graphRevision: 1, updatedAt: "2026-01-01T00:00:00.000Z" },
          usages: {},
          reservedNames: [],
        }));
      }
      return fallback(input, init);
    }));
    renderWithQuery(<MantineProvider><TextLibraryPanel channelId="channel-a" language="en" /></MantineProvider>, {}, { staleTime: 60_000 });

    const nameField = await screen.findByRole("textbox", { name: "Name" });
    const textField = screen.getByRole("textbox", { name: "Text" });
    expect(textField).toHaveValue("Welcome to chat");
    fireEvent.change(nameField, { target: { value: "rejected_draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reload" }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Text" })).toHaveValue("Welcome from the server"));
    expect(libraryReads).toBeGreaterThan(2);
  });
});
