import { useState, type ReactElement } from "react";

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const editorFixture = vi.hoisted(() => {
  const textAreaMessages = {
    countLabel: (count: number, maximum: number) => `${String(count)} / ${String(maximum)}`,
    previewCountLabel: (count: number) => `${String(count)} preview characters`,
    unknownVariable: (name: string) => `Unknown variable {${name}}`,
    insertSuggestionLabel: (name: string) => `Insert {${name}}`,
    worstCaseLength: (length: number) => `Worst case: ${String(length)}`,
  };
  const catalog = (language: "de" | "en") => ({
    title: language === "de" ? "Fixture-Einstellungen" : "Fixture settings",
    ariaLabel: language === "de" ? "Fixture-Einstellungen" : "Fixture settings",
    readOnlyReason: language === "de" ? "Nur Verwalter dürfen Fixture-Einstellungen ändern." : "Only managers may change fixture settings.",
    saveLabel: language === "de" ? "Fixture speichern" : "Save fixture",
    discardLabel: language === "de" ? "Verwerfen" : "Discard",
    savedLabel: language === "de" ? "Gespeichert." : "Saved.",
    pendingLabel: language === "de" ? "Wird gespeichert …" : "Saving …",
    invalidMessage: language === "de" ? "Ungültige Werte." : "Invalid values.",
    numberMissing: language === "de" ? "Zahl eingeben." : "Enter a number.",
    issueLabels: { error: language === "de" ? "Fehler" : "Error", warning: language === "de" ? "Hinweis" : "Warning" },
    loadError: language === "de" ? "Laden fehlgeschlagen." : "Could not load.",
    saveError: language === "de" ? "Speichern fehlgeschlagen." : "Could not save.",
    conflictMessage: language === "de" ? "Fixture wurde inzwischen geändert." : "Fixture changed concurrently.",
    reloadLabel: language === "de" ? "Serverstand laden" : "Reload server version",
    enabledLabel: language === "de" ? "An" : "On",
    disabledLabel: language === "de" ? "Aus" : "Off",
    templateMessages: textAreaMessages,
    warningLabel: () => language === "de" ? "Eine Vorlage enthält einen unbekannten Platzhalter." : "A template contains an unknown variable.",
    sections: { general: language === "de" ? "Allgemein" : "General" },
    fields: {
      amount: { label: language === "de" ? "Menge" : "Amount", hint: language === "de" ? "Eine ganze Zahl." : "A whole number.", unit: "Stück", increaseLabel: "Increase amount", decreaseLabel: "Decrease amount" },
      handle: { label: language === "de" ? "Konto" : "Handle", hint: language === "de" ? "Twitch-Name." : "Twitch name." },
      message: { label: language === "de" ? "Nachricht" : "Message", hint: language === "de" ? "Vorlage für die Nachricht." : "Message template.", previewLabel: "Preview", previewSpeaker: "Bot", variables: [{ name: "viewer", description: "Viewer name.", sample: "Ada" }] },
      mode: { label: language === "de" ? "Modus" : "Mode", hint: language === "de" ? "Wähle einen Modus." : "Choose a mode.", options: { automatic: { label: language === "de" ? "Automatisch" : "Automatic", description: "Runs automatically." }, manual: { label: language === "de" ? "Von Hand" : "Manual", description: "Runs by hand." } } },
      enabled: { label: language === "de" ? "Zusatzaktion" : "Extra action", hint: language === "de" ? "Schaltet die Zusatzaktion ein." : "Turns on the extra action.", description: language === "de" ? "Zusätzliche Aktion ausführen." : "Run an extra action." },
      threshold: { label: language === "de" ? "Schwelle" : "Threshold", hint: language === "de" ? "Mindestmenge." : "Minimum amount.", unit: "Stück", disabledReason: language === "de" ? "Zusatzaktion ist ausgeschaltet." : "Extra action is off.", increaseLabel: "Increase threshold", decreaseLabel: "Decrease threshold" },
    },
  });
  const definition = {
    spec: { sections: [{ id: "general", icon: "tabSettings", fields: [
      { kind: "number", key: "amount", min: 0, max: 10, step: 1 },
      { kind: "text", key: "handle", prefix: "@", maxLength: 32 },
      { kind: "template", key: "message", preview: (template: string, samples: Readonly<Record<string, string>>) => template.replace("{viewer}", samples.viewer ?? "") },
      { kind: "segment", key: "mode", options: [{ value: "automatic" }, { value: "manual" }] },
      { kind: "switchCard", key: "enabled", children: [{ kind: "number", key: "threshold", min: 0, max: 10, step: 1 }] },
    ] }] },
    locales: { de: catalog("de"), en: catalog("en") },
  };
  return { definition, loader: vi.fn(() => Promise.resolve({ default: definition })) };
});

