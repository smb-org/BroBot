import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

import streamElementsFields from "../../docs/embedding/streamelements/fields.json?raw";
import streamElementsHtml from "../../docs/embedding/streamelements/widget.html?raw";
import streamElementsJs from "../../docs/embedding/streamelements/widget.js?raw";
import { OverlaysPage } from "../../src/dashboard/OverlaysPage";
import { UiProvider as BaseUiProvider } from "../../src/dashboard/ui";
import { ToastHost } from "../../src/dashboard/ui/Toast";
import { dismissToast, toastsSnapshot } from "../../src/dashboard/ui/toast-store";
import { jsonResponse } from "../unit/fixtures";
import { renderWithQuery as render } from "../query-test-utils";

const UiProvider = ({ children }: { children: ReactNode }) => <BaseUiProvider><ToastHost />{children}</BaseUiProvider>;

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
const openActionMenu = async (row: HTMLElement, triggerLabel: string): Promise<HTMLElement> => {
  const trigger = within(row).getByRole("button", { name: triggerLabel });
  fireEvent.click(trigger);
  const menuId = trigger.getAttribute("aria-controls");
  const locateMenu = (): HTMLElement | null => (menuId === null ? null : document.getElementById(menuId)) ?? Array.from(document.querySelectorAll<HTMLElement>("[data-menu-dropdown]"))
    .find((candidate) => candidate.getAttribute("aria-labelledby") === trigger.id) ?? null;
  await waitFor(() => {
    if (locateMenu() === null) throw new Error(`Action menu is missing (controls=${menuId ?? "none"}; trigger=${trigger.id}; dropdowns=${String(document.querySelectorAll("[data-menu-dropdown]").length)}).`);
  });
  const menu = locateMenu();
  if (menu === null) throw new Error("Action menu is missing.");
  return menu;
};
const findToast = async (message: string): Promise<HTMLElement> => {
  const text = await screen.findByText(message);
  const toast = text.closest<HTMLElement>(".ui-toast");
  if (toast === null) throw new Error(`Toast was not found for: ${message}`);
  return toast;
};
const openAccessMenu = async (row: HTMLElement, accessName = "OBS Main PC"): Promise<HTMLElement> => {
  return await openActionMenu(row, `Aktionen für ${accessName}`);
};
const selectAccessAction = async (row: HTMLElement, accessName: string, action: string, triggerLabel = `Aktionen für ${accessName}`): Promise<void> => {
  const menu = await openActionMenu(row, triggerLabel);
  fireEvent.click(within(menu).getByRole("menuitem", { name: action, hidden: true }));
};

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
    for (const toast of toastsSnapshot()) dismissToast(toast.id);
    vi.unstubAllGlobals();
    setBrowserLanguage("de-DE");
  });

  const routeFetcher = (options: {
    conflictDelete?: boolean;
    emptyOverlays?: boolean;
    secondOverlay?: boolean;
    accessLastUsedAt?: string | null;
    accessExpiresAt?: string | null;
    accessRevokedAt?: string | null;
    accessRecoverable?: boolean;
    removeElementOnReplace?: boolean;
    legacyClosingPending?: boolean;
    legacyTokens?: Array<{ id: string; name: string | null; createdAt: string; createdBy: string | null; lastUsedAt: string | null; expiresAt: string | null }>;
  } = {}) => {
    let accesses: AccessFixture[] = [{
      ...access,
      ...(options.accessLastUsedAt === undefined ? {} : { lastUsedAt: options.accessLastUsedAt }),
      ...(options.accessExpiresAt === undefined ? {} : { expiresAt: options.accessExpiresAt }),
      ...(options.accessRevokedAt === undefined ? {} : { revokedAt: options.accessRevokedAt }),
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
        accesses = [...accesses.map((item) => item.tokenId === "access-a" ? { ...item, revokedAt: "2026-09-24T12:00:00.000Z" } : item), {
          ...access, tokenId: "access-replaced", label: "OBS Main PC", recoverable: true,
        }];
        return jsonResponse({ tokenId: "access-replaced", overlayUrl: secret, label: "OBS Main PC 2", expiresAt: null }, 201);
      }
      if (/\/accesses\/[^/]+\/revoke$/u.test(url.pathname) && method === "POST") {
        const tokenId = url.pathname.split("/").at(-2);
        accesses = accesses.map((item) => item.tokenId === tokenId ? { ...item, revokedAt: "2026-09-24T12:00:00.000Z" } : item);
        return new Response(null, { status: 204 });
      }
      if (/\/accesses\/[^/]+$/u.test(url.pathname) && method === "DELETE") {
        const tokenId = url.pathname.split("/").at(-1);
        accesses = accesses.filter((item) => item.tokenId !== tokenId);
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
    setBrowserLanguage("de-DE");
    const fetcher = routeFetcher({ secondOverlay: true, legacyTokens: [{ id: "legacy-token", name: null, createdAt: "2026-09-24T10:00:00.000Z", createdBy: null, lastUsedAt: null, expiresAt: null }] });
    const onOpenEditor = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><OverlaysPage channelId="channel-a" canManage={false} onOpenEditor={onOpenEditor} /></UiProvider>);

    const table = await screen.findByRole("table");
    expect(document.querySelector(".overlays-feedback-slot")).not.toBeInTheDocument();
    expect(table.closest(".overlays-table-wrap")).not.toHaveClass("overlays-table-wrap--inspector-open");
    expect(within(table).getByText("Gameplay")).toBeInTheDocument();
    expect(within(table).getAllByText("1", { selector: "td" })).toHaveLength(2);
    const noLastUsedRow = within(table).getByText("Second scene").closest("tr");
    expect(noLastUsedRow?.querySelector(".table-empty-value")).toHaveAttribute("aria-hidden", "true");
    expect(noLastUsedRow?.querySelector(".sr-only")).toHaveTextContent("kein Wert");
    expect(within(table).queryByText("OBS Main PC")).not.toBeInTheDocument();
    fireEvent.click(within(table).getByText("Gameplay"));
    expect(table.closest(".overlays-table-wrap")).toHaveClass("overlays-table-wrap--inspector-open");

    const inspector = await screen.findByRole("region", { name: "Zugänge" });
    expect(within(inspector).getByText("OBS Main PC", { selector: "strong" })).toBeInTheDocument();
    expect(within(inspector).getByRole("button", { name: "Zugang ausstellen" })).toBeDisabled();
    const accessRow = within(inspector).getByText("OBS Main PC", { selector: "strong" }).closest("li");
    if (!(accessRow instanceof HTMLElement)) throw new Error("Access list row is missing.");
    expect(within(accessRow).getByRole("button", { name: "Link kopieren: OBS Main PC" })).toBeDisabled();
    const menu = await openAccessMenu(accessRow);
    expect(within(menu).getByRole("menuitem", { name: "Einrichten", hidden: true })).toBeEnabled();
    expect(within(menu).getByRole("menuitem", { name: "Link anzeigen", hidden: true })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: "Ersetzen …", hidden: true })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: "Widerrufen …", hidden: true })).toBeDisabled();
    expect(within(accessRow).getByText(/^Zuletzt benutzt:/u)).toHaveTextContent("Zuletzt benutzt: 24.09.2026");
    expect(within(accessRow).getByText("Aktiv").parentElement).toHaveClass("led");
    const fullInspector = document.querySelector(".list-detail__inspector");
    if (!(fullInspector instanceof HTMLElement)) throw new Error("Overlay inspector is missing.");
    expect(within(fullInspector).getByRole("button", { name: "Overlay löschen" })).toBeDisabled();
    expect(within(fullInspector).getByRole("button", { name: "Komposition bearbeiten" })).toBeDisabled();
    expect(within(fullInspector).getAllByText("Nur Broadcaster und Verwalter dürfen Overlays oder Zugänge ändern.")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Importieren" })).toBeDisabled();
    expect(document.querySelector("a[href*='token=']")).toBeNull();
    expect(fetcher.mock.calls.some(([input]) => requestPath(input).includes("/reveal"))).toBe(false);
  });

  it("shows operators why new overlay creation is disabled on the initial view", () => {
    vi.stubGlobal("fetch", routeFetcher({ emptyOverlays: true }));
    render(<UiProvider><OverlaysPage channelId="channel-a" canManage={false} /></UiProvider>);

    const create = screen.getByRole("button", { name: "Neues Overlay" });
    expect(create).toBeDisabled();
    const descriptionId = create.getAttribute("aria-describedby");
    expect(descriptionId).not.toBeNull();
    const reason = descriptionId === null ? null : document.getElementById(descriptionId);
    expect(reason).toHaveTextContent("Nur Broadcaster und Verwalter dürfen Overlays oder Zugänge ändern.");
    expect(reason).toHaveAttribute("role", "note");
  });

  it("shows operators the disabled remove action and its reason for revoked access", async () => {
    vi.stubGlobal("fetch", routeFetcher({ accessRevokedAt: "2026-09-24T12:00:00.000Z" }));
    render(<UiProvider><OverlaysPage channelId="channel-a" canManage={false} /></UiProvider>);
    fireEvent.click(await screen.findByText("Gameplay"));

    const inspector = await screen.findByRole("region", { name: "Zugänge" });
    const revokedSection = within(inspector).getByText("1 widerrufene Zugänge").closest("details");
    if (!(revokedSection instanceof HTMLDetailsElement)) throw new Error("Revoked access section is missing.");
    fireEvent.click(within(revokedSection).getByText("1 widerrufene Zugänge"));
    const row = within(revokedSection).getByText("OBS Main PC", { selector: "strong" }).closest("li");
    if (!(row instanceof HTMLElement)) throw new Error("Revoked access row is missing.");

    expect(within(row).getByText("Nur Broadcaster und Verwalter dürfen Overlays oder Zugänge ändern.", { selector: "[role=note]" })).toBeInTheDocument();
    const menu = await openAccessMenu(row);
    expect(within(menu).getAllByRole("menuitem", { hidden: true })).toHaveLength(1);
    expect(within(menu).getByRole("menuitem", { name: "Entfernen", hidden: true })).toBeDisabled();
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

    expect(await findToast("Overlay „score“ wurde importiert.")).toHaveAttribute("role", "status");
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
    { language: "de-DE", lastUsed: "Zuletzt benutzt: —", noValue: "kein Wert", status: "Aktiv" },
    { language: "en-US", lastUsed: "Last used: —", noValue: "no value", status: "Active" },
  ])("labels access metadata and uses a compact row menu in $language", async ({ language, lastUsed, noValue, status }) => {
    setBrowserLanguage(language);
    vi.stubGlobal("fetch", routeFetcher({ accessLastUsedAt: null }));
    render(<UiProvider><OverlaysPage channelId="channel-a" canManage /></UiProvider>);
    fireEvent.click(await screen.findByText("Gameplay"));

    const inspector = await screen.findByRole("region", { name: language === "en-US" ? "Accesses" : "Zugänge" });
    const accessRow = within(inspector).getByText("OBS Main PC", { selector: "strong" }).closest("li");
    if (!(accessRow instanceof HTMLElement)) throw new Error("Access list row is missing.");
    expect(accessRow.querySelector(".overlay-access-list__last-used")).toHaveTextContent(lastUsed);
    expect(within(accessRow).getByText(noValue)).toHaveClass("sr-only");
    expect(within(accessRow).getByText(status).parentElement).toHaveClass("led");

    const actions = within(accessRow).getAllByRole("button");
    expect(actions).toHaveLength(2);
    expect(within(accessRow).getByRole("button", { name: language === "en-US" ? "Copy link: OBS Main PC" : "Link kopieren: OBS Main PC" })).toBeEnabled();
    expect(within(accessRow).getByRole("button", { name: language === "en-US" ? "Actions for OBS Main PC" : "Aktionen für OBS Main PC" })).toHaveAttribute("aria-haspopup", "menu");
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
      show: "Link anzeigen",
      replace: "Ersetzen …",
      hint: "Link nicht wiederherstellbar – für einen neuen ersetzen.",
    },
    {
      language: "en-US",
      show: "Show link",
      replace: "Replace …",
      hint: "Link cannot be recovered — replace it to issue a new one.",
    },
  ])("disables link reveal for an imported access and explains how to issue a new one in $language", async ({ language, show, replace, hint }) => {
    setBrowserLanguage(language);
    vi.stubGlobal("fetch", routeFetcher({ accessRecoverable: false }));
    render(<UiProvider><OverlaysPage channelId="channel-a" canManage /></UiProvider>);
    fireEvent.click(await screen.findByText("Gameplay"));

    const inspector = await screen.findByRole("region", { name: language === "en-US" ? "Accesses" : "Zugänge" });
    const accessRow = within(inspector).getByText("OBS Main PC", { selector: "strong" }).closest("li");
    if (!(accessRow instanceof HTMLElement)) throw new Error("Access list row is missing.");
    const menu = await openActionMenu(accessRow, language === "en-US" ? "Actions for OBS Main PC" : "Aktionen für OBS Main PC");
    expect(within(menu).getByRole("menuitem", { name: show, hidden: true })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: replace, hidden: true })).toBeEnabled();
    expect(within(accessRow).getByText(hint)).toBeInTheDocument();
  });

  it.each([
    {
      language: "de-DE", status: "Abgelaufen", copy: "Link kopieren: OBS Main PC", trigger: "Aktionen für OBS Main PC",
      show: "Link anzeigen", replace: "Ersetzen …", revoke: "Widerrufen …", title: "Zugang „OBS Main PC“ widerrufen?",
      consequence: "Quellen mit diesem Zugang verlieren sofort den Zugriff.", confirm: "Zugang widerrufen: OBS Main PC",
    },
    {
      language: "en-US", status: "Expired", copy: "Copy link: OBS Main PC", trigger: "Actions for OBS Main PC",
      show: "Show link", replace: "Replace …", revoke: "Revoke …", title: "Revoke access “OBS Main PC”?",
      consequence: "Sources using this access will lose access immediately.", confirm: "Revoke access: OBS Main PC",
    },
  ])("allows an expired access to be revoked with localized confirmation in $language", async ({ language, status, copy, trigger, show, replace, revoke, title, consequence, confirm }) => {
    setBrowserLanguage(language);
    const fetcher = routeFetcher({ accessExpiresAt: "2026-09-24T11:00:00.000Z" });
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><OverlaysPage channelId="channel-a" canManage /></UiProvider>);
    fireEvent.click(await screen.findByText("Gameplay"));

    const inspector = await screen.findByRole("region", { name: language === "de-DE" ? "Zugänge" : "Accesses" });
    const accessRow = within(inspector).getByText("OBS Main PC", { selector: "strong" }).closest("li");
    if (!(accessRow instanceof HTMLElement)) throw new Error("Expired access list row is missing.");
    expect(within(accessRow).getByText(status)).toBeInTheDocument();
    expect(within(accessRow).getByRole("button", { name: copy })).toBeDisabled();
    const menu = await openActionMenu(accessRow, trigger);
    expect(within(menu).getByRole("menuitem", { name: show, hidden: true })).toBeDisabled();
    expect(within(menu).getByRole("menuitem", { name: replace, hidden: true })).toBeEnabled();
    expect(within(menu).getByRole("menuitem", { name: revoke, hidden: true })).toBeEnabled();
    fireEvent.click(within(menu).getByRole("menuitem", { name: revoke, hidden: true }));

    const dialog = await screen.findByRole("dialog", { name: title });
    expect(within(dialog).getByRole("heading")).toHaveTextContent(title);
    expect(dialog).toHaveTextContent(consequence);
    fireEvent.click(within(dialog).getByRole("button", { name: confirm }));
    expect(await findToast(language === "de-DE" ? "Zugang widerrufen." : "Access revoked.")).toHaveAttribute("role", "status");
    expect(fetcher.mock.calls.some(([input, init]) => requestPath(input).endsWith("/access-a/revoke") && init?.method === "POST")).toBe(true);

    const revokedCount = language === "de-DE" ? "1 widerrufene Zugänge" : "1 revoked accesses";
    const revokedSection = within(inspector).getByText(revokedCount).closest("details");
    if (!(revokedSection instanceof HTMLDetailsElement)) throw new Error("Revoked access section is missing.");
    fireEvent.click(within(revokedSection).getByText(revokedCount));
    const revokedRow = within(revokedSection).getByText("OBS Main PC", { selector: "strong" }).closest("li");
    if (!(revokedRow instanceof HTMLElement)) throw new Error("Revoked access row is missing.");
    const revokedMenu = await openActionMenu(revokedRow, trigger);
    const menuItems = within(revokedMenu).getAllByRole("menuitem", { hidden: true });
    expect(menuItems).toHaveLength(1);
    const removeItem = menuItems[0];
    if (removeItem === undefined) throw new Error("Remove action is missing from the revoked access menu.");
    expect(removeItem).toHaveTextContent(language === "de-DE" ? "Entfernen" : "Remove");
    fireEvent.click(removeItem);

    await waitFor(() => {
      expect(fetcher.mock.calls.some(([input, init]) => requestPath(input).endsWith("/access-a") && init?.method === "DELETE")).toBe(true);
    });
    expect(await findToast(language === "de-DE" ? "Zugang entfernt." : "Access removed.")).toHaveAttribute("role", "status");
    expect(screen.queryByRole("dialog", { name: /Entfernen|Remove/u })).not.toBeInTheDocument();
    expect(within(revokedSection).queryByText("OBS Main PC", { selector: "strong" })).not.toBeInTheDocument();
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
    const issuedRow = within(inspector).getByText("OBS Backup PC", { selector: "strong" }).closest("li");
    if (!(issuedRow instanceof HTMLElement)) throw new Error("Issued access list row is missing.");
    fireEvent.click(within(issuedRow).getByRole("button", { name: "Link kopieren: OBS Backup PC" }));
    await vi.waitFor(() => { expect(writeText).toHaveBeenCalledWith(secret); });

    const originalAccess = within(inspector).getByText("OBS Main PC", { selector: "strong" }).closest("li");
    if (!(originalAccess instanceof HTMLElement)) throw new Error("Access list row is missing.");
    fireEvent.click(within(originalAccess).getByRole("button", { name: "Link kopieren: OBS Main PC" }));
    await vi.waitFor(() => { expect(writeText).toHaveBeenCalledWith(secret); });
    await waitFor(() => expect(within(originalAccess).getByRole("button", { name: "Kopiert: OBS Main PC" })).toBeInTheDocument());
    expect(originalAccess.querySelector(".overlay-access-list__expanded")).toBeNull();
    expect(within(originalAccess).queryByText(secret)).not.toBeInTheDocument();

    await selectAccessAction(originalAccess, "OBS Main PC", "Link anzeigen");
    await vi.waitFor(() => { expect(fetcher.mock.calls.some(([input]) => requestPath(input).includes("/access-a/reveal"))).toBe(true); });
    expect(await screen.findByText(secret)).toBeInTheDocument();
    await selectAccessAction(originalAccess, "OBS Main PC", "Ersetzen …");
    const replaceDialog = await screen.findByRole("dialog");
    expect(within(replaceDialog).getByRole("heading")).toHaveTextContent("Zugang „OBS Main PC“ ersetzen?");
    expect(replaceDialog).toHaveTextContent("Der bisherige Link wird ungültig und verbundene Quellen verlieren den Zugriff.");
    fireEvent.click(within(replaceDialog).getByRole("button", { name: "Zugang ersetzen: OBS Main PC" }));
    await vi.waitFor(() => { expect(fetcher.mock.calls.some(([input]) => requestPath(input).includes("/access-a/replace"))).toBe(true); });
    expect(await screen.findByText(maskedSecret)).toBeInTheDocument();
    expect(fetcher.mock.calls.some(([input]) => requestPath(input).includes("/access-a/replace"))).toBe(true);
    const revokedSection = inspector.querySelector(".overlay-access-revoked");
    expect(revokedSection).not.toBeNull();
    expect(within(revokedSection as HTMLElement).getByText("OBS Main PC", { selector: "strong" })).toBeInTheDocument();

    const replacementRow = Array.from(inspector.querySelectorAll<HTMLElement>(".overlay-access-list__item"))
      .find((row) => !row.classList.contains("overlay-access-list__item--revoked") && row.querySelector("strong")?.textContent === "OBS Main PC");
    if (!(replacementRow instanceof HTMLElement)) throw new Error("Replacement access list row is missing.");
    await selectAccessAction(replacementRow, "OBS Main PC", "Widerrufen …");
    const dialog = await screen.findByRole("dialog", { name: "Zugang „OBS Main PC“ widerrufen?" });
    expect(within(dialog).getByRole("heading")).toHaveTextContent("Zugang „OBS Main PC“ widerrufen?");
    expect(dialog).toHaveTextContent("Quellen mit diesem Zugang verlieren sofort den Zugriff.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Zugang widerrufen: OBS Main PC" }));
    expect(await findToast("Zugang widerrufen.")).toHaveAttribute("role", "status");
    expect(fetcher.mock.calls.some(([input]) => requestPath(input).endsWith("/access-replaced/revoke"))).toBe(true);
  });

  it("lets a manager reveal the current overlay link in its row when clipboard access is denied", async () => {
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

    const issuedRow = within(inspector).getByText("OBS Backup PC", { selector: "strong" }).closest("li");
    if (!(issuedRow instanceof HTMLElement)) throw new Error("Issued access list row is missing.");
    fireEvent.click(within(issuedRow).getByRole("button", { name: "Link kopieren: OBS Backup PC" }));
    expect(await screen.findAllByText("Der Link konnte nicht kopiert werden.")).not.toHaveLength(0);
    await selectAccessAction(issuedRow, "OBS Backup PC", "Link anzeigen");
    expect(within(issuedRow).getByText(secret)).toBeInTheDocument();

    fireEvent.click(within(table).getByText("Second scene"));
    await screen.findByRole("heading", { name: "Second scene" });
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
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
    expect(within(dialog).getByRole("heading")).toHaveTextContent("Overlay „Gameplay“ löschen?");
    expect(dialog).toHaveTextContent("Das Overlay mit seinen Elementen wird gelöscht und alle Zugänge werden widerrufen.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Overlay löschen: Gameplay" }));

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
    const accessRow = within(inspector).getByText("OBS Main PC", { selector: "strong" }).closest("li");
    if (!(accessRow instanceof HTMLElement)) throw new Error("Access list row is missing.");
    await selectAccessAction(accessRow, "OBS Main PC", "Einrichten");
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
    const accessRow = within(inspector).getByText("OBS Main PC", { selector: "strong" }).closest("li");
    if (!(accessRow instanceof HTMLElement)) throw new Error("Access list row is missing.");
    await selectAccessAction(accessRow, "OBS Main PC", "Einrichten");
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
    const accessRow = within(inspector).getByText("OBS Main PC", { selector: "strong" }).closest("li");
    if (!(accessRow instanceof HTMLElement)) throw new Error("Access list row is missing.");
    await selectAccessAction(accessRow, "OBS Main PC", "Einrichten");
    const assistant = within(inspector).getByRole("region", { name: "Einrichtungsassistent" });
    const output = within(assistant).getByRole("combobox", { name: "Ausgabe" });
    fireEvent.click(output);
    fireEvent.click(await screen.findByRole("option", { name: "Einzelnes Element: Score" }));
    expect(assistant).toHaveTextContent("Breite ≈ Elementbreite × Skalierung; Höhe nach Inhalt.");
    expect(assistant).toHaveTextContent("#token=••••••&element=element-a");

    fireEvent.click(within(assistant).getByRole("button", { name: "Overlay-Link kopieren" }));
    await vi.waitFor(() => { expect(writeText).toHaveBeenLastCalledWith(`${secret}&element=element-a`); });
    expect(fetcher.mock.calls.some(([input]) => requestPath(input).endsWith("/access-a/reveal"))).toBe(true);
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
    const setupRow = within(inspector).getByText("OBS Main PC", { selector: "strong" }).closest("li");
    if (!(setupRow instanceof HTMLElement)) throw new Error("Access list row is missing.");
    await selectAccessAction(setupRow, "OBS Main PC", "Einrichten");
    const assistant = within(inspector).getByRole("region", { name: "Einrichtungsassistent" });
    const output = within(assistant).getByRole("combobox", { name: "Ausgabe" });
    fireEvent.click(output);
    fireEvent.click(await screen.findByRole("option", { name: "Einzelnes Element: Score" }));

    const accessRow = within(inspector).getByText("OBS Main PC", { selector: "strong" }).closest("li");
    if (!(accessRow instanceof HTMLElement)) throw new Error("Access list row is missing.");
    await selectAccessAction(accessRow, "OBS Main PC", "Ersetzen …");
    const replaceDialog = await screen.findByRole("dialog");
    fireEvent.click(within(replaceDialog).getByRole("button", { name: "Zugang ersetzen: OBS Main PC" }));
    await vi.waitFor(() => { expect(fetcher.mock.calls.some(([input]) => requestPath(input).endsWith("/access-a/replace"))).toBe(true); });
    const refreshedAssistant = within(inspector).getByRole("region", { name: "Einrichtungsassistent" });
    const refreshedOutput = within(refreshedAssistant).getByRole("combobox", { name: "Ausgabe" });
    await vi.waitFor(() => { expect(refreshedOutput).toHaveValue("Ganzes Overlay"); });
    expect(refreshedAssistant).toHaveTextContent("Breite und Höhe: 1920 × 1080 px");

    fireEvent.click(within(refreshedAssistant).getByRole("button", { name: "Overlay-Link kopieren" }));
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

  it("shows operators disabled access actions with one reason", async () => {
    const fetcher = routeFetcher();
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><OverlaysPage channelId="channel-a" canManage={false} /></UiProvider>);
    fireEvent.click(await screen.findByText("Gameplay"));
    const inspector = await screen.findByRole("region", { name: "Zugänge" });
    const accessRow = within(inspector).getByText("OBS Main PC", { selector: "strong" }).closest("li");
    if (!(accessRow instanceof HTMLElement)) throw new Error("Access list row is missing.");
    const fullInspector = document.querySelector(".list-detail__inspector");
    if (!(fullInspector instanceof HTMLElement)) throw new Error("Overlay inspector is missing.");
    expect(within(fullInspector).getAllByText("Nur Broadcaster und Verwalter dürfen Overlays oder Zugänge ändern.")).toHaveLength(1);
    expect(within(accessRow).getByRole("button", { name: "Link kopieren: OBS Main PC" })).toBeDisabled();
    const menu = await openAccessMenu(accessRow);
    expect(within(menu).getByRole("menuitem", { name: "Einrichten", hidden: true })).toBeEnabled();
    for (const action of ["Link anzeigen", "Ersetzen …", "Widerrufen …"]) {
      expect(within(menu).getByRole("menuitem", { name: action, hidden: true })).toBeDisabled();
    }
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Einrichten", hidden: true }));
    const assistant = within(inspector).getByRole("region", { name: "Einrichtungsassistent" });
    expect(within(assistant).getByText(/overlay#token=••••••/u)).toBeInTheDocument();
    expect(within(assistant).getByRole("button", { name: "Overlay-Link kopieren" })).toBeDisabled();
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
    const accessRow = within(inspector).getByText("OBS Main PC", { selector: "strong" }).closest("li");
    if (!(accessRow instanceof HTMLElement)) throw new Error("Access list row is missing.");
    await selectAccessAction(accessRow, "OBS Main PC", language === "de-DE" ? "Einrichten" : "Set up", language === "de-DE" ? "Aktionen für OBS Main PC" : "Actions for OBS Main PC");
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

    const legacy = await screen.findByRole("region", { name: "Alte Links" });
    fireEvent.click(await within(legacy).findByText("Alte Links (1)"));
    expect(within(legacy).getByText("Unbenannter Alt-Link")).toBeInTheDocument();
    expect(legacy).toHaveTextContent("Link-ID: legacy-a");
    const legacyRow = within(legacy).getByRole("listitem");
    const menu = await openActionMenu(legacyRow, "Aktionen für Unbenannter Alt-Link legacy-a");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Widerrufen …", hidden: true }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("legacy-a");
    expect(within(dialog).getByRole("heading")).toHaveTextContent("Alten Link „Unbenannter Alt-Link (legacy-a)“ widerrufen?");
    fireEvent.click(within(dialog).getByRole("button", { name: "Alten Link widerrufen: Unbenannter Alt-Link (legacy-a)" }));
    expect(await findToast("Zugang widerrufen.")).toHaveAttribute("role", "status");
    const revoke = fetcher.mock.calls.find(([input, init]) => requestPath(input).endsWith("/legacy-access-a/revoke") && init?.method === "POST");
    expect(revoke?.[1]?.body).toContain("Über Alte Links im Dashboard widerrufen");
    expect(within(legacy).getByText("Keine ungebundenen alten Links.")).toBeInTheDocument();
  });

  it.each([
    ["de-DE", "Zugang widerrufen. Verbundene Quellen werden noch geschlossen.", "Alten Link widerrufen: Unbenannter Alt-Link (bbbbbbbb)"],
    ["en-US", "Access revoked. Connected sources are still closing.", "Revoke legacy link: Unnamed legacy link (bbbbbbbb)"],
  ])("shows the pending closure message and token identity after legacy revocation in %s", async (language, pendingMessage, confirmLabel) => {
    setBrowserLanguage(language);
    const fetcher = routeFetcher({ emptyOverlays: true, legacyClosingPending: true, legacyTokens: [
      { id: "aaaaaaaa-first", name: null, createdAt: "2026-09-24T10:00:00.000Z", createdBy: "Test manager", lastUsedAt: null, expiresAt: null },
      { id: "bbbbbbbb-second", name: null, createdAt: "2026-09-24T10:00:00.000Z", createdBy: "Test manager", lastUsedAt: null, expiresAt: null },
    ] });
    vi.stubGlobal("fetch", fetcher);
    render(<UiProvider><OverlaysPage channelId="channel-a" canManage /></UiProvider>);

    const legacy = await screen.findByRole("region", { name: language === "de-DE" ? "Alte Links" : "Legacy links" });
    fireEvent.click(await within(legacy).findByText(language === "de-DE" ? "Alte Links (2)" : "Legacy links (2)"));
    const targetRow = within(legacy).getAllByRole("listitem").find((row) => row.textContent.includes("bbbbbbbb"));
    if (!(targetRow instanceof HTMLElement)) throw new Error("Target legacy link row is missing.");
    expect(legacy).toHaveTextContent(`${language === "de-DE" ? "Link-ID" : "Link ID"}: aaaaaaaa`);
    const legacyMenuLabel = language === "de-DE" ? "Aktionen für Unbenannter Alt-Link bbbbbbbb" : "Actions for Unnamed legacy link bbbbbbbb";
    const menu = await openActionMenu(targetRow, legacyMenuLabel);
    fireEvent.click(within(menu).getByRole("menuitem", { name: language === "de-DE" ? "Widerrufen …" : "Revoke …", hidden: true }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("bbbbbbbb");
    expect(dialog).not.toHaveTextContent("aaaaaaaa");
    fireEvent.click(within(dialog).getByRole("button", { name: confirmLabel }));

    expect(await findToast(pendingMessage)).toHaveAttribute("role", "status");
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
    const issuedRow = within(inspector).getByText("OBS Backup PC", { selector: "strong" }).closest("li");
    if (!(issuedRow instanceof HTMLElement)) throw new Error("Issued access list row is missing.");
    await selectAccessAction(issuedRow, "OBS Backup PC", "Link anzeigen");
    expect(within(issuedRow).getByText(secret)).toBeInTheDocument();

    page.rerender(<UiProvider><OverlaysPage channelId="channel-a" canManage={false} /></UiProvider>);
    expect(screen.queryByText(maskedSecret)).not.toBeInTheDocument();
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
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
    const row = within(inspector).getByText("OBS Main PC", { selector: "strong" }).closest("li");
    if (!(row instanceof HTMLElement)) throw new Error("Access row is missing.");
    await selectAccessAction(row, "OBS Main PC", "Link anzeigen");
    await vi.waitFor(() => { expect(resolveReveal).toBeTypeOf("function"); });
    fireEvent.click(within(table).getByText("Second scene"));
    await vi.waitFor(() => { expect(fetcher.mock.calls.some(([input]) => requestPath(input).endsWith("/overlays/overlay-b/accesses"))).toBe(true); });
    act(() => { resolveReveal?.(jsonResponse({ overlayUrl: secret })); });

    expect(screen.queryByText(maskedSecret)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Link kopieren: OBS Main PC" })).not.toBeInTheDocument();
  });
});
