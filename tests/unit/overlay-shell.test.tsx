import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RealtimeEnvelope } from "../../src/realtime-contract";
import type { OverlayRealtimeCallbacks } from "../../src/overlay/realtime";

const realtimeMocks = vi.hoisted(() => ({ connectOverlayRealtime: vi.fn() }));

vi.mock("../../src/overlay/realtime", () => realtimeMocks);
vi.mock("../../src/text", () => ({
  formatCount: (value: number, language: "de" | "en") => {
    if (value === 13) throw new Error("Fixture render failure");
    return new Intl.NumberFormat(language === "de" ? "de-DE" : "en-US", { maximumFractionDigits: 0 }).format(value);
  },
}));

import { OverlayShell } from "../../src/overlay/shell";

const element = (
  id: string,
  x: number,
  y: number,
  scalePercent: number,
  z: number,
  inComposition = true,
  variableName = "score",
  kind = "variable",
) => ({
  id,
  kind,
  label: id,
  variableName,
  text: "Score: {value}",
  config: {},
  x,
  y,
  scalePercent,
  z,
  inComposition,
});

const overlayPayload = (
  value = 1200,
  css = ".brobot-overlay { color: white; }",
  includeSecond = true,
): Response => new Response(
  JSON.stringify({
    language: "en",
    overlay: {
      id: "overlay-fixture",
      revision: 1,
      width: 1920,
      height: 1080,
      css,
      elements: [
        element("element-first", 20, 30, 100, 4),
        element("element-second", 80, 90, 150, 2, includeSecond, "safe_count"),
        element("element-third", 120, 140, 75, 8, true, "safe_count"),
      ],
    },
    variables: { score: value, safe_count: 1200 },
  }),
  { status: 200, headers: { "Content-Type": "application/json" } },
);

const createVariableMessage = (value: number): RealtimeEnvelope<"variables.changed"> => ({
  version: 1,
  id: "fixture-message",
  createdAt: "2026-09-25T08:00:00.000Z",
  channelId: "fixture-channel",
  type: "variables.changed",
  payload: { set: [{ name: "score", value }], removed: [] },
});

let realtimeCallbacks: OverlayRealtimeCallbacks | null = null;

