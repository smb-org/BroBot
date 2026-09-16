import { describe, expect, it, vi } from "vitest";

import { ChannelObject } from "../../src/worker/durable/ChannelObject";

describe("ChannelObject-WebSocket-Gerüst", () => {
  it("beendet die Verbindung nicht bei einer eingehenden Nachricht", () => {
    const webSocket = { close: vi.fn() } as unknown as WebSocket;
    const object = Object.create(ChannelObject.prototype) as ChannelObject;

    object.webSocketMessage(webSocket, "Testnachricht");

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(webSocket.close).not.toHaveBeenCalled();
  });

  it("ruft beim bereits geschlossenen Socket nicht erneut close auf", () => {
    const webSocket = { close: vi.fn() } as unknown as WebSocket;
    const object = Object.create(ChannelObject.prototype) as ChannelObject;

    object.webSocketClose(webSocket, 1006, "", false);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(webSocket.close).not.toHaveBeenCalled();
  });
});
