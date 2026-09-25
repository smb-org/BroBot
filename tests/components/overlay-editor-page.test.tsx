import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardApp } from "../../src/dashboard/main";
import { OverlayCanvas } from "../../src/overlay/canvas";
import { jsonResponse } from "../unit/fixtures";

const channel = {
  channelId: "kanal-a", login: "kanal-a", displayName: "Alpha", language: "en", role: "manager",
  broadcasterConnection: "connected", channelBotConsent: "granted",
  bot: { status: "connected", reason: null, updatedAt: "2026-09-24T10:00:00.000Z" },
  moderator: { isModerator: true, checkedAt: "2026-09-24T10:00:00.000Z", reason: null },
  chatSubscription: { status: "enabled", subscriptionId: "sub-a", reason: null, updatedAt: "2026-09-24T10:00:00.000Z" },
  tokens: { botExpiresAt: "2099-09-24T10:00:00.000Z", loginStatus: "connected", loginReason: null, loginExpiresAt: "2099-09-24T10:00:00.000Z" },
  streamState: "offline", streamStartedAt: null,
  controls: {
    mute: { active: false, until: null, mode: null },
    pause: { active: false, until: null, mode: null },
  },
  lastError: null,
};

const initialOverlay = {
  id: "overlay-a", channelId: "kanal-a", name: "Gameplay", width: 1280, height: 720, css: ".brobot-variable { color: rgb(1, 2, 3); }", revision: 4,
  createdAt: "2026-09-24T10:00:00.000Z", updatedAt: "2026-09-24T10:00:00.000Z",
  elements: [{ id: "element-a", kind: "variable", label: "Score", variableName: "score", text: "Score: {value}", config: {}, x: 24, y: 32, scalePercent: 100, z: 0, inComposition: true }],
};

const variable = {
  channelId: "kanal-a", name: "score", value: 1234, description: "Current score", resetOnStreamStart: false,
  createdAt: "2026-09-24T00:00:00.000Z", updatedAt: "2026-09-24T00:00:00.000Z", usages: [],
};

const requestUrl = (input: RequestInfo | URL): URL => input instanceof Request
  ? new URL(input.url)
  : input instanceof URL ? input : new URL(input, window.location.origin);

interface WindowWithElementConstructor { Element: typeof Element }

const previewFrameWindow = (): WindowWithElementConstructor => {
  const frame = document.querySelector<HTMLIFrameElement>('[data-testid="overlay-editor-renderer"]');
  if (frame?.contentWindow == null) throw new Error("Overlay preview frame window is missing.");
  return frame.contentWindow as unknown as WindowWithElementConstructor;
};

// jsdom never lays elements out, so `getBoundingClientRect()` always reports {0, 0}; this stubs it
// for one overlay element (matched by the `data-element` attribute `OverlayCanvas` sets) so reclamp
// effects have a real size to react to. `sizeAt` can read the element's own inline style (e.g. its
// `transform: scale(...)`) to reflect a scale change. The preview renders inside an <iframe>, which
// is its own realm with its own `Element` class distinct from the top-level document's, so the
// patch has to target that frame's own prototype (and can only be installed once it exists).
const stubMeasuredElementSize = (frameWindow: WindowWithElementConstructor, elementId: string, sizeAt: (element: HTMLElement) => { width: number; height: number }): void => {
  vi.spyOn(frameWindow.Element.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const { width, height } = this.dataset.element === elementId ? sizeAt(this) : { width: 0, height: 0 };
    return { x: 0, y: 0, left: 0, top: 0, right: width, bottom: height, width, height, toJSON: () => ({}) };
  });
};