const activeLoader = vi.hoisted(() => vi.fn(() => Promise.resolve({ default: () => <p>Panel geladen</p> })));

vi.mock("../../src/modules/registry", () => ({
  MODULES: [
    { id: "aktiv", settingsSchema: {}, defaultSettings: {}, panel: activeLoader },
    { id: "ohne-panel", settingsSchema: {}, defaultSettings: {} },
    {
      id: "editor-fixture",
      settingsSchema: { shape: { amount: {}, handle: {}, message: {}, mode: {}, enabled: {}, threshold: {} } },
      defaultSettings: { amount: 2, handle: "", message: "Hello {viewer}", mode: "automatic", enabled: true, threshold: 4 },
      templateFields: { message: [{ name: "viewer", sample: "Ada", maxLength: 40 }] },
      settingsEditor: editorFixture.loader,
    },
    { id: "channel_events", mandatory: true, settingsSchema: {}, defaultSettings: {} },
  ],
}));

import { UiProvider } from "../../src/dashboard/ui";
import { ModuleNavigation, ModulePanelMount, ModulePage, ModuleWorkspace } from "../../src/dashboard/module-panels";
import { useDashboardRoute } from "../../src/dashboard/router";

const renderWithMantine = (element: ReactElement): ReturnType<typeof render> => render(<UiProvider>{element}</UiProvider>);
const editorFixtureSettings = { amount: 2, handle: "ada", message: "Hello {viewer}", mode: "automatic", enabled: true, threshold: 4 };

const renderSettingsFixture = (fetcher: typeof fetch, ownRole: "manager" | "operator" = "manager"): ReturnType<typeof render> => {
  vi.stubGlobal("fetch", fetcher);
  return renderWithMantine(<ModulePage
    channelId="kanal-a"
    moduleId="editor-fixture"
    ownRole={ownRole}
    modules={[{ id: "editor-fixture", enabled: true, settings: "{}" }]}
    activeModules={[{ moduleId: "editor-fixture", settings: "{}" }]}
    onNavigate={vi.fn()}
    onToggle={vi.fn()}
  />);
};

