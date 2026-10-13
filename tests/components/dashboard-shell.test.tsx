import { fireEvent, render } from "@testing-library/react";
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
});
