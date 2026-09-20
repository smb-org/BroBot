import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const activeLoader = vi.hoisted(() => vi.fn(() => Promise.resolve({ default: () => <p>Panel geladen</p> })));

vi.mock("../../src/modules/registry", () => ({
  MODULES: [
    { id: "aktiv", settingsSchema: {}, defaultSettings: {}, panel: activeLoader },
    { id: "ohne-panel", settingsSchema: {}, defaultSettings: {} },
  ],
}));

import { ModuleNavigation, ModulePanelMount, ModulePage, ModuleWorkspace } from "../../src/dashboard/module-panels";

describe("Modul-Panel-Lader", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

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
    render(<ModulePage channelId="kanal-a" moduleId="aktiv" ownRole="verwalter" modules={[{ id: "aktiv", enabled: true, settings: "{}" }]} activeModules={[{ moduleId: "aktiv", settings: "{}" }]} onNavigate={vi.fn()} onToggle={vi.fn()} />);

    expect(await screen.findByText("Panel geladen")).toBeInTheDocument();
    expect(activeLoader).toHaveBeenCalledTimes(1);
  });

  it("zeigt für ein aktives Modul ohne Panel einen erklärten Zustand", () => {
    render(<ModulePage channelId="kanal-a" moduleId="ohne-panel" ownRole="verwalter" modules={[{ id: "ohne-panel", enabled: true, settings: "{}" }]} activeModules={[{ moduleId: "ohne-panel", settings: "{}" }]} onNavigate={vi.fn()} onToggle={vi.fn()} />);

    expect(screen.getByText("Für dieses aktive Modul gibt es noch keine Panel-Ansicht.")).toBeInTheDocument();
  });

  it("verwendet die Modulliste als Quelle und behauptet bei fehlender Übersicht nicht inaktiv", () => {
    render(<ModulePage
      channelId="kanal-a"
      moduleId="aktiv"
      ownRole="verwalter"
      modules={[{ id: "aktiv", enabled: true, settings: "{}" }]}
      activeModules={[]}
      onNavigate={vi.fn()}
      onToggle={vi.fn()}
    />);

    expect(screen.getByRole("switch", { name: "aktiv: Läuft" })).toBeChecked();
    expect(screen.queryByText("Das Modul „aktiv“ ist in diesem Kanal nicht aktiv.")).not.toBeInTheDocument();
    expect(screen.getByText("Module werden geladen …")).toBeInTheDocument();
  });

  it("navigiert beim Tippen auf eine Rastertaste, ohne beim Tippen zu schalten", () => {
    const fetcher = vi.fn<typeof fetch>();
    const onNavigate = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(<ModuleWorkspace channelId="kanal-a" ownRole="verwalter" modules={[{ id: "aktiv", enabled: true, settings: "{}" }]} onNavigate={onNavigate} />);

    const taste = screen.getByRole("link", { name: /aktiv.*Läuft/i });
    fireEvent.click(taste);

    expect(onNavigate).toHaveBeenCalledWith({ kind: "module", channelId: "kanal-a", moduleId: "aktiv" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("zeigt über der Modulüberschrift keinen Kicker", () => {
    render(<ModuleWorkspace channelId="kanal-a" ownRole="verwalter" modules={[]} onNavigate={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Module", level: 1 })).toBeInTheDocument();
    expect(screen.queryByText("Tastenraster")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Eigenschaften-Inspektor" })).not.toBeInTheDocument();
  });

  it("zeigt dem Bediener den deaktivierten Detail-Schalter mit Grund an", () => {
    render(<ModulePage
      channelId="kanal-a"
      moduleId="aktiv"
      ownRole="bediener"
      modules={[{ id: "aktiv", enabled: true, settings: "{}" }]}
      activeModules={[{ moduleId: "aktiv", settings: "{}" }]}
      onNavigate={vi.fn()}
      onToggle={vi.fn()}
    />);

    const toggle = screen.getByRole("switch", { name: /aktiv/i });
    expect(toggle).toBeDisabled();
    expect(screen.getByText("Nur Broadcaster und Verwalter dürfen Module ändern.")).toBeInTheDocument();
  });

  it("zeigt das Modulsymbol im Detailkopf; die Brotkrume liegt in der Kopfleiste", () => {
    render(<ModulePage
      channelId="kanal-a"
      moduleId="aktiv"
      ownRole="verwalter"
      modules={[{ id: "aktiv", enabled: true, settings: "{}" }]}
      activeModules={[{ moduleId: "aktiv", settings: "{}" }]}
      onNavigate={vi.fn()}
      onToggle={vi.fn()}
    />);

    expect(document.querySelector(".module-detail-breadcrumb")).not.toBeInTheDocument();
    expect(document.querySelector(".module-detail__icon .module-glyph")).toBeInTheDocument();
  });

  it("zeigt unbekannte und deaktivierte Modul-IDs auf der Detailseite verständlich", () => {
    const { rerender } = render(<ModulePage
      channelId="kanal-a"
      moduleId="aktiv"
      ownRole="verwalter"
      modules={[{ id: "aktiv", enabled: false, settings: "{}" }]}
      activeModules={[]}
      onNavigate={vi.fn()}
      onToggle={vi.fn()}
    />);
    expect(screen.getByText(/ist ausgeschaltet/i)).toBeInTheDocument();

    rerender(<ModulePage
      channelId="kanal-a"
      moduleId="unbekannt"
      ownRole="verwalter"
      modules={[]}
      activeModules={[]}
      onNavigate={vi.fn()}
      onToggle={vi.fn()}
    />);
    expect(screen.getByText(/ist nicht bekannt/i)).toBeInTheDocument();
  });
});
