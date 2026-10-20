import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
        postsTo: "this_chat", reply: true, suppressedBy: null, automated: true,
      }],
      templateNotes: [],
    }],
  }],
  ...overrides,
});

const renderPage = (options: {
  channelId?: string;
  only?: DryRunRequest["only"];
} = {}) => render(<TestAreaPage
  channelId={options.channelId ?? "channel-a"}
  language="de"
  initialStreamState="online"
  {...(options.only === undefined ? {} : { only: options.only })}
/>);

const run = (): void => {
  const button = screen.getAllByRole("button", { name: "Prüfen" }).at(0);
  if (button === undefined) throw new Error("The test button is missing.");
  fireEvent.click(button);
};

const selectFiringRow = async (): Promise<void> => {
  fireEvent.click(await screen.findByRole("button", { name: /!discord/u }));
};

describe("test area result and channel regressions", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
    vi.mocked(fetchChannelBroadcast).mockResolvedValue({
      title: "Demo",
      game: null,
      manageScopeAvailable: false,
    });
    vi.mocked(searchChannelGames).mockResolvedValue([]);
    vi.mocked(lookupChannelGames).mockResolvedValue([]);
    vi.mocked(dryRunChatMessage).mockResolvedValue(response());
  });

  it("preserves suppression and success or failure conditions for every effect and answer", async () => {
    vi.mocked(dryRunChatMessage).mockResolvedValue(response({
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
          effects: [
            { kind: "timeout", minSeconds: 30, maxSeconds: 30, reason: "spam", suppressedBy: "channel_muted" },
            {
              kind: "chat", text: "Erfolgsantwort", target: "source_only", postsTo: "this_chat",
              reply: true, suppressedBy: "channel_muted", automated: true, when: "on_success",
            },
            {
              kind: "chat", text: "Fehlerantwort", target: "source_only", postsTo: "this_chat",
              reply: true, suppressedBy: null, automated: true, when: "on_failure",
            },
          ],
          templateNotes: [],
        }],
      }],
    }));
    renderPage();
    run();
    await selectFiringRow();

    const detail = document.querySelector(".test-area__detail-content");
    expect(detail).not.toBeNull();
    expect(detail).toHaveTextContent("30 s");
    expect(detail).toHaveTextContent("Unterdrückt: Kanal stummgeschaltet");
    expect(detail).toHaveTextContent("Nur bei Erfolg");
    expect(detail).toHaveTextContent("Nur bei Fehler");
    expect(detail).toHaveTextContent("Erfolgsantwort");
    expect(detail).toHaveTextContent("Fehlerantwort");
  });

  it("renders deferred template notes in the selected result detail", async () => {
    vi.mocked(dryRunChatMessage).mockResolvedValue(response({
      modules: [{
        moduleId: "text_commands",
        status: "reacts",
        entries: [{
          moduleId: "text_commands",
          entry: { kind: "text_command", id: "discord", label: "!discord" },
          outcome: "fires",
          match: { kind: "alias", token: "dc" },
          blocks: [],
          effects: [],
          templateNotes: [{ code: "template.deferred_live", detail: { name: "weather.condition" } }],
        }],
      }],
    }));
    renderPage();
    run();
    await selectFiringRow();

    expect(screen.getByText("wird beim Senden live ermittelt")).toBeInTheDocument();
  });

  it("keeps a polite result summary live region mounted and updates it after Enter", async () => {
    renderPage();
    const summary = screen.getByTestId("test-area-live-summary");
    expect(summary).toHaveAttribute("role", "status");
    expect(summary).toHaveAttribute("aria-live", "polite");

    const input = screen.getAllByRole("textbox", { name: "Nachricht" }).at(0);
    if (input === undefined) throw new Error("The message input is missing.");
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(dryRunChatMessage).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(summary).toHaveTextContent("1 reagiert"));
    expect(screen.getByTestId("test-area-live-summary")).toBe(summary);
  });

  it("shows module failures as incomplete results instead of a confirmed no-match state", async () => {
    vi.mocked(dryRunChatMessage).mockResolvedValue(response({
      modules: [
        { moduleId: "text_commands", status: "silent", entries: [] },
        { moduleId: "faq", status: "error", error: "module_error", entries: [] },
      ],
    }));
    renderPage();
    run();

    const hint = await screen.findByTestId("test-area-incomplete-result-hint");
    const slot = screen.getByTestId("test-area-results-slot");
    await waitFor(() => expect(hint).toHaveAccessibleName(/Ergebnis unvollständig.*Mindestens ein Modul konnte die Nachricht nicht vollständig prüfen.*Fehler bei: FAQ/u));
    expect(hint).toHaveRole("button");
    const announcement = screen.getByTestId("test-area-incomplete-result-announcement");
    expect(announcement).toHaveAttribute("role", "status");
    expect(announcement).toHaveAttribute("aria-live", "polite");
    expect(announcement).toHaveTextContent("Ergebnis unvollständig");
    expect(slot).toHaveAttribute("data-state", "incomplete");
    expect(slot).not.toHaveTextContent("Keine Reaktion gefunden");

    const silentHint = screen.getByRole("button", { name: "Ohne Reaktion: Textbefehle" });
    fireEvent.click(silentHint);
    expect(await screen.findByRole("dialog", { name: "Ohne Reaktion: Textbefehle" })).toHaveTextContent("Ohne Reaktion: Textbefehle");
    fireEvent.click(document.body);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Ohne Reaktion: Textbefehle" })).not.toBeInTheDocument());

    hint.focus();
    expect(hint).toHaveFocus();
    const focusedPopover = await screen.findByRole("dialog", { name: /Ergebnis unvollständig/u });
    expect(focusedPopover).toHaveTextContent("Mindestens ein Modul konnte die Nachricht nicht vollständig prüfen.");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Ergebnis unvollständig/u })).not.toBeInTheDocument());

    fireEvent.click(hint);
    expect(await screen.findByRole("dialog", { name: /Ergebnis unvollständig/u })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Ergebnis unvollständig/u })).not.toBeInTheDocument());
  });

  it("keeps successful rows visible when another module failed", async () => {
    const successfulModule = response().modules[0];
    if (successfulModule === undefined) throw new Error("The successful module fixture is missing.");
    vi.mocked(dryRunChatMessage).mockResolvedValue(response({
      modules: [successfulModule, { moduleId: "faq", status: "error", error: "module_error", entries: [] }],
    }));
    renderPage();
    run();

    expect(await screen.findByTestId("test-area-results-slot")).toHaveAttribute("data-state", "incomplete");
    expect(await screen.findByTestId("test-area-incomplete-result-hint")).toHaveAccessibleName(/Ergebnis unvollständig/u);
    expect(await screen.findByRole("button", { name: /!discord/u })).toBeInTheDocument();
  });

  it("stores replay history with its channel and never exposes it in another channel", async () => {
    const savedRequest: DryRunRequest = {
      text: "!hello",
      sender: { login: "viewer_17", statuses: ["moderator"] },
      streamState: "offline",
      game: null,
      sharedChat: true,
      only: { moduleId: "faq", entryId: "faq-a" },
    };
    vi.mocked(dryRunChatMessage).mockResolvedValue(response());
    const first = renderPage({ channelId: "channel-a", only: savedRequest.only });
    run();
    await waitFor(() => expect(dryRunChatMessage).toHaveBeenCalledWith("channel-a", expect.anything(), expect.anything()));
    const stored = JSON.parse(sessionStorage.getItem("test-area-history:channel-a") ?? "[]") as Array<{ channelId: string; request: DryRunRequest }>;
    expect(stored[0]).toMatchObject({ channelId: "channel-a", request: { only: { entryId: "faq-a" } } });

    first.unmount();
    renderPage({ channelId: "channel-b" });
    fireEvent.click(screen.getByRole("button", { name: "Verlauf · 0" }));
    const history = screen.getByRole("dialog", { name: "Verlauf" });
    expect(within(history).queryByRole("button", { name: /erneut prüfen/u })).not.toBeInTheDocument();
    fireEvent.click(within(history).getByRole("button", { name: "Schließen" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Verlauf" })).not.toBeInTheDocument());
    vi.clearAllMocks();
    run();
    await waitFor(() => expect(dryRunChatMessage).toHaveBeenCalledWith("channel-b", expect.anything(), expect.anything()));
    const latestRequest = vi.mocked(dryRunChatMessage).mock.calls.at(-1)?.[1];
    expect(latestRequest).not.toHaveProperty("only");
  });
});
