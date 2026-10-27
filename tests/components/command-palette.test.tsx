import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { changeChannelVariableValue, createStreamMarker, fetchStreamMarkerAvailability, fetchChannelVariables, setChannelControl } from "../../src/dashboard/api";
import type { PanelChannelControl, PanelChannelControls } from "../../src/panel-contract";
import { dashboardTexts } from "../../src/dashboard/locale";
import { ChannelCommandPalette } from "../../src/dashboard/command-palette";
import { CommandPalette } from "../../src/dashboard/ui/CommandPalette";
import { UiProvider, type CommandPaletteItem } from "../../src/dashboard/ui";
import { dismissToast, toastsSnapshot } from "../../src/dashboard/ui/toast-store";
import type { DashboardRoute } from "../../src/dashboard/router";
import { loadUpcomingTimers } from "../../src/modules/timers/panel/service";

vi.mock("../../src/dashboard/api", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  changeChannelVariableValue: vi.fn(),
  createStreamMarker: vi.fn(),
  fetchStreamMarkerAvailability: vi.fn(),
  fetchChannelVariables: vi.fn(),
  setChannelControl: vi.fn(),
}));

vi.mock("../../src/modules/timers/panel/service", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  loadUpcomingTimers: vi.fn(),
  skipNextTimerOccurrence: vi.fn(),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.mocked(fetchChannelVariables).mockResolvedValue({ count: 0, maximum: 50, variables: [] });
  vi.mocked(fetchStreamMarkerAvailability).mockReset().mockResolvedValue({ manageScopeAvailable: true });
  vi.mocked(changeChannelVariableValue).mockReset();
  vi.mocked(loadUpcomingTimers).mockClear();
  vi.mocked(loadUpcomingTimers).mockResolvedValue([]);
  vi.mocked(createStreamMarker).mockReset();
});

const off: PanelChannelControl = { active: false, until: null, mode: null };
const idleControls: PanelChannelControls = { mute: off, pause: off };
const pausedControls: PanelChannelControls = { mute: off, pause: { active: true, until: null, mode: "unlimited" } };

const texts = dashboardTexts("en").commandPalette;

