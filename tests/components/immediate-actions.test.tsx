import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImmediateActions } from "../../src/dashboard/ImmediateActions";
import { changeChannelVariableValue, fetchChannelOverview, fetchChannelVariables, sendTestMessage, type PanelChannelVariable } from "../../src/dashboard/api";
import { dashboardTexts } from "../../src/dashboard/locale";
import { loadTextCommandData } from "../../src/modules/text_commands/panel/service";
import { textCommandQuickActionTexts } from "../../src/modules/text_commands/panel/quick-action-locale";
import { loadUpcomingTimers, skipNextTimerOccurrence } from "../../src/modules/timers/panel/service";
import type { Timer } from "../../src/modules/timers/contracts";
import { UiProvider } from "../../src/dashboard/ui";
import { clickSelectOption } from "../query-test-utils";

vi.mock("../../src/dashboard/api", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  changeChannelVariableValue: vi.fn(),
  fetchChannelOverview: vi.fn(),
  fetchChannelVariables: vi.fn(),
  sendTestMessage: vi.fn(),
}));

vi.mock("../../src/modules/text_commands/panel/service", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  loadTextCommandData: vi.fn(),
}));

vi.mock("../../src/modules/timers/panel/service", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  loadUpcomingTimers: vi.fn(),
  skipNextTimerOccurrence: vi.fn(),
}));

const setChannelVariables = (variables: readonly PanelChannelVariable[]): void => {
  vi.mocked(fetchChannelVariables).mockResolvedValue({ count: variables.length, maximum: 50, variables });
  vi.mocked(loadTextCommandData).mockResolvedValue({ commands: [], variables: [...variables] });
};

