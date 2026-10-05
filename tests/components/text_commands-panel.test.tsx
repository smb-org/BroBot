import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { TEXT_COMMAND_MINIMUM_TIERS, TEXT_COMMAND_TIMEOUT_TEMPLATE_VARIABLES, type TextCommand } from "../../src/modules/text_commands/contracts";
import { TEXT_COMMAND_DEFAULT_TEXTS } from "../../src/modules/text_commands/contracts/chat-defaults";
import { statusForTier, renderCommandText } from "../../src/modules/text_commands/domain";
import { TextCommandsPanel } from "../../src/modules/text_commands/panel";
import { textCommandsTexts } from "../../src/modules/text_commands/panel/locale";
import { useDashboardRoute } from "../../src/dashboard/router";
import { jsonResponse } from "../unit/fixtures";

const initialLanguage = Object.getOwnPropertyDescriptor(window.navigator, "language");

const makeCommand = (overrides: Partial<TextCommand> = {}): TextCommand => ({
  channelId: "kanal-a",
  name: "hallo",
  text: "Hallo {user} aus {channel}",
  kind: "text",
  enabled: true,
  minimumTier: "everyone",
  cooldownSeconds: 5,
  aliases: ["hey"],
  userCooldownSeconds: 15,
  streamCondition: "online",
  responseType: "reply",
  chatTarget: "source_only",
  variableAction: null,
  timeoutAction: null,
  useCount: 0,
  lastUsedAt: null,
  createdAt: "2026-09-19T12:00:00.000Z",
  updatedAt: "2026-09-19T12:00:00.000Z",
  revision: 1,
  ...overrides,
});

interface FetchOptions {
  commands?: () => TextCommand[];
  templateVariables?: readonly unknown[];
  onMutation?: (method: string, path: string, body: unknown) => Response | Promise<Response>;
}

const panelFetch = ({ commands = () => [makeCommand()], templateVariables, onMutation = () => jsonResponse({ warnings: [] }) }: FetchOptions = {}): ReturnType<typeof vi.fn<typeof fetch>> =>
  vi.fn<typeof fetch>((input, init) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
    if (url.pathname.endsWith("/template-variables") && method === "GET") return Promise.resolve(jsonResponse({ variables: templateVariables ?? [
      { name: "welcome", moduleId: "text_library", isTextBlock: true },
      ...TEXT_COMMAND_TIMEOUT_TEMPLATE_VARIABLES.map((variable) => ({ ...variable, moduleId: "text_commands", isTextBlock: false })),
    ] }));
    if (url.pathname.endsWith("/commands") && method === "GET") return Promise.resolve(jsonResponse({ commands: commands(), variables: [] }));
    if (url.pathname.includes("/commands/") || (url.pathname.endsWith("/commands") && method !== "GET")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null;
      return Promise.resolve(onMutation(method, url.pathname, body));
    }
    return Promise.resolve(jsonResponse({}, 404));
  });

const renderPanel = (fetcher: typeof fetch, props: { canManage?: boolean; botIsModerator?: boolean | null } = {}): ReturnType<typeof render> => {
  vi.stubGlobal("fetch", fetcher);
  return render(<UiProvider><TextCommandsPanel channelId="kanal-a" language="de" {...props} /></UiProvider>);
};

const selectCommand = async (name = "hallo"): Promise<HTMLElement> => {
  const heading = await screen.findByText(`!${name}`);
  const row = heading.closest("tr");
  if (!(row instanceof HTMLElement)) throw new Error("Command row is missing");
  fireEvent.click(row);
  return row;
};

const editor = (): HTMLElement => {
  const node = document.querySelector(".ui-editor-shell");
  if (!(node instanceof HTMLElement)) throw new Error("Command editor is missing");
  return node;
};

const templateEditorFor = (field: "text" | "usageText" | "timeoutFallbackText"): HTMLElement => {
  const control = editor().querySelector(`[name="${field}"]`);
  const node = control?.closest(".command-template-editor");
  if (!(node instanceof HTMLElement)) throw new Error(`The ${field} template editor is missing`);
  return node;
};

