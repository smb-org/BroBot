import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const inactiveLoader = vi.hoisted(() => vi.fn(() => Promise.resolve({ default: () => null })));

vi.mock("../../src/modules/registry", () => ({
  MODULES: [{ id: "inactive", settingsSchema: {}, defaultSettings: {}, panel: inactiveLoader }],
}));

import { ModulePanelMount } from "../../src/dashboard/module-panels";

describe("Modul-Panel-Lader", () => {
  afterEach(() => cleanup());

  it("ruft den Lazy-Loader eines nicht aktiven Moduls nicht auf", () => {
    render(<ModulePanelMount channelId="kanal-a" activeModules={[]} />);

    expect(screen.getByText("Keine Module aktiv.")).toBeInTheDocument();
    expect(inactiveLoader).not.toHaveBeenCalled();
  });
});
