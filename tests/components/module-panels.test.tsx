import { useState, type ReactElement } from "react";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const editorFixture = vi.hoisted(() => {
  const templateMessages = {
    countLabel: (count: number, maximum: number) => `${String(count)} / ${String(maximum)}`,
    previewCountLabel: (count: number) => `${String(count)} preview characters`,
    openBrace: "Unclosed variable: add a closing brace }.",
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
    templateMessages,
    warningLabel: () => language === "de" ? "Eine Vorlage enthält einen unbekannten Platzhalter." : "A template contains an unknown variable.",
    sections: { general: language === "de" ? "Allgemein" : "General", extra: language === "de" ? "Weitere" : "Extra" },
    fields: {
      amount: { label: language === "de" ? "Menge" : "Amount", hint: language === "de" ? "Eine ganze Zahl." : "A whole number.", invalidError: language === "de" ? "Mindestens ein Stück." : "Use at least one item.", unit: "Stück" },
      handle: { label: language === "de" ? "Konto" : "Handle", hint: language === "de" ? "Twitch-Name." : "Twitch name." },
      labels: { label: language === "de" ? "Abstimmungslabels" : "Vote labels", hint: language === "de" ? "Leer lassen für Standardwerte." : "Leave blank to use defaults.", placeholder: "Yes|No", invalidError: language === "de" ? "Gib zwei gültige Labels ein." : "Enter two valid labels." },
      message: { label: language === "de" ? "Nachricht" : "Message", hint: language === "de" ? "Vorlage für die Nachricht." : "Message template.", previewLabel: "Preview", previewSpeaker: "Bot", variables: [{ name: "viewer", description: "Viewer name.", sample: "Ada" }] },
      mode: { label: language === "de" ? "Modus" : "Mode", hint: language === "de" ? "Wähle einen Modus." : "Choose a mode.", options: { automatic: { label: language === "de" ? "Automatisch" : "Automatic", description: "Runs automatically." }, manual: { label: language === "de" ? "Von Hand" : "Manual", description: "Runs by hand." } } },
      enabled: { label: language === "de" ? "Zusatzaktion" : "Extra action", hint: language === "de" ? "Schaltet die Zusatzaktion ein." : "Turns on the extra action.", description: language === "de" ? "Zusätzliche Aktion ausführen." : "Run an extra action." },
      threshold: { label: language === "de" ? "Schwelle" : "Threshold", hint: language === "de" ? "Mindestmenge." : "Minimum amount.", unit: "Stück", disabledReason: language === "de" ? "Zusatzaktion ist ausgeschaltet." : "Extra action is off." },
      extraMessage: { label: language === "de" ? "Zusatznachricht" : "Extra message", hint: language === "de" ? "Zusätzlicher Inhalt." : "Additional content." },
    },
  });
  const definition = {
    spec: { sections: [
      { id: "general", icon: "tabSettings", fields: [
        { kind: "number", key: "amount", min: 0, max: 10, step: 1, validate: (value: number) => value >= 1 },
        { kind: "text", key: "handle", prefix: "@", maxLength: 32 },
        { kind: "text", key: "labels", optional: true, validate: (value: string) => value.trim().length === 0 || value === "Yes|No" },
        { kind: "template", key: "message", preview: (template: string, samples: Readonly<Record<string, string>>) => template.replace("{viewer}", samples.viewer ?? "") },
        { kind: "segment", key: "mode", options: [{ value: "automatic" }, { value: "manual" }] },
        { kind: "switchCard", key: "enabled", children: [{ kind: "number", key: "threshold", min: 0, max: 10, step: 1 }] },
      ] },
      { id: "extra", icon: "tabSettings", fields: [
        { kind: "text", key: "extraMessage", optional: true },
      ] },
    ] },
    locales: { de: catalog("de"), en: catalog("en") },
  };
  const belaboxCatalog = (language: "de" | "en") => {
    const base = catalog(language);
    return {
      ...base,
      sections: {
        ...base.sections,
        polling: language === "de" ? "Abfrage" : "Polling",
        alerts: language === "de" ? "Meldungen" : "Alerts",
      },
      fields: {
        ...base.fields,
        chatCooldownSeconds: {
          label: language === "de" ? "Chat-Abkühlzeit" : "Chat cooldown",
          hint: language === "de" ? "Wartezeit zwischen Chatmeldungen." : "Wait time between chat messages.",
          unit: "s",
        },
      },
    };
  };
  const belaboxDefinition = {
    spec: { sections: [
      { id: "polling", icon: "tabSettings", fields: [
        { kind: "number", key: "chatCooldownSeconds", min: 0, max: 86_400, step: 1 },
      ] },
      { id: "alerts", icon: "tabSettings", fields: [] },
    ] },
    locales: { de: belaboxCatalog("de"), en: belaboxCatalog("en") },
  };
  return {
    definition,
    loader: vi.fn(() => Promise.resolve({ default: definition })),
    belaboxDefinition,
    belaboxLoader: vi.fn(() => Promise.resolve({ default: belaboxDefinition })),
  };
});

const activeLoader = vi.hoisted(() => vi.fn(() => Promise.resolve({ default: () => <p>Panel geladen</p> })));
const relatedPanelLoader = vi.hoisted(() => vi.fn());
const belaboxPanelLoader = vi.hoisted(() => vi.fn());

