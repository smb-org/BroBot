import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import ChatVotingPanel from "../../src/modules/chat_voting/panel";
import type { ChatVoteTemplate } from "../../src/modules/chat_voting/contracts";
import { chatVotingSavedPanelTexts } from "../../src/modules/chat_voting/panel/locale-saved";
import { jsonResponse } from "../unit/fixtures";
import { renderWithQuery as render } from "../query-test-utils";

const template: ChatVoteTemplate = {
  id: "template-dinner",
  channelId: "channel-432",
  shortcut: null,
  title: "Abendessen",
  resultText: "Danke fürs Abstimmen! Ergebnis: {vote.result}",
  labels: ["Pizza", "Burger"],
  freeTextMode: null,
  durationSeconds: 120,
  revision: 1,
  legacyAlias: null,
  lastUsedAt: null,
  createdAt: "2026-10-15T10:00:00.000Z",
  updatedAt: "2026-10-15T10:00:00.000Z",
};
const initialWindowWidth = window.innerWidth;
const requestUrl = (input: RequestInfo | URL): URL => {
  if (input instanceof Request) return new URL(input.url);
  if (input instanceof URL) return input;
  return new URL(input, "https://brobot.example");
};

const mount = (options: { templates?: ChatVoteTemplate[]; canManage?: boolean; waitForTemplates?: Promise<Response> } = {}) => {
  const saved: string[] = [];
  let currentTemplates = [...(options.templates ?? [template])];
  const requests = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/channels/channel-432/modules/chat_voting/templates" && method === "GET") {
      return options.waitForTemplates ?? Promise.resolve(jsonResponse({
        templates: currentTemplates,
        count: currentTemplates.length,
        maximum: 100,
      }));
    }
    if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-432" }));
    if (url.pathname === "/api/channels/channel-432/modules/chat_voting/templates" && method === "POST") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : {};
      saved.push(String(body.title));
      const created = { ...template, ...body, id: "template-created", revision: 1 };
      currentTemplates = [created, ...currentTemplates];
      return Promise.resolve(jsonResponse({ template: created }, 201));
    }
    if (url.pathname.startsWith("/api/channels/channel-432/modules/chat_voting/templates/") && method === "PATCH") {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Partial<ChatVoteTemplate> : {};
      const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      const current = currentTemplates.find((entry) => entry.id === id);
      if (current === undefined) return Promise.resolve(jsonResponse({ error: "not_found" }, 404));
      const updated = { ...current, ...body, revision: current.revision + 1, updatedAt: "2026-10-15T10:01:00.000Z" };
      currentTemplates = currentTemplates.map((entry) => entry.id === id ? updated : entry);
      return Promise.resolve(jsonResponse({ template: updated }));
    }
    if (url.pathname.startsWith("/api/channels/channel-432/modules/chat_voting/templates/") && method === "DELETE") {
      const id = decodeURIComponent(url.pathname.split("/").at(-1) ?? "");
      currentTemplates = currentTemplates.filter((entry) => entry.id !== id);
      return Promise.resolve(jsonResponse({ ok: true }));
    }
    return Promise.resolve(jsonResponse({ error: "not_found" }, 404));
  });
  vi.stubGlobal("fetch", requests);
  const view = render(<UiProvider><ChatVotingPanel channelId="channel-432" language="de" canManage={options.canManage ?? true} /></UiProvider>);
  return { ...view, requests, saved };
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(window, "innerWidth", { configurable: true, value: initialWindowWidth });
});

