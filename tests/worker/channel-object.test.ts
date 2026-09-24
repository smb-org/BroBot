import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processAdPrewarning: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../src/worker/ad-prewarning", () => mocks);

import type {
  RealtimeEnvelope,
  RealtimeOverlayPrincipal,
  RealtimePanelPrincipal,
  RealtimePrincipal,
} from "../../src/realtime-contract";
import { ChannelObject } from "../../src/worker/durable/ChannelObject";
import { REALTIME_PRINCIPAL_HEADER, REALTIME_PROTOCOL } from "../../src/worker/realtime-protocol";

const validPrincipal = (
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

const upgradeRequest = (principal?: RealtimePrincipal): Request => new Request(
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
  send: ReturnType<typeof vi.fn<(message: string) => void>>;
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

const overlaySocketFor = (
  input: Omit<RealtimeOverlayPrincipal, "overlayId"> & { overlayId?: string | null },
): SocketDouble => {
  const principal: RealtimeOverlayPrincipal = { ...input, overlayId: input.overlayId ?? null };
  return {
    tags: ["kind:overlay", `token:${principal.tokenId}`,
      ...(principal.overlayId === null ? [] : [`overlay:${principal.overlayId}`])],
    send: vi.fn(),
    close: vi.fn(),
    deserializeAttachment: vi.fn(() => principal),
  } as unknown as SocketDouble;
};

type StorageDouble = {
  values: Map<string, unknown>;
  list: ReturnType<typeof vi.fn>;
  setAlarm: ReturnType<typeof vi.fn>;
  deleteAlarm: ReturnType<typeof vi.fn>;
};

const storageOf = (object: ChannelObject): StorageDouble =>
  (object as unknown as { ctx: { storage: StorageDouble } }).ctx.storage;

const objectFor = (sockets: SocketDouble[], database?: D1Database): ChannelObject => {
  const values = new Map<string, unknown>();
  let transactionQueue = Promise.resolve();
  const storage: StorageDouble = {
    values,
    list: vi.fn((options?: { prefix?: string; startAfter?: string; limit?: number }) => {
      const keys = [...values.keys()]
        .filter((key) => options?.prefix === undefined || key.startsWith(options.prefix))
        .filter((key) => options?.startAfter === undefined || key > options.startAfter)
        .sort()
        .slice(0, options?.limit);
      return Promise.resolve(new Map(keys.map((key) => [key, values.get(key)])));
    }),
    setAlarm: vi.fn(),
    deleteAlarm: vi.fn(),
  };
  const prepared = {
    bind: vi.fn(() => prepared),
    all: vi.fn().mockResolvedValue({ results: [] }),
    first: vi.fn().mockResolvedValue({ token_id: "token-1" }),
  };
  const state = {
    id: { name: "kanal-a" },
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets: (tag?: string) => tag === undefined
      ? sockets
      : sockets.filter((socket) => socket.tags.includes(tag)),
    acceptWebSocket: vi.fn((socket: WebSocket) => { sockets.push(socket as SocketDouble); }),
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
      list: storage.list,
      transaction: vi.fn(async <T>(closure: (transaction: {
        get: <Value>(key: string) => Promise<Value | undefined>;
        put: (key: string, value: unknown) => Promise<void>;
        delete: (key: string) => Promise<boolean>;
      }) => Promise<T>) => {
        const predecessor = transactionQueue;
        let release!: () => void;
        transactionQueue = new Promise<void>((resolve) => { release = resolve; });
        await predecessor;
        try {
          return await closure({
            get: <Value>(key: string) => Promise.resolve(values.get(key) as Value | undefined),
            put: (key: string, value: unknown) => {
              values.set(key, value);
              return Promise.resolve();
            },
            delete: (key: string) => Promise.resolve(values.delete(key)),
          });
        } finally {
          release();
        }
      }),
    },
  } as unknown as DurableObjectState;
  const object = Object.create(ChannelObject.prototype) as ChannelObject;
  (object as unknown as { ctx: DurableObjectState }).ctx = state;
  (object as unknown as { env: Env }).env = { DB: database ?? ({ prepare: () => prepared } as unknown as D1Database) } as Env;
  return object;
};

const typeOfSerializedMessage = (serialized: string): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const type = Reflect.get(parsed, "type") as unknown;
  return typeof type === "string" ? type : null;
};