vi.mock("../../src/modules/registry", () => ({
  MODULES: [
    {
      id: "points",
      navigationCategory: "participation",
      settingsSchema: {},
      defaultSettings: {},
      navigationEntries: [{ id: "points", label: { de: "Punkte", en: "Points" }, iconKind: "points", keywords: ["points"] }],
    },
    {
      id: "emote_slots",
      navigationCategory: "games",
      requiresModules: ["points"],
      settingsSchema: {},
      defaultSettings: {},
      navigationEntries: [{ id: "slot", label: { de: "Slot", en: "Slot" }, iconKind: "slot", keywords: ["slot"] }],
    },
    {
      id: "aktiv",
      navigationCategory: "chat",
      settingsSchema: {},
      defaultSettings: {},
      chatCommands: [{
        name: "!sample",
        syntax: "!sample @user",
        description: { de: "Startet einen Beispielbefehl.", en: "Starts an example command." },
        arguments: [{ name: "@user", hint: { de: "Twitch-Login.", en: "Twitch login." } }],
        minimumChatStatus: "everyone",
      }],
      panel: activeLoader,
    },
    {
      id: "ohne-panel",
      navigationCategory: "chat",
      mandatory: true,
      mandatoryReason: { de: "Das Modul stellt einen notwendigen Fixture-Wert bereit.", en: "The module provides a required fixture value." },
      settingsSchema: {},
      defaultSettings: {},
      navigationEntries: [{
        id: "ohne-panel",
        label: { de: "Fixture-Wert", en: "Fixture value" },
        description: { de: "Dieses Modul erklärt den Zweck.", en: "This module explains its purpose." },
        iconKind: "texts",
      }],
      templateVariableCatalog: [{
        name: "fixture.value",
        maxLength: 20,
        sample: "42",
        picker: {
          de: { label: "Fixture-Wert", description: "Stellt einen Fixture-Wert bereit." },
          en: { label: "Fixture value", description: "Provides a fixture value." },
        },
      }],
    },
    {
      id: "channel-page-fixture",
      navigationCategory: "chat",
      mandatory: true,
      mandatoryReason: { de: "Diese Kanalansicht ist erforderlich.", en: "This channel view is required." },
      settingsSchema: {},
      defaultSettings: {},
      navigationEntries: [{
        id: "texts",
        label: { de: "Texte", en: "Texts" },
        showMainSwitch: false,
        iconKind: "texts",
      }],
    },
    {
      id: "editor-fixture",
      navigationCategory: "chat",
      settingsSchema: { shape: { amount: {}, handle: {}, labels: {}, message: {}, mode: {}, enabled: {}, threshold: {}, extraMessage: {} } },
      defaultSettings: { amount: 2, handle: "", labels: "", message: "Hello {viewer}", mode: "automatic", enabled: true, threshold: 4, extraMessage: "Extra value" },
      templateFields: { message: [{ name: "viewer", sample: "Ada", maxLength: 40 }] },
      settingsEditor: editorFixture.loader,
    },
    {
      id: "editor-lazy-fixture",
      settingsSchema: { shape: { amount: {}, handle: {}, labels: {}, message: {}, mode: {}, enabled: {}, threshold: {}, extraMessage: {} } },
      defaultSettings: { amount: 2, handle: "", labels: "", message: "Hello {viewer}", mode: "automatic", enabled: true, threshold: 4, extraMessage: "Extra value" },
      templateFields: { message: [{ name: "viewer", sample: "Ada", maxLength: 40 }] },
      settingsEditor: editorFixture.loader,
    },
    {
      id: "editor-before-fixture",
      navigationCategory: "chat",
      settingsSchema: { shape: { amount: {}, handle: {}, labels: {}, message: {}, mode: {}, enabled: {}, threshold: {}, extraMessage: {} } },
      defaultSettings: { amount: 2, handle: "", labels: "", message: "Hello {viewer}", mode: "automatic", enabled: true, threshold: 4, extraMessage: "Extra value" },
      templateFields: { message: [{ name: "viewer", sample: "Ada", maxLength: 40 }] },
      panel: relatedPanelLoader,
      settingsEditor: editorFixture.loader,
      settingsEditorPlacement: "before-panel",
      settingsEditorRelatedParts: ["panel"],
    },
    {
      id: "belabox",
      navigationCategory: "chat",
      settingsSchema: { shape: { chatCooldownSeconds: {} } },
      defaultSettings: { chatCooldownSeconds: 300 },
      panel: belaboxPanelLoader,
      settingsEditor: editorFixture.belaboxLoader,
    },
    { id: "channel_events", mandatory: true, mandatoryReason: { de: "Ereignisdaten sind immer verfügbar.", en: "Event data is always available." }, settingsSchema: {}, defaultSettings: {} },
  ],
}));

import { UiProvider } from "../../src/dashboard/ui";
import { dismissToast, toastsSnapshot } from "../../src/dashboard/ui/toast-store";
import { ModuleNavigation, ModulePanelMount, ModulePage, ModuleWorkspace } from "../../src/dashboard/module-panels";
import { moduleQueryKey } from "../../src/dashboard/data";
import { useModuleQuery } from "../../src/dashboard/data";
import { useDashboardRoute } from "../../src/dashboard/router";
import { renderWithQuery } from "../query-test-utils";

const ActivePanelProbe = ({ channelId }: { channelId: string }): ReactElement => {
  const query = useModuleQuery(channelId, "editor-before-fixture", "panel", async (signal) => {
    const response = await fetch(`/api/channels/${encodeURIComponent(channelId)}/modules/editor-before-fixture/panel-state`, { signal });
    const result: unknown = await response.json();
    if (typeof result !== "object" || result === null) throw new Error("The panel response is invalid.");
    if (!("revision" in result)) throw new Error("The panel response is missing its revision.");
    const revision: unknown = result.revision;
    if (typeof revision !== "number") throw new Error("The panel response is missing its revision.");
    return { revision };
  });
  return <><p>Panel geladen</p><output data-testid="panel-settings-revision">{String(query.data?.revision ?? (query.isError ? `Error: ${String(query.error)}` : "Loading"))}</output></>;
};

relatedPanelLoader.mockImplementation(() => Promise.resolve({ default: ActivePanelProbe }));

const renderWithUiProvider = (element: ReactElement, queryOptions: { gcTime?: number; staleTime?: number } = {}): ReturnType<typeof renderWithQuery> =>
  renderWithQuery(<UiProvider>{element}</UiProvider>, undefined, queryOptions);
const editorFixtureSettings = { amount: 2, handle: "ada", labels: "", message: "Hello {viewer}", mode: "automatic", enabled: true, threshold: 4, extraMessage: "Extra value" };

let completeBelaboxRemoval: (() => void) | undefined;

const BelaboxRemovalProbe = ({
  onStatsUrlDraftChange,
  onSettingsRevisionChange,
}: {
  onStatsUrlDraftChange?: (value: string) => void;
  onSettingsRevisionChange?: (revision: number) => void;
}): ReactElement | null => onStatsUrlDraftChange === undefined
  ? null
  : <button type="button" onClick={() => {
    const updateDraft = onStatsUrlDraftChange;
    const updateRevision = onSettingsRevisionChange;
    void new Promise<void>((resolve) => { completeBelaboxRemoval = resolve; }).then(() => {
      updateRevision?.(2);
      updateDraft("");
    });
  }}>Remove BELABOX URL</button>;

const renderSettingsFixture = (
  fetcher: typeof fetch,
  ownRole: "manager" | "operator" = "manager",
  queryOptions: { gcTime?: number; staleTime?: number } = {},
  moduleId = "editor-fixture",
): ReturnType<typeof renderWithQuery> => {
  vi.stubGlobal("fetch", fetcher);
  return renderWithUiProvider(<ModulePage
    channelId="kanal-a"
    moduleId={moduleId}
    ownRole={ownRole}
    modules={[{ id: moduleId, enabled: true, settings: "{}" }]}
    activeModules={[{ moduleId, settings: "{}" }]}
    onNavigate={vi.fn()}
    onToggle={vi.fn()}
  />, queryOptions);
};

