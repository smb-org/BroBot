import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";

import { TestWebSocket } from "../components/test-websocket";

const realtimeMocks = vi.hoisted(() => ({ connectOverlayRealtime: vi.fn() }));

vi.mock("../../src/overlay/realtime", () => realtimeMocks);

import * as overlayStatus from "../../src/overlay/status";
import { OverlayStatusView } from "../../src/overlay/status";

const versionResponse = (version: string): Response => new Response(
  JSON.stringify({ version, language: "de" }),
  { status: 200, headers: { "Content-Type": "application/json" } },
);

const invalidResponse = (): Response => new Response("", { status: 401 });

const variableResponse = (name: string, value: number, language: "de" | "en" = "en"): Response => new Response(
  JSON.stringify({ name, value }),
  { status: 200, headers: { "Content-Type": "application/json", "Content-Language": language } },
);

const setFragment = (token: string): void => {
  window.history.replaceState(null, "", `/overlay#token=${token}`);
};

const setDebugFragment = (fragment = "erstes-token"): void => {
  setFragment(`${fragment}&debug=1`);
};

describe("Overlay status view", () => {
  beforeEach(() => {
    setDebugFragment();
    TestWebSocket.instances = [];
    vi.stubGlobal("WebSocket", TestWebSocket);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    realtimeMocks.connectOverlayRealtime.mockReset();
    setFragment("");
  });

  it.each([
    ["backend error", invalidResponse()],
    ["network error", new Error("Netzwerk unterbrochen")],
  ])("stays completely empty on a %s", async (_description, failure) => {
    const fetcher = vi.fn();
    fetcher.mockImplementation(() => failure instanceof Error
      ? Promise.reject(failure)
      : Promise.resolve(failure));
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayStatusView />);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    expect(container).toBeEmptyDOMElement();
  });

  it("keeps the default status page empty and only shows diagnostics with debug=1", async () => {
    const fetcher = vi.fn().mockResolvedValue(versionResponse("debug-version"));
    vi.stubGlobal("fetch", fetcher);
    setFragment("erstes-token");

    const { container } = render(<OverlayStatusView />);
    expect(container).toBeEmptyDOMElement();
    expect(fetcher).not.toHaveBeenCalled();

    act(() => {
      setDebugFragment();
      window.dispatchEvent(new Event("hashchange"));
    });

    await waitFor(() => expect(container).toHaveTextContent("Version debug-version"));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries after a startup error without reloading", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error("Worker nicht erreichbar"))
      .mockResolvedValueOnce(versionResponse("wieder-da"));
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayStatusView />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container).toBeEmptyDOMElement();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.resolve();
    });

    expect(container).toHaveTextContent("Version wieder-da");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("re-checks a changed fragment token within the same document", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(versionResponse("alt"))
      .mockResolvedValueOnce(versionResponse("neu"));
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayStatusView />);
    await waitFor(() => expect(container).toHaveTextContent("Version alt"));

    act(() => {
      setDebugFragment("zweites-token");
      window.dispatchEvent(new Event("hashchange"));
    });

    await waitFor(() => expect(container).toHaveTextContent("Version neu"));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
      headers: { Authorization: "Bearer zweites-token" },
    });
  });

  it("turns a revocation into invisible content on the next poll", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(versionResponse("laufend"))
      .mockResolvedValueOnce(invalidResponse());
    vi.stubGlobal("fetch", fetcher);

    const { container } = render(<OverlayStatusView />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container).toHaveTextContent("Version laufend");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
      await Promise.resolve();
    });

    expect(container).toBeEmptyDOMElement();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("restarts a terminally closed socket after a successful status poll", async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(versionResponse("laufend")));
    vi.stubGlobal("fetch", fetcher);
    realtimeMocks.connectOverlayRealtime.mockReturnValue(vi.fn());

    render(<OverlayStatusView />);
    await waitFor(() => expect(realtimeMocks.connectOverlayRealtime).toHaveBeenCalledTimes(1));

    const onTerminalClose = realtimeMocks.connectOverlayRealtime.mock.calls[0]?.[1] as (() => void) | undefined;
    expect(onTerminalClose).toBeTypeOf("function");
    act(() => onTerminalClose?.());
    await act(async () => {
      await Promise.resolve();
      window.dispatchEvent(new Event("hashchange"));
    });

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(realtimeMocks.connectOverlayRealtime).toHaveBeenCalledTimes(2));
  });

  it("moderately increases the interval after repeated failures", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockRejectedValue(new Error("Worker nicht erreichbar"));
    vi.stubGlobal("fetch", fetcher);

    render(<OverlayStatusView />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(119_999);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("renders the selected channel variable as text with stable styling classes", async () => {
    setFragment("erstes-token&var=score&text=Score%3A+%7Bvalue%7D");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(variableResponse("score", 12_345)));
    realtimeMocks.connectOverlayRealtime.mockReturnValue(vi.fn());
    const entry = Reflect.get(overlayStatus, "OverlayEntry");
    expect(typeof entry).toBe("function");
    if (typeof entry !== "function") return;

    const View = entry as ComponentType;
    const { container } = render(<View />);

    await waitFor(() => expect(container.querySelector(".brobot-variable__value")).toHaveTextContent("12,345"));
    expect(container.querySelector(".brobot-variable__text")?.textContent).toBe("Score: ");
    const variable = container.querySelector(".brobot-variable");
    expect(variable).toHaveAttribute("data-variable", "score");
    expect(variable).not.toHaveAttribute("style");
  });

  it("renders overlay templates as text nodes", async () => {
    setFragment("erstes-token&var=score&text=%3Cb%3E%7Bvalue%7D%3C%2Fb%3E");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(variableResponse("score", 7)));
    realtimeMocks.connectOverlayRealtime.mockReturnValue(vi.fn());
    const entry = Reflect.get(overlayStatus, "OverlayEntry");
    expect(typeof entry).toBe("function");
    if (typeof entry !== "function") return;
    const View = entry as ComponentType;

    const { container } = render(<View />);

    await waitFor(() => expect(container.querySelector(".brobot-variable__value")).toHaveTextContent("7"));
    expect(container.querySelector("b")).toBeNull();
    expect(container.querySelector(".brobot-variable__text")).toHaveTextContent("<b>");
  });

  it("formats the value using the channel language from the token-scoped response", async () => {
    setFragment("erstes-token&var=score&text=%7Bvalue%7D");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(variableResponse("score", 12_345, "de")));
    realtimeMocks.connectOverlayRealtime.mockReturnValue(vi.fn());
    const entry = Reflect.get(overlayStatus, "OverlayEntry");
    if (typeof entry !== "function") throw new Error("Overlay entry component is missing.");
    const View = entry as ComponentType;

    const { container } = render(<View />);

    await waitFor(() => expect(container.querySelector(".brobot-variable__value")).toHaveTextContent("12.345"));
  });

  it("reconciles the initial load after the first realtime connection opens", async () => {
    setFragment("erstes-token&var=score&text=%7Bvalue%7D");
    let loadCount = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => {
      loadCount += 1;
      return Promise.resolve(variableResponse("score", loadCount));
    });
    vi.stubGlobal("fetch", fetcher);
    let callbacks: { onOpen: (reconnected: boolean) => void } | null = null;
    realtimeMocks.connectOverlayRealtime.mockImplementation((_token, _terminalClose, handler) => {
      callbacks = handler as typeof callbacks;
      return vi.fn();
    });
    const entry = Reflect.get(overlayStatus, "OverlayEntry");
    if (typeof entry !== "function") throw new Error("Overlay entry component is missing.");
    const View = entry as ComponentType;

    const { container } = render(<View />);
    await waitFor(() => expect(container.querySelector(".brobot-variable__value")).toHaveTextContent("1"));
    act(() => callbacks?.onOpen(false));

    await waitFor(() => expect(container.querySelector(".brobot-variable__value")).toHaveTextContent("2"));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("renders no variable content when the configured variable is unknown", async () => {
    setFragment("erstes-token&var=missing&text=%7Bvalue%7D");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    realtimeMocks.connectOverlayRealtime.mockReturnValue(vi.fn());
    const entry = Reflect.get(overlayStatus, "OverlayEntry");
    if (typeof entry !== "function") throw new Error("Overlay entry component is missing.");
    const View = entry as ComponentType;

    const { container } = render(<View />);

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(container.querySelector(".brobot-variable")).toBeNull();
  });

  it("reconciles set and removal hints from authoritative state with a bounded debounce", async () => {
    setFragment("erstes-token&var=score&text=Score%3A+%7Bvalue%7D");
    let authoritativeValue = 10;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(variableResponse("score", authoritativeValue)));
    vi.stubGlobal("fetch", fetcher);
    let callbacks: {
      onOpen: (reconnected: boolean) => void;
      onMessage: (message: unknown) => void;
    } | null = null;
    realtimeMocks.connectOverlayRealtime.mockImplementation((_token, _terminalClose, handler) => {
      callbacks = handler as typeof callbacks;
      return vi.fn();
    });
    const entry = Reflect.get(overlayStatus, "OverlayEntry");
    expect(typeof entry).toBe("function");
    if (typeof entry !== "function") return;

    vi.useFakeTimers();
    const View = entry as ComponentType;
    const { container } = render(<View />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".brobot-variable__value")).toHaveTextContent("10");

    const message = (value: number | null) => ({
      version: 1,
      id: `update-${String(value)}-${String(Math.random())}`,
      createdAt: "2026-09-24T12:00:00.000Z",
      channelId: "channel-a",
      type: "variables.changed",
      payload: value === null
        ? { set: [], removed: ["score"] }
        : { set: [{ name: "score", value }], removed: [] },
    });
    act(() => callbacks?.onMessage(message(99)));
    act(() => callbacks?.onMessage(message(null)));
    expect(container.querySelector(".brobot-variable__value")).toHaveTextContent("10");
    authoritativeValue = 12;
    await act(async () => { await vi.advanceTimersByTimeAsync(249); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".brobot-variable__value")).toHaveTextContent("12");

    authoritativeValue = 15;
    for (let index = 0; index < 7; index++) {
      act(() => callbacks?.onMessage(message(200 + index)));
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    }
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".brobot-variable__value")).toHaveTextContent("12");
    act(() => callbacks?.onMessage(message(207)));
    await act(async () => { await vi.advanceTimersByTimeAsync(99); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".brobot-variable__value")).toHaveTextContent("12");
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(container.querySelector(".brobot-variable__value")).toHaveTextContent("15");
  });

  it("keeps refreshing while realtime hints arrive faster than requests complete", async () => {
    setFragment("erstes-token&var=score&text=%7Bvalue%7D");
    vi.useFakeTimers();
    let requestValue = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => {
      const value = ++requestValue;
      return new Promise<Response>((resolve) => {
        window.setTimeout(() => resolve(variableResponse("score", value)), 300);
      });
    });
    vi.stubGlobal("fetch", fetcher);
    let callbacks: { onOpen: (reconnected: boolean) => void; onMessage: (message: unknown) => void } | null = null;
    realtimeMocks.connectOverlayRealtime.mockImplementation((_token, _terminalClose, handler) => {
      callbacks = handler as typeof callbacks;
      return vi.fn();
    });
    const entry = Reflect.get(overlayStatus, "OverlayEntry");
    if (typeof entry !== "function") throw new Error("Overlay entry component is missing.");
    const View = entry as ComponentType;

    const { container } = render(<View />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(container.querySelector(".brobot-variable__value")).toHaveTextContent("1");

    const message = (id: number) => ({
      version: 1,
      id: `update-${String(id)}`,
      createdAt: "2026-09-24T12:00:00.000Z",
      channelId: "channel-a",
      type: "variables.changed",
      payload: { set: [{ name: "score", value: id }], removed: [] },
    });
    const displayedValues = new Set([container.querySelector(".brobot-variable__value")?.textContent]);
    for (let index = 0; index < 30; index++) {
      act(() => callbacks?.onMessage(message(index)));
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      displayedValues.add(container.querySelector(".brobot-variable__value")?.textContent);
    }

    expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(displayedValues.has("2")).toBe(true);
    expect(displayedValues.has("3")).toBe(true);
    expect(Number(container.querySelector(".brobot-variable__value")?.textContent)).toBeGreaterThan(3);
  });

  it("keeps retrying through four startup failures until the variable request succeeds", async () => {
    setFragment("erstes-token&var=score&text=%7Bvalue%7D");
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("Worker nicht erreichbar"))
      .mockRejectedValueOnce(new Error("Worker nicht erreichbar"))
      .mockRejectedValueOnce(new Error("Worker nicht erreichbar"))
      .mockRejectedValueOnce(new Error("Worker nicht erreichbar"))
      .mockResolvedValueOnce(variableResponse("score", 5));
    vi.stubGlobal("fetch", fetcher);
    realtimeMocks.connectOverlayRealtime.mockReturnValue(vi.fn());
    const entry = Reflect.get(overlayStatus, "OverlayEntry");
    if (typeof entry !== "function") throw new Error("Overlay entry component is missing.");
    const View = entry as ComponentType;

    const { container } = render(<View />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    for (const [index, delay] of [1_000, 2_000, 4_000, 8_000].entries()) {
      await act(async () => { await vi.advanceTimersByTimeAsync(delay); });
      expect(fetcher).toHaveBeenCalledTimes(index + 2);
    }
    expect(container.querySelector(".brobot-variable__value")).toHaveTextContent("5");
  });

  it("clears pending variable refresh timers when unmounted", async () => {
    setFragment("erstes-token&var=score&text=%7Bvalue%7D");
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>()
      .mockImplementationOnce(() => new Promise<Response>((_resolve, reject) => {
        window.setTimeout(() => reject(new Error("Worker nicht erreichbar")), 500);
      }))
      .mockRejectedValue(new Error("Worker nicht erreichbar"));
    vi.stubGlobal("fetch", fetcher);
    let callbacks: { onOpen: (reconnected: boolean) => void; onMessage: (message: unknown) => void } | null = null;
    realtimeMocks.connectOverlayRealtime.mockImplementation((_token, _terminalClose, handler) => {
      callbacks = handler as typeof callbacks;
      return vi.fn();
    });
    const entry = Reflect.get(overlayStatus, "OverlayEntry");
    if (typeof entry !== "function") throw new Error("Overlay entry component is missing.");
    const View = entry as ComponentType;

    const { unmount } = render(<View />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(400); });
    act(() => callbacks?.onMessage({
      version: 1,
      id: "pending-update",
      createdAt: "2026-09-24T12:00:00.000Z",
      channelId: "channel-a",
      type: "variables.changed",
      payload: { set: [{ name: "score", value: 2 }], removed: [] },
    }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetcher).toHaveBeenCalledTimes(1);

    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(180_000); });

    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
