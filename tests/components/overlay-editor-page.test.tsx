import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DashboardApp } from "../../src/dashboard/main";
import { OverlayCanvas } from "../../src/overlay/canvas";
import { jsonResponse } from "../unit/fixtures";

const channel = {
  channelId: "kanal-a", login: "kanal-a", displayName: "Alpha", role: "manager",
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

describe("Overlay composition editor", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    Object.defineProperty(window.navigator, "language", { value: "de-DE", configurable: true });
  });

  it("keeps pointer and keyboard edits local, then saves one revisioned PUT", async () => {
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
    await waitFor(() => expect(previewFrame?.contentDocument?.querySelector(".brobot-variable")).toHaveTextContent("Score: 1.234"));
    const previewDocument = previewFrame?.contentDocument;
    const canvas = previewDocument?.getElementById("root");
    const element = previewDocument?.querySelector<HTMLElement>('[data-element="element-a"]');
    if (canvas === null || canvas === undefined || element === null || element === undefined) throw new Error("Overlay preview canvas is missing.");
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, right: 1280, bottom: 720, width: 1280, height: 720, toJSON: () => ({}),
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
    expect(fetcher).toHaveBeenCalledTimes(fetchCount);

    const firstDraftElement = savedOverlay.elements[0];
    if (firstDraftElement === undefined) throw new Error("Overlay test element is missing.");
    const outputDraft = { ...savedOverlay, elements: [{ ...firstDraftElement, x: 30, y: 49 }] };
    const output = render(<OverlayCanvas
      overlay={{ id: outputDraft.id, revision: outputDraft.revision, width: outputDraft.width, height: outputDraft.height, css: outputDraft.css, elements: outputDraft.elements }}
      language="de"
      variables={{ score: 1234 }}
      elementId={null}
      debug={false}
    />);
    const previewMarkup = previewDocument?.querySelector(".brobot-overlay")?.outerHTML;
    const outputMarkup = output.container.querySelector(".brobot-overlay")?.outerHTML;
    expect(previewMarkup).toBe(outputMarkup);
    expect(previewDocument?.querySelector("style[data-brobot-overlay-css]")?.textContent).toContain(".brobot-variable");
    expect(previewMarkup).toMatchInlineSnapshot(`
      "<div class="brobot-overlay" style="position: relative; width: 1280px; height: 720px;"><div data-element="element-a" data-kind="variable" style="position: absolute; left: 30px; top: 49px; transform: scale(1); transform-origin: top left; z-index: 0;"><div class="brobot-variable" data-variable="score"><span class="brobot-variable__text">Score: </span><span class="brobot-variable__value">1.234</span></div></div></div>"
    `);
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