describe("Module panel loader", () => {
  afterEach(() => {
    cleanup();
    for (const toast of toastsSnapshot()) dismissToast(toast.id);
    vi.unstubAllGlobals();
    editorFixture.loader.mockClear();
    editorFixture.belaboxLoader.mockClear();
    belaboxPanelLoader.mockClear();
    completeBelaboxRemoval = undefined;
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

  it("shows generic information for active panel-less modules on the overview", () => {
    render(<ModulePanelMount channelId="kanal-a" activeModules={[{ moduleId: "ohne-panel", settings: "{}" }]} />);

    expect(screen.getByText("Dieses Modul erklärt den Zweck.")).toBeDefined();
    expect(screen.getByText("Das Modul stellt einen notwendigen Fixture-Wert bereit.")).toBeDefined();
    expect(screen.getByText("{fixture.value}", { exact: true })).toBeDefined();
    expect(activeLoader).not.toHaveBeenCalled();
  });

  it("lazy-loads the panel only on the module subpage", async () => {
    render(<ModulePage channelId="kanal-a" moduleId="aktiv" ownRole="manager" modules={[{ id: "aktiv", enabled: true, settings: "{}" }]} activeModules={[{ moduleId: "aktiv", settings: "{}" }]} onNavigate={vi.fn()} onToggle={vi.fn()} />);

    expect(await screen.findByText("Panel geladen")).toBeInTheDocument();
    expect(activeLoader).toHaveBeenCalledTimes(1);
  });

  it("keeps declared chat command help in the module header while module data loads", async () => {
    const common = {
      channelId: "kanal-a",
      moduleId: "aktiv",
      ownRole: "manager" as const,
      modules: [{ id: "aktiv", enabled: true, settings: "{}" }],
      onNavigate: vi.fn(),
      onToggle: vi.fn(),
    };
    const { rerender } = render(<ModulePage {...common} activeModules={[]} />);

    const commandButton = screen.getByRole("button", { name: /Chatbefehle · 1|Chat commands · 1/ });
    fireEvent.click(commandButton);
    const commands = screen.getByRole("dialog", { name: /Chatbefehle|Chat commands/ });
    expect(commands).toHaveTextContent("!sample @user");
    expect(commands).toHaveTextContent(/Twitch-Login\.|Twitch login\./);

    rerender(<ModulePage {...common} activeModules={[{ moduleId: "aktiv", settings: "{}" }]} />);

    expect(await screen.findByText("Panel geladen")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Chatbefehle · 1|Chat commands · 1/ })).toBe(commandButton);
    expect(screen.getByRole("dialog", { name: /Chatbefehle|Chat commands/ })).toBe(commands);
  });

  it("places a long module panel after its settings editor", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({
      settings: editorFixtureSettings,
      revision: 1,
      variables: [],
    }))));
    renderWithUiProvider(<ModulePage
      channelId="kanal-a"
      moduleId="editor-before-fixture"
      ownRole="manager"
      modules={[{ id: "editor-before-fixture", enabled: true, settings: "{}" }]}
      activeModules={[{ moduleId: "editor-before-fixture", settings: "{}" }]}
      onNavigate={vi.fn()}
      onToggle={vi.fn()}
    />);

    const settings = await screen.findByRole("region", { name: "Fixture-Einstellungen" });
    const panel = await screen.findByText("Panel geladen");
    expect(settings.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
  });

  it("renders generic module information when an active module has no panel", () => {
    render(<ModulePage channelId="kanal-a" moduleId="ohne-panel" ownRole="manager" modules={[{ id: "ohne-panel", enabled: true, settings: "{}" }]} activeModules={[{ moduleId: "ohne-panel", settings: "{}" }]} onNavigate={vi.fn()} onToggle={vi.fn()} />);

    expect(screen.getByText("Dieses Modul erklärt den Zweck.")).toBeDefined();
    expect(screen.getByText("Das Modul stellt einen notwendigen Fixture-Wert bereit.")).toBeDefined();
    const catalog = within(screen.getByRole("region", { name: "Vorlagenvariablen" }));
    expect(catalog.getByRole("heading", { name: "Fixture-Wert" })).toBeDefined();
    expect(catalog.getByText("fixture.value", { exact: true })).toBeDefined();
    expect(catalog.getByText("Stellt einen Fixture-Wert bereit.")).toBeDefined();
    expect(catalog.getByText("{fixture.value}", { exact: true })).toBeDefined();
    expect(screen.queryByText("Für dieses aktive Modul gibt es noch keine Panel-Ansicht.")).toBeNull();
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
    const onNavigate = vi.fn();
    const onToggleModule = vi.fn(() => Promise.resolve());
    renderWithUiProvider(<ModuleWorkspace channelId="kanal-a" ownRole="manager" modules={[{ id: "aktiv", enabled: true, settings: "{}" }]} onNavigate={onNavigate} onToggleModule={onToggleModule} />);

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

    fireEvent.click(screen.getByRole("switch", { name: /^aktiv:/i }));
    await waitFor(() => { expect(onToggleModule).toHaveBeenCalledWith("kanal-a", "aktiv", false); });
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });

  it("locks a module row until its required module is enabled (protects=the Slot switch shows its missing points dependency and cannot send a toggle request; fails_when=the switch stays enabled, omits the dependency reason, or calls the mutation handler; no_claim=server enforcement for a concurrent manager)", () => {
    const onToggleModule = vi.fn(() => Promise.resolve());
    renderWithUiProvider(<ModuleWorkspace
      channelId="kanal-a"
      ownRole="manager"
      modules={[
        { id: "points", enabled: false, settings: "{}" },
        { id: "emote_slots", enabled: false, settings: "{}" },
      ]}
      onNavigate={vi.fn()}
      onToggleModule={onToggleModule}
    />);

    const slotSwitch = screen.getByRole("switch", { name: "Slot: Aus" });
    expect(slotSwitch).toBeDisabled();
    expect(screen.getByText("Benötigt: Punkte")).toBeInTheDocument();
    fireEvent.click(slotSwitch);
    expect(onToggleModule).not.toHaveBeenCalled();
  });

  it("locks points while an enabled game still depends on them (protects=the points switch names active dependent modules and cannot disable the requirement; fails_when=points can be disabled or its lock reason omits the enabled game; no_claim=which server state wins if managers toggle concurrently)", () => {
    const onToggleModule = vi.fn(() => Promise.resolve());
    renderWithUiProvider(<ModuleWorkspace
      channelId="kanal-a"
      ownRole="manager"
      modules={[
        { id: "points", enabled: true, settings: "{}" },
        { id: "emote_slots", enabled: true, settings: "{}" },
      ]}
      onNavigate={vi.fn()}
      onToggleModule={onToggleModule}
    />);

    const pointsSwitch = screen.getByRole("switch", { name: "Punkte: Läuft" });
    expect(pointsSwitch).toBeDisabled();
    expect(screen.getByText("Erst ausschalten: Slot")).toBeInTheDocument();
    fireEvent.click(pointsSwitch);
    expect(onToggleModule).not.toHaveBeenCalled();
  });

  it("locks the Slot page header switch when points are disabled (protects=the Slot page header explains its missing points dependency without moving the page; fails_when=the header switch remains enabled or lacks the existing lock hint; no_claim=the browser layout at other viewport sizes)", () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify({ settings: {}, revision: 1, variables: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }))));
    const onToggle = vi.fn();
    renderWithUiProvider(<ModulePage
      channelId="kanal-a"
      moduleId="emote_slots"
      ownRole="manager"
      modules={[
        { id: "points", enabled: false, settings: "{}" },
        { id: "emote_slots", enabled: false, settings: "{}" },
      ]}
      activeModules={[]}
      onNavigate={vi.fn()}
      onToggle={onToggle}
    />);

    const slotSwitch = screen.getByRole("switch", { name: "Slot: Aus" });
    expect(slotSwitch).toBeDisabled();
    expect(screen.getByText("Benötigt: Punkte")).toBeInTheDocument();
    fireEvent.click(slotSwitch);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("shows mandatory channel events as always active without rendering a switch", () => {
    renderWithUiProvider(<ModuleWorkspace channelId="kanal-a" ownRole="manager" modules={[]} onNavigate={vi.fn()} onToggleModule={vi.fn(() => Promise.resolve())} />);

    expect(screen.queryByRole("switch", { name: "Kanalereignisse" })).not.toBeInTheDocument();
    const row = screen.getByText("Kanalereignisse").closest(".list-row");
    const status = within(row as HTMLElement).getByText("Läuft · immer aktiv");
    expect(within(row as HTMLElement).getByRole("note")).toHaveTextContent("Ereignisdaten sind immer verfügbar.");
    expect(within(row?.querySelector(".list-row__description") as HTMLElement).getByRole("note")).toBeInTheDocument();
    expect(row?.querySelector(".list-row__status")).not.toHaveTextContent("Ereignisdaten sind immer verfügbar.");
    expect(status.closest(".module-locked-status")).toHaveAttribute("title", "Ereignisdaten sind immer verfügbar.");
    expect(status.closest(".module-locked-status")).not.toHaveAttribute("aria-description");
    expect(status.closest(".module-locked-status")).toHaveAttribute("aria-label", "Läuft · immer aktiv");
    // The note already carries the reason, so the link's accessible name must contain it exactly once.
    const link = within(row as HTMLElement).getByRole("link");
    expect(link).toHaveAccessibleName(expect.stringContaining("Ereignisdaten sind immer verfügbar."));
    expect(link).toHaveAccessibleName(expect.not.stringMatching(/Ereignisdaten sind immer verfügbar\.[^]*Ereignisdaten sind immer verfügbar\./u));
  });

  it("shows the mandatory module detail as always active without a switch", () => {
    render(<ModulePage
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
    expect(status.closest(".module-locked-status")).toHaveAttribute("title", "Ereignisdaten sind immer verfügbar.");
    expect(status.closest(".module-locked-status")).toHaveAttribute("aria-description", "Ereignisdaten sind immer verfügbar.");
    expect(status.closest(".module-locked-status")).toHaveAttribute("aria-label", "Läuft · immer aktiv: Ereignisdaten sind immer verfügbar.");
    expect(screen.queryByText("Ereignisdaten sind immer verfügbar.")).not.toBeInTheDocument();
    expect(document.querySelector(".module-detail-heading .page-header__meta")).toBeNull();
    expect(screen.queryByText("Module werden geladen …")).not.toBeInTheDocument();
  });

  it("lets a registered channel page hide its always-active main switch and use its declared icon", () => {
    renderWithUiProvider(<ModulePage
      channelId="kanal-a"
      moduleId="channel-page-fixture"
      ownRole="manager"
      modules={[{ id: "channel-page-fixture", enabled: true, mandatory: true, settings: "{}" }]}
      activeModules={[]}
      onNavigate={vi.fn()}
      onToggle={vi.fn()}
    />);

    expect(screen.getByRole("heading", { name: "Texte", level: 1 })).toBeInTheDocument();
    expect(screen.queryByText("Hauptschalter")).not.toBeInTheDocument();
    const icon = document.querySelector(".module-detail__icon svg");
    expect(icon).toHaveClass("module-glyph");
    expect(icon?.querySelector("rect")).toBeNull();
    expect(icon?.querySelector("path")).toBeInTheDocument();
  });

  it("allows blank optional labels and waits for interaction before showing their validation error", async () => {
    const fetcher = vi.fn<typeof fetch>((input) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      return Promise.resolve(path.endsWith("/modules/editor-fixture/settings")
        ? Response.json({ settings: editorFixtureSettings, revision: 1, variables: [] })
        : Response.json({}));
    });
    renderSettingsFixture(fetcher);

    const labels = await screen.findByRole("textbox", { name: "Abstimmungslabels" });
    expect(labels).toHaveAttribute("placeholder", "Yes|No");
    expect(labels).toHaveValue("");
    expect(screen.queryByText("Gib zwei gültige Labels ein.")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Allgemein" })).toBeInTheDocument();

    fireEvent.change(labels, { target: { value: "Yes|" } });
    expect(await screen.findByText("Gib zwei gültige Labels ein.")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Allgemein, Fehler" })).toBeInTheDocument();

    fireEvent.change(labels, { target: { value: "" } });
    expect(screen.queryByText("Gib zwei gültige Labels ein.")).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Allgemein" })).toBeInTheDocument();
  });

  it("maps every blocking settings validation error to a marked field and summary link", async () => {
    const fetcher = vi.fn<typeof fetch>((input) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      return Promise.resolve(path.endsWith("/modules/editor-fixture/settings")
        ? Response.json({ settings: editorFixtureSettings, revision: 1, variables: [] })
        : Response.json({}));
    });
    renderSettingsFixture(fetcher);

    const invalidControls: readonly (readonly [HTMLElement, string])[] = [
      [await screen.findByRole("spinbutton", { name: "Menge" }), ""],
      [screen.getByRole("textbox", { name: "Konto" }), ""],
      [screen.getByRole("textbox", { name: "Abstimmungslabels" }), "Yes|"],
      [screen.getByRole("textbox", { name: "Nachricht" }), ""],
      [screen.getByRole("spinbutton", { name: "Schwelle" }), ""],
    ];
    for (const [control, value] of invalidControls) fireEvent.change(control, { target: { value } });

    const expectedErrors = [
      ["Menge", "Zahl eingeben."],
      ["Konto", "Ungültige Werte."],
      ["Abstimmungslabels", "Gib zwei gültige Labels ein."],
      ["Nachricht", "Ungültige Werte."],
      ["Schwelle", "Zahl eingeben."],
    ] as const;
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent(`${String(expectedErrors.length)} Felder fehlerhaft`);
    fireEvent.click(within(status).getByRole("button", { name: "Fehlerhafte Felder anzeigen" }));
    expect(within(await screen.findByRole("dialog", { name: "Fehlerhafte Felder" })).getAllByRole("button")).toHaveLength(expectedErrors.length);
    expect(screen.getByRole("tab", { name: "Allgemein, Fehler" })).toBeInTheDocument();
    for (const [label, message] of expectedErrors) {
      // Activating a link closes the popover at once, so each link needs it reopened.
      if (screen.queryByRole("dialog", { name: "Fehlerhafte Felder" }) === null) fireEvent.click(within(status).getByRole("button", { name: "Fehlerhafte Felder anzeigen" }));
      const invalidPopover = await screen.findByRole("dialog", { name: "Fehlerhafte Felder" });
      const control = screen.getByRole(label === "Menge" || label === "Schwelle" ? "spinbutton" : "textbox", { name: label });
      expect(control).toHaveAttribute("aria-invalid", "true");
      fireEvent.click(within(invalidPopover).getByRole("button", { name: `${label}: ${message}` }));
      expect(control).toHaveFocus();
    }
  });

  it("reveals untouched custom validation errors when another field already blocks saving", async () => {
    const initialSettings = { ...editorFixtureSettings, labels: "Yes|" };
    const fetcher = vi.fn<typeof fetch>((input) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      return Promise.resolve(path.endsWith("/modules/editor-fixture/settings")
        ? Response.json({ settings: initialSettings, revision: 1, variables: [] })
        : Response.json({}));
    });
    renderSettingsFixture(fetcher);

    const handle = await screen.findByRole("textbox", { name: "Konto" });
    const labels = screen.getByRole("textbox", { name: "Abstimmungslabels" });
    fireEvent.change(handle, { target: { value: "" } });
    expect(handle).toHaveAttribute("aria-invalid", "true");
    expect(labels).not.toHaveAttribute("aria-invalid", "true");
    fireEvent.click(screen.getByRole("button", { name: "Fixture speichern" }));

    const status = screen.getByRole("status");
    fireEvent.click(within(status).getByRole("button", { name: "Fehlerhafte Felder anzeigen" }));
    const invalidPopover = await screen.findByRole("dialog", { name: "Fehlerhafte Felder" });
    await within(invalidPopover).findByRole("button", { name: "Abstimmungslabels: Gib zwei gültige Labels ein." });
    expect(within(invalidPopover).getAllByRole("button")).toHaveLength(2);
    expect(labels).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("tab", { name: "Allgemein, Fehler" })).toBeInTheDocument();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("shows the catalog error beside a number that fails cross-field validation", async () => {
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      if (path.endsWith("/modules/editor-fixture/settings") && init?.method === "PATCH") return Promise.resolve(Response.json({}));
      return Promise.resolve(path.endsWith("/modules/editor-fixture/settings")
        ? Response.json({ settings: editorFixtureSettings, revision: 1, variables: [] })
        : Response.json({}));
    });
    renderSettingsFixture(fetcher);

    const amount = await screen.findByRole("spinbutton", { name: "Menge" });
    fireEvent.change(amount, { target: { value: "0" } });

    expect(amount).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Mindestens ein Stück.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Fixture speichern" }));
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("shows the server reason beside a settings field and keeps its error row reserved", async () => {
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      if (path.endsWith("/modules/editor-fixture/settings") && init?.method === "PATCH") {
        return Promise.resolve(Response.json({ error: "module_settings_invalid", path: "settings.handle", reason: "Choose a supported account name." }, { status: 400 }));
      }
      return Promise.resolve(path.endsWith("/modules/editor-fixture/settings")
        ? Response.json({ settings: editorFixtureSettings, revision: 1, variables: [] })
        : Response.json({}));
    });
    renderSettingsFixture(fetcher);

    const handle = await screen.findByRole("textbox", { name: "Konto" });
    fireEvent.change(handle, { target: { value: "changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Fixture speichern" }));

    expect(await screen.findByText("Choose a supported account name.")).toBeVisible();
    expect(handle).toHaveAttribute("aria-invalid", "true");
    expect(handle.closest(".ui-field")?.querySelector(".ui-field__error")).toBeInTheDocument();
  });

  it("localizes a known server field reason and keeps the raw reason as a fallback only", async () => {
    const rawReason = "This text cannot be sent by the chat bot.";
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      if (path.endsWith("/modules/editor-fixture/settings") && init?.method === "PATCH") {
        return Promise.resolve(Response.json({
          error: "module_settings_invalid",
          path: "settings.message",
          reasonCode: "template_text_invalid",
          reason: rawReason,
        }, { status: 400 }));
      }
      return Promise.resolve(path.endsWith("/modules/editor-fixture/settings")
        ? Response.json({ settings: editorFixtureSettings, revision: 1, variables: [] })
        : Response.json({}));
    });
    renderSettingsFixture(fetcher);

    const message = await screen.findByRole("textbox", { name: "Nachricht" });
    fireEvent.change(message, { target: { value: "Changed {viewer}" } });
    fireEvent.click(screen.getByRole("button", { name: "Fixture speichern" }));

    expect(await screen.findByText("Der Chattext kann nicht gesendet werden.")).toBeVisible();
    expect(screen.queryByText(rawReason)).not.toBeInTheDocument();
  });

  it("focuses an enabled switch when a disabled child still blocks saving", async () => {
    const fetcher = vi.fn<typeof fetch>((input) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      return Promise.resolve(path.endsWith("/modules/editor-fixture/settings")
        ? Response.json({ settings: editorFixtureSettings, revision: 1, variables: [] })
        : Response.json({}));
    });
    renderSettingsFixture(fetcher);

    const threshold = await screen.findByRole("spinbutton", { name: "Schwelle" });
    fireEvent.change(threshold, { target: { value: "" } });
    const switchCard = screen.getByRole("switch", { name: "Zusatzaktion" });
    fireEvent.click(switchCard);

    expect(screen.queryByRole("spinbutton", { name: "Schwelle" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fehlerhafte Felder anzeigen" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Fehlerhafte Felder anzeigen" }));
    const invalidFieldLink = within(await screen.findByRole("dialog", { name: "Fehlerhafte Felder" })).getByRole("button", { name: "Schwelle: Zahl eingeben." });
    fireEvent.click(invalidFieldLink);

    expect(switchCard).toHaveFocus();
    expect(screen.getByRole("tab", { name: "Allgemein, Fehler" })).toBeInTheDocument();
  });

  it("shows the module name and state once in the row", () => {
    renderWithUiProvider(<ModuleWorkspace channelId="kanal-a" ownRole="manager" modules={[{ id: "aktiv", enabled: true, settings: "{}" }]} onNavigate={vi.fn()} onToggleModule={vi.fn(() => Promise.resolve())} />);
    const row = screen.getByRole("link", { name: /aktiv.*Läuft/i }).closest(".list-row");
    if (!(row instanceof HTMLElement)) throw new Error("Module row is missing");
    expect(within(row).getAllByText("aktiv", { exact: true })).toHaveLength(1);
    expect(within(row).getAllByText("Läuft", { exact: true })).toHaveLength(1);
  });

  it("reflects the state returned by the shared toggle handler", async () => {
    const onNavigate = vi.fn();
    const Harness = (): ReactElement => {
      const [modules, setModules] = useState([{ id: "aktiv", enabled: true, settings: "{}" }]);
      const onToggleModule = (_channelId: string, _moduleId: string, enabled: boolean): Promise<void> => {
        setModules([{ id: "aktiv", enabled, settings: "{}" }]);
        return Promise.resolve();
      };
      return <ModuleWorkspace channelId="kanal-a" ownRole="manager" modules={modules} onNavigate={onNavigate} onToggleModule={onToggleModule} />;
    };
    renderWithUiProvider(<Harness />);

    const toggle = screen.getByRole("switch", { name: /aktiv/i });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);

    await waitFor(() => { expect(screen.getByRole("switch", { name: /aktiv/i })).not.toBeChecked(); });
  });

  it("forwards module state transitions to the shared toggle handler", async () => {
    const onToggleModule = vi.fn(() => Promise.resolve());
    renderWithUiProvider(<ModuleWorkspace channelId="kanal-a" ownRole="manager" modules={[{ id: "aktiv", enabled: true, settings: "{}" }]} onNavigate={vi.fn()} onToggleModule={onToggleModule} />);

    fireEvent.click(screen.getByRole("switch", { name: /aktiv/i }));
    await waitFor(() => { expect(onToggleModule).toHaveBeenCalledWith("kanal-a", "aktiv", false); });
  });

  it("ignores rapid clicks on the same pending switch", async () => {
    let resolveToggle: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { resolveToggle = resolve; });
    const onToggleModule = vi.fn(() => pending);
    renderWithUiProvider(<ModuleWorkspace channelId="kanal-a" ownRole="manager" modules={[{ id: "aktiv", enabled: true, settings: "{}" }]} onNavigate={vi.fn()} onToggleModule={onToggleModule} />);

    const toggle = screen.getByRole("switch", { name: /aktiv/i });
    fireEvent.click(toggle);
    // The switch disables itself while pending, so a second click through
    // the DOM is a no-op; `fireEvent.click` still lets us assert that.
    fireEvent.click(toggle);

    resolveToggle?.();
    await waitFor(() => { expect(onToggleModule).toHaveBeenCalledTimes(1); });
  });

  it("shows no kicker above the module heading", () => {
    renderWithUiProvider(<ModuleWorkspace channelId="kanal-a" ownRole="manager" modules={[]} onNavigate={vi.fn()} onToggleModule={vi.fn(() => Promise.resolve())} />);

    expect(screen.getByRole("heading", { name: "Module", level: 1 })).toBeInTheDocument();
    expect(screen.queryByText("Tastenraster")).not.toBeInTheDocument();
    expect(screen.queryByRole("complementary", { name: "Eigenschaften-Inspektor" })).not.toBeInTheDocument();
  });

  it("shows the operator the disabled detail switch with a reason", () => {
    renderWithUiProvider(<ModulePage
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
    renderWithUiProvider(<ModulePage
      channelId="kanal-a"
      moduleId="aktiv"
      ownRole="manager"
      modules={[{ id: "aktiv", enabled: true, settings: "{}" }]}
      activeModules={[{ moduleId: "aktiv", settings: "{}" }]}
      onNavigate={vi.fn()}
      onToggle={vi.fn()}
    />);

    expect(document.querySelector(".module-detail-breadcrumb")).not.toBeInTheDocument();
    expect(document.querySelector(".module-detail-heading__icon .module-heading-glyph")).toBeInTheDocument();
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
    const moduleId = "editor-lazy-fixture";
    let resolveSettings: ((response: Response) => void) | undefined;
    const deferredSettings = new Promise<Response>((resolve) => { resolveSettings = resolve; });
    let patchBody: unknown;
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      if (path === "/api/csrf") return Promise.resolve(Response.json({ token: "csrf-token" }));
      if (path.endsWith(`/modules/${moduleId}/settings`) && init?.method === "PATCH") {
        patchBody = typeof init.body === "string" ? JSON.parse(init.body) as unknown : null;
        const request = patchBody as { revision: number; settings: typeof editorFixtureSettings };
        return Promise.resolve(Response.json({
          settings: request.settings,
          revision: 2,
          warnings: [{ field: "message", code: "unknown_template_variables", unknownVariables: ["ghost"] }],
        }));
      }
      if (path.endsWith(`/modules/${moduleId}/settings`)) return deferredSettings;
      return Promise.resolve(Response.json({}));
    });
    const view = renderSettingsFixture(fetcher, "manager", {}, moduleId);

    expect(view.container.querySelector('.ui-load-state[data-status="loading"]')).not.toBeNull();
    expect(view.container.querySelectorAll(".ui-load-state__reserved-lines > span").length).toBeGreaterThan(0);
    expect(editorFixture.loader).toHaveBeenCalledOnce();
    resolveSettings?.(Response.json({ settings: editorFixtureSettings, revision: 1, variables: [] }));

    await screen.findByRole("spinbutton", { name: "Menge" });
    const handle = screen.getByRole("textbox", { name: "Konto" });
    const message = screen.getByRole("textbox", { name: "Nachricht" });
    const mode = screen.getByRole("group", { name: "Modus" });
    const extraAction = screen.getByRole("switch", { name: /Zusatzaktion/ });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Menge" }), { target: { value: "3" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Menge" }), { target: { value: "3" } });
    expect(document.querySelector(".ui-field__prefix")).toHaveTextContent("@");
    expect(screen.getByText("Hello Ada")).toBeInTheDocument();
    const fieldHelp: readonly (readonly [string, string])[] = [
      ["Menge", "Eine ganze Zahl."],
      ["Konto", "Twitch-Name."],
      ["Nachricht", "Vorlage für die Nachricht."],
      ["Modus", "Runs automatically."],
      ["Schwelle", "Mindestmenge."],
    ];
    for (const [label, help] of fieldHelp) {
      if (label === "Menge" || label === "Schwelle") {
        expect(screen.getByText(help, { selector: ".unit-input__description" })).toBeVisible();
      } else {
        expect(screen.getByRole("button", { name: `${label}: ${help}` })).toHaveAttribute("title", help);
      }
    }
    expect(screen.queryByText("Zusätzliche Aktion ausführen.")).not.toBeInTheDocument();

    fireEvent.change(handle, { target: { value: "@Ada" } });
    expect(handle).toHaveValue("Ada");
    fireEvent.change(message, { target: { value: "Willkommen {viewer}!" } });
    fireEvent.click(within(mode).getByRole("button", { name: /Von Hand/ }));
    fireEvent.click(extraAction);
    expect(screen.queryByRole("spinbutton", { name: "Schwelle" })).not.toBeInTheDocument();
    expect(screen.queryByText("Zusatzaktion ist ausgeschaltet.")).not.toBeInTheDocument();
    expect(screen.getByText("Zusätzliche Aktion ausführen.")).toBeInTheDocument();
    fireEvent.click(extraAction);
    expect(screen.getByRole("spinbutton", { name: "Schwelle" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "Fixture speichern" }));
    await waitFor(() => expect(patchBody).toEqual({
      revision: 1,
      settings: {
        amount: 3,
          extraMessage: "Extra value",
        handle: "Ada",
        labels: "",
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
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Nachricht" })).toHaveValue("Serverstand {viewer}"));
  });

  it("keeps a dirty module settings draft and advances its baseline when only the revision changes", async () => {
    let submittedRevision: number | undefined;
    let serverRevision = 1;
    const serverSettings = editorFixtureSettings;
    const view = renderSettingsFixture(vi.fn<typeof fetch>((input, init) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      if (path.endsWith("/modules/editor-fixture/settings") && init?.method === "PATCH") {
        if (typeof init.body === "string") submittedRevision = (JSON.parse(init.body) as { revision: number }).revision;
        const savedSettings = typeof init.body === "string"
          ? (JSON.parse(init.body) as { settings: typeof editorFixtureSettings }).settings
          : editorFixtureSettings;
        return Promise.resolve(Response.json({ settings: savedSettings, revision: 3, warnings: [] }));
      }
      return Promise.resolve(path.endsWith("/modules/editor-fixture/settings")
        ? Response.json({ settings: serverSettings, revision: serverRevision, variables: [] })
        : Response.json({}));
    }));
    const message = await screen.findByRole("textbox", { name: "Nachricht" });
    fireEvent.change(message, { target: { value: "Local draft {viewer}" } });
    const key = moduleQueryKey("kanal-a", "editor-fixture", "settings");
    serverRevision = 2;
    await act(async () => {
      await view.queryClient.invalidateQueries({ queryKey: key, exact: true });
    });

    await waitFor(() => expect(view.queryClient.getQueryData<{ revision: number }>(key)?.revision).toBe(2));
    expect(message).toHaveValue("Local draft {viewer}");
    fireEvent.change(screen.getByRole("textbox", { name: "Konto" }), { target: { value: "local-handle" } });
    fireEvent.click(screen.getByRole("button", { name: "Fixture speichern" }));
    await waitFor(() => expect(submittedRevision).toBe(2));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Nachricht" })).toHaveValue("Local draft {viewer}"));
    expect(message).toHaveValue("Local draft {viewer}");
  });

  it("keeps the refreshed BELABOX cooldown when URL removal completes late", async () => {
    let serverRevision = 1;
    let serverSettings = { chatCooldownSeconds: 300 };
    belaboxPanelLoader.mockImplementation(() => Promise.resolve({ default: BelaboxRemovalProbe }));
    const fetcher = vi.fn<typeof fetch>((input) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      return Promise.resolve(path.endsWith("/modules/belabox/settings")
        ? Response.json({ settings: serverSettings, revision: serverRevision, variables: [], warnings: [] })
        : Response.json({}));
    });
    vi.stubGlobal("fetch", fetcher);
    const view = renderWithUiProvider(<ModulePage
      channelId="kanal-a"
      moduleId="belabox"
      ownRole="manager"
      modules={[{ id: "belabox", enabled: true, settings: "{}" }]}
      activeModules={[{ moduleId: "belabox", settings: "{}" }]}
      onNavigate={vi.fn()}
      onToggle={vi.fn()}
    />);

    const cooldown = await screen.findByRole("spinbutton", { name: "Chat-Abkühlzeit" });
    expect(cooldown).toHaveValue(300);
    fireEvent.click(await screen.findByRole("button", { name: "Remove BELABOX URL" }));
    expect(completeBelaboxRemoval).toBeTypeOf("function");

    serverRevision = 3;
    serverSettings = { chatCooldownSeconds: 600 };
    const key = moduleQueryKey("kanal-a", "belabox", "settings");
    await act(async () => {
      await view.queryClient.invalidateQueries({ queryKey: key, exact: true });
    });
    await waitFor(() => expect(view.queryClient.getQueryData<{ revision: number }>(key)?.revision).toBe(3));
    await waitFor(() => expect(cooldown).toHaveValue(600));

    await act(async () => {
      completeBelaboxRemoval?.();
      await Promise.resolve();
    });
    expect(cooldown).toHaveValue(600);
  });

  it("keeps the old baseline when settings change remotely during a dirty draft", async () => {
    let submittedRevision: number | undefined;
    let serverRevision = 1;
    let serverSettings = editorFixtureSettings;
    const view = renderSettingsFixture(vi.fn<typeof fetch>((input, init) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      if (path.endsWith("/modules/editor-fixture/settings") && init?.method === "PATCH") {
        if (typeof init.body === "string") submittedRevision = (JSON.parse(init.body) as { revision: number }).revision;
        return Promise.resolve(Response.json({ error: "module_settings_changed_concurrently" }, { status: 409 }));
      }
      return Promise.resolve(path.endsWith("/modules/editor-fixture/settings")
        ? Response.json({ settings: serverSettings, revision: serverRevision, variables: [] })
        : Response.json({}));
    }));
    const message = await screen.findByRole("textbox", { name: "Nachricht" });
    fireEvent.change(message, { target: { value: "Local draft {viewer}" } });
    const key = moduleQueryKey("kanal-a", "editor-fixture", "settings");
    serverRevision = 2;
    serverSettings = { ...editorFixtureSettings, message: "Remote {viewer}" };
    await act(async () => {
      await view.queryClient.invalidateQueries({ queryKey: key, exact: true });
    });

    await waitFor(() => expect(view.queryClient.getQueryData<{ revision: number }>(key)?.revision).toBe(2));
    expect(message).toHaveValue("Local draft {viewer}");
    fireEvent.click(screen.getByRole("button", { name: "Fixture speichern" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Fixture wurde inzwischen geändert.");
    expect(submittedRevision).toBe(1);
    expect(message).toHaveValue("Local draft {viewer}");
  });

  it("keeps the settings draft and conflict visible when reloading the server version fails", async () => {
    let settingsReads = 0;
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      if (path === "/api/csrf") return Promise.resolve(Response.json({ token: "csrf-token" }));
      if (path.endsWith("/modules/editor-fixture/settings") && init?.method === "PATCH") {
        return Promise.resolve(Response.json({ error: "module_settings_changed_concurrently" }, { status: 409 }));
      }
      if (path.endsWith("/modules/editor-fixture/settings")) {
        settingsReads += 1;
        return Promise.resolve(settingsReads === 1
          ? Response.json({ settings: editorFixtureSettings, revision: 1, variables: [], warnings: [] })
          : Response.json({ error: "temporarily_unavailable" }, { status: 503 }));
      }
      return Promise.resolve(Response.json({}));
    });
    renderSettingsFixture(fetcher);

    const message = await screen.findByRole("textbox", { name: "Nachricht" });
    fireEvent.change(message, { target: { value: "Keep this draft {viewer}" } });
    fireEvent.click(screen.getByRole("button", { name: "Fixture speichern" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Fixture wurde inzwischen geändert.");
    fireEvent.click(screen.getByRole("button", { name: "Serverstand laden" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Fixture wurde inzwischen geändert. Moduleinstellungen konnten nicht geladen werden.");
    expect(message).toHaveValue("Keep this draft {viewer}");
    expect(within(screen.getByRole("region", { name: "Fixture-Einstellungen" })).getByRole("button", { name: "Erneut versuchen" })).toBeInTheDocument();
  });

  it("discards to the last server response after a successful settings save", async () => {
    const canonicalSettings = { ...editorFixtureSettings, handle: "server-canonical" };
    let serverSettings = editorFixtureSettings;
    let serverRevision = 1;
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      if (path === "/api/csrf") return Promise.resolve(Response.json({ token: "csrf-token" }));
      if (path.endsWith("/modules/editor-fixture/settings") && init?.method === "PATCH") {
        serverSettings = canonicalSettings;
        serverRevision = 2;
        return Promise.resolve(Response.json({ settings: canonicalSettings, revision: 2, warnings: [] }));
      }
      if (path.endsWith("/modules/editor-fixture/settings")) return Promise.resolve(Response.json({ settings: serverSettings, revision: serverRevision, variables: [] }));
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

  it("reuses warm module settings when the settings editor is mounted again", async () => {
    const fetcher = vi.fn<typeof fetch>((input) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      return Promise.resolve(path.endsWith("/modules/editor-fixture/settings")
        ? Response.json({ settings: editorFixtureSettings, revision: 1, variables: [] })
        : Response.json({}));
    });
    const queryOptions = { gcTime: 600_000, staleTime: 30_000 };
    const view = renderSettingsFixture(fetcher, "manager", queryOptions);
    expect(await screen.findByRole("textbox", { name: "Konto" })).toHaveValue("ada");
    const settingsReadCount = (): number => fetcher.mock.calls.filter(([input]) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      return path.endsWith("/modules/editor-fixture/settings");
    }).length;
    const initialSettingsReadCount = settingsReadCount();
    expect(initialSettingsReadCount).toBeGreaterThan(0);

    view.rerender(<UiProvider>{null}</UiProvider>);
    view.rerender(<UiProvider><ModulePage
      channelId="kanal-a"
      moduleId="editor-fixture"
      ownRole="manager"
      modules={[{ id: "editor-fixture", enabled: true, settings: "{}" }]}
      activeModules={[{ moduleId: "editor-fixture", settings: "{}" }]}
      onNavigate={vi.fn()}
      onToggle={vi.fn()}
    /></UiProvider>);

    expect(await screen.findByRole("textbox", { name: "Konto" })).toHaveValue("ada");
    expect(settingsReadCount()).toBe(initialSettingsReadCount);
  });

  it("shows an explicit retry after the initial module settings query fails", async () => {
    let settingsReads = 0;
    const fetcher = vi.fn<typeof fetch>((input) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      if (!path.endsWith("/modules/editor-fixture/settings")) return Promise.resolve(Response.json({}));
      settingsReads += 1;
      return Promise.resolve(settingsReads === 1
        ? Response.json({ error: "temporarily_unavailable" }, { status: 503 })
        : Response.json({ settings: editorFixtureSettings, revision: 1, variables: [] }));
    });
    renderSettingsFixture(fetcher, "manager", { gcTime: 600_000, staleTime: 30_000 });

    expect(await screen.findByText("Moduleinstellungen konnten nicht geladen werden.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Erneut versuchen|Retry/u }));

    expect(await screen.findByRole("textbox", { name: "Konto" })).toHaveValue("ada");
    expect(settingsReads).toBe(2);
  });

  it("refreshes related module data after its settings editor saves", async () => {
    let panelRevision = 1;
    let panelReads = 0;
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const path = input instanceof Request ? new URL(input.url).pathname : new URL(String(input), "https://brobot.example").pathname;
      if (path === "/api/csrf") return Promise.resolve(Response.json({ token: "csrf-token" }));
      if (path.endsWith("/modules/editor-before-fixture/settings") && init?.method === "PATCH") {
        panelRevision = 2;
        return Promise.resolve(Response.json({ settings: editorFixtureSettings, revision: 2, warnings: [] }));
      }
      if (path.endsWith("/modules/editor-before-fixture/settings")) return Promise.resolve(Response.json({ settings: editorFixtureSettings, revision: 1, variables: [] }));
      if (path.endsWith("/modules/editor-before-fixture/panel-state")) {
        panelReads += 1;
        return Promise.resolve(Response.json({ revision: panelRevision }));
      }
      return Promise.resolve(Response.json({}));
    });
    vi.stubGlobal("fetch", fetcher);
    renderWithUiProvider(<ModulePage
      channelId="kanal-a"
      moduleId="editor-before-fixture"
      ownRole="manager"
      modules={[{ id: "editor-before-fixture", enabled: true, settings: "{}" }]}
      activeModules={[{ moduleId: "editor-before-fixture", settings: "{}" }]}
      onNavigate={vi.fn()}
      onToggle={vi.fn()}
    />);

    await waitFor(() => expect(screen.getByTestId("panel-settings-revision")).toHaveTextContent("1"));
    expect(panelReads).toBe(1);
    fireEvent.change(await screen.findByRole("textbox", { name: "Konto" }), { target: { value: "saved-handle" } });
    fireEvent.click(screen.getByRole("button", { name: "Fixture speichern" }));

    await waitFor(() => { expect(screen.getByTestId("panel-settings-revision")).toHaveTextContent("2"); });
    expect(panelReads).toBe(2);
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

    fireEvent.change(await screen.findByRole("spinbutton", { name: "Menge" }), { target: { value: "5" } });
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
    renderWithUiProvider(<Harness />);

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
    renderWithUiProvider(<Harness />);

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
    const properties = document.querySelector(".ui-settings-editor__readonly-sections");
    expect(properties).not.toBeNull();
    expect(within(properties as HTMLElement).getByText("Menge")).toBeInTheDocument();
    expect(within(properties as HTMLElement).getByText("Konto")).toBeInTheDocument();
    expect(within(properties as HTMLElement).getByText("Nachricht")).toBeInTheDocument();
    expect(within(properties as HTMLElement).getByText("Modus")).toBeInTheDocument();
    expect(within(properties as HTMLElement).getByText("Zusatzaktion")).toBeInTheDocument();
    expect(within(properties as HTMLElement).getByText("Schwelle")).toBeInTheDocument();
    expect(within(properties as HTMLElement).getByText("Zusatznachricht")).toBeInTheDocument();
    expect(within(properties as HTMLElement).getByText("Extra value")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(properties?.closest(".ui-editor-shell")?.querySelector("form")).toBeNull();
    expect(screen.queryByRole("button", { name: "Fixture speichern" })).not.toBeInTheDocument();
  });
});
