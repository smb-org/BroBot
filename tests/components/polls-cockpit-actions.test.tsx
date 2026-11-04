import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImmediateActions } from "../../src/dashboard/ImmediateActions";
import { moduleQueryKey } from "../../src/dashboard/data";
import { setDashboardRealtimeStatus } from "../../src/dashboard/data/realtime";
import { UiProvider } from "../../src/dashboard/ui";
import type { PollsEntry, PollsRun } from "../../src/modules/polls/contracts";
import PollsCockpitResolveActionContent from "../../src/modules/polls/panel/resolve-cockpit-action-content";
import { loadFreshPrediction, loadPollsActionReadiness, loadPollsState, reconcilePolls, resolvePollsRun, startPollsEntry } from "../../src/modules/polls/panel/service";
import PollsCockpitStartActionContent from "../../src/modules/polls/panel/cockpit-action-content";
import type { PollsPanelState } from "../../src/modules/polls/panel/service";
import { clickSelectOption, renderWithQuery } from "../query-test-utils";

vi.mock("../../src/modules/polls/panel/service", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  loadFreshPrediction: vi.fn(),
  loadPollsActionReadiness: vi.fn(),
  loadPollsState: vi.fn(),
  reconcilePolls: vi.fn(),
  resolvePollsRun: vi.fn(),
  startPollsEntry: vi.fn(),
}));

const startedAt = "2030-01-01T12:00:00.000Z";

const pollEntry: PollsEntry = {
  id: "prepared-poll",
  kind: "poll",
  title: "Mittagspause?",
  choices: ["Ja", "Nein"],
  durationSeconds: 60,
  channelPointsVotingEnabled: false,
  channelPointsPerVote: null,
  revision: 1,
  createdAt: startedAt,
  updatedAt: startedAt,
  lastStartedAt: null,
};

const predictionEntry: PollsEntry = {
  ...pollEntry,
  id: "prepared-prediction",
  kind: "prediction",
  title: "Fällt der Boss?",
  durationSeconds: 120,
  channelPointsVotingEnabled: false,
  channelPointsPerVote: null,
};

const openPrediction: PollsRun = {
  id: "open-prediction",
  kind: "prediction",
  twitchId: "twitch-prediction-fictional",
  entryId: null,
  source: "twitch",
  title: "Fällt der Boss?",
  choices: [
    { id: "boss-falls", title: "Boss fällt", votes: null, users: 4, channelPoints: 350 },
    { id: "boss-lives", title: "Boss bleibt", votes: null, users: 2, channelPoints: 100 },
  ],
  status: "active",
  startedAt,
  endsAt: "2030-01-01T12:03:00.000Z",
  lockedAt: null,
  endedAt: null,
  winningChoiceId: null,
  refundDeadline: null,
  lastEventAt: startedAt,
  dismissedAt: null,
};

const stateWith = (entries: PollsEntry[] = [], prediction: PollsRun | null = null): PollsPanelState => ({
  active: { poll: null, prediction },
  open: [],
  entries,
});

const renderPollsActions = () => renderWithQuery(
  <UiProvider><ImmediateActions
    channelId="channel-polls"
    streamState="online"
    role="operator"
    modules={[{ id: "polls", enabled: true }]}
  /></UiProvider>,
);

afterEach(() => {
  cleanup();
  localStorage.clear();
  setDashboardRealtimeStatus("channel-polls", "offline");
});

beforeEach(() => {
  vi.mocked(loadPollsActionReadiness).mockReset().mockResolvedValue({ ready: true, missingScopes: [], metadataUnknown: false });
  vi.mocked(loadPollsState).mockReset().mockResolvedValue(stateWith());
  vi.mocked(reconcilePolls).mockReset().mockResolvedValue();
  vi.mocked(loadFreshPrediction).mockReset().mockResolvedValue(openPrediction);
  vi.mocked(startPollsEntry).mockReset().mockResolvedValue({ ...openPrediction, id: "started-poll", kind: "poll" });
  vi.mocked(resolvePollsRun).mockReset().mockResolvedValue({ ...openPrediction, status: "resolved", winningChoiceId: "boss-falls" });
});

