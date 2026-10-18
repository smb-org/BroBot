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

const response = (overrides: Partial<DryRunResponse> = {}): DryRunResponse => ({
  evaluatedAt: "2030-01-01T12:01:00.000Z",
  controls: { muted: false, paused: false },
  sender: { userId: "dry-run:viewer_42", resolved: false, perUserCooldownsUseSyntheticId: true },
  modules: [
    {
      moduleId: "text_commands",
      status: "reacts",
      entries: [{
        moduleId: "text_commands",
        entry: { kind: "text_command", id: "discord", label: "!discord" },
        outcome: "fires",
        match: { kind: "alias", token: "dc" },
        blocks: [],
        effects: [
          {
            kind: "chat", text: "Discord: discord.gg/beispiel", target: "source_only",
            postsTo: "this_chat", reply: true, suppressedBy: null, automated: true,
          },
          { kind: "cooldown", scope: "global", seconds: 30 },
        ],
        templateNotes: [],
      }],
    },
    {
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
    },
    { moduleId: "chat_voting", status: "silent", entries: [] },
    { moduleId: "votekick", status: "not_testable", entries: [] },
  ],
  ...overrides,
});

const renderPage = (options: {
  only?: DryRunRequest["only"];
  onOpenEditor?: (moduleId: "text_commands" | "faq", entryId: string) => void;
} = {}) => render(<TestAreaPage
  channelId="channel-a"
  language="de"
  initialStreamState="online"
  {...(options.only === undefined ? {} : { only: options.only })}
  {...(options.onOpenEditor === undefined ? {} : { onOpenEditor: options.onOpenEditor })}
/>);

const run = (): void => {
  const button = screen.getAllByRole("button", { name: "Prüfen" }).at(0);
  if (button === undefined) throw new Error("The test button is missing.");
  fireEvent.click(button);
};
const firingRow = () => screen.getByRole("button", { name: /!discord/u });

