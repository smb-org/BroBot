import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ImmediateActions } from "../../src/dashboard/ImmediateActions";
import { changeChannelVariableValue, createStreamMarker, fetchStreamMarkerAvailability, fetchChannelOverview, fetchChannelVariables, sendTestMessage, type PanelChannelVariable } from "../../src/dashboard/api";
import { dashboardTexts } from "../../src/dashboard/locale";
import { loadTextCommandData } from "../../src/modules/text_commands/panel/service";
import { textCommandQuickActionTexts } from "../../src/modules/text_commands/panel/quick-action-locale";
import { UiProvider } from "../../src/dashboard/ui";
import { clickSelectOption } from "../query-test-utils";

vi.mock("../../src/dashboard/api", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  changeChannelVariableValue: vi.fn(),
  createStreamMarker: vi.fn(),
  fetchStreamMarkerAvailability: vi.fn(),
  fetchChannelOverview: vi.fn(),
  fetchChannelVariables: vi.fn(),
  sendTestMessage: vi.fn(),
}));

vi.mock("../../src/modules/text_commands/panel/service", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  loadTextCommandData: vi.fn(),
}));

const setChannelVariables = (variables: readonly PanelChannelVariable[]): void => {
  vi.mocked(fetchChannelVariables).mockResolvedValue({ count: variables.length, maximum: 50, variables });
  vi.mocked(loadTextCommandData).mockResolvedValue({ commands: [], variables: [...variables] });
};

afterEach(() => {
  cleanup();
  localStorage.clear();
});

beforeEach(() => {
  setChannelVariables([{ channelId: "channel-a", name: "score", value: 4, description: "", resetOnStreamStart: false, createdAt: "", updatedAt: "", usages: [] }]);
  vi.mocked(changeChannelVariableValue).mockReset();
  vi.mocked(createStreamMarker).mockReset();
  vi.mocked(fetchStreamMarkerAvailability).mockReset().mockResolvedValue({ manageScopeAvailable: true });
  vi.mocked(sendTestMessage).mockReset();
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

  it("disables stream markers with a linked scope grant reason", async () => {
    vi.mocked(fetchStreamMarkerAvailability).mockResolvedValue({ manageScopeAvailable: false });

    render(<UiProvider><ImmediateActions channelId="channel-a" streamState="online" role="manager"
      modules={[{ id: "channel_events", enabled: true }]} /></UiProvider>);

    const action = await screen.findByRole("button", { name: /Set stream marker|Stream-Marker setzen/u });
    await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText(/broadcast permission is missing|Broadcaster-Berechtigung fehlt/u)).not.toBeNull();
    const grantLink = screen.getByRole("link", { name: /Grant permission|Berechtigung erteilen/u });
    expect(grantLink.getAttribute("href")).toBe("/auth/channels/channel-a/broadcaster-scopes/broadcast");
  });

  it("disables stream markers with the offline reason", async () => {
    render(<UiProvider><ImmediateActions channelId="channel-a" streamState="offline" role="manager"
      modules={[{ id: "channel_events", enabled: true }]} /></UiProvider>);

    const action = await screen.findByRole("button", { name: /Set stream marker|Stream-Marker setzen/u });
    expect((action as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/stream is offline|Stream ist offline/u)).not.toBeNull();
    expect(fetchStreamMarkerAvailability).not.toHaveBeenCalled();
  });

  it("shows the typed stream marker position in its feedback", async () => {
    vi.mocked(createStreamMarker).mockResolvedValue({ result: "created", positionSeconds: 323 });
    const onFeedbackMessage = vi.fn();

    render(<UiProvider><ImmediateActions channelId="channel-a" streamState="online" role="manager"
      modules={[{ id: "channel_events", enabled: true }]} onFeedbackMessage={onFeedbackMessage} /></UiProvider>);

    const action = await screen.findByRole("button", { name: /Set stream marker|Stream-Marker setzen/u });
    await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(action);

    await waitFor(() => expect(createStreamMarker).toHaveBeenCalledWith("channel-a"));
    expect(await screen.findByText(/Stream marker set at 5:23|Stream-Marker bei 5:23 gesetzt/u)).not.toBeNull();
    expect(onFeedbackMessage).toHaveBeenCalledWith(expect.stringMatching(/5:23/u), undefined, "success");
  });

  it.each([
    {
      result: { result: "scope_missing", error: "broadcast_scope_missing", grantHref: "/auth/channels/channel-a/broadcaster-scopes/broadcast" } as const,
      message: /Broadcaster-Berechtigung fehlt/u,
      tone: "error" as const,
    },
    { result: { result: "offline" } as const, message: /Der Stream ist offline/u, tone: "error" as const },
    { result: { result: "rate_limited", retryAfter: 21 } as const, message: /Erneut in 21 s/u, tone: "info" as const },
    { result: { result: "token_expired" } as const, message: /Twitch-Zugang abgelaufen/u, tone: "error" as const },
    { result: { result: "failed" } as const, message: /Stream-Marker konnte nicht gesetzt werden/u, tone: "error" as const },
  ])("maps the typed $result.result stream marker response to short feedback", async ({ result, message, tone }) => {
    vi.mocked(createStreamMarker).mockResolvedValue(result);
    const onFeedbackMessage = vi.fn();

    render(<UiProvider><ImmediateActions channelId="channel-a" streamState="online" role="manager"
      modules={[{ id: "channel_events", enabled: true }]} onFeedbackMessage={onFeedbackMessage} /></UiProvider>);

    const action = await screen.findByRole("button", { name: /Set stream marker|Stream-Marker setzen/u });
    await waitFor(() => expect((action as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(action);

    expect(await screen.findByText(message)).not.toBeNull();
    expect(onFeedbackMessage).toHaveBeenCalledWith(
      expect.stringMatching(message),
      result.result === "scope_missing" ? { href: result.grantHref, label: "Berechtigung erteilen" } : undefined,
      tone,
    );
  });

  it("ignores a late stream marker scope response from the previous channel", async () => {
    let resolveChannelA: ((value: Awaited<ReturnType<typeof fetchStreamMarkerAvailability>>) => void) | undefined;
    let resolveChannelB: ((value: Awaited<ReturnType<typeof fetchStreamMarkerAvailability>>) => void) | undefined;
    vi.mocked(fetchStreamMarkerAvailability).mockImplementation((channelId) => new Promise((resolve) => {
      if (channelId === "channel-a") resolveChannelA = resolve;
      else resolveChannelB = resolve;
    }));
    const actions = (channelId: string) => <UiProvider><ImmediateActions channelId={channelId} streamState="online" role="manager"
      modules={[{ id: "channel_events", enabled: true }]} /></UiProvider>;
    const view = render(actions("channel-a"));
    await waitFor(() => expect(resolveChannelA).toBeTypeOf("function"));
    view.rerender(actions("channel-b"));
    await waitFor(() => expect(resolveChannelB).toBeTypeOf("function"));

    await act(async () => {
      resolveChannelB?.({ manageScopeAvailable: true });
      await Promise.resolve();
    });
    const marker = await screen.findByRole("button", { name: /Set stream marker|Stream-Marker setzen/u });
    await waitFor(() => expect((marker as HTMLButtonElement).disabled).toBe(false));
    await act(async () => {
      resolveChannelA?.({ manageScopeAvailable: false });
      await Promise.resolve();
    });

    expect((marker as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("link", { name: /Grant permission|Berechtigung erteilen/u })).toBeNull();
  });
});
