import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { UiProvider } from "../../src/dashboard/ui";
import { moduleQueryKey } from "../../src/dashboard/data";
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
  answerColors: ["#5b8cff", "#ff9f43"],
  offerInCockpit: true,
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

const mount = (options: {
  templates?: ChatVoteTemplate[];
  canManage?: boolean;
  waitForTemplates?: Promise<Response>;
  waitForReloadTemplates?: Promise<Response>;
  onReloadStarted?: () => void;
  templateResponses?: ChatVoteTemplate[][];
  patchResponse?: (updated: ChatVoteTemplate) => Promise<Response>;
  templateVariables?: unknown[];
} = {}) => {
  const saved: string[] = [];
  let currentTemplates = [...(options.templates ?? [template])];
  let templateRead = 0;
  const requests = vi.fn<typeof fetch>((input, init) => {
    const url = requestUrl(input);
    const method = init?.method ?? "GET";
    if (url.pathname === "/api/channels/channel-432/modules/chat_voting/templates" && method === "GET") {
      const readIndex = templateRead;
      templateRead += 1;
      if (readIndex === 2 && options.waitForReloadTemplates !== undefined) {
        options.onReloadStarted?.();
        return options.waitForReloadTemplates;
      }
      const responseTemplates = options.templateResponses?.[readIndex] ?? currentTemplates;
      return options.waitForTemplates ?? Promise.resolve(jsonResponse({
        templates: responseTemplates,
        count: responseTemplates.length,
        maximum: 100,
      }));
    }
    if (url.pathname === "/api/channels/channel-432/template-variables" && method === "GET") {
      return Promise.resolve(jsonResponse({ variables: options.templateVariables ?? [] }));
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
      const response = options.patchResponse?.(updated) ?? Promise.resolve(jsonResponse({ template: updated }));
      return response.then((result) => {
        if (result.ok) currentTemplates = currentTemplates.map((entry) => entry.id === id ? updated : entry);
        return result;
      });
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
    expect(screen.getByText("Im Cockpit")).toBeInTheDocument();
  });

  it("edits answer colors, shows duplicate and contrast feedback, previews the colors, and restores defaults", async () => {
    const chatOnly = { ...template, id: "template-chat-only", title: "Nur Chat", shortcut: "nurchat", offerInCockpit: false };
    const { requests } = mount({ templates: [template, chatOnly] });
    expect(await screen.findByRole("link", { name: /Nur Chat/u })).toBeInTheDocument();
    expect(screen.getByText("Nur Chat", { selector: ".chat-voting-template-list__offer" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("link", { name: /Abendessen/u }));
    const trigger = await screen.findByRole("button", { name: "Farbe für Antwort 1" });
    fireEvent.click(trigger);
    const popover = await screen.findByRole("dialog", { name: "Farbe für Antwort 1" });
    const hex = within(popover).getByRole("textbox", { name: "Eigener Hex-Wert" });

    fireEvent.change(hex, { target: { value: "#ff9f43" } });
    expect(within(popover).getByText("Jede Antwort braucht eine eigene Farbe.")).toBeInTheDocument();
    fireEvent.change(hex, { target: { value: "#1c222b" } });
    expect(within(popover).getByText("Mindestens 3:1 Kontrast im Cockpit und auf Overlay-Balken.")).toBeInTheDocument();

    const preview = screen.getByTestId("chat-vote-color-preview");
    expect(preview).toHaveTextContent("Farben · Vorschau");
    fireEvent.click(screen.getByRole("button", { name: "Standard wiederherstellen" }));
    expect((preview.querySelector(".chat-voting-editor__color-preview-track > span") as HTMLElement).style.backgroundColor).toBe("rgb(91, 140, 255)");
    fireEvent.click(trigger);
    fireEvent.click(within(screen.getByRole("dialog", { name: "Farbe für Antwort 1" })).getByRole("button", { name: "#ff6fae" }));
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(requests.mock.calls.some(([input, init]) => requestUrl(input).pathname.endsWith("/templates/template-dinner") && init?.method === "PATCH")).toBe(true));
    const savedBody = requests.mock.calls.find(([input, init]) => requestUrl(input).pathname.endsWith("/templates/template-dinner") && init?.method === "PATCH")?.[1]?.body;
    expect(JSON.parse(savedBody as string)).toMatchObject({ answerColors: ["#ff6fae", "#ff9f43"], offerInCockpit: true });
  });

  it("adds a removed answer with an unused default color while preserving the remaining assignments", async () => {
    const threeAnswers: ChatVoteTemplate = {
      ...template,
      title: "Three answers",
      labels: ["Pizza", "Burger", "Kebab"],
      answerColors: ["#5b8cff", "#ff9f43", "#2ed3a3"],
    };
    mount({ templates: [threeAnswers] });
    fireEvent.click(await screen.findByRole("link", { name: /Three answers/u }));

    fireEvent.click(screen.getByRole("button", { name: "Antwort 1 entfernen" }));
    fireEvent.click(screen.getByRole("button", { name: "Antwort hinzufügen" }));

    expect(screen.getByRole("button", { name: "Farbe für Antwort 1" }).style.backgroundColor).toBe("rgb(255, 159, 67)");
    expect(screen.getByRole("button", { name: "Farbe für Antwort 2" }).style.backgroundColor).toBe("rgb(46, 211, 163)");
    expect(screen.getByRole("button", { name: "Farbe für Antwort 3" }).style.backgroundColor).toBe("rgb(91, 140, 255)");
  });

  it("shows and highlights the missing shortcut or cockpit offer beside its switch", async () => {
    mount();
    fireEvent.click(await screen.findByRole("link", { name: /Abendessen/u }));
    const cockpitSwitch = await screen.findByRole("switch", { name: "Im Cockpit anbieten" });

    fireEvent.click(cockpitSwitch);

    expect(cockpitSwitch.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("Kürzel festlegen oder im Cockpit anbieten.").textContent).toBe("Kürzel festlegen oder im Cockpit anbieten.");
  });

  it("keeps the localized contrast feedback concise and complete", async () => {
    mount();
    fireEvent.click(await screen.findByRole("link", { name: /Abendessen/u }));
    fireEvent.click(await screen.findByRole("button", { name: "Farbe für Antwort 1" }));
    const popover = await screen.findByRole("dialog", { name: "Farbe für Antwort 1" });
    fireEvent.change(within(popover).getByRole("textbox", { name: "Eigener Hex-Wert" }), { target: { value: "#1c222b" } });

    expect(popover.querySelector(".chat-voting-editor__color-feedback")?.textContent)
      .toBe("Mindestens 3:1 Kontrast im Cockpit und auf Overlay-Balken.");
  });

  it("tracks and discards an unfinished custom color from a clean saved template", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    const secondTemplate = { ...template, id: "template-weekend", title: "Wochenende" };
    const { requests } = mount({ templates: [template, secondTemplate] });
    fireEvent.click(await screen.findByRole("link", { name: /Abendessen/u }));

    const save = screen.getByRole("button", { name: "Speichern" });
    const discard = screen.getByRole("button", { name: "Verwerfen" });
    expect(screen.getByText("Gespeichert")).toBeInTheDocument();
    expect(save).toBeDisabled();
    expect(discard).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Farbe für Antwort 1" }));
    const popover = await screen.findByRole("dialog", { name: "Farbe für Antwort 1" });
    const hex = within(popover).getByRole("textbox", { name: "Eigener Hex-Wert" });
    fireEvent.change(hex, { target: { value: "#abc" } });

    expect(within(popover).getByText("Hex-Farbe im Format #5b8cff eingeben.")).toBeInTheDocument();
    expect(screen.getByText("Änderungen ausstehend")).toBeInTheDocument();
    expect(save).toBeDisabled();
    expect(discard).toBeEnabled();
    fireEvent.click(save);
    expect(requests.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Farbe für Antwort 1" }));
    fireEvent.click(screen.getByRole("link", { name: /Wochenende/u }));
    const guard = await screen.findByRole("dialog", { name: "Änderungen verwerfen?" });
    fireEvent.click(within(guard).getByRole("button", { name: "Weiter bearbeiten" }));
    fireEvent.click(screen.getByRole("button", { name: "Farbe für Antwort 1" }));
    const reopenedPopover = await screen.findByRole("dialog", { name: "Farbe für Antwort 1" });
    expect(within(reopenedPopover).getByRole("textbox", { name: "Eigener Hex-Wert" })).toHaveValue("#abc");

    fireEvent.click(discard);
    expect(within(reopenedPopover).getByRole("textbox", { name: "Eigener Hex-Wert" })).toHaveValue("#5b8cff");
    expect(screen.getByText("Gespeichert")).toBeInTheDocument();
    expect(save).toBeDisabled();
    expect(discard).toBeDisabled();
  });

  it("preserves a newer unfinished hex edit when an earlier save completes", async () => {
    let markSaveStarted: (() => void) | undefined;
    const saveStarted = new Promise<void>((resolve) => { markSaveStarted = resolve; });
    let finishSave: ((response: Response) => void) | undefined;
    const pendingResponse = new Promise<Response>((resolve) => { finishSave = resolve; });
    mount({
      patchResponse: () => {
        markSaveStarted?.();
        return pendingResponse;
      },
    });
    fireEvent.change(await screen.findByRole("textbox", { name: "Frage" }), { target: { value: "Neue Frage" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await saveStarted;

    fireEvent.click(screen.getByRole("button", { name: "Farbe für Antwort 1" }));
    const popover = await screen.findByRole("dialog", { name: "Farbe für Antwort 1" });
    fireEvent.change(within(popover).getByRole("textbox", { name: "Eigener Hex-Wert" }), { target: { value: "#abc" } });
    const completeSave = finishSave;
    if (completeSave === undefined) throw new Error("The pending template save is missing.");
    await act(async () => {
      await Promise.resolve().then(() => completeSave(jsonResponse({ template: { ...template, title: "Neue Frage", revision: 2 } })));
    });

    expect(within(popover).getByRole("textbox", { name: "Eigener Hex-Wert" })).toHaveValue("#abc");
    expect(screen.getByText("Änderungen ausstehend")).toBeInTheDocument();
    expect(screen.queryByText("Gespeichert")).not.toBeInTheDocument();
  });

  it("clears raw color edits when accepting the reloaded server version after a conflict", async () => {
    const serverTemplate = { ...template, answerColors: ["#2ed3a3", "#ff9f43"], revision: 2 };
    mount({
      templateResponses: [[template], [serverTemplate], [serverTemplate], [serverTemplate]],
      patchResponse: () => Promise.resolve(jsonResponse({ error: "chat_vote_template_conflict" }, 409)),
    });
    fireEvent.change(await screen.findByRole("textbox", { name: "Frage" }), { target: { value: "Lokale Frage" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await screen.findByRole("button", { name: "Neu laden" });

    fireEvent.click(screen.getByRole("button", { name: "Farbe für Antwort 1" }));
    const popover = await screen.findByRole("dialog", { name: "Farbe für Antwort 1" });
    fireEvent.change(within(popover).getByRole("textbox", { name: "Eigener Hex-Wert" }), { target: { value: "#ffffff" } });
    fireEvent.click(screen.getByRole("button", { name: "Neu laden" }));

    const trigger = screen.getByRole("button", { name: "Farbe für Antwort 1" });
    await waitFor(() => expect(trigger.style.backgroundColor).toBe("rgb(46, 211, 163)"));
    expect(screen.getByTestId("chat-vote-color-preview").querySelector(".chat-voting-editor__color-preview-track > span") as HTMLElement).toHaveStyle({ backgroundColor: "rgb(46, 211, 163)" });
    if (screen.queryByRole("dialog", { name: "Farbe für Antwort 1" }) === null) fireEvent.click(trigger);
    const reloadedPopover = await screen.findByRole("dialog", { name: "Farbe für Antwort 1" });
    expect(within(reloadedPopover).getByRole("textbox", { name: "Eigener Hex-Wert" })).toHaveValue("#2ed3a3");
    expect(screen.getByRole("button", { name: "Speichern" })).toBeDisabled();
  });

  it("keeps an answer hex draft through another answer edit and removal", async () => {
    mount();

    fireEvent.click(await screen.findByRole("button", { name: "Farbe für Antwort 2" }));
    let popover = await screen.findByRole("dialog", { name: "Farbe für Antwort 2" });
    const hexInput = within(popover).getByRole("textbox", { name: "Eigener Hex-Wert" });
    fireEvent.change(hexInput, { target: { value: "#abc" } });

    fireEvent.change(screen.getByRole("textbox", { name: "Antwort 1" }), { target: { value: "Salat" } });
    expect(within(popover).getByRole("textbox", { name: "Eigener Hex-Wert" })).toHaveValue("#abc");

    fireEvent.click(screen.getByRole("button", { name: "Farbe für Antwort 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Antwort 1 entfernen" }));
    fireEvent.click(screen.getByRole("button", { name: "Farbe für Antwort 1" }));
    popover = await screen.findByRole("dialog", { name: "Farbe für Antwort 1" });
    expect(within(popover).getByRole("textbox", { name: "Eigener Hex-Wert" })).toHaveValue("#abc");

    fireEvent.click(screen.getByRole("button", { name: "Verwerfen" }));
    expect(screen.getByRole("textbox", { name: "Antwort 1" })).toHaveValue("Pizza");
    expect(screen.getByRole("textbox", { name: "Antwort 2" })).toHaveValue("Burger");
  });

  it("keeps a newer answer hex edit when a conflict reload finishes", async () => {
    let markReloadStarted: (() => void) | undefined;
    const reloadStarted = new Promise<void>((resolve) => { markReloadStarted = resolve; });
    let finishReload: ((response: Response) => void) | undefined;
    const reloadResponse = new Promise<Response>((resolve) => { finishReload = resolve; });
    const serverTemplate = { ...template, title: "Server question", answerColors: ["#2ed3a3", "#ff9f43"], revision: 2 };
    mount({
      waitForReloadTemplates: reloadResponse,
      onReloadStarted: () => { markReloadStarted?.(); },
      patchResponse: () => Promise.resolve(jsonResponse({ error: "chat_vote_template_conflict" }, 409)),
    });

    fireEvent.change(await screen.findByRole("textbox", { name: "Frage" }), { target: { value: "Local question" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    fireEvent.click(await screen.findByRole("button", { name: "Neu laden" }));
    await reloadStarted;

    fireEvent.click(screen.getByRole("button", { name: "Farbe für Antwort 1" }));
    const popover = await screen.findByRole("dialog", { name: "Farbe für Antwort 1" });
    const hexInput = within(popover).getByRole("textbox", { name: "Eigener Hex-Wert" });
    fireEvent.change(hexInput, { target: { value: "#abcdef" } });
    const completeReload = finishReload;
    if (completeReload === undefined) throw new Error("The pending template reload is missing.");
    act(() => { completeReload(jsonResponse({ templates: [serverTemplate], count: 1, maximum: 100 })); });

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Frage" })).toHaveValue("Server question"));
    expect(within(popover).getByRole("textbox", { name: "Eigener Hex-Wert" })).toHaveValue("#abcdef");
    expect(screen.getByTestId("chat-vote-color-preview").querySelector(".chat-voting-editor__color-preview-track > span")).toHaveStyle({ backgroundColor: "rgb(171, 205, 239)" });
  });

  it("keeps a renamed answer's color draft with its original server answer when a new answer has the local name", async () => {
    let markReloadStarted: (() => void) | undefined;
    const reloadStarted = new Promise<void>((resolve) => { markReloadStarted = resolve; });
    let finishReload: ((response: Response) => void) | undefined;
    const reloadResponse = new Promise<Response>((resolve) => { finishReload = resolve; });
    const serverTemplate = {
      ...template,
      labels: ["Pizza", "Burger", "Pasta"],
      answerColors: ["#5b8cff", "#ff9f43", "#2ed3a3"],
      revision: 2,
    };
    mount({
      templateResponses: [[template], [serverTemplate], [serverTemplate]],
      waitForReloadTemplates: reloadResponse,
      onReloadStarted: () => { markReloadStarted?.(); },
      patchResponse: () => Promise.resolve(jsonResponse({ error: "chat_vote_template_conflict" }, 409)),
    });

    fireEvent.change(await screen.findByRole("textbox", { name: "Antwort 1" }), { target: { value: "Pasta" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    fireEvent.click(await screen.findByRole("button", { name: "Neu laden" }));
    await reloadStarted;

    fireEvent.click(screen.getByRole("button", { name: "Farbe für Antwort 1" }));
    const popover = await screen.findByRole("dialog", { name: "Farbe für Antwort 1" });
    fireEvent.change(within(popover).getByRole("textbox", { name: "Eigener Hex-Wert" }), { target: { value: "#abcdef" } });
    const completeReload = finishReload;
    if (completeReload === undefined) throw new Error("The pending template reload is missing.");
    act(() => { completeReload(jsonResponse({ templates: [serverTemplate], count: 1, maximum: 100 })); });

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Antwort 1" })).toHaveValue("Pizza"));
    const previewTracks = screen.getByTestId("chat-vote-color-preview").querySelectorAll(".chat-voting-editor__color-preview-track > span");
    expect(previewTracks[0]).toHaveStyle({ backgroundColor: "rgb(171, 205, 239)" });
    expect(previewTracks[2]).toHaveStyle({ backgroundColor: "rgb(46, 211, 163)" });
  });

  it("does not attach a color draft to another answer when the server removes an answer", async () => {
    let markReloadStarted: (() => void) | undefined;
    const reloadStarted = new Promise<void>((resolve) => { markReloadStarted = resolve; });
    let finishReload: ((response: Response) => void) | undefined;
    const reloadResponse = new Promise<Response>((resolve) => { finishReload = resolve; });
    const serverTemplate = { ...template, title: "Server question", labels: ["Burger"], answerColors: ["#2ed3a3"], revision: 2 };
    mount({
      waitForReloadTemplates: reloadResponse,
      onReloadStarted: () => { markReloadStarted?.(); },
      patchResponse: () => Promise.resolve(jsonResponse({ error: "chat_vote_template_conflict" }, 409)),
    });

    fireEvent.change(await screen.findByRole("textbox", { name: "Frage" }), { target: { value: "Local question" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    fireEvent.click(await screen.findByRole("button", { name: "Neu laden" }));
    await reloadStarted;

    fireEvent.click(screen.getByRole("button", { name: "Farbe für Antwort 1" }));
    const popover = await screen.findByRole("dialog", { name: "Farbe für Antwort 1" });
    fireEvent.change(within(popover).getByRole("textbox", { name: "Eigener Hex-Wert" }), { target: { value: "#abcdef" } });
    const completeReload = finishReload;
    if (completeReload === undefined) throw new Error("The pending template reload is missing.");
    act(() => { completeReload(jsonResponse({ templates: [serverTemplate], count: 1, maximum: 100 })); });

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Antwort 1" })).toHaveValue("Burger"));
    const colorTrigger = screen.getByRole("button", { name: "Farbe für Antwort 1" });
    expect(colorTrigger).toHaveStyle({ backgroundColor: "rgb(46, 211, 163)" });
    if (screen.queryByRole("dialog", { name: "Farbe für Antwort 1" }) === null) fireEvent.click(colorTrigger);
    expect(within(screen.getByRole("dialog", { name: "Farbe für Antwort 1" })).getByRole("textbox", { name: "Eigener Hex-Wert" })).toHaveValue("#2ed3a3");
  });

  it("drops a color draft when a reload resolves a locally hidden duplicate label", async () => {
    let markReloadStarted: (() => void) | undefined;
    const reloadStarted = new Promise<void>((resolve) => { markReloadStarted = resolve; });
    let finishReload: ((response: Response) => void) | undefined;
    const reloadResponse = new Promise<Response>((resolve) => { finishReload = resolve; });
    const duplicateTemplate = { ...template, labels: ["Same", "Same"], answerColors: ["#5b8cff", "#ff9f43"] };
    const serverTemplate = { ...duplicateTemplate, labels: ["Same"], answerColors: ["#2ed3a3"], revision: 2 };
    mount({
      templates: [duplicateTemplate],
      templateResponses: [[duplicateTemplate], [serverTemplate], [serverTemplate]],
      waitForReloadTemplates: reloadResponse,
      onReloadStarted: () => { markReloadStarted?.(); },
      patchResponse: () => Promise.resolve(jsonResponse({ error: "chat_vote_template_conflict" }, 409)),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Antwort 1 entfernen" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Frage" }), { target: { value: "Local question" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    fireEvent.click(await screen.findByRole("button", { name: "Neu laden" }));
    await reloadStarted;

    fireEvent.click(await screen.findByRole("button", { name: "Farbe für Antwort 1" }));
    const popover = await screen.findByRole("dialog", { name: "Farbe für Antwort 1" });
    fireEvent.change(within(popover).getByRole("textbox", { name: "Eigener Hex-Wert" }), { target: { value: "#abcdef" } });
    const completeReload = finishReload;
    if (completeReload === undefined) throw new Error("The pending template reload is missing.");
    act(() => { completeReload(jsonResponse({ templates: [serverTemplate], count: 1, maximum: 100 })); });

    await waitFor(() => expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Frage" }).value).toBe("Abendessen"));
    const colorTrigger = screen.getByRole("button", { name: "Farbe für Antwort 1" });
    expect(colorTrigger.style.backgroundColor).toBe("rgb(46, 211, 163)");
    if (screen.queryByRole("dialog", { name: "Farbe für Antwort 1" }) === null) fireEvent.click(colorTrigger);
    expect(within(screen.getByRole("dialog", { name: "Farbe für Antwort 1" })).getByRole<HTMLInputElement>("textbox", { name: "Eigener Hex-Wert" }).value).toBe("#2ed3a3");
  });

  it("preserves a color draft re-edited to its original value during a conflict reload", async () => {
    let markReloadStarted: (() => void) | undefined;
    const reloadStarted = new Promise<void>((resolve) => { markReloadStarted = resolve; });
    let finishReload: ((response: Response) => void) | undefined;
    const reloadResponse = new Promise<Response>((resolve) => { finishReload = resolve; });
    const serverTemplate = { ...template, title: "Server question", answerColors: ["#2ed3a3", "#ff9f43"], revision: 2 };
    mount({
      waitForReloadTemplates: reloadResponse,
      onReloadStarted: () => { markReloadStarted?.(); },
      patchResponse: () => Promise.resolve(jsonResponse({ error: "chat_vote_template_conflict" }, 409)),
    });

    fireEvent.change(await screen.findByRole("textbox", { name: "Frage" }), { target: { value: "Local question" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await screen.findByRole("button", { name: "Neu laden" });
    fireEvent.click(screen.getByRole("button", { name: "Farbe für Antwort 1" }));
    const popover = await screen.findByRole("dialog", { name: "Farbe für Antwort 1" });
    const hexInput = within(popover).getByRole("textbox", { name: "Eigener Hex-Wert" });
    fireEvent.change(hexInput, { target: { value: "#abcdef" } });
    fireEvent.click(screen.getByRole("button", { name: "Neu laden" }));
    await reloadStarted;

    fireEvent.click(screen.getByRole("button", { name: "Farbe für Antwort 1" }));
    const pendingPopover = await screen.findByRole("dialog", { name: "Farbe für Antwort 1" });
    const pendingHexInput = within(pendingPopover).getByRole("textbox", { name: "Eigener Hex-Wert" });
    fireEvent.change(pendingHexInput, { target: { value: "#abcde" } });
    fireEvent.change(pendingHexInput, { target: { value: "#abcdef" } });
    const completeReload = finishReload;
    if (completeReload === undefined) throw new Error("The pending template reload is missing.");
    act(() => { completeReload(jsonResponse({ templates: [serverTemplate], count: 1, maximum: 100 })); });

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Frage" })).toHaveValue("Server question"));
    expect(within(screen.getByRole("dialog", { name: "Farbe für Antwort 1" })).getByRole("textbox", { name: "Eigener Hex-Wert" })).toHaveValue("#abcdef");
    expect(screen.getByTestId("chat-vote-color-preview").querySelector(".chat-voting-editor__color-preview-track > span")).toHaveStyle({ backgroundColor: "rgb(171, 205, 239)" });
  });

  it("keeps a new vote as a two-minute draft until the explicit save action", async () => {
    const { requests, saved } = mount({ templates: [] });
    expect(await screen.findByText("Noch keine gespeicherten Abstimmungen")).toBeInTheDocument();
    const createButtons = await screen.findAllByRole("button", { name: "Abstimmung anlegen" });
    const createButton = createButtons[0];
    if (createButton === undefined) throw new Error("The create vote button is missing.");
    fireEvent.click(createButton);

    expect(screen.queryByRole("spinbutton", { name: "Sekunden" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Eigene$/u }));
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

  it("keeps the automatically selected desktop draft guarded when the window narrows", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    mount({ templates: [template, { ...template, id: "template-weekend", title: "Wochenende" }] });

    const question = await screen.findByRole("textbox", { name: "Frage" });
    fireEvent.change(question, { target: { value: "Entwurf der automatischen Auswahl" } });
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1100 });
    fireEvent(window, new Event("resize"));

    await waitFor(() => expect(screen.getByRole("textbox", { name: "Frage" })).toHaveValue("Entwurf der automatischen Auswahl"));
    expect(screen.queryByRole("dialog", { name: "Änderungen verwerfen?" })).not.toBeInTheDocument();
  });

  it("auto-selects a template when a later refresh changes an empty collection to populated", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    const rendered = mount({ templateResponses: [[], [template]] });
    expect(await screen.findByText("Noch keine gespeicherten Abstimmungen")).toBeInTheDocument();

    await act(async () => {
      await rendered.queryClient.invalidateQueries({ queryKey: moduleQueryKey("channel-432", "chat_voting", "templates") });
    });

    expect(await screen.findByRole("textbox", { name: "Frage" })).toHaveValue("Abendessen");
  });

  it("offers save-and-switch in the dirty draft guard and keeps it open after a failed save", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    let failFirstSave = true;
    mount({
      templates: [{ ...template, id: "template-a", title: "Vote A" }, { ...template, id: "template-b", title: "Vote B" }],
      patchResponse: (updated) => {
        if (failFirstSave) {
          failFirstSave = false;
          return Promise.resolve(jsonResponse({ error: "internal" }, 500));
        }
        return Promise.resolve(jsonResponse({ template: updated }));
      },
    });

    fireEvent.change(await screen.findByRole("textbox", { name: "Frage" }), { target: { value: "Vote A changed" } });
    fireEvent.click(screen.getByRole("link", { name: /Vote B/u }));
    const dialog = await screen.findByRole("dialog", { name: "Änderungen verwerfen?" });
    const saveAndSwitch = within(dialog).getByRole("button", { name: "Speichern und wechseln" });

    fireEvent.click(saveAndSwitch);
    expect(await within(dialog).findByText("Nicht gespeichert – erneut versuchen")).toBeInTheDocument();
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Frage"]')).toHaveValue("Vote A changed");

    fireEvent.click(within(dialog).getByRole("button", { name: "Speichern und wechseln" }));
    expect(await screen.findByRole("textbox", { name: "Frage" })).toHaveValue("Vote B");
  });

  it("does not let a late save from the old vote replace the current vote draft", async () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440 });
    const first = { ...template, id: "template-a", title: "Vote A" };
    const second = { ...template, id: "template-b", title: "Vote B" };
    let releaseFirstSave: (() => void) | undefined;
    let markFirstSaveStarted: (() => void) | undefined;
    const firstSaveGate = new Promise<void>((resolve) => { releaseFirstSave = resolve; });
    const firstSaveStarted = new Promise<void>((resolve) => { markFirstSaveStarted = resolve; });
    const { requests } = mount({
      templates: [first, second],
      patchResponse: async (updated) => {
        if (updated.id === "template-a") {
          markFirstSaveStarted?.();
          await firstSaveGate;
        }
        return jsonResponse({ template: updated });
      },
    });

    const question = await screen.findByRole("textbox", { name: "Frage" });
    fireEvent.change(question, { target: { value: "Vote A edited" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await firstSaveStarted;
    fireEvent.change(question, { target: { value: "Vote A" } });
    fireEvent.click(screen.getByRole("link", { name: /Vote B/u }));
    const secondQuestion = await screen.findByRole("textbox", { name: "Frage" });
    fireEvent.change(secondQuestion, { target: { value: "Vote B draft" } });

    releaseFirstSave?.();
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Frage" })).toHaveValue("Vote B draft"));
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(requests.mock.calls.some(([input, init]) =>
      requestUrl(input).pathname.endsWith("/templates/template-b") && init?.method === "PATCH")).toBe(true));

    const secondSave = requests.mock.calls.find(([input, init]) =>
      requestUrl(input).pathname.endsWith("/templates/template-b") && init?.method === "PATCH")?.[1]?.body;
    expect(typeof secondSave).toBe("string");
    expect(JSON.parse(secondSave as string)).toMatchObject({ title: "Vote B draft", revision: 1 });
  });

  it("shows saved vote properties without repeating the page permission reason to operators", async () => {
    mount({ canManage: false });
    expect(await screen.findByRole("link", { name: /Abendessen/u })).toBeInTheDocument();
    const inspector = screen.getByRole("region", { name: "Frage" });
    expect(within(inspector).queryByRole("note")).not.toBeInTheDocument();
    expect(within(inspector).getByText("Pizza, Burger")).toBeInTheDocument();
    expect(within(inspector).getByText("Danke fürs Abstimmen! Ergebnis: {vote.result}")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Frage" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Speichern" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Abstimmung anlegen" })).toBeDisabled();
  });

  it("keeps the delete action visible without repeating the page permission reason", async () => {
    mount({ canManage: false });
    await screen.findByRole("link", { name: /Abendessen/u });
    fireEvent.click(screen.getByRole("button", { name: "Weitere Aktionen" }));

    const deleteItem = await screen.findByRole("menuitem", { name: /Abstimmung löschen/u });
    expect(deleteItem).toHaveAttribute("aria-disabled", "true");
    expect(deleteItem).not.toHaveTextContent("Nur Broadcaster und Verwalter dürfen Abstimmungen bearbeiten.");
  });

  it("accepts the saved vote edit response after an explicit save", async () => {
    const { requests } = mount();
    const resultText = await screen.findByRole("textbox", { name: "Ergebnistext" });
    expect(screen.getAllByText("Ergebnistext", { exact: true })).toHaveLength(1);
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

  it("offers channel variables, text blocks, and API sources in result text", async () => {
    mount({
      templates: [{ ...template, resultText: "{vote.result} {var.score} {text.summary} {api.score}" }],
      templateVariables: [
        { name: "var.score", moduleId: "host", isTextBlock: false, description: "Punktzahl", group: "channel", maxLength: 10, sample: "8", source: "channel", contexts: ["event"] },
        { name: "text.summary", moduleId: "text_library", isTextBlock: true, maxLength: 500, sample: "Zusammenfassung", contexts: ["event"] },
        { name: "api.score", moduleId: "api_source", isTextBlock: false, description: "Punktzahl", group: "api", maxLength: 100, sample: "8", source: "module", contexts: ["event"] },
      ],
    });
    const resultText = await screen.findByRole("textbox", { name: "Ergebnistext" });
    await waitFor(() => expect(resultText.closest(".ui-template-text-field")?.querySelector(".ui-template-text-field__warnings"))
      .not.toHaveTextContent("Unbekannte Variable"));

    fireEvent.change(resultText, { target: { value: "{var." } });
    expect(await screen.findByRole("option", { name: /\{var\.score\}/u })).toBeInTheDocument();
    fireEvent.change(resultText, { target: { value: "{text." } });
    expect(await screen.findByRole("option", { name: /\{text\.summary\}/u })).toBeInTheDocument();
    fireEvent.change(resultText, { target: { value: "{api." } });
    expect(await screen.findByRole("option", { name: /\{api\.score\}/u })).toBeInTheDocument();
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
