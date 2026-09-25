import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardApp } from "../../src/dashboard/main";
import { generateOverlayStyleBlock, OVERLAY_STYLE_BEGIN_MARKER, OVERLAY_STYLE_END_MARKER } from "../../src/dashboard/overlay-style-model";
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

  it("adds enabled module elements with their declared default size", async () => {
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    let savedOverlay = { ...initialOverlay, elements: [] as typeof initialOverlay.elements };
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
      if (url.pathname === "/api/channels/kanal-a/modules") return Promise.resolve(jsonResponse({ modules: [
        { id: "ads", enabled: true, mandatory: false, settings: "{}" },
      ] }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a" && method === "GET") return Promise.resolve(jsonResponse({ overlay: savedOverlay }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a" && method === "PUT") {
        const requestBody = init?.body;
        if (typeof requestBody !== "string") throw new Error("Overlay save body must be JSON text.");
        const body = JSON.parse(requestBody) as { elements: typeof initialOverlay.elements };
        savedOverlay = { ...savedOverlay, revision: savedOverlay.revision + 1, elements: body.elements };
        return Promise.resolve(jsonResponse({ overlay: savedOverlay }));
      }
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [], count: 0, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      return Promise.reject(new Error(`Unexpected request ${method} ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/overlays/overlay-a");
    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Gameplay", level: 1 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add ad countdown" }));
    const snoozeInfo = await screen.findByRole("checkbox", { name: "Show snooze info" });
    expect(snoozeInfo).not.toBeChecked();
    const previewFrame = document.querySelector<HTMLIFrameElement>('[data-testid="overlay-editor-renderer"]');
    await waitFor(() => expect(previewFrame?.contentDocument?.body).toHaveTextContent("Ad in 2:30"));
    expect(previewFrame?.contentDocument?.body).toHaveTextContent("Sample");
    fireEvent.click(snoozeInfo);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(savedOverlay.elements).toHaveLength(1));
    expect(savedOverlay.elements[0]).toMatchObject({
      kind: "ads.countdown",
      config: { showSnoozeInfo: true },
      x: 490,
      y: 312,
      scalePercent: 100,
    });
  });

  it("marks a stored module element when its module is disabled", async () => {
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    const firstElement = initialOverlay.elements[0];
    if (firstElement === undefined) throw new Error("Overlay editor fixture element is missing.");
    const disabledOverlay = { ...initialOverlay, elements: [{
      ...firstElement,
      kind: "ads.countdown",
      label: "Ad countdown",
      variableName: null,
    }] };
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/channels/kanal-a/modules") return Promise.resolve(jsonResponse({ modules: [
        { id: "ads", enabled: false, mandatory: false, settings: "{}" },
      ] }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a") return Promise.resolve(jsonResponse({ overlay: disabledOverlay }));
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [], count: 0, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      return Promise.reject(new Error(`Unexpected request ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/overlays/overlay-a");
    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Gameplay", level: 1 })).toBeInTheDocument();
    expect(await screen.findAllByText("Ads module is disabled.")).toHaveLength(2);
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
    expect(previewMarkup).toMatchInlineSnapshot(`"<div class="brobot-overlay" style="position: relative; width: 1280px; height: 720px;"><div data-element="element-a" data-kind="variable" class="brobot-overlay-composition-element" style="position: absolute; left: 30px; top: 49px; width: max-content; transform: scale(1) translateX(var(--brobot-overlay-anchor-x, 0%)); transform-origin: top left; z-index: 0;"><div class="brobot-variable" data-variable="score"><span class="brobot-variable__text">Score: </span><span class="brobot-variable__value">1,234</span></div></div></div>"`);
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

  it("applies overlay and element typography to the rendered preview text", async () => {
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    const styledOverlay = {
      ...initialOverlay,
      css: generateOverlayStyleBlock({
        overlay: {
          fontFamily: "Georgia", fontSize: 30, color: "#112233", textAlign: "center",
          stroke: { width: 2, color: "#223344" },
          shadow: { x: 1, y: 2, blur: 3, color: "#556677" },
        },
        elements: { "element-a": { fontFamily: "Arial", fontSize: 32, color: "#445566", textAlign: "right" } },
      }),
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a") return Promise.resolve(jsonResponse({ overlay: styledOverlay }));
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      return Promise.reject(new Error(`Unexpected request ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/overlays/overlay-a");
    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Gameplay", level: 1 })).toBeInTheDocument();
    const previewFrame = document.querySelector<HTMLIFrameElement>('[data-testid="overlay-editor-renderer"]');
    await waitFor(() => expect(previewFrame?.contentDocument?.querySelector("style[data-brobot-overlay-css]")?.textContent).toContain(".brobot-overlay :where(.brobot-variable, .brobot-module-text)"));
    const variableText = previewFrame?.contentDocument?.querySelector<HTMLElement>('[data-variable="score"]');
    if (variableText === null || variableText === undefined) throw new Error("Overlay preview text is missing.");
    const computedStyle = previewFrame?.contentWindow?.getComputedStyle(variableText);

    expect(computedStyle?.fontFamily).toContain("Arial");
    expect(computedStyle?.fontSize).toBe("32px");
    expect(computedStyle?.color).toBe("rgb(68, 85, 102)");
    expect(computedStyle?.textAlign).toBe("right");
    expect(computedStyle?.getPropertyValue("-webkit-text-stroke")).toContain("2px");
    expect(computedStyle?.textShadow).toContain("1px 2px 3px");
  });

  it("locks legacy wrapper-target CSS until it is rewritten from the style editor", async () => {
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    const legacyCss = `${OVERLAY_STYLE_BEGIN_MARKER}\n.brobot-overlay {\n  color: #123456;\n}\n\n[data-element="element-a"] {\n  font-size: 28px;\n}\n${OVERLAY_STYLE_END_MARKER}`;
    const legacyOverlay = { ...initialOverlay, css: legacyCss };
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a") return Promise.resolve(jsonResponse({ overlay: legacyOverlay }));
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      return Promise.reject(new Error(`Unexpected request ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/overlays/overlay-a");
    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Gameplay", level: 1 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Style editor" }));
    expect(screen.getByRole("button", { name: "Rewrite from editor" })).toBeInTheDocument();
    expect(screen.getByLabelText("Font size")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Rewrite from editor" }));

    expect(screen.queryByRole("button", { name: "Rewrite from editor" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "CSS code" }));
    const css = document.querySelector<HTMLTextAreaElement>("#overlay-editor-css-code");
    if (css === null) throw new Error("CSS editor field is missing.");
    expect(css.value).not.toContain(".brobot-overlay {");
    expect(css.value).not.toContain('[data-element="element-a"] {');
  });

  it("removes an element style rule when its final property is cleared", async () => {
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    const styledOverlay = {
      ...initialOverlay,
      css: generateOverlayStyleBlock({ overlay: {}, elements: { "element-a": { fontSize: 28 } } }),
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a") return Promise.resolve(jsonResponse({ overlay: styledOverlay }));
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      return Promise.reject(new Error(`Unexpected request ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/overlays/overlay-a");
    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Gameplay", level: 1 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Style editor" }));
    const target = screen.getByRole("combobox", { name: "Apply style to" });
    fireEvent.click(target);
    fireEvent.click(await screen.findByRole("option", { name: "Element: Score", hidden: true }));
    const fontSize = screen.getByRole("spinbutton", { name: "Font size" });
    expect(fontSize).toHaveValue("28");
    fireEvent.change(fontSize, { target: { value: "" } });

    expect(fontSize).toHaveValue("");
    fireEvent.click(screen.getByRole("tab", { name: "CSS code" }));
    const cssField = document.querySelector<HTMLTextAreaElement>("#overlay-editor-css-code");
    if (cssField === null) throw new Error("CSS editor field is missing.");
    const css = cssField.value;
    expect(css).not.toContain("font-size: 28px;");
    expect(css).toContain(OVERLAY_STYLE_BEGIN_MARKER);
    expect(css).toContain(OVERLAY_STYLE_END_MARKER);
  });

  it.each([
    ["center", 150, 1130],
    ["right", 300, 1280],
  ] as const)("uses the %s anchor for editor drag, keyboard, numeric input and position limits", async (alignment, minX, maxX) => {
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    const alignedOverlay = {
      ...initialOverlay,
      css: generateOverlayStyleBlock({ overlay: {}, elements: { "element-a": { textAlign: alignment } } }),
      elements: [{ ...initialOverlay.elements[0], x: 900 }],
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a") return Promise.resolve(jsonResponse({ overlay: alignedOverlay }));
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      return Promise.reject(new Error(`Unexpected request ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/overlays/overlay-a");
    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Gameplay", level: 1 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Style editor" }));
    expect(screen.getByRole("combobox", { name: "Anchor" })).toBeInTheDocument();
    expect(screen.getByText("Sets the growth direction.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Layout" }));
    const elementId = alignedOverlay.elements[0]?.id;
    if (elementId === undefined) throw new Error("Aligned test element is missing.");
    const frameWindow = previewFrameWindow();
    stubMeasuredElementSize(frameWindow, elementId, (element) => {
      const scale = Number(/scale\(([\d.]+)\)/.exec(element.style.transform)?.[1] ?? "1");
      return { width: 300 * scale, height: 40 * scale };
    });
    fireEvent.click(screen.getByRole("tab", { name: "Style editor" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Font size" }), { target: { value: "32" } });
    fireEvent.click(screen.getByRole("tab", { name: "Layout" }));
    const xField = screen.getByRole("spinbutton", { name: "X (px)" });
    await waitFor(() => expect(xField).toHaveAttribute("aria-valuemin", String(minX)));
    expect(xField).toHaveAttribute("aria-valuemax", String(maxX));

    fireEvent.change(xField, { target: { value: "0" } });
    expect(xField).toHaveValue(String(minX));
    const previewFrame = document.querySelector<HTMLIFrameElement>('[data-testid="overlay-editor-renderer"]');
    const canvas = previewFrame?.contentDocument?.getElementById("root");
    const element = previewFrame?.contentDocument?.querySelector<HTMLElement>(`[data-element="${elementId}"]`);
    if (canvas === null || canvas === undefined || element === null || element === undefined) throw new Error("Aligned preview element is missing.");
    fireEvent.keyDown(canvas, { key: "ArrowLeft" });
    expect(xField).toHaveValue(String(minX));
    fireEvent.keyDown(canvas, { key: "ArrowRight" });
    expect(xField).toHaveValue(String(minX + 1));
    const elementBeforeDrag = previewFrame?.contentDocument?.querySelector<HTMLElement>(`[data-element="${elementId}"]`);
    if (elementBeforeDrag === null || elementBeforeDrag === undefined) throw new Error("Updated aligned preview element is missing.");
    fireEvent.pointerDown(elementBeforeDrag, { pointerId: 1, button: 0, clientX: 1, clientY: 0 });
    fireEvent.pointerMove(canvas, { pointerId: 1, clientX: 11, clientY: 0 });
    fireEvent.pointerUp(canvas, { pointerId: 1 });
    expect(xField).toHaveValue(String(minX + 11));
  });

  it("reclamps when a managed style change makes the rendered element wider", async () => {
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    const nearEdgeElement = {
      ...initialOverlay.elements[0], id: "element-style-edge", label: "Style edge", x: 900, y: 100,
    };
    const overlayWithNearEdgeElement = { ...initialOverlay, elements: [nearEdgeElement] };
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
    stubMeasuredElementSize(previewFrameWindow(), nearEdgeElement.id, (element) => {
      const block = element.ownerDocument.querySelector("style[data-brobot-overlay-css]")?.textContent ?? "";
      return { width: block.includes("font-size: 500px;") ? 500 : 300, height: 40 };
    });
    fireEvent.click(screen.getByRole("tab", { name: "Style editor" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Font size" }), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("tab", { name: "Layout" }));

    expect(screen.getByRole("spinbutton", { name: "X (px)" })).toHaveValue("780");
  });

  it("reclamps an unselected element near the edge when an overlay-default style grows it", async () => {
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    // The first element is selected by default and stays selected throughout; only the second,
    // never-selected element sits near the right edge and must still be reclamped when the
    // overlay-default font size grows it.
    const selectedElement = { ...initialOverlay.elements[0], id: "element-selected", x: 24, y: 32 };
    const nearEdgeElement = { ...initialOverlay.elements[0], id: "element-unselected-edge", label: "Edge", x: 900, y: 100, z: 1 };
    const overlayWithBothElements = { ...initialOverlay, elements: [selectedElement, nearEdgeElement] };
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a" && (init?.method ?? "GET") === "GET") return Promise.resolve(jsonResponse({ overlay: overlayWithBothElements }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a" && init?.method === "PUT") {
        if (typeof init.body !== "string") throw new Error("Overlay save body must be JSON text.");
        const body = JSON.parse(init.body) as { css: string; elements: typeof initialOverlay.elements };
        return Promise.resolve(jsonResponse({ overlay: { ...overlayWithBothElements, css: body.css, elements: body.elements, revision: 5 } }));
      }
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      return Promise.reject(new Error(`Unexpected request ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/overlays/overlay-a");
    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Gameplay", level: 1 })).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "X (px)" })).toHaveValue("24");
    stubMeasuredElementSize(previewFrameWindow(), nearEdgeElement.id, (element) => {
      const block = element.ownerDocument.querySelector("style[data-brobot-overlay-css]")?.textContent ?? "";
      return { width: block.includes("font-size: 500px;") ? 500 : 300, height: 40 };
    });
    fireEvent.click(screen.getByRole("tab", { name: "Style editor" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Font size" }), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(fetcher.mock.calls.filter(([, requestInit]) => requestInit?.method === "PUT")).toHaveLength(1));
    const saveCall = fetcher.mock.calls.find(([, requestInit]) => requestInit?.method === "PUT");
    if (saveCall === undefined || typeof saveCall[1]?.body !== "string") throw new Error("Overlay save request is missing.");
    const saved = JSON.parse(saveCall[1].body) as { elements: typeof initialOverlay.elements };
    const savedEdgeElement = saved.elements.find(({ id }) => id === nearEdgeElement.id);
    // At 500px width the element no longer fits at x=900 inside the 1280px canvas and is pulled back
    // to fit, even though it was never selected.
    expect(savedEdgeElement?.x).toBe(780);
  });

  it("clears an unsettable style color and shows its empty state", async () => {
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    const styledOverlay = {
      ...initialOverlay,
      css: generateOverlayStyleBlock({ overlay: { color: "#123456" }, elements: {} }),
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a") return Promise.resolve(jsonResponse({ overlay: styledOverlay }));
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      return Promise.reject(new Error(`Unexpected request ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/overlays/overlay-a");
    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Gameplay", level: 1 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Style editor" }));
    const textColorInput = screen.getByLabelText("Text color");
    expect(textColorInput).toHaveValue("#123456");
    fireEvent.click(screen.getByRole("button", { name: "Clear color" }));

    expect(within(textColorInput.closest(".ui-color-field") as HTMLElement).getByText("Not set")).toBeInTheDocument();
    expect(textColorInput).toHaveAccessibleDescription("Not set");
    expect(textColorInput).toHaveAttribute("data-unset", "true");
    expect(textColorInput.parentElement).toHaveAttribute("data-unset", "true");
    expect(textColorInput.parentElement?.querySelector(".ui-color-field__empty-swatch")).toBeInTheDocument();
    const previewFrame = document.querySelector<HTMLIFrameElement>("iframe[data-testid='overlay-editor-renderer']");
    expect(previewFrame?.contentDocument?.querySelector("style[data-brobot-overlay-css]")?.textContent).not.toContain("color: #123456;");
  });

  it("opens the font disclosure by default and leaves unset sections collapsed with summaries", async () => {
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a") return Promise.resolve(jsonResponse({ overlay: initialOverlay }));
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      return Promise.reject(new Error(`Unexpected request ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/overlays/overlay-a");
    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Gameplay", level: 1 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Style editor" }));

    for (const [title, expanded, section] of [
      ["Font", true, "font"], ["Outline", false, "outline"], ["Shadow", false, "shadow"], ["Background & spacing", false, "background"],
    ] as const) {
      const disclosure = screen.getByRole("button", { name: new RegExp(`^${title}`) });
      expect(disclosure).toHaveAttribute("aria-expanded", String(expanded));
      expect(disclosure.querySelector(`[data-style-icon="${section}"] svg`)).toBeInTheDocument();
      const panelId = disclosure.getAttribute("aria-controls");
      if (panelId === null) throw new Error(`${title} disclosure has no controlled panel.`);
      const panel = document.getElementById(panelId);
      expect(panel).toBeInTheDocument();
      if (expanded) expect(panel).not.toHaveAttribute("hidden");
      else {
        expect(panel).toHaveAttribute("hidden");
        expect(within(disclosure).getByText("not set")).toBeInTheDocument();
      }
    }
    expect(screen.getByRole("spinbutton", { name: "Font size" })).toBeInTheDocument();
    expect(screen.queryByRole("spinbutton", { name: "Outline width" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Outline/ }));

    expect(screen.getByRole("button", { name: /^Outline/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("spinbutton", { name: "Outline width" })).toBeInTheDocument();
  });

  it("auto-opens style sections that contain values and summarizes those values", async () => {
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    const styledOverlay = {
      ...initialOverlay,
      css: generateOverlayStyleBlock({
        overlay: {
          fontFamily: "Arial", fontSize: 32, fontWeight: 700, color: "#abcdef", textAlign: "center", lineHeight: 1.2, letterSpacing: 1,
          stroke: { width: 2, color: "#000000" },
          shadow: { x: 1, y: 2, blur: 3, color: "#112233" },
          background: { color: "#445566", opacityPercent: 75 }, padding: 8, borderRadius: 12,
        },
        elements: {},
      }),
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a") return Promise.resolve(jsonResponse({ overlay: styledOverlay }));
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      return Promise.reject(new Error(`Unexpected request ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/overlays/overlay-a");
    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Gameplay", level: 1 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Style editor" }));

    for (const title of ["Font", "Outline", "Shadow", "Background & spacing"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${title}`) })).toHaveAttribute("aria-expanded", "true");
    }
    expect(screen.getByText("Arial · 32 px · 700 · #abcdef · Center · 1.2 · 1 px")).toBeInTheDocument();
    expect(screen.getByText("2 px · #000000")).toBeInTheDocument();
    expect(screen.getByText("X 1 px · Y 2 px · 3 px · #112233")).toBeInTheDocument();
    expect(screen.getByText("#445566 · 75% · 8 px · 12 px")).toBeInTheDocument();
  });

  it("locks the style fields after a code edit and rewrites the managed block from the editor", async () => {
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input, init) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/csrf") return Promise.resolve(jsonResponse({ token: "csrf-test" }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a" && (init?.method ?? "GET") === "GET") return Promise.resolve(jsonResponse({ overlay: initialOverlay }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a" && init?.method === "PUT") {
        if (typeof init.body !== "string") throw new Error("Overlay save body must be JSON text.");
        const body = JSON.parse(init.body) as { css: string; elements: typeof initialOverlay.elements };
        return Promise.resolve(jsonResponse({ overlay: { ...initialOverlay, css: body.css, elements: body.elements, revision: 5 } }));
      }
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      return Promise.reject(new Error(`Unexpected request ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/overlays/overlay-a");
    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Gameplay", level: 1 })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Style editor" }));
    fireEvent.change(screen.getByLabelText("Text color"), { target: { value: "#123456" } });
    fireEvent.click(screen.getByRole("tab", { name: "CSS code" }));
    const code = screen.getByRole("textbox", { name: "CSS code" });
    const currentCss = (code as HTMLTextAreaElement).value;
    expect(currentCss).toContain("color: #123456;");
    fireEvent.change(code, { target: { value: currentCss.replace("color: #123456;", "color: hotpink;") } });

    fireEvent.click(screen.getByRole("tab", { name: "Style editor" }));
    const stylePanel = screen.getByRole("tabpanel", { name: "Style editor" });
    expect(within(stylePanel).getByText(/style block was changed in code/i, { selector: "p" })).toBeInTheDocument();
    expect(screen.getByLabelText("Text color")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Rewrite from editor" }));
    expect(screen.getByLabelText("Text color")).toBeEnabled();
    expect(screen.getByLabelText("Text color")).toHaveValue("#123456");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(fetcher.mock.calls.filter(([, init]) => init?.method === "PUT")).toHaveLength(1));
    const saveCall = fetcher.mock.calls.find(([, init]) => init?.method === "PUT");
    if (saveCall === undefined || typeof saveCall[1]?.body !== "string") throw new Error("Overlay save request is missing.");
    expect((JSON.parse(saveCall[1].body) as { css: string }).css).toContain("color: #123456;");
  });

  it("copies the complete CSS string from the code tab", async () => {
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");
    const writeText = vi.fn<(value: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a") return Promise.resolve(jsonResponse({ overlay: initialOverlay }));
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      return Promise.reject(new Error(`Unexpected request ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/overlays/overlay-a");
    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Gameplay", level: 1 })).toBeInTheDocument();
    const previewViewport = document.querySelector<HTMLElement>(".overlay-editor__preview-viewport");
    expect(previewViewport?.style.aspectRatio).toBe("1280 / 720");
    fireEvent.click(screen.getByRole("tab", { name: "CSS code" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy CSS" }));
    expect(await screen.findByText("CSS copied")).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(initialOverlay.css);
    if (clipboardDescriptor === undefined) Reflect.deleteProperty(window.navigator, "clipboard");
    else Object.defineProperty(window.navigator, "clipboard", clipboardDescriptor);
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
    const operatorOverlay = {
      ...initialOverlay,
      css: generateOverlayStyleBlock({
        overlay: {},
        elements: { "element-a": { fontSize: 28, color: "#123456", stroke: { width: 2, color: "#112233" } } },
      }),
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [operatorChannel], bot: channel.bot }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a") return Promise.resolve(jsonResponse({ overlay: operatorOverlay }));
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      return Promise.reject(new Error(`Unexpected request ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/overlays/overlay-a");
    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Gameplay", level: 1 })).toBeInTheDocument();
    const reason = screen.getByText("Bediener können die Komposition ansehen, aber nicht ändern.", { selector: "p" });
    expect(reason).toHaveTextContent("Bediener können die Komposition ansehen, aber nicht ändern.");
    expect(reason).toHaveAttribute("id", "overlay-editor-readonly-reason");
    const addVariableSelect = screen.getByRole("combobox", { name: "Kanalvariable auswählen" });
    expect(addVariableSelect).toBeDisabled();
    const addVariableReasonId = addVariableSelect.getAttribute("aria-describedby");
    expect(addVariableReasonId).toBe(`overlay-editor-readonly-reason-select-${addVariableSelect.id}`);
    expect(addVariableReasonId === null ? null : document.getElementById(addVariableReasonId)).toHaveTextContent("Bediener können die Komposition ansehen, aber nicht ändern.");
    const actions = [
      screen.getByRole("button", { name: "Variable anzeigen" }),
      screen.getByRole("button", { name: "Element entfernen" }),
      screen.getByRole("button", { name: "Speichern" }),
    ];
    for (const action of actions) {
      expect(action).toBeDisabled();
      expect(action).toHaveAttribute("aria-describedby", "overlay-editor-readonly-reason");
    }
    fireEvent.click(screen.getByRole("tab", { name: "Stil-Editor" }));
    expect(screen.getByText("Bediener dürfen den Overlay-Stil ansehen, aber nicht ändern.", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByLabelText("Textfarbe")).toBeDisabled();
    const styleTarget = screen.getByRole("combobox", { name: "Stil anwenden auf" });
    expect(styleTarget).toBeEnabled();
    fireEvent.click(styleTarget);
    fireEvent.click(await screen.findByRole("option", { name: "Element: Score", hidden: true }));
    expect(screen.getByRole("spinbutton", { name: "Schriftgröße" })).toHaveValue("28");
    expect(screen.getByLabelText("Textfarbe")).toHaveValue("#123456");
    const outlineWidth = screen.getByRole("spinbutton", { name: "Konturstärke" });
    expect(outlineWidth).toHaveValue("2");
    expect(outlineWidth).toBeDisabled();
    const shadowDisclosure = screen.getByRole("button", { name: /^Schatten/ });
    expect(shadowDisclosure).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(shadowDisclosure);
    const shadowX = screen.getByRole("spinbutton", { name: "Schatten X-Versatz" });
    expect(shadowX).toBeDisabled();
    const shadowReasonId = shadowX.getAttribute("aria-describedby");
    expect(shadowReasonId).not.toBeNull();
    expect(document.getElementById(shadowReasonId ?? "")).toHaveTextContent("Bediener dürfen den Overlay-Stil ansehen, aber nicht ändern.");
    const systemFont = screen.getByRole("combobox", { name: "Systemschrift auswählen" });
    expect(systemFont).toBeDisabled();
    const styleReasonId = systemFont.getAttribute("aria-describedby");
    expect(styleReasonId).toBe(`overlay-style-disabled-reason-select-${systemFont.id}`);
    expect(styleReasonId === null ? null : document.getElementById(styleReasonId)).toHaveTextContent("Bediener dürfen den Overlay-Stil ansehen, aber nicht ändern.");
    fireEvent.click(screen.getByRole("tab", { name: "CSS-Code" }));
    expect(screen.getByText("Bediener können das Overlay-CSS kopieren, aber nicht ändern.", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "CSS-Code" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "CSS kopieren" })).toBeEnabled();
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

  it("keeps selected and dashed preview bounds visible when authored CSS hides element outlines", async () => {
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    const firstElement = initialOverlay.elements[0];
    if (firstElement === undefined) throw new Error("Overlay test element is missing.");
    const overlayWithConflictingCss = {
      ...initialOverlay,
      css: `${initialOverlay.css}\n.brobot-overlay [data-element] { outline: none !important; }`,
      elements: [firstElement, { ...firstElement, id: "element-b", label: "Second", x: 480 }],
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a") return Promise.resolve(jsonResponse({ overlay: overlayWithConflictingCss }));
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      return Promise.reject(new Error(`Unexpected request ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/overlays/overlay-a");
    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Gameplay", level: 1 })).toBeInTheDocument();
    const previewFrame = document.querySelector<HTMLIFrameElement>('[data-testid="overlay-editor-renderer"]');
    await waitFor(() => {
      const bounds = previewFrame?.contentDocument?.querySelector<HTMLElement>("[data-brobot-editor-bounds-layer]")?.shadowRoot;
      expect(bounds?.querySelector('[data-brobot-editor-bound="element-a"]')).toBeInTheDocument();
      expect(bounds?.querySelector('[data-brobot-editor-bound="element-b"]')).toBeInTheDocument();
    });
    const previewDocument = previewFrame?.contentDocument;
    const boundsHost = previewDocument?.querySelector<HTMLElement>("[data-brobot-editor-bounds-layer]");
    const bounds = boundsHost?.shadowRoot;
    const selectedBound = bounds?.querySelector<HTMLElement>('[data-brobot-editor-bound="element-a"]');
    const unselectedBound = bounds?.querySelector<HTMLElement>('[data-brobot-editor-bound="element-b"]');
    expect(selectedBound).toHaveAttribute("data-selected", "true");
    expect(selectedBound?.style.borderStyle).toBe("solid");
    expect(unselectedBound).toHaveAttribute("data-selected", "false");
    expect(unselectedBound?.style.borderStyle).toBe("dashed");
    expect(unselectedBound?.closest(".brobot-overlay")).toBeNull();
    expect(previewDocument?.querySelector("style[data-brobot-overlay-css]")?.textContent).toContain("outline: none !important");
    const renderedElement = previewDocument?.querySelector<HTMLElement>('[data-element="element-a"]');
    if (renderedElement === null || renderedElement === undefined) throw new Error("Overlay preview element is missing.");
    expect(previewFrame?.contentWindow?.getComputedStyle(renderedElement).outlineStyle).toBe("none");
    const baseStyle = previewFrame?.contentDocument?.head.querySelector("style");
    expect(baseStyle?.textContent).not.toContain("[data-element]");

    fireEvent.click(screen.getByRole("button", { name: "Remove element" }));
    await waitFor(() => expect(bounds?.querySelector('[data-brobot-editor-bound="element-b"]')).toHaveAttribute("data-selected", "true"));
    fireEvent.click(screen.getByRole("button", { name: "Remove element" }));
    await waitFor(() => expect(bounds?.querySelectorAll("[data-brobot-editor-bound]")).toHaveLength(0));
  });

  it("shows the unsaved-changes status only once on the save bar", async () => {
    Object.defineProperty(window.navigator, "language", { value: "en-US", configurable: true });
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      const url = requestUrl(input);
      if (url.pathname === "/api/channels") return Promise.resolve(jsonResponse({ channels: [channel], bot: channel.bot }));
      if (url.pathname === "/api/channels/kanal-a/overlays/overlay-a") return Promise.resolve(jsonResponse({ overlay: initialOverlay }));
      if (url.pathname === "/api/channels/kanal-a/variables") return Promise.resolve(jsonResponse({ variables: [variable], count: 1, maximum: 25 }));
      if (url.pathname === "/api/channels/kanal-a/overlay-tokens") return Promise.resolve(jsonResponse({ tokens: [], nextOffset: null }));
      return Promise.reject(new Error(`Unexpected request ${url.pathname}`));
    });
    vi.stubGlobal("fetch", fetcher);
    window.history.replaceState({}, "", "/channels/kanal-a/overlays/overlay-a");
    render(<DashboardApp />);

    expect(await screen.findByRole("heading", { name: "Gameplay", level: 1 })).toBeInTheDocument();
    const saveBar = document.querySelector<HTMLElement>(".ui-save-bar");
    if (saveBar === null) throw new Error("Save bar is missing.");
    expect(within(saveBar).queryByText("Unsaved changes")).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Element label" }), { target: { value: "Score label" } });

    expect(within(saveBar).getAllByText("Unsaved changes")).toHaveLength(1);
  });
});
