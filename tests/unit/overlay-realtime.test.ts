import { afterEach, describe, expect, it, vi } from "vitest";

import { connectOverlayRealtime } from "../../src/overlay/realtime";
import { OVERLAY_TOKEN_SUBPROTOCOL_PREFIX, REALTIME_PROTOCOL } from "../../src/realtime-contract";

class FakeWebSocket {
  public static instances: FakeWebSocket[] = [];
  public readonly listeners = new Map<string, Set<EventListener>>();
  public closeCalls: Array<[number | undefined, string | undefined]> = [];
  public protocol = REALTIME_PROTOCOL;

  public constructor(
    public readonly url: string,
    public readonly protocols: string | string[] = [],
  ) {
    FakeWebSocket.instances.push(this);
  }

  public addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    const listeners = this.listeners.get(type) ?? new Set<EventListener>();
    listeners.add(typeof listener === "function" ? listener : (event) => {
      listener.handleEvent(event);
    });
    this.listeners.set(type, listeners);
  }

  public close(code?: number, reason?: string): void {
    this.closeCalls.push([code, reason]);
    this.dispatch("close", { code: code ?? 1000, reason: reason ?? "" } as CloseEvent);
  }

  public dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

describe("overlay realtime client", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    FakeWebSocket.instances = [];
  });

  it("authenticates in the protocol list without adding the token to the URL", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const stop = connectOverlayRealtime("z".repeat(43));

    const socket = FakeWebSocket.instances[0];
    expect(socket === undefined ? null : new URL(socket.url).pathname).toBe("/ws/overlay");
    expect(socket?.url.startsWith("ws://")).toBe(true);
    expect(socket?.url).not.toContain("z".repeat(43));
    expect(socket?.protocols).toEqual([REALTIME_PROTOCOL, `${OVERLAY_TOKEN_SUBPROTOCOL_PREFIX}${"z".repeat(43)}`]);
    stop();
  });

  it("reconnects with exponential backoff after a transient close", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 })));
    const stop = connectOverlayRealtime("z".repeat(43));

    FakeWebSocket.instances[0]?.dispatch("close", { code: 1006, reason: "network" } as CloseEvent);
    await vi.advanceTimersByTimeAsync(249);
    expect(FakeWebSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.instances[1]?.dispatch("close", { code: 1006, reason: "network" } as CloseEvent);
    await vi.advanceTimersByTimeAsync(499);
    expect(FakeWebSocket.instances).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWebSocket.instances).toHaveLength(3);

    stop();
  });

  it("revalidates before reconnecting and stops when bootstrap reports a revoked token", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetcher);
    const terminalClose = vi.fn();
    const stop = connectOverlayRealtime("z".repeat(43), terminalClose);

    FakeWebSocket.instances[0]?.dispatch("close", { code: 1006, reason: "handshake rejected" } as CloseEvent);
    await vi.advanceTimersByTimeAsync(250);

    expect(fetcher).toHaveBeenCalledWith("/api/overlay/bootstrap", {
      headers: { Authorization: `Bearer ${"z".repeat(43)}` },
      cache: "no-store",
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(terminalClose).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    stop();
  });

  it("keeps retrying when bootstrap revalidation has a transient network failure", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const terminalClose = vi.fn();
    const stop = connectOverlayRealtime("z".repeat(43), terminalClose);

    FakeWebSocket.instances[0]?.dispatch("close", { code: 1006, reason: "network" } as CloseEvent);
    await vi.advanceTimersByTimeAsync(250);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(terminalClose).not.toHaveBeenCalled();

    FakeWebSocket.instances[1]?.dispatch("close", { code: 1006, reason: "network" } as CloseEvent);
    await vi.advanceTimersByTimeAsync(500);
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(terminalClose).not.toHaveBeenCalled();
    stop();
  });

  it("revalidates after three consecutive abnormal handshakes", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const stop = connectOverlayRealtime("z".repeat(43));

    FakeWebSocket.instances[0]?.dispatch("close", { code: 1006, reason: "handshake failed" } as CloseEvent);
    await vi.advanceTimersByTimeAsync(250);
    FakeWebSocket.instances[1]?.dispatch("close", { code: 1006, reason: "handshake failed" } as CloseEvent);
    await vi.advanceTimersByTimeAsync(500);
    FakeWebSocket.instances[2]?.dispatch("close", { code: 1006, reason: "handshake failed" } as CloseEvent);
    await vi.advanceTimersByTimeAsync(0);

    expect(fetcher).toHaveBeenCalledTimes(3);
    stop();
  });

  it("reconnects after the server marks a close as transient", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const stop = connectOverlayRealtime("z".repeat(43));

    FakeWebSocket.instances[0]?.dispatch("close", { code: 4008, reason: "temporary" } as CloseEvent);
    await vi.advanceTimersByTimeAsync(250);

    expect(FakeWebSocket.instances).toHaveLength(2);
    stop();
  });

  it("does not reconnect after a token is revoked", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const stop = connectOverlayRealtime("z".repeat(43));

    FakeWebSocket.instances[0]?.dispatch("close", { code: 4003, reason: "revoked" } as CloseEvent);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(FakeWebSocket.instances).toHaveLength(1);
    stop();
  });

  it("reports a terminal close so a later successful status poll can restart it", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const terminalClose = vi.fn();
    const stop = connectOverlayRealtime("z".repeat(43), terminalClose);

    FakeWebSocket.instances[0]?.dispatch("close", { code: 4003, reason: "revoked" } as CloseEvent);

    expect(terminalClose).toHaveBeenCalledTimes(1);
    stop();
  });

  it("reports typed messages and whether an open follows a reconnect", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const opened: boolean[] = [];
    const messages: unknown[] = [];
    const overlayChanges: unknown[] = [];
    const stop = connectOverlayRealtime("z".repeat(43), undefined, {
      onOpen: (reconnected: boolean) => opened.push(reconnected),
      onMessage: (message: unknown) => messages.push(message),
      onOverlayChanged: (message: unknown) => overlayChanges.push(message),
    });

    FakeWebSocket.instances[0]?.dispatch("open", new Event("open"));
    FakeWebSocket.instances[0]?.dispatch("message", {
      data: JSON.stringify({
        version: 1,
        id: "message-1",
        createdAt: "2026-09-24T12:00:00.000Z",
        channelId: "channel-a",
        type: "system.hello",
        payload: {},
      }),
    } as MessageEvent<string>);
    FakeWebSocket.instances[0]?.dispatch("message", {
      data: JSON.stringify({
        version: 1,
        id: "message-3",
        createdAt: "2026-09-24T12:00:02.000Z",
        channelId: "channel-a",
        type: "overlay.changed",
        payload: { overlayId: "overlay-a", revision: 3 },
      }),
    } as MessageEvent<string>);
    FakeWebSocket.instances[0]?.dispatch("message", {
      data: JSON.stringify({
        version: 1,
        id: "message-2",
        createdAt: "2026-09-24T12:00:01.000Z",
        channelId: "channel-a",
        type: "variables.changed",
        payload: { set: [{ name: "score", value: 8 }], removed: [] },
      }),
    } as MessageEvent<string>);
    FakeWebSocket.instances[0]?.dispatch("close", { code: 1006, reason: "network" } as CloseEvent);
    await vi.advanceTimersByTimeAsync(250);
    FakeWebSocket.instances[1]?.dispatch("open", new Event("open"));

    expect(opened).toEqual([false, true]);
    expect(messages).toMatchObject([{ type: "variables.changed", payload: { set: [{ name: "score", value: 8 }] } }]);
    expect(overlayChanges).toMatchObject([{ type: "overlay.changed", payload: { overlayId: "overlay-a", revision: 3 } }]);
    stop();
  });
});
