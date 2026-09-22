import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verarbeiteWerbevorwarnung: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/worker/werbe-vorwarnung", () => mocks);

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
  role: "operator",
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

type StorageDouble = {
  values: Map<string, unknown>;
  setAlarm: ReturnType<typeof vi.fn>;
  deleteAlarm: ReturnType<typeof vi.fn>;
};

const storageOf = (object: ChannelObject): StorageDouble =>
  (object as unknown as { ctx: { storage: StorageDouble } }).ctx.storage;

const objectFor = (sockets: SocketDouble[], database?: D1Database): ChannelObject => {
  const values = new Map<string, unknown>();
  const storage: StorageDouble = {
    values,
    setAlarm: vi.fn(),
    deleteAlarm: vi.fn(),
  };
  const prepared = {
    bind: vi.fn(() => prepared),
    all: vi.fn().mockResolvedValue({ results: [] }),
  };
  const state = {
    id: { name: "kanal-a" },
    getWebSockets: (tag?: string) => tag === undefined
      ? sockets
      : sockets.filter((socket) => socket.tags.includes(tag)),
    storage: {
      ...storage,
      get: vi.fn((key: string) => Promise.resolve(values.get(key))),
      put: vi.fn((key: string, value: unknown) => {
        values.set(key, value);
        return Promise.resolve();
      }),
      delete: vi.fn((key: string) => {
        values.delete(key);
        return Promise.resolve(true);
      }),
    },
  } as unknown as DurableObjectState;
  const object = Object.create(ChannelObject.prototype) as ChannelObject;
  (object as unknown as { ctx: DurableObjectState }).ctx = state;
  (object as unknown as { env: Env }).env = { DB: database ?? ({ prepare: () => prepared } as unknown as D1Database) } as Env;
  return object;
};

const ereignisNachricht: RealtimeEnvelope<"event_log.new"> = {
  version: 1,
  id: "nachricht-1",
  createdAt: "2026-09-21T12:00:00.000Z",
  channelId: "kanal-a",
  type: "event_log.new",
  payload: { entries: [] },
};

describe("ChannelObject-Realtime-Strecke", () => {
  afterEach(() => {
    vi.useRealTimers();
    mocks.verarbeiteWerbevorwarnung.mockClear();
  });

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

  it("hält zwei Fristen getrennt, arbeitet die frühere ab und behält die spätere", async () => {
    vi.useFakeTimers();
    const jetzt = Date.parse("2026-09-21T12:00:00.000Z");
    vi.setSystemTime(jetzt);
    const object = objectFor([]);
    const storage = storageOf(object);

    storage.values.set("security_round", jetzt + 2_000);
    await object.planeWerbevorwarnung(jetzt + 4_000);
    expect(storage.setAlarm).toHaveBeenLastCalledWith(jetzt + 2_000);

    vi.setSystemTime(jetzt + 2_000);
    await object.alarm();
    expect(mocks.verarbeiteWerbevorwarnung).not.toHaveBeenCalled();
    expect(storage.values.size).toBe(1);
    expect([...storage.values.values()]).toEqual([jetzt + 4_000]);
    expect(storage.setAlarm).toHaveBeenLastCalledWith(jetzt + 4_000);

    vi.setSystemTime(jetzt + 4_000);
    await object.alarm();
    expect(mocks.verarbeiteWerbevorwarnung).toHaveBeenCalledTimes(1);
    expect(storage.values.size).toBe(0);
    expect(storage.deleteAlarm).toHaveBeenCalled();
  });

  it("führt die Sicherheitsrunde auch mit offener Vorwarnungsfrist aus", async () => {
    vi.useFakeTimers();
    const jetzt = Date.parse("2026-09-21T12:00:00.000Z");
    vi.setSystemTime(jetzt);
    const socket = socketFor(gueltigerPrinzipal());
    const sockets = [socket];
    const prepare = vi.fn(() => {
      const statement = {
        bind: vi.fn(() => statement),
        all: vi.fn().mockResolvedValue({ results: [] }),
      };
      return statement;
    });
    const database = { prepare } as unknown as D1Database;
    const object = objectFor(sockets, database);
    const storage = storageOf(object);
    socket.close.mockImplementation(() => { sockets.length = 0; });
    storage.values.set("security_round", jetzt - 1);
    await object.planeWerbevorwarnung(jetzt + 60_000);

    await object.alarm();

    expect(prepare).toHaveBeenCalled();
    const close = Reflect.get(socket, "close") as ReturnType<typeof vi.fn>;
    expect(close).toHaveBeenCalledWith(4003, "Berechtigung widerrufen");
    expect([...storage.values.values()]).toEqual([jetzt + 60_000]);
  });
});