describe("saved chat voting collection", () => {
  it("localizes singular and plural answer counts in German and English", () => {
    expect(chatVotingSavedPanelTexts("de").templateMeta(1, "2 Min")).toBe("1 Antwort · 2 Min");
    expect(chatVotingSavedPanelTexts("de").templateMeta(2, "2 Min")).toBe("2 Antworten · 2 Min");
    expect(chatVotingSavedPanelTexts("en").templateMeta(1, "2 min")).toBe("1 answer · 2 min");
    expect(chatVotingSavedPanelTexts("en").templateMeta(2, "2 min")).toBe("2 answers · 2 min");
    expect(chatVotingSavedPanelTexts("en").previewCountLabel(1)).toBe("1 character");
  });

  it("shows only saved votes and does not load or expose live vote operations", async () => {
    const { requests } = mount();

    expect(await screen.findByRole("link", { name: /Abendessen/u })).toBeInTheDocument();
    expect(requests.mock.calls.some(([input]) => {
      const path = requestUrl(input).pathname;
      return path.includes("/current") || path.includes("/recent");
    })).toBe(false);
    expect(screen.queryByRole("button", { name: /start|beenden|freigeben/iu })).not.toBeInTheDocument();
    expect(screen.getByText("Gespeicherte Abstimmungen")).toBeInTheDocument();
  });

  it("keeps a new vote as a two-minute draft until the explicit save action", async () => {
    const { requests, saved } = mount({ templates: [] });
    expect(await screen.findByText("Noch keine gespeicherten Abstimmungen")).toBeInTheDocument();
    const createButtons = await screen.findAllByRole("button", { name: "Abstimmung anlegen" });
    const createButton = createButtons[0];
    if (createButton === undefined) throw new Error("The create vote button is missing.");
    fireEvent.click(createButton);

    expect(screen.getByRole("spinbutton", { name: "Sekunden" })).toHaveValue(120);
    fireEvent.change(screen.getByRole("textbox", { name: "Frage" }), { target: { value: "Abendessen" } });
    fireEvent.click(screen.getByRole("button", { name: "Antwort hinzufügen" }));
    fireEvent.click(screen.getByRole("button", { name: "Antwort hinzufügen" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Antwort 1" }), { target: { value: "Pizza" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Antwort 2" }), { target: { value: "Burger" } });

    expect(saved).toEqual([]);
    expect(requests.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(saved).toEqual(["Abendessen"]));
  });

  it("preserves a dirty selection when a mobile collection widens", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    const weekend: ChatVoteTemplate = { ...template, id: "template-weekend", title: "Wochenende" };
    mount({ templates: [template, weekend] });

    fireEvent.click(await screen.findByRole("link", { name: /Wochenende/u }));
    const question = await screen.findByRole("textbox", { name: "Frage" });
    fireEvent.change(question, { target: { value: "Geänderte Frage" } });

    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    fireEvent(window, new Event("resize"));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Frage" })).toHaveValue("Geänderte Frage"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("shows saved vote properties without edit controls to operators", async () => {
    mount({ canManage: false });
    expect(await screen.findByRole("link", { name: /Abendessen/u })).toBeInTheDocument();
    const inspector = screen.getByRole("region", { name: "Frage" });
    expect(within(inspector).getByRole("note")).toHaveTextContent("Nur Broadcaster und Verwalter dürfen Abstimmungen bearbeiten.");
    expect(within(inspector).getByText("Pizza, Burger")).toBeInTheDocument();
    expect(within(inspector).getByText("Danke fürs Abstimmen! Ergebnis: {vote.result}")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Frage" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Speichern" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abstimmung anlegen" })).toBeDisabled();
  });

  it("accepts the saved vote edit response after an explicit save", async () => {
    const { requests } = mount();
    const resultText = await screen.findByRole("textbox", { name: "Ergebnistext" });
    expect(resultText).toHaveValue("Danke fürs Abstimmen! Ergebnis: {vote.result}");
    expect(screen.getAllByText("Chat-Vorschau", { exact: true })).toHaveLength(2);

    fireEvent.change(screen.getByRole("textbox", { name: "Frage" }), { target: { value: "Neue Frage" } });
    fireEvent.change(resultText, { target: { value: "Vielen Dank! {vote.result}" } });
    expect(screen.getByText(/Vielen Dank! Pizza: 8/)).toBeInTheDocument();
    expect(requests.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));

    await waitFor(() => expect(requests.mock.calls.some(([input, init]) => {
      const url = requestUrl(input);
      return url.pathname.endsWith("/templates/template-dinner") && init?.method === "PATCH";
    })).toBe(true));
    expect(await screen.findByRole("link", { name: /Neue Frage/u })).toBeInTheDocument();
    const update = requests.mock.calls.find(([input, init]) => {
      const url = requestUrl(input);
      return url.pathname.endsWith("/templates/template-dinner") && init?.method === "PATCH";
    })?.[1]?.body;
    if (typeof update !== "string") throw new Error("The template update body is missing.");
    expect(JSON.parse(update)).toMatchObject({ title: "Neue Frage", resultText: "Vielen Dank! {vote.result}", revision: 1 });
    expect(screen.getByRole("button", { name: "Verwerfen" })).toBeDisabled();
  });

  it("confirms a manager delete and removes the saved vote from the collection", async () => {
    const { requests } = mount();
    fireEvent.click(await screen.findByRole("link", { name: /Abendessen/u }));
    fireEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Abstimmung löschen" }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "„Abendessen“ löschen?" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Abstimmung löschen" }));

    await waitFor(() => expect(requests.mock.calls.some(([input, init]) =>
      requestUrl(input).pathname.endsWith("/templates/template-dinner") && init?.method === "DELETE")).toBe(true));
    await waitFor(() => expect(screen.queryByRole("link", { name: /Abendessen/u })).not.toBeInTheDocument());
  });
});
