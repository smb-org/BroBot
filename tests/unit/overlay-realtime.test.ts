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

  it("does not reconnect after a token is revoked", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const stop = connectOverlayRealtime("z".repeat(43));

    FakeWebSocket.instances[0]?.dispatch("close", { code: 4003, reason: "revoked" } as CloseEvent);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(FakeWebSocket.instances).toHaveLength(1);
    stop();
  });
});
