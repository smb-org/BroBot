import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const activeLoader = vi.hoisted(() => vi.fn(() => Promise.resolve({ default: () => <p>Panel geladen</p> })));

vi.mock("../../src/modules/registry", () => ({
  MODULES: [
    { id: "aktiv", settingsSchema: {}, defaultSettings: {}, panel: activeLoader },
    { id: "ohne-panel", settingsSchema: {}, defaultSettings: {} },
  ],
}));

import { ModuleNavigation, ModulePanelMount, ModulePage } from "../../src/dashboard/module-panels";

describe("Modul-Panel-Lader", () => {
  afterEach(() => cleanup());

  it("verweist aktive Module auf ihre eigene Unterseite", () => {
    const onNavigate = vi.fn();
    render(<ModuleNavigation channelId="kanal-a" activeModules={[{ moduleId: "aktiv", settings: "{}" }]} onNavigate={onNavigate} />);

    const link = screen.getByRole("link", { name: "aktiv" });
    expect(link).toHaveAttribute("href", "/channels/kanal-a/modules/aktiv");
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith({ kind: "module", channelId: "kanal-a", moduleId: "aktiv" });
  });

  it("ruft den Lazy-Loader auf der Übersicht nicht auf", () => {
    render(<ModulePanelMount channelId="kanal-a" activeModules={[]} />);

    expect(screen.getByText("Keine Module aktiv.")).toBeInTheDocument();
    expect(activeLoader).not.toHaveBeenCalled();
  });

  it("lädt das Panel erst auf der Modulunterseite lazy", async () => {
    render(<ModulePage channelId="kanal-a" moduleId="aktiv" activeModules={[{ moduleId: "aktiv", settings: "{}" }]} />);

    expect(await screen.findByText("Panel geladen")).toBeInTheDocument();
    expect(activeLoader).toHaveBeenCalledTimes(1);
  });

  it("zeigt für ein aktives Modul ohne Panel einen erklärten Zustand", () => {
    render(<ModulePage channelId="kanal-a" moduleId="ohne-panel" activeModules={[{ moduleId: "ohne-panel", settings: "{}" }]} />);

    expect(screen.getByText("Für dieses aktive Modul gibt es noch keine Panel-Ansicht.")).toBeInTheDocument();
  });
});