describe("Module panel loader", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    editorFixture.loader.mockClear();
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

  it("loads a declaration lazily and renders each field with catalog copy before saving only its schema keys", async () => {
    let resolveSettings: ((response: Response) => void) | undefined;
    const deferredSettings = new Promise<Response>((resolve) => { resolveSettings = resolve; });
    let patchBody: unknown;
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      if (path === "/api/csrf") return Promise.resolve(Response.json({ token: "csrf-token" }));
      if (path.endsWith("/modules/editor-fixture/settings") && init?.method === "PATCH") {
        patchBody = typeof init.body === "string" ? JSON.parse(init.body) as unknown : null;
        const request = patchBody as { revision: number; settings: typeof editorFixtureSettings };
        return Promise.resolve(Response.json({
          settings: request.settings,
          revision: 2,
          warnings: [{ field: "message", code: "unknown_template_variables", unknownVariables: ["ghost"] }],
        }));
      }
      if (path.endsWith("/modules/editor-fixture/settings")) return deferredSettings;
      return Promise.resolve(Response.json({}));
    });
    renderSettingsFixture(fetcher);

    expect(screen.getByText("Modulansichten werden geladen …")).toBeInTheDocument();
    expect(editorFixture.loader).toHaveBeenCalledOnce();
    resolveSettings?.(Response.json({ settings: editorFixtureSettings, revision: 1, variables: [] }));

    const amount = await screen.findByRole("spinbutton", { name: "Menge" });
    const handle = screen.getByRole("textbox", { name: "Konto" });
    const message = screen.getByRole("textbox", { name: "Nachricht" });
    const mode = screen.getByRole("radiogroup", { name: "Modus" });
    const extraAction = screen.getByRole("switch", { name: /Zusatzaktion/ });
    const threshold = screen.getByRole("spinbutton", { name: "Schwelle" });
    expect(document.querySelector(".ui-field__prefix")).toHaveTextContent("@");
    expect(screen.getByText("Hello Ada")).toBeInTheDocument();
    for (const field of [amount, handle, message, mode, extraAction, threshold]) {
      const describedBy = field.getAttribute("aria-describedby");
      expect(describedBy).toBeTruthy();
      expect((describedBy ?? "").split(/\s+/u).map((id) => document.getElementById(id)?.textContent ?? "").join(" ").trim()).not.toBe("");
    }

    fireEvent.click(screen.getByRole("button", { name: "Increase amount" }));
    fireEvent.change(handle, { target: { value: "@Ada" } });
    expect(handle).toHaveValue("Ada");
    fireEvent.change(message, { target: { value: "Willkommen {viewer}!" } });
    fireEvent.click(within(mode).getByRole("radio", { name: /Von Hand/ }));
    fireEvent.click(extraAction);
    expect(threshold).toBeDisabled();
    expect(screen.getAllByText("Zusatzaktion ist ausgeschaltet.")).toHaveLength(2);
    fireEvent.click(extraAction);
    expect(threshold).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Fixture speichern" }));
    await waitFor(() => expect(patchBody).toEqual({
      revision: 1,
      settings: {
        amount: 3,
        handle: "Ada",
        message: "Willkommen {viewer}!",
        mode: "manual",
        enabled: true,
        threshold: 4,
      },
    }));
    expect(await screen.findByRole("status")).toHaveTextContent("Gespeichert. Eine Vorlage enthält einen unbekannten Platzhalter.");
  });

  it("keeps a module settings draft through a 409 and reloads the server version", async () => {
    let currentSettings = { ...editorFixtureSettings };
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      if (path === "/api/csrf") return Promise.resolve(Response.json({ token: "csrf-token" }));
      if (path.endsWith("/modules/editor-fixture/settings") && init?.method === "PATCH") return Promise.resolve(Response.json({ error: "module_settings_changed_concurrently" }, { status: 409 }));
      if (path.endsWith("/modules/editor-fixture/settings")) return Promise.resolve(Response.json({ settings: currentSettings, revision: 1, variables: [], warnings: [] }));
      return Promise.resolve(Response.json({}));
    });
    renderSettingsFixture(fetcher);

    const message = await screen.findByRole("textbox", { name: "Nachricht" });
    fireEvent.change(message, { target: { value: "Mein Entwurf {viewer}" } });
    fireEvent.click(screen.getByRole("button", { name: "Fixture speichern" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Fixture wurde inzwischen geändert.");
    expect(message).toHaveValue("Mein Entwurf {viewer}");

    currentSettings = { ...currentSettings, message: "Serverstand {viewer}" };
    fireEvent.click(screen.getByRole("button", { name: "Serverstand laden" }));
    expect(await screen.findByRole("textbox", { name: "Nachricht" })).toHaveValue("Serverstand {viewer}");
  });

  it("discards to the last server response after a successful settings save", async () => {
    const canonicalSettings = { ...editorFixtureSettings, handle: "server-canonical" };
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      if (path === "/api/csrf") return Promise.resolve(Response.json({ token: "csrf-token" }));
      if (path.endsWith("/modules/editor-fixture/settings") && init?.method === "PATCH") {
        return Promise.resolve(Response.json({ settings: canonicalSettings, revision: 2, warnings: [] }));
      }
      if (path.endsWith("/modules/editor-fixture/settings")) return Promise.resolve(Response.json({ settings: editorFixtureSettings, revision: 1, variables: [] }));
      return Promise.resolve(Response.json({}));
    });
    renderSettingsFixture(fetcher);

    const handle = await screen.findByRole("textbox", { name: "Konto" });
    fireEvent.change(handle, { target: { value: "candidate" } });
    fireEvent.click(screen.getByRole("button", { name: "Fixture speichern" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Konto" })).toHaveValue("server-canonical"));

    fireEvent.change(screen.getByRole("textbox", { name: "Konto" }), { target: { value: "unsaved-again" } });
    fireEvent.click(screen.getByRole("button", { name: "Verwerfen" }));
    expect(screen.getByRole("textbox", { name: "Konto" })).toHaveValue("server-canonical");
  });

  it("disables switch cards while a settings save is pending", async () => {
    let resolvePatch: ((response: Response) => void) | undefined;
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      if (path === "/api/csrf") return Promise.resolve(Response.json({ token: "csrf-token" }));
      if (path.endsWith("/modules/editor-fixture/settings") && init?.method === "PATCH") {
        return new Promise<Response>((resolve) => { resolvePatch = resolve; });
      }
      if (path.endsWith("/modules/editor-fixture/settings")) return Promise.resolve(Response.json({ settings: editorFixtureSettings, revision: 1, variables: [] }));
      return Promise.resolve(Response.json({}));
    });
    renderSettingsFixture(fetcher);

    fireEvent.click(await screen.findByRole("button", { name: "Increase amount" }));
    fireEvent.click(screen.getByRole("button", { name: "Fixture speichern" }));
    const switchCard = await screen.findByRole("switch", { name: /Zusatzaktion/ });
    expect(switchCard).toBeDisabled();
    resolvePatch?.(Response.json({ settings: editorFixtureSettings, revision: 2, warnings: [] }));
  });

  it("blocks route navigation from a dirty module settings editor", async () => {
    const fetcher = vi.fn<typeof fetch>((input) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      return Promise.resolve(path.endsWith("/modules/editor-fixture/settings")
        ? Response.json({ settings: editorFixtureSettings, revision: 1, variables: [] })
        : Response.json({}));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/modules/editor-fixture");
    const Harness = (): ReactElement => {
      const [route, navigate] = useDashboardRoute();
      return <>
        <button type="button" onClick={() => { navigate({ kind: "overview" }); }}>Go overview</button>
        <output>{route.kind}</output>
        {route.kind === "module" ? <ModulePage
          channelId="kanal-a"
          moduleId="editor-fixture"
          ownRole="manager"
          modules={[{ id: "editor-fixture", enabled: true, settings: "{}" }]}
          activeModules={[{ moduleId: "editor-fixture", settings: "{}" }]}
          onNavigate={vi.fn()}
          onToggle={vi.fn()}
        /> : null}
      </>;
    };
    renderWithMantine(<Harness />);

    fireEvent.change(await screen.findByRole("textbox", { name: "Konto" }), { target: { value: "draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Go overview" }));
    const guard = await screen.findByRole("dialog");
    expect(screen.getByText("module")).toBeInTheDocument();
    expect(within(guard).getByRole("button", { name: "Weiter bearbeiten" })).toBeInTheDocument();
    expect(within(guard).getByRole("button", { name: "Verwerfen und wechseln" })).toBeInTheDocument();
    expect(within(guard).getByRole("button", { name: "Speichern und wechseln" })).toBeInTheDocument();

    fireEvent.click(within(guard).getByRole("button", { name: "Weiter bearbeiten" }));
    expect(screen.getByRole("textbox", { name: "Konto" })).toHaveValue("draft");
    fireEvent.click(screen.getByRole("button", { name: "Go overview" }));
    fireEvent.click(await screen.findByRole("button", { name: "Verwerfen und wechseln" }));
    await waitFor(() => expect(screen.getByText("overview")).toBeInTheDocument());
  });

  it("keeps a dirty module draft when browser Back is canceled", async () => {
    const fetcher = vi.fn<typeof fetch>((input) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      return Promise.resolve(path.endsWith("/modules/editor-fixture/settings")
        ? Response.json({ settings: editorFixtureSettings, revision: 1, variables: [] })
        : Response.json({}));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/");
    const Harness = (): ReactElement => {
      const [route, navigate] = useDashboardRoute();
      return <>
        <button type="button" onClick={() => { navigate({ kind: "module", channelId: "kanal-a", moduleId: "editor-fixture" }); }}>Open module</button>
        <output>{route.kind}</output>
        {route.kind === "module" ? <ModulePage
          channelId="kanal-a"
          moduleId="editor-fixture"
          ownRole="manager"
          modules={[{ id: "editor-fixture", enabled: true, settings: "{}" }]}
          activeModules={[{ moduleId: "editor-fixture", settings: "{}" }]}
          onNavigate={vi.fn()}
          onToggle={vi.fn()}
        /> : null}
      </>;
    };
    renderWithMantine(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Open module" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Konto" }), { target: { value: "keep this draft" } });
    window.history.back();

    const guard = await screen.findByRole("dialog");
    expect(window.location.pathname).toBe("/");
    fireEvent.click(within(guard).getByRole("button", { name: "Weiter bearbeiten" }));
    await waitFor(() => expect(window.location.pathname).toBe("/channels/kanal-a/modules/editor-fixture"));
    expect(screen.getByRole("textbox", { name: "Konto" })).toHaveValue("keep this draft");
  });

  it("shows all declaration values read-only to an operator without form controls", async () => {
    const fetcher = vi.fn<typeof fetch>((input) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      return Promise.resolve(path.endsWith("/modules/editor-fixture/settings")
        ? Response.json({ settings: editorFixtureSettings, revision: 1, variables: [] })
        : Response.json({}));
    });
    renderSettingsFixture(fetcher, "operator");

    expect(await screen.findByText("Nur Verwalter dürfen Fixture-Einstellungen ändern.")).toBeInTheDocument();
    const properties = document.querySelector("dl.ui-settings-editor__properties");
    expect(properties).not.toBeNull();
    expect(within(properties as HTMLElement).getByText("Menge")).toBeInTheDocument();
    expect(within(properties as HTMLElement).getByText("Konto")).toBeInTheDocument();
    expect(within(properties as HTMLElement).getByText("Nachricht")).toBeInTheDocument();
    expect(within(properties as HTMLElement).getByText("Modus")).toBeInTheDocument();
    expect(within(properties as HTMLElement).getByText("Zusatzaktion")).toBeInTheDocument();
    expect(within(properties as HTMLElement).getByText("Schwelle")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(properties?.closest(".ui-editor-shell")?.querySelector("form")).toBeNull();
    expect(screen.queryByRole("button", { name: "Fixture speichern" })).not.toBeInTheDocument();
  });
});
