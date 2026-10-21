import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { ToastHost } from "../../src/dashboard/ui/Toast";
import { dismissToast, toastsSnapshot } from "../../src/dashboard/ui/toast-store";
import { TEXT_COMMAND_MINIMUM_TIERS, TEXT_COMMAND_TIMEOUT_TEMPLATE_VARIABLES, type TextCommand } from "../../src/modules/text_commands/contracts";
import { TEXT_COMMAND_DEFAULT_TEXTS } from "../../src/modules/text_commands/contracts/chat-defaults";
import { statusForTier, renderCommandText } from "../../src/modules/text_commands/domain";
import TextCommandsPanel from "../../src/modules/text_commands/panel";
import { textCommandsTexts } from "../../src/modules/text_commands/panel/locale";
import { useDashboardRoute } from "../../src/dashboard/router";
import { jsonResponse } from "../unit/fixtures";
import { clickSelectOption, renderWithQuery } from "../query-test-utils";

const initialLanguage = Object.getOwnPropertyDescriptor(window.navigator, "language");
const originalRangeBounds = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");

beforeEach(() => {
  if (originalRangeBounds === undefined) {
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(0, 0, 0, 0),
    });
  }
});

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
  channelVariables?: readonly { name: string; value: number; description: string }[];
  templateVariables?: readonly unknown[];
  onMutation?: (method: string, path: string, body: unknown) => Response | Promise<Response>;
}

const panelFetch = ({ commands = () => [makeCommand()], channelVariables = [], templateVariables, onMutation = () => jsonResponse({ warnings: [] }) }: FetchOptions = {}): ReturnType<typeof vi.fn<typeof fetch>> =>
  vi.fn<typeof fetch>((input, init) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
    if (url.pathname.endsWith("/template-variables") && method === "GET") return Promise.resolve(jsonResponse({ variables: templateVariables ?? [
      { name: "text.welcome", moduleId: "text_library", isTextBlock: true, sample: "Willkommen im Kanal" },
      ...TEXT_COMMAND_TIMEOUT_TEMPLATE_VARIABLES.map((variable) => ({ ...variable, moduleId: "text_commands", isTextBlock: false })),
    ] }));
    if (url.pathname.endsWith("/commands") && method === "GET") return Promise.resolve(jsonResponse({ commands: commands(), variables: channelVariables }));
    if (url.pathname.includes("/commands/") || (url.pathname.endsWith("/commands") && method !== "GET")) {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : null;
      return Promise.resolve(onMutation(method, url.pathname, body)).then(async (response) => {
        if (!response.ok) return response;
        const payload: unknown = await response.clone().json().catch(() => null);
        if (typeof payload === "object" && payload !== null && "command" in payload) return response;
        const fields = typeof body === "object" && body !== null ? body as Partial<TextCommand> : {};
        const oldName = url.pathname.endsWith("/commands") ? undefined : url.pathname.split("/").at(-1);
        const existing = commands().find((command) => command.name === oldName);
        const name = typeof fields.name === "string" ? fields.name : existing?.name ?? "neu";
        const command: TextCommand = {
          ...(existing ?? makeCommand({ name })),
          ...fields,
          channelId: "kanal-a",
          name,
          enabled: typeof fields.enabled === "boolean" ? fields.enabled : existing?.enabled ?? true,
          revision: (existing?.revision ?? 0) + 1,
        };
        const warnings = typeof payload === "object" && payload !== null && "warnings" in payload && Array.isArray(payload.warnings)
          ? payload.warnings
          : [];
        return jsonResponse({ command, warnings }, response.status);
      });
    }
    return Promise.resolve(jsonResponse({}, 404));
  });

const renderPanel = (fetcher: typeof fetch, props: { language?: "de" | "en"; canManage?: boolean; canOperate?: boolean; botIsModerator?: boolean | null } = {}) => {
  vi.stubGlobal("fetch", fetcher);
  const { language = "de", ...panelProps } = props;
  return renderWithQuery(<UiProvider><TextCommandsPanel channelId="kanal-a" language={language} {...panelProps} /></UiProvider>);
};

const commandList = async (): Promise<HTMLElement> => waitFor(() => {
  const node = document.querySelector(".text-command-list");
  if (!(node instanceof HTMLElement)) throw new Error("Command list is missing");
  return node;
});

const selectCommand = async (name = "hallo"): Promise<HTMLElement> => {
  const list = await commandList();
  const heading = await within(list).findByText(`!${name}`);
  const row = heading.closest(".text-command-row");
  if (!(row instanceof HTMLElement)) throw new Error("Command row is missing");
  fireEvent.click(row);
  return row;
};

const selectKind = (label: string): HTMLElement => {
  const group = screen.getByRole("group", { name: "Art der Antwort" });
  const option = within(group).getByRole("button", { name: label });
  fireEvent.click(option);
  return option;
};

const editor = (): HTMLElement => {
  const node = document.querySelector(".text-command-editor");
  if (!(node instanceof HTMLElement)) throw new Error("Command editor is missing");
  return node;
};

const tierInclusion = (tier: TextCommand["minimumTier"]): string => {
  const labels = textCommandsTexts("de");
  return labels.tierDescription(tier, statusForTier[tier].map((status) => labels.tierSubjects[status]));
};

