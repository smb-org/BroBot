import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

import streamElementsFields from "../../docs/embedding/streamelements/fields.json?raw";
import streamElementsHtml from "../../docs/embedding/streamelements/widget.html?raw";
import streamElementsJs from "../../docs/embedding/streamelements/widget.js?raw";
import { OverlaysPage } from "../../src/dashboard/OverlaysPage";
import { UiProvider } from "../../src/dashboard/ui";
import { jsonResponse } from "../unit/fixtures";

const overlay = {
  id: "overlay-a", channelId: "channel-a", name: "Gameplay", width: 1920, height: 1080, css: "", revision: 4,
  createdAt: "2026-09-24T10:00:00.000Z", updatedAt: "2026-09-24T10:00:00.000Z",
  elements: [{ id: "element-a", kind: "variable", label: "Score", variableName: "score", text: "Score: {value}", config: {}, x: 0, y: 0, scalePercent: 100, z: 0, inComposition: true }],
};
const access = {
  tokenId: "access-a", overlayId: "overlay-a", label: "OBS Main PC", createdAt: "2026-09-24T10:00:00.000Z",
  expiresAt: null, revokedAt: null, lastUsedAt: "2026-09-24T11:00:00.000Z", recoverable: true,
};
type AccessFixture = {
  tokenId: string;
  overlayId: string;
  label: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  recoverable: boolean;
};
const summary = { id: "overlay-a", name: "Gameplay", width: 1920, height: 1080, revision: 4, elementCount: 1, accessCount: 1, lastUsedAt: access.lastUsedAt, createdAt: overlay.createdAt, updatedAt: overlay.updatedAt };
const overlayB = { ...overlay, id: "overlay-b", name: "Second scene", revision: 1, elements: [] };
const summaryB = { ...summary, id: "overlay-b", name: "Second scene", revision: 1, elementCount: 0, accessCount: 0, lastUsedAt: null };
const secret = `https://brobot.example/overlay#token=${"f".repeat(43)}`;
const maskedSecret = "https://brobot.example/overlay#token=••••••";
const requestPath = (input: RequestInfo | URL): string => {
  if (input instanceof Request) return new URL(input.url).pathname;
  if (input instanceof URL) return input.pathname;
  return new URL(input, window.location.href).pathname;
};
const requestBody = (init: RequestInit | undefined): string => typeof init?.body === "string" ? init.body : "";
const dashboardStyles = readFileSync(new NodeURL("../../src/dashboard/styles.css", import.meta.url), "utf8");

const validateWithWidget = (overlayUrl: string, brobotAddress: string): { src: string; errorDisplay: string } => {
  const widgetRuntime: { loadWidget?: (event: unknown) => void } = {};
  const frame = { style: { display: "" }, src: "" };
  const error = { style: { display: "" }, textContent: "" };
  runInNewContext(streamElementsJs, {
    window: { addEventListener: (_event: string, listener: (event: unknown) => void) => { widgetRuntime.loadWidget = listener; } },
    document: { getElementById: (id: string) => id === "brobotOverlayFrame" ? frame : error },
    navigator: { language: "en-US" },
    URL,
    URLSearchParams,
  });
  const loadWidget = widgetRuntime.loadWidget;
  if (loadWidget === undefined) throw new Error("Widget did not register its load handler.");
  loadWidget({ detail: { fieldData: { overlayUrl, brobotAddress } } });
  return { src: frame.src, errorDisplay: error.style.display };
};

const setBrowserLanguage = (language: string): void => {
  Object.defineProperty(window.navigator, "language", { value: language, configurable: true });
};

