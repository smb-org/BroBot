import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";

import { PanelApiError } from "../../src/contracts/panel-error";
import { UiProvider } from "../../src/dashboard/ui";
import { runDashboardNavigationGuards } from "../../src/dashboard/ui/navigation-guard";
import type { PollsEntry, PollsRun } from "../../src/modules/polls/contracts";
import PollsPanel from "../../src/modules/polls/panel";
import { renderWithQuery } from "../query-test-utils";

const mocks = vi.hoisted(() => ({
  loadPollsState: vi.fn(),
  loadPollsHistory: vi.fn(),
  reconcilePolls: vi.fn(),
  createPollsEntry: vi.fn(),
  updatePollsEntry: vi.fn(),
  deletePollsEntry: vi.fn(),
  startPollsEntry: vi.fn(),
  endPollsRun: vi.fn(),
  lockPollsRun: vi.fn(),
  cancelPollsRun: vi.fn(),
  resolvePollsRun: vi.fn(),
  dismissPollsRun: vi.fn(),
  loadFreshPrediction: vi.fn(),
}));

vi.mock("../../src/modules/polls/panel/service", () => mocks);

const at = "2030-01-01T12:00:00.000Z";
const pollEntry: PollsEntry = {
  id: "entry-poll", kind: "poll", title: "Best snack?", choices: ["Cake", "Fruit"], durationSeconds: 60,
  channelPointsVotingEnabled: false, channelPointsPerVote: null, revision: 1,
  createdAt: at, updatedAt: at, lastStartedAt: null,
};
const predictionEntry: PollsEntry = {
  id: "entry-prediction", kind: "prediction", title: "Boss falls?", choices: ["Yes", "No"], durationSeconds: 120,
  channelPointsVotingEnabled: false, channelPointsPerVote: null, revision: 1,
  createdAt: at, updatedAt: at, lastStartedAt: null,
};
const activePoll: PollsRun = {
  id: "run-poll", kind: "poll", twitchId: "twitch-poll", entryId: pollEntry.id, source: "brobot",
  title: "Best snack?", choices: [
    { id: "cake", title: "Cake", votes: 8, users: null, channelPoints: 0 },
    { id: "fruit", title: "Fruit", votes: 2, users: null, channelPoints: 0 },
  ], status: "active", startedAt: at, endsAt: "2030-01-01T12:01:00.000Z", lockedAt: null,
  endedAt: null, winningChoiceId: null, refundDeadline: null, lastEventAt: at, dismissedAt: null,
};
const activePrediction: PollsRun = {
  id: "run-prediction", kind: "prediction", twitchId: "twitch-prediction", entryId: predictionEntry.id, source: "twitch",
  title: "Boss falls?", choices: [
    { id: "falls", title: "Boss falls", votes: null, users: 3, channelPoints: 250 },
    { id: "lives", title: "Boss lives", votes: null, users: 1, channelPoints: 50 },
  ], status: "active", startedAt: at, endsAt: "2030-01-01T12:02:00.000Z", lockedAt: null,
  endedAt: null, winningChoiceId: null, refundDeadline: "2030-01-02T12:00:00.000Z", lastEventAt: at, dismissedAt: null,
};
const lockedPrediction: PollsRun = {
  ...activePrediction, id: "run-locked", status: "locked", lockedAt: "2030-01-01T12:02:00.000Z",
};
const state = (overrides: Partial<{ poll: PollsRun | null; prediction: PollsRun | null; open: PollsRun[]; entries: PollsEntry[] }> = {}) => ({
  active: { poll: overrides.poll ?? null, prediction: overrides.prediction ?? null },
  open: overrides.open ?? [],
  entries: overrides.entries ?? [],
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

beforeEach(() => {
  mocks.loadPollsState.mockResolvedValue(state());
  mocks.loadPollsHistory.mockResolvedValue({ runs: [], nextCursor: null });
  mocks.reconcilePolls.mockResolvedValue(undefined);
  mocks.createPollsEntry.mockResolvedValue(pollEntry);
  mocks.updatePollsEntry.mockResolvedValue(pollEntry);
  mocks.deletePollsEntry.mockResolvedValue(undefined);
  mocks.startPollsEntry.mockResolvedValue(activePoll);
  mocks.endPollsRun.mockResolvedValue(activePoll);
  mocks.lockPollsRun.mockResolvedValue(lockedPrediction);
  mocks.cancelPollsRun.mockResolvedValue(lockedPrediction);
  mocks.resolvePollsRun.mockResolvedValue(lockedPrediction);
  mocks.dismissPollsRun.mockResolvedValue(undefined);
  mocks.loadFreshPrediction.mockResolvedValue(activePrediction);
});

const mount = (canOperate = false) => renderWithQuery(
  <UiProvider><PollsPanel channelId="channel-demo" language="de" canOperate={canOperate} /></UiProvider>,
);

describe("polls panel", () => {
  it("keeps both run slots present when empty and renders active and locked runs in their sections", async () => {
    const view = mount();
    expect(await screen.findByText("Keine Umfrage aktiv")).toBeVisible();
    expect(screen.getByText("Keine Prediction aktiv")).toBeVisible();

    mocks.loadPollsState.mockResolvedValue(state({ poll: activePoll, prediction: activePrediction, open: [lockedPrediction] }));
    view.unmount();
    const activeView = mount();
    const running = await screen.findByRole("region", { name: "Läuft gerade" });
    expect(await within(running).findByText("Best snack?")).toBeVisible();
    expect(within(running).getByText("Boss falls?")).toBeVisible();
    const open = screen.getByRole("region", { name: "Offene Predictions" });
    expect(within(open).getByText("Boss falls?")).toBeVisible();
    expect(within(open).getByText(/2030/u)).toBeVisible();
    activeView.unmount();
  });

  it("shows why starting an entry is disabled while a run of that kind is active", async () => {
    mocks.loadPollsState.mockResolvedValue(state({ poll: activePoll, entries: [pollEntry] }));
    mount(true);
    const row = await screen.findByRole("article", { name: "Best snack?" });
    expect(within(row).getByRole("button", { name: "Starten" })).toBeDisabled();
    expect(within(row).getByText("Es läuft bereits eine Umfrage.")).toBeVisible();
  });

  it("shows Twitch limit counters and maps server validation errors to the matching field", async () => {
    mocks.createPollsEntry.mockRejectedValue(new PanelApiError(422, "polls_invalid_entry", {
      error: "polls_invalid_entry", fields: [{ path: ["title"], message: "Invalid title." }],
    }));
    mount(true);
    const newButton = await screen.findByRole("button", { name: "Neu" });
    await waitFor(() => { expect(newButton).toBeEnabled(); });
    fireEvent.click(newButton);
    const dialog = await screen.findByRole("dialog", { name: "Neuer Eintrag" });
    expect(within(dialog).getByText("0 / 60")).toBeVisible();
    fireEvent.change(within(dialog).getByLabelText("Titel"), { target: { value: "Beste Snacks" } });
    fireEvent.change(within(dialog).getByLabelText("Antwort 1"), { target: { value: "Kuchen" } });
    fireEvent.change(within(dialog).getByLabelText("Antwort 2"), { target: { value: "Obst" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Speichern" }));
    expect(await within(dialog).findByText("Twitch hat diesen Titel abgelehnt. Prüfe die Länge und den Inhalt." )).toBeVisible();
  });

  it("names the selected outcome in the resolve confirmation button", async () => {
    mocks.loadPollsState.mockResolvedValue(state({ prediction: activePrediction }));
    mount(true);
    fireEvent.click(await screen.findByRole("button", { name: "Auflösen …" }));
    const dialog = await screen.findByRole("dialog", { name: "Prediction auflösen" });
    expect(mocks.loadFreshPrediction).toHaveBeenCalledWith("channel-demo", activePrediction.id, expect.any(AbortSignal));
    fireEvent.click(await within(dialog).findByRole("radio", { name: /Boss falls/u }));
    expect(within(dialog).getByRole("button", { name: "„Boss falls“ auszahlen" })).toBeVisible();
  });

  it("reconciles once on mount for operators with an open run, but not for read-only members", async () => {
    mocks.loadPollsState.mockResolvedValue(state({ poll: activePoll }));
    mount(true);
    await waitFor(() => expect(mocks.reconcilePolls).toHaveBeenCalledTimes(1));
    expect(mocks.reconcilePolls).toHaveBeenCalledWith("channel-demo", false);

    cleanup();
    vi.clearAllMocks();
    mocks.loadPollsState.mockResolvedValue(state({ poll: activePoll }));
    mount(false);
    await screen.findByText("Best snack?");
    expect(mocks.reconcilePolls).not.toHaveBeenCalled();
  });

  const openCreateDialog = async () => {
    const newButton = await screen.findByRole("button", { name: "Neu" });
    await waitFor(() => { expect(newButton).toBeEnabled(); });
    fireEvent.click(newButton);
    return screen.findByRole("dialog", { name: "Neuer Eintrag" });
  };

  it("keeps focus and the full text while typing several characters into a choice", async () => {
    mocks.loadPollsHistory.mockResolvedValue({ runs: [], nextCursor: null });
    mount(true);
    const dialog = await openCreateDialog();
    const input = within(dialog).getByLabelText("Antwort 1");
    input.focus();
    let text = "";
    for (const character of "Kuchen") {
      text += character;
      fireEvent.change(within(dialog).getByLabelText("Antwort 1"), { target: { value: text } });
    }
    const after = within(dialog).getByLabelText("Antwort 1");
    expect(after).toBe(input);
    expect(after).toHaveFocus();
    expect(after).toHaveValue("Kuchen");
  });

  it("asks for confirmation when navigating away with a dirty editor", async () => {
    mocks.loadPollsHistory.mockResolvedValue({ runs: [], nextCursor: null });
    mount(true);
    const dialog = await openCreateDialog();
    fireEvent.change(within(dialog).getByLabelText("Titel"), { target: { value: "Beste Snacks" } });
    const proceed = vi.fn();
    const cancel = vi.fn();
    runDashboardNavigationGuards(proceed, cancel);
    expect(proceed).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /Verwerfen/u })).toBeVisible();
  });

  it("refetches the state query on the fallback interval while realtime is disconnected", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval"], shouldAdvanceTime: true });
    try {
      mocks.loadPollsHistory.mockResolvedValue({ runs: [], nextCursor: null });
      mount(true);
      await screen.findByRole("region", { name: "Läuft gerade" });
      await waitFor(() => { expect(mocks.loadPollsState).toHaveBeenCalledTimes(1); });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(mocks.loadPollsState.mock.calls.length).toBeGreaterThan(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("saves a duplicated entry without further edits", async () => {
    mocks.loadPollsState.mockResolvedValue(state({ entries: [pollEntry] }));
    mocks.loadPollsHistory.mockResolvedValue({ runs: [], nextCursor: null });
    mocks.createPollsEntry.mockResolvedValue(pollEntry);
    mount(true);
    const duplicate = await screen.findByRole("button", { name: "Duplizieren" });
    fireEvent.click(duplicate);
    const dialog = await screen.findByRole("dialog", { name: "Neuer Eintrag" });
    const save = within(dialog).getByRole("button", { name: "Speichern" });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => { expect(mocks.createPollsEntry).toHaveBeenCalledTimes(1); });
  });
});
