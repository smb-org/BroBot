import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { TEXT_COMMAND_MINIMUM_TIERS, type TextCommand } from "../../src/modules/text_commands/contracts";
import { statusForTier, renderCommandText } from "../../src/modules/text_commands/domain";
import { TextCommandsPanel } from "../../src/modules/text_commands/panel";
import { textCommandsTexts } from "../../src/modules/text_commands/panel/locale";

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});
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
  lastUsedAt: null,
  createdAt: "2026-09-19T12:00:00.000Z",
  updatedAt: "2026-09-19T12:00:00.000Z",
  ...overrides,
});

interface FetchOptions {
  commands?: () => TextCommand[];
  onMutation?: (method: string, path: string, body: unknown) => Response | Promise<Response>;
}

const panelFetch = ({ commands = () => [makeCommand()], onMutation = () => jsonResponse({ warnings: [] }) }: FetchOptions = {}): ReturnType<typeof vi.fn<typeof fetch>> =>
  vi.fn<typeof fetch>((input, init) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
    if (url.pathname.endsWith("/commands") && method === "GET") return Promise.resolve(jsonResponse({ commands: commands() }));
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
    expect(editor().querySelector(".ui-field__prefix")).toHaveTextContent("!");
    expect(screen.getByText(renderCommandText("Hallo {user} aus {channel}", { user: "zuschauerin", channel: "beispielkanal" }))).toBeInTheDocument();

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
        name: "hallo",
        kind: "text",
        text: "Hallo {user} aus {channel}",
        minimumTier: "everyone",
        cooldownSeconds: 5,
        aliases: ["hey"],
        userCooldownSeconds: 0,
        streamCondition: "online",
        responseType: "reply",
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
      minimumTier: "everyone",
      cooldownSeconds: 5,
      aliases: [],
      userCooldownSeconds: 0,
      streamCondition: "any",
      responseType: "say",
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
    fireEvent.click(screen.getByRole("radio", { name: "Befehlsliste" }));
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
      responseType: "say",
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
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(3));
    await waitFor(() => expect(save).toBeEnabled());
    expect(await screen.findByText(/!hey ist schon ein Alias von !anderer\./u)).toBeInTheDocument();
    expect(document.querySelector(".ui-tag-input__pill[aria-invalid='true']")).not.toBeNull();
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

  it("shows operators a read-only property list and keeps Active as an immediate action", async () => {
    const fetcher = panelFetch();
    renderPanel(fetcher, { canManage: false });
    await selectCommand();
    const readonly = editor();
    expect(within(readonly).getByText("Nur Broadcaster und Verwalter dürfen Befehle anlegen, bearbeiten oder löschen.")).toBeInTheDocument();
    expect(within(readonly).getByText("!hey")).toBeInTheDocument();
    expect(within(readonly).getAllByText("Antwort")).toHaveLength(2);
    expect(within(readonly).getByText("nur online")).toBeInTheDocument();
    expect(within(readonly).getByText("aus")).toBeInTheDocument();
    expect(within(readonly).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(readonly).queryByRole("button", { name: "Änderungen speichern" })).not.toBeInTheDocument();

    fireEvent.click(within(readonly).getByRole("switch", { name: "Aktiv" }));
    await waitFor(() => {
      const toggle = fetcher.mock.calls.find(([, init]) => init?.method === "PATCH");
      expect(toggle).toBeDefined();
      expect(toggle?.[1]?.body).toBe(JSON.stringify({ enabled: false }));
    });
  });

  it("keeps the row minimum-tier control as an immediate action and restores focus when the editor closes", async () => {
    let minimumTier: TextCommand["minimumTier"] = "everyone";
    const fetcher = panelFetch({
      commands: () => [makeCommand({ minimumTier })],
      onMutation: (method, _path, body) => {
        if (method === "PATCH" && typeof body === "object" && body !== null && "minimumTier" in body && typeof body.minimumTier === "string") {
          minimumTier = body.minimumTier as TextCommand["minimumTier"];
        }
        return jsonResponse({ warnings: [] });
      },
    });
    const onCloseInspector = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><TextCommandsPanel channelId="kanal-a" language="de" onCloseInspector={onCloseInspector} /></UiProvider>);

    const row = await screen.findByRole("row", { name: /!hallo/u });
    const tierSelect = within(row).getByRole("combobox", { name: "Wer darf auslösen: !hallo" });
    fireEvent.click(tierSelect);
    fireEvent.click(await screen.findByRole("option", { name: "Moderatoren", hidden: true }));
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) =>
      init?.method === "PATCH" && init.body === JSON.stringify({ minimumTier: "moderator" }))).toBe(true));

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

  it("deletes through ConfirmDialog", async () => {
    const fetcher = panelFetch();
    renderPanel(fetcher);
    await selectCommand();
    fireEvent.click(screen.getByRole("button", { name: "Befehl löschen" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Aliase !hey/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Befehl !hallo endgültig löschen" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true));
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
