import { describe, expect, it, vi } from "vitest";

import type {
  RealtimeEnvelope,
  RealtimePanelPrincipal,
} from "../../src/realtime-contract";
import { ChannelObject } from "../../src/worker/durable/ChannelObject";
import { REALTIME_PRINCIPAL_HEADER, REALTIME_PROTOCOL } from "../../src/worker/realtime-protocol";

const gueltigerPrinzipal = (
  overrides: Partial<RealtimePanelPrincipal> = {},
): RealtimePanelPrincipal => ({
  v: 1,
  kind: "panel",
  channelId: "kanal-a",
  userId: "user-1",
  sessionId: "session-1",
  role: "bediener",
  expiresAt: "2099-09-19T00:00:00.000Z",
  ...overrides,
});

const upgradeRequest = (principal?: RealtimePanelPrincipal): Request => new Request(
  "https://channel-object.internal/ws",
  {
    headers: {
      Upgrade: "websocket",
      "Sec-WebSocket-Protocol": REALTIME_PROTOCOL,
      ...(principal === undefined ? {} : { [REALTIME_PRINCIPAL_HEADER]: JSON.stringify(principal) }),
    },
  },
);

type SocketDouble = WebSocket & {
  tags: string[];
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  deserializeAttachment: ReturnType<typeof vi.fn>;
};

const socketFor = (principal: RealtimePanelPrincipal): SocketDouble => ({
  tags: [
    "kind:panel",
    `user:${principal.userId}`,
    `session:${principal.sessionId}`,
  ],
  send: vi.fn(),
  close: vi.fn(),
  deserializeAttachment: vi.fn(() => principal),
} as unknown as SocketDouble);

const objectFor = (sockets: SocketDouble[]): ChannelObject => {
  const state = {
    id: { name: "kanal-a" },
    getWebSockets: (tag?: string) => tag === undefined
      ? sockets
      : sockets.filter((socket) => socket.tags.includes(tag)),
    storage: {
      setAlarm: vi.fn(),
      deleteAlarm: vi.fn(),
    },
  } as unknown as DurableObjectState;
  const object = Object.create(ChannelObject.prototype) as ChannelObject;
  (object as unknown as { ctx: DurableObjectState }).ctx = state;
  return object;
};

const ereignisNachricht: RealtimeEnvelope<"ereignisprotokoll.neu"> = {
  version: 1,
  id: "nachricht-1",
  createdAt: "2026-09-21T12:00:00.000Z",
  channelId: "kanal-a",
  type: "ereignisprotokoll.neu",
  payload: { entries: [] },
};

describe("ChannelObject-Realtime-Strecke", () => {
  it("weist einen Aufbau ohne Prinzipal mit 403 ab", () => {
    const object = objectFor([]);

    expect(object.fetch(upgradeRequest()).status).toBe(403);
  });

  it("weist einen Prinzipal für einen fremden Kanal mit 403 ab", () => {
    const object = objectFor([]);

    expect(object.fetch(upgradeRequest(gueltigerPrinzipal({ channelId: "kanal-b" }))).status).toBe(403);
  });

  it("weist eine Veröffentlichung für einen fremden Kanal ab", () => {
    const object = objectFor([]);

    expect(() => {
      object.publish({ ...ereignisNachricht, channelId: "kanal-b" });
    }).toThrow(/fremden Kanal/);
  });

  it("sendet an eine abgelaufene Verbindung nichts mehr", () => {
    const abgelaufen = socketFor(gueltigerPrinzipal({ expiresAt: "2000-01-01T00:00:00.000Z" }));
    const gueltig = socketFor(gueltigerPrinzipal({ userId: "user-2", sessionId: "session-2" }));
    const object = objectFor([abgelaufen, gueltig]);

    object.publish(ereignisNachricht);

    expect(abgelaufen.send.mock.calls).toHaveLength(0);
    expect(abgelaufen.close.mock.calls).toEqual([[4001, "Berechtigung abgelaufen"]]);
    expect(gueltig.send.mock.calls).toHaveLength(1);
  });

  it("widerruft nur die Verbindung des betroffenen Nutzers", async () => {
    const betroffener = socketFor(gueltigerPrinzipal());
    const anderer = socketFor(gueltigerPrinzipal({ userId: "user-2", sessionId: "session-2" }));
    const object = objectFor([betroffener, anderer]);

    await object.revokeUser("user-1");

    expect(betroffener.close.mock.calls).toEqual([[4003, "Kanalzugriff widerrufen"]]);
    expect(anderer.close.mock.calls).toHaveLength(0);
  });
});
