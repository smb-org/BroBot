import { act, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isCommandPaletteShortcut } from "../../src/dashboard/command-palette-shortcut";
import { Shell } from "../../src/dashboard/ui/Shell";

afterEach(() => { vi.unstubAllGlobals(); });

describe("dashboard shell shortcuts", () => {
  it("uses only the platform shortcut so macOS Ctrl+K remains native in editable fields", () => {
    expect(isCommandPaletteShortcut({ key: "k", ctrlKey: true, metaKey: false }, true)).toBe(false);
    expect(isCommandPaletteShortcut({ key: "k", ctrlKey: false, metaKey: true }, true)).toBe(true);
    expect(isCommandPaletteShortcut({ key: "k", ctrlKey: true, metaKey: false }, false)).toBe(true);
    expect(isCommandPaletteShortcut({ key: "k", ctrlKey: false, metaKey: true }, false)).toBe(false);

    vi.stubGlobal("navigator", { platform: "MacIntel", language: "en-US", userAgent: "Macintosh" });
    const onCommandPaletteOpenChange = vi.fn();
    const { getByRole } = render(<Shell
      header={() => null}
      navbar={() => null}
      navLabel="Navigation"
      openSidebarLabel="Open sidebar"
      closeSidebarLabel="Close sidebar"
      mode="setup"
      commandPaletteOpen={false}
      onCommandPaletteOpenChange={onCommandPaletteOpenChange}
    ><input aria-label="Draft" /></Shell>);
    const draft = getByRole("textbox", { name: "Draft" });
    fireEvent.keyDown(draft, { key: "k", ctrlKey: true });
    expect(onCommandPaletteOpenChange).not.toHaveBeenCalled();
    fireEvent.keyDown(draft, { key: "k", metaKey: true });
    expect(onCommandPaletteOpenChange).toHaveBeenCalledWith(true);
  });

  it("leaves nothing inert when the route returns to live with the drawer open", () => {
    const props = {
      header: () => null,
      navbar: () => null,
      navLabel: "Navigation",
      openSidebarLabel: "Open sidebar",
      closeSidebarLabel: "Close sidebar",
      commandPaletteOpen: false,
      onCommandPaletteOpenChange: vi.fn(),
    };
    const { rerender, container } = render(<Shell {...props} mode="setup"><p>page</p></Shell>);
    fireEvent.click(within(container).getByRole("button", { name: "Open sidebar" }));
    expect(container.querySelectorAll("[inert]").length).toBeGreaterThan(0);
    rerender(<Shell {...props} mode="live"><p>page</p></Shell>);
    expect(container.querySelectorAll("[inert]")).toHaveLength(0);
    rerender(<Shell {...props} mode="setup"><p>page</p></Shell>);
    expect(container.querySelectorAll("[inert]")).toHaveLength(0);
  });

  it("closes the drawer when the layout widens past the mobile breakpoint", () => {
    let mobile = true;
    const listeners = new Set<() => void>();
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: mobile,
      media: query,
      addEventListener: (_: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
    }));
    const { container } = render(<Shell
      header={() => <button type="button">head</button>}
      navbar={() => <a href="#a">link</a>}
      navLabel="Navigation"
      openSidebarLabel="Open sidebar"
      closeSidebarLabel="Close sidebar"
      mode="setup"
      commandPaletteOpen={false}
      onCommandPaletteOpenChange={vi.fn()}
    ><button type="button">main</button></Shell>);
    fireEvent.click(within(container).getByRole("button", { name: "Open sidebar" }));
    expect(container.querySelectorAll("[inert]").length).toBeGreaterThan(0);
    act(() => { mobile = false; listeners.forEach((listener) => listener()); });
    expect(container.querySelectorAll("[inert]")).toHaveLength(0);
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    // Tab is no longer trapped: the handler must not redirect focus into the drawer.
    const mainButton = within(container).getByRole("button", { name: "main" });
    mainButton.focus();
    expect(fireEvent.keyDown(mainButton, { key: "Tab" })).toBe(true);
    expect(document.activeElement).toBe(mainButton);
    // Narrowing again must not resurrect the stale open state.
    act(() => { mobile = true; listeners.forEach((listener) => listener()); });
    expect(container.querySelectorAll("[inert]")).toHaveLength(0);
  });
});
