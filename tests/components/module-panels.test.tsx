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

describe("Module panel loader", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("links active modules to their own subpage", () => {
    const onNavigate = vi.fn();
    render(<ModuleNavigation channelId="kanal-a" activeModules={[{ moduleId: "aktiv", settings: "{}" }]} onNavigate={onNavigate} />);

    const link = screen.getByRole("link", { name: "aktiv" });
    expect(link).toHaveAttribute("href", "/channels/kanal-a/modules/aktiv");
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledWith({ kind: "module", channelId: "kanal-a", moduleId: "aktiv" });
  });

  it("does not call the lazy loader on the overview", () => {
    render(<ModulePanelMount channelId="kanal-a" activeModules={[]} />);

    expect(screen.getByText("Keine Module aktiv.")).toBeInTheDocument();
    expect(activeLoader).not.toHaveBeenCalled();
  });

  it("lazy-loads the panel only on the module subpage", async () => {
    render(<ModulePage channelId="kanal-a" moduleId="aktiv" ownRole="manager" modules={[{ id: "aktiv", enabled: true, settings: "{}" }]} activeModules={[{ moduleId: "aktiv", settings: "{}" }]} onNavigate={vi.fn()} onToggle={vi.fn()} />);

    expect(await screen.findByText("Panel geladen")).toBeInTheDocument();
    expect(activeLoader).toHaveBeenCalledTimes(1);
  });

  it("shows an explained state for an active module without a panel", () => {
    render(<ModulePage channelId="kanal-a" moduleId="ohne-panel" ownRole="manager" modules={[{ id: "ohne-panel", enabled: true, settings: "{}" }]} activeModules={[{ moduleId: "ohne-panel", settings: "{}" }]} onNavigate={vi.fn()} onToggle={vi.fn()} />);

    expect(screen.getByText("Für dieses aktive Modul gibt es noch keine Panel-Ansicht.")).toBeInTheDocument();
  });

  it("uses the module list as the source and does not claim inactive when the overview is missing", () => {
    render(<ModulePage
      channelId="kanal-a"
      moduleId="aktiv"
      ownRole="manager"
      modules={[{ id: "aktiv", enabled: true, settings: "{}" }]}
      activeModules={[]}
      onNavigate={vi.fn()}
      onToggle={vi.fn()}
    />);

    expect(screen.getByRole("switch", { name: "aktiv: Läuft" })).toBeChecked();
    expect(screen.queryByText("Das Modul „aktiv“ ist in diesem Kanal nicht aktiv.")).not.toBeInTheDocument();
    expect(screen.getByText("Module werden geladen …")).toBeInTheDocument();
  });

  it("navigates on tapping a grid tile without toggling on tap", () => {
    const fetcher = vi.fn<typeof fetch>();
    const onNavigate = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(<ModuleWorkspace channelId="kanal-a" ownRole="manager" modules={[{ id: "aktiv", enabled: true, settings: "{}" }]} onNavigate={onNavigate} />);

    const taste = screen.getByRole("link", { name: /aktiv.*Läuft/i });
    fireEvent.click(taste);

    expect(onNavigate).toHaveBeenCalledWith({ kind: "module", channelId: "kanal-a", moduleId: "aktiv" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("shows no kicker above the module heading", () => {
    render(<ModuleWorkspace channelId="kanal-a" ownRole="manager" modules={[]} onNavigate={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Module", level: 1 })).toBeInTheDocument();
    expect(screen.queryByText("Tastenraster")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Eigenschaften-Inspektor" })).not.toBeInTheDocument();
  });

  it("shows the operator the disabled detail switch with a reason", () => {
    render(<ModulePage
      channelId="kanal-a"
      moduleId="aktiv"
      ownRole="operator"
      modules={[{ id: "aktiv", enabled: true, settings: "{}" }]}
      activeModules={[{ moduleId: "aktiv", settings: "{}" }]}
      onNavigate={vi.fn()}
      onToggle={vi.fn()}
    />);

    const toggle = screen.getByRole("switch", { name: /aktiv/i });
    expect(toggle).toBeDisabled();
    expect(screen.getByText("Nur Broadcaster und Verwalter dürfen Module ändern.")).toBeInTheDocument();
  });

  it("shows the module icon in the detail header; the breadcrumb lives in the top bar", () => {
    render(<ModulePage
      channelId="kanal-a"
      moduleId="aktiv"
      ownRole="manager"
      modules={[{ id: "aktiv", enabled: true, settings: "{}" }]}
      activeModules={[{ moduleId: "aktiv", settings: "{}" }]}
      onNavigate={vi.fn()}
      onToggle={vi.fn()}
    />);

    expect(document.querySelector(".module-detail-breadcrumb")).not.toBeInTheDocument();
    expect(document.querySelector(".module-detail__icon .module-glyph")).toBeInTheDocument();
  });

  it("shows unknown and disabled module IDs understandably on the detail page", () => {
    const { rerender } = render(<ModulePage
      channelId="kanal-a"
      moduleId="aktiv"
      ownRole="manager"
      modules={[{ id: "aktiv", enabled: false, settings: "{}" }]}
      activeModules={[]}
      onNavigate={vi.fn()}
      onToggle={vi.fn()}
    />);
    expect(screen.getByText(/ist ausgeschaltet/i)).toBeInTheDocument();

    rerender(<ModulePage
      channelId="kanal-a"
      moduleId="unbekannt"
      ownRole="manager"
      modules={[]}
      activeModules={[]}
      onNavigate={vi.fn()}
      onToggle={vi.fn()}
    />);
    expect(screen.getByText(/ist nicht bekannt/i)).toBeInTheDocument();
  });
});