describe("Overlays page", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    setBrowserLanguage("de-DE");
  });

  const routeFetcher = (options: {
    conflictDelete?: boolean;
    emptyOverlays?: boolean;
    secondOverlay?: boolean;
    accessLastUsedAt?: string | null;
    accessRecoverable?: boolean;
    removeElementOnReplace?: boolean;
    legacyClosingPending?: boolean;
    legacyTokens?: Array<{ id: string; name: string | null; createdAt: string; createdBy: string | null; lastUsedAt: string | null; expiresAt: string | null }>;
  } = {}) => {
    let accesses: AccessFixture[] = [{
      ...access,
      ...(options.accessLastUsedAt === undefined ? {} : { lastUsedAt: options.accessLastUsedAt }),
      ...(options.accessRecoverable === undefined ? {} : { recoverable: options.accessRecoverable }),
    }];
    let legacyTokens = [...(options.legacyTokens ?? [])];
    let importedOverlay: typeof overlay | null = null;
    let currentOverlay = overlay;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href);
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/csrf") return jsonResponse({ token: "csrf-test" });
      if (url.pathname === "/api/channels/channel-a/overlays" && method === "GET") {
        const listed = options.emptyOverlays ? [] : [
          { ...summary, accessCount: accesses.filter((item) => item.revokedAt === null).length },
          ...(options.secondOverlay ? [summaryB] : []),
        ];
        return jsonResponse({ overlays: importedOverlay === null ? listed : [
          ...listed,
          { ...summary, id: importedOverlay.id, name: importedOverlay.name, elementCount: importedOverlay.elements.length, accessCount: 1 },
        ], maximum: 20, elementMaximum: 20 });
      }
      if (url.pathname === "/api/channels/channel-a/overlay-tokens" && method === "GET") return jsonResponse({ tokens: legacyTokens, nextOffset: null });
      if (url.pathname.startsWith("/api/channels/channel-a/overlay-tokens/") && url.pathname.endsWith("/revoke") && method === "POST") {
        const tokenId = url.pathname.split("/").at(-2);
        legacyTokens = legacyTokens.filter((item) => item.id !== tokenId);
        if (options.legacyClosingPending) return jsonResponse({ closingPending: true }, 202);
        return new Response(null, { status: 204 });
      }
      if (url.pathname === "/api/channels/channel-a/overlays/import-legacy" && method === "POST") {
        const body = JSON.parse(requestBody(init)) as { variableName: string; text: string };
        const firstElement = overlay.elements[0];
        if (firstElement === undefined) throw new Error("Overlay fixture is missing its element.");
        importedOverlay = {
          ...overlay,
          id: "overlay-imported",
          name: body.variableName,
          elements: [{ ...firstElement, label: body.variableName, variableName: body.variableName, text: body.text, x: 0, y: 0 }],
        };
        legacyTokens = [];
        return jsonResponse({ overlay: importedOverlay }, 201);
      }
      if (url.pathname === "/api/channels/channel-a/overlays/overlay-a" && method === "GET") return jsonResponse({ overlay: currentOverlay });
      if (url.pathname === "/api/channels/channel-a/overlays/overlay-b" && method === "GET") return jsonResponse({ overlay: overlayB });
      if (url.pathname === "/api/channels/channel-a/overlays/overlay-imported" && method === "GET" && importedOverlay !== null) return jsonResponse({ overlay: importedOverlay });
      if (url.pathname === "/api/channels/channel-a/overlays/overlay-a/accesses" && method === "GET") {
        return jsonResponse({ accesses, activeCount: accesses.filter((item) => item.revokedAt === null).length, maximum: 10 });
      }
      if (url.pathname === "/api/channels/channel-a/overlays/overlay-b/accesses" && method === "GET") return jsonResponse({ accesses: [], activeCount: 0, maximum: 10 });
      if (url.pathname === "/api/channels/channel-a/overlays/overlay-imported/accesses" && method === "GET") return jsonResponse({ accesses: [], activeCount: 0, maximum: 10 });
      if (url.pathname === "/api/channels/channel-a/overlays/overlay-a/accesses" && method === "POST") {
        const issued = { tokenId: "access-new", overlayUrl: secret, label: "OBS Backup PC", expiresAt: null };
        accesses = [...accesses, { ...access, tokenId: issued.tokenId, label: issued.label }];
        return jsonResponse(issued, 201);
      }
      if (url.pathname.endsWith("/access-a/reveal") && method === "POST") return jsonResponse({ overlayUrl: secret });
      if (url.pathname.endsWith("/access-a/replace") && method === "POST") {
        if (options.removeElementOnReplace) currentOverlay = { ...overlay, revision: 5, elements: [] };
        return jsonResponse({ tokenId: "access-replaced", overlayUrl: secret, label: "OBS Main PC 2", expiresAt: null }, 201);
      }
      if (url.pathname.endsWith("/access-a/revoke") && method === "POST") {
        accesses = accesses.map((item) => item.tokenId === "access-a" ? { ...item, revokedAt: "2026-09-24T12:00:00.000Z" } : item);
        return new Response(null, { status: 204 });
      }
      if (url.pathname.endsWith("/overlay-a") && method === "DELETE") {
        return options.conflictDelete
          ? jsonResponse({ error: "overlay_changed_concurrently", currentRevision: 5 }, 409)
          : new Response(null, { status: 204 });
      }
      return Promise.reject(new Error(`Unexpected request ${method} ${url.pathname}`));
    });
    return fetcher;
  };

  it("lists overlay counts and usage, and keeps operator management actions disabled without exposing links", async () => {
    const fetcher = routeFetcher({ legacyTokens: [{ id: "legacy-token", name: null, createdAt: "2026-09-24T10:00:00.000Z", createdBy: null, lastUsedAt: null, expiresAt: null }] });
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><OverlaysPage channelId="channel-a" canManage={false} /></UiProvider>);

    const table = await screen.findByRole("table");
    expect(table.closest(".overlays-table-wrap")).not.toHaveClass("overlays-table-wrap--inspector-open");
    expect(within(table).getByText("Gameplay")).toBeInTheDocument();
    expect(within(table).getAllByText("1", { selector: "td" })).toHaveLength(2);
    expect(within(table).queryByText("OBS Main PC")).not.toBeInTheDocument();
    fireEvent.click(within(table).getByText("Gameplay"));
    expect(table.closest(".overlays-table-wrap")).toHaveClass("overlays-table-wrap--inspector-open");

    const inspector = await screen.findByRole("region", { name: "Zugänge" });
    expect(within(inspector).getByText("OBS Main PC")).toBeInTheDocument();
    expect(within(inspector).getByRole("button", { name: "Zugang ausstellen" })).toBeDisabled();
    expect(within(inspector).getByRole("button", { name: "Link erneut anzeigen" })).toBeDisabled();
    expect(within(inspector).getByRole("button", { name: "Ersetzen" })).toBeDisabled();
    expect(within(inspector).getByRole("button", { name: "Widerrufen" })).toBeDisabled();
    const accessRow = within(inspector).getByText("OBS Main PC").closest("li");
    if (!(accessRow instanceof HTMLElement)) throw new Error("Access list row is missing.");
    expect(within(accessRow).getByText(/^Zuletzt benutzt:/u)).toHaveTextContent("Zuletzt benutzt: 24.09.2026");
    expect(within(accessRow).getByText("Status: Aktiv")).toHaveClass("overlay-access-list__status");
    const fullInspector = document.querySelector(".list-detail__inspector");
    if (!(fullInspector instanceof HTMLElement)) throw new Error("Overlay inspector is missing.");
    expect(within(fullInspector).getByRole("button", { name: "Overlay löschen" })).toBeDisabled();
    expect(within(inspector).getByText(/Bediener können Overlays/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Importieren" })).not.toBeInTheDocument();
    expect(document.querySelector("a[href*='token=']")).toBeNull();
    expect(within(inspector).getByRole("button", { name: "Ersetzen" })).toHaveAttribute("title", expect.stringContaining("Nur Broadcaster"));
    expect(fetcher.mock.calls.some(([input]) => requestPath(input).includes("/reveal"))).toBe(false);
  });

  it("parses a legacy link locally and sends only its token, variable, and text", async () => {
    const fetcher = routeFetcher({ emptyOverlays: true, legacyTokens: [{
      id: "legacy-token", name: null, createdAt: "2026-09-24T10:00:00.000Z", createdBy: null, lastUsedAt: null, expiresAt: null,
    }] });
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><OverlaysPage channelId="channel-a" canManage /></UiProvider>);

    fireEvent.click(await screen.findByRole("button", { name: "Importieren" }));
    expect(await screen.findByText("Benutzerdefiniertes OBS-CSS wird nicht importiert.")).toBeInTheDocument();
    expect(screen.getByText("Positionen in OBS werden nicht importiert.")).toBeInTheDocument();
    expect(screen.getByText(/Ein Token kann mehrere unterschiedliche Fragment-Links/u)).toBeInTheDocument();

    const token = "a".repeat(43);
    const legacyLink = `https://example.invalid/overlay#token=${token}&var=score&text=Imported%3A+%7Bvalue%7D`;
    fireEvent.change(screen.getByRole("textbox", { name: "Alter Overlay-Link" }), { target: { value: legacyLink } });
    fireEvent.click(screen.getByRole("button", { name: "Link importieren" }));

    expect(await screen.findByRole("status")).toHaveTextContent("Overlay „score“ wurde importiert.");
    const importCall = fetcher.mock.calls.find(([input]) => requestPath(input).endsWith("/overlays/import-legacy"));
    expect(importCall).toBeDefined();
    const [request, init] = importCall ?? [];
    const requestUrl = request instanceof Request ? new URL(request.url) : new URL(String(request), window.location.href);
    expect(requestUrl.hash).toBe("");
    expect(requestUrl.search).toBe("");
    expect(JSON.parse(requestBody(init))).toEqual({ token, variableName: "score", text: "Imported: {value}" });
    expect(requestBody(init)).not.toContain(legacyLink);
    expect(await screen.findByText("score", { selector: ".overlays-table tbody th" })).toBeInTheDocument();
  });

  it.each([
    { language: "de-DE", lastUsed: "Zuletzt benutzt: nie", status: "Status: Aktiv" },
    { language: "en-US", lastUsed: "Last used: never", status: "Status: Active" },
  ])("labels access metadata and uses secondary buttons in $language", async ({ language, lastUsed, status }) => {
    setBrowserLanguage(language);
    vi.stubGlobal("fetch", routeFetcher({ accessLastUsedAt: null }));
    render(<UiProvider><OverlaysPage channelId="channel-a" canManage /></UiProvider>);
    fireEvent.click(await screen.findByText("Gameplay"));

    const inspector = await screen.findByRole("region", { name: language === "en-US" ? "Accesses" : "Zugänge" });
    const accessRow = within(inspector).getByText("OBS Main PC").closest("li");
    if (!(accessRow instanceof HTMLElement)) throw new Error("Access list row is missing.");
    expect(within(accessRow).getByText(lastUsed)).toBeInTheDocument();
    expect(within(accessRow).getByText(status)).toHaveClass("overlay-access-list__status");

    const actions = within(accessRow).getAllByRole("button");
    expect(actions).toHaveLength(4);
    for (const action of actions) expect(action).toHaveAttribute("data-variant", "default");
  });

  it("opens the selected overlay composition editor", async () => {
    const fetcher = routeFetcher();
    vi.stubGlobal("fetch", fetcher);
    const onOpenEditor = vi.fn();
    render(<UiProvider><OverlaysPage channelId="channel-a" canManage onOpenEditor={onOpenEditor} /></UiProvider>);
    fireEvent.click(await screen.findByText("Gameplay"));
    await screen.findByRole("region", { name: "Zugänge" });

    fireEvent.click(screen.getByRole("button", { name: "Komposition bearbeiten" }));

    expect(onOpenEditor).toHaveBeenCalledWith("overlay-a");
  });

  it.each([
    {
      language: "de-DE",
      reveal: "Link erneut anzeigen",
      replace: "Ersetzen",
      hint: "Dieser alte Zugang kann nicht erneut angezeigt werden. Stelle einen neuen Zugang aus.",
    },
    {
      language: "en-US",
      reveal: "Show link again",
      replace: "Replace",
      hint: "This legacy access cannot be shown again. Issue a new access.",
    },
  ])("disables reveal for an imported access and explains how to issue a new one in $language", async ({ language, reveal, replace, hint }) => {
    setBrowserLanguage(language);
    vi.stubGlobal("fetch", routeFetcher({ accessRecoverable: false }));
    render(<UiProvider><OverlaysPage channelId="channel-a" canManage /></UiProvider>);
    fireEvent.click(await screen.findByText("Gameplay"));

    const inspector = await screen.findByRole("region", { name: language === "en-US" ? "Accesses" : "Zugänge" });
    const accessRow = within(inspector).getByText("OBS Main PC").closest("li");
    if (!(accessRow instanceof HTMLElement)) throw new Error("Access list row is missing.");
    expect(within(accessRow).getByRole("button", { name: reveal })).toBeDisabled();
    expect(within(accessRow).getByRole("button", { name: replace })).toBeEnabled();
    expect(within(accessRow).getByText(hint)).toBeInTheDocument();
  });

  it("issues and copies a link, re-shows and replaces access, and confirms revocation", async () => {
    const fetcher = routeFetcher();
    vi.stubGlobal("fetch", fetcher);
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<UiProvider><OverlaysPage channelId="channel-a" canManage /></UiProvider>);
    const table = await screen.findByRole("table");
    fireEvent.click(within(table).getByText("Gameplay"));
    const inspector = await screen.findByRole("region", { name: "Zugänge" });

    fireEvent.change(within(inspector).getByLabelText("Name des Zugangs"), { target: { value: "OBS Backup PC" } });
    fireEvent.click(within(inspector).getByRole("button", { name: "Zugang ausstellen" }));
    expect(await screen.findByText(maskedSecret)).toBeInTheDocument();
    expect(screen.queryByDisplayValue(secret)).not.toBeInTheDocument();
    expect([...document.querySelectorAll("input, textarea")].some((element) => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? element.value.includes("f".repeat(43)) : false)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Link kopieren" }));
    expect(writeText).toHaveBeenCalledWith(secret);

    const originalAccess = within(inspector).getByText("OBS Main PC").closest("li");
    if (!(originalAccess instanceof HTMLElement)) throw new Error("Access list row is missing.");
    fireEvent.click(within(originalAccess).getByRole("button", { name: "Link erneut anzeigen" }));
    await vi.waitFor(() => { expect(fetcher.mock.calls.some(([input]) => requestPath(input).includes("/access-a/reveal"))).toBe(true); });
    expect(await screen.findByText(maskedSecret)).toBeInTheDocument();
    fireEvent.click(within(originalAccess).getByRole("button", { name: "Ersetzen" }));
    await vi.waitFor(() => { expect(fetcher.mock.calls.some(([input]) => requestPath(input).includes("/access-a/replace"))).toBe(true); });
    expect(await screen.findByText(maskedSecret)).toBeInTheDocument();
    expect(fetcher.mock.calls.some(([input]) => requestPath(input).includes("/access-a/replace"))).toBe(true);

    fireEvent.click(within(originalAccess).getByRole("button", { name: "Widerrufen" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Widerrufen: OBS Main PC" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Zugang widerrufen.");
    expect(fetcher.mock.calls.some(([input]) => requestPath(input).includes("/access-a/revoke"))).toBe(true);
  });

  it("lets a manager reveal the current overlay link in a selectable field when clipboard access is denied", async () => {
    const fetcher = routeFetcher({ secondOverlay: true });
    vi.stubGlobal("fetch", fetcher);
    const writeText = vi.fn().mockRejectedValue(new DOMException("Permission denied", "NotAllowedError"));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<UiProvider><OverlaysPage channelId="channel-a" canManage /></UiProvider>);
    const table = await screen.findByRole("table");
    fireEvent.click(within(table).getByText("Gameplay"));
    const inspector = await screen.findByRole("region", { name: "Zugänge" });
    fireEvent.change(within(inspector).getByLabelText("Name des Zugangs"), { target: { value: "OBS Backup PC" } });
    fireEvent.click(within(inspector).getByRole("button", { name: "Zugang ausstellen" }));
    await screen.findByText(maskedSecret);

    fireEvent.click(within(inspector).getByRole("button", { name: "Link kopieren" }));
    expect(await screen.findAllByText("Der Link konnte nicht kopiert werden.")).not.toHaveLength(0);
    fireEvent.click(within(inspector).getByRole("button", { name: "Link anzeigen" }));
    const linkField = within(inspector).getByRole("textbox", { name: "Vollständiger Link" });
    expect(linkField).toHaveValue(secret);
    expect(linkField).toHaveAttribute("readonly");

    fireEvent.click(within(table).getByText("Second scene"));
    await screen.findByRole("heading", { name: "Second scene" });
    expect(screen.queryByRole("textbox", { name: "Vollständiger Link" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Link verbergen" })).not.toBeInTheDocument();
  });

  it("surfaces a delete revision conflict and reloads the current overlay", async () => {
    const fetcher = routeFetcher({ conflictDelete: true });
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><OverlaysPage channelId="channel-a" canManage /></UiProvider>);
    fireEvent.click(await screen.findByText("Gameplay"));
    const inspector = document.querySelector(".list-detail__inspector");
    if (!(inspector instanceof HTMLElement)) throw new Error("Overlay inspector is missing.");
    fireEvent.click(await within(inspector).findByRole("button", { name: "Overlay löschen" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Gameplay endgültig löschen" }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Das Overlay wurde zwischenzeitlich geändert.");
    const deleteCall = fetcher.mock.calls.find(([input, init]) => requestPath(input).endsWith("/overlays/overlay-a") && init?.method === "DELETE");
    expect(deleteCall?.[1]?.body).toBe(JSON.stringify({ baseRevision: 4 }));
    expect(fetcher.mock.calls.filter(([input]) => requestPath(input).endsWith("/overlays/overlay-a")).length).toBeGreaterThan(1);
  });

  it("shows localized OBS setup steps inside the selected access", async () => {
    vi.stubGlobal("fetch", routeFetcher());
    render(<UiProvider><OverlaysPage channelId="channel-a" canManage /></UiProvider>);
    fireEvent.click(await screen.findByText("Gameplay"));
    const inspector = await screen.findByRole("region", { name: "Zugänge" });
    fireEvent.click(within(inspector).getByRole("button", { name: "Einrichten" }));
    const assistant = within(inspector).getByRole("region", { name: "Einrichtungsassistent" });
    const tabs = within(assistant).getAllByRole("tab");
    for (const tab of tabs) {
      const panelId = tab.getAttribute("aria-controls");
      expect(panelId).not.toBeNull();
      const panel = document.getElementById(panelId ?? "");
      expect(panel).toBeInTheDocument();
      expect(panel?.hidden).toBe(tab.getAttribute("aria-selected") !== "true");
    }
    expect(within(assistant).getAllByRole("tabpanel", { hidden: true })).toHaveLength(3);
    expect(within(assistant).getAllByRole("tab").find((tab) => tab.getAttribute("aria-selected") === "false")).toHaveClass("overlay-setup__tab");
    expect(dashboardStyles).toMatch(/\.overlay-setup__tab\s*\{[^}]*min-height:\s*44px/u);
    expect(dashboardStyles).toMatch(/\.overlay-setup__panel\[hidden\]\s*\{[^}]*display:\s*none/u);
    expect(dashboardStyles).toMatch(/\.overlay-elements-list\s*\{[^}]*list-style:\s*none/u);
    expect(document.querySelector(".overlay-elements-list")).toHaveClass("overlay-elements-list");
    expect(assistant).toHaveTextContent("Breite und Höhe: 1920 × 1080 px");
    expect(assistant).toHaveTextContent("Quelle hinzufügen");
    expect(assistant).toHaveTextContent("Browser auswählen");
    expect(assistant).toHaveTextContent("Die Anzeige ist maskiert; der kopierte Link enthält den Zugangstoken.");
    expect(assistant).toHaveTextContent("Eigenes CSS gehört in den Stil des Overlays.");
    expect(within(assistant).getByRole("tab", { name: "OBS" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("Overlay-Link", { selector: ".overlay-access-secret" })).not.toBeInTheDocument();
  });

  it("switches setup platform tabs and copies the source embedding files verbatim", async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    vi.stubGlobal("fetch", routeFetcher());
    render(<UiProvider><OverlaysPage channelId="channel-a" canManage /></UiProvider>);
    fireEvent.click(await screen.findByText("Gameplay"));
    const inspector = await screen.findByRole("region", { name: "Zugänge" });
    fireEvent.click(within(inspector).getByRole("button", { name: "Einrichten" }));
    const assistant = within(inspector).getByRole("region", { name: "Einrichtungsassistent" });

    const obsTab = within(assistant).getByRole("tab", { name: "OBS" });
    fireEvent.keyDown(obsTab, { key: "ArrowRight" });
    const streamElementsTab = within(assistant).getByRole("tab", { name: "StreamElements" });
    expect(streamElementsTab).toHaveAttribute("aria-selected", "true");
    expect(assistant).toHaveTextContent("Overlay → Add Widget → Static/Custom → Custom Widget");
    expect(assistant).toHaveTextContent("brobotAddress");
    expect(assistant).toHaveTextContent("overlayUrl");
    fireEvent.click(within(assistant).getByRole("button", { name: "HTML kopieren" }));
    fireEvent.click(within(assistant).getByRole("button", { name: "JS kopieren" }));
    fireEvent.click(within(assistant).getByRole("button", { name: "Fields kopieren" }));
    expect(writeText).toHaveBeenNthCalledWith(1, streamElementsHtml);
    expect(writeText).toHaveBeenNthCalledWith(2, streamElementsJs);
    expect(writeText).toHaveBeenNthCalledWith(3, streamElementsFields);
    expect(await within(assistant).findByRole("button", { name: "Fields kopiert" })).toBeInTheDocument();

    const soundAlertsTab = within(assistant).getByRole("tab", { name: "Sound Alerts" });
    fireEvent.click(soundAlertsTab);
    expect(soundAlertsTab).toHaveAttribute("aria-selected", "true");
    expect(assistant).toHaveTextContent("Scenes → Add Widget → Import Widget");
    expect(assistant).toHaveTextContent("noch nicht am echten Sound-Alerts-Produkt geprüft");
    expect(within(assistant).getByRole("button", { name: "HTML kopieren" })).toBeInTheDocument();
    expect(within(assistant).getByRole("button", { name: "JS kopieren" })).toBeInTheDocument();
    expect(within(assistant).getByRole("button", { name: "Fields kopieren" })).toBeInTheDocument();
  });

  it("copies a selected element URL through the access reveal flow without rendering its token", async () => {
    const fetcher = routeFetcher();
    vi.stubGlobal("fetch", fetcher);
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<UiProvider><OverlaysPage channelId="channel-a" canManage /></UiProvider>);
    fireEvent.click(await screen.findByText("Gameplay"));
    const inspector = await screen.findByRole("region", { name: "Zugänge" });
    fireEvent.click(within(inspector).getByRole("button", { name: "Einrichten" }));
    const assistant = within(inspector).getByRole("region", { name: "Einrichtungsassistent" });
    const output = within(assistant).getByRole("combobox", { name: "Ausgabe" });
    fireEvent.click(output);
    fireEvent.click(await screen.findByRole("option", { name: "Einzelnes Element: Score" }));
    expect(assistant).toHaveTextContent("Breite ≈ Elementbreite × Skalierung; Höhe nach Inhalt.");
    expect(assistant).toHaveTextContent("#token=••••••&element=element-a");

    fireEvent.click(within(assistant).getByRole("button", { name: "Link zum Kopieren anzeigen" }));
    await vi.waitFor(() => { expect(fetcher.mock.calls.some(([input]) => requestPath(input).endsWith("/access-a/reveal"))).toBe(true); });
    expect(writeText).not.toHaveBeenCalled();
    fireEvent.click(within(assistant).getByRole("button", { name: "Overlay-Link kopieren" }));
    await vi.waitFor(() => { expect(writeText).toHaveBeenLastCalledWith(`${secret}&element=element-a`); });
    expect(await within(assistant).findByRole("button", { name: "Overlay-Link kopiert" })).toBeInTheDocument();
    const copiedElementUrl = writeText.mock.calls[0]?.[0];
    if (typeof copiedElementUrl !== "string") throw new Error("The selected element URL was not copied.");
    const elementFields = {
      brobotAddress: { value: new URL(copiedElementUrl).origin },
      overlayUrl: { value: copiedElementUrl },
    };
    const validation = validateWithWidget(elementFields.overlayUrl.value, elementFields.brobotAddress.value);
    expect(validation.errorDisplay).toBe("none");
    expect(validation.src).toBe(copiedElementUrl);
    expect(document.body.textContent).not.toContain("f".repeat(43));
    expect([...document.querySelectorAll("input, textarea")].some((element) => element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? element.value.includes("f".repeat(43)) : false)).toBe(false);

  });

  it("copies the whole overlay when a refreshed composition removes the selected element", async () => {
    const fetcher = routeFetcher({ removeElementOnReplace: true });
    vi.stubGlobal("fetch", fetcher);
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    render(<UiProvider><OverlaysPage channelId="channel-a" canManage /></UiProvider>);
    fireEvent.click(await screen.findByText("Gameplay"));
    const inspector = await screen.findByRole("region", { name: "Zugänge" });
    fireEvent.click(within(inspector).getByRole("button", { name: "Einrichten" }));
    const assistant = within(inspector).getByRole("region", { name: "Einrichtungsassistent" });
    const output = within(assistant).getByRole("combobox", { name: "Ausgabe" });
    fireEvent.click(output);
    fireEvent.click(await screen.findByRole("option", { name: "Einzelnes Element: Score" }));

    const accessRow = within(inspector).getByText("OBS Main PC").closest("li");
    if (!(accessRow instanceof HTMLElement)) throw new Error("Access list row is missing.");
    fireEvent.click(within(accessRow).getByRole("button", { name: "Ersetzen" }));
    await vi.waitFor(() => { expect(fetcher.mock.calls.some(([input]) => requestPath(input).endsWith("/access-a/replace"))).toBe(true); });
    await vi.waitFor(() => { expect(output).toHaveValue("Ganzes Overlay"); });
    expect(assistant).toHaveTextContent("Breite und Höhe: 1920 × 1080 px");

    fireEvent.click(within(assistant).getByRole("button", { name: "Link zum Kopieren anzeigen" }));
    await vi.waitFor(() => { expect(fetcher.mock.calls.filter(([input]) => requestPath(input).endsWith("/access-a/reveal")).length).toBeGreaterThan(0); });
    fireEvent.click(within(assistant).getByRole("button", { name: "Overlay-Link kopieren" }));
    await vi.waitFor(() => { expect(writeText).toHaveBeenCalledWith(secret); });
    const copiedUrl = writeText.mock.calls[0]?.[0];
    if (typeof copiedUrl !== "string") throw new Error("The whole overlay URL was not copied after the selection became stale.");
    const wholeOverlayFields = {
      brobotAddress: { value: new URL(copiedUrl).origin },
      overlayUrl: { value: copiedUrl },
    };
    const validation = validateWithWidget(wholeOverlayFields.overlayUrl.value, wholeOverlayFields.brobotAddress.value);
    expect(validation.errorDisplay).toBe("none");
    expect(validation.src).toBe(copiedUrl);
  });

  it.each([
    `${secret}&element=bad%20id`,
    `${secret}&element=${"x".repeat(65)}`,
    `${secret}&debug=1`,
  ])("rejects an invalid custom widget fragment: %s", (overlayUrl) => {
    const validation = validateWithWidget(overlayUrl, new URL(overlayUrl).origin);
    expect(validation.src).toBe("");
    expect(validation.errorDisplay).toBe("block");
  });

  it("keeps setup instructions and snippet copying available to operators but explains disabled access copying", async () => {
    const fetcher = routeFetcher();
    vi.stubGlobal("fetch", fetcher);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    render(<UiProvider><OverlaysPage channelId="channel-a" canManage={false} /></UiProvider>);
    fireEvent.click(await screen.findByText("Gameplay"));
    const inspector = await screen.findByRole("region", { name: "Zugänge" });
    fireEvent.click(within(inspector).getByRole("button", { name: "Einrichten" }));
    const assistant = within(inspector).getByRole("region", { name: "Einrichtungsassistent" });
    const copyUrl = within(assistant).getByRole("button", { name: "Link zum Kopieren anzeigen" });
    expect(copyUrl).toBeDisabled();
    expect(assistant).toHaveTextContent("Nur Broadcaster und Verwalter dürfen Overlay-Zugänge kopieren.");
    expect(within(assistant).getByRole("tab", { name: "OBS" })).toBeEnabled();
    fireEvent.click(within(assistant).getByRole("tab", { name: "StreamElements" }));
    fireEvent.click(within(assistant).getByRole("button", { name: "HTML kopieren" }));
    expect(writeText).toHaveBeenCalledWith(streamElementsHtml);
    fireEvent.click(copyUrl);
    expect(fetcher.mock.calls.some(([input]) => requestPath(input).endsWith("/access-a/reveal"))).toBe(false);
  });

  it.each([
    {
      language: "de-DE", assistant: "Einrichtungsassistent", target: "Zielsystem",
      obsCopy: "Die Anzeige ist maskiert; der kopierte Link enthält den Zugangstoken.",
      fields: "brobotAddress auf den HTTPS-Ursprung des Overlay-Links und overlayUrl auf den vollständigen Link mit Zugangstoken setzen",
    },
    {
      language: "en-US", assistant: "Setup assistant", target: "Target platform",
      obsCopy: "The displayed URL is masked; the copied link includes the access token.",
      fields: "set brobotAddress to the HTTPS origin of the overlay link and overlayUrl to the full link containing the access token",
    },
  ])("localizes setup labels in $language", async ({ language, assistant: assistantLabel, target, obsCopy, fields }) => {
    setBrowserLanguage(language);
    vi.stubGlobal("fetch", routeFetcher());
    render(<UiProvider><OverlaysPage channelId="channel-a" canManage /></UiProvider>);
    fireEvent.click(await screen.findByText("Gameplay"));
    const inspector = await screen.findByRole("region", { name: language === "de-DE" ? "Zugänge" : "Accesses" });
    fireEvent.click(within(inspector).getByRole("button", { name: language === "de-DE" ? "Einrichten" : "Set up" }));
    const assistant = within(inspector).getByRole("region", { name: assistantLabel });
    expect(within(assistant).getByRole("tablist", { name: target })).toBeInTheDocument();
    const obsTab = within(assistant).getByRole("tab", { name: "OBS" });
    expect(document.getElementById(obsTab.getAttribute("aria-controls") ?? "")?.textContent).toContain(obsCopy);
    const streamElementsTab = within(assistant).getByRole("tab", { name: "StreamElements" });
    expect(document.getElementById(streamElementsTab.getAttribute("aria-controls") ?? "")?.textContent).toContain(fields);
    const soundAlertsTab = within(assistant).getByRole("tab", { name: "Sound Alerts" });
    expect(document.getElementById(soundAlertsTab.getAttribute("aria-controls") ?? "")?.textContent).toContain(fields);
  });

  it("keeps legacy links manageable on a channel with no overlays", async () => {
    const fetcher = routeFetcher({ emptyOverlays: true, legacyTokens: [{
      id: "legacy-access-a", name: null, createdAt: "2026-09-24T10:00:00.000Z", createdBy: "Sample creator",
      lastUsedAt: null, expiresAt: null,
    }] });
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><OverlaysPage channelId="channel-a" canManage /></UiProvider>);

    const legacy = await screen.findByRole("region", { name: "Alte Links (Konfiguration im Link)" });
    expect(within(legacy).getByText("Unbenannter Alt-Link")).toBeInTheDocument();
    expect(legacy).toHaveTextContent("Link-ID: legacy-a");
    fireEvent.click(within(legacy).getByRole("button", { name: "Widerrufen" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("legacy-a");
    fireEvent.click(within(dialog).getByRole("button", { name: "Unbenannter Alt-Link (legacy-a) widerrufen" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Zugang widerrufen.");
    const revoke = fetcher.mock.calls.find(([input, init]) => requestPath(input).endsWith("/legacy-access-a/revoke") && init?.method === "POST");
    expect(revoke?.[1]?.body).toContain("Über Alte Links im Dashboard widerrufen");
    expect(screen.queryByRole("region", { name: "Alte Links (Konfiguration im Link)" })).not.toBeInTheDocument();
  });

  it.each([
    ["de-DE", "Zugang widerrufen. Verbundene Quellen werden noch geschlossen.", "Unbenannter Alt-Link (bbbbbbbb) widerrufen"],
    ["en-US", "Access revoked. Connected sources are still closing.", "Revoke Unnamed legacy link (bbbbbbbb)"],
  ])("shows the pending closure message and token identity after legacy revocation in %s", async (language, pendingMessage, confirmLabel) => {
    setBrowserLanguage(language);
    const fetcher = routeFetcher({ emptyOverlays: true, legacyClosingPending: true, legacyTokens: [
      { id: "aaaaaaaa-first", name: null, createdAt: "2026-09-24T10:00:00.000Z", createdBy: "Test manager", lastUsedAt: null, expiresAt: null },
      { id: "bbbbbbbb-second", name: null, createdAt: "2026-09-24T10:00:00.000Z", createdBy: "Test manager", lastUsedAt: null, expiresAt: null },
    ] });
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><OverlaysPage channelId="channel-a" canManage /></UiProvider>);

    const legacy = await screen.findByRole("region", { name: language === "de-DE" ? "Alte Links (Konfiguration im Link)" : "Legacy links (configuration in the link)" });
    const targetRow = within(legacy).getAllByRole("listitem").find((row) => row.textContent.includes("bbbbbbbb"));
    if (!(targetRow instanceof HTMLElement)) throw new Error("Target legacy link row is missing.");
    expect(legacy).toHaveTextContent(`${language === "de-DE" ? "Link-ID" : "Link ID"}: aaaaaaaa`);
    fireEvent.click(within(targetRow).getByRole("button", { name: language === "de-DE" ? "Widerrufen" : "Revoke" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("bbbbbbbb");
    expect(dialog).not.toHaveTextContent("aaaaaaaa");
    fireEvent.click(within(dialog).getByRole("button", { name: confirmLabel }));

    expect(await screen.findByRole("status")).toHaveTextContent(pendingMessage);
    expect(fetcher.mock.calls.some(([input, init]) => requestPath(input).endsWith("/bbbbbbbb-second/revoke") && init?.method === "POST")).toBe(true);
    expect(fetcher.mock.calls.some(([input, init]) => requestPath(input).endsWith("/aaaaaaaa-first/revoke") && init?.method === "POST")).toBe(false);
  });

  it("clears an issued link immediately when the manager role is removed", async () => {
    vi.stubGlobal("fetch", routeFetcher());
    const page = render(<UiProvider><OverlaysPage channelId="channel-a" canManage /></UiProvider>);
    fireEvent.click(await screen.findByText("Gameplay"));
    const inspector = await screen.findByRole("region", { name: "Zugänge" });
    fireEvent.change(within(inspector).getByLabelText("Name des Zugangs"), { target: { value: "OBS Backup PC" } });
    fireEvent.click(within(inspector).getByRole("button", { name: "Zugang ausstellen" }));
    expect(await screen.findByText(maskedSecret)).toBeInTheDocument();
    fireEvent.click(within(inspector).getByRole("button", { name: "Link anzeigen" }));
    expect(within(inspector).getByRole("textbox", { name: "Vollständiger Link" })).toHaveValue(secret);

    page.rerender(<UiProvider><OverlaysPage channelId="channel-a" canManage={false} /></UiProvider>);
    expect(screen.queryByText(maskedSecret)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Link kopieren" })).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Vollständiger Link" })).not.toBeInTheDocument();
  });

  it("does not show a delayed reveal after the manager selects another overlay", async () => {
    let resolveReveal: ((response: Response) => void) | null = null;
    const fetcher = routeFetcher({ secondOverlay: true });
    const original = fetcher.getMockImplementation();
    fetcher.mockImplementation((input, init) => {
      const path = requestPath(input);
      if (path.endsWith("/access-a/reveal") && (init?.method ?? "GET") === "POST") {
        return new Promise((resolve) => { resolveReveal = resolve; });
      }
      return original?.(input, init) ?? Promise.reject(new Error(`Unexpected request ${path}`));
    });
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><OverlaysPage channelId="channel-a" canManage /></UiProvider>);
    const table = await screen.findByRole("table");
    fireEvent.click(within(table).getByText("Gameplay"));
    const inspector = await screen.findByRole("region", { name: "Zugänge" });
    const row = within(inspector).getByText("OBS Main PC").closest("li");
    if (!(row instanceof HTMLElement)) throw new Error("Access row is missing.");
    fireEvent.click(within(row).getByRole("button", { name: "Link erneut anzeigen" }));
    await vi.waitFor(() => { expect(resolveReveal).toBeTypeOf("function"); });
    fireEvent.click(within(table).getByText("Second scene"));
    await vi.waitFor(() => { expect(fetcher.mock.calls.some(([input]) => requestPath(input).endsWith("/overlays/overlay-b/accesses"))).toBe(true); });
    act(() => { resolveReveal?.(jsonResponse({ overlayUrl: secret })); });

    expect(screen.queryByText(maskedSecret)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Link kopieren" })).not.toBeInTheDocument();
  });
});
