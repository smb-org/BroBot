import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { changeChannelVariableValue, fetchChannelVariables, setChannelControl } from "../../src/dashboard/api";
import type { PanelChannelControl, PanelChannelControls } from "../../src/panel-contract";
import { dashboardTexts } from "../../src/dashboard/locale";
import { ChannelCommandPalette } from "../../src/dashboard/command-palette";
import { CommandPalette } from "../../src/dashboard/ui/CommandPalette";
import { UiProvider, type CommandPaletteItem } from "../../src/dashboard/ui";
import type { DashboardRoute } from "../../src/dashboard/router";

vi.mock("../../src/dashboard/api", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  changeChannelVariableValue: vi.fn(),
  fetchChannelVariables: vi.fn(),
  setChannelControl: vi.fn(),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.mocked(fetchChannelVariables).mockResolvedValue({ count: 0, maximum: 50, variables: [] });
  vi.mocked(changeChannelVariableValue).mockReset();
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
    expect(counter.textContent).toMatch(/No numeric channel variables|Keine numerischen Kanalvariablen/u);

    fireEvent.change(input, { target: { value: "test message" } });
    const message = await screen.findByRole("option", { name: /Send test message|Testnachricht senden/u });
    expect(message.getAttribute("aria-disabled")).toBe("true");
    expect(message.textContent).toMatch(/bot is not connected|Bot ist nicht verbunden/u);
  });

  it("keeps the counter row height reserved after its variables load", async () => {
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
    expect(counter.querySelector(".command-palette__item-description")).not.toBeNull();
    resolveVariables?.({ count: 1, maximum: 50, variables: [{ channelId: "kanal-a", name: "score", value: 4, description: "", resetOnStreamStart: false, createdAt: "", updatedAt: "", usages: [] }] });

    await waitFor(() => expect(counter.getAttribute("aria-disabled")).not.toBe("true"));
    expect(counter.querySelector(".command-palette__item-description")).not.toBeNull();
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
});
