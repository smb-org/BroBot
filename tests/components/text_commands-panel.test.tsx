import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TextCommandsPanel } from "../../src/modules/text_commands/panel";

const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

describe("Textbefehle-Panel-Ansicht", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("listet Befehle und bietet Bearbeiten und Löschen an", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/commands") && init?.method === undefined) {
        return Promise.resolve(jsonResponse({ befehle: [{
          channelId: "kanal-a",
          name: "hallo",
          text: "Hallo {user}",
          kind: "text",
          enabled: true,
          cooldownSeconds: 5,
          lastUsedAt: new Date(Date.now() - 60_000).toISOString(),
          createdAt: "2026-09-19T12:00:00.000Z",
          updatedAt: "2026-09-19T12:00:00.000Z",
        }] }));
      }
      return Promise.resolve(jsonResponse({ befehl: {} }));
    });
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });

    render(<TextCommandsPanel channelId="kanal-a" />);

    expect(await screen.findByText("!hallo")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "!Name" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Art" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Antwort" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Abkühl." })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Zuletzt" })).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Schalter" })).toBeInTheDocument();
    expect(screen.getByRole("row", { name: /!hallo.*vor 1 min/ })).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Hallo {user}")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("row", { name: /!hallo/ }));
    expect(screen.getByDisplayValue("Hallo {user}")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Eigenschaften von !hallo" })).toHaveTextContent("vor 1 min");
    expect(screen.getByRole("button", { name: "Befehl !hallo speichern" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Befehl !hallo löschen" })).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("Hallo {user}"), { target: { value: "Neu {channel}" } });
    fireEvent.click(screen.getByRole("button", { name: "Befehl !hallo speichern" }));
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
  });

  it("hält den Anlege-Knopf bedeckt, bis Pflichtfelder gefüllt sind", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(jsonResponse({ befehle: [] })));
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });

    render(<TextCommandsPanel channelId="kanal-a" />);

    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    const createPanel = await screen.findByRole("region", { name: "Befehl anlegen" });
    const add = within(createPanel).getByRole("button", { name: "Befehl anlegen" });
    expect(add).toBeDisabled();
    expect(add).not.toHaveClass("button--primary");
    expect(screen.getByText(/Name und Antworttext ausfüllen/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "hallo" } });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Antworttext"), { target: { value: "Hallo" } });
    expect(add).toBeEnabled();
    expect(add).toHaveClass("button--primary");
  });

  it("sperrt das Anlegeformular während des Requests", async () => {
    let resolveCreate!: (response: Response) => void;
    const createFinished = new Promise<Response>((resolve) => { resolveCreate = resolve; });
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/commands") && init?.method === undefined) return Promise.resolve(jsonResponse({ befehle: [] }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (init?.method === "POST") return createFinished;
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });

    render(<TextCommandsPanel channelId="kanal-a" />);

    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    const createPanel = await screen.findByRole("region", { name: "Befehl anlegen" });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "hallo" } });
    fireEvent.change(screen.getByLabelText("Antworttext"), { target: { value: "Hallo" } });
    const add = within(createPanel).getByRole("button", { name: "Befehl anlegen" });

    fireEvent.click(add);
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));

    expect(createPanel.querySelector("form")).toHaveAttribute("aria-busy", "true");
    expect(add).toBeDisabled();
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByLabelText("Art")).toBeDisabled();
    expect(screen.getByLabelText("Antworttext")).toBeDisabled();
    expect(screen.getByRole("spinbutton")).toBeDisabled();

    resolveCreate(jsonResponse({}));
    await waitFor(() => expect(createPanel.querySelector("form")).toHaveAttribute("aria-busy", "false"));
    expect(add).toBeDisabled();
  });

  it("setzt beim Wechsel zu einem anderen Befehl die Entwurfswerte neu", async () => {
    const commands = [
      {
        channelId: "kanal-a", name: "alpha", text: "Antwort A", kind: "text" as const, enabled: true,
        cooldownSeconds: 5, lastUsedAt: null, createdAt: "2026-09-19T12:00:00.000Z", updatedAt: "2026-09-19T12:00:00.000Z",
      },
      {
        channelId: "kanal-a", name: "beta", text: "Antwort B", kind: "text" as const, enabled: true,
        cooldownSeconds: 10, lastUsedAt: null, createdAt: "2026-09-19T12:00:00.000Z", updatedAt: "2026-09-19T12:00:00.000Z",
      },
    ];
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ befehle: commands })));
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });

    render(<TextCommandsPanel channelId="kanal-a" />);

    fireEvent.click(await screen.findByRole("row", { name: /!alpha/ }));
    fireEvent.change(await screen.findByDisplayValue("Antwort A"), { target: { value: "Entwurf" } });
    fireEvent.click(screen.getByRole("row", { name: /!beta/ }));

    expect(await screen.findByDisplayValue("Antwort B")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("Entwurf")).not.toBeInTheDocument();
  });

  it.each([
    ["de-DE", "Befehl !hallo löschen", "Befehl !hallo endgültig löschen", "Abbrechen"],
    ["en-US", "Delete !hallo", "Delete !hallo permanently", "Cancel"],
  ])("bestätigt das Löschen erst an Ort und Stelle (%s)", async (browserLanguage, deleteLabel, confirmLabel, cancelLabel) => {
    let exists = true;
    let deleteRequestCount = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/commands") && init?.method === undefined) {
        return Promise.resolve(jsonResponse({ befehle: exists ? [{
          channelId: "kanal-a",
          name: "hallo",
          text: "Hallo",
          kind: "text",
          enabled: true,
          cooldownSeconds: 5,
          lastUsedAt: null,
          createdAt: "2026-09-19T12:00:00.000Z",
          updatedAt: "2026-09-19T12:00:00.000Z",
        }] : [] }));
      }
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (init?.method === "DELETE") {
        deleteRequestCount += 1;
        exists = false;
        return Promise.resolve(jsonResponse({}));
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(window.navigator, "language", { value: browserLanguage, configurable: true });

    render(<TextCommandsPanel channelId="kanal-a" />);

    fireEvent.click(await screen.findByRole("row", { name: /!hallo/ }));
    const deleteButton = await screen.findByRole("button", { name: deleteLabel });
    expect(deleteButton).toHaveClass("button--danger");
    expect(deleteButton).not.toHaveClass("button--quiet");

    fireEvent.click(deleteButton);
    const confirmation = await screen.findByRole("alertdialog");
    expect(confirmation).toHaveTextContent("hallo");
    expect(deleteRequestCount).toBe(0);
    expect(screen.getByRole("button", { name: cancelLabel })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: cancelLabel }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(deleteRequestCount).toBe(0);

    fireEvent.click(await screen.findByRole("button", { name: deleteLabel }));
    fireEvent.click(await screen.findByRole("button", { name: confirmLabel }));
    await waitFor(() => expect(deleteRequestCount).toBe(1));
  });

  it("behält ein geleertes Zahlenfeld leer und speichert es nicht als null", async () => {
    let created = false;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/commands") && init?.method === undefined) return Promise.resolve(jsonResponse({ befehle: [] }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (init?.method === "POST") {
        created = true;
        return Promise.resolve(jsonResponse({}));
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });

    render(<TextCommandsPanel channelId="kanal-a" />);

    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "hallo" } });
    fireEvent.change(screen.getByLabelText("Antworttext"), { target: { value: "Hallo" } });
    const cooldown = screen.getByRole("spinbutton");
    fireEvent.change(cooldown, { target: { value: "" } });

    expect((cooldown as HTMLInputElement).value).toBe("");
    fireEvent.click(within(await screen.findByRole("region", { name: "Befehl anlegen" })).getByRole("button", { name: "Befehl anlegen" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(created).toBe(false);
    expect((cooldown as HTMLInputElement).value).toBe("");
  });

  it("ordnet die drei Feldbreiten nach Inhaltsart zu", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/commands") && init?.method === undefined) {
        return Promise.resolve(jsonResponse({ befehle: [{
          channelId: "kanal-a",
          name: "hallo",
          text: "Hallo",
          kind: "text",
          enabled: true,
          cooldownSeconds: 5,
          lastUsedAt: null,
          createdAt: "2026-09-19T12:00:00.000Z",
          updatedAt: "2026-09-19T12:00:00.000Z",
        }] }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });

    render(<TextCommandsPanel channelId="kanal-a" />);

    expect(await screen.findByRole("heading", { name: "Befehle" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Befehl anlegen" }));
    await screen.findByRole("region", { name: "Befehl anlegen" });
    expect(screen.getByLabelText("Name").closest("label")).toHaveClass("config-field--mittel");
    expect(screen.getByLabelText("Antworttext").closest("label")).toHaveClass("config-field--breit");
    expect(screen.getAllByRole("spinbutton").map((field) => field.closest("label")?.className)).toEqual(["config-field config-field--schmal"]);

    fireEvent.click(await screen.findByRole("row", { name: /!hallo/ }));
    const editorTextarea = await screen.findByDisplayValue("Hallo");
    const editorField = editorTextarea.closest("label");
    expect(editorField).toHaveClass("config-field--breit");
    expect(screen.getAllByRole("spinbutton").map((field) => field.closest("label")?.className)).toEqual([
      "config-field config-field--schmal",
    ]);
  });

  it.each([
    ["de-DE", "Der Textbefehl konnte nicht gelöscht werden."],
    ["en-US", "The text command could not be deleted."],
  ])("zeigt für einen Löschfehler den passenden Text (%s)", async (browserLanguage, expected) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/commands") && init?.method === undefined) {
        return Promise.resolve(jsonResponse({ befehle: [{
          channelId: "kanal-a",
          name: "hallo",
          text: "Hallo",
          kind: "text",
          enabled: true,
          cooldownSeconds: 5,
          lastUsedAt: null,
          createdAt: "2026-09-19T12:00:00.000Z",
          updatedAt: "2026-09-19T12:00:00.000Z",
        }] }));
      }
      if (init?.method === "DELETE") return Promise.resolve(jsonResponse({ error: "forbidden" }, 403));
      return Promise.resolve(jsonResponse({ token: "csrf" }));
    });
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(window.navigator, "language", { value: browserLanguage, configurable: true });

    render(<TextCommandsPanel channelId="kanal-a" />);

    fireEvent.click(await screen.findByRole("row", { name: /!hallo/ }));
    fireEvent.click(await screen.findByRole("button", {
      name: browserLanguage === "de-DE" ? "Befehl !hallo löschen" : "Delete !hallo",
    }));
    fireEvent.click(await screen.findByRole("button", {
      name: browserLanguage === "de-DE" ? "Befehl !hallo endgültig löschen" : "Delete !hallo permanently",
    }));

    expect(await screen.findByRole("alert")).toHaveTextContent(expected);
  });

  it("folgt mit dem Panel der Browsersprache", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(jsonResponse({ befehle: [] })));
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });

    render(<TextCommandsPanel channelId="kanal-a" />);

    expect(await screen.findByRole("heading", { name: "Commands" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add command" }));
    expect(await screen.findByRole("region", { name: "Add command" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Type" })).toBeInTheDocument();
  });

  it("blendet das Antwortfeld für die Art liste aus und legt ohne Text an", async () => {
    let createdBody: Record<string, unknown> | null = null;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/commands") && init?.method === undefined) return Promise.resolve(jsonResponse({ befehle: [] }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (init?.method === "POST") {
        createdBody = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });

    render(<TextCommandsPanel channelId="kanal-a" />);

    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    const createPanel = await screen.findByRole("region", { name: "Befehl anlegen" });
    const art = await screen.findByRole("combobox", { name: "Art" });
    fireEvent.change(art, { target: { value: "list" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "befehle" } });
    expect(screen.queryByLabelText("Antworttext")).not.toBeInTheDocument();
    const add = within(createPanel).getByRole("button", { name: "Befehl anlegen" });
    expect(add).toBeEnabled();
    fireEvent.click(add);
    await waitFor(() => expect(createdBody).toEqual({ name: "befehle", kind: "list", cooldownSeconds: 5 }));
  });

  it("zeigt Bedienern den Schalter offen und Inhaltsaktionen sichtbar, aber gesperrt", async () => {
    let enabled = false;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/commands") && init?.method === undefined) {
        return Promise.resolve(jsonResponse({ befehle: [{
          channelId: "kanal-a",
          name: "hallo",
          text: "Antwort",
          kind: "text",
          enabled,
          cooldownSeconds: 5,
          lastUsedAt: null,
          createdAt: "2026-09-19T12:00:00.000Z",
          updatedAt: "2026-09-19T12:00:00.000Z",
        }] }));
      }
      if (init?.method === "PATCH") {
        const body = typeof init.body === "string" ? JSON.parse(init.body) as { enabled?: boolean } : {};
        enabled = body.enabled ?? enabled;
      }
      return Promise.resolve(jsonResponse({ befehl: {} }));
    });
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });

    render(<TextCommandsPanel channelId="kanal-a" canManage={false} />);

    const row = await screen.findByRole("row", { name: /!hallo/ });
    const toggle = await screen.findByRole("switch", { name: "Befehl !hallo: ausgeschaltet" });
    expect(toggle).toBeEnabled();
    expect(within(row).getByRole("combobox", { name: "Mindeststufe für Befehl !hallo" })).toBeDisabled();

    fireEvent.click(await screen.findByRole("button", { name: "Befehl anlegen" }));
    const createPanel = await screen.findByRole("region", { name: "Befehl anlegen" });
    const create = within(createPanel).getByRole("button", { name: "Befehl anlegen" });
    expect(create).toBeDisabled();
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByLabelText("Art")).toBeDisabled();
    expect(screen.getByLabelText("Antworttext")).toBeDisabled();
    expect(screen.getByRole("spinbutton")).toBeDisabled();

    fireEvent.click(toggle);
    expect(await screen.findByRole("switch", { name: "Befehl !hallo: eingeschaltet" })).toBeEnabled();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH" && init.body === JSON.stringify({ enabled: true }))).toBe(true);

    fireEvent.click(row);
    const editor = await screen.findByRole("region", { name: "Eigenschaften von !hallo" });
    expect(within(editor).getByLabelText("Name")).toBeDisabled();
    expect(within(editor).getByLabelText("Antworttext")).toBeDisabled();
    expect(within(editor).getByLabelText("Abkühlzeit (Sekunden)")).toBeDisabled();
    expect(within(editor).getByRole("button", { name: "Befehl !hallo speichern" })).toBeDisabled();
    expect(within(editor).getByRole("button", { name: "Befehl !hallo löschen" })).toBeDisabled();
    expect(screen.getAllByText("Nur Broadcaster und Verwalter dürfen Befehle anlegen, bearbeiten oder löschen.").length).toBeGreaterThan(0);
  });

  it("zeigt die Mindeststufe als eigene Spalte und ändert sie über den Verwaltungsweg", async () => {
    let minimumTier = "everyone";
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/commands") && init?.method === undefined) {
        return Promise.resolve(jsonResponse({ befehle: [{
          channelId: "kanal-a",
          name: "hallo",
          text: "Antwort",
          kind: "text",
          enabled: true,
          minimumTier: minimumTier,
          cooldownSeconds: 5,
          lastUsedAt: null,
          createdAt: "2026-09-19T12:00:00.000Z",
          updatedAt: "2026-09-19T12:00:00.000Z",
        }] }));
      }
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (init?.method === "PATCH") {
        const body = typeof init.body === "string" ? JSON.parse(init.body) as { minimumTier?: string } : {};
        minimumTier = body.minimumTier ?? minimumTier;
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });

    render(<TextCommandsPanel channelId="kanal-a" />);

    const row = await screen.findByRole("row", { name: /!hallo/ });
    expect(screen.getByRole("columnheader", { name: "Mindeststufe" })).toBeInTheDocument();
    const select = within(row).getByRole("combobox", { name: "Mindeststufe für Befehl !hallo" });
    expect(select).toHaveValue("everyone");
    fireEvent.change(select, { target: { value: "moderator" } });

    await screen.findByRole("option", { name: "Moderatoren", selected: true });
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH" && init.body === JSON.stringify({ minimumTier: "moderator" }))).toBe(true);
  });

  it("ordnet Liste und Inspector als direkte Kinder des Befehlsbereichs an", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/commands") && init?.method === undefined) {
        return Promise.resolve(jsonResponse({ befehle: [{
          channelId: "kanal-a",
          name: "hallo",
          text: "Hallo",
          kind: "text",
          enabled: true,
          cooldownSeconds: 5,
          lastUsedAt: null,
          createdAt: "2026-09-19T12:00:00.000Z",
          updatedAt: "2026-09-19T12:00:00.000Z",
        }] }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });

    render(<TextCommandsPanel channelId="kanal-a" />);

    const row = await screen.findByRole("row", { name: /!hallo/ });
    fireEvent.click(row);
    const bereich = row.closest(".inspektor-bereich");
    expect(bereich).not.toBeNull();
    expect(bereich?.children).toHaveLength(2);
    expect(bereich?.children[0]).toHaveClass("inspektor-bereich__liste");
    expect(bereich?.children[1]).toHaveClass("sub-inspector");
  });

  it("schließt den Befehls-Inspector per Taste und Escape mit Fokus auf der Zeile", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/commands") && init?.method === undefined) {
        return Promise.resolve(jsonResponse({ befehle: [{
          channelId: "kanal-a",
          name: "hallo",
          text: "Hallo",
          kind: "text",
          enabled: true,
          cooldownSeconds: 5,
          lastUsedAt: null,
          createdAt: "2026-09-19T12:00:00.000Z",
          updatedAt: "2026-09-19T12:00:00.000Z",
        }] }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    const onCloseInspector = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });

    render(<TextCommandsPanel channelId="kanal-a" onCloseInspector={onCloseInspector} />);

    const row = await screen.findByRole("row", { name: /!hallo/ });
    row.focus();
    fireEvent.click(row);
    expect(row).toHaveFocus();
    await screen.findByRole("region", { name: "Eigenschaften von !hallo" });
    const closeButton = screen.getByRole("button", { name: "Schließen" });
    closeButton.focus();
    fireEvent.click(closeButton);
    expect(screen.queryByRole("region", { name: "Eigenschaften von !hallo" })).not.toBeInTheDocument();
    expect(row).toHaveAttribute("aria-selected", "false");
    expect(row).toHaveFocus();
    expect(onCloseInspector).toHaveBeenCalledOnce();

    fireEvent.click(row);
    const reopenedInspector = await screen.findByRole("region", { name: "Eigenschaften von !hallo" });
    expect(reopenedInspector).toBeInTheDocument();
    expect(row).toHaveFocus();
    const reopenedCloseButton = within(reopenedInspector).getByRole("button", { name: "Schließen" });
    reopenedCloseButton.focus();
    fireEvent.keyDown(reopenedCloseButton, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Eigenschaften von !hallo" })).not.toBeInTheDocument();
    expect(row).toHaveFocus();
    expect(onCloseInspector).toHaveBeenCalledTimes(2);
  });

  it("öffnet das Anlegen in der Inspektorspalte und wechselt ohne Doppelbelegung", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/commands") && init?.method === undefined) {
        return Promise.resolve(jsonResponse({ befehle: [{
          channelId: "kanal-a",
          name: "hallo",
          text: "Hallo",
          kind: "text",
          enabled: true,
          cooldownSeconds: 5,
          lastUsedAt: null,
          createdAt: "2026-09-19T12:00:00.000Z",
          updatedAt: "2026-09-19T12:00:00.000Z",
        }] }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });

    render(<TextCommandsPanel channelId="kanal-a" />);

    const list = await screen.findByRole("region", { name: "Befehle" });
    const bereich = list.parentElement?.parentElement;
    expect(bereich).not.toBeNull();
    expect(bereich?.children).toHaveLength(1);
    const plus = within(list).getByRole("button", { name: "Befehl anlegen" });
    fireEvent.click(plus);
    await screen.findByRole("region", { name: "Befehl anlegen" });
    expect(bereich?.children).toHaveLength(2);

    const row = await screen.findByRole("row", { name: /!hallo/ });
    fireEvent.click(row);
    expect(screen.queryByRole("region", { name: "Befehl anlegen" })).not.toBeInTheDocument();
    expect(await screen.findByRole("region", { name: "Eigenschaften von !hallo" })).toBeInTheDocument();

    fireEvent.click(plus);
    expect(screen.queryByRole("region", { name: "Eigenschaften von !hallo" })).not.toBeInTheDocument();
    const reopenedCreatePanel = await screen.findByRole("region", { name: "Befehl anlegen" });
    expect(row).toHaveAttribute("aria-selected", "false");

    fireEvent.click(within(reopenedCreatePanel).getByRole("button", { name: "Schließen" }));
    expect(screen.queryByRole("region", { name: "Befehl anlegen" })).not.toBeInTheDocument();
    expect(plus).toHaveFocus();

    fireEvent.click(plus);
    const escapedCreatePanel = await screen.findByRole("region", { name: "Befehl anlegen" });
    fireEvent.keyDown(escapedCreatePanel, { key: "Escape" });
    expect(screen.queryByRole("region", { name: "Befehl anlegen" })).not.toBeInTheDocument();
    expect(plus).toHaveFocus();
  });

  it("reicht den Schließen-Weg des Modul-Contracts an den Host weiter", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/commands") && init?.method === undefined) {
        return Promise.resolve(jsonResponse({ befehle: [{
          channelId: "kanal-a",
          name: "hallo",
          text: "Hallo",
          kind: "text",
          enabled: true,
          cooldownSeconds: 5,
          lastUsedAt: null,
          createdAt: "2026-09-19T12:00:00.000Z",
          updatedAt: "2026-09-19T12:00:00.000Z",
        }] }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    const onCloseInspector = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });

    render(<TextCommandsPanel channelId="kanal-a" onCloseInspector={onCloseInspector} />);

    fireEvent.click(await screen.findByRole("row", { name: /!hallo/ }));
    fireEvent.keyDown(await screen.findByRole("region", { name: "Eigenschaften von !hallo" }), { key: "Escape" });

    expect(onCloseInspector).toHaveBeenCalledOnce();
  });
});