describe("test area page", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
    vi.mocked(fetchChannelBroadcast).mockResolvedValue({
      title: "Demo",
      game: { id: "509658", name: "Just Chatting" },
      manageScopeAvailable: false,
    });
    vi.mocked(searchChannelGames).mockResolvedValue([]);
    vi.mocked(lookupChannelGames).mockResolvedValue([]);
    vi.mocked(dryRunChatMessage).mockResolvedValue(response());
  });

  it("keeps the reserved result slot mounted through idle, loading, result, and error", async () => {
    let finishFirst!: (value: DryRunResponse) => void;
    vi.mocked(dryRunChatMessage)
      .mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockRejectedValueOnce(new Error("offline"));
    renderPage();
    const slot = screen.getByTestId("test-area-results-slot");

    expect(slot).toHaveAttribute("data-state", "idle");
    run();
    expect(screen.getByTestId("test-area-results-slot")).toBe(slot);
    expect(slot).toHaveAttribute("data-state", "loading");
    finishFirst(response());
    await waitFor(() => expect(slot).toHaveAttribute("data-state", "result"));
    expect(screen.getByTestId("test-area-results-slot")).toBe(slot);

    run();
    await waitFor(() => expect(slot).toHaveAttribute("data-state", "error"));
    expect(screen.getByTestId("test-area-results-slot")).toBe(slot);

    fireEvent.click(screen.getByRole("button", { name: "Erneut prüfen" }));
    await waitFor(() => expect(slot).toHaveAttribute("data-state", "result"));
  });

  it("summarizes rows and keeps silent and unsupported modules in the meta line", async () => {
    renderPage();
    run();

    await waitFor(() => expect(document.querySelector(".test-area__results-title")).toHaveTextContent("1 reagiert · 1 blockiert"));
    expect(screen.getByText(/^Ohne Reaktion:/u)).toBeInTheDocument();
    expect(screen.getByText("Noch ohne Trockenlauf: Votekick")).toBeInTheDocument();
    expect(screen.queryByText("Nicht testbar")).not.toBeInTheDocument();
    expect(firingRow()).toHaveAttribute("aria-current", "true");
  });

  it("applies the broadcast game after a message edit while the broadcast request is pending", async () => {
    let resolveBroadcast!: (value: { title: string; game: { id: string; name: string }; manageScopeAvailable: boolean }) => void;
    vi.mocked(fetchChannelBroadcast).mockReturnValue(new Promise((resolve) => { resolveBroadcast = resolve; }));
    renderPage();

    const message = screen.getAllByRole("textbox", { name: "Nachricht" })[0];
    if (message === undefined) throw new Error("The message field is missing.");
    fireEvent.change(message, { target: { value: "!dc geaendert" } });

    resolveBroadcast({ title: "Demo", game: { id: "509658", name: "Just Chatting" }, manageScopeAvailable: false });
    await waitFor(() => expect(document.querySelector(".ui-game-multi-select__single-value-name")).toHaveTextContent("Just Chatting"));

    run();
    await waitFor(() => expect(dryRunChatMessage).toHaveBeenCalledWith("channel-a", expect.objectContaining({
      text: "!dc geaendert",
      game: { id: "509658", name: "Just Chatting" },
    }), expect.anything()));
  });

  it("preserves the restored history game when a pending broadcast response arrives", async () => {
    const restoredRequest: DryRunRequest = {
      text: "!dc aus verlauf",
      sender: { login: "viewer_17", statuses: ["moderator"] },
      streamState: "offline",
      game: { id: "saved-game", name: "Saved Game" },
      sharedChat: true,
    };
    sessionStorage.setItem("test-area-history:channel-a", JSON.stringify([{
      channelId: "channel-a",
      request: restoredRequest,
      createdAt: "2030-01-01T12:00:00.000Z",
    }]));
    let resolveBroadcast!: (value: { title: string; game: { id: string; name: string }; manageScopeAvailable: boolean }) => void;
    vi.mocked(fetchChannelBroadcast).mockReturnValue(new Promise((resolve) => { resolveBroadcast = resolve; }));
    renderPage();

    const replayButton = document.querySelector<HTMLButtonElement>(".test-area__history-item");
    if (replayButton === null) throw new Error("The saved history entry is missing.");
    fireEvent.click(replayButton);
    resolveBroadcast({ title: "Demo", game: { id: "current-game", name: "Current Game" }, manageScopeAvailable: false });

    await waitFor(() => expect(document.querySelector(".ui-game-multi-select__single-value-name")).toHaveTextContent("Saved Game"));
    await waitFor(() => expect(dryRunChatMessage).toHaveBeenCalledWith("channel-a", expect.objectContaining({
      text: "!dc aus verlauf",
      game: { id: "saved-game", name: "Saved Game" },
      sharedChat: true,
    }), expect.anything()));
  });

  it("keeps a user-selected game when the delayed broadcast response arrives", async () => {
    let resolveBroadcast!: (value: { title: string; game: { id: string; name: string }; manageScopeAvailable: boolean }) => void;
    vi.mocked(fetchChannelBroadcast).mockReturnValue(new Promise((resolve) => { resolveBroadcast = resolve; }));
    vi.mocked(searchChannelGames).mockResolvedValue([{ id: "manual-game", name: "Manual Game" }]);
    renderPage();

    const gameSearch = screen.getByRole("searchbox", { name: "Spiel" });
    fireEvent.focus(gameSearch);
    fireEvent.change(gameSearch, { target: { value: "Manual" } });
    fireEvent.click(await screen.findByRole("option", { name: "Manual Game" }));
    resolveBroadcast({ title: "Demo", game: { id: "current-game", name: "Current Game" }, manageScopeAvailable: false });

    await waitFor(() => expect(document.querySelector(".ui-game-multi-select__single-value-name")).toHaveTextContent("Manual Game"));
    run();
    await waitFor(() => expect(dryRunChatMessage).toHaveBeenCalledWith("channel-a", expect.objectContaining({
      game: { id: "manual-game", name: "Manual Game" },
    }), expect.anything()));
  });

  it("shows regex ranges and only the first block reason in the detail", async () => {
    const regexResponse = response({
      modules: [{
        moduleId: "faq",
        status: "blocked",
        entries: [{
          moduleId: "faq",
          entry: { kind: "faq_entry", id: "faq-regex", label: "Regex-Regel" },
          outcome: "blocked",
          match: { kind: "regex", pattern: "hallo", ranges: [[4, 9]] },
          blocks: [
            { code: "faq.person_cooldown", detail: { remainingSeconds: 42 } },
            { code: "faq.cooldown", detail: { remainingSeconds: 30 } },
          ],
          effects: [],
          templateNotes: [],
        }],
      }],
    });
    vi.mocked(dryRunChatMessage).mockResolvedValue(regexResponse);
    renderPage();
    run();
    const row = await screen.findByRole("button", { name: /Regex-Regel/u });
    fireEvent.click(row);

    expect(await screen.findByRole("heading", { name: "Regex-Regel" })).toBeInTheDocument();
    expect(screen.getByText("hallo", { selector: "mark" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Blockiert" })).toBeInTheDocument();
    const detail = document.querySelector(".test-area__detail");
    expect(detail).toHaveTextContent(/noch 42 s/u);
    expect(detail).not.toHaveTextContent(/30 s/u);
    expect(screen.queryByRole("heading", { name: "Würde tun" })).not.toBeInTheDocument();
  });

  it("shows the mute chip only for a muted result and explains the suppressed answer", async () => {
    const mutedResponse = response({
      controls: { muted: true, paused: false },
      modules: [{
        moduleId: "text_commands",
        status: "reacts",
        entries: [{
          moduleId: "text_commands",
          entry: { kind: "text_command", id: "discord", label: "!discord" },
          outcome: "fires",
          match: { kind: "alias", token: "dc" },
          blocks: [],
          effects: [{
            kind: "chat", text: "Discord: discord.gg/beispiel", target: "source_only",
            postsTo: "this_chat", reply: true, suppressedBy: "channel_muted", automated: true,
          }],
          templateNotes: [],
        }],
      }],
    });
    vi.mocked(dryRunChatMessage).mockResolvedValue(mutedResponse);
    renderPage();
    run();

    expect(await screen.findByText("Stumm")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /!discord/u }));
    expect(await screen.findByText("Würde nicht gesendet: Kanal ist stummgeschaltet.")).toBeInTheDocument();
    expect(screen.queryByText("Stumm")).toBeInTheDocument();
  });

  it("sends a deep-linked module and saved entry filter", async () => {
    renderPage({ only: { moduleId: "faq", entryId: "faq-a" } });
    run();

    await waitFor(() => expect(dryRunChatMessage).toHaveBeenCalledWith(
      "channel-a",
      expect.objectContaining({ only: { moduleId: "faq", entryId: "faq-a" } }),
      expect.anything(),
    ));
  });

  it("opens the matching saved entry in its editor", async () => {
    const onOpenEditor = vi.fn();
    renderPage({ onOpenEditor });
    run();
    fireEvent.click(await screen.findByRole("button", { name: /!discord/u }));
    fireEvent.click(await screen.findByRole("button", { name: "Im Editor öffnen" }));

    expect(onOpenEditor).toHaveBeenCalledWith("text_commands", "discord");
  });
});