const plannedTimer: Timer = {
  id: "timer-1",
  name: "Welcome",
  enabled: true,
  messageText: "Welcome back!",
  chatTarget: "all_chats",
  trigger: { type: "interval", live: { minutes: 10 } },
  revision: 3,
  nextRunAt: "2026-10-13T12:10:00.000Z",
  nextRunState: "live",
  lastRunAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

afterEach(() => {
  cleanup();
  localStorage.clear();
});

beforeEach(() => {
  setChannelVariables([{ channelId: "channel-a", name: "score", value: 4, description: "", resetOnStreamStart: false, createdAt: "", updatedAt: "", usages: [] }]);
  vi.mocked(changeChannelVariableValue).mockReset();
  vi.mocked(sendTestMessage).mockReset();
  vi.mocked(loadUpcomingTimers).mockClear();
  vi.mocked(loadUpcomingTimers).mockResolvedValue([plannedTimer]);
  vi.mocked(skipNextTimerOccurrence).mockReset();
});

describe("cockpit action role mirror", () => {
  it("keeps rate-limit feedback concise in German and English", () => {
    expect(textCommandQuickActionTexts.testMessage.rateLimited("27")).toEqual({ de: "Erneut in 27 s", en: "Retry in 27 s" });
  });

  it("locks manager actions for operators while keeping operator actions available", () => {
    render(
      <UiProvider>
        <ImmediateActions
          channelId="channel-a"
          streamState="online"
          role="operator"
          modules={[{ id: "ads", enabled: true }, { id: "clips", enabled: true }]}
        />
      </UiProvider>,
    );

    const adAction = screen.getByRole("button", { name: /Werbung starten|Start ad break/u });
    const clipAction = screen.getByRole("button", { name: /Clip erstellen|Create clip/u });
    expect((adAction as HTMLButtonElement).disabled).toBe(true);
    expect(adAction.getAttribute("aria-haspopup")).toBe("dialog");
    expect((clipAction as HTMLButtonElement).disabled).toBe(false);
    expect(clipAction.hasAttribute("aria-haspopup")).toBe(false);
    expect(screen.getByText(/Nur Verwalter und Broadcaster dürfen diese Aktion ausführen\.|Only managers and broadcasters may run this action\./u)).not.toBeNull();
  });

  it("increments the selected variable through the existing value route and shows its new value", async () => {
    setChannelVariables([{ channelId: "channel-a", name: "score", value: 4, description: "Score", resetOnStreamStart: false, createdAt: "", updatedAt: "", usages: [] }]);
    vi.mocked(changeChannelVariableValue).mockResolvedValue({
      variable: { channelId: "channel-a", name: "score", value: 5, description: "Score", resetOnStreamStart: false, createdAt: "", updatedAt: "" },
    });
    vi.mocked(fetchChannelOverview).mockResolvedValue({ bot: { status: "connected", reason: null, updatedAt: "" } } as never);

    render(<UiProvider><ImmediateActions channelId="channel-a" streamState="online" role="operator"
      modules={[{ id: "text_commands", enabled: true }]} botConnected />
    </UiProvider>);

    const action = await screen.findByRole("button", { name: /Counter \+1|Zähler \+1/u });
    await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(action);
    const picker = await screen.findByRole("combobox", { name: /variable/iu });
    fireEvent.click(picker);
    clickSelectOption(await screen.findByRole("option", { name: /score/iu, hidden: true }));
    fireEvent.click(await screen.findByRole("button", { name: dashboardTexts().streamManager.actionRun }));

    await waitFor(() => expect(changeChannelVariableValue).toHaveBeenCalledOnce());
    expect(changeChannelVariableValue).toHaveBeenCalledWith("channel-a", "score", "add", 1);
    expect((await screen.findByText(/Neuer Wert: 5|New value: 5/u)).textContent).toMatch(/Neuer Wert: 5|New value: 5/u);
  });

  it("keeps counter submission disabled and guarded until variables finish loading", async () => {
    let resolveCounterData: ((value: Awaited<ReturnType<typeof loadTextCommandData>>) => void) | undefined;
    vi.mocked(loadTextCommandData).mockImplementation(() => new Promise((resolve) => { resolveCounterData = resolve; }));
    vi.mocked(changeChannelVariableValue).mockResolvedValue({
      variable: { channelId: "channel-a", name: "score", value: 5, description: "Score", resetOnStreamStart: false, createdAt: "", updatedAt: "" },
    });
    const onActionStart = vi.fn(() => Date.now());

    render(<UiProvider><ImmediateActions channelId="channel-a" streamState="online" role="operator"
      modules={[{ id: "text_commands", enabled: true }]} botConnected onActionStart={onActionStart} />
    </UiProvider>);

    const action = await screen.findByRole("button", { name: /Counter \+1|Zähler \+1/u });
    await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(action);
    const runButton = await screen.findByRole("button", { name: dashboardTexts().streamManager.actionRun });
    await waitFor(() => expect(document.querySelector(".live-action-content--counter[aria-busy='true']")).not.toBeNull());
    const loadingCounterContent = document.querySelector<HTMLElement>(".live-action-content--counter[aria-busy='true']");
    expect(loadingCounterContent?.querySelector(".ui-field__label")?.textContent).toMatch(/Channel variable|Kanalvariable/u);
    expect(loadingCounterContent?.querySelector(".live-action-content--counter__select-skeleton")).not.toBeNull();

    expect((runButton as HTMLButtonElement).disabled).toBe(true);
    expect(runButton.getAttribute("title")).toMatch(/Loading variables|Variablen werden geladen/u);
    fireEvent.submit(runButton.closest("form") as HTMLFormElement);
    expect(onActionStart).not.toHaveBeenCalled();
    expect(changeChannelVariableValue).not.toHaveBeenCalled();

    resolveCounterData?.({ commands: [], variables: [{ name: "score", value: 4, description: "Score" }] });
    await waitFor(() => expect((runButton as HTMLButtonElement).disabled).toBe(false));
    const loadedCounterContent = document.querySelector<HTMLElement>(".live-action-content--counter[aria-busy='false']");
    expect(loadedCounterContent?.querySelector(".ui-field__label")?.textContent).toMatch(/Channel variable|Kanalvariable/u);
    expect(loadedCounterContent?.querySelector(".live-action-content--counter__select-skeleton")).toBeNull();
    fireEvent.click(runButton);

    await waitFor(() => expect(changeChannelVariableValue).toHaveBeenCalledWith("channel-a", "score", "add", 1));
    expect(onActionStart).toHaveBeenCalledOnce();
  });

  it("remembers the counter variable per channel in the picker", async () => {
    localStorage.setItem("brobot-dashboard-counter-variable-v1:channel-a", "lives");
    localStorage.setItem("brobot-dashboard-counter-variable-v1:channel-b", "score");
    setChannelVariables([
        { channelId: "channel-a", name: "score", value: 4, description: "", resetOnStreamStart: false, createdAt: "", updatedAt: "", usages: [] },
        { channelId: "channel-a", name: "lives", value: 3, description: "", resetOnStreamStart: false, createdAt: "", updatedAt: "", usages: [] },
    ]);

    render(<UiProvider><ImmediateActions channelId="channel-a" streamState="online" role="operator"
      modules={[{ id: "text_commands", enabled: true }]} botConnected />
    </UiProvider>);

    fireEvent.click(await screen.findByRole("button", { name: /Counter \+1|Zähler \+1/u }));
    const picker = await screen.findByRole("combobox", { name: /variable/iu });
    expect(picker.textContent).toContain("lives");
    fireEvent.click(picker);
    clickSelectOption(await screen.findByRole("option", { name: /score/iu, hidden: true }));
    expect(localStorage.getItem("brobot-dashboard-counter-variable-v1:channel-a")).toBe("score");
    expect(localStorage.getItem("brobot-dashboard-counter-variable-v1:channel-b")).toBe("score");
  });

  it("remembers the displayed default counter after submitting without changing it", async () => {
    localStorage.removeItem("brobot-dashboard-counter-variable-v1:channel-a");
    setChannelVariables([{ channelId: "channel-a", name: "score", value: 4, description: "", resetOnStreamStart: false, createdAt: "", updatedAt: "", usages: [] }]);
    vi.mocked(changeChannelVariableValue).mockResolvedValue({
      variable: { channelId: "channel-a", name: "score", value: 5, description: "", resetOnStreamStart: false, createdAt: "", updatedAt: "" },
    });
    vi.mocked(fetchChannelOverview).mockResolvedValue({ bot: { status: "connected", reason: null, updatedAt: "" } } as never);

    render(<UiProvider><ImmediateActions channelId="channel-a" streamState="online" role="operator"
      modules={[{ id: "text_commands", enabled: true }]} botConnected />
    </UiProvider>);

    fireEvent.click(await screen.findByRole("button", { name: /Counter \+1|Zähler \+1/u }));
    const picker = await screen.findByRole("combobox", { name: /variable/iu });
    expect(picker.textContent).toContain("score");
    fireEvent.click(await screen.findByRole("button", { name: dashboardTexts().streamManager.actionRun }));

    await waitFor(() => expect(changeChannelVariableValue).toHaveBeenCalledWith("channel-a", "score", "add", 1));
    expect(localStorage.getItem("brobot-dashboard-counter-variable-v1:channel-a")).toBe("score");
  });

  it("keeps counter and test message visible with their unavailable reasons", async () => {
    setChannelVariables([]);
    vi.mocked(fetchChannelOverview).mockResolvedValue({ bot: { status: "not_connected", reason: null, updatedAt: "" } } as never);

    render(<UiProvider><ImmediateActions channelId="channel-a" streamState="online" role="operator"
      modules={[{ id: "text_commands", enabled: true }]} botConnected={false} />
    </UiProvider>);

    const counter = await screen.findByRole("button", { name: /Counter \+1|Zähler \+1/u });
    const testMessage = await screen.findByRole("button", { name: /Send test message|Testnachricht senden/u });
    await waitFor(() => expect((counter as HTMLButtonElement).disabled).toBe(true));
    expect((testMessage as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/No numeric channel variables|Keine numerischen Kanalvariablen/u)).not.toBeNull();
    expect(screen.getByText(/bot is not connected|Bot ist nicht verbunden/u)).not.toBeNull();
  });

  it("shows the typed sent result for a test message", async () => {
    vi.mocked(sendTestMessage).mockResolvedValue({ result: "sent" });

    render(<UiProvider><ImmediateActions channelId="channel-a" streamState="online" role="operator"
      modules={[{ id: "text_commands", enabled: true }]} botConnected />
    </UiProvider>);

    const action = await screen.findByRole("button", { name: /Send test message|Testnachricht senden/u });
    await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(action);

    await waitFor(() => expect(sendTestMessage).toHaveBeenCalledWith("channel-a"));
    const feedback = await screen.findByText(/Testnachricht gesendet|Test message sent/u);
    expect(feedback.textContent).toMatch(/Testnachricht gesendet|Test message sent/u);
  });

  it("shows a short rate-limit notice with the warning tone", async () => {
    vi.mocked(sendTestMessage).mockResolvedValue({ result: "rate_limited", retryAfter: 27 });
    const onFeedbackMessage = vi.fn();

    render(<UiProvider><ImmediateActions channelId="channel-a" streamState="online" role="operator"
      modules={[{ id: "text_commands", enabled: true }]} botConnected onFeedbackMessage={onFeedbackMessage} />
    </UiProvider>);

    const action = await screen.findByRole("button", { name: /Send test message|Testnachricht senden/u });
    await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(action);

    await waitFor(() => expect(onFeedbackMessage).toHaveBeenCalledWith("Erneut in 27 s", undefined, "info"));
  });

  it("disables timer skipping with an inline reason when no occurrence is planned", async () => {
    vi.mocked(loadUpcomingTimers).mockResolvedValue([]);
    render(<UiProvider><ImmediateActions channelId="channel-a" role="operator"
      modules={[{ id: "timers", enabled: true }]} />
    </UiProvider>);

    const action = await screen.findByRole("button", { name: /Timer überspringen|Skip next timer message/u });
    await screen.findByText(/Kein Timer.*geplant|No timer.*planned/u);
    await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(true));
  });

  it("keeps timer skipping visible with a module-off reason", async () => {
    render(<UiProvider><ImmediateActions channelId="channel-a" role="operator"
      modules={[{ id: "timers", enabled: false }]} />
    </UiProvider>);

    const action = await screen.findByRole("button", { name: /Timer überspringen|Skip next timer message/u });
    await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText(dashboardTexts().streamManager.availabilityReasons.module_disabled)).not.toBeNull();
    expect(loadUpcomingTimers).not.toHaveBeenCalled();
  });

  it("requires a chosen timer and maps the skipped result to concise feedback", async () => {
    vi.mocked(skipNextTimerOccurrence).mockResolvedValue({
      result: "skipped",
      skippedOccurrenceAt: "2026-10-13T12:10:00.000Z",
      nextOccurrenceAt: "2026-10-13T12:20:00.000Z",
    });
    const onFeedbackMessage = vi.fn();
    render(<UiProvider><ImmediateActions channelId="channel-a" role="operator"
      modules={[{ id: "timers", enabled: true }]} onFeedbackMessage={onFeedbackMessage} />
    </UiProvider>);

    const action = await screen.findByRole("button", { name: /Timer überspringen|Skip next timer message/u });
    await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(action);
    const timerSelect = await screen.findByRole("combobox", { name: /Timer/u });
    await waitFor(() => expect((timerSelect as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByRole("button", { name: dashboardTexts().streamManager.actionRun }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(timerSelect);
    clickSelectOption(await screen.findByRole("option", { name: /Welcome/u, hidden: true }));
    const run = screen.getByRole("button", { name: dashboardTexts().streamManager.actionRun });
    await waitFor(() => expect((run as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(run);

    await waitFor(() => expect(skipNextTimerOccurrence).toHaveBeenCalledWith("channel-a", "timer-1"));
    expect(await screen.findByText(/Übersprungen.*12:20|Skipped.*12:20/u)).not.toBeNull();
    expect(onFeedbackMessage).toHaveBeenCalledWith(expect.stringMatching(/Übersprungen.*12:20|Skipped.*12:20/u), undefined, "success");
  });

  it("maps an already-skipped result to a short informational message", async () => {
    vi.mocked(skipNextTimerOccurrence).mockResolvedValue({ result: "already_skipped" });
    const onFeedbackMessage = vi.fn();
    render(<UiProvider><ImmediateActions channelId="channel-a" role="operator"
      modules={[{ id: "timers", enabled: true }]} onFeedbackMessage={onFeedbackMessage} />
    </UiProvider>);

    const action = await screen.findByRole("button", { name: /Timer überspringen|Skip next timer message/u });
    await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(action);
    const timerSelect = await screen.findByRole("combobox", { name: /Timer/u });
    await waitFor(() => expect((timerSelect as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(timerSelect);
    clickSelectOption(await screen.findByRole("option", { name: /Welcome/u, hidden: true }));
    fireEvent.click(screen.getByRole("button", { name: dashboardTexts().streamManager.actionRun }));

    expect(await screen.findByText("Der nächste Lauf ist bereits übersprungen.")).not.toBeNull();
    expect(onFeedbackMessage).toHaveBeenCalledWith("Der nächste Lauf ist bereits übersprungen.", undefined, "info");
  });
});