describe("OverlayShell and OverlayCanvas", () => {
  beforeEach(() => {
    realtimeCallbacks = null;
    realtimeMocks.connectOverlayRealtime.mockReset();
    realtimeMocks.connectOverlayRealtime.mockImplementation((
      _token: string,
      _onTerminalClose: (() => void) | undefined,
      callbacks: OverlayRealtimeCallbacks,
    ) => {
      realtimeCallbacks = callbacks;
      return vi.fn();
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.head.querySelector("style[data-brobot-overlay-css]")?.remove();
  });

  it("uses one bootstrap and one socket for a three-element composition", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(overlayPayload());
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);

    await waitFor(() => expect(container.querySelectorAll("[data-element]")).toHaveLength(3));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/api/overlay/bootstrap", expect.objectContaining({
      headers: { Authorization: "Bearer fictional-token" },
      cache: "no-store",
    }));
    expect(realtimeMocks.connectOverlayRealtime).toHaveBeenCalledTimes(1);
    expect(realtimeMocks.connectOverlayRealtime).toHaveBeenCalledWith("fictional-token", expect.any(Function), expect.any(Object));
    expect(container.querySelector(".brobot-overlay")).toHaveStyle({ width: "1920px", height: "1080px" });
    expect(container.querySelector('[data-element="element-first"]')).toHaveStyle({ left: "20px", top: "30px", zIndex: "4", width: "max-content" });
    expect(container.querySelector('[data-element="element-first"]')).toHaveClass("brobot-overlay-composition-element");
    expect(container.querySelector('[data-element="element-third"]')).toHaveStyle({ left: "120px", top: "140px", transform: "scale(0.75) translateX(var(--brobot-overlay-anchor-x, 0%))" });
    expect(container.querySelector('[data-element="element-second"]')).not.toBeNull();
    expect(container.querySelectorAll(".brobot-variable")).toHaveLength(3);
    expect(container.querySelectorAll(".brobot-variable__text")).toHaveLength(3);
    expect(container.querySelectorAll(".brobot-variable__value")).toHaveLength(3);
    await waitFor(() => expect(document.head.querySelector("style[data-brobot-overlay-css]")?.textContent)
      .toBe(".brobot-overlay { color: white; }"));
  });

  it("keeps a denied bootstrap transparent when a legacy debug fragment is present", async () => {
    window.history.replaceState(null, "", "/overlay#token=fictional-token&debug=1");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 403 }));
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(container).toBeEmptyDOMElement();
  });

  it("renders one selected element at the origin with its stored scale", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(overlayPayload(1200, ".brobot-overlay { color: white; }", false)));

    const { container } = render(<OverlayShell token="fictional-token" elementId="element-second" />);

    await waitFor(() => expect(container.querySelector('[data-element="element-second"]')).not.toBeNull());
    expect(container.querySelectorAll("[data-element]")).toHaveLength(1);
    const isolatedElement = container.querySelector('[data-element="element-second"]');
    expect(isolatedElement).toHaveStyle({
      left: "0px",
      top: "0px",
      transform: "scale(1.5)",
    });
    // Isolated/legacy rendering (e.g. an unbound #text= link in a narrow OBS browser source)
    // keeps its original shrink-to-fit/wrap behavior: no forced width, no composition class.
    expect(isolatedElement).not.toHaveClass("brobot-overlay-composition-element");
    expect(isolatedElement?.getAttribute("style")).not.toContain("max-content");
  });

  it("renders stored text for a bound legacy token and ignores fragment configuration", async () => {
    window.history.replaceState(null, "", "/overlay#token=fictional-token&var=score&text=Fragment%20override%3A%20%7Bvalue%7D");
    const payload = {
      language: "en",
      overlay: {
        id: "imported-overlay", revision: 1, width: 1920, height: 1080, css: "",
        elements: [{ ...element("imported-element", 0, 0, 100, 0), text: "Imported: {value}" }],
      },
      variables: { score: 1200 },
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(payload), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);

    await waitFor(() => expect(container.querySelector('[data-element="imported-element"]')).not.toBeNull());
    expect(container.querySelector('[data-element="imported-element"] .brobot-variable__text')).toHaveTextContent("Imported:");
    expect(container).not.toHaveTextContent("Fragment override");
    expect(fetcher).toHaveBeenCalledWith("/api/overlay/bootstrap", expect.objectContaining({
      headers: { Authorization: "Bearer fictional-token" },
    }));
  });

  it.each([
    ["without a placeholder", "Legacy score"],
    ["with multiple placeholders", "Legacy {value} plus {value}"],
  ])("preserves legacy rendering %s after the token is bound", async (_description, legacyText) => {
    const fragment = new URLSearchParams({ token: "fictional-token", var: "score", text: legacyText });
    window.history.replaceState(null, "", `/overlay#${fragment.toString()}`);
    let bootstrapRequests = 0;
    const boundPayload = {
      language: "en",
      overlay: {
        id: "imported-overlay", revision: 1, width: 1920, height: 1080, css: "",
        elements: [{ ...element("imported-element", 0, 0, 100, 0), text: legacyText }],
      },
      variables: { score: 1200 },
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
      if (input === "/api/overlay/bootstrap") {
        bootstrapRequests += 1;
        return Promise.resolve(new Response(JSON.stringify(bootstrapRequests === 1
          ? { language: "en", overlay: null, variables: { score: 1200 } }
          : boundPayload), { status: 200 }));
      }
      if (input === "/api/overlay/variables/score") {
        return Promise.resolve(new Response(JSON.stringify({ name: "score", value: 1200 }), {
          status: 200,
          headers: { "Content-Language": "en" },
        }));
      }
      const requestDescription = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      return Promise.reject(new Error(`Unexpected request ${requestDescription}.`));
    });
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);
    await waitFor(() => expect(realtimeCallbacks?.onTokenBound).toBeTypeOf("function"));
    await waitFor(() => expect(container.querySelector(".brobot-variable__value")).toHaveTextContent("1,200"));
    const legacyRendering = container.textContent;
    const legacyCallbacks = realtimeCallbacks;

    act(() => legacyCallbacks?.onTokenBound?.());

    await waitFor(() => expect(container.querySelector('[data-element="imported-element"]')).not.toBeNull());
    expect(bootstrapRequests).toBe(2);
    expect(container.textContent).toBe(legacyRendering);
  });

  it("updates live values, debounces overlay changes, and reloads after reconnect", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(overlayPayload()));
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-element="element-first"] .brobot-variable__value')).toHaveTextContent("1,200");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(realtimeMocks.connectOverlayRealtime).toHaveBeenCalledTimes(1);
    expect(realtimeCallbacks?.onMessage).toBeTypeOf("function");

    act(() => realtimeCallbacks?.onMessage?.(createVariableMessage(3400)));
    await waitFor(() => expect(container.querySelector('[data-element="element-first"] .brobot-variable__value')).toHaveTextContent("3,400"));
    expect(fetcher).toHaveBeenCalledTimes(1);

    vi.useFakeTimers();
    act(() => realtimeCallbacks?.onOverlayChanged?.({
      version: 1,
      id: "fixture-change",
      createdAt: "2026-09-25T08:00:00.000Z",
      channelId: "fixture-channel",
      type: "overlay.changed",
      payload: { overlayId: "overlay-fixture", revision: 2 },
    }));
    await act(async () => { await vi.advanceTimersByTimeAsync(249); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetcher).toHaveBeenCalledTimes(2);

    act(() => realtimeCallbacks?.onOpen?.(true));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("keeps a live variable update newer than an in-flight bootstrap response", async () => {
    let finishReload: ((response: Response) => void) | undefined;
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(overlayPayload(1200))
      .mockImplementationOnce(() => new Promise((resolve) => { finishReload = resolve; }));
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);
    await waitFor(() => expect(container.querySelector('[data-element="element-first"]')).not.toBeNull());
    act(() => realtimeCallbacks?.onOpen?.(true));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));

    act(() => realtimeCallbacks?.onMessage?.(createVariableMessage(3400)));
    expect(container.querySelector('[data-element="element-first"] .brobot-variable__value')).toHaveTextContent("3,400");
    await act(async () => {
      finishReload?.(overlayPayload(1200));
      await Promise.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(container.querySelector('[data-element="element-first"] .brobot-variable__value')).toHaveTextContent("3,400"));
  });

  it("reconciles the bootstrap after the first successful socket open", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(overlayPayload());
    vi.stubGlobal("fetch", fetcher);

    render(<OverlayShell token="fictional-token" elementId={null} />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    act(() => realtimeCallbacks?.onOpen?.(false));

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });

  it("keeps the last rendered content through a transient bootstrap reload failure and retries", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(overlayPayload(1200))
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValueOnce(overlayPayload(3400));
    vi.stubGlobal("fetch", fetcher);
    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);

    await waitFor(() => expect(container.querySelector("[data-element]")).not.toBeNull());
    vi.useFakeTimers();
    act(() => realtimeCallbacks?.onOpen?.(true));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector("[data-element]")).not.toBeNull();
    expect(container.querySelector('[data-element="element-first"] .brobot-variable__value')).toHaveTextContent("1,200");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(container.querySelector('[data-element="element-first"] .brobot-variable__value')).toHaveTextContent("3,400");
  });

  it("clears rendered content after revocation while the source is disconnected", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(overlayPayload()));
    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);
    await waitFor(() => expect(container.querySelector("[data-element]")).not.toBeNull());
    const terminalClose = realtimeMocks.connectOverlayRealtime.mock.calls[0]?.[1] as (() => void) | undefined;

    act(() => terminalClose?.());

    expect(container.querySelector("[data-element]")).toBeNull();
    act(() => realtimeCallbacks?.onOpen?.(true));
    expect(container.querySelector("[data-element]")).toBeNull();
  });

  it("keeps revoked sources transparent when an active bootstrap finishes", async () => {
    let finishBootstrap: ((response: Response) => void) | undefined;
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(overlayPayload())
      .mockImplementationOnce(() => new Promise((resolve) => { finishBootstrap = resolve; }));
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);
    await waitFor(() => expect(container.querySelector("[data-element]")).not.toBeNull());
    await waitFor(() => expect(realtimeMocks.connectOverlayRealtime).toHaveBeenCalledTimes(1));
    const terminalClose = realtimeMocks.connectOverlayRealtime.mock.calls[0]?.[1] as (() => void) | undefined;
    act(() => realtimeCallbacks?.onOpen?.(true));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const activeSignal = fetcher.mock.calls[1]?.[1]?.signal;
    act(() => terminalClose?.());
    expect(activeSignal?.aborted).toBe(true);
    await act(async () => {
      finishBootstrap?.(overlayPayload());
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector("[data-element]")).toBeNull();
    act(() => realtimeCallbacks?.onOpen?.(false));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(container.querySelector("[data-element]")).toBeNull();
  });

  it("cancels queued reloads and coalesces reconnects while a bootstrap is in flight", async () => {
    vi.useFakeTimers();
    let finishReload: ((response: Response) => void) | undefined;
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(overlayPayload())
      .mockImplementationOnce(() => new Promise((resolve) => { finishReload = resolve; }))
      .mockResolvedValue(overlayPayload());
    vi.stubGlobal("fetch", fetcher);

    render(<OverlayShell token="fictional-token" elementId={null} />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    act(() => realtimeCallbacks?.onOverlayChanged?.({
      version: 1,
      id: "fixture-change",
      createdAt: "2026-09-25T08:00:00.000Z",
      channelId: "fixture-channel",
      type: "overlay.changed",
      payload: { overlayId: "overlay-fixture", revision: 2 },
    }));
    act(() => realtimeCallbacks?.onOpen?.(true));
    expect(fetcher).toHaveBeenCalledTimes(2);
    act(() => realtimeCallbacks?.onOpen?.(true));
    act(() => realtimeCallbacks?.onOpen?.(true));
    expect(fetcher).toHaveBeenCalledTimes(2);

    await act(async () => {
      finishReload?.(overlayPayload());
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("lets the legacy entry own the only realtime connection for an unbound link", async () => {
    window.history.replaceState(null, "", "/overlay#token=fictional-token&var=score&text=%7Bvalue%7D");
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ language: "en", overlay: null, variables: {} }), { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify({ name: "score", value: 12 }), { status: 200, headers: { "Content-Language": "en" } }));
    vi.stubGlobal("fetch", fetcher);

    render(<OverlayShell token="fictional-token" elementId={null} />);

    await waitFor(() => expect(realtimeMocks.connectOverlayRealtime).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fetcher.mock.calls.some(([input]) => input === "/api/overlay/variables/score")).toBe(true));
    expect(fetcher).toHaveBeenCalledWith("/api/overlay/bootstrap", expect.anything());
    expect(realtimeMocks.connectOverlayRealtime).toHaveBeenCalledTimes(1);
  });

  it("recovers an element boundary after its rendered value changes", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(overlayPayload(13)));

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);
    await waitFor(() => expect(container.querySelectorAll("[data-element]")).toHaveLength(2));
    act(() => realtimeCallbacks?.onMessage?.(createVariableMessage(1200)));

    await waitFor(() => expect(container.querySelectorAll("[data-element]")).toHaveLength(3));
    expect(container.querySelector('[data-element="element-first"] .brobot-variable__value')).toHaveTextContent("1,200");
  });

  it("keeps a missing constructor variable transparent", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      language: "en",
      overlay: {
        id: "overlay-fixture", revision: 1, width: 1920, height: 1080, css: "",
        elements: [element("element-constructor", 0, 0, 100, 0, true, "constructor")],
      },
      variables: {},
    }), { status: 200 })));

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);
    await waitFor(() => expect(container.querySelector(".brobot-overlay")).not.toBeNull());

    expect(container.querySelector("[data-element]")).toBeNull();
  });

  it("keeps sibling elements visible when one variable element throws", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(overlayPayload(13)));

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} />);

    await waitFor(() => expect(container.querySelectorAll(".brobot-variable__value")).toHaveLength(2));
    expect(container.querySelectorAll("[data-element]")).toHaveLength(2);
    expect(container).toHaveTextContent("1,200");
  });

  it("leaves unknown standalone element IDs transparent", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(overlayPayload()));

    const { container } = render(<OverlayShell token="fictional-token" elementId="unknown-element" />);

    await waitFor(() => expect(document.head.querySelector("style[data-brobot-overlay-css]")).not.toBeNull());
    expect(container).toBeEmptyDOMElement();
  });

  it("strips imports and remote CSS URLs before injection while retaining relative assets", async () => {
    const css = '@import url("https://assets.example/theme.css"); .brobot-overlay { background: url("https://assets.example/image.png"); mask: url("../assets/mask.svg"); }';
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(overlayPayload(1200, css)));

    render(<OverlayShell token="fictional-token" elementId={null} />);

    await waitFor(() => expect(document.head.querySelector("style[data-brobot-overlay-css]")?.textContent)
      .toContain("../assets/mask.svg"));
    const installedCss = document.head.querySelector("style[data-brobot-overlay-css]")?.textContent ?? "";
    expect(installedCss).not.toContain("@import");
    expect(installedCss).not.toContain("https://assets.example");
  });
});