const eventMessage: RealtimeEnvelope<"event_log.new"> = {
  version: 1,
  id: "nachricht-1",
  createdAt: "2026-09-21T12:00:00.000Z",
  channelId: "kanal-a",
  type: "event_log.new",
  payload: { entries: [] },
};

describe("ChannelObject realtime path", () => {
  afterEach(() => {
    vi.useRealTimers();
    mocks.processAdPrewarning.mockClear();
  });

  it("rejects a connection without a principal with 403", () => {
    const object = objectFor([]);

    return expect(object.fetch(upgradeRequest())).resolves.toHaveProperty("status", 403);
  });

  it("rejects a principal for a foreign channel with 403", async () => {
    const object = objectFor([]);

    await expect(object.fetch(upgradeRequest(validPrincipal({ channelId: "kanal-b" })))
      .then((response) => response.status)).resolves.toBe(403);
  });

  it("rejects an overlay principal for a foreign channel with 403", async () => {
    const object = objectFor([]);

    await expect(object.fetch(upgradeRequest({
      v: 1,
      kind: "overlay",
      channelId: "kanal-b",
      tokenId: "token-1",
      overlayId: null,
      expiresAt: null,
    })).then((response) => response.status)).resolves.toBe(403);
  });

  it("rejects a publish for a foreign channel", () => {
    const object = objectFor([]);

    expect(() => {
      object.publish([{ ...eventMessage, channelId: "kanal-b" }]);
    }).toThrow(/foreign channel/);
  });

  it("sends nothing more to an expired connection", () => {
    const expired = socketFor(validPrincipal({ expiresAt: "2000-01-01T00:00:00.000Z" }));
    const valid = socketFor(validPrincipal({ userId: "user-2", sessionId: "session-2" }));
    const object = objectFor([expired, valid]);

    object.publish([eventMessage]);

    expect(expired.send.mock.calls).toHaveLength(0);
    expect(expired.close.mock.calls).toEqual([[4001, "authorization expired"]]);
    expect(valid.send.mock.calls).toHaveLength(1);
  });

  it("keeps panel-only event-log hints away from overlay sockets", () => {
    const panel = socketFor(validPrincipal());
    const overlay = overlaySocketFor({
      v: 1,
      kind: "overlay",
      channelId: "kanal-a",
      tokenId: "token-1",
      expiresAt: null,
    });
    const object = objectFor([panel, overlay]);

    object.publish([eventMessage]);

    expect(panel.send.mock.calls).toHaveLength(1);
    expect(overlay.send.mock.calls).toHaveLength(0);
  });

  it("publishes a list once and routes variable changes to both client kinds", () => {
    const panel = socketFor(validPrincipal());
    const overlay = overlaySocketFor({
      v: 1,
      kind: "overlay",
      channelId: "kanal-a",
      tokenId: "token-1",
      expiresAt: null,
    });
    const object = objectFor([panel, overlay]);
    const variablesMessage: RealtimeEnvelope<"variables.changed"> = {
      version: 1,
      id: "nachricht-2",
      createdAt: "2026-09-24T12:00:01.000Z",
      channelId: "kanal-a",
      type: "variables.changed",
      payload: { set: [{ name: "score", value: 12 }], removed: [] },
    };

    object.publish([eventMessage, variablesMessage]);

    expect(panel.send.mock.calls.map(([message]) => typeOfSerializedMessage(message))).toEqual([
      "event_log.new",
      "variables.changed",
    ]);
    expect(overlay.send.mock.calls.map(([message]) => typeOfSerializedMessage(message))).toEqual([
      "variables.changed",
    ]);
  });

  it("routes overlay changes by the durable overlay tag after a fresh object instance", () => {
    const firstOverlay = overlaySocketFor({
      v: 1, kind: "overlay", channelId: "kanal-a", tokenId: "token-a", overlayId: "overlay-a", expiresAt: null,
    });
    const secondOverlay = overlaySocketFor({
      v: 1, kind: "overlay", channelId: "kanal-a", tokenId: "token-b", overlayId: "overlay-b", expiresAt: null,
    });
    const legacyOverlay = overlaySocketFor({
      v: 1, kind: "overlay", channelId: "kanal-a", tokenId: "token-legacy", overlayId: null, expiresAt: null,
    });
    const panel = socketFor(validPrincipal());
    // A new ChannelObject is constructed for each wake from hibernation. Only
    // socket tags and attachments are shared with the fresh instance.
    const previousInstance = objectFor([firstOverlay, secondOverlay, legacyOverlay, panel]);
    const internals = previousInstance as unknown as { ctx: DurableObjectState; env: Env };
    // Miniflare's DurableObject base constructor requires a branded state, so
    // model its newly allocated subclass instance while reusing hibernated
    // state exactly as the runtime does.
    const objectAfterWake = Object.create(ChannelObject.prototype) as ChannelObject;
    (objectAfterWake as unknown as { ctx: DurableObjectState }).ctx = internals.ctx;
    (objectAfterWake as unknown as { env: Env }).env = internals.env;
    const changed: RealtimeEnvelope<"overlay.changed"> = {
      version: 1,
      id: "overlay-change-1",
      createdAt: "2026-09-24T12:00:00.000Z",
      channelId: "kanal-a",
      type: "overlay.changed",
      payload: { overlayId: "overlay-a", revision: 2 },
    };

    objectAfterWake.publish([changed]);

    expect(firstOverlay.send.mock.calls.map(([message]) => typeOfSerializedMessage(message))).toEqual(["overlay.changed"]);
    expect(secondOverlay.send.mock.calls).toHaveLength(0);
    expect(legacyOverlay.send.mock.calls).toHaveLength(0);
    expect(panel.send.mock.calls.map(([message]) => typeOfSerializedMessage(message))).toEqual(["overlay.changed"]);
  });

  it("closes an expired overlay socket before considering its recipient type", () => {
    const overlay = overlaySocketFor({
      v: 1,
      kind: "overlay",
      channelId: "kanal-a",
      tokenId: "token-1",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    const object = objectFor([overlay]);

    object.publish([eventMessage]);

    expect(overlay.send.mock.calls).toHaveLength(0);
    expect(overlay.close.mock.calls).toEqual([[4001, "authorization expired"]]);
  });

  it("closes every open socket for a revoked overlay token", async () => {
    const affected = overlaySocketFor({
      v: 1,
      kind: "overlay",
      channelId: "kanal-a",
      tokenId: "token-1",
      expiresAt: null,
    });
    const other = overlaySocketFor({
      v: 1,
      kind: "overlay",
      channelId: "kanal-a",
      tokenId: "token-2",
      expiresAt: null,
    });
    const sockets = [affected, other];
    const object = objectFor(sockets);
    affected.close.mockImplementation(() => { sockets.splice(sockets.indexOf(affected), 1); });

    await object.revokeToken("token-1");

    expect(affected.close.mock.calls).toEqual([[4003, "Overlay token revoked"]]);
    expect(other.close.mock.calls).toHaveLength(0);
  });

  it("rejects a handshake that is still in flight when its token is revoked", async () => {
    const token = {
      v: 1 as const,
      kind: "overlay" as const,
      channelId: "kanal-a",
      tokenId: "token-in-flight",
      overlayId: null,
      expiresAt: null,
    };
    const object = objectFor([]);
    let releaseHandshake!: () => void;
    let signalHandshakeStarted!: () => void;
    const handshakeGate = new Promise<void>((resolve) => { releaseHandshake = resolve; });
    const handshakeStarted = new Promise<void>((resolve) => { signalHandshakeStarted = resolve; });
    vi.spyOn(object as unknown as { allowOverlayHandshake: (tokenId: string, now: number) => Promise<boolean> }, "allowOverlayHandshake")
      .mockImplementation(async () => {
        signalHandshakeStarted();
        await handshakeGate;
        return true;
      });
    const accept = (object as unknown as { ctx: { acceptWebSocket: ReturnType<typeof vi.fn> } }).ctx.acceptWebSocket;

    const handshake = object.fetch(upgradeRequest(token));
    await handshakeStarted;
    await object.revokeToken(token.tokenId);
    releaseHandshake();
    const response = await handshake;

    expect(response.status).toBe(403);
    expect(accept).not.toHaveBeenCalled();
    const marker = storageOf(object).values.get(`overlay_revoked:${token.tokenId}`);
    expect(typeof (marker as { revokedAt?: unknown }).revokedAt).toBe("number");
  });

  it("prunes old revoke markers on alarms and writes, then rejects revoked tokens through D1", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-09-24T12:00:00.000Z");
    vi.setSystemTime(now);
    const token = {
      v: 1 as const,
      kind: "overlay" as const,
      channelId: "kanal-a",
      tokenId: "token-old-revoked",
      overlayId: null,
      expiresAt: null,
    };
    const prepare = vi.fn(() => ({
        bind: vi.fn(() => ({
          first: vi.fn().mockResolvedValue(null),
          all: vi.fn().mockResolvedValue({ results: [] }),
        })),
      }));
    const database = { prepare } as unknown as D1Database;
    const object = objectFor([], database);
    const storage = storageOf(object);
    for (let index = 0; index < 1_001; index += 1) {
      storage.values.set(`overlay_revoked:old-${String(index).padStart(4, "0")}`, { revokedAt: now - 10 * 60_000 - 1 });
    }
    storage.values.set(`overlay_revoked:${token.tokenId}`, { revokedAt: now - 10 * 60_000 - 1 });

    await object.alarm();

    expect(storage.values.has(`overlay_revoked:${token.tokenId}`)).toBe(false);
    expect([...storage.values.keys()].some((key) => key.startsWith("overlay_revoked:"))).toBe(false);
    expect(storage.list).toHaveBeenNthCalledWith(2, {
      prefix: "overlay_revoked:", limit: 1_000, startAfter: "overlay_revoked:old-0999",
    });

    storage.values.set(`overlay_revoked:${token.tokenId}`, { revokedAt: now - 10 * 60_000 - 1 });
    await object.revokeToken("token-new-revoke");
    expect(storage.values.has(`overlay_revoked:${token.tokenId}`)).toBe(false);
    expect(storage.values.get("overlay_revoked:token-new-revoke")).toEqual({ revokedAt: now });

    const response = await object.fetch(upgradeRequest(token));

    expect(response.status).toBe(403);
    expect(storage.values.has(`overlay_revoked:${token.tokenId}`)).toBe(false);
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("FROM overlay_tokens"));
  });

  it("retries a failed overlay socket close from its durable revocation marker", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-09-24T12:00:00.000Z");
    vi.setSystemTime(now);
    const token = {
      v: 1 as const,
      kind: "overlay" as const,
      channelId: "kanal-a",
      tokenId: "token-retry",
      overlayId: null,
      expiresAt: null,
    };
    const socket = overlaySocketFor(token);
    const sockets = [socket];
    socket.close.mockImplementationOnce(() => { throw new Error("socket close failed"); })
      .mockImplementation(() => { sockets.splice(sockets.indexOf(socket), 1); });
    const object = objectFor(sockets);

    await expect(object.revokeToken(token.tokenId)).resolves.toBe(false);
    expect(storageOf(object).values.get(`overlay_revoked:${token.tokenId}`)).toEqual({ revokedAt: now });
    expect(storageOf(object).values.get("security_retry")).toBe(now + 60_000);

    vi.setSystemTime(now + 60_000);
    await object.alarm();

    expect(socket.close.mock.calls).toEqual([
      [4003, "Overlay token revoked"],
      [4003, "Authorization revoked"],
    ]);
    expect(sockets).toHaveLength(0);
  });

  it("preserves the earlier security deadline when a connection joins", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-09-21T12:00:00.000Z");
    vi.setSystemTime(now);
    const object = objectFor([socketFor(validPrincipal())]);
    const storage = storageOf(object);
    storage.values.set("security_round", now + 2_000);

    await (object as unknown as { scheduleSecurityAlarm: () => Promise<void> }).scheduleSecurityAlarm();

    expect(storage.values.get("security_round")).toBe(now + 2_000);
    expect(storage.setAlarm).toHaveBeenLastCalledWith(now + 2_000);
  });

  it("closes sockets in a failed authorization batch with the transient code and retries", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-09-21T12:00:00.000Z");
    vi.setSystemTime(now);
    const socket = overlaySocketFor({
      v: 1,
      kind: "overlay",
      channelId: "kanal-a",
      tokenId: "token-1",
      expiresAt: null,
    });
    const panel = socketFor(validPrincipal());
    const sockets = [socket, panel];
    let sessionChecks = 0;
    const database = {
      prepare: vi.fn((query: string) => ({
        bind: vi.fn(() => ({
          all: vi.fn(() => {
            if (!query.includes("auth_sessions")) return Promise.resolve({ results: [] });
            sessionChecks += 1;
            return sessionChecks === 1
              ? Promise.reject(new Error("D1 temporarily unavailable"))
              : Promise.resolve({ results: [{ session_id: "session-1", user_id: "user-1", role: "operator" }] });
          }),
        })),
      })),
    } as unknown as D1Database;
    const object = objectFor(sockets, database);
    const storage = storageOf(object);
    storage.values.set("security_round", now - 1);
    socket.close.mockImplementation(() => { sockets.splice(sockets.indexOf(socket), 1); });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await object.alarm();
      // The panel's session batch failed to query D1: its socket is closed
      // with the transient code so the client reconnects and is
      // re-authorized on handshake, instead of staying subscribed.
      expect(panel.close.mock.calls).toEqual([[4008, "authorization check unavailable"]]);
      expect(socket.close.mock.calls).toEqual([[4003, "Authorization revoked"]]);
      expect(storage.values.get("security_round")).toBe(now - 1);
      expect(storage.values.get("security_retry")).toBe(now + 60_000);
      expect(errorLog).toHaveBeenCalled();

      vi.setSystemTime(now + 60_000);
      await object.alarm();
      // The retry's session batch succeeds, so no further close.
      expect(panel.close.mock.calls).toHaveLength(1);
      expect(storage.values.get("security_round")).toBe(now + 16 * 60_000);
      expect(storage.values.has("security_retry")).toBe(false);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("closes only the sockets in a failed batch, leaving other batches untouched", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-09-21T12:00:00.000Z");
    vi.setSystemTime(now);
    const failingBatch = Array.from({ length: 98 }, (_, index) => socketFor(validPrincipal({
      userId: `user-${String(index)}`,
      sessionId: `session-${String(index)}`,
    })));
    const okSocket = socketFor(validPrincipal({ userId: "user-ok", sessionId: "session-ok" }));
    const sockets = [...failingBatch, okSocket];
    let sessionCallCount = 0;
    const database = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn(() => {
            sessionCallCount += 1;
            return sessionCallCount === 1
              ? Promise.reject(new Error("D1 unavailable"))
              : Promise.resolve({ results: [{ session_id: "session-ok", user_id: "user-ok", role: "operator" }] });
          }),
        })),
      })),
    } as unknown as D1Database;
    const object = objectFor(sockets, database);
    storageOf(object).values.set("security_round", now - 1);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await object.alarm();
      // Batch 1 (98 sessions, the D1 parameter chunk size) failed to query;
      // its sockets are closed with the transient code so their clients
      // reconnect and are re-authorized on handshake.
      for (const socket of failingBatch) {
        expect(socket.close.mock.calls).toEqual([[4008, "authorization check unavailable"]]);
      }
      // Batch 2's query succeeded and found the session still valid.
      expect(okSocket.close.mock.calls).toHaveLength(0);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("chunks session and token checks below D1's 100-parameter limit", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-09-21T12:00:00.000Z");
    vi.setSystemTime(now);
    const panels = Array.from({ length: 101 }, (_, index) => socketFor(validPrincipal({
      userId: `user-${String(index)}`,
      sessionId: `session-${String(index)}`,
    })));
    const overlays = Array.from({ length: 101 }, (_, index) => overlaySocketFor({
      v: 1,
      kind: "overlay",
      channelId: "kanal-a",
      tokenId: `token-${String(index)}`,
      expiresAt: null,
    }));
    const binds: unknown[][] = [];
    const database = {
      prepare: vi.fn((query: string) => {
        const statement = {
          bind: vi.fn((...values: unknown[]) => {
            binds.push(values);
            return {
              all: () => Promise.resolve({
                results: query.includes("auth_sessions")
                  ? values.slice(1, -1).map((sessionId) => ({
                    session_id: sessionId,
                    user_id: `user-${String(sessionId).slice("session-".length)}`,
                    role: "operator",
                  }))
                  : values.slice(1, -1).map((tokenId) => ({ token_id: tokenId })),
              }),
            };
          }),
        };
        return statement;
      }),
    } as unknown as D1Database;
    const object = objectFor([...panels, ...overlays], database);
    storageOf(object).values.set("security_round", now - 1);

    await object.alarm();

    expect(binds).toHaveLength(4);
    expect(Math.max(...binds.map((values) => values.length))).toBeLessThanOrEqual(100);
    expect([...panels, ...overlays].every((socket) => socket.close.mock.calls.length === 0)).toBe(true);
  });

  it("enforces socket capacity before accepting and reserves room for panels", async () => {
    const token = { v: 1 as const, kind: "overlay" as const, channelId: "kanal-a", tokenId: "token-1", overlayId: null, expiresAt: null };
    const sameTokenSockets = Array.from({ length: 10 }, () => overlaySocketFor(token));
    const object = objectFor(sameTokenSockets);
    const response = await object.fetch(upgradeRequest(token));
    const state = (object as unknown as { ctx: { acceptWebSocket: ReturnType<typeof vi.fn> } }).ctx;

    expect(response.status).toBe(503);
    expect(state.acceptWebSocket).not.toHaveBeenCalled();

    const overlays = Array.from({ length: 384 }, (_, index) => overlaySocketFor({ ...token, tokenId: `token-${String(index)}` }));
    const panelSockets = Array.from({ length: 127 }, (_, index) => socketFor(validPrincipal({
      userId: `panel-${String(index)}`,
      sessionId: `panel-session-${String(index)}`,
    })));
    const nearlyFull = objectFor([...overlays, ...panelSockets]);
    const hasCapacity = (target: ChannelObject, principal: RealtimePrincipal): boolean =>
      (target as unknown as { hasConnectionCapacity: (value: RealtimePrincipal) => boolean })
        .hasConnectionCapacity(principal);

    expect(hasCapacity(nearlyFull, validPrincipal())).toBe(true);
    expect(hasCapacity(nearlyFull, { ...token, tokenId: "new-token" })).toBe(false);

    const full = objectFor(Array.from({ length: 512 }, (_, index) => socketFor(validPrincipal({
      userId: `panel-${String(index)}`,
      sessionId: `full-session-${String(index)}`,
    }))));
    expect(hasCapacity(full, validPrincipal({ userId: "late-panel", sessionId: "late-session" }))).toBe(false);
  });

  it("caps panel sockets per user without locking out other panels or overlays", async () => {
    const sameUserSockets = Array.from({ length: 10 }, (_, index) => socketFor(validPrincipal({
      sessionId: `session-${String(index)}`,
    })));
    const object = objectFor(sameUserSockets);
    const state = (object as unknown as { ctx: { acceptWebSocket: ReturnType<typeof vi.fn> } }).ctx;

    const response = await object.fetch(upgradeRequest(validPrincipal({ sessionId: "session-11" })));

    expect(response.status).toBe(503);
    expect(state.acceptWebSocket).not.toHaveBeenCalled();

    const hasCapacity = (principal: RealtimePrincipal): boolean =>
      (object as unknown as { hasConnectionCapacity: (value: RealtimePrincipal) => boolean })
        .hasConnectionCapacity(principal);
    expect(hasCapacity(validPrincipal({ userId: "user-2", sessionId: "user-2-session" }))).toBe(true);
    expect(hasCapacity({ v: 1, kind: "overlay", channelId: "kanal-a", tokenId: "token-1", overlayId: null, expiresAt: null })).toBe(true);
  });

  it("rate-limits repeated overlay handshakes per token", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-09-21T12:00:00.000Z");
    vi.setSystemTime(now);
    const object = objectFor([]);
    const allow = (object as unknown as {
      allowOverlayHandshake: (tokenId: string, at: number) => Promise<boolean>;
    }).allowOverlayHandshake;

    const attempts = await Promise.all(Array.from({ length: 30 }, () => allow.call(object, "token-1", now)));
    expect(attempts.every(Boolean)).toBe(true);
    await expect(allow.call(object, "token-1", now)).resolves.toBe(false);
    await expect(allow.call(object, "token-2", now)).resolves.toBe(true);
    await expect(allow.call(object, "token-1", now + 60_000)).resolves.toBe(true);
  });

  it("closes sockets that send application data", () => {
    const socket = overlaySocketFor({
      v: 1,
      kind: "overlay",
      channelId: "kanal-a",
      tokenId: "token-1",
      expiresAt: null,
    });
    const object = objectFor([socket]);

    object.webSocketMessage(socket, JSON.stringify({ type: "client.message" }));

    expect(socket.close.mock.calls).toEqual([[1008, "Realtime channel is one-way"]]);
  });

  it("revokes only the connection of the affected user", async () => {
    const affected = socketFor(validPrincipal());
    const other = socketFor(validPrincipal({ userId: "user-2", sessionId: "session-2" }));
    const object = objectFor([affected, other]);

    await object.revokeUser("user-1");

    expect(affected.close.mock.calls).toEqual([[4003, "Channel access revoked"]]);
    expect(other.close.mock.calls).toHaveLength(0);
  });

  it("keeps two deadlines separate, processes the earlier one and keeps the later one", async () => {
    vi.useFakeTimers();
    const jetzt = Date.parse("2026-09-21T12:00:00.000Z");
    vi.setSystemTime(jetzt);
    const object = objectFor([]);
    const storage = storageOf(object);

    storage.values.set("security_round", jetzt + 2_000);
    await object.scheduleAdPrewarning(jetzt + 4_000);
    expect(storage.setAlarm).toHaveBeenLastCalledWith(jetzt + 2_000);

    vi.setSystemTime(jetzt + 2_000);
    await object.alarm();
    expect(mocks.processAdPrewarning).not.toHaveBeenCalled();
    expect(storage.values.size).toBe(1);
    expect([...storage.values.values()]).toEqual([jetzt + 4_000]);
    expect(storage.setAlarm).toHaveBeenLastCalledWith(jetzt + 4_000);

    vi.setSystemTime(jetzt + 4_000);
    await object.alarm();
    expect(mocks.processAdPrewarning).toHaveBeenCalledTimes(1);
    expect(storage.values.size).toBe(0);
    expect(storage.deleteAlarm).toHaveBeenCalled();
  });

  it("runs the security round even with an open pre-warning deadline", async () => {
    vi.useFakeTimers();
    const jetzt = Date.parse("2026-09-21T12:00:00.000Z");
    vi.setSystemTime(jetzt);
    const socket = socketFor(validPrincipal());
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
    await object.scheduleAdPrewarning(jetzt + 60_000);

    await object.alarm();

    expect(prepare).toHaveBeenCalled();
    const close = Reflect.get(socket, "close") as ReturnType<typeof vi.fn>;
    expect(close).toHaveBeenCalledWith(4003, "Authorization revoked");
    expect([...storage.values.values()]).toEqual([jetzt + 60_000]);
  });
});