describe("polls cockpit actions", () => {
  it("disables the start action with the missing broadcaster scope reason", async () => {
    vi.mocked(loadPollsActionReadiness).mockResolvedValue({
      ready: false,
      missingScopes: ["channel:manage:polls"],
      metadataUnknown: false,
    });
    renderPollsActions();

    const startAction = await screen.findByRole("button", { name: /Umfrage\/Prediction starten|Start poll\/prediction/u });
    await waitFor(() => expect((startAction as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText(/channel:manage:polls/u)).not.toBeNull();
  });

  it("keeps the start action unavailable when broadcaster scope metadata is unknown", async () => {
    vi.mocked(loadPollsActionReadiness).mockResolvedValue({ ready: false, missingScopes: [], metadataUnknown: true });
    renderPollsActions();

    const startAction = await screen.findByRole("button", { name: /Umfrage\/Prediction starten|Start poll\/prediction/u });
    await waitFor(() => expect((startAction as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText(/Broadcaster-Berechtigungen konnten nicht geprüft werden|Broadcaster permissions could not be checked/u)).not.toBeNull();
  });

  it("filters prepared entries by search and kind and starts the chosen entry", async () => {
    vi.mocked(loadPollsState).mockResolvedValue({
      active: { poll: {
      ...openPrediction,
      id: "active-poll",
      kind: "poll",
      title: "Andere Umfrage",
      status: "active",
      }, prediction: null },
      open: [],
      entries: [pollEntry, predictionEntry],
    });
    renderPollsActions();

    const startAction = await screen.findByRole("button", { name: /Umfrage\/Prediction starten|Start poll\/prediction/u });
    await waitFor(() => expect((startAction as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(startAction);

    await screen.findByRole("dialog", { name: /Umfrage\/Prediction starten|Start poll\/prediction/u });
    const search = await screen.findByRole("textbox", { name: /Einträge suchen|Search entries/u });
    fireEvent.change(search, { target: { value: "Boss" } });
    expect(screen.queryByRole("article", { name: "Mittagspause?" })).toBeNull();
    expect(screen.getByRole("article", { name: "Fällt der Boss?" })).not.toBeNull();

    fireEvent.change(search, { target: { value: "" } });
    const filter = screen.getByRole("group", { name: /Eintragstyp|Entry type/u });
    fireEvent.click(within(filter).getByRole("button", { name: /Predictions/u }));
    expect(screen.queryByRole("article", { name: "Mittagspause?" })).toBeNull();
    expect(screen.getByRole("article", { name: "Fällt der Boss?" })).not.toBeNull();

    const busyReason = /Es läuft bereits eine Umfrage\.|A poll is already running\./u;
    fireEvent.click(within(filter).getByRole("button", { name: /Alle|All/u }));
    const pollRow = screen.getByRole("article", { name: "Mittagspause?" });
    expect(within(pollRow).getByText(busyReason)).not.toBeNull();
    expect(within(pollRow).getByRole("button", { name: /Starten|Start/u })).toHaveProperty("disabled", true);

    const predictionRow = screen.getByRole("article", { name: "Fällt der Boss?" });
    fireEvent.click(within(predictionRow).getByRole("button", { name: /Starten|Start/u }));
    await waitFor(() => expect(startPollsEntry).toHaveBeenCalledWith("channel-polls", predictionEntry.id));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Umfrage\/Prediction starten|Start poll\/prediction/u })).toBeNull());
  });

  it("keeps the start dialog open when Enter submits its search field", async () => {
    vi.mocked(loadPollsState).mockResolvedValue(stateWith([pollEntry]));
    const onActionStart = vi.fn(() => Date.now());
    renderWithQuery(<UiProvider><ImmediateActions
      channelId="channel-polls"
      streamState="online"
      role="operator"
      modules={[{ id: "polls", enabled: true }]}
      onActionStart={onActionStart}
    /></UiProvider>);

    const startAction = await screen.findByRole("button", { name: /Umfrage\/Prediction starten|Start poll\/prediction/u });
    await waitFor(() => expect(startAction).toBeEnabled());
    fireEvent.click(startAction);
    const dialog = await screen.findByRole("dialog", { name: /Umfrage\/Prediction starten|Start poll\/prediction/u });
    const search = await within(dialog).findByRole("textbox", { name: /Einträge suchen|Search entries/u });
    fireEvent.change(search, { target: { value: "Mittag" } });
    fireEvent.submit(search.closest("form") as HTMLFormElement);

    expect(await screen.findByRole("dialog", { name: /Umfrage\/Prediction starten|Start poll\/prediction/u })).toBe(dialog);
    expect(search).toHaveProperty("value", "Mittag");
    expect(onActionStart).not.toHaveBeenCalled();
    expect(startPollsEntry).not.toHaveBeenCalled();
  });

  it("reconciles a stale active run when the start dialog opens", async () => {
    const stalePoll = { ...openPrediction, id: "stale-poll", kind: "poll" as const, title: pollEntry.title };
    vi.mocked(loadPollsState).mockResolvedValue({
      active: { poll: stalePoll, prediction: null },
      open: [],
      entries: [pollEntry],
    });
    vi.mocked(reconcilePolls).mockImplementation(() => {
      vi.mocked(loadPollsState).mockResolvedValue(stateWith([pollEntry]));
      return Promise.resolve();
    });
    renderPollsActions();

    const startAction = await screen.findByRole("button", { name: /Umfrage\/Prediction starten|Start poll\/prediction/u });
    await waitFor(() => expect(startAction).toBeEnabled());
    fireEvent.click(startAction);
    const dialog = await screen.findByRole("dialog", { name: /Umfrage\/Prediction starten|Start poll\/prediction/u });
    const start = await within(dialog).findByRole("button", { name: /Starten|Start/u });

    await waitFor(() => expect(reconcilePolls).toHaveBeenCalledTimes(1));
    expect(reconcilePolls).toHaveBeenCalledWith("channel-polls", false);
    await waitFor(() => expect(start).toBeEnabled());
  });

  it("preserves valid polls data after a failed availability refresh and renders both action contents", async () => {
    const cachedState = stateWith([pollEntry], openPrediction);
    vi.mocked(loadPollsState).mockRejectedValue(new Error("Polls state refresh failed."));
    const dataKey = moduleQueryKey("channel-polls", "polls", "data");
    const { queryClient } = renderWithQuery(<UiProvider><ImmediateActions
      channelId="channel-polls"
      streamState="online"
      role="operator"
      modules={[{ id: "polls", enabled: true }]}
    /></UiProvider>, undefined, { initialData: [{ queryKey: dataKey, data: cachedState }], staleTime: 0, gcTime: 60_000 });

    await waitFor(() => expect(loadPollsState).toHaveBeenCalled());
    await waitFor(() => expect(queryClient.getQueryData(dataKey)).toEqual(cachedState));
    expect(queryClient.getQueryData(dataKey)).toEqual(cachedState);
    const resolveAction = await screen.findByRole("button", { name: /Prediction auflösen|Resolve prediction/u });
    await waitFor(() => expect(resolveAction.getAttribute("title")).toMatch(/Offene Predictions konnten nicht geprüft werden|Open predictions could not be checked/u));

    const startAction = await screen.findByRole("button", { name: /Umfrage\/Prediction starten|Start poll\/prediction/u });
    await waitFor(() => expect(startAction).toBeEnabled());
    fireEvent.click(startAction);
    const startDialog = await screen.findByRole("dialog", { name: /Umfrage\/Prediction starten|Start poll\/prediction/u });
    expect(await within(startDialog).findByRole("article", { name: pollEntry.title })).not.toBeNull();
    fireEvent.click(within(startDialog).getByRole("button", { name: /Abbrechen|Cancel/u }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Umfrage\/Prediction starten|Start poll\/prediction/u })).toBeNull());

    renderWithQuery(<UiProvider><PollsCockpitResolveActionContent channelId="channel-polls" language="en" /></UiProvider>, undefined, { queryClient });
    expect(await screen.findByRole("radio", { name: "Boss fällt" })).not.toBeNull();
    expect(queryClient.getQueryData(dataKey)).toEqual(cachedState);
  });

  it.each(["missing", "invalid"] as const)("shows error status rows when either action content receives %s state", async (stateKind) => {
    const dataKey = moduleQueryKey("channel-polls", "polls", "data");
    vi.mocked(loadPollsState).mockRejectedValue(new Error("Polls state refresh failed."));
    const initialData = stateKind === "invalid" ? [{ queryKey: dataKey, data: null }] : [];
    const { queryClient } = renderWithQuery(<UiProvider><>
      <PollsCockpitStartActionContent channelId="channel-polls" language="en" />
      <PollsCockpitResolveActionContent channelId="channel-polls" language="en" />
    </></UiProvider>, undefined, { initialData, staleTime: 0 });

    await waitFor(() => expect(loadPollsState).toHaveBeenCalled());
    expect(await screen.findAllByRole("alert")).toHaveLength(2);
    expect(queryClient.getQueryData(dataKey)).toBe(stateKind === "invalid" ? null : undefined);
  });

  it("keeps the resolve action unavailable without an open prediction and enables it when one appears", async () => {
    vi.mocked(loadPollsState).mockResolvedValue(stateWith());
    const { queryClient } = renderPollsActions();
    const resolveAction = await screen.findByRole("button", { name: /Prediction auflösen|Resolve prediction/u });
    await waitFor(() => expect((resolveAction as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText(/keine offene Prediction|no open prediction/iu)).not.toBeNull();

    vi.mocked(loadPollsState).mockResolvedValue(stateWith([], openPrediction));
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: moduleQueryKey("channel-polls", "polls", "data"), exact: true });
    });
    await waitFor(() => expect((resolveAction as HTMLButtonElement).disabled).toBe(false));
  });

  it("names the selected outcome on the resolve confirmation button", async () => {
    vi.mocked(loadPollsState).mockResolvedValue(stateWith([], openPrediction));
    renderPollsActions();

    const resolveAction = await screen.findByRole("button", { name: /Prediction auflösen|Resolve prediction/u });
    await waitFor(() => expect((resolveAction as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(resolveAction);

    const outcome = await screen.findByRole("radio", { name: "Boss fällt" });
    fireEvent.click(outcome);
    expect(screen.getByRole("button", { name: "„Boss fällt“ auszahlen" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "„Boss fällt“ auszahlen" }));
    await waitFor(() => expect(resolvePollsRun).toHaveBeenCalledWith("channel-polls", openPrediction.id, "boss-falls"));
  });

  it("lists several open predictions oldest first and lets the operator choose one", async () => {
    const olderPrediction = { ...openPrediction, id: "older-prediction", title: "Erste Prediction", startedAt: "2030-01-01T11:00:00.000Z" };
    const newerPrediction = { ...openPrediction, id: "newer-prediction", title: "Zweite Prediction", startedAt: "2030-01-01T13:00:00.000Z" };
    vi.mocked(loadPollsState).mockResolvedValue({
      active: { poll: null, prediction: olderPrediction },
      open: [newerPrediction],
      entries: [],
    });
    renderPollsActions();

    const resolveAction = await screen.findByRole("button", { name: /Prediction auflösen|Resolve prediction/u });
    await waitFor(() => expect((resolveAction as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(resolveAction);
    const predictionPicker = await screen.findByRole("combobox", { name: /Prediction auswählen|Choose a prediction/u });
    fireEvent.click(predictionPicker);
    const newerOption = await screen.findByRole("option", { name: /Zweite Prediction/u, hidden: true });
    clickSelectOption(newerOption);
    expect(loadFreshPrediction).toHaveBeenCalledWith("channel-polls", newerPrediction.id, expect.any(AbortSignal));
  });
});
