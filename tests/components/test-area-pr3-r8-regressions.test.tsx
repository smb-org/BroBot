import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dryRunChatMessage, fetchChannelBroadcast, lookupChannelGames, searchChannelGames } from "../../src/dashboard/api";
import type { DryRunRequest, DryRunResponse } from "../../src/contracts/dry-run";
import { TestAreaPage } from "../../src/dashboard/TestAreaPage";

vi.mock("../../src/dashboard/api", () => ({
  dryRunChatMessage: vi.fn(),
  fetchChannelBroadcast: vi.fn(),
  lookupChannelGames: vi.fn(),
  searchChannelGames: vi.fn(),
}));

const faqResponse = (): DryRunResponse => ({
  evaluatedAt: "2030-01-01T12:01:00.000Z",
  controls: { muted: false, paused: false },
  sender: { userId: "dry-run:viewer_42", resolved: false, perUserCooldownsUseSyntheticId: true },
  modules: [{
    moduleId: "faq",
    status: "blocked",
    entries: [{
      moduleId: "faq",
      entry: { kind: "faq_entry", id: "faq-a", label: "Begrüßung" },
      outcome: "blocked",
      match: { kind: "keyword", pattern: "hallo" },
      blocks: [{ code: "faq.person_cooldown", detail: { remainingSeconds: 42 } }],
      effects: [],
      templateNotes: [],
    }],
  }],
});

const savedRequest = (only: DryRunRequest["only"]): DryRunRequest => ({
  text: "!dc hallo",
  sender: { login: "viewer_17", statuses: ["moderator"] },
  streamState: "offline",
  game: null,
  sharedChat: false,
  ...(only === undefined ? {} : { only }),
});

const saveHistory = (request: DryRunRequest): void => {
  sessionStorage.setItem("test-area-history:channel-a", JSON.stringify([{
    channelId: "channel-a",
    request,
    createdAt: "2030-01-01T12:00:00.000Z",
  }]));
};

const renderPage = () => render(<TestAreaPage channelId="channel-a" language="de" initialStreamState="online" />);

const selectModule = async (label: string): Promise<void> => {
  fireEvent.click(screen.getByRole("combobox", { name: "Module" }));
  const option = await screen.findByRole("option", { name: label });
  fireEvent.pointerDown(option, { pointerId: 1, pointerType: "mouse", button: 0 });
  fireEvent.click(option);
};

const run = (): void => {
  const button = screen.getAllByRole("button", { name: "Prüfen" })[0];
  if (button === undefined) throw new Error("The test button is missing.");
  fireEvent.click(button);
};

describe("Testbereich result scope and history replay", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
    vi.mocked(fetchChannelBroadcast).mockResolvedValue({ title: "Demo", game: null, manageScopeAvailable: false });
    vi.mocked(searchChannelGames).mockResolvedValue([]);
    vi.mocked(lookupChannelGames).mockResolvedValue([]);
    vi.mocked(dryRunChatMessage).mockResolvedValue(faqResponse());
  });

  it("keeps FAQ results in their original slot when the module filter changes", async () => {
    renderPage();
    await selectModule("FAQ");
    run();

    const slot = await screen.findByTestId("test-area-results-slot");
    await screen.findByRole("button", { name: /Begrüßung/u });

    await selectModule("Textbefehle");

    const hint = screen.getByTestId("test-area-stale-result-hint");
    expect(screen.getByTestId("test-area-results-slot")).toBe(slot);
    expect(hint).toHaveAttribute("data-visible", "true");
    expect(hint).toHaveTextContent("Eingaben geändert – Prüfen aktualisiert das Ergebnis");
    expect(slot).toHaveAttribute("data-state", "result");
    expect(screen.getByRole("button", { name: /Begrüßung/u })).toBeInTheDocument();
    expect(screen.queryByText("Keine Reaktion gefunden")).not.toBeInTheDocument();
  });

  it("marks the displayed result stale when a non-module input changes", async () => {
    renderPage();
    await selectModule("FAQ");
    run();

    const slot = await screen.findByTestId("test-area-results-slot");
    await screen.findByRole("button", { name: /Begrüßung/u });
    const sender = screen.getAllByRole("textbox", { name: "Absender" })[0];
    if (sender === undefined) throw new Error("The sender field is missing.");
    fireEvent.change(sender, { target: { value: "viewer_99" } });

    const hint = screen.getByTestId("test-area-stale-result-hint");
    expect(screen.getByTestId("test-area-results-slot")).toBe(slot);
    expect(hint).toHaveAttribute("data-visible", "true");
    expect(screen.getByRole("button", { name: /Begrüßung/u })).toBeInTheDocument();
  });

  it("replays a module-only history entry without locking the module selector", async () => {
    saveHistory(savedRequest({ moduleId: "faq" }));
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "!dc hallo von viewer_17 erneut prüfen" }));

    await waitFor(() => expect(dryRunChatMessage).toHaveBeenCalled());
    expect(screen.getByRole("combobox", { name: "Module" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Eintragsfilter aufheben" })).not.toBeInTheDocument();
  });

  it("keeps the module selector locked for an entry-specific history replay", async () => {
    saveHistory(savedRequest({ moduleId: "faq", entryId: "faq-a" }));
    renderPage();

    fireEvent.click(screen.getByRole("button", { name: "!dc hallo von viewer_17 erneut prüfen" }));

    await waitFor(() => expect(dryRunChatMessage).toHaveBeenCalledWith(
      "channel-a",
      expect.objectContaining({ only: { moduleId: "faq", entryId: "faq-a" } }),
      expect.anything(),
    ));
    expect(screen.getByRole("combobox", { name: "Module" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Eintragsfilter aufheben" })).toBeInTheDocument();
  });
});