describe("Text command editor", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    if (initialLanguage !== undefined) Object.defineProperty(window.navigator, "language", initialLanguage);
  });

  it("opens in the ListDetail inspector with icon tabs, prefixes, counters, preview, and tier descriptions", async () => {
    const fetcher = panelFetch();
    renderPanel(fetcher);
    await selectCommand();

    const settingsTab = screen.getByRole("tab", { name: "Einstellungen" });
    const advancedTab = screen.getByRole("tab", { name: "Erweitert" });
    expect(settingsTab.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(advancedTab.querySelector("svg[aria-hidden='true']")).not.toBeNull();
    expect(screen.getByText("5 von 32")).toBeInTheDocument();
    expect(screen.getByText("a–z, 0–9, - und _")).toBeInTheDocument();
    expect(editor().querySelector(".ui-field__prefix")).toHaveTextContent("!");
    expect(screen.getByText(renderCommandText("Hallo {user} aus {channel}", { user: "zuschauerin", channel: "beispielkanal" }))).toBeInTheDocument();
    expect(within(editor()).getByRole("switch", { name: "Kanalvariable ändern" })).toBeInTheDocument();
    expect(screen.getAllByText(textCommandsTexts("de").variableSelectHint)).toHaveLength(1);
    expect(within(editor()).getByRole("switch", { name: "Kanalvariable ändern" }).closest(".ui-switch-card")?.querySelector(".ui-switch-card__children")).toBeNull();

    fireEvent.click(advancedTab);
    const copy = textCommandsTexts("de");
    const group = screen.getByRole("radiogroup", { name: "Wer darf auslösen" });
    const included = { viewer: "Zuschauer", subscriber: "Abonnenten", vip: "VIPs", moderator: "Moderatoren", broadcaster: "Broadcaster" } as const;
    for (const tier of TEXT_COMMAND_MINIMUM_TIERS) {
      const subjects = statusForTier[tier].map((status) => included[status]);
      const lastSubject = subjects.at(-1) ?? "";
      const description = subjects.length < 2
        ? subjects[0] ?? ""
        : `${subjects.slice(0, -1).join(", ")} und ${lastSubject}`;
      const exclusion = tier === "subscriber" ? " VIPs nicht." : tier === "vip" ? " Abonnenten nicht." : "";
      expect(within(group).getByRole("radio", { name: `${copy.tierLabels[tier]}. ${description}.${exclusion}` })).toBeInTheDocument();
    }
  });

  it("shows a one-line description for each kind option in the Art select", async () => {
    const fetcher = panelFetch();
    renderPanel(fetcher);
    await selectCommand();
    fireEvent.click(screen.getByRole("combobox", { name: "Art" }));
    await waitFor(() => {
      expect(screen.getByRole("listbox")).toHaveTextContent("AntworttextAntwortet mit dem Text unten.");
      expect(screen.getByRole("listbox")).toHaveTextContent("BefehlslisteZählt alle eingeschalteten Befehle auf (ohne Aliase).");
      expect(screen.getByRole("listbox")).toHaveTextContent("Shoutout!so <name> empfiehlt einen Twitch-Kanal im Chat.");
      expect(screen.getByRole("listbox")).toHaveTextContent("TimeoutTimeout für den Aufrufer; Antwort bei Erfolg und Ersatztext bei Ablehnung.");
    });
  });

  it("offers slash syntax, blocks malformed known commands, and keeps unknown commands as text", async () => {
    let created: unknown;
    const fetcher = panelFetch({
      commands: () => [],
      onMutation: (_method, _path, body) => {
        created = body;
        return jsonResponse({ warnings: [] });
      },
    });
    renderPanel(fetcher);
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "test" } });
    const response = screen.getByRole("textbox", { name: "Antwort" });
    fireEvent.change(response, { target: { value: "/" } });

    const suggestions = screen.getByRole("group", { name: "Twitch-Befehle am Anfang werden beim Speichern in strukturierte Felder umgewandelt." });
    expect(within(suggestions).getByRole("button", { name: /\/timeout \{user\} <seconds\|min-max> \[reason\]/u })).toHaveTextContent("Timeoutet den Aufrufer");
    expect(within(suggestions).getByRole("button", { name: /\/announce <text>/u })).toHaveTextContent("Twitch-Ankündigung");
    expect(within(suggestions).getByRole("button", { name: /\/shoutout \{target\}/u })).toHaveTextContent("Befehlsargument");

    fireEvent.change(response, { target: { value: "/timeout somebody 30" } });
    expect(screen.getByRole("alert")).toHaveTextContent("Ungültige Syntax: /timeout {user} <seconds|min-max> [reason]");
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(created).toBeUndefined();

    fireEvent.change(response, { target: { value: "/permit everyone" } });
    expect(screen.getByText("Dieser Slash-Befehl bleibt Antworttext.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    await waitFor(() => expect(created).toMatchObject({ kind: "text", text: "/permit everyone" }));
  });

  it("replaces a slash suggestion while preserving the response body", async () => {
    renderPanel(panelFetch({ commands: () => [] }));
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    const response = screen.getByRole("textbox", { name: "Antwort" });
    fireEvent.change(response, { target: { value: "/time\nKeep this response" } });

    const suggestions = screen.getByRole("group", { name: "Twitch-Befehle am Anfang werden beim Speichern in strukturierte Felder umgewandelt." });
    fireEvent.click(within(suggestions).getByRole("button", { name: /\/timeout/u }));

    expect(response).toHaveValue("/timeout {user} 120\nKeep this response");
  });

  it("validates a converted slash draft before blocking save", async () => {
    let created: unknown;
    const fetcher = panelFetch({
      commands: () => [],
      onMutation: (_method, _path, body) => {
        created = body;
        return jsonResponse({ warnings: [] });
      },
    });
    renderPanel(fetcher);
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "shout" } });
    fireEvent.click(screen.getByRole("combobox", { name: "Art" }));
    fireEvent.click(await screen.findByRole("option", { name: /Timeout/u }));
    fireEvent.change(screen.getByRole("textbox", { name: "Antwort (optional)" }), { target: { value: "/shoutout {target}" } });

    const save = screen.getByRole("button", { name: "Anlegen" });
    expect(save).toBeEnabled();
    fireEvent.click(save);

    await waitFor(() => expect(created).toMatchObject({ kind: "shoutout", text: TEXT_COMMAND_DEFAULT_TEXTS.shoutout }));
  });

  it("ignores errors from fields a slash conversion discards", async () => {
    let created: unknown;
    const fetcher = panelFetch({
      commands: () => [],
      onMutation: (_method, _path, body) => {
        created = body;
        return jsonResponse({ warnings: [] });
      },
    });
    renderPanel(fetcher);
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "shout" } });
    fireEvent.click(screen.getByRole("combobox", { name: "Art" }));
    fireEvent.click(await screen.findByRole("option", { name: /Timeout/u }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Höchstens" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(await screen.findByRole("tab", { name: "Einstellungen, Fehler" })).toBeInTheDocument();
    expect(created).toBeUndefined();

    fireEvent.change(screen.getByRole("textbox", { name: "Antwort (optional)" }), { target: { value: "/shoutout {target}" } });
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));

    await waitFor(() => expect(created).toMatchObject({ kind: "shoutout" }));
  });

  it("ignores an invalid variable action discarded by a slash conversion", async () => {
    let created: unknown;
    const fetcher = panelFetch({
      commands: () => [],
      onMutation: (_method, _path, body) => {
        created = body;
        return jsonResponse({ warnings: [] });
      },
    });
    renderPanel(fetcher);
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "shout" } });
    fireEvent.click(screen.getByRole("switch", { name: "Kanalvariable ändern" }));
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(await screen.findByRole("tab", { name: "Einstellungen, Fehler" })).toBeInTheDocument();
    expect(created).toBeUndefined();

    fireEvent.change(screen.getByRole("textbox", { name: "Antwort" }), { target: { value: "/shoutout {target}" } });
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));

    await waitFor(() => expect(created).toMatchObject({ kind: "shoutout" }));
  });

  it("lets timeout commands configure usage text", async () => {
    let created: unknown;
    const fetcher = panelFetch({
      commands: () => [],
      onMutation: (_method, _path, body) => {
        created = body;
        return jsonResponse({ warnings: [] });
      },
    });
    renderPanel(fetcher);
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "timeout" } });
    fireEvent.click(screen.getByRole("combobox", { name: "Art" }));
    fireEvent.click(await screen.findByRole("option", { name: /Timeout/u }));
    fireEvent.change(screen.getByRole("textbox", { name: "Antwort (optional)" }), { target: { value: "Timed out." } });
    fireEvent.change(screen.getByRole("textbox", { name: "Ersatztext bei Ablehnung (optional)" }), { target: { value: "Could not time out." } });
    fireEvent.click(within(editor()).getByText("Erweitert", { selector: "summary" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Antwort bei fehlenden oder ungültigen Argumenten" }), { target: { value: "Usage: !timeout <amount>" } });
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));

    await waitFor(() => expect(created).toMatchObject({ kind: "timeout", usageText: "Usage: !timeout <amount>" }));
  });

  it("offers the shared system variable catalog in the response picker", async () => {
    renderPanel(panelFetch({ commands: () => [] }));
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    const trigger = within(templateEditorFor("text")).getByRole("button", { name: "Variable einfügen" });
    expect(trigger.querySelector("svg")).toHaveClass("tabler-icon-braces");
    fireEvent.click(trigger);
    const picker = await screen.findByRole("listbox", { name: "Variable auswählen" });
    expect(within(picker).getByRole("option", { name: /\{user\}/u, hidden: true })).toBeInTheDocument();
    expect(within(picker).getByRole("option", { name: /\{uptime\}/u, hidden: true })).toBeInTheDocument();
    expect(within(picker).getByRole("option", { name: /\{random 1-100\}/u, hidden: true })).toBeInTheDocument();
    expect(within(picker).getByRole("group", { name: "Stream", hidden: true })).toBeInTheDocument();
    expect(picker.querySelector(".ui-variable-picker__option-copy .ui-variable-picker__description")).not.toBeNull();
    expect(picker.querySelector(".ui-variable-picker__sample")).not.toBeNull();
    const liveLookups = within(picker).getAllByRole("img", { name: "Fragt Twitch live ab, wenn der Befehl ausgeführt wird", hidden: true });
    expect(liveLookups.length).toBeGreaterThan(0);
    for (const liveLookup of liveLookups) {
      expect(liveLookup.querySelector("svg")).toHaveClass("tabler-icon-info-circle");
      expect(liveLookup).toHaveAttribute("title", "Fragt Twitch live ab, wenn der Befehl ausgeführt wird");
    }
    fireEvent.click(within(picker).getByRole("option", { name: /\{uptime\}/u, hidden: true }));
    expect(within(templateEditorFor("text")).getByRole("textbox", { name: "Antwort" })).toHaveValue("{uptime}");
  });

  it("inserts a selected text-library block into a command response", async () => {
    const fetcher = panelFetch();
    renderPanel(fetcher);
    await selectCommand();

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(expect.stringContaining("/template-variables")));
    const picker = templateEditorFor("text").querySelector(".command-library-picker");
    if (!(picker instanceof HTMLElement)) throw new Error("Text-library picker is missing");
    fireEvent.click(within(picker).getByRole("combobox", { name: "Text aus Bibliothek" }));
    const welcomeOptions = await screen.findAllByText("{welcome}");
    const welcomeOption = welcomeOptions[0];
    if (welcomeOption === undefined) throw new Error("Text-library option is missing");
    fireEvent.click(welcomeOption);
    fireEvent.click(within(picker).getByRole("button", { name: "Text einsetzen" }));

    expect(within(templateEditorFor("text")).getByRole("textbox", { name: "Antwort" })).toHaveValue("Hallo {user} aus {channel} {welcome}");
  });

  it("orders timeout fields before advanced settings and accepts silent timeout text", async () => {
    let created: unknown;
    const fetcher = panelFetch({
      commands: () => [],
      onMutation: (_method, _path, body) => {
        created = body;
        return jsonResponse({ warnings: [] });
      },
    });
    renderPanel(fetcher);
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "quiet" } });
    fireEvent.click(screen.getByRole("combobox", { name: "Art" }));
    fireEvent.click(await screen.findByRole("option", { name: /Timeout/u }));

    const ordered = [
      screen.getByRole("combobox", { name: "Art" }),
      screen.getByRole("spinbutton", { name: "Mindestens" }),
      screen.getByRole("spinbutton", { name: "Höchstens" }),
      screen.getByRole("textbox", { name: "Timeout-Grund" }),
      screen.getByRole("textbox", { name: "Antwort (optional)" }),
      screen.getByRole("textbox", { name: "Ersatztext bei Ablehnung (optional)" }),
      editor().querySelector("details.command-usage-advanced > summary"),
    ];
    for (let index = 0; index < ordered.length - 1; index++) {
      const current = ordered[index];
      const next = ordered[index + 1];
      if (current === null || current === undefined || next === null || next === undefined) throw new Error("Timeout editor fields are missing.");
      expect(current.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(screen.getByRole("textbox", { name: "Antwort (optional)" })).not.toBeRequired();
    for (const field of ["text", "timeoutFallbackText", "usageText"] as const) {
      expect(templateEditorFor(field).querySelectorAll(".command-library-picker")).toHaveLength(1);
    }
    expect([...editor().querySelectorAll("h2, h3")].some((heading) => heading.textContent.includes("Text aus Bibliothek"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    await waitFor(() => expect(created).toMatchObject({
      kind: "timeout",
      text: "",
      timeoutAction: { minSeconds: 120, maxSeconds: 120, fallbackText: "" },
    }));
  });

  it("marks a blocking timeout range error and focuses its field from the summary", async () => {
    renderPanel(panelFetch({ commands: () => [] }));
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "quiet" } });
    fireEvent.click(screen.getByRole("combobox", { name: "Art" }));
    fireEvent.click(await screen.findByRole("option", { name: /Timeout/u }));
    const minimum = screen.getByRole("spinbutton", { name: "Mindestens" });
    const maximum = screen.getByRole("spinbutton", { name: "Höchstens" });
    fireEvent.change(minimum, { target: { value: "120" } });
    fireEvent.change(maximum, { target: { value: "60" } });

    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));

    await waitFor(() => expect(minimum).toHaveFocus());
    expect(minimum).toHaveAttribute("aria-invalid", "true");
    expect(maximum).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("tab", { name: "Einstellungen, Fehler" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Dauer: Die Dauer muss zwischen 1 s und 14 Tagen liegen; das Minimum darf das Maximum nicht überschreiten." }));
    expect(minimum).toHaveFocus();
  });

  it("keeps the usage reply editor collapsed by default for text commands", async () => {
    const command = makeCommand({ usageText: "Try !hallo 10" });
    renderPanel(panelFetch({ commands: () => [command] }));
    await selectCommand();

    const labels = textCommandsTexts("de");
    const section = editor().querySelector("details.command-usage-advanced");
    expect(section).toBeInstanceOf(HTMLDetailsElement);
    expect((section as HTMLDetailsElement).open).toBe(false);
    expect(section).not.toHaveAttribute("open");

    fireEvent.click(within(editor()).getByText(labels.usageAdvanced, { selector: "summary" }));
    expect(screen.getByRole("textbox", { name: labels.templateFieldLabels.usageText })).toHaveValue("Try !hallo 10");
    expect(screen.getByText(labels.usageTextHint)).toBeInTheDocument();
  });

  it("persists edits and explicit clearing of the usage reply", async () => {
    const command = makeCommand({ usageText: "Try !hallo 10" });
    const onMutation = vi.fn<(method: string, path: string, body: unknown) => Response>(() => jsonResponse({ warnings: [] }));
    renderPanel(panelFetch({ commands: () => [command], onMutation }));
    await selectCommand();

    const labels = textCommandsTexts("de");
    fireEvent.click(within(editor()).getByText(labels.usageAdvanced, { selector: "summary" }));
    const usageReply = screen.getByRole("textbox", { name: labels.templateFieldLabels.usageText });
    fireEvent.change(usageReply, { target: { value: "Try !hallo <name>" } });
    fireEvent.click(screen.getByRole("button", { name: labels.save }));
    await waitFor(() => expect(onMutation).toHaveBeenCalledTimes(1));
    expect(onMutation.mock.calls[0]?.[2]).toMatchObject({ usageText: "Try !hallo <name>" });

    fireEvent.change(screen.getByRole("textbox", { name: labels.templateFieldLabels.usageText }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: labels.save }));
    await waitFor(() => expect(onMutation).toHaveBeenCalledTimes(2));
    expect(onMutation.mock.calls[1]?.[2]).toMatchObject({ usageText: "" });
  });

  it("clears an invalid usage reply when changing to a command list", async () => {
    const onMutation = vi.fn<(method: string, path: string, body: unknown) => Response>(() => jsonResponse({ warnings: [] }));
    renderPanel(panelFetch({ commands: () => [makeCommand({ usageText: "x".repeat(501) })], onMutation }));
    await selectCommand();

    fireEvent.click(screen.getByRole("combobox", { name: "Art" }));
    fireEvent.click(await screen.findByRole("option", { name: /Befehlsliste/u }));
    expect(screen.queryByRole("textbox", { name: textCommandsTexts("de").templateFieldLabels.usageText })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Änderungen speichern" }));

    await waitFor(() => expect(onMutation).toHaveBeenCalledTimes(1));
    expect(onMutation.mock.calls[0]?.[2]).toMatchObject({ kind: "list", text: "" });
    expect(onMutation.mock.calls[0]?.[2]).not.toHaveProperty("usageText");
    expect(screen.queryByRole("button", { name: /Antwort bei fehlenden oder ungültigen Argumenten/u })).not.toBeInTheDocument();
  });

  it("keeps the variable action in a left-aligned switch card and the command body scrollable", async () => {
    renderPanel(panelFetch());
    await selectCommand();

    expect(editor()).toHaveClass("command-editor-shell");
    expect(editor().querySelector(".ui-editor-shell__body")).toHaveClass("ui-editor-shell__body");
    const toggle = screen.getByRole("switch", { name: "Kanalvariable ändern" });
    expect(toggle.closest(".ui-switch-card")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle.closest(".ui-switch-card")?.querySelector(".ui-switch-card__children")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Variable" }).closest(".ui-switch-card__children")).not.toBeNull();
  });

  it("defaults set_argument to moderators unless the draft already chose a tier", async () => {
    renderPanel(panelFetch({ commands: () => [] }));
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    fireEvent.click(screen.getByRole("switch", { name: "Kanalvariable ändern" }));
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Kanalvariable ändern" })).getByRole("radio", { name: "Argument" }));
    fireEvent.click(screen.getByRole("tab", { name: "Erweitert" }));
    expect(within(screen.getByRole("radiogroup", { name: "Wer darf auslösen" })).getByRole("radio", { checked: true }))
      .toHaveAccessibleName("Moderatoren. Moderatoren und Broadcaster.");
  });

  it("keeps an explicit everyone tier when set_argument is selected later", async () => {
    renderPanel(panelFetch({ commands: () => [] }));
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    fireEvent.click(screen.getByRole("tab", { name: "Erweitert" }));
    const tierGroup = screen.getByRole("radiogroup", { name: "Wer darf auslösen" });
    fireEvent.click(within(tierGroup).getByRole("radio", { name: "VIPs. VIPs, Moderatoren und Broadcaster. Abonnenten nicht." }));
    fireEvent.click(within(tierGroup).getByRole("radio", { name: "Alle. Zuschauer, Abonnenten, VIPs, Moderatoren und Broadcaster." }));
    fireEvent.click(screen.getByRole("tab", { name: "Einstellungen" }));
    fireEvent.click(screen.getByRole("switch", { name: "Kanalvariable ändern" }));
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Kanalvariable ändern" })).getByRole("radio", { name: "Argument" }));
    fireEvent.click(screen.getByRole("tab", { name: "Erweitert" }));
    const currentTierGroup = screen.getByRole("radiogroup", { name: "Wer darf auslösen" });
    expect(within(currentTierGroup).getByRole("radio", { checked: true })).toHaveAccessibleName("Alle. Zuschauer, Abonnenten, VIPs, Moderatoren und Broadcaster.");
  });

  it("describes a silent action in the response column", async () => {
    const actionCommand = makeCommand({
      text: "",
      variableAction: { name: "score", operation: "add", amount: 1 },
    });
    renderPanel(panelFetch({ commands: () => [actionCommand] }));
    const cell = await screen.findByRole("cell", { name: "Ändert score um +1" });
    expect(cell).toHaveClass("table__answer--placeholder");
  });

  it("renders the picker as a grouped bottom sheet below 600 pixels", async () => {
    const originalMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query: string): MediaQueryList => ({
      matches: query === "(max-width: 599px)", media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    });
    try {
      renderPanel(panelFetch({ commands: () => [] }));
      fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
      fireEvent.click(within(templateEditorFor("text")).getByRole("button", { name: "Variable einfügen" }));
      const picker = await screen.findByRole("listbox", { name: "Variable auswählen" });
      expect(picker.parentElement).toHaveClass("ui-variable-picker--sheet");
      expect(picker.parentElement?.querySelector(".ui-variable-picker__mobile-header")).toBeInTheDocument();
      expect(picker.parentElement?.querySelector(".ui-variable-picker__search")).toBeInTheDocument();
      expect(picker.parentElement?.querySelector(".ui-variable-picker__option-copy")).toBeInTheDocument();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("shows the shoutout usage response and its Twitch cooldown hint", async () => {
    renderPanel(panelFetch({ commands: () => [] }));
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Art" }));
    fireEvent.click(await screen.findByRole("option", { name: /Shoutout/u }));
    fireEvent.click(within(editor()).getByText("Erweitert", { selector: "summary" }));
    expect(screen.getByRole("textbox", { name: "Antwort bei fehlenden oder ungültigen Argumenten" })).toBeInTheDocument();
    expect(screen.getByText("Twitch begrenzt Shoutouts selbst: 2 Minuten pro Kanal und 60 Minuten pro Ziel.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Erweitert" }));
    const tierGroup = screen.getByRole("radiogroup", { name: "Wer darf auslösen" });
    expect(within(tierGroup).getByRole("radio", { checked: true })).toHaveAccessibleName("Moderatoren. Moderatoren und Broadcaster.");
  });

  it("puts the Art select's hint below the field, not between the label and the control", async () => {
    const fetcher = panelFetch();
    renderPanel(fetcher);
    await selectCommand();
    const combobox = screen.getByRole("combobox", { name: "Art" });
    const hint = combobox.closest(".mantine-Select-root")?.querySelector(".mantine-Select-description");
    expect(hint).toHaveTextContent("Antwortet mit dem Text unten.");
    expect(combobox.compareDocumentPosition(hint as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("labels the response variable chips with their placeholder, not an empty pill", async () => {
    const fetcher = panelFetch({ commands: () => [] });
    renderPanel(fetcher);
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    fireEvent.click(within(templateEditorFor("text")).getByRole("button", { name: "Variable einfügen" }));
    const picker = await screen.findByRole("listbox", { name: "Variable auswählen" });
    expect(within(picker).getByRole("option", { name: /\{user\}/u, hidden: true })).toBeInTheDocument();
    expect(within(picker).getByRole("option", { name: /\{channel\}/u, hidden: true })).toBeInTheDocument();
  });

  it("uses the chat preview, not plain text, for a command list's response", async () => {
    const rows = [makeCommand({ name: "commands", kind: "list", aliases: [] }), makeCommand({ name: "hallo" })];
    const fetcher = panelFetch({ commands: () => rows });
    renderPanel(fetcher);
    await selectCommand("commands");
    const panel = editor();
    expect(within(panel).getByText("Vorschau")).toBeInTheDocument();
    expect(within(panel).getByText("Bot")).toBeInTheDocument();
    expect(within(panel).getByText("Befehle: !hallo")).toBeInTheDocument();
    expect(within(panel).queryByRole("textbox", { name: "Antwort" })).not.toBeInTheDocument();
  });

  it("gives every editor field a non-empty helper line and edits aliases and cooldowns", async () => {
    const fetcher = panelFetch();
    renderPanel(fetcher);
    await selectCommand();
    const panel = editor();

    const assertVisibleFieldHelpers = (): void => {
      for (const role of ["textbox", "radiogroup", "spinbutton", "switch"] as const) {
        for (const field of within(panel).queryAllByRole(role)) {
          const describedBy = field.getAttribute("aria-describedby");
          expect(describedBy, `${role} should reference its helper line`).toBeTruthy();
          for (const id of (describedBy ?? "").split(/\s+/u).filter(Boolean)) {
            const helper = document.getElementById(id)?.textContent ?? "";
            expect(helper.trim().length, `${role} helper line ${id}`).toBeGreaterThan(0);
          }
        }
      }
    };
    assertVisibleFieldHelpers();

    const aliasGroup = within(panel).getByRole("group", { name: "Aliase" });
    expect(aliasGroup.querySelector(".ui-field__prefix")).toHaveTextContent("!");
    fireEvent.click(screen.getByRole("tab", { name: "Erweitert" }));
    assertVisibleFieldHelpers();
    const cooldown = screen.getByRole("spinbutton", { name: "Abkühlzeit" });
    const userCooldown = screen.getByRole("spinbutton", { name: "Je Nutzer" });
    expect(cooldown).toHaveValue("5");
    expect(userCooldown).toHaveValue("15");
    expect(within(panel).getAllByText("s")).toHaveLength(2);
    fireEvent.change(userCooldown, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Änderungen speichern" }));
    await waitFor(() => {
      const patch = fetcher.mock.calls.find(([, init]) => init?.method === "PATCH");
      expect(patch?.[1]?.body).toBe(JSON.stringify({
        revision: 1,
        name: "hallo",
        kind: "text",
        text: "Hallo {user} aus {channel}",
        usageText: "",
        minimumTier: "everyone",
        cooldownSeconds: 5,
        aliases: ["hey"],
        userCooldownSeconds: 0,
        streamCondition: "online",
        games: [],
        responseType: "reply",
        chatTarget: "source_only",
        variableAction: null,
        timeoutAction: null,
      }));
    });
  });

  it("creates with §14 defaults and sends every extended command field", async () => {
    let created: unknown;
    const fetcher = panelFetch({
      commands: () => [],
      onMutation: (method, _path, body) => {
        if (method === "POST") created = body;
        return jsonResponse({ warnings: [] });
      },
    });
    renderPanel(fetcher);
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "!Neu" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Antwort" }), { target: { value: "Hallo" } });
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));

    await waitFor(() => expect(created).toEqual({
      name: "neu",
      text: "Hallo",
      kind: "text",
      usageText: "",
      minimumTier: "everyone",
      cooldownSeconds: 5,
      aliases: [],
      userCooldownSeconds: 0,
      streamCondition: "any",
      games: [],
      responseType: "say",
      chatTarget: "source_only",
      variableAction: null,
      timeoutAction: null,
    }));
  });

  it("creates a command list without a response field or response text", async () => {
    let created: unknown;
    const fetcher = panelFetch({
      commands: () => [],
      onMutation: (method, _path, body) => {
        if (method === "POST") created = body;
        return jsonResponse({ warnings: [] });
      },
    });
    renderPanel(fetcher);
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Art" }));
    fireEvent.click(await screen.findByRole("option", { name: /Befehlsliste/u }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "befehle" } });
    expect(screen.queryByRole("textbox", { name: "Antwort" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));

    await waitFor(() => expect(created).toEqual({
      name: "befehle",
      text: "",
      kind: "list",
      minimumTier: "everyone",
      cooldownSeconds: 5,
      aliases: [],
      userCooldownSeconds: 0,
      streamCondition: "any",
      games: [],
      responseType: "say",
      chatTarget: "source_only",
      variableAction: null,
      timeoutAction: null,
    }));
  });

  it("locks the create fields while the request is pending", async () => {
    let resolveCreate: ((response: Response) => void) | undefined;
    const createRequest = new Promise<Response>((resolve) => { resolveCreate = resolve; });
    const fetcher = panelFetch({ commands: () => [], onMutation: () => createRequest });
    renderPanel(fetcher);
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "neu" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Antwort" }), { target: { value: "Hallo" } });
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));

    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    expect(document.querySelector(".ui-editor-shell .ui-save-bar")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("textbox", { name: "Name" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Antwort" })).toBeDisabled();
    resolveCreate?.(jsonResponse({ warnings: [] }));
    await waitFor(() => expect(document.querySelector(".ui-editor-shell")).not.toBeInTheDocument());
  });

  it("keeps a cleared cooldown empty and does not send a null value", async () => {
    const fetcher = panelFetch({ commands: () => [] });
    renderPanel(fetcher);
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "neu" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Antwort" }), { target: { value: "Hallo" } });
    fireEvent.click(screen.getByRole("tab", { name: "Erweitert" }));
    const cooldown = screen.getByRole("spinbutton", { name: "Abkühlzeit" });
    fireEvent.change(cooldown, { target: { value: "" } });
    expect(cooldown).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(cooldown).toHaveValue("");
  });

  it("saves an unknown variable as a warning and keeps the save action primary", async () => {
    const fetcher = panelFetch({
      onMutation: () => jsonResponse({
        warnings: [{ field: "text", code: "unknown_template_variables", unknownVariables: ["viewer"] }],
      }),
    });
    renderPanel(fetcher);
    await selectCommand();
    const response = screen.getByRole("textbox", { name: "Antwort" });
    fireEvent.change(response, { target: { value: "Hallo {viewer}" } });
    expect(await screen.findByText(/Unbekannte Variable \{viewer\}/u)).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Änderungen speichern" });
    expect(save).toBeEnabled();
    expect(save).toHaveAttribute("data-variant", "filled");
    fireEvent.click(save);
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    expect(await screen.findByRole("status")).toHaveTextContent("Gespeichert. Unbekannte Variable: {viewer}");
    expect(response).toHaveValue("Hallo {viewer}");
  });

  it("guards row switching, Escape, and the inspector backdrop with all three choices", async () => {
    const rows = [makeCommand(), makeCommand({ name: "beta", text: "Antwort B", aliases: [] })];
    const fetcher = panelFetch({ commands: () => rows });
    renderPanel(fetcher);
    await selectCommand("hallo");
    fireEvent.change(screen.getByRole("textbox", { name: "Antwort" }), { target: { value: "Entwurf" } });
    const beta = await screen.findByText("!beta");
    fireEvent.click(beta.closest("tr") as HTMLElement);
    const guard = await screen.findByRole("dialog");
    expect(within(guard).getByRole("button", { name: "Weiter bearbeiten" })).toBeInTheDocument();
    expect(within(guard).getByRole("button", { name: "Verwerfen und wechseln" })).toBeInTheDocument();
    expect(within(guard).getByRole("button", { name: "Speichern und wechseln" })).toBeInTheDocument();
    fireEvent.click(within(guard).getByRole("button", { name: "Weiter bearbeiten" }));
    expect(screen.getByRole("textbox", { name: "Antwort" })).toHaveValue("Entwurf");

    fireEvent.keyDown(editor(), { key: "Escape" });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Weiter bearbeiten" }));
    const backdrop = document.querySelector(".list-detail__backdrop");
    if (!(backdrop instanceof HTMLElement)) throw new Error("Inspector backdrop is missing");
    fireEvent.click(backdrop);
    fireEvent.click(await screen.findByRole("button", { name: "Verwerfen und wechseln" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.querySelector(".ui-editor-shell")).not.toBeInTheDocument();
  });

  it("blocks route navigation from a dirty command editor", async () => {
    const fetcher = panelFetch();
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/modules/text_commands");
    const Harness = (): React.ReactElement => {
      const [route, navigate] = useDashboardRoute();
      return <>
        <button type="button" onClick={() => { navigate({ kind: "overview" }); }}>Go overview</button>
        <output>{route.kind}</output>
        {route.kind === "module" ? <TextCommandsPanel channelId="kanal-a" language="de" initialSelection="hallo" /> : null}
      </>;
    };
    render(<UiProvider><Harness /></UiProvider>);

    const response = await screen.findByRole("textbox", { name: "Antwort" });
    fireEvent.change(response, { target: { value: "Entwurf" } });
    fireEvent.click(screen.getByRole("button", { name: "Go overview" }));
    const guard = await screen.findByRole("dialog");
    expect(screen.getByText("module")).toBeInTheDocument();
    expect(within(guard).getByRole("button", { name: "Weiter bearbeiten" })).toBeInTheDocument();
    expect(within(guard).getByRole("button", { name: "Verwerfen und wechseln" })).toBeInTheDocument();
    expect(within(guard).getByRole("button", { name: "Speichern und wechseln" })).toBeInTheDocument();

    fireEvent.click(within(guard).getByRole("button", { name: "Weiter bearbeiten" }));
    expect(screen.getByRole("textbox", { name: "Antwort" })).toHaveValue("Entwurf");
    fireEvent.click(screen.getByRole("button", { name: "Go overview" }));
    fireEvent.click(await screen.findByRole("button", { name: "Verwerfen und wechseln" }));
    await waitFor(() => expect(screen.getByText("overview")).toBeInTheDocument());
  });

  it("saves and switches from the draft guard, and keeps the new row selected", async () => {
    const rows = [makeCommand(), makeCommand({ name: "beta", text: "Antwort B", aliases: [] })];
    const fetcher = panelFetch({ commands: () => rows });
    renderPanel(fetcher);
    await selectCommand("hallo");
    fireEvent.change(screen.getByRole("textbox", { name: "Antwort" }), { target: { value: "Gespeichert" } });
    fireEvent.click((await screen.findByText("!beta")).closest("tr") as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "Speichern und wechseln" }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Antwort" })).toHaveValue("Antwort B"));
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true);
  });

  it("preserves the draft on command_changed_concurrently and reloads the server version on request", async () => {
    const rows = [makeCommand()];
    const fetcher = panelFetch({
      commands: () => rows,
      onMutation: () => jsonResponse({ error: "command_changed_concurrently" }, 409),
    });
    renderPanel(fetcher);
    await selectCommand();
    const response = screen.getByRole("textbox", { name: "Antwort" });
    fireEvent.change(response, { target: { value: "Mein Entwurf" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Änderungen speichern" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Änderungen speichern" }));
    await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1));
    expect(await screen.findByText(/Inzwischen von jemand anderem geändert\./u)).toBeInTheDocument();
    expect(response).toHaveValue("Mein Entwurf");
    rows[0] = makeCommand({ text: "Serverstand" });
    fireEvent.click(screen.getByRole("button", { name: "Serverstand laden" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Antwort" })).toHaveValue("Serverstand"));
  });

  it("maps command_already_exists and both command_alias_conflict fields to field errors", async () => {
    let error: unknown = { error: "command_already_exists" };
    const fetcher = panelFetch({
      onMutation: () => jsonResponse(error, 409),
    });
    renderPanel(fetcher);
    await selectCommand();
    const name = screen.getByRole("textbox", { name: "Name" });
    const save = screen.getByRole("button", { name: "Änderungen speichern" });

    fireEvent.change(name, { target: { value: "neu" } });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1));
    expect(await screen.findByText("Der Befehl existiert bereits.")).toBeInTheDocument();
    expect(name).toHaveAttribute("aria-invalid", "true");

    error = { error: "command_alias_conflict", conflict: { field: "name", trigger: "hallo", command: "anderer" } };
    fireEvent.change(name, { target: { value: "neu2" } });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(2));
    expect(await screen.findByText("!hallo ist schon ein Alias von !anderer.")).toBeInTheDocument();
    expect(name).toHaveAttribute("aria-invalid", "true");

    error = { error: "command_alias_conflict", conflict: { field: "aliases", trigger: "hey", command: "anderer" } };
    fireEvent.change(name, { target: { value: "neu3" } });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(3));
    await waitFor(() => expect(save).toBeEnabled());
    expect(await screen.findByText(/!hey ist schon ein Alias von !anderer\./u)).toBeInTheDocument();
    expect(document.querySelector(".ui-tag-input__pill[aria-invalid='true']")).not.toBeNull();
  });

  it("focuses the conflicting alias chip's remove button when aliases are at capacity", async () => {
    const aliases = Array.from({ length: 10 }, (_unused, index) => `alias${String(index + 1)}`);
    renderPanel(panelFetch({ commands: () => [makeCommand({ aliases })] }));
    await selectCommand();

    const name = screen.getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "alias5" } });
    const save = screen.getByRole("button", { name: "Änderungen speichern" });
    expect(screen.getByRole("combobox", { name: "Aliase" })).toBeDisabled();
    fireEvent.click(save);

    const aliasError = screen.getByRole("button", { name: "Aliase: Das ist schon der Name." });
    fireEvent.click(aliasError);
    expect(screen.getByRole("button", { name: "Alias !alias5 entfernen" })).toHaveFocus();
    expect(screen.getByRole("button", { name: "Alias !alias5 entfernen" })).toBeEnabled();
  });

  it("shows the amber announcement warning only when moderator status is false", async () => {
    const fetcher = panelFetch();
    renderPanel(fetcher, { botIsModerator: false });
    await selectCommand();
    fireEvent.click(screen.getByRole("radio", { name: "Ankündigung" }));
    expect(screen.getByText("Der Bot ist hier kein Moderator — der Text geht als normale Nachricht raus.")).toBeInTheDocument();
    expect(editor().querySelector(".ui-segmented-control__warning")).not.toBeNull();
    expect(editor().querySelector(".ui-editor-shell__issue-dot--warning")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Änderungen speichern" })).toBeEnabled();

    cleanup();
    renderPanel(panelFetch(), { botIsModerator: null });
    await selectCommand();
    fireEvent.click(screen.getByRole("radio", { name: "Ankündigung" }));
    expect(screen.queryByText("Der Bot ist hier kein Moderator — der Text geht als normale Nachricht raus.")).not.toBeInTheDocument();
  });

  it("converts a leading timeout slash command into structured fields before saving", async () => {
    let created: unknown;
    const fetcher = panelFetch({
      commands: () => [],
      onMutation: (method, _path, body) => {
        if (method === "POST") created = body;
        return jsonResponse({ warnings: [] });
      },
    });
    renderPanel(fetcher, { botIsModerator: false });
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "roulette" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Antwort" }), {
      target: { value: "/timeout {user} 30-60 Raid spamming\nTimed out for {timeout.duration}" },
    });
    expect(screen.getByText("Timeout für den Aufrufer für 30–60 s.")).toHaveAttribute("role", "status");
    expect(screen.queryByRole("switch", { name: "Aufrufer timeouten" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));

    expect(screen.getByRole("spinbutton", { name: "Mindestens" })).toHaveValue("30");
    expect(screen.getByRole("spinbutton", { name: "Höchstens" })).toHaveValue("60");
    expect(screen.getByRole("textbox", { name: "Antwort (optional)" })).toHaveValue("Timed out for {timeout.duration}");
    expect(screen.getByRole("textbox", { name: "Timeout-Grund" })).toHaveValue("Raid spamming");
    expect(screen.getByText("Der Bot ist kein Moderator. Timeouts können nicht ausgeführt werden.")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Kanalvariable ändern" })).toBeInTheDocument();

    await waitFor(() => expect(created).toMatchObject({
      name: "roulette",
      kind: "timeout",
      text: "Timed out for {timeout.duration}",
      timeoutAction: {
        minSeconds: 30,
        maxSeconds: 60,
        reason: "Raid spamming",
        fallbackText: "",
      },
    }));
  });

  it("converts a leading announcement slash command and keeps the converted result visible", async () => {
    let saved: unknown;
    const fetcher = panelFetch({
      onMutation: (method, _path, body) => {
        if (method === "PATCH") saved = body;
        return jsonResponse({ warnings: [] });
      },
    });
    renderPanel(fetcher);
    await selectCommand();
    fireEvent.change(screen.getByRole("textbox", { name: "Antwort" }), { target: { value: "/announce Stream starts now!" } });
    expect(screen.getByText("Wird als Twitch-Ankündigung gesendet.")).toHaveAttribute("role", "status");
    fireEvent.click(screen.getByRole("button", { name: "Änderungen speichern" }));

    await waitFor(() => expect(saved).toMatchObject({ kind: "text", responseType: "announcement", text: "Stream starts now!" }));
    expect(screen.getByRole("textbox", { name: "Antwort" })).toHaveValue("Stream starts now!");
    expect(screen.getByRole("radio", { name: "Ankündigung" })).toBeChecked();
  });

  it("shows operators a read-only property list and keeps Active as an immediate action", async () => {
    const fetcher = panelFetch();
    renderPanel(fetcher, { canManage: false });
    await selectCommand();
    const readonly = editor();
    expect(within(readonly).getByText("Nur Broadcaster und Verwalter dürfen Befehle anlegen, bearbeiten oder löschen.")).toBeInTheDocument();
    expect(within(readonly).getByText("!hey")).toBeInTheDocument();
    expect(within(readonly).getAllByText("Aktiv")).toHaveLength(1);
    expect(within(readonly).getAllByText("Antwort")).toHaveLength(2);
    expect(within(readonly).getByText("nur online")).toBeInTheDocument();
    expect(within(readonly).getByText("aus")).toBeInTheDocument();
    expect(within(readonly).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(readonly).queryByRole("button", { name: "Änderungen speichern" })).not.toBeInTheDocument();

    fireEvent.click(within(readonly).getByRole("switch", { name: "Aktiv" }));
    await waitFor(() => {
      const toggle = fetcher.mock.calls.find(([, init]) => init?.method === "PATCH");
      expect(toggle).toBeDefined();
      expect(toggle?.[1]?.body).toBe(JSON.stringify({ revision: 1, enabled: false }));
    });
  });

  it("shows the minimum tier as a badge and restores focus when the inspector closes", async () => {
    const fetcher = panelFetch();
    const onCloseInspector = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><TextCommandsPanel channelId="kanal-a" language="de" onCloseInspector={onCloseInspector} /></UiProvider>);

    const row = await screen.findByRole("row", { name: /!hallo/u });
    expect(within(row).getByText("Alle")).toHaveClass("ui-badge");
    expect(within(row).queryByRole("combobox")).not.toBeInTheDocument();

    row.focus();
    fireEvent.click(row);
    const inspector = await screen.findByRole("region", { name: "Eigenschaften von !hallo" });
    expect(within(inspector).getByRole("tab", { name: "Einstellungen" })).toBeInTheDocument();
    fireEvent.click(within(inspector).getByRole("button", { name: "Schließen" }));
    expect(row).toHaveFocus();
    expect(onCloseInspector).toHaveBeenCalledOnce();

    fireEvent.click(row);
    const reopened = await screen.findByRole("region", { name: "Eigenschaften von !hallo" });
    fireEvent.keyDown(within(reopened).getByRole("button", { name: "Schließen" }), { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Eigenschaften von !hallo" })).not.toBeInTheDocument();
    expect(onCloseInspector).toHaveBeenCalledTimes(2);
  });

  it("edits the minimum tier in the inspector and saves the draft as one change", async () => {
    let current = makeCommand();
    const fetcher = panelFetch({
      commands: () => [current],
      onMutation: (method, _path, body) => {
        if (method !== "PATCH" || typeof body !== "object" || body === null || !("revision" in body)) {
          return jsonResponse({ warnings: [] });
        }
        if (body.revision !== current.revision) {
          return jsonResponse({ error: "command_changed_concurrently", current }, 409);
        }
        if ("minimumTier" in body && typeof body.minimumTier === "string") {
          current = { ...current, minimumTier: body.minimumTier as TextCommand["minimumTier"], revision: current.revision + 1 };
        } else if ("text" in body && typeof body.text === "string") {
          current = { ...current, text: body.text, revision: current.revision + 1 };
        }
        return jsonResponse({ warnings: [] });
      },
    });
    renderPanel(fetcher);
    await selectCommand();
    fireEvent.click(within(editor()).getByRole("tab", { name: "Erweitert" }));
    const minimumTierGroup = within(editor()).getByRole("radiogroup", { name: "Wer darf auslösen" });
    fireEvent.click(within(minimumTierGroup).getByRole("radio", { name: /^Moderatoren\./u }));
    fireEvent.click(within(editor()).getByRole("button", { name: "Änderungen speichern" }));
    await waitFor(() => expect(current).toMatchObject({ minimumTier: "moderator", revision: 2 }));

    const patches = fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.[1]?.body).toEqual(JSON.stringify({
      revision: 1,
      name: "hallo",
      kind: "text",
      text: "Hallo {user} aus {channel}",
      usageText: "",
      minimumTier: "moderator",
      cooldownSeconds: 5,
      aliases: ["hey"],
      userCooldownSeconds: 15,
      streamCondition: "online",
      games: [],
      responseType: "reply",
      chatTarget: "source_only",
      variableAction: null,
      timeoutAction: null,
    }));
    await waitFor(() => expect(within(screen.getByRole("row", { name: /!hallo/u })).getByText("Moderatoren")).toHaveClass("ui-badge"));
    expect(current.minimumTier).toBe("moderator");
  });

  it("deletes through ConfirmDialog", async () => {
    const fetcher = panelFetch();
    renderPanel(fetcher);
    await selectCommand();
    const deleteButton = screen.getByRole("button", { name: "Befehl löschen" });
    expect(deleteButton).toHaveTextContent("Befehl löschen");
    fireEvent.click(deleteButton);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Aliase !hey/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Befehl !hallo endgültig löschen" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true));
    const deleteCall = fetcher.mock.calls.find(([, init]) => init?.method === "DELETE");
    expect(deleteCall?.[0]).toBe("/api/channels/kanal-a/modules/text_commands/commands/hallo?revision=1");
  });

  it("follows the browser language when the host does not pass one", async () => {
    vi.stubGlobal("fetch", panelFetch());
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    render(<UiProvider><TextCommandsPanel channelId="kanal-a" /></UiProvider>);

    expect(await screen.findByRole("button", { name: "Add command" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Response" })).toBeInTheDocument();
  });

  it("preselects the command requested by Spotlight after the command list loads", async () => {
    vi.stubGlobal("fetch", panelFetch({ commands: () => [makeCommand({ name: "clip" }), makeCommand()] }));
    render(<UiProvider><TextCommandsPanel channelId="kanal-a" language="de" initialSelection="clip" /></UiProvider>);

    expect(await screen.findByRole("region", { name: "Eigenschaften von !clip" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /!clip/u })).toHaveAttribute("aria-selected", "true");
  });
});
