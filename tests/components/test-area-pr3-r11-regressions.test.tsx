import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dryRunChatMessage, fetchChannelBroadcast, lookupChannelGames, searchChannelGames } from "../../src/dashboard/api";
import type { DryRunModuleReport, DryRunRequest, DryRunResponse } from "../../src/contracts/dry-run";
import { TestAreaPage } from "../../src/dashboard/TestAreaPage";

vi.mock("../../src/dashboard/api", () => ({
  dryRunChatMessage: vi.fn(),
  fetchChannelBroadcast: vi.fn(),
  lookupChannelGames: vi.fn(),
  searchChannelGames: vi.fn(),
}));

const ballotReport = (
  moduleId: "chat_voting" | "votekick",
  ballotOverrides: { choice?: string; choiceKind?: "option" | "term"; label?: string; untitled?: boolean } = {},
): DryRunModuleReport => {
  const report = moduleId === "chat_voting" ? {
    moduleId,
    status: "reacts" as const,
    entries: [{
      moduleId,
      entry: { kind: "chat_vote" as const, id: "chat-vote-message", label: "Stimme !vote 2" },
      outcome: "fires" as const,
      match: { kind: "command_name" as const, token: "!vote" },
      blocks: [],
      effects: [{ kind: "ballot" as const, moduleId, action: "count" as const, label: ballotOverrides.label ?? "Abstimmung", choice: ballotOverrides.choice ?? "2", counts: [1, 0], ...ballotOverrides }],
      templateNotes: [],
    }],
  } : {
    moduleId,
    status: "reacts" as const,
    entries: [{
      moduleId,
      entry: { kind: "votekick" as const, id: "votekick-message", label: "!votekick viewer_9" },
      outcome: "fires" as const,
      match: { kind: "command_name" as const, token: "!votekick" },
      blocks: [],
      effects: [{ kind: "ballot" as const, moduleId, action: "count" as const, label: "viewer_9", choice: "yes", counts: [1, 0] }],
      templateNotes: [],
    }],
  };
  return report;
};

const responseFor = (module: DryRunModuleReport): DryRunResponse => ({
  evaluatedAt: "2030-01-01T12:01:00.000Z",
  controls: { muted: false, paused: false },
  sender: { userId: "dry-run:viewer_42", resolved: false, perUserCooldownsUseSyntheticId: true },
  modules: [module],
});

const requiredElement = (selector: string): HTMLElement => {
  const element = document.querySelector(selector);
  if (!(element instanceof HTMLElement)) throw new Error(`Missing element: ${selector}`);
  return element;
};

const renderPage = (
  module: DryRunModuleReport,
  options: { language?: "de" | "en"; onOpenEditor?: (moduleId: NonNullable<DryRunRequest["only"]>["moduleId"], entryId: string) => void } = {},
) => {
  vi.mocked(dryRunChatMessage).mockResolvedValue(responseFor(module));
  return render(<TestAreaPage channelId="channel-a" language={options.language ?? "de"} initialStreamState="online" {...(options.onOpenEditor === undefined ? {} : { onOpenEditor: options.onOpenEditor })} />);
};

const run = async (message?: string): Promise<void> => {
  if (message !== undefined) {
    fireEvent.change(requiredElement(".test-area__context-form input"), { target: { value: message } });
  }
  fireEvent.click(requiredElement(".test-area__context-form .test-area__run-button"));
  await waitFor(() => expect(document.querySelector(".test-area__result-row")).not.toBeNull());
};

describe("Testbereich voting result regressions", () => {
  afterEach(() => {
    cleanup();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchChannelBroadcast).mockResolvedValue({ title: "Demo", game: null, manageScopeAvailable: false });
    vi.mocked(searchChannelGames).mockResolvedValue([]);
    vi.mocked(lookupChannelGames).mockResolvedValue([]);
  });

  it("describes a numeric free-text vote as a term", async () => {
    const module = ballotReport("chat_voting", { choice: "123", choiceKind: "term" });
    renderPage(module);
    await run("123");

    expect(document.querySelector(".test-area__row-main small")).toHaveTextContent("Begriff „123“");
    expect(document.querySelector(".test-area__detail")).toHaveTextContent("stimmt für den Begriff „123“");
  });

  it("localizes an untitled ballot in English result rows and details", async () => {
    const module = ballotReport("chat_voting", { untitled: true });
    renderPage(module, { language: "en" });
    await run("!vote 2");

    expect(screen.getByRole("button", { name: /Untitled vote/u })).toBeInTheDocument();
    expect(document.querySelector(".test-area__detail h2")).toHaveTextContent("Untitled vote");
  });

  it("puts the votekick target check under its own pending heading", async () => {
    const module: DryRunModuleReport = {
      moduleId: "votekick",
      status: "indeterminate",
      entries: [{
        moduleId: "votekick",
        entry: { kind: "votekick", id: "votekick-message", label: "!votekick viewer_9" },
        outcome: "indeterminate",
        match: { kind: "command_name", token: "!votekick" },
        blocks: [],
        effects: [],
        templateNotes: [{ code: "template.deferred_live", detail: { name: "votekick.target" } }],
      }],
    };
    renderPage(module);
    await run();

    const detail = requiredElement(".test-area__detail");
    expect(within(detail).getByRole("heading", { name: "Noch offen" })).toBeInTheDocument();
    expect(within(detail).queryByRole("heading", { name: "Vorlagenhinweise" })).not.toBeInTheDocument();
    expect(detail).toHaveTextContent("Das Ziel wird beim Senden geprüft.");
  });

  it.each(["chat_voting", "votekick"] as const)("opens %s settings from desktop detail", async (moduleId) => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    const onOpenEditor = vi.fn();
    renderPage(ballotReport(moduleId), { onOpenEditor });
    await run();

    fireEvent.click(within(requiredElement(".test-area__detail")).getByRole("button", { name: "Im Editor öffnen" }));
    expect(onOpenEditor).toHaveBeenCalledWith(moduleId, moduleId === "chat_voting" ? "chat-vote-message" : "votekick-message");
  });

});