const selectMinimumTier = async (tier: TextCommand["minimumTier"]): Promise<HTMLElement> => {
  const labels = textCommandsTexts("de");
  const select = screen.getByRole("combobox", { name: labels.minimumRole });
  fireEvent.click(select);
  clickSelectOption(await screen.findByRole("option", { name: labels.tierLabels[tier], hidden: true }));
  return select;
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
    toastsSnapshot().forEach((toast) => dismissToast(toast.id));
    if (initialLanguage !== undefined) Object.defineProperty(window.navigator, "language", initialLanguage);
    if (originalRangeBounds === undefined) delete (Range.prototype as unknown as { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect;
    else Object.defineProperty(Range.prototype, "getBoundingClientRect", originalRangeBounds);
  });

  it("opens a template request as an unsaved prefilled command", async () => {
    const fetcher = panelFetch();
    const consumed = vi.fn<() => void>();
    vi.stubGlobal("fetch", fetcher);
    const Harness = () => {
      const [initialCommand, setInitialCommand] = useState<{ name: string; text: string } | undefined>({ name: "wetter", text: "In {weather.place} sind es {weather.temp}." });
      return <TextCommandsPanel
        channelId="kanal-a"
        language="de"
        {...(initialCommand === undefined ? {} : { initialCommand })}
        onInitialCommandConsumed={() => { consumed(); setInitialCommand(undefined); }}
      />;
    };
    renderWithQuery(<UiProvider><Harness /></UiProvider>);

    await waitFor(() => expect(consumed).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("textbox", { name: "Befehlsname" })).toHaveValue("wetter");
    expect(screen.getByRole("textbox", { name: "Antworttext" })).toHaveValue("In {weather.place} sind es {weather.temp}.");
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST" || init?.method === "PUT")).toBe(false);
  });

  it("opens the canonical command when the initial command name is an alias", async () => {
    const fetcher = panelFetch({ commands: () => [makeCommand({ name: "weather", aliases: ["wetter"], text: "Canonical response" })] });
    const consumed = vi.fn<() => void>();
    vi.stubGlobal("fetch", fetcher);
    const Harness = () => {
      const [initialCommand, setInitialCommand] = useState<{ name: string; text: string } | undefined>({ name: "WETTER", text: "Template response" });
      return <TextCommandsPanel
        channelId="kanal-a"
        language="de"
        {...(initialCommand === undefined ? {} : { initialCommand })}
        onInitialCommandConsumed={() => { consumed(); setInitialCommand(undefined); }}
      />;
    };
    renderWithQuery(<UiProvider><Harness /></UiProvider>);

    await waitFor(() => expect(consumed).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("textbox", { name: "Befehlsname" })).toHaveValue("weather");
    expect(screen.getByRole("textbox", { name: "Antworttext" })).toHaveValue("Canonical response");
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST" || init?.method === "PUT")).toBe(false);
  });

  it("shows cached commands immediately when returning to the module", async () => {
    vi.stubGlobal("fetch", panelFetch());
    const view = renderWithQuery(<UiProvider><TextCommandsPanel channelId="kanal-a" language="de" /></UiProvider>, undefined, { gcTime: 600_000 });
    await within(await commandList()).findByText("!hallo");
    view.rerender(<UiProvider><div /></UiProvider>);
    view.rerender(<UiProvider><TextCommandsPanel channelId="kanal-a" language="de" /></UiProvider>);
    expect(within(await commandList()).getByText("!hallo")).toBeInTheDocument();
    expect(document.querySelector(".ui-load-state")).not.toHaveAttribute("data-status", "loading");
  });

  it("keeps command creation visible and explains why an operator cannot use it", async () => {
    renderPanel(panelFetch(), { canManage: false });

    const addButton = await screen.findByRole("button", { name: "Befehl anlegen" });
    expect(addButton).toBeDisabled();
    const reasonId = addButton.getAttribute("aria-describedby");
    expect(reasonId).not.toBeNull();
    const reason = document.getElementById(reasonId as string);
    expect(reason).toBeVisible();
    expect(reason).toHaveTextContent(textCommandsTexts("de").managementLocked);
    expect(reason).not.toHaveAttribute("aria-hidden");
    expect(document.querySelector(".text-command-list .form-error")).toBeNull();
  });

  it("filters commands immediately and reports the filtered count", async () => {
    renderPanel(panelFetch({ commands: () => [
      makeCommand(),
      makeCommand({ name: "discord", aliases: ["community"], text: "Join the Discord" }),
    ] }));

    const search = await screen.findByRole("textbox", { name: "Befehle suchen" });
    fireEvent.change(search, { target: { value: "discord" } });

    const list = await commandList();
    expect(within(list).getByText("!discord")).toBeVisible();
    expect(within(list).queryByText("!hallo")).not.toBeInTheDocument();
    expect(document.querySelector(".text-command-filter-count")).toHaveTextContent("1 Eintrag");
  });

  it.each([
    { browserLanguage: "de-DE", panelLanguage: "en" as const, search: "Search commands", clear: "Clear search", usage: "1 of 1 commands" },
    { browserLanguage: "en-US", panelLanguage: "de" as const, search: "Befehle suchen", clear: "Suche leeren", usage: "1 von 1 Befehle" },
  ])("uses $panelLanguage for common toolbar text when the browser is $browserLanguage", async ({ browserLanguage, panelLanguage, search, clear, usage }) => {
    Object.defineProperty(window.navigator, "language", { configurable: true, value: browserLanguage });
    renderPanel(panelFetch(), { language: panelLanguage });

    await within(await commandList()).findByText("!hallo");
    const searchBox = await screen.findByRole("textbox", { name: search });
    expect(document.querySelector(".list-toolbar__search .ui-field__clear")).toHaveAttribute("aria-label", clear);
    fireEvent.change(searchBox, { target: { value: "hallo" } });
    expect(document.querySelector(".text-command-filter-count")).toHaveTextContent(usage.includes(" of ") ? "1 entry" : "1 Eintrag");
  });

  it("uses the panel language for commands without a response", async () => {
    Object.defineProperty(window.navigator, "language", { configurable: true, value: "de-DE" });
    renderPanel(panelFetch({ commands: () => [makeCommand({ kind: "list", text: "", aliases: [] })] }), { language: "en" });

    expect(await within(await commandList()).findByText("Lists all enabled commands (without aliases).")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Response type" })).toBeInTheDocument();
  });

  it("reports a command-list load failure in the persistent toast host", async () => {
    let commandLoads = 0;
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (url.pathname.endsWith("/template-variables")) return Promise.resolve(jsonResponse({ variables: [] }));
      if (url.pathname.endsWith("/commands")) {
        commandLoads += 1;
        return Promise.resolve(commandLoads === 1
          ? jsonResponse({ error: "command_load_failed" }, 500)
          : jsonResponse({ commands: [makeCommand()], variables: [] }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);

    renderWithQuery(<UiProvider><ToastHost /><TextCommandsPanel channelId="kanal-a" language="de" /></UiProvider>);

    const loadError = textCommandsTexts("de").loadError;
    await waitFor(() => expect(document.querySelector(".ui-toast--error")).toHaveTextContent(loadError));
    expect(document.querySelector(".ui-load-state__content [role=alert]")).toHaveTextContent(loadError);
    expect(document.querySelector(".text-command-list .form-error")).toBeNull();
    expect(screen.getByRole("button", { name: "Befehl anlegen" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: /^(Retry|Erneut versuchen)$/u }));
    expect(await within(await commandList()).findByText("!hallo")).toBeInTheDocument();
    expect(commandLoads).toBe(2);
  });

  it("retries a failed template-variable query inside the editor", async () => {
    let variableReads = 0;
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/template-variables")) {
        variableReads += 1;
        return Promise.resolve(variableReads === 1
          ? jsonResponse({ error: "temporarily_unavailable" }, 503)
          : jsonResponse({ variables: [] }));
      }
      if (url.pathname.endsWith("/commands")) return Promise.resolve(jsonResponse({ commands: [makeCommand()], variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);

    renderWithQuery(<UiProvider><TextCommandsPanel channelId="kanal-a" language="en" /></UiProvider>, undefined, { gcTime: 600_000 });
    await selectCommand();

    expect(await screen.findByText(textCommandsTexts("en").templateVariablesLoadError)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^(Retry|Erneut versuchen)$/u }));

    await waitFor(() => expect(screen.queryByText(textCommandsTexts("en").templateVariablesLoadError)).not.toBeInTheDocument());
    expect(variableReads).toBe(2);
  });

  it("shows and retries a background template-variable refresh failure", async () => {
    let variableReads = 0;
    let failNextRead = false;
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/template-variables")) {
        variableReads += 1;
        return Promise.resolve(failNextRead
          ? jsonResponse({ error: "temporarily_unavailable" }, 503)
          : jsonResponse({ variables: [] }));
      }
      if (url.pathname.endsWith("/commands")) return Promise.resolve(jsonResponse({ commands: [makeCommand()], variables: [] }));
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetcher);

    function TogglePanel() {
      const [mounted, setMounted] = useState(true);
      return <>
        <button onClick={() => setMounted((current) => !current)}>{mounted ? "Leave module" : "Re-enter module"}</button>
        {mounted ? <TextCommandsPanel channelId="kanal-a" language="en" /> : null}
      </>;
    }
    renderWithQuery(<UiProvider><TogglePanel /></UiProvider>, undefined, {
      gcTime: 600_000,
      staleTime: 0,
    });
    await selectCommand();
    expect(variableReads).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "Leave module" }));
    failNextRead = true;
    fireEvent.click(screen.getByRole("button", { name: "Re-enter module" }));
    await within(await commandList()).findByText("!hallo");
    await selectCommand();
    await waitFor(() => expect(variableReads).toBe(2));

    expect(await screen.findByText(textCommandsTexts("en").templateVariablesLoadError)).toBeInTheDocument();
    failNextRead = false;
    fireEvent.click(screen.getByRole("button", { name: /^(Retry|Erneut versuchen)$/u }));
    await waitFor(() => expect(screen.queryByText(textCommandsTexts("en").templateVariablesLoadError)).not.toBeInTheDocument());
    expect(variableReads).toBe(3);
  });

  it("opens a collection editor with message, timing, and destination sections", async () => {
    const fetcher = panelFetch();
    renderPanel(fetcher);
    await selectCommand();

    expect(screen.getByRole("heading", { name: "Auslöser" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Art der Antwort" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Wer darf auslösen" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Abklingzeit" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Weitere Einstellungen" })).toBeInTheDocument();
    expect(screen.getByText("5 / 32 Zeichen")).toBeInTheDocument();
    expect(screen.getByText("a–z, 0–9, - und _")).toBeInTheDocument();
    expect(editor().querySelector(".ui-field__prefix")).toHaveTextContent("!");
    expect(screen.getByText(renderCommandText("Hallo {user} aus {channel}", { user: "zuschauerin", channel: "beispielkanal" }))).toBeInTheDocument();
    const advanced = editor().querySelector("details.command-usage-advanced");
    expect(advanced).not.toHaveAttribute("open");
    expect(screen.getAllByText(textCommandsTexts("de").variableSelectHint)).toHaveLength(1);
    expect(within(editor()).queryByTestId("command-variable-action-slot")).not.toBeInTheDocument();

    expect(screen.getByText(tierInclusion("everyone"))).toBeInTheDocument();
    for (const tier of TEXT_COMMAND_MINIMUM_TIERS) {
      await selectMinimumTier(tier);
      expect(screen.getByText(tierInclusion(tier))).toBeInTheDocument();
    }
  });

  it("shows a description for the selected response type", async () => {
    const fetcher = panelFetch();
    renderPanel(fetcher);
    await selectCommand();
    expect(screen.getByText("Antwortet mit dem Text unten.")).toBeInTheDocument();
    selectKind("Befehlsliste");
    expect(screen.getByText("Zählt alle eingeschalteten Befehle auf (ohne Aliase).")).toBeInTheDocument();
    selectKind("Shoutout");
    expect(screen.getByText("!so <name> empfiehlt einen Twitch-Kanal im Chat.")).toBeInTheDocument();
    selectKind("Timeout");
    expect(screen.getByText("Timeout für den Aufrufer; Antwort bei Erfolg und Ersatztext bei Ablehnung.")).toBeInTheDocument();
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
    fireEvent.change(screen.getByRole("textbox", { name: "Befehlsname" }), { target: { value: "test" } });
    const response = screen.getByRole("textbox", { name: "Antworttext" });
    fireEvent.change(response, { target: { value: "/" } });

    const suggestions = screen.getByRole("group", { name: "Twitch-Befehle am Anfang werden beim Speichern in strukturierte Felder umgewandelt." });
    expect(within(suggestions).getByRole("button", { name: /\/timeout \{user\} <seconds\|min-max> \[reason\]/u })).toHaveTextContent("Timeoutet den Aufrufer");
    expect(within(suggestions).getByRole("button", { name: /\/announce <text>/u })).toHaveTextContent("Twitch-Ankündigung");
    expect(within(suggestions).getByRole("button", { name: /\/shoutout \{target\}/u })).toHaveTextContent("Befehlsargument");

    fireEvent.change(response, { target: { value: "/timeout somebody 30" } });
    expect(editor().querySelector("#command-text-error")).toHaveTextContent("Ungültige Syntax: /timeout {user} <seconds|min-max> [reason]");
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(created).toBeUndefined();

    fireEvent.change(response, { target: { value: "/permit everyone" } });
    expect(screen.getByText("Dieser Slash-Befehl bleibt Antworttext.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    await waitFor(() => expect(created).toMatchObject({ kind: "text", text: "/permit everyone" }));
  });

  it("keeps a reserved slash-help slot beside the response editor", async () => {
    renderPanel(panelFetch({ commands: () => [] }));
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));

    expect(templateEditorFor("text").querySelector(".command-slash-help")).not.toBeNull();
  });

  it("replaces a slash suggestion while preserving the response body", async () => {
    renderPanel(panelFetch({ commands: () => [] }));
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    const response = screen.getByRole("textbox", { name: "Antworttext" });
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
    fireEvent.change(screen.getByRole("textbox", { name: "Befehlsname" }), { target: { value: "shout" } });
    selectKind("Timeout");
    fireEvent.change(screen.getByRole("textbox", { name: "Antworttext (optional)" }), { target: { value: "/shoutout {target}" } });

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
    fireEvent.change(screen.getByRole("textbox", { name: "Befehlsname" }), { target: { value: "shout" } });
    selectKind("Timeout");
    fireEvent.change(screen.getByRole("spinbutton", { name: "Höchstens" }), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(screen.getByRole("spinbutton", { name: "Höchstens" })).toHaveAttribute("aria-invalid", "true");
    expect(created).toBeUndefined();

    fireEvent.change(screen.getByRole("textbox", { name: "Antworttext (optional)" }), { target: { value: "/shoutout {target}" } });
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
    fireEvent.change(screen.getByRole("textbox", { name: "Befehlsname" }), { target: { value: "shout" } });
    fireEvent.click(screen.getByText("Erweitert"));
    fireEvent.click(screen.getByRole("switch", { name: "Kanalvariable ändern" }));
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(screen.getByText("Keine Kanalvariablen angelegt.")).toBeInTheDocument();
    expect(created).toBeUndefined();

    fireEvent.change(screen.getByRole("textbox", { name: "Antworttext" }), { target: { value: "/shoutout {target}" } });
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));

    await waitFor(() => expect(created).toMatchObject({ kind: "shoutout" }));
  });

  it("measures the response length after a slash conversion", async () => {
    let created: { text?: string; kind?: string } | undefined;
    renderPanel(panelFetch({
      commands: () => [],
      onMutation: (_method, _path, body) => {
        created = body as { text?: string };
        return jsonResponse({ warnings: [] });
      },
    }));
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Befehlsname" }), { target: { value: "ann" } });
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(created).toBeUndefined();
    expect(screen.getByRole("textbox", { name: "Antworttext" })).toHaveAttribute("aria-invalid", "true");

    fireEvent.change(screen.getByRole("textbox", { name: "Antworttext" }), { target: { value: `/announce ${"a".repeat(495)}` } });
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));

    await waitFor(() => expect(created?.text).toBe("a".repeat(495)));
  });

  it("measures the response length after a timeout slash conversion", async () => {
    let created: { text?: string; kind?: string } | undefined;
    renderPanel(panelFetch({
      commands: () => [],
      onMutation: (_method, _path, body) => {
        created = body as { text?: string; kind?: string };
        return jsonResponse({ warnings: [] });
      },
    }));
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Befehlsname" }), { target: { value: "tmo" } });
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(created).toBeUndefined();

    fireEvent.change(screen.getByRole("textbox", { name: "Antworttext" }), { target: { value: `/timeout {user} 120\n${"a".repeat(495)}` } });
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));

    await waitFor(() => expect(created).toMatchObject({ kind: "timeout", text: "a".repeat(495) }));
  });

  it("ignores an overlong usage reply that a shoutout conversion replaces", async () => {
    let created: { kind?: string } | undefined;
    renderPanel(panelFetch({
      commands: () => [],
      onMutation: (_method, _path, body) => {
        created = body as { kind?: string };
        return jsonResponse({ warnings: [] });
      },
    }));
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Befehlsname" }), { target: { value: "shout" } });
    fireEvent.change(editor().querySelector('[name="usageText"]') as HTMLElement, { target: { value: " ".repeat(501) } });
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(created).toBeUndefined();
    fireEvent.change(screen.getByRole("textbox", { name: "Antworttext" }), { target: { value: "/shoutout {target}" } });
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
    fireEvent.change(screen.getByRole("textbox", { name: "Befehlsname" }), { target: { value: "timeout" } });
    selectKind("Timeout");
    fireEvent.change(screen.getByRole("textbox", { name: "Antworttext (optional)" }), { target: { value: "Timed out." } });
    fireEvent.change(screen.getByRole("textbox", { name: "Ersatztext bei Ablehnung (optional)" }), { target: { value: "Could not time out." } });
    fireEvent.click(within(editor()).getByText("Erweitert", { selector: "summary" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Antwort bei fehlenden oder ungültigen Argumenten" }), { target: { value: "Usage: !timeout <amount>" } });
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));

    await waitFor(() => expect(created).toMatchObject({ kind: "timeout", usageText: "Usage: !timeout <amount>" }));
  });

  it("offers the shared system variable catalog in the response picker", async () => {
    renderPanel(panelFetch({ commands: () => [] }));
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    const input = within(templateEditorFor("text")).getByRole<HTMLTextAreaElement>("textbox", { name: "Antworttext" });
    fireEvent.change(input, { target: { value: "{", selectionStart: 1, selectionEnd: 1 } });
    const picker = await screen.findByRole("listbox", { name: "Variable auswählen" });
    expect(within(picker).getByRole("option", { name: /\{user\}/u, hidden: true })).toBeInTheDocument();
    expect(within(picker).getByRole("option", { name: /\{uptime\}/u, hidden: true })).toBeInTheDocument();
    expect(within(picker).getByRole("option", { name: /\{random 1-100\}/u, hidden: true })).toBeInTheDocument();
    const textBlock = await within(picker).findByRole("option", { name: /\{text\.welcome\}/u, hidden: true });
    expect(textBlock.querySelector(".ui-template-text-field__suggestion-sample--tag")).toHaveTextContent("Willkommen im Kanal");
    expect(within(picker).getByRole("group", { name: "Textbausteine", hidden: true })).toBeInTheDocument();
    expect(within(picker).getByRole("group", { name: "Kanal", hidden: true })).toBeInTheDocument();
    expect(picker.querySelector(".ui-template-text-field__suggestion-sample")).not.toBeNull();
    const liveLookups = within(picker).getAllByRole("img", { name: "Fragt Twitch live ab, wenn der Befehl ausgeführt wird", hidden: true });
    expect(liveLookups.length).toBeGreaterThan(0);
    for (const liveLookup of liveLookups) {
      expect(liveLookup.querySelector("svg")).toHaveClass("lucide-info");
      expect(liveLookup).toHaveAttribute("title", "Fragt Twitch live ab, wenn der Befehl ausgeführt wird");
    }
    fireEvent.change(input, { target: { value: "{uptime", selectionStart: 7, selectionEnd: 7 } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input).toHaveValue("{uptime}"));
  });

  it("inserts a selected text-library block through the shared variable picker", async () => {
    const fetcher = panelFetch();
    renderPanel(fetcher);
    await selectCommand();

    await waitFor(() => expect(fetcher.mock.calls.some(([input]) => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url).includes("/template-variables"))).toBe(true));
    const input = within(templateEditorFor("text")).getByRole<HTMLTextAreaElement>("textbox", { name: "Antworttext" });
    fireEvent.change(input, { target: { value: `${input.value} ` } });
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.select(input);
    fireEvent.click(within(templateEditorFor("text")).getByRole("button", { name: "Variable einfügen" }));
    const picker = await screen.findByRole("listbox", { name: "Variable auswählen" });
    fireEvent.click(within(picker).getByRole("option", { name: /\{text\.welcome\}/u, hidden: true }));

    expect(input).toHaveValue("Hallo {user} aus {channel} {text.welcome}");
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
    fireEvent.change(screen.getByRole("textbox", { name: "Befehlsname" }), { target: { value: "quiet" } });
    selectKind("Timeout");

    const ordered = [
      screen.getByRole("group", { name: "Art der Antwort" }),
      screen.getByRole("spinbutton", { name: "Mindestens" }),
      screen.getByRole("spinbutton", { name: "Höchstens" }),
      screen.getByRole("textbox", { name: "Antworttext (optional)" }),
      screen.getByRole("textbox", { name: "Ersatztext bei Ablehnung (optional)" }),
      screen.getByRole("textbox", { name: "Timeout-Grund" }),
      editor().querySelector("details.command-usage-advanced > summary"),
    ];
    for (let index = 0; index < ordered.length - 1; index++) {
      const current = ordered[index];
      const next = ordered[index + 1];
      if (current === null || current === undefined || next === null || next === undefined) throw new Error("Timeout editor fields are missing.");
      expect(current.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(screen.getByRole("textbox", { name: "Antworttext (optional)" })).not.toBeRequired();
    expect([...editor().querySelectorAll("h2, h3")].some((heading) => heading.textContent.includes("Text aus Bibliothek"))).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    await waitFor(() => expect(created).toMatchObject({
      kind: "timeout",
      text: "",
      timeoutAction: { minSeconds: 120, maxSeconds: 120, fallbackText: "" },
    }));
  });

  it("marks a blocking timeout range error beside its fields", async () => {
    renderPanel(panelFetch({ commands: () => [] }));
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Befehlsname" }), { target: { value: "quiet" } });
    selectKind("Timeout");
    const minimum = screen.getByRole("spinbutton", { name: "Mindestens" });
    const maximum = screen.getByRole("spinbutton", { name: "Höchstens" });
    fireEvent.change(minimum, { target: { value: "120" } });
    fireEvent.change(maximum, { target: { value: "60" } });

    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));

    expect(minimum).toHaveAttribute("aria-invalid", "true");
    expect(maximum).toHaveAttribute("aria-invalid", "true");
    expect(screen.getAllByText("Die Dauer muss zwischen 1 s und 14 Tagen liegen; das Minimum darf das Maximum nicht überschreiten.")).toHaveLength(2);
  });

  it("shows variable-action validation beside the action fields", async () => {
    const fetcher = panelFetch({ commands: () => [] });
    renderPanel(fetcher);
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Befehlsname" }), { target: { value: "shout" } });
    fireEvent.click(screen.getByText("Erweitert"));
    const toggle = screen.getByRole("switch", { name: "Kanalvariable ändern" });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(toggle).toHaveAttribute("id", "command-variable-action");
    expect(screen.getAllByText(/Kanalvariable und Betrag prüfen/u)).toHaveLength(2);
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("shows a localized server validation error beside its field", async () => {
    const fetcher = panelFetch({
      commands: () => [],
      onMutation: () => jsonResponse({ error: "command_data_invalid", path: "cooldownSeconds", reasonCode: "too_small" }, 400),
    });
    renderPanel(fetcher);
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Befehlsname" }), { target: { value: "zeit" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Antworttext" }), { target: { value: "Test" } });
    const cooldown = screen.getByRole("spinbutton", { name: "Zwischen zwei Aufrufen" });
    fireEvent.change(cooldown, { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));

    expect(await screen.findByText("Der Wert liegt unter dem erlaubten Minimum.")).toBeVisible();
    expect(cooldown).toHaveAttribute("aria-invalid", "true");
  });

  it("marks a stale variable action field after server validation even when variables are available", async () => {
    const fetcher = panelFetch({
      channelVariables: [{ name: "score", value: 5, description: "Points" }],
      commands: () => [makeCommand({ variableAction: { name: "score", operation: "add", amount: 2 } })],
      onMutation: () => jsonResponse({ error: "command_data_invalid", path: "variableAction.name", reasonCode: "custom" }, 400),
    });
    renderPanel(fetcher);
    await selectCommand();
    fireEvent.click(within(editor()).getByText("Erweitert", { selector: "summary" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Antworttext" }), { target: { value: "Changed response" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

    const variable = screen.getByRole("combobox", { name: "Variable" });
    await waitFor(() => expect(variable).toHaveAttribute("aria-invalid", "true"));
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true);
  });

  it("keeps rejected alias text dirty, blocks save, and prompts before Escape closes", async () => {
    const fetcher = panelFetch();
    renderPanel(fetcher);
    await selectCommand();

    const aliases = screen.getByRole("textbox", { name: "Weitere Auslöser" });
    fireEvent.change(aliases, { target: { value: "bad!" } });
    fireEvent.keyDown(aliases, { key: "Enter" });
    expect(aliases).toHaveValue("bad!");
    expect(screen.getByRole("button", { name: "Speichern" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

    expect(await screen.findByText("Alias-Eingabe erst bestätigen oder entfernen.")).toBeVisible();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    fireEvent.keyDown(editor(), { key: "Escape" });
    expect(await screen.findByRole("dialog")).toHaveTextContent("Ungespeicherte Änderungen");
    fireEvent.click(screen.getByRole("button", { name: "Weiter bearbeiten" }));
    expect(screen.getByRole("textbox", { name: "Weitere Auslöser" })).toHaveValue("bad!");
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

  it("keeps custom Shoutout text when the selected kind is clicked again", async () => {
    renderPanel(panelFetch({ commands: () => [makeCommand({ kind: "shoutout", text: "Custom shoutout", usageText: "Custom usage" })] }));
    await selectCommand();

    selectKind("Shoutout");

    expect(screen.getByRole("textbox", { name: "Antworttext" })).toHaveValue("Custom shoutout");
  });

  it("restores per-kind response, usage, variable, and timeout drafts until the active kind is saved", async () => {
    const onMutation = vi.fn<(method: string, path: string, body: unknown) => Response>(() => jsonResponse({ warnings: [] }));
    renderPanel(panelFetch({ commands: () => [makeCommand({ text: "Text draft", variableAction: { name: "score", operation: "add", amount: 2 } })], onMutation }));
    await selectCommand();

    selectKind("Shoutout");
    fireEvent.change(screen.getByRole("textbox", { name: "Antworttext" }), { target: { value: "Shoutout draft" } });
    fireEvent.click(within(editor()).getByText("Erweitert", { selector: "summary" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Antwort bei fehlenden oder ungültigen Argumenten" }), { target: { value: "Shoutout usage draft" } });
    selectKind("Befehlsliste");
    expect(screen.queryByRole("textbox", { name: "Antworttext" })).not.toBeInTheDocument();
    selectKind("Shoutout");
    expect(screen.getByRole("textbox", { name: "Antworttext" })).toHaveValue("Shoutout draft");
    fireEvent.click(within(editor()).getByText("Erweitert", { selector: "summary" }));
    expect(screen.getByRole("textbox", { name: "Antwort bei fehlenden oder ungültigen Argumenten" })).toHaveValue("Shoutout usage draft");

    selectKind("Timeout");
    fireEvent.change(screen.getByRole("textbox", { name: "Antworttext (optional)" }), { target: { value: "Timeout draft" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Ersatztext bei Ablehnung (optional)" }), { target: { value: "Timeout fallback draft" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Timeout-Grund" }), { target: { value: "Timeout reason draft" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Mindestens" }), { target: { value: "30" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Höchstens" }), { target: { value: "90" } });
    selectKind("Antworttext");
    expect(screen.getByRole("textbox", { name: "Antworttext" })).toHaveValue("Text draft");
    fireEvent.click(within(editor()).getByText("Erweitert", { selector: "summary" }));
    expect(screen.getByRole("switch", { name: "Kanalvariable ändern" })).toBeChecked();

    selectKind("Timeout");
    expect(screen.getByRole("textbox", { name: "Antworttext (optional)" })).toHaveValue("Timeout draft");
    expect(screen.getByRole("textbox", { name: "Ersatztext bei Ablehnung (optional)" })).toHaveValue("Timeout fallback draft");
    expect(screen.getByRole("textbox", { name: "Timeout-Grund" })).toHaveValue("Timeout reason draft");
    expect(await screen.findByRole("spinbutton", { name: "Mindestens" })).toHaveValue(30);
    expect(screen.getByRole("spinbutton", { name: "Höchstens" })).toHaveValue(90);
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(onMutation).toHaveBeenCalledTimes(1));
    const payload = onMutation.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(payload).toMatchObject({ kind: "timeout", text: "Timeout draft", timeoutAction: { minSeconds: 30, maxSeconds: 90, fallbackText: "Timeout fallback draft", reason: "Timeout reason draft" } });
    expect(payload).toHaveProperty("usageText", "");
    expect(payload).not.toHaveProperty("kindDrafts");
  });

  it("edits only the selected currency token", async () => {
    renderPanel(panelFetch({ commands: () => [makeCommand({ text: "{currency.convert USD EUR} then {currency.convert GBP CAD}" })] }));
    await selectCommand();

    const target = screen.getByRole("combobox", { name: "Währungsvariable" });
    fireEvent.click(target);
    clickSelectOption(await screen.findByRole("option", { name: "Antworttext · 2", hidden: true }));
    const from = screen.getByRole("combobox", { name: "Von" });
    fireEvent.click(from);
    clickSelectOption(await screen.findByRole("option", { name: "JPY", hidden: true }));

    expect(screen.getByRole("textbox", { name: "Antworttext" })).toHaveValue("{currency.convert USD EUR} then {currency.convert JPY CAD}");
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

    selectKind("Befehlsliste");
    expect(screen.queryByRole("textbox", { name: textCommandsTexts("de").templateFieldLabels.usageText })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(onMutation).toHaveBeenCalledTimes(1));
    expect(onMutation.mock.calls[0]?.[2]).toMatchObject({ kind: "list", text: "" });
    expect(onMutation.mock.calls[0]?.[2]).not.toHaveProperty("usageText");
    expect(screen.queryByRole("button", { name: /Antwort bei fehlenden oder ungültigen Argumenten/u })).not.toBeInTheDocument();
  });

  it("shows variable action fields only while the optional section is on", async () => {
    renderPanel(panelFetch());
    await selectCommand();

    expect(editor()).toHaveClass("text-command-editor");
    expect(editor().querySelector(".text-command-editor__scroll")).toBeInTheDocument();
    fireEvent.click(within(editor()).getByText("Erweitert"));
    const toggle = screen.getByRole("switch", { name: "Kanalvariable ändern" });
    const section = toggle.closest(".ui-switch-section");
    expect(section).toBeInTheDocument();
    expect(within(section as HTMLElement).queryByTestId("command-variable-action-slot")).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(within(section as HTMLElement).getByTestId("command-variable-action-slot")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Variable" }).closest(".ui-switch-section__content")).not.toBeNull();
  });

  it("defaults set_argument to moderators unless the draft already chose a tier", async () => {
    renderPanel(panelFetch({ commands: () => [] }));
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    fireEvent.click(screen.getByText("Erweitert"));
    fireEvent.click(screen.getByRole("switch", { name: "Kanalvariable ändern" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Kanalvariable ändern" })).getByRole("button", { name: "Argument" }));
    expect(screen.getByRole("combobox", { name: "Mindestrolle" })).toHaveTextContent("Moderatoren");
    expect(screen.getByText(tierInclusion("moderator"))).toBeInTheDocument();
  });

  it("keeps an explicit everyone tier when set_argument is selected later", async () => {
    renderPanel(panelFetch({ commands: () => [] }));
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    await selectMinimumTier("vip");
    await selectMinimumTier("everyone");
    fireEvent.click(screen.getByText("Erweitert"));
    fireEvent.click(screen.getByRole("switch", { name: "Kanalvariable ändern" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Kanalvariable ändern" })).getByRole("button", { name: "Argument" }));
    expect(screen.getByRole("combobox", { name: "Mindestrolle" })).toHaveTextContent("Alle");
    expect(screen.getByText(tierInclusion("everyone"))).toBeInTheDocument();
  });

  it("describes a silent action in the command list", async () => {
    const actionCommand = makeCommand({
      text: "",
      aliases: [],
      variableAction: { name: "score", operation: "add", amount: 1 },
    });
    renderPanel(panelFetch({ commands: () => [actionCommand] }));
    expect(await screen.findByText("Ändert score um +1")).toBeInTheDocument();
  });

  it("opens the anchored variable overlay below 600 pixels", async () => {
    const originalMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query: string): MediaQueryList => ({
      matches: query === "(max-width: 599px)", media: query, onchange: null,
      addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => false,
    });
    try {
      renderPanel(panelFetch({ commands: () => [] }));
      fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
      const input = within(templateEditorFor("text")).getByRole("textbox", { name: "Antworttext" });
      fireEvent.change(input, { target: { value: "{", selectionStart: 1, selectionEnd: 1 } });
      const picker = await screen.findByRole("listbox", { name: "Variable auswählen" });
      expect(picker.parentElement).toHaveClass("ui-template-text-field__suggestions-dropdown");
      expect(within(picker).getByRole("group", { name: "Kanal", hidden: true })).toBeInTheDocument();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("shows the shoutout usage response and its Twitch cooldown hint", async () => {
    renderPanel(panelFetch({ commands: () => [] }));
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    selectKind("Shoutout");
    fireEvent.click(within(editor()).getByText("Erweitert", { selector: "summary" }));
    expect(screen.getByRole("textbox", { name: "Antwort bei fehlenden oder ungültigen Argumenten" })).toBeInTheDocument();
    expect(screen.getByText("Twitch begrenzt Shoutouts selbst: 2 Minuten pro Kanal und 60 Minuten pro Ziel.")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Mindestrolle" })).toHaveTextContent("Moderatoren");
    expect(screen.getByText(tierInclusion("moderator"))).toBeInTheDocument();
  });

  it("puts the Art select's hint below the field, not between the label and the control", async () => {
    const fetcher = panelFetch();
    renderPanel(fetcher);
    await selectCommand();
    const group = screen.getByRole("group", { name: "Art der Antwort" });
    const hint = group.closest(".segment-choice-field")?.querySelector(".segment-choice-field__hint");
    expect(hint).toHaveTextContent("Antwortet mit dem Text unten.");
    expect(group.compareDocumentPosition(hint as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("inserts a response variable inline from the keyboard", async () => {
    const fetcher = panelFetch({ commands: () => [] });
    renderPanel(fetcher);
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    const input = within(templateEditorFor("text")).getByRole("textbox", { name: "Antworttext" });
    fireEvent.change(input, { target: { value: "{channel", selectionStart: 8, selectionEnd: 8 } });
    await screen.findByRole("listbox", { name: "Variable auswählen" });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(input).toHaveValue("{channel}"));
  });

  it("uses the chat preview, not plain text, for a command list's response", async () => {
    const rows = [makeCommand({ name: "commands", kind: "list", aliases: [] }), makeCommand({ name: "hallo" })];
    const fetcher = panelFetch({ commands: () => rows });
    renderPanel(fetcher);
    await selectCommand("commands");
    const panel = editor();
    expect(within(panel).getByText("Vorschau")).toBeInTheDocument();
    expect(within(panel).getByText("BroBot")).toBeInTheDocument();
    expect(within(panel).getByText("Befehle: !hallo")).toBeInTheDocument();
    expect(within(panel).queryByRole("textbox", { name: "Antworttext" })).not.toBeInTheDocument();
  });

  it("gives every editor field a non-empty helper line and edits aliases and cooldowns", async () => {
    const fetcher = panelFetch();
    renderPanel(fetcher);
    await selectCommand();
    const panel = editor();

    const assertVisibleFieldHelpers = (): void => {
      for (const role of ["textbox", "group", "spinbutton", "switch"] as const) {
        for (const field of within(panel).queryAllByRole(role)) {
          if (role === "group" && !field.classList.contains("segment-choice")) continue;
          if (role === "switch" && field.closest(".page-header__module-switch") !== null) continue;
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
    expect(within(panel).getByRole("textbox", { name: "Befehlsname" }).closest(".ui-field")?.querySelector(".ui-field__prefix")).toHaveTextContent("!");
    fireEvent.click(within(panel).getByText("Erweitert", { selector: "summary" }));
    assertVisibleFieldHelpers();
    const cooldown = screen.getByRole("spinbutton", { name: "Zwischen zwei Aufrufen" });
    const userCooldown = screen.getByRole("spinbutton", { name: "Je Nutzer" });
    expect(cooldown).toHaveValue(5);
    expect(userCooldown).toHaveValue(15);
    expect(within(panel).getAllByText("s")).toHaveLength(2);
    fireEvent.change(userCooldown, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => {
      const patch = fetcher.mock.calls.find(([, init]) => init?.method === "PATCH");
      expect(patch?.[1]?.body).toBe(JSON.stringify({
        revision: 1,
        name: "hallo",
        enabled: true,
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
    fireEvent.change(screen.getByRole("textbox", { name: "Befehlsname" }), { target: { value: "!Neu" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Antworttext" }), { target: { value: "Hallo" } });
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));

    await waitFor(() => expect(created).toEqual({
      name: "neu",
      enabled: true,
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
      chatTarget: null,
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
    selectKind("Befehlsliste");
    fireEvent.change(screen.getByRole("textbox", { name: "Befehlsname" }), { target: { value: "befehle" } });
    expect(screen.queryByRole("textbox", { name: "Antworttext" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));

    await waitFor(() => expect(created).toEqual({
      name: "befehle",
      enabled: true,
      text: "",
      kind: "list",
      minimumTier: "everyone",
      cooldownSeconds: 5,
      aliases: [],
      userCooldownSeconds: 0,
      streamCondition: "any",
      games: [],
      responseType: "say",
      chatTarget: null,
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
    fireEvent.change(screen.getByRole("textbox", { name: "Befehlsname" }), { target: { value: "neu" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Antworttext" }), { target: { value: "Hallo" } });
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));

    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    expect(document.querySelector(".text-command-editor .ui-save-bar")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("textbox", { name: "Befehlsname" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Antworttext" })).toBeDisabled();
    resolveCreate?.(jsonResponse({ warnings: [] }));
    await waitFor(() => expect(document.querySelector(".text-command-editor")).not.toBeInTheDocument());
  });

  it("keeps a cleared cooldown empty and does not send a null value", async () => {
    const fetcher = panelFetch({ commands: () => [] });
    renderPanel(fetcher);
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Befehlsname" }), { target: { value: "neu" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Antworttext" }), { target: { value: "Hallo" } });
    const cooldown = screen.getByRole("spinbutton", { name: "Zwischen zwei Aufrufen" });
    fireEvent.change(cooldown, { target: { value: "" } });
    expect(cooldown).toHaveValue(null);
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    expect(cooldown).toHaveValue(null);
  });

  it("saves an unknown variable as a warning and keeps the save action primary", async () => {
    const fetcher = panelFetch({
      onMutation: () => jsonResponse({
        warnings: [{ field: "text", code: "unknown_template_variables", unknownVariables: ["viewer"] }],
      }),
    });
    renderPanel(fetcher);
    await selectCommand();
    const response = screen.getByRole("textbox", { name: "Antworttext" });
    fireEvent.change(response, { target: { value: "Hallo {viewer}" } });
    expect(await screen.findByText(/Unbekannte Variable \{viewer\}/u)).toBeInTheDocument();
    const save = screen.getByRole("button", { name: "Speichern" });
    expect(save).toBeEnabled();
    expect(save).toHaveAttribute("data-variant", "primary");
    fireEvent.click(save);
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    expect(await screen.findByRole("status")).toHaveTextContent("Alle Änderungen gespeichert Unbekannte Variable: {viewer}");
    expect(response).toHaveValue("Hallo {viewer}");
  });

  it("guards row switching and Escape with all three choices", async () => {
    const rows = [makeCommand(), makeCommand({ name: "beta", text: "Antwort B", aliases: [] })];
    const fetcher = panelFetch({ commands: () => rows });
    renderPanel(fetcher);
    await selectCommand("hallo");
    fireEvent.change(screen.getByRole("textbox", { name: "Antworttext" }), { target: { value: "Entwurf" } });
    const beta = await screen.findByText("!beta");
    fireEvent.click(beta.closest(".text-command-row") as HTMLElement);
    const guard = await screen.findByRole("dialog");
    expect(within(guard).getByRole("button", { name: "Weiter bearbeiten" })).toBeInTheDocument();
    expect(within(guard).getByRole("button", { name: "Verwerfen und wechseln" })).toBeInTheDocument();
    expect(within(guard).getByRole("button", { name: "Speichern und wechseln" })).toBeInTheDocument();
    fireEvent.click(within(guard).getByRole("button", { name: "Weiter bearbeiten" }));
    expect(screen.getByRole("textbox", { name: "Antworttext" })).toHaveValue("Entwurf");

    fireEvent.keyDown(editor(), { key: "Escape" });
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Weiter bearbeiten" }));
    fireEvent.click(document.querySelector(".collection-page__detail-back") as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "Verwerfen und wechseln" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.querySelector(".collection-page")).toHaveAttribute("data-detail-open", "false");
    expect(document.querySelector(".text-command-editor")).toBeInTheDocument();
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
    renderWithQuery(<UiProvider><Harness /></UiProvider>);

    const response = await screen.findByRole("textbox", { name: "Antworttext" });
    fireEvent.change(response, { target: { value: "Entwurf" } });
    fireEvent.click(screen.getByRole("button", { name: "Go overview" }));
    const guard = await screen.findByRole("dialog");
    expect(screen.getByText("module")).toBeInTheDocument();
    expect(within(guard).getByRole("button", { name: "Weiter bearbeiten" })).toBeInTheDocument();
    expect(within(guard).getByRole("button", { name: "Verwerfen und wechseln" })).toBeInTheDocument();
    expect(within(guard).getByRole("button", { name: "Speichern und wechseln" })).toBeInTheDocument();

    fireEvent.click(within(guard).getByRole("button", { name: "Weiter bearbeiten" }));
    expect(screen.getByRole("textbox", { name: "Antworttext" })).toHaveValue("Entwurf");
    fireEvent.click(screen.getByRole("button", { name: "Go overview" }));
    fireEvent.click(await screen.findByRole("button", { name: "Verwerfen und wechseln" }));
    await waitFor(() => expect(screen.getByText("overview")).toBeInTheDocument());
  });

  it("saves and switches from the draft guard, and keeps the new row selected", async () => {
    const rows = [makeCommand(), makeCommand({ name: "beta", text: "Antwort B", aliases: [] })];
    const fetcher = panelFetch({ commands: () => rows });
    renderPanel(fetcher);
    await selectCommand("hallo");
    fireEvent.change(screen.getByRole("textbox", { name: "Antworttext" }), { target: { value: "Gespeichert" } });
    fireEvent.click((await screen.findByText("!beta")).closest(".text-command-row") as HTMLElement);
    fireEvent.click(await screen.findByRole("button", { name: "Speichern und wechseln" }));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Antworttext" })).toHaveValue("Antwort B"));
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
    const response = screen.getByRole("textbox", { name: "Antworttext" });
    fireEvent.change(response, { target: { value: "Mein Entwurf" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Speichern" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1));
    expect(await screen.findByText(/Inzwischen von jemand anderem geändert\./u)).toBeInTheDocument();
    expect(response).toHaveValue("Mein Entwurf");
    rows[0] = makeCommand({ text: "Serverstand" });
    fireEvent.click(screen.getByRole("button", { name: "Serverstand laden" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Antworttext" })).toHaveValue("Serverstand"));
  });

  it("keeps a newer selection and its draft when a renamed command's refresh is delayed", async () => {
    let rows = [makeCommand(), makeCommand({ name: "beta", text: "Antwort B", aliases: [] })];
    let holdGet = false;
    let releaseGet: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { releaseGet = resolve; });
    const baseFetch = panelFetch({
      commands: () => rows,
      onMutation: (method, _path, body) => {
        if (method === "PATCH" && typeof body === "object" && body !== null) {
          const { name } = body as { name: string };
          rows = rows.map((row) => row.name === "hallo" ? { ...row, name, revision: 2 } : row);
          holdGet = true;
        }
        return jsonResponse({ warnings: [] });
      },
    });
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (holdGet && url.pathname.endsWith("/commands") && (init?.method ?? "GET") === "GET") await gate;
      return baseFetch(input, init);
    }));
    renderWithQuery(<UiProvider><TextCommandsPanel channelId="kanal-a" language="de" /></UiProvider>, undefined, {
      gcTime: 600_000,
      staleTime: 600_000,
    });

    await selectCommand("hallo");
    fireEvent.change(screen.getByRole("textbox", { name: "Befehlsname" }), { target: { value: "hallo2" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await selectCommand("beta");
    fireEvent.change(screen.getByRole("textbox", { name: "Antworttext" }), { target: { value: "Entwurf B" } });

    releaseGet();
    await within(await commandList()).findByText("!hallo2");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByRole("textbox", { name: "Befehlsname" })).toHaveValue("beta");
    expect(screen.getByRole("textbox", { name: "Antworttext" })).toHaveValue("Entwurf B");
  });

  describe("obsolete editor continuations", () => {
    const setup = (hold: "POST" | "PATCH" | "DELETE" | "GET", onCloseInspector?: () => void) => {
      let rows = [makeCommand(), makeCommand({ name: "beta", text: "Antwort B", aliases: [] }), makeCommand({ name: "gamma", text: "Antwort C", aliases: [] })];
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let holdGets = false;
      const baseFetch = panelFetch({ commands: () => rows });
      vi.stubGlobal("fetch", vi.fn<typeof fetch>(async (input, init) => {
        const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
        const method = init?.method ?? "GET";
        const isCommands = url.pathname.includes("/commands");
        if (isCommands && method === hold && hold !== "GET") await gate;
        if (isCommands && method === "GET" && holdGets) await gate;
        if (isCommands && method === "POST" && typeof init?.body === "string") {
          const { name } = JSON.parse(init.body) as { name: string };
          rows = [...rows, makeCommand({ name, text: "Hallo", aliases: [] })];
          holdGets = hold === "GET";
        }
        if (isCommands && method === "PATCH" && typeof init?.body === "string") {
          const { name } = JSON.parse(init.body) as { name: string };
          rows = rows.map((row) => row.name === "hallo" ? { ...row, name, revision: 2 } : row);
          holdGets = hold === "GET";
        }
        if (isCommands && method === "DELETE") {
          rows = rows.filter((row) => row.name !== url.pathname.split("/").at(-1));
          holdGets = hold === "GET";
        }
        return baseFetch(input, init);
      }));
      renderWithQuery(<UiProvider><TextCommandsPanel channelId="kanal-a" language="de" {...(onCloseInspector === undefined ? {} : { onCloseInspector })} /></UiProvider>, undefined, {
        gcTime: 600_000,
        staleTime: 600_000,
      });
      return release;
    };
    const openCreate = async (name: string): Promise<void> => {
      fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Befehlsname" }), { target: { value: name } });
    };
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

    it("keeps a newer create draft when an earlier create POST is released late", async () => {
      const release = setup("POST");
      await openCreate("eins");
      fireEvent.change(screen.getByRole("textbox", { name: "Antworttext" }), { target: { value: "Hallo" } });
      fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
      fireEvent.click((await within(await commandList()).findByText("!beta")).closest(".text-command-row") as HTMLElement);
      fireEvent.click(await screen.findByRole("button", { name: "Verwerfen und wechseln" }));
      await openCreate("zwei");

      release();
      await within(await commandList()).findByText("!eins");
      await settle();
      expect(screen.getByRole("textbox", { name: "Befehlsname" })).toHaveValue("zwei");
    });

    it("keeps a newer create form when an earlier create's revalidation finishes late", async () => {
      const release = setup("GET");
      await openCreate("eins");
      fireEvent.change(screen.getByRole("textbox", { name: "Antworttext" }), { target: { value: "Hallo" } });
      fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));
      await waitFor(() => expect(screen.getByRole("textbox", { name: "Befehlsname" })).toHaveValue("eins"));
      fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
      fireEvent.change(screen.getByRole("textbox", { name: "Befehlsname" }), { target: { value: "zwei" } });

      release();
      await settle();
      expect(screen.getByRole("textbox", { name: "Befehlsname" })).toHaveValue("zwei");
    });

    it("completes save-and-switch only for the current editor when the refresh is delayed", async () => {
      const release = setup("GET");
      await selectCommand("hallo");
      fireEvent.change(screen.getByRole("textbox", { name: "Befehlsname" }), { target: { value: "hallo2" } });
      fireEvent.click((await within(await commandList()).findByText("!beta")).closest(".text-command-row") as HTMLElement);
      fireEvent.click(await screen.findByRole("button", { name: "Speichern und wechseln" }));
      await waitFor(() => expect(screen.getByRole("textbox", { name: "Befehlsname" })).toHaveValue("beta"));
      await selectCommand("gamma");
      fireEvent.change(screen.getByRole("textbox", { name: "Antworttext" }), { target: { value: "Entwurf C" } });

      release();
      await settle();
      expect(screen.getByRole("textbox", { name: "Befehlsname" })).toHaveValue("gamma");
      expect(screen.getByRole("textbox", { name: "Antworttext" })).toHaveValue("Entwurf C");
    });

    it("does not run a held save-and-switch navigation after the panel unmounted", async () => {
      const onCloseInspector = vi.fn();
      const release = setup("PATCH", onCloseInspector);
      await selectCommand("hallo");
      fireEvent.change(screen.getByRole("textbox", { name: "Antworttext" }), { target: { value: "Entwurf" } });
      fireEvent.keyDown(editor(), { key: "Escape" });
      fireEvent.click(await screen.findByRole("button", { name: "Speichern und wechseln" }));
      await waitFor(() => expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));

      cleanup();
      release();
      await settle();
      expect(onCloseInspector).not.toHaveBeenCalled();
    });

    it("keeps a newly selected command when a deletion's revalidation finishes late", async () => {
      const release = setup("GET");
      await selectCommand("hallo");
      fireEvent.click(screen.getByRole("button", { name: "Weitere Aktionen", hidden: true }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Befehl löschen" }));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "Befehl !hallo löschen" }));
      await waitFor(() => expect(screen.queryByText("!hallo")).not.toBeInTheDocument());
      await selectCommand("beta");
      fireEvent.change(screen.getByRole("textbox", { name: "Antworttext" }), { target: { value: "Entwurf B" } });

      release();
      await settle();
      expect(screen.getByRole("textbox", { name: "Befehlsname" })).toHaveValue("beta");
      expect(screen.getByRole("textbox", { name: "Antworttext" })).toHaveValue("Entwurf B");
    });
  });

  it("keeps the draft and conflict after a failed server reload, then retries against the refreshed revision", async () => {
    let rows = [makeCommand()];
    let failCommandReload = false;
    const submittedRevisions: number[] = [];
    const baseFetch = panelFetch({
      commands: () => rows,
      onMutation: (_method, _path, body) => {
        const revision = typeof body === "object" && body !== null ? (body as { revision?: unknown }).revision : undefined;
        if (typeof revision === "number") submittedRevisions.push(revision);
        return submittedRevisions.length === 1
          ? jsonResponse({ error: "command_changed_concurrently" }, 409)
          : jsonResponse({ warnings: [] });
      },
    });
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/commands") && (init?.method ?? "GET") === "GET" && failCommandReload) {
        return Promise.resolve(jsonResponse({ error: "temporarily_unavailable" }, 503));
      }
      return baseFetch(input, init);
    });
    vi.stubGlobal("fetch", fetcher);

    renderWithQuery(<UiProvider><TextCommandsPanel channelId="kanal-a" language="de" /></UiProvider>, undefined, {
      gcTime: 600_000,
      staleTime: 600_000,
    });
    await selectCommand();
    const response = screen.getByRole("textbox", { name: "Antworttext" });
    fireEvent.change(response, { target: { value: "Mein Entwurf" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(submittedRevisions).toEqual([1]));
    expect(await screen.findByText(/Inzwischen von jemand anderem geändert\./u)).toBeInTheDocument();

    failCommandReload = true;
    fireEvent.click(screen.getByRole("button", { name: "Serverstand laden" }));

    expect(await screen.findByText(/Der Serverstand konnte nicht geladen werden\./u)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Antworttext" })).toHaveValue("Mein Entwurf");
    expect(screen.getByText(/Inzwischen von jemand anderem geändert\./u)).toBeInTheDocument();
    expect(within(editor()).getByRole("button", { name: "Erneut versuchen" })).toBeInTheDocument();

    failCommandReload = false;
    rows = [makeCommand({ text: "Serverstand", revision: 2 })];
    fireEvent.click(within(editor()).getByRole("button", { name: "Erneut versuchen" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Antworttext" })).toHaveValue("Serverstand"));

    fireEvent.change(screen.getByRole("textbox", { name: "Antworttext" }), { target: { value: "Nach erneutem Laden" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(submittedRevisions).toEqual([1, 2]));
  });

  it("maps command_already_exists and both command_alias_conflict fields to field errors", async () => {
    let error: unknown = { error: "command_already_exists" };
    const fetcher = panelFetch({
      onMutation: () => jsonResponse(error, 409),
    });
    renderPanel(fetcher);
    await selectCommand();
    const name = screen.getByRole("textbox", { name: "Befehlsname" });
    const save = screen.getByRole("button", { name: "Speichern" });

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
    expect(document.querySelector(".chips-input__chip[aria-invalid='true']")).not.toBeNull();
  });

  it("focuses the conflicting alias chip's remove button when aliases are at capacity", async () => {
    const aliases = Array.from({ length: 10 }, (_unused, index) => `alias${String(index + 1)}`);
    renderPanel(panelFetch({ commands: () => [makeCommand({ aliases })] }));
    await selectCommand();

    const name = screen.getByRole("textbox", { name: "Befehlsname" });
    fireEvent.change(name, { target: { value: "alias5" } });
    const save = screen.getByRole("button", { name: "Speichern" });
    expect(screen.getByRole("textbox", { name: "Weitere Auslöser" })).toHaveAttribute("readonly");
    fireEvent.click(save);

    expect(screen.getByText("Das ist schon der Name.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Alias !alias5 entfernen" })).toBeEnabled();
  });

  it("shows the amber announcement warning only when moderator status is false", async () => {
    const fetcher = panelFetch();
    renderPanel(fetcher, { botIsModerator: false });
    await selectCommand();
    fireEvent.click(screen.getByRole("button", { name: "Ankündigung" }));
    expect(screen.getByText("Der Bot ist hier kein Moderator — der Text geht als normale Nachricht raus.")).toBeInTheDocument();
    expect(editor().querySelector(".segment-choice-field__warning")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Speichern" })).toBeEnabled();

    cleanup();
    renderPanel(panelFetch(), { botIsModerator: null });
    await selectCommand();
    fireEvent.click(screen.getByRole("button", { name: "Ankündigung" }));
    expect(screen.queryByText("Der Bot ist hier kein Moderator — der Text geht als normale Nachricht raus.")).not.toBeInTheDocument();
  });

  it("converts a leading timeout slash command into structured fields before saving", async () => {
    let created: unknown;
    const commands: TextCommand[] = [];
    const fetcher = panelFetch({
      commands: () => commands,
      onMutation: (method, _path, body) => {
        if (method === "POST" && typeof body === "object" && body !== null) {
          created = body;
          commands.push({ ...makeCommand({ name: "roulette" }), ...(body as Partial<TextCommand>) });
        }
        return jsonResponse({ warnings: [] });
      },
    });
    renderPanel(fetcher, { botIsModerator: false });
    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Befehlsname" }), { target: { value: "roulette" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Antworttext" }), {
      target: { value: "/timeout {user} 30-60 Raid spamming\nTimed out for {timeout.duration}" },
    });
    expect(screen.getByText("Timeout für den Aufrufer für 30–60 s.")).toHaveAttribute("role", "status");
    expect(screen.queryByRole("switch", { name: "Aufrufer timeouten" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Anlegen" }));

    await waitFor(() => expect(created).toMatchObject({ name: "roulette", kind: "timeout" }));
    expect(await screen.findByRole("spinbutton", { name: "Mindestens" })).toHaveValue(30);
    expect(screen.getByRole("spinbutton", { name: "Höchstens" })).toHaveValue(60);
    expect(screen.getByRole("textbox", { name: "Antworttext (optional)" })).toHaveValue("Timed out for {timeout.duration}");
    expect(screen.getByRole("textbox", { name: "Timeout-Grund" })).toHaveValue("Raid spamming");
    expect(screen.getByText("Der Bot ist kein Moderator. Timeouts können nicht ausgeführt werden.")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Erweitert"));
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
    fireEvent.change(screen.getByRole("textbox", { name: "Antworttext" }), { target: { value: "/announce Stream starts now!" } });
    expect(screen.getByText("Wird als Twitch-Ankündigung gesendet.")).toHaveAttribute("role", "status");
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(saved).toMatchObject({ kind: "text", responseType: "announcement", text: "Stream starts now!" }));
    expect(screen.getByRole("textbox", { name: "Antworttext" })).toHaveValue("Stream starts now!");
    expect(screen.getByRole("button", { name: "Ankündigung" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows operator settings as properties and stages the Active switch until save", async () => {
    const fetcher = panelFetch();
    renderPanel(fetcher, { canManage: false, canOperate: true });
    await selectCommand();
    const readonly = editor();
    expect(within(readonly).getByText("Einstellungen ändern nur Broadcaster und Verwalter.")).toBeInTheDocument();
    expect(readonly.querySelector("dl.properties")).toBeInTheDocument();
    expect(within(readonly).getByText("Hallo {user} aus {channel}")).toBeInTheDocument();
    expect(within(readonly).queryAllByRole("textbox")).toHaveLength(0);
    const active = within(readonly).getByRole("switch", { name: "Aktiv" });
    expect(active).toBeEnabled();
    expect(within(readonly).getByRole("button", { name: "Speichern" })).toBeDisabled();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);

    fireEvent.click(active);
    expect(within(readonly).getByRole("button", { name: "Speichern" })).toBeEnabled();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("lets operators save only the enabled flag", async () => {
    const fetcher = panelFetch();
    renderPanel(fetcher, { canManage: false, canOperate: true });
    await selectCommand();
    const readonly = editor();
    expect(readonly.querySelector("dl.properties")).toBeInTheDocument();
    expect(within(readonly).queryAllByRole("textbox")).toHaveLength(0);
    expect(within(readonly).getByRole("switch", { name: "Aktiv" })).toBeEnabled();

    fireEvent.click(within(readonly).getByRole("switch", { name: "Aktiv" }));
    fireEvent.click(within(readonly).getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1));
    const patch = fetcher.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(patch?.[1]?.body).toBe(JSON.stringify({ revision: 1, enabled: false }));
  });

  it("continues deletion after saving a renamed command and targets its new name", async () => {
    let current = makeCommand();
    const fetcher = panelFetch({
      commands: () => [current],
      onMutation: (method, _path, body) => {
        if (method === "PATCH") {
          const fields = body as Partial<TextCommand>;
          current = { ...current, ...fields, name: fields.name ?? current.name, revision: 2 };
          return jsonResponse({ command: current, warnings: [] });
        }
        return jsonResponse({});
      },
    });
    renderPanel(fetcher);
    await selectCommand();
    fireEvent.change(screen.getByRole("textbox", { name: "Befehlsname" }), { target: { value: "renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Weitere Aktionen", hidden: true }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Befehl löschen" }));

    const guard = await screen.findByRole("dialog");
    fireEvent.click(within(guard).getByRole("button", { name: "Speichern und wechseln" }));
    await waitFor(() => expect(guard).not.toBeInTheDocument());
    const deleteDialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(deleteDialog).getByRole("heading")).toHaveTextContent("Befehl !renamed löschen?"));
    fireEvent.click(within(deleteDialog).getByRole("button", { name: "Befehl !renamed löschen" }));

    await waitFor(() => expect(fetcher.mock.calls.some(([input, init]) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      return init?.method === "DELETE" && url.includes("/commands/renamed?revision=2");
    })).toBe(true));
  });

  it("does not classify host variables as module badges or filters", async () => {
    renderPanel(panelFetch({
      commands: () => [makeCommand({ text: "Hello {user}" })],
      templateVariables: [{ name: "user", moduleId: "host", isTextBlock: false, sample: "viewer" }],
    }));
    const row = await screen.findByRole("button", { name: /!hallo/u });

    expect(within(row).getByText("Antworttext")).toBeInTheDocument();
    const moduleFilter = screen.getByRole("combobox", { name: "Verwendet Modul-Variablen" });
    expect(moduleFilter).toBeDisabled();
    expect(screen.queryByRole("option", { name: "host", hidden: true })).not.toBeInTheDocument();
  });

  it("restores focus to the selected command when its details close", async () => {
    const fetcher = panelFetch();
    const onCloseInspector = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    renderWithQuery(<UiProvider><TextCommandsPanel channelId="kanal-a" language="de" onCloseInspector={onCloseInspector} /></UiProvider>);

    const row = await screen.findByRole("button", { name: /!hallo/u });
    expect(within(row).queryByRole("combobox")).not.toBeInTheDocument();

    row.focus();
    fireEvent.click(row);
    await screen.findByRole("region", { name: "Eigenschaften von !hallo" });
    fireEvent.click(document.querySelector(".collection-page__detail-back") as HTMLElement);
    await waitFor(() => expect(row).toHaveFocus());
    expect(onCloseInspector).not.toHaveBeenCalled();

    fireEvent.click(row);
    await screen.findByRole("region", { name: "Eigenschaften von !hallo" });
    fireEvent.keyDown(document.querySelector(".collection-page__detail-back") as HTMLElement, { key: "Escape" });
    await waitFor(() => expect(row).toHaveFocus());
    expect(document.querySelector(".collection-page")).toHaveAttribute("data-detail-open", "false");
    expect(onCloseInspector).not.toHaveBeenCalled();
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
    await selectMinimumTier("moderator");
    fireEvent.click(within(editor()).getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(current).toMatchObject({ minimumTier: "moderator", revision: 2 }));

    const patches = fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.[1]?.body).toEqual(JSON.stringify({
      revision: 1,
      name: "hallo",
      enabled: true,
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
    expect(screen.getByRole("combobox", { name: "Mindestrolle" })).toHaveTextContent("Moderatoren");
    expect(current.minimumTier).toBe("moderator");
  });

  it("deletes through ConfirmDialog", async () => {
    const fetcher = panelFetch();
    renderPanel(fetcher);
    await selectCommand();
    fireEvent.click(screen.getByRole("button", { name: "Weitere Aktionen", hidden: true }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Befehl löschen" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading")).toHaveTextContent("Befehl !hallo löschen?");
    expect(within(dialog).getByText(/Aliase !hey/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Befehl !hallo löschen" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true));
    const deleteCall = fetcher.mock.calls.find(([, init]) => init?.method === "DELETE");
    expect(deleteCall?.[0]).toBe("/api/channels/kanal-a/modules/text_commands/commands/hallo?revision=1");
  });

  it("follows the browser language when the host does not pass one", async () => {
    vi.stubGlobal("fetch", panelFetch());
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    renderWithQuery(<UiProvider><TextCommandsPanel channelId="kanal-a" /></UiProvider>);

    expect(await screen.findByRole("button", { name: "Add command" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Triggers" })).toBeInTheDocument();
  });

  it("preselects the command requested by the command palette after the command list loads", async () => {
    vi.stubGlobal("fetch", panelFetch({ commands: () => [makeCommand({ name: "clip" }), makeCommand()] }));
    renderWithQuery(<UiProvider><TextCommandsPanel channelId="kanal-a" language="de" initialSelection="clip" /></UiProvider>);

    expect(await screen.findByRole("region", { name: "Eigenschaften von !clip" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /!clip/u })).toHaveAttribute("aria-current", "true");
  });

  it("does not fall back to a different command when the requested selection is missing", async () => {
    vi.stubGlobal("fetch", panelFetch({ commands: () => [makeCommand(), makeCommand({ name: "clip" })] }));
    renderWithQuery(<UiProvider><TextCommandsPanel channelId="kanal-a" language="de" initialSelection="wetter" /></UiProvider>);

    const list = await commandList();
    await within(list).findByText("!hallo");

    expect(list.querySelector(".text-command-row[aria-current='true']")).toBeNull();
    expect(screen.queryByRole("region", { name: "Eigenschaften von !hallo" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Eigenschaften von !clip" })).not.toBeInTheDocument();
  });
});
