import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TextbefehlePanel } from "../../src/modules/textbefehle/panel";

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
      if (url.pathname.endsWith("/befehle") && init?.method === undefined) {
        return Promise.resolve(jsonResponse({ befehle: [{
          channelId: "kanal-a",
          name: "hallo",
          text: "Hallo {user}",
          art: "text",
          enabled: true,
          cooldownSekunden: 5,
          zuletztVerwendetAt: new Date(Date.now() - 60_000).toISOString(),
          createdAt: "2026-09-19T12:00:00.000Z",
          updatedAt: "2026-09-19T12:00:00.000Z",
        }] }));
      }
      return Promise.resolve(jsonResponse({ befehl: {} }));
    });
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });

    render(<TextbefehlePanel channelId="kanal-a" />);

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

    render(<TextbefehlePanel channelId="kanal-a" />);

    const add = await screen.findByRole("button", { name: "Befehl anlegen" });
    expect(add).toBeDisabled();
    expect(add).not.toHaveClass("button--primary");
    expect(screen.getByText(/Name und Antworttext ausfüllen/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "hallo" } });
    expect(add).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Antworttext"), { target: { value: "Hallo" } });
    expect(add).toBeEnabled();
    expect(add).toHaveClass("button--primary");
  });

  it.each([
    ["de-DE", "Befehl !hallo löschen", "Befehl !hallo endgültig löschen", "Abbrechen"],
    ["en-US", "Delete !hallo", "Delete !hallo permanently", "Cancel"],
  ])("bestätigt das Löschen erst an Ort und Stelle (%s)", async (browserLanguage, deleteLabel, confirmLabel, cancelLabel) => {
    let exists = true;
    let deleteRequestCount = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/befehle") && init?.method === undefined) {
        return Promise.resolve(jsonResponse({ befehle: exists ? [{
          channelId: "kanal-a",
          name: "hallo",
          text: "Hallo",
          art: "text",
          enabled: true,
          cooldownSekunden: 5,
          zuletztVerwendetAt: null,
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

    render(<TextbefehlePanel channelId="kanal-a" />);

    fireEvent.click(await screen.findByRole("row", { name: /!hallo/ }));
    const deleteButton = await screen.findByRole("button", { name: deleteLabel });
    expect(deleteButton).toHaveClass("button--danger");
    expect(deleteButton).not.toHaveClass("button--quiet");

    fireEvent.click(deleteButton);
    const confirmation = await screen.findByRole("alertdialog");
    expect(confirmation).toHaveTextContent("hallo");
    expect(deleteRequestCount).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: cancelLabel }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(deleteRequestCount).toBe(0);

    fireEvent.click(await screen.findByRole("button", { name: deleteLabel }));
    fireEvent.click(await screen.findByRole("button", { name: confirmLabel }));
    await waitFor(() => expect(deleteRequestCount).toBe(1));
  });

  it("ordnet die drei Feldbreiten nach Inhaltsart zu", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/befehle") && init?.method === undefined) {
        return Promise.resolve(jsonResponse({ befehle: [{
          channelId: "kanal-a",
          name: "hallo",
          text: "Hallo",
          art: "text",
          enabled: true,
          cooldownSekunden: 5,
          zuletztVerwendetAt: null,
          createdAt: "2026-09-19T12:00:00.000Z",
          updatedAt: "2026-09-19T12:00:00.000Z",
        }] }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });

    render(<TextbefehlePanel channelId="kanal-a" />);

    expect(await screen.findByRole("heading", { name: "Befehle" })).toBeInTheDocument();
    expect(screen.getByLabelText("Name").closest("label")).toHaveClass("config-field--mittel");
    expect(screen.getByLabelText("Antworttext").closest("label")).toHaveClass("config-field--breit");
    expect(screen.getAllByRole("spinbutton").map((field) => field.closest("label")?.className)).toEqual(["config-field config-field--schmal"]);

    fireEvent.click(await screen.findByRole("row", { name: /!hallo/ }));
    const editorTextarea = await screen.findByDisplayValue("Hallo");
    const editorField = editorTextarea.closest("label");
    expect(editorField).toHaveClass("config-field--breit");
    expect(screen.getAllByRole("spinbutton").map((field) => field.closest("label")?.className)).toEqual([
      "config-field config-field--schmal",
      "config-field config-field--schmal",
    ]);
  });

  it.each([
    ["de-DE", "Der Textbefehl konnte nicht gelöscht werden."],
    ["en-US", "The text command could not be deleted."],
  ])("zeigt für einen Löschfehler den passenden Text (%s)", async (browserLanguage, expected) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/befehle") && init?.method === undefined) {
        return Promise.resolve(jsonResponse({ befehle: [{
          channelId: "kanal-a",
          name: "hallo",
          text: "Hallo",
          art: "text",
          enabled: true,
          cooldownSekunden: 5,
          zuletztVerwendetAt: null,
          createdAt: "2026-09-19T12:00:00.000Z",
          updatedAt: "2026-09-19T12:00:00.000Z",
        }] }));
      }
      if (init?.method === "DELETE") return Promise.resolve(jsonResponse({ error: "forbidden" }, 403));
      return Promise.resolve(jsonResponse({ token: "csrf" }));
    });
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(window.navigator, "language", { value: browserLanguage, configurable: true });

    render(<TextbefehlePanel channelId="kanal-a" />);

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

    render(<TextbefehlePanel channelId="kanal-a" />);

    expect(await screen.findByRole("heading", { name: "Commands" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add command" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Type" })).toBeInTheDocument();
  });

  it("blendet das Antwortfeld für die Art liste aus und legt ohne Text an", async () => {
    let createdBody: Record<string, unknown> | null = null;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/befehle") && init?.method === undefined) return Promise.resolve(jsonResponse({ befehle: [] }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (init?.method === "POST") {
        createdBody = typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : null;
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });

    render(<TextbefehlePanel channelId="kanal-a" />);

    const art = await screen.findByRole("combobox", { name: "Art" });
    fireEvent.change(art, { target: { value: "liste" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "befehle" } });
    expect(screen.queryByLabelText("Antworttext")).not.toBeInTheDocument();
    const add = screen.getByRole("button", { name: "Befehl anlegen" });
    expect(add).toBeEnabled();
    fireEvent.click(add);
    await waitFor(() => expect(createdBody).toEqual({ name: "befehle", art: "liste", cooldownSekunden: 5 }));
  });

  it("zeigt Bedienern den Schalter offen und Inhaltsaktionen sichtbar, aber gesperrt", async () => {
    let enabled = false;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/befehle") && init?.method === undefined) {
        return Promise.resolve(jsonResponse({ befehle: [{
          channelId: "kanal-a",
          name: "hallo",
          text: "Antwort",
          art: "text",
          enabled,
          cooldownSekunden: 5,
          zuletztVerwendetAt: null,
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

    render(<TextbefehlePanel channelId="kanal-a" canManage={false} />);

    const row = await screen.findByRole("row", { name: /!hallo/ });
    const toggle = await screen.findByRole("switch", { name: "Befehl !hallo: ausgeschaltet" });
    expect(toggle).toBeEnabled();
    expect(within(row).getByRole("combobox", { name: "Mindeststufe für Befehl !hallo" })).toBeDisabled();

    const create = await screen.findByRole("button", { name: "Befehl anlegen" });
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
    let mindeststufe = "alle";
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/befehle") && init?.method === undefined) {
        return Promise.resolve(jsonResponse({ befehle: [{
          channelId: "kanal-a",
          name: "hallo",
          text: "Antwort",
          art: "text",
          enabled: true,
          mindeststufe,
          cooldownSekunden: 5,
          zuletztVerwendetAt: null,
          createdAt: "2026-09-19T12:00:00.000Z",
          updatedAt: "2026-09-19T12:00:00.000Z",
        }] }));
      }
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf" }));
      if (init?.method === "PATCH") {
        const body = typeof init.body === "string" ? JSON.parse(init.body) as { mindeststufe?: string } : {};
        mindeststufe = body.mindeststufe ?? mindeststufe;
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });

    render(<TextbefehlePanel channelId="kanal-a" />);

    const row = await screen.findByRole("row", { name: /!hallo/ });
    expect(screen.getByRole("columnheader", { name: "Mindeststufe" })).toBeInTheDocument();
    const select = within(row).getByRole("combobox", { name: "Mindeststufe für Befehl !hallo" });
    expect(select).toHaveValue("alle");
    fireEvent.change(select, { target: { value: "moderator" } });

    await screen.findByRole("option", { name: "Moderatoren", selected: true });
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH" && init.body === JSON.stringify({ mindeststufe: "moderator" }))).toBe(true);
  });

  it("ordnet Liste und Inspector als direkte Kinder des Befehlsbereichs an", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = input instanceof Request ? new URL(input.url) : new URL(String(input), "https://brobot.example");
      if (url.pathname.endsWith("/befehle") && init?.method === undefined) {
        return Promise.resolve(jsonResponse({ befehle: [{
          channelId: "kanal-a",
          name: "hallo",
          text: "Hallo",
          art: "text",
          enabled: true,
          cooldownSekunden: 5,
          zuletztVerwendetAt: null,
          createdAt: "2026-09-19T12:00:00.000Z",
          updatedAt: "2026-09-19T12:00:00.000Z",
        }] }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal("fetch", fetcher);
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });

    render(<TextbefehlePanel channelId="kanal-a" />);

    const row = await screen.findByRole("row", { name: /!hallo/ });
    fireEvent.click(row);
    const bereich = row.closest(".inspektor-bereich");
    expect(bereich).not.toBeNull();
    expect(bereich?.children).toHaveLength(2);
    expect(bereich?.children[0]).toHaveClass("inspektor-bereich__liste");
    expect(bereich?.children[1]).toHaveClass("sub-inspector");
  });
});