describe("Overlay composition editor", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });
  });

  it("formats preview values with the channel language instead of the browser locale", async () => {
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });
    let savedOverlay = initialOverlay;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a" && method === "GET") return Promise.resolve(jsonResponse({ overlay: savedOverlay }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a" && method === "PUT") {
        const requestBody = init?.body;
        if (typeof requestBody !== "string") throw new Error("Overlay save body must be JSON text.");
        const body = JSON.parse(requestBody) as { baseRevision: number; elements: typeof initialOverlay.elements };
        savedOverlay = { ...savedOverlay, revision: savedOverlay.revision + 1, elements: body.elements };
        return Promise.resolve(jsonResponse({ overlay: savedOverlay }));
      }
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      return Promise.reject(new Error(`Unexpected request ${method} ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/overlays/overlay-a");
    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Gameplay", level: 1 })).toBeInTheDocument();
    const previewFrame = document.querySelector<HTMLIFrameElement>('[data-testid="overlay-editor-renderer"]');
    await waitFor(() => expect(previewFrame?.contentDocument?.querySelector(".brobot-variable")).toHaveTextContent("Score: 1,234"));
    const previewDocument = previewFrame?.contentDocument;
    const canvas = previewDocument?.getElementById("root");
    const element = previewDocument?.querySelector<HTMLElement>('[data-element="element-a"]');
    if (canvas === null || canvas === undefined || element === null || element === undefined) throw new Error("Overlay preview canvas is missing.");
    expect(previewFrame).toHaveStyle({ width: "1280px", height: "720px" });
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720, toJSON: () => ({}),
    });
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
      x: 24, y: 32, left: 24, top: 32, right: 324, bottom: 132, width: 300, height: 100, toJSON: () => ({}),
    });
    const fetchCount = fetcher.mock.calls.length;

    fireEvent.pointerDown(element, { pointerId: 1, button: 0, clientX: 24, clientY: 32 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 29, clientY: 39 });
    fireEvent.pointerUp(canvas, { pointerId: 1, clientX: 29, clientY: 39 });
    expect(screen.getByRole("spinbutton", { name: "X (px)" })).toHaveValue("29");
    expect(screen.getByRole("spinbutton", { name: "Y (px)" })).toHaveValue("39");
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    fireEvent.keyDown(canvas, { key: "ArrowDown", shiftKey: true });
    expect(screen.getByRole("spinbutton", { name: "X (px)" })).toHaveValue("30");
    expect(screen.getByRole("spinbutton", { name: "Y (px)" })).toHaveValue("49");

    const elementAfterKeyboard = previewDocument?.querySelector<HTMLElement>('[data-element="element-a"]');
    if (elementAfterKeyboard === null || elementAfterKeyboard === undefined) throw new Error("Updated overlay preview element is missing.");
    vi.spyOn(elementAfterKeyboard, "getBoundingClientRect").mockReturnValue({
      x: 30, y: 49, left: 30, top: 49, right: 330, bottom: 149, width: 300, height: 100, toJSON: () => ({}),
    });
    fireEvent.pointerDown(elementAfterKeyboard, { pointerId: 2, pointerType: "touch", button: 0, clientX: 30, clientY: 49 });
    fireEvent.pointerMove(canvas, { pointerId: 2, pointerType: "touch", clientX: 2000, clientY: 2000 });
    fireEvent.pointerUp(canvas, { pointerId: 2, pointerType: "touch" });
    expect(screen.getByRole("spinbutton", { name: "X (px)" })).toHaveValue("980");
    expect(screen.getByRole("spinbutton", { name: "Y (px)" })).toHaveValue("620");
    const elementAfterTouch = previewDocument?.querySelector<HTMLElement>('[data-element="element-a"]');
    if (elementAfterTouch === null || elementAfterTouch === undefined) throw new Error("Touched overlay preview element is missing.");
    vi.spyOn(elementAfterTouch, "getBoundingClientRect").mockReturnValue({
      x: 980, y: 620, left: 980, top: 620, right: 1280, bottom: 720, width: 300, height: 100, toJSON: () => ({}),
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "X (px)" }), { target: { value: "30" } });
    const elementAfterXChange = previewDocument?.querySelector<HTMLElement>('[data-element="element-a"]');
    if (elementAfterXChange === null || elementAfterXChange === undefined) throw new Error("Updated overlay preview element is missing.");
    vi.spyOn(elementAfterXChange, "getBoundingClientRect").mockReturnValue({
      x: 30, y: 620, left: 30, top: 620, right: 330, bottom: 720, width: 300, height: 100, toJSON: () => ({}),
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Y (px)" }), { target: { value: "49" } });
    expect(screen.getByRole("spinbutton", { name: "X (px)" })).toHaveValue("30");
    expect(screen.getByRole("spinbutton", { name: "Y (px)" })).toHaveValue("49");
    expect(fetcher).toHaveBeenCalledTimes(fetchCount);

    const firstDraftElement = savedOverlay.elements[0];
    if (firstDraftElement === undefined) throw new Error("Overlay test element is missing.");
    const outputDraft = { ...savedOverlay, elements: [{ ...firstDraftElement, x: 30, y: 49 }] };
    const output = render(<OverlayCanvas
      overlay={{ id: outputDraft.id, revision: outputDraft.revision, width: outputDraft.width, height: outputDraft.height, css: outputDraft.css, elements: outputDraft.elements }}
      language="en"
      variables={{ score: 1234 }}
      elementId={null}
    />);
    const previewMarkup = previewDocument?.querySelector(".brobot-overlay")?.outerHTML;
    const outputMarkup = output.container.querySelector(".brobot-overlay")?.outerHTML;
    expect(previewMarkup).toBe(outputMarkup);
    expect(previewDocument?.querySelector("style[data-brobot-overlay-css]")?.textContent).toContain(".brobot-variable");
    expect(previewMarkup).toMatchInlineSnapshot(`"<div class="brobot-overlay" style="position: relative; width: 1280px; height: 720px;"><div data-element="element-a" data-kind="variable" class="brobot-overlay-composition-element" style="position: absolute; left: 30px; top: 49px; width: max-content; transform: scale(1); transform-origin: top left; z-index: 0;"><div class="brobot-variable" data-variable="score"><span class="brobot-variable__text">Score: </span><span class="brobot-variable__value">1,234</span></div></div></div>"`);
    output.unmount();

    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(fetcher.mock.calls.filter(([input, init]) => requestUrl(input).pathname.endsWith("/overlays/overlay-a") && init?.method === "PUT")).toHaveLength(1));
    const put = fetcher.mock.calls.find(([input, init]) => requestUrl(input).pathname.endsWith("/overlays/overlay-a") && init?.method === "PUT");
    if (put === undefined) throw new Error("Overlay save request is missing.");
    const requestBody = put[1]?.body;
    if (typeof requestBody !== "string") throw new Error("Overlay save body must be JSON text.");
    const body = JSON.parse(requestBody) as { baseRevision: number; elements: Array<{ x: number; y: number }> };
    expect(body.baseRevision).toBe(4);
    expect(body.elements[0]).toMatchObject({ x: 30, y: 49 });
  });

  it("consumes a variable deep link into an unsaved draft", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a") return Promise.resolve(jsonResponse({ overlay: initialOverlay }));
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      return Promise.reject(new Error(`Unexpected request ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/overlays/overlay-a?variable=score");

    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Gameplay", level: 1 })).toBeInTheDocument();
    await waitFor(() => expect(document.querySelectorAll(".overlay-editor__element-list li")).toHaveLength(2));
    expect(window.location.search).toBe("");
    expect(screen.getByRole("button", { name: "Speichern" })).toBeEnabled();
    expect(fetcher.mock.calls.filter(([input, init]) => requestUrl(input).pathname.endsWith("/overlays/overlay-a") && init?.method === "PUT")).toHaveLength(0);
  });

  it("keeps a new overlay local until Save and drops it when discarded", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      if (url.pathname === "/api/channels/kanal-a/overlays") return Promise.resolve(jsonResponse({ overlays: [], maximum: 20, elementMaximum: 20 }));
      return Promise.reject(new Error(`Unexpected request ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/variables");
    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Kanalvariablen", level: 1 })).toBeInTheDocument();
    fireEvent.click(screen.getByText("{var.score}"));
    fireEvent.click(await screen.findByRole("button", { name: "In Overlay verwenden" }));
    fireEvent.click(await screen.findByRole("button", { name: "Editor öffnen" }));
    expect(await screen.findByRole("heading", { name: "Overlay score", level: 1 })).toBeInTheDocument();
    expect(fetcher.mock.calls.filter(([input, init]) => requestUrl(input).pathname === "/api/channels/kanal-a/overlays" && init?.method === "POST")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Entwurf verwerfen" }));
    fireEvent.click(screen.getByRole("button", { name: "Zurück zu Overlays" }));
    expect(await screen.findByRole("heading", { name: "Overlays", level: 1 })).toBeInTheDocument();
    expect(fetcher.mock.calls.filter(([input, init]) => requestUrl(input).pathname === "/api/channels/kanal-a/overlays" && init?.method === "POST")).toHaveLength(0);
  });

  it("creates a new overlay only when Save is pressed", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      if (url.pathname === "/api/channels/kanal-a/overlays" && init?.method === "POST") {
        if (typeof init.body !== "string") throw new Error("Overlay create body must be JSON text.");
        const body = JSON.parse(init.body) as { name: string; width: number; height: number; initialElement?: typeof initialOverlay.elements[number] };
        return Promise.resolve(jsonResponse({ overlay: {
          ...initialOverlay,
          id: "overlay-new", name: body.name, width: body.width, height: body.height, css: "", revision: 1,
          elements: body.initialElement === undefined ? [] : [body.initialElement],
        } }, 201));
      }
      return Promise.reject(new Error(`Unexpected request ${init?.method ?? "GET"} ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/overlays/new?name=Overlay+score&variable=score");
    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Overlay score", level: 1 })).toBeInTheDocument();
    expect(fetcher.mock.calls.filter(([input, init]) => requestUrl(input).pathname === "/api/channels/kanal-a/overlays" && init?.method === "POST")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(fetcher.mock.calls.filter(([input, init]) => requestUrl(input).pathname === "/api/channels/kanal-a/overlays" && init?.method === "POST")).toHaveLength(1));
    expect(fetcher.mock.calls.filter(([input, init]) => requestUrl(input).pathname === "/api/channels/kanal-a/overlays/overlay-new" && init?.method === "PUT")).toHaveLength(0);
  });

  it("shows operator add, remove and Save actions disabled with the read-only reason", async () => {
    const operatorChannel = { ...channel, role: "operator" };
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [operatorChannel], bot: channel.bot }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a") return Promise.resolve(jsonResponse({ overlay: initialOverlay }));
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      return Promise.reject(new Error(`Unexpected request ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/overlays/overlay-a");
    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Gameplay", level: 1 })).toBeInTheDocument();
    const reason = screen.getByText("Bediener können die Komposition ansehen, aber nicht ändern.");
    expect(reason).toHaveTextContent("Bediener können die Komposition ansehen, aber nicht ändern.");
    expect(reason).toHaveAttribute("id", "overlay-editor-readonly-reason");
    const actions = [
      screen.getByRole("button", { name: "Variable anzeigen" }),
      screen.getByRole("button", { name: "Element entfernen" }),
      screen.getByRole("button", { name: "Speichern" }),
    ];
    for (const action of actions) {
      expect(action).toBeDisabled();
      expect(action).toHaveAttribute("aria-describedby", "overlay-editor-readonly-reason");
    }
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
  });

  it("clamps a hidden element back on-canvas once shown, using its real rendered size", async () => {
    // While `inComposition: false`, the element is not rendered, so the X/Y fields allowed the
    // full canvas range and a value chosen while hidden could leave it off-canvas once shown.
    // Its real rendered size (300x40) is wider than the 40x40 fallback used at toggle time, so
    // the fallback clamp alone would still leave part of it clipped past the canvas edge.
    const hiddenElement = {
      id: "element-hidden", kind: "variable", label: "Hidden", variableName: "score",
      text: "Hidden: {value}", config: {}, x: 1270, y: 700, scalePercent: 100, z: 1, inComposition: false,
    };
    const overlayWithHiddenElement = { ...initialOverlay, elements: [hiddenElement, initialOverlay.elements[0]] };
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a") return Promise.resolve(jsonResponse({ overlay: overlayWithHiddenElement }));
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      return Promise.reject(new Error(`Unexpected request ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/overlays/overlay-a");
    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Gameplay", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "X (px)" })).toHaveValue("1270");
    expect(screen.getByRole("spinbutton", { name: "Y (px)" })).toHaveValue("700");
    stubMeasuredElementSize(previewFrameWindow(), "element-hidden", () => ({ width: 300, height: 40 }));

    const toggleRow = screen.getByText("In der Komposition anzeigen").closest(".ui-switch-field__row");
    const toggle = toggleRow?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (toggle === null || toggle === undefined) throw new Error("Composition toggle is missing.");
    fireEvent.click(toggle);

    // Reclamped against the real 300x40 size once measured, fully inside the 1280x720 canvas
    // (not left at 1240/680, which is only where the 40x40 fallback clamp would have put it).
    expect(screen.getByRole("spinbutton", { name: "X (px)" })).toHaveValue("980");
    expect(screen.getByRole("spinbutton", { name: "Y (px)" })).toHaveValue("680");
  });

  it("reclamps position when a scale increase would push the element past the canvas edge", async () => {
    const nearEdgeElement = {
      id: "element-near-edge", kind: "variable", label: "Near edge", variableName: "score",
      text: "Near: {value}", config: {}, x: 900, y: 100, scalePercent: 100, z: 1, inComposition: true,
    };
    const overlayWithNearEdgeElement = { ...initialOverlay, elements: [nearEdgeElement, initialOverlay.elements[0]] };
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a") return Promise.resolve(jsonResponse({ overlay: overlayWithNearEdgeElement }));
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      return Promise.reject(new Error(`Unexpected request ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/overlays/overlay-a");
    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Gameplay", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "X (px)" })).toHaveValue("900");
    // The rendered box grows with `scalePercent`, mirroring the `transform: scale(...)` OverlayCanvas applies.
    stubMeasuredElementSize(previewFrameWindow(), "element-near-edge", (element) => {
      const factor = Number(/scale\(([\d.]+)\)/.exec(element.style.transform)?.[1] ?? "1");
      return { width: 300 * factor, height: 40 * factor };
    });

    fireEvent.change(screen.getByRole("spinbutton", { name: "Skalierung (%)" }), { target: { value: "200" } });

    // At 2x scale the element is 600px wide; 900 + 600 exceeds the 1280px canvas, so it is pulled back to fit.
    expect(screen.getByRole("spinbutton", { name: "X (px)" })).toHaveValue("680");
  });

  it("keeps a changed draft when a revision conflict is resolved", async () => {
    let putCount = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a" && (init?.method ?? "GET") === "GET") return Promise.resolve(jsonResponse({ overlay: initialOverlay }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a" && init?.method === "PUT") {
        putCount++;
        if (putCount === 1) return Promise.resolve(jsonResponse({ error: "overlay_changed_concurrently", currentRevision: 5 }, 409));
        if (typeof init.body !== "string") throw new Error("Overlay save body must be JSON text.");
        const body = JSON.parse(init.body) as { elements: typeof initialOverlay.elements };
        return Promise.resolve(jsonResponse({ overlay: { ...initialOverlay, revision: 6, elements: body.elements } }));
      }
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      return Promise.reject(new Error(`Unexpected request ${init?.method ?? "GET"} ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/overlays/overlay-a");
    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Gameplay", level: 1 })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Elementname" }), { target: { value: "Score label" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(await screen.findByRole("dialog", { name: "Overlay wurde geändert" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Überschreiben" }));
    await waitFor(() => expect(putCount).toBe(2));
    expect(screen.getByRole("textbox", { name: "Elementname" })).toHaveValue("Score label");
  });

  it("holds navigation while a direct save is in flight", async () => {
    let finishSave: () => void = () => { throw new Error("Overlay save did not start."); };
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a" && (init?.method ?? "GET") === "GET") return Promise.resolve(jsonResponse({ overlay: initialOverlay }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a" && init?.method === "PUT") {
        const requestBody = init.body;
        if (typeof requestBody !== "string") throw new Error("Overlay save body must be JSON text.");
        const body = JSON.parse(requestBody) as { elements: typeof initialOverlay.elements };
        return new Promise<Response>((resolve) => {
          finishSave = () => { resolve(jsonResponse({ overlay: { ...initialOverlay, revision: 5, elements: body.elements } })); };
        });
      }
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      return Promise.reject(new Error(`Unexpected request ${init?.method ?? "GET"} ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/overlays/overlay-a");
    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Gameplay", level: 1 })).toBeInTheDocument();
    const xField = await screen.findByRole("spinbutton", { name: "X (px)" });
    fireEvent.change(xField, { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    await waitFor(() => expect(fetcher.mock.calls.filter(([input, init]) => requestUrl(input).pathname.endsWith("/overlays/overlay-a") && init?.method === "PUT")).toHaveLength(1));

    const navigation = screen.getByRole("navigation", { name: "Hauptnavigation" });
    fireEvent.click(within(navigation).getByRole("link", { name: "Variablen" }));
    const guard = await screen.findByRole("dialog", { name: "Ungespeicherte Änderungen" });
    expect(within(guard).getByRole("button", { name: "Verwerfen und verlassen" })).toBeDisabled();
    finishSave();

    await waitFor(() => expect(within(guard).getByRole("button", { name: "Verwerfen und verlassen" })).toBeEnabled());
    expect(within(guard).queryByRole("button", { name: "Speichern und verlassen" })).not.toBeInTheDocument();
    fireEvent.click(within(guard).getByRole("button", { name: "Verwerfen und verlassen" }));
    expect(await screen.findByRole("heading", { name: "Kanalvariablen", level: 1 })).toBeInTheDocument();
    expect(fetcher.mock.calls.filter(([input, init]) => requestUrl(input).pathname.endsWith("/overlays/overlay-a") && init?.method === "PUT")).toHaveLength(1);
  });
});
