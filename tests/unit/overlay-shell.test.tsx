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

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} debug={false} />);

    await waitFor(() => expect(container.querySelectorAll("[data-element]")).toHaveLength(3));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/api/overlay/bootstrap", expect.objectContaining({
      headers: { Authorization: "Bearer fictional-token" },
      cache: "no-store",
    }));
    expect(realtimeMocks.connectOverlayRealtime).toHaveBeenCalledTimes(1);
    expect(realtimeMocks.connectOverlayRealtime).toHaveBeenCalledWith("fictional-token", expect.any(Function), expect.any(Object));
    expect(container.querySelector(".brobot-overlay")).toHaveStyle({ width: "1920px", height: "1080px" });
    expect(container.querySelector('[data-element="element-first"]')).toHaveStyle({ left: "20px", top: "30px", zIndex: "4" });
    expect(container.querySelector('[data-element="element-third"]')).toHaveStyle({ left: "120px", top: "140px", transform: "scale(0.75)" });
    expect(container.querySelector('[data-element="element-second"]')).not.toBeNull();
    expect(container.querySelectorAll(".brobot-variable")).toHaveLength(3);
    expect(container.querySelectorAll(".brobot-variable__text")).toHaveLength(3);
    expect(container.querySelectorAll(".brobot-variable__value")).toHaveLength(3);
    await waitFor(() => expect(document.head.querySelector("style[data-brobot-overlay-css]")?.textContent)
      .toBe(".brobot-overlay { color: white; }"));
  });

  it("renders one selected element at the origin with its stored scale", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(overlayPayload(1200, ".brobot-overlay { color: white; }", false)));

    const { container } = render(<OverlayShell token="fictional-token" elementId="element-second" debug={false} />);

    await waitFor(() => expect(container.querySelector('[data-element="element-second"]')).not.toBeNull());
    expect(container.querySelectorAll("[data-element]")).toHaveLength(1);
    expect(container.querySelector('[data-element="element-second"]')).toHaveStyle({
      left: "0px",
      top: "0px",
      transform: "scale(1.5)",
    });
  });

  it("updates live values, debounces overlay changes, and reloads after reconnect", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(overlayPayload()));
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} debug={false} />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
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

  it("keeps sibling elements visible when one variable element throws", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(overlayPayload(13)));

    const { container } = render(<OverlayShell token="fictional-token" elementId={null} debug={false} />);

    await waitFor(() => expect(container.querySelectorAll(".brobot-variable__value")).toHaveLength(2));
    expect(container.querySelectorAll("[data-element]")).toHaveLength(2);
    expect(container).toHaveTextContent("1,200");
  });

  it("leaves unknown standalone element IDs transparent", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(overlayPayload()));

    const { container } = render(<OverlayShell token="fictional-token" elementId="unknown-element" debug={false} />);

    await waitFor(() => expect(document.head.querySelector("style[data-brobot-overlay-css]")).not.toBeNull());
    expect(container).toBeEmptyDOMElement();
  });
});