describe("cmdk command palette", () => {
  it("filters results and activates the highlighted item with Enter", async () => {
    const onTrigger = vi.fn();
    const items: CommandPaletteItem[] = [
      { id: "timer", label: "Timer", group: "Chat", onTrigger },
      { id: "members", label: "Members", group: "Administration", onTrigger: vi.fn() },
    ];
    render(
      <UiProvider><CommandPalette
        items={items}
        open
        onOpenChange={vi.fn()}
        emptyMessage={texts.empty}
        title={texts.title}
        description={texts.description}
        placeholder={texts.placeholder}
        navigateHint={texts.navigateHint}
        openHint={texts.openHint}
      /></UiProvider>,
    );

    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "Timer" } });
    await waitFor(() => expect(screen.getByText("Timer")).not.toBeNull());
    expect(screen.queryByText("Members")).toBeNull();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onTrigger).toHaveBeenCalledOnce();
  });

  it("keeps a reserved reason line for rows without a description and exposes label plus state accessibly", () => {
    const items: CommandPaletteItem[] = [
      {
        id: "mute-channel",
        label: "Kanal stummschalten",
        description: "Bleibt aktiv, bis du es aufhebst.",
        stateLabel: "Inaktiv",
        onTrigger: vi.fn(),
      },
      {
        id: "pause-automations",
        label: "Automatische Aktionen pausieren",
        stateLabel: "Inaktiv",
        onTrigger: vi.fn(),
      },
    ];
    render(
      <UiProvider><CommandPalette
        items={items}
        open
        onOpenChange={vi.fn()}
        emptyMessage={texts.empty}
        title={texts.title}
        description={texts.description}
        placeholder={texts.placeholder}
        navigateHint={texts.navigateHint}
        openHint={texts.openHint}
      /></UiProvider>,
    );

    const describedRow = screen.getByRole("option", { name: "Kanal stummschalten Inaktiv" });
    const emptyReasonRow = screen.getByRole("option", { name: "Automatische Aktionen pausieren Inaktiv" });
    const describedReasonId = describedRow.getAttribute("aria-describedby");
    expect(describedReasonId).not.toBeNull();
    expect(document.getElementById(describedReasonId ?? "")?.textContent).toBe("Bleibt aktiv, bis du es aufhebst.");
    expect(describedRow.querySelector(".command-palette__inline-reason")?.textContent).toBe("Bleibt aktiv, bis du es aufhebst.");
    expect(emptyReasonRow.querySelector(".command-palette__inline-reason")?.textContent).toBe("");
    expect(emptyReasonRow.getAttribute("aria-describedby")).toBeNull();
  });

  it("restores focus to the control that opened it after Escape", async () => {
    const item: CommandPaletteItem = { id: "members", label: "Members", group: "Administration", onTrigger: vi.fn() };
    const Harness = () => {
      const [open, setOpen] = useState(false);
      return <>
        <button onClick={() => { setOpen(true); }} type="button">Open search</button>
        <UiProvider><CommandPalette
          items={[item]}
          open={open}
          onOpenChange={setOpen}
          emptyMessage={texts.empty}
          title={texts.title}
          description={texts.description}
          placeholder={texts.placeholder}
          navigateHint={texts.navigateHint}
          openHint={texts.openHint}
        /></UiProvider>
      </>;
    };
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Open search" });
    trigger.focus();
    trigger.click();
    const input = await screen.findByRole("combobox");
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("keeps inactive modules findable from the same navigation data", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onNavigate = vi.fn<(route: DashboardRoute) => void>();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}", { status: 404 }))));
    render(
      <QueryClientProvider client={client}><UiProvider><ChannelCommandPalette
        open
        onOpenChange={vi.fn()}
        channelId="kanal-a"
        ownRole="manager"
        modules={[{ id: "timers", enabled: false, settings: "{}" }]}
        onToggleModule={() => Promise.resolve()}
        onNavigate={onNavigate}
        onOpenCommand={vi.fn()}
        onOpenVariable={vi.fn()}
      /></UiProvider></QueryClientProvider>,
    );

    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "Timer" } });
    await waitFor(() => expect(screen.getByText("Timer")).not.toBeNull());
    expect(screen.getByText(/^(Off|Aus)$/u).textContent).toMatch(/^(Off|Aus)$/u);
    expect(document.querySelector(".command-palette__category")).toBeNull();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onNavigate).toHaveBeenCalledWith({ kind: "module", channelId: "kanal-a", moduleId: "timers" });
  });

  it("keeps the highlighted pause item selected when its label flips to resume", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(setChannelControl).mockResolvedValue({ controls: pausedControls });
    const palette = (channelControls: PanelChannelControls) => (
      <QueryClientProvider client={client}><UiProvider><ChannelCommandPalette
        open
        onOpenChange={vi.fn()}
        channelId="kanal-a"
        ownRole="manager"
        modules={[]}
        channelControls={channelControls}
        onRefreshChannelState={() => Promise.resolve()}
        onToggleModule={() => Promise.resolve()}
        onNavigate={vi.fn()}
        onOpenCommand={vi.fn()}
        onOpenVariable={vi.fn()}
      /></UiProvider></QueryClientProvider>
    );
    const view = render(palette(idleControls));

    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "pause" } });
    const pauseItem = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-value='action:channel-pause']");
    await waitFor(() => expect(pauseItem()?.getAttribute("aria-selected")).toBe("true"));
    const labelBefore = pauseItem()?.textContent;

    view.rerender(palette(pausedControls));
    await waitFor(() => expect(pauseItem()?.textContent).not.toBe(labelBefore));
    expect(pauseItem()?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(setChannelControl).toHaveBeenCalledWith("kanal-a", "pause", null);
  });

  it("shows a load failure instead of the empty-variables reason when the variable fetch is rejected", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(fetchChannelVariables).mockRejectedValue(new Error("503"));
    render(
      <QueryClientProvider client={client}><UiProvider><ChannelCommandPalette
        open
        onOpenChange={vi.fn()}
        channelId="kanal-a"
        ownRole="operator"
        streamState="online"
        botConnected
        modules={[{ id: "text_commands", enabled: true, settings: "{}" }]}
        onToggleModule={() => Promise.resolve()}
        onNavigate={vi.fn()}
        onOpenCommand={vi.fn()}
        onOpenVariable={vi.fn()}
      /></UiProvider></QueryClientProvider>,
    );

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "counter" } });
    const counter = await screen.findByRole("option", { name: /Counter \+1|Zähler \+1/u });
    await waitFor(() => expect(counter.getAttribute("aria-disabled")).toBe("true"));
    const reason = counter.querySelector<HTMLElement>(".command-palette__inline-reason");
    await waitFor(() => expect(reason?.textContent).toMatch(/could not be loaded|konnten nicht geladen werden/u));
    expect(reason?.textContent).not.toMatch(/No numeric channel variables|Keine numerischen Kanalvariablen/u);
  });

  it("shows declared quick actions as disabled with their variable and bot availability reasons", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(fetchChannelVariables).mockResolvedValue({ count: 0, maximum: 50, variables: [] });
    render(
      <QueryClientProvider client={client}><UiProvider><ChannelCommandPalette
        open
        onOpenChange={vi.fn()}
        channelId="kanal-a"
        ownRole="operator"
        streamState="online"
        botConnected={false}
        modules={[{ id: "text_commands", enabled: true, settings: "{}" }]}
        onToggleModule={() => Promise.resolve()}
        onNavigate={vi.fn()}
        onOpenCommand={vi.fn()}
        onOpenVariable={vi.fn()}
      /></UiProvider></QueryClientProvider>,
    );

    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "counter" } });
    const counter = await screen.findByRole("option", { name: /Counter \+1|Zähler \+1/u });
    await waitFor(() => expect(counter.getAttribute("aria-disabled")).toBe("true"));
    const counterReason = counter.querySelector<HTMLElement>(".command-palette__inline-reason");
    expect(counterReason?.textContent).toMatch(/No numeric channel variables|Keine numerischen Kanalvariablen/u);
    expect(counterReason?.title).toMatch(/No numeric channel variables|Keine numerischen Kanalvariablen/u);
    expect(counter.querySelector(".command-palette__item-description")).toBeNull();
    const counterDescriptionId = counter.getAttribute("aria-describedby");
    expect(counterDescriptionId).not.toBeNull();
    expect(document.getElementById(counterDescriptionId ?? "")?.textContent).toMatch(/No numeric channel variables|Keine numerischen Kanalvariablen/u);

    fireEvent.change(input, { target: { value: "test message" } });
    const message = await screen.findByRole("option", { name: /Send test message|Testnachricht senden/u });
    expect(message.getAttribute("aria-disabled")).toBe("true");
    const messageReason = message.querySelector<HTMLElement>(".command-palette__inline-reason");
    expect(messageReason?.textContent).toMatch(/bot is not connected|Bot ist nicht verbunden/u);
    expect(messageReason?.title).toMatch(/bot is not connected|Bot ist nicht verbunden/u);
    expect(message.querySelector(".command-palette__item-description")).toBeNull();
    const messageDescriptionId = message.getAttribute("aria-describedby");
    expect(messageDescriptionId).not.toBeNull();
    expect(document.getElementById(messageDescriptionId ?? "")?.textContent).toMatch(/bot is not connected|Bot ist nicht verbunden/u);
  });

  it("shows timer skipping disabled in the palette when no next occurrence is planned", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(loadUpcomingTimers).mockResolvedValue([]);
    render(
      <QueryClientProvider client={client}><UiProvider><ChannelCommandPalette
        open
        onOpenChange={vi.fn()}
        channelId="kanal-a"
        ownRole="operator"
        modules={[{ id: "timers", enabled: true, settings: "{}" }]}
        onToggleModule={() => Promise.resolve()}
        onNavigate={vi.fn()}
        onOpenCommand={vi.fn()}
        onOpenVariable={vi.fn()}
      /></UiProvider></QueryClientProvider>,
    );

    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "timer skip" } });
    const timerAction = await screen.findByRole("option", { name: /Skip next timer message|Timer überspringen/u });
    await waitFor(() => expect(timerAction.getAttribute("aria-disabled")).toBe("true"));
    expect(timerAction.querySelector(".command-palette__inline-reason")?.textContent).toMatch(/No timer.*planned|Kein Timer.*geplant/u);
  });

  it("keeps timer skipping visible and disabled when the timers module is off", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}><UiProvider><ChannelCommandPalette
        open
        onOpenChange={vi.fn()}
        channelId="kanal-a"
        ownRole="operator"
        modules={[{ id: "timers", enabled: false, settings: "{}" }]}
        onToggleModule={() => Promise.resolve()}
        onNavigate={vi.fn()}
        onOpenCommand={vi.fn()}
        onOpenVariable={vi.fn()}
      /></UiProvider></QueryClientProvider>,
    );

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "timer skip" } });
    const timerAction = await screen.findByRole("option", { name: /Skip next timer message|Timer überspringen/u });
    await waitFor(() => expect(timerAction.getAttribute("aria-disabled")).toBe("true"));
    expect(timerAction.querySelector(".command-palette__inline-reason")?.textContent).toMatch(/module.*disabled|Modul.*deaktiviert/u);
    expect(loadUpcomingTimers).not.toHaveBeenCalled();
  });

  it("shows counter loading status inline without adding a second row", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let resolveVariables: ((value: Awaited<ReturnType<typeof fetchChannelVariables>>) => void) | undefined;
    vi.mocked(fetchChannelVariables).mockImplementation(() => new Promise((resolve) => { resolveVariables = resolve; }));
    render(
      <QueryClientProvider client={client}><UiProvider><ChannelCommandPalette
        open
        onOpenChange={vi.fn()}
        channelId="kanal-a"
        ownRole="operator"
        streamState="online"
        botConnected
        modules={[{ id: "text_commands", enabled: true, settings: "{}" }]}
        onToggleModule={() => Promise.resolve()}
        onNavigate={vi.fn()}
        onOpenCommand={vi.fn()}
        onOpenVariable={vi.fn()}
      /></UiProvider></QueryClientProvider>,
    );

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "counter" } });
    const counter = await screen.findByRole("option", { name: /Counter \+1|Zähler \+1/u });
    expect(counter.querySelector(".command-palette__item-description")).toBeNull();
    expect(counter.querySelector(".command-palette__inline-reason")?.textContent).toMatch(/Loading|Lädt|Aktion wird geladen/u);
    resolveVariables?.({ count: 1, maximum: 50, variables: [{ channelId: "kanal-a", name: "score", value: 4, description: "", resetOnStreamStart: false, createdAt: "", updatedAt: "", usages: [] }] });

    await waitFor(() => expect(counter.getAttribute("aria-disabled")).not.toBe("true"));
    expect(counter.querySelector(".command-palette__item-description")).toBeNull();
    expect(counter.querySelector(".command-palette__inline-reason")?.textContent).toBe("");
  });

  it("waits for a fresh counter-variable list after reopening the palette", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let resolveReopenedVariables: ((value: Awaited<ReturnType<typeof fetchChannelVariables>>) => void) | undefined;
    let refreshing = false;
    vi.mocked(fetchChannelVariables).mockImplementation(() => refreshing
      ? new Promise((resolve) => { resolveReopenedVariables = resolve; })
      : Promise.resolve({ count: 1, maximum: 50, variables: [{ channelId: "kanal-a", name: "score", value: 4, description: "", resetOnStreamStart: false, createdAt: "", updatedAt: "", usages: [] }] }));
    vi.mocked(changeChannelVariableValue).mockResolvedValue({
      variable: { channelId: "kanal-a", name: "score", value: 5, description: "", resetOnStreamStart: false, createdAt: "", updatedAt: "" },
    });
    localStorage.setItem("brobot-dashboard-counter-variable-v1:kanal-a", "score");
    const onOpenChange = vi.fn();
    const palette = (open: boolean) => (
      <QueryClientProvider client={client}><UiProvider><ChannelCommandPalette
        open={open}
        onOpenChange={onOpenChange}
        channelId="kanal-a"
        ownRole="operator"
        streamState="online"
        botConnected
        modules={[{ id: "text_commands", enabled: true, settings: "{}" }]}
        onToggleModule={() => Promise.resolve()}
        onNavigate={vi.fn()}
        onOpenCommand={vi.fn()}
        onOpenVariable={vi.fn()}
      /></UiProvider></QueryClientProvider>
    );
    const view = render(palette(true));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "counter" } });
    const firstCounter = await screen.findByRole("option", { name: /Counter \+1|Zähler \+1/u });
    await waitFor(() => expect(firstCounter.getAttribute("aria-disabled")).not.toBe("true"));

    refreshing = true;
    view.rerender(palette(false));
    view.rerender(palette(true));
    await waitFor(() => expect(resolveReopenedVariables).toBeTypeOf("function"));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "counter" } });
    const reopenedCounter = await screen.findByRole("option", { name: /Counter \+1|Zähler \+1/u });
    const disabledWhileRefreshing = reopenedCounter.getAttribute("aria-disabled");
    fireEvent.click(reopenedCounter);
    resolveReopenedVariables?.({ count: 0, maximum: 50, variables: [] });

    expect(disabledWhileRefreshing).toBe("true");
    expect(changeChannelVariableValue).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });

  it("rechecks module, role, and stream availability while counter confirmation is open", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(fetchChannelVariables).mockResolvedValue({ count: 1, maximum: 50, variables: [{
      channelId: "kanal-a", name: "score", value: 4, description: "", resetOnStreamStart: false, createdAt: "", updatedAt: "", usages: [],
    }] });
    vi.mocked(changeChannelVariableValue).mockResolvedValue({
      variable: { channelId: "kanal-a", name: "score", value: 5, description: "", resetOnStreamStart: false, createdAt: "", updatedAt: "" },
    });
    const palette = (streamState: "online" | "offline", ownRole: "operator" | null, enabled: boolean) => (
      <QueryClientProvider client={client}><UiProvider><ChannelCommandPalette
        open
        onOpenChange={vi.fn()}
        channelId="kanal-a"
        ownRole={ownRole}
        streamState={streamState}
        botConnected
        modules={[{ id: "text_commands", enabled, settings: "{}" }]}
        onToggleModule={() => Promise.resolve()}
        onNavigate={vi.fn()}
        onOpenCommand={vi.fn()}
        onOpenVariable={vi.fn()}
      /></UiProvider></QueryClientProvider>
    );
    const view = render(palette("online", "operator", true));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "counter" } });
    const counter = await screen.findByRole("option", { name: /Counter \+1|Zähler \+1/u });
    await waitFor(() => expect(counter.getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(counter);
    const picker = await screen.findByRole("dialog", { name: /Choose counter|Zähler auswählen/u });
    const confirm = within(picker).getByRole("button", { name: /Run|Ausführen/u });

    view.rerender(palette("offline", "operator", true));
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    view.rerender(palette("online", "operator", false));
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    view.rerender(palette("online", null, true));
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(picker.querySelector("form") as HTMLFormElement);

    expect(changeChannelVariableValue).not.toHaveBeenCalled();
  });

  it("ignores a late counter-variable response from the previous channel", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let resolveChannelA: ((value: Awaited<ReturnType<typeof fetchChannelVariables>>) => void) | undefined;
    let resolveChannelB: ((value: Awaited<ReturnType<typeof fetchChannelVariables>>) => void) | undefined;
    vi.mocked(fetchChannelVariables).mockImplementation((channelId) => new Promise((resolve) => {
      if (channelId === "kanal-a") resolveChannelA = resolve;
      else resolveChannelB = resolve;
    }));
    vi.mocked(changeChannelVariableValue).mockResolvedValue({
      variable: { channelId: "kanal-b", name: "score", value: 5, description: "", resetOnStreamStart: false, createdAt: "", updatedAt: "" },
    });
    localStorage.setItem("brobot-dashboard-counter-variable-v1:kanal-b", "score");

    const palette = (channelId: string, open: boolean, onOpenChange: (open: boolean) => void) => (
      <QueryClientProvider client={client}><UiProvider><ChannelCommandPalette
        open={open}
        onOpenChange={onOpenChange}
        channelId={channelId}
        ownRole="operator"
        streamState="online"
        botConnected
        modules={[{ id: "text_commands", enabled: true, settings: "{}" }]}
        onToggleModule={() => Promise.resolve()}
        onNavigate={vi.fn()}
        onOpenCommand={vi.fn()}
        onOpenVariable={vi.fn()}
      /></UiProvider></QueryClientProvider>
    );
    const onOpenChange = vi.fn();
    const view = render(palette("kanal-a", true, onOpenChange));
    view.rerender(palette("kanal-a", false, onOpenChange));
    view.rerender(palette("kanal-b", true, onOpenChange));

    await waitFor(() => expect(resolveChannelB).toBeTypeOf("function"));
    await waitFor(() => expect(resolveChannelA).toBeTypeOf("function"));
    resolveChannelB?.({ count: 1, maximum: 50, variables: [{ channelId: "kanal-b", name: "score", value: 4, description: "", resetOnStreamStart: false, createdAt: "", updatedAt: "", usages: [] }] });

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "counter" } });
    const counter = await screen.findByRole("option", { name: /Counter \+1|Zähler \+1/u });
    await waitFor(() => expect(counter.getAttribute("aria-disabled")).not.toBe("true"));
    await act(async () => {
      resolveChannelA?.({ count: 1, maximum: 50, variables: [{ channelId: "kanal-a", name: "lives", value: 2, description: "", resetOnStreamStart: false, createdAt: "", updatedAt: "", usages: [] }] });
      await Promise.resolve();
    });
    fireEvent.click(screen.getByRole("option", { name: /Counter \+1|Zähler \+1/u }));

    await waitFor(() => expect(changeChannelVariableValue).toHaveBeenCalledWith("kanal-b", "score", "add", 1));
  });

  it("asks for a counter target before incrementing when no saved target is valid", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    localStorage.removeItem("brobot-dashboard-counter-variable-v1:kanal-a");
    vi.mocked(fetchChannelVariables).mockResolvedValue({ count: 1, maximum: 50, variables: [{
      channelId: "kanal-a", name: "score", value: 4, description: "", resetOnStreamStart: false, createdAt: "", updatedAt: "", usages: [],
    }] });
    vi.mocked(changeChannelVariableValue).mockResolvedValue({
      variable: { channelId: "kanal-a", name: "score", value: 5, description: "", resetOnStreamStart: false, createdAt: "", updatedAt: "" },
    });
    const Harness = () => {
      const [open, setOpen] = useState(true);
      return <QueryClientProvider client={client}><UiProvider><ChannelCommandPalette
        open={open}
        onOpenChange={setOpen}
        channelId="kanal-a"
        ownRole="operator"
        streamState="online"
        botConnected
        modules={[{ id: "text_commands", enabled: true, settings: "{}" }]}
        onToggleModule={() => Promise.resolve()}
        onNavigate={vi.fn()}
        onOpenCommand={vi.fn()}
        onOpenVariable={vi.fn()}
      /></UiProvider></QueryClientProvider>;
    };
    render(<Harness />);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "counter" } });
    const counter = await screen.findByRole("option", { name: /Counter \+1|Zähler \+1/u });
    await waitFor(() => expect(counter.getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(counter);

    expect(changeChannelVariableValue).not.toHaveBeenCalled();
    const picker = await screen.findByRole("dialog", { name: /Choose counter|Zähler auswählen/u });
    expect(picker).not.toBeNull();
    expect(within(picker).getByRole("combobox", { name: /Channel variable|Kanalvariable/u })).not.toBeNull();
    fireEvent.click(within(picker).getByRole("button", { name: /Run|Ausführen/u }));

    await waitFor(() => expect(changeChannelVariableValue).toHaveBeenCalledWith("kanal-a", "score", "add", 1));
    expect(localStorage.getItem("brobot-dashboard-counter-variable-v1:kanal-a")).toBe("score");
  });

  it("shows a disabled stream marker and grant action when the broadcaster scope is missing", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onNavigate = vi.fn();
    vi.mocked(fetchStreamMarkerAvailability).mockResolvedValue({ manageScopeAvailable: false });
    render(<QueryClientProvider client={client}><UiProvider><ChannelCommandPalette
      open onOpenChange={vi.fn()} channelId="kanal-a" viewerUserId="kanal-a" ownRole="manager" streamState="online"
      modules={[{ id: "channel_events", enabled: true, settings: "{}" }]}
      onToggleModule={() => Promise.resolve()} onNavigate={onNavigate} onOpenCommand={vi.fn()} onOpenVariable={vi.fn()}
    /></UiProvider></QueryClientProvider>);

    await waitFor(() => expect(fetchStreamMarkerAvailability).toHaveBeenCalledWith("kanal-a", expect.any(AbortSignal)));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "stream marker" } });
    const marker = await screen.findByRole("option", { name: /Set stream marker|Stream-Marker setzen/u });
    expect(marker.getAttribute("aria-disabled")).toBe("true");
    const reasonId = marker.getAttribute("aria-describedby");
    expect(reasonId).not.toBeNull();
    expect(document.getElementById(reasonId ?? "")?.textContent).toMatch(/broadcast permission is missing|Broadcaster-Berechtigung fehlt/u);
    expect(await screen.findByRole("option", { name: /Grant permission|Berechtigung erteilen/u })).not.toBeNull();
  });

  it("shows an owner-only grant reason without an actionable grant item for other members", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(fetchStreamMarkerAvailability).mockResolvedValue({ manageScopeAvailable: false });
    render(<QueryClientProvider client={client}><UiProvider><ChannelCommandPalette
      open onOpenChange={vi.fn()} channelId="kanal-a" viewerUserId="manager-1" ownRole="manager" streamState="online"
      modules={[{ id: "channel_events", enabled: true, settings: "{}" }]}
      onToggleModule={() => Promise.resolve()} onNavigate={vi.fn()} onOpenCommand={vi.fn()} onOpenVariable={vi.fn()}
    /></UiProvider></QueryClientProvider>);

    await waitFor(() => expect(fetchStreamMarkerAvailability).toHaveBeenCalledWith("kanal-a", expect.any(AbortSignal)));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "stream marker" } });
    const marker = await screen.findByRole("option", { name: /Set stream marker|Stream-Marker setzen/u });
    expect(marker.getAttribute("aria-disabled")).toBe("true");
    const reasonId = marker.getAttribute("aria-describedby");
    expect(document.getElementById(reasonId ?? "")?.textContent).toMatch(/only the channel owner can grant this permission|Nur der Kanalinhaber kann diese Berechtigung erteilen/u);
    expect(screen.queryByRole("option", { name: /Grant permission|Berechtigung erteilen/u })).toBeNull();
  });

  it("shows the offline reason for stream markers in the palette", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><UiProvider><ChannelCommandPalette
      open onOpenChange={vi.fn()} channelId="kanal-a" ownRole="manager" streamState="offline"
      modules={[{ id: "channel_events", enabled: true, settings: "{}" }]}
      onToggleModule={() => Promise.resolve()} onNavigate={vi.fn()} onOpenCommand={vi.fn()} onOpenVariable={vi.fn()}
    /></UiProvider></QueryClientProvider>);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "stream marker" } });
    const marker = await screen.findByRole("option", { name: /Set stream marker|Stream-Marker setzen/u });
    expect(marker.getAttribute("aria-disabled")).toBe("true");
    const reasonId = marker.getAttribute("aria-describedby");
    expect(document.getElementById(reasonId ?? "")?.textContent).toMatch(/stream is offline|Stream ist offline/u);
    expect(fetchStreamMarkerAvailability).not.toHaveBeenCalled();
  });

  it("shows typed stream marker feedback after choosing the palette action", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(createStreamMarker).mockResolvedValue({ result: "created", positionSeconds: 323 });
    render(<QueryClientProvider client={client}><UiProvider><ChannelCommandPalette
      open onOpenChange={vi.fn()} channelId="kanal-a" ownRole="manager" streamState="online"
      modules={[{ id: "channel_events", enabled: true, settings: "{}" }]}
      onToggleModule={() => Promise.resolve()} onNavigate={vi.fn()} onOpenCommand={vi.fn()} onOpenVariable={vi.fn()}
    /></UiProvider></QueryClientProvider>);

    await waitFor(() => expect(fetchStreamMarkerAvailability).toHaveBeenCalled());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "stream marker" } });
    const marker = await screen.findByRole("option", { name: /Set stream marker|Stream-Marker setzen/u });
    await waitFor(() => expect(marker.getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(marker);

    await waitFor(() => expect(createStreamMarker).toHaveBeenCalledWith("kanal-a"));
    await waitFor(() => expect(toastsSnapshot().at(-1)?.message).toMatch(/Stream marker set at 5:23|Stream-Marker bei 5:23 gesetzt/u));
  });

  it("dismisses a published marker grant toast when the palette switches channels", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.mocked(createStreamMarker).mockResolvedValue({
      result: "scope_missing",
      error: "broadcast_scope_missing",
      grantHref: "/auth/channels/kanal-a/broadcaster-scopes/broadcast",
    });
    const palette = (channelId: string) => <QueryClientProvider client={client}><UiProvider><ChannelCommandPalette
      key={channelId}
      open onOpenChange={vi.fn()} channelId={channelId} viewerUserId={channelId} ownRole="manager" streamState="online"
      modules={[{ id: "channel_events", enabled: true, settings: "{}" }]}
      onToggleModule={() => Promise.resolve()} onNavigate={vi.fn()} onOpenCommand={vi.fn()} onOpenVariable={vi.fn()}
    /></UiProvider></QueryClientProvider>;
    const view = render(palette("kanal-a"));

    await waitFor(() => expect(fetchStreamMarkerAvailability).toHaveBeenCalledWith("kanal-a", expect.any(AbortSignal)));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "stream marker" } });
    const marker = await screen.findByRole("option", { name: /Set stream marker|Stream-Marker setzen/u });
    await waitFor(() => expect(marker.getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(marker);

    const grantMessage = /broadcast permission is missing|Broadcaster-Berechtigung fehlt/u;
    await waitFor(() => expect(toastsSnapshot().some(({ message }) => grantMessage.test(message))).toBe(true));
    view.rerender(palette("kanal-b"));

    expect(toastsSnapshot().some(({ message }) => grantMessage.test(message))).toBe(false);
  });

  it("shows stream marker feedback when rendered under StrictMode", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const existingToastIds = new Set(toastsSnapshot().map(({ id }) => id));
    vi.mocked(createStreamMarker).mockResolvedValue({ result: "created", positionSeconds: 323 });
    render(<StrictMode><QueryClientProvider client={client}><UiProvider><ChannelCommandPalette
      open onOpenChange={vi.fn()} channelId="kanal-a" ownRole="manager" streamState="online"
      modules={[{ id: "channel_events", enabled: true, settings: "{}" }]}
      onToggleModule={() => Promise.resolve()} onNavigate={vi.fn()} onOpenCommand={vi.fn()} onOpenVariable={vi.fn()}
    /></UiProvider></QueryClientProvider></StrictMode>);

    await waitFor(() => expect(fetchStreamMarkerAvailability).toHaveBeenCalled());
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "stream marker" } });
    const marker = await screen.findByRole("option", { name: /Set stream marker|Stream-Marker setzen/u });
    await waitFor(() => expect(marker.getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(marker);

    const createdMessage = /Stream marker set at 5:23|Stream-Marker bei 5:23 gesetzt/u;
    await waitFor(() => expect(toastsSnapshot().some(({ id, message }) => !existingToastIds.has(id) && createdMessage.test(message))).toBe(true));
    for (const toast of toastsSnapshot()) {
      if (!existingToastIds.has(toast.id) && createdMessage.test(toast.message)) dismissToast(toast.id);
    }
  });

  it("drops a delayed marker grant toast after switching palette channels", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let resolveMarker: ((value: Awaited<ReturnType<typeof createStreamMarker>>) => void) | undefined;
    const pendingMarker = new Promise<Awaited<ReturnType<typeof createStreamMarker>>>((resolve) => { resolveMarker = resolve; });
    vi.mocked(createStreamMarker).mockReturnValue(pendingMarker);
    const existingToastIds = new Set(toastsSnapshot().map(({ id }) => id));
    const palette = (channelId: string) => <QueryClientProvider client={client}><UiProvider><ChannelCommandPalette
      open onOpenChange={vi.fn()} channelId={channelId} viewerUserId={channelId} ownRole="manager" streamState="online"
      modules={[{ id: "channel_events", enabled: true, settings: "{}" }]}
      onToggleModule={() => Promise.resolve()} onNavigate={vi.fn()} onOpenCommand={vi.fn()} onOpenVariable={vi.fn()}
    /></UiProvider></QueryClientProvider>;
    const view = render(palette("kanal-a"));

    await waitFor(() => expect(fetchStreamMarkerAvailability).toHaveBeenCalledWith("kanal-a", expect.any(AbortSignal)));
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "stream marker" } });
    const marker = await screen.findByRole("option", { name: /Set stream marker|Stream-Marker setzen/u });
    await waitFor(() => expect(marker.getAttribute("aria-disabled")).not.toBe("true"));
    fireEvent.click(marker);
    await waitFor(() => expect(createStreamMarker).toHaveBeenCalledWith("kanal-a"));
    view.rerender(palette("kanal-b"));

    await act(async () => {
      resolveMarker?.({
        result: "scope_missing",
        error: "broadcast_scope_missing",
        grantHref: "/auth/channels/kanal-a/broadcaster-scopes/broadcast",
      });
      await pendingMarker;
    });

    const grantMessage = /broadcast permission is missing|Broadcaster-Berechtigung fehlt/u;
    expect(toastsSnapshot().some(({ id, message }) => !existingToastIds.has(id) && grantMessage.test(message))).toBe(false);
  });

  it("ignores a late marker-scope response after switching palette channels", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let resolveChannelA: ((value: Awaited<ReturnType<typeof fetchStreamMarkerAvailability>>) => void) | undefined;
    let resolveChannelB: ((value: Awaited<ReturnType<typeof fetchStreamMarkerAvailability>>) => void) | undefined;
    vi.mocked(fetchStreamMarkerAvailability).mockImplementation((channelId) => new Promise((resolve) => {
      if (channelId === "kanal-a") resolveChannelA = resolve;
      else resolveChannelB = resolve;
    }));
    const palette = (channelId: string) => <QueryClientProvider client={client}><UiProvider><ChannelCommandPalette
      open onOpenChange={vi.fn()} channelId={channelId} ownRole="manager" streamState="online"
      modules={[{ id: "channel_events", enabled: true, settings: "{}" }]}
      onToggleModule={() => Promise.resolve()} onNavigate={vi.fn()} onOpenCommand={vi.fn()} onOpenVariable={vi.fn()}
    /></UiProvider></QueryClientProvider>;
    const view = render(palette("kanal-a"));
    await waitFor(() => expect(resolveChannelA).toBeTypeOf("function"));
    view.rerender(palette("kanal-b"));
    await waitFor(() => expect(resolveChannelB).toBeTypeOf("function"));

    await act(async () => {
      resolveChannelB?.({ manageScopeAvailable: true });
      await Promise.resolve();
    });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "stream marker" } });
    const marker = await screen.findByRole("option", { name: /Set stream marker|Stream-Marker setzen/u });
    await waitFor(() => expect(marker.getAttribute("aria-disabled")).not.toBe("true"));
    await act(async () => {
      resolveChannelA?.({ manageScopeAvailable: false });
      await Promise.resolve();
    });

    expect(marker.getAttribute("aria-disabled")).not.toBe("true");
  });
});
