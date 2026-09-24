import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const realtimeMocks = vi.hoisted(() => ({ connectOverlayRealtime: vi.fn() }));

vi.mock("../../src/overlay/realtime", () => realtimeMocks);

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
});
