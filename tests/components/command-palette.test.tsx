import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { dashboardTexts } from "../../src/dashboard/locale";
import { ChannelCommandPalette } from "../../src/dashboard/command-palette";
import { CommandPalette } from "../../src/dashboard/ui/CommandPalette";
import { UiProvider, type CommandPaletteItem } from "../../src/dashboard/ui";
import type { DashboardRoute } from "../../src/dashboard/router";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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
});
