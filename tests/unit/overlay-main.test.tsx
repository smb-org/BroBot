import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentType } from "react";

const realtimeMocks = vi.hoisted(() => ({ connectOverlayRealtime: vi.fn() }));

vi.mock("../../src/overlay/realtime", () => realtimeMocks);

import * as overlayStatus from "../../src/overlay/status";
import { OverlayStatusView } from "../../src/overlay/status";

class QuietWebSocket {
  public static instances: QuietWebSocket[] = [];
  public protocol = "brobot.v1";
  public readonly listeners = new Map<string, Set<EventListener>>();

  public constructor() {
    QuietWebSocket.instances.push(this);
  }

  public addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(typeof listener === "function" ? listener : (event) => listener.handleEvent(event));
    this.listeners.set(type, listeners);
  }

  public close(code = 1000): void {
    this.dispatch("close", { code, reason: "closed" } as CloseEvent);
  }

  public dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

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

describe("Overlay status view", () => {
  beforeEach(() => {
    setFragment("erstes-token");
    QuietWebSocket.instances = [];
    vi.stubGlobal("WebSocket", QuietWebSocket);
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
      setFragment("zweites-token");
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
    expect(container.querySelector(".brobot-variable")).toHaveAttribute("data-variable", "score");
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

  it("reloads on reconnect and debounces variable changes for 1.5 seconds", async () => {
    setFragment("erstes-token&var=score&text=Score%3A+%7Bvalue%7D");
    let loadCount = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => {
      loadCount += 1;
      if (loadCount === 3) return Promise.resolve(new Response("", { status: 503 }));
      return Promise.resolve(variableResponse("score", loadCount));
    });
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

    const View = entry as ComponentType;
    const { container } = render(<View />);
    await waitFor(() => expect(container.querySelector(".brobot-variable__value")).toHaveTextContent("1"));

    act(() => callbacks?.onOpen(true));
    await waitFor(() => expect(container.querySelector(".brobot-variable__value")).toHaveTextContent("2"));
    expect(fetcher).toHaveBeenCalledTimes(2);

    vi.useFakeTimers();
    const message = (value: number) => ({
      version: 1,
      id: `update-${String(value)}`,
      createdAt: "2026-09-24T12:00:00.000Z",
      channelId: "channel-a",
      type: "variables.changed",
      payload: { set: [{ name: "score", value }], removed: [] },
    });
    act(() => callbacks?.onMessage(message(3)));
    expect(container.querySelector(".brobot-variable__value")).toHaveTextContent("3");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    act(() => callbacks?.onMessage(message(4)));
    expect(container.querySelector(".brobot-variable__value")).toHaveTextContent("4");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_499); });
    expect(fetcher).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(container.querySelector(".brobot-variable__value")).toHaveTextContent("4");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(container.querySelector(".brobot-variable__value")).toHaveTextContent("4");
  });
});
