import { useState, type ReactElement } from "react";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const activeLoader = vi.hoisted(() => vi.fn(() => Promise.resolve({ default: () => <p>Panel geladen</p> })));

vi.mock("../../src/modules/registry", () => ({
  MODULES: [
    { id: "aktiv", settingsSchema: {}, defaultSettings: {}, panel: activeLoader },
    { id: "ohne-panel", settingsSchema: {}, defaultSettings: {} },
    { id: "channel_events", mandatory: true, settingsSchema: {}, defaultSettings: {} },
  ],
}));

import { UiProvider } from "../../src/dashboard/ui";
import { ModuleNavigation, ModulePanelMount, ModulePage, ModuleWorkspace } from "../../src/dashboard/module-panels";

const renderWithMantine = (element: ReactElement): ReturnType<typeof render> => render(<UiProvider>{element}</UiProvider>);

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

  it("navigates from the module row click and Enter, while the switch toggles without navigation", async () => {
    const fetcher = vi.fn<typeof fetch>((input) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      return Promise.resolve(path === "/api/csrf"
        ? Response.json({ token: "csrf-token" })
        : Response.json({ module: { id: "aktiv", enabled: false, settings: "{}" } }));
    });
    const onNavigate = vi.fn();
    const onChanged = vi.fn(() => Promise.resolve());
    vi.stubGlobal("fetch", fetcher);
    renderWithMantine(<ModuleWorkspace channelId="kanal-a" ownRole="manager" modules={[{ id: "aktiv", enabled: true, settings: "{}" }]} onNavigate={onNavigate} onChanged={onChanged} />);

    const link = screen.getByRole("link", { name: /aktiv.*Läuft/i });
    fireEvent.click(link);
    expect(onNavigate).toHaveBeenCalledTimes(1);
    link.focus();
    fireEvent.keyDown(link, { key: "Enter" });
    expect(onNavigate).toHaveBeenCalledTimes(2);
    const row = link.closest(".list-row");
    if (!(row instanceof HTMLElement)) throw new Error("Module row is missing");
    expect(within(row).getAllByText("aktiv", { exact: true })).toHaveLength(1);
    expect(within(row).getAllByText("Läuft", { exact: true })).toHaveLength(1);
    expect(within(row).queryByRole("checkbox")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("switch", { name: "aktiv" }));
    await waitFor(() => { expect(onChanged).toHaveBeenCalledTimes(1); });
    expect(onNavigate).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.some(([, requestInit]) => requestInit?.method === "PATCH")).toBe(true);
  });

  it("shows mandatory channel events as always active without rendering a switch", () => {
    renderWithMantine(<ModuleWorkspace channelId="kanal-a" ownRole="manager" modules={[]} onNavigate={vi.fn()} onChanged={vi.fn(() => Promise.resolve())} />);

    expect(screen.queryByRole("switch", { name: "Kanalereignisse" })).not.toBeInTheDocument();
    const status = screen.getByText("Läuft · immer aktiv");
    expect(status.closest(".module-locked-status")).toHaveAttribute("title", "Kanalereignisse sind immer aktiv.");
    expect(status.closest(".module-locked-status")).toHaveAttribute("aria-description", "Kanalereignisse sind immer aktiv.");
  });

  it("shows the mandatory module detail as always active without a switch", () => {
    renderWithMantine(<ModulePage
      channelId="kanal-a"
      moduleId="channel_events"
      ownRole="manager"
      modules={[{ id: "channel_events", enabled: true, mandatory: true, settings: "{}" }]}
      activeModules={[]}
      onNavigate={vi.fn()}
      onToggle={vi.fn()}
    />);

    expect(screen.queryByRole("switch", { name: "Kanalereignisse: Läuft" })).not.toBeInTheDocument();
    const status = screen.getByText("Läuft · immer aktiv");
    expect(status.closest(".module-locked-status")).toHaveAttribute("title", "Kanalereignisse sind immer aktiv.");
    expect(status.closest(".module-locked-status")).toHaveAttribute("aria-description", "Kanalereignisse sind immer aktiv.");
    expect(screen.queryByText("Module werden geladen …")).not.toBeInTheDocument();
  });

  it("shows the module name and state once in the row", () => {
    renderWithMantine(<ModuleWorkspace channelId="kanal-a" ownRole="manager" modules={[{ id: "aktiv", enabled: true, settings: "{}" }]} onNavigate={vi.fn()} onChanged={vi.fn(() => Promise.resolve())} />);
    const row = screen.getByRole("link", { name: /aktiv.*Läuft/i }).closest(".list-row");
    if (!(row instanceof HTMLElement)) throw new Error("Module row is missing");
    expect(within(row).getAllByText("aktiv", { exact: true })).toHaveLength(1);
    expect(within(row).getAllByText("Läuft", { exact: true })).toHaveLength(1);
  });

  it("toggles a module and reloads the caller's list afterwards", async () => {
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(Response.json({ module: { id: "aktiv", enabled: false, settings: "{}" } })));
    vi.stubGlobal("fetch", fetcher);
    const onNavigate = vi.fn();
    const Harness = (): ReactElement => {
      const [modules, setModules] = useState([{ id: "aktiv", enabled: true, settings: "{}" }]);
      const onChanged = (): Promise<void> => {
        setModules([{ id: "aktiv", enabled: false, settings: "{}" }]);
        return Promise.resolve();
      };
      return <ModuleWorkspace channelId="kanal-a" ownRole="manager" modules={modules} onNavigate={onNavigate} onChanged={onChanged} />;
    };
    renderWithMantine(<Harness />);

    const toggle = screen.getByRole("switch", { name: /aktiv/i });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);

    await waitFor(() => { expect(screen.getByRole("switch", { name: /aktiv/i })).not.toBeChecked(); });
    const [url, init] = fetcher.mock.calls.find(([, requestInit]) => requestInit?.method === "PATCH") ?? [];
    expect(url instanceof URL ? url.pathname : url).toBe("/api/channels/kanal-a/modules/aktiv");
    expect(init?.body).toBe(JSON.stringify({ enabled: false }));
  });

  it("sends exactly one PATCH for two rapid clicks on the same switch", async () => {
    let resolvePatch: ((response: Response) => void) | undefined;
    const patch = new Promise<Response>((resolve) => { resolvePatch = resolve; });
    const fetcher = vi.fn<typeof fetch>((_input, init) =>
      init?.method === "PATCH" ? patch : Promise.resolve(Response.json({ modules: [] })));
    const onChanged = vi.fn(() => Promise.resolve());
    vi.stubGlobal("fetch", fetcher);
    renderWithMantine(<ModuleWorkspace channelId="kanal-a" ownRole="manager" modules={[{ id: "aktiv", enabled: true, settings: "{}" }]} onNavigate={vi.fn()} onChanged={onChanged} />);

    const toggle = screen.getByRole("switch", { name: /aktiv/i });
    fireEvent.click(toggle);
    // The switch disables itself while pending, so a second click through
    // the DOM is a no-op; `fireEvent.click` still lets us assert that.
    fireEvent.click(toggle);

    resolvePatch?.(Response.json({ module: { id: "aktiv", enabled: false, settings: "{}" } }));
    await waitFor(() => { expect(onChanged).toHaveBeenCalledTimes(1); });
    expect(fetcher.mock.calls.filter(([, requestInit]) => requestInit?.method === "PATCH")).toHaveLength(1);
  });

  it("shows no kicker above the module heading", () => {
    renderWithMantine(<ModuleWorkspace channelId="kanal-a" ownRole="manager" modules={[]} onNavigate={vi.fn()} onChanged={vi.fn(() => Promise.resolve())} />);

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
    const reason = screen.getByText("Nur Broadcaster und Verwalter dürfen Module ändern.");
    expect(reason).toBeInTheDocument();
    expect(reason.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(reason).toHaveTextContent("Nur Broadcaster und Verwalter dürfen Module ändern.");
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
