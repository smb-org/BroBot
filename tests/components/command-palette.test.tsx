import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { setChannelControl } from "../../src/dashboard/api";
import type { PanelChannelControl, PanelChannelControls } from "../../src/panel-contract";
import { dashboardTexts } from "../../src/dashboard/locale";
import { ChannelCommandPalette } from "../../src/dashboard/command-palette";
import { CommandPalette } from "../../src/dashboard/ui/CommandPalette";
import { UiProvider, type CommandPaletteItem } from "../../src/dashboard/ui";
import type { DashboardRoute } from "../../src/dashboard/router";

vi.mock("../../src/dashboard/api", async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  setChannelControl: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
    await waitFor(() => expect(screen.getByText("Timer")).toBeVisible());
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
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
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
        onNavigate={onNavigate}
        onOpenCommand={vi.fn()}
        onOpenVariable={vi.fn()}
      /></UiProvider></QueryClientProvider>,
    );

    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "Timer" } });
    await waitFor(() => expect(screen.getByText("Timer")).toBeVisible());
    expect(screen.getByText(/^(Off|Aus)$/u)).toBeVisible();
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
        onNavigate={vi.fn()}
        onOpenCommand={vi.fn()}
        onOpenVariable={vi.fn()}
      /></UiProvider></QueryClientProvider>
    );
    const view = render(palette(idleControls));

    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "pause" } });
    const pauseItem = (): HTMLElement | null => document.querySelector<HTMLElement>("[data-value='action:channel-pause']");
    await waitFor(() => expect(pauseItem()).toHaveAttribute("aria-selected", "true"));
    const labelBefore = pauseItem()?.textContent;

    view.rerender(palette(pausedControls));
    await waitFor(() => expect(pauseItem()?.textContent).not.toBe(labelBefore));
    expect(pauseItem()).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(setChannelControl).toHaveBeenCalledWith("kanal-a", "pause", null);
  });
});
