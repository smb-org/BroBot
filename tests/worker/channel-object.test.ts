import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processAdPrewarning: vi.fn().mockResolvedValue(undefined),
  refreshAdPrewarningAlarm: vi.fn().mockResolvedValue(undefined),
  getAdSchedule: vi.fn(),
}));

vi.mock("../../src/worker/ad-prewarning", () => mocks);
vi.mock("../../src/modules/ads/adapters/prewarning-alarm", () => ({ refreshAdPrewarningAlarm: mocks.refreshAdPrewarningAlarm }));
vi.mock("../../src/modules/ads/adapters/ad-schedule", () => ({ getAdSchedule: mocks.getAdSchedule }));

import type {
  RealtimeEnvelope,
  RealtimeOverlayPrincipal,
  RealtimePanelPrincipal,
  RealtimePrincipal,
} from "../../src/realtime-contract";
import { OVERLAY_ACCESS_BOUND_CLOSE_CODE, OVERLAY_ACCESS_BOUND_CLOSE_REASON } from "../../src/realtime-contract";
import type { AdsSchedule } from "../../src/modules/ads/contracts";
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
  serializeAttachment: ReturnType<typeof vi.fn>;
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
  serializeAttachment: vi.fn(),
} as unknown as SocketDouble);

const overlaySocketFor = (
  input: Omit<RealtimeOverlayPrincipal, "overlayId"> & { overlayId?: string | null },
): SocketDouble => {
  const principal: RealtimeOverlayPrincipal = { ...input, overlayId: input.overlayId ?? null };
  let attachment: unknown = { ...principal };
  return {
    tags: ["kind:overlay", `token:${principal.tokenId}`,
      ...(principal.overlayId === null ? [] : [`overlay:${principal.overlayId}`])],
    send: vi.fn(),
    close: vi.fn(),
    deserializeAttachment: vi.fn(() => attachment),
    serializeAttachment: vi.fn((next: unknown) => { attachment = next; }),
  } as unknown as SocketDouble;
};

type StorageDouble = {
  values: Map<string, unknown>;
  get: ReturnType<typeof vi.fn<(key: string) => Promise<unknown>>>;
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
    get: vi.fn((key: string) => Promise.resolve(values.get(key))),
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
    first: vi.fn().mockResolvedValue({ token_id: "token-1", overlay_id: null }),
  };
  const getWebSockets = vi.fn((tag?: string) => tag === undefined
    ? sockets
    : sockets.filter((socket) => socket.tags.includes(tag)));
  const state = {
    id: { name: "kanal-a" },
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets,
    acceptWebSocket: vi.fn((socket: WebSocket) => {
      sockets.push(socket as SocketDouble);
      const endpoint = socket as WebSocket & { accept: () => void };
      endpoint.accept();
    }),
    storage: {
      ...storage,
      get: storage.get,
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
  (object as unknown as { adScheduleRefresh: Promise<unknown> | null }).adScheduleRefresh = null;
  (object as unknown as { adScheduleRefreshStartedAt: number }).adScheduleRefreshStartedAt = 0;
  (object as unknown as { adScheduleRefreshGeneration: number }).adScheduleRefreshGeneration = 0;
  (object as unknown as { adScheduleOperationQueue: Promise<void> }).adScheduleOperationQueue = Promise.resolve();
  (object as unknown as { recentlyBoundOverlayTokenIds: Set<string> }).recentlyBoundOverlayTokenIds = new Set();
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
    vi.unstubAllGlobals();
    mocks.processAdPrewarning.mockReset().mockResolvedValue(undefined);
    mocks.refreshAdPrewarningAlarm.mockReset().mockResolvedValue(undefined);
    mocks.getAdSchedule.mockReset();
  });

  const adSchedule = (nextAdAt: string | null): AdsSchedule => ({
    nextAdAt,
    duration: 60,
    lastAdAt: null,
    prerollFreeTime: 120,
    snoozeCount: 1,
    snoozeRefreshAt: null,
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

  it("rejects a publish for a foreign channel", async () => {
    const object = objectFor([]);

    await expect(Promise.resolve().then(() => object.publish([{ ...eventMessage, channelId: "kanal-b" }])))
      .rejects.toThrow(/foreign channel/);
  });

  it("sends nothing more to an expired connection", async () => {
    const expired = socketFor(validPrincipal({ expiresAt: "2000-01-01T00:00:00.000Z" }));
    const valid = socketFor(validPrincipal({ userId: "user-2", sessionId: "session-2" }));
    const object = objectFor([expired, valid]);

    await object.publish([eventMessage]);

    expect(expired.send.mock.calls).toHaveLength(0);
    expect(expired.close.mock.calls).toEqual([[4001, "authorization expired"]]);
    expect(valid.send.mock.calls).toHaveLength(1);
  });

  it("keeps panel-only event-log hints away from overlay sockets", async () => {
    const panel = socketFor(validPrincipal());
    const overlay = overlaySocketFor({
      v: 1,
      kind: "overlay",
      channelId: "kanal-a",
      tokenId: "token-1",
      expiresAt: null,
    });
    const object = objectFor([panel, overlay]);

    await object.publish([eventMessage]);

    expect(panel.send.mock.calls).toHaveLength(1);
    expect(overlay.send.mock.calls).toHaveLength(0);
  });

  it("accepts a bound overlay without reading its variable references", async () => {
    const token: RealtimeOverlayPrincipal = {
      v: 1,
      kind: "overlay",
      channelId: "kanal-a",
      tokenId: "token-a",
      overlayId: "overlay-a",
      expiresAt: null,
    };
    const prepare = vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn().mockResolvedValue({ token_id: token.tokenId, overlay_id: token.overlayId }),
      })),
    }));
    const object = objectFor([], { prepare } as unknown as D1Database);

    const response = await object.fetch(upgradeRequest(token));
    const state = (object as unknown as { ctx: { getWebSockets: () => WebSocket[] } }).ctx;
    const accepted = state.getWebSockets()[0];

    expect(response.status).toBe(101);
    expect(accepted?.deserializeAttachment()).toEqual(token);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(prepare).toHaveBeenCalledWith(expect.stringContaining("FROM overlay_tokens"));
  });

  it("closes a stale legacy handshake when its token is already bound", async () => {
    const token: RealtimeOverlayPrincipal = {
      v: 1,
      kind: "overlay",
      channelId: "kanal-a",
      tokenId: "token-bound-during-handshake",
      overlayId: null,
      expiresAt: null,
    };
    const prepare = vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn().mockResolvedValue({ token_id: token.tokenId, overlay_id: "overlay-current" }),
      })),
    }));
    const object = objectFor([], { prepare } as unknown as D1Database);
    const pair = new WebSocketPair();
    const close = vi.spyOn(pair[1], "close");
    const send = vi.spyOn(pair[1], "send");
    vi.stubGlobal("WebSocketPair", function WebSocketPairDouble() { return pair; });

    const response = await object.fetch(upgradeRequest(token));

    expect(response.status).toBe(101);
    expect(close).toHaveBeenCalledWith(OVERLAY_ACCESS_BOUND_CLOSE_CODE, OVERLAY_ACCESS_BOUND_CLOSE_REASON);
    expect(send).not.toHaveBeenCalled();
  });

  it("rechecks revocation immediately before accept when token validation awaits", async () => {
    const token: RealtimeOverlayPrincipal = {
      v: 1,
      kind: "overlay",
      channelId: "kanal-a",
      tokenId: "token-during-lookup",
      overlayId: "overlay-a",
      expiresAt: null,
    };
    let releaseLookup!: () => void;
    let signalLookupStarted!: () => void;
    const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });
    const lookupStarted = new Promise<void>((resolve) => { signalLookupStarted = resolve; });
    const prepare = vi.fn((query: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => {
          if (query.includes("overlay_tokens")) {
            signalLookupStarted();
            await lookupGate;
            return { token_id: token.tokenId };
          }
          return null;
        }),
      })),
    }));
    const object = objectFor([], { prepare } as unknown as D1Database);
    const accept = (object as unknown as { ctx: { acceptWebSocket: ReturnType<typeof vi.fn> } }).ctx.acceptWebSocket;

    const handshake = object.fetch(upgradeRequest(token));
    await lookupStarted;
    await object.revokeToken(token.tokenId);
    releaseLookup();
    const response = await handshake;

    expect(response.status).toBe(403);
    expect(accept).not.toHaveBeenCalled();
    expect(prepare).toHaveBeenCalledTimes(1);
  });

  it("keeps stream-state refreshes away from overlay sockets", async () => {
    const panel = socketFor(validPrincipal());
    const overlay = overlaySocketFor({ v: 1, kind: "overlay", channelId: "kanal-a", tokenId: "token-1", expiresAt: null });
    const object = objectFor([panel, overlay]);
    const message: RealtimeEnvelope<"stream.state.changed"> = {
      version: 1,
      id: "stream-state-1",
      createdAt: "2026-09-24T12:00:00.000Z",
      channelId: "kanal-a",
      type: "stream.state.changed",
      payload: { state: "online", startedAt: "2026-09-24T11:00:00.000Z", changedAt: "2026-09-24T12:00:00.000Z" },
    };

    await object.publish([message]);

    expect(panel.send.mock.calls).toHaveLength(1);
    expect(overlay.send.mock.calls).toHaveLength(0);
    expect(typeOfSerializedMessage(panel.send.mock.calls[0]?.[0] ?? "")).toBe("stream.state.changed");
  });

  it("publishes a list once and routes variable changes to both client kinds", async () => {
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

    await object.publish([eventMessage, variablesMessage]);

    const getWebSockets = (object as unknown as { ctx: { getWebSockets: ReturnType<typeof vi.fn> } }).ctx.getWebSockets;
    expect(getWebSockets).toHaveBeenCalledTimes(1);
    expect(getWebSockets).toHaveBeenCalledWith();

    expect(panel.send.mock.calls.map(([message]) => typeOfSerializedMessage(message))).toEqual([
      "event_log.new",
      "variables.changed",
    ]);
    expect(overlay.send.mock.calls.map(([message]) => typeOfSerializedMessage(message))).toEqual([
      "variables.changed",
    ]);
  });

  it("filters each variable change to the variables referenced by that overlay", async () => {
    const panel = socketFor(validPrincipal());
    const overlayA = overlaySocketFor({
      v: 1, kind: "overlay", channelId: "kanal-a", tokenId: "token-a", overlayId: "overlay-a",
      expiresAt: null,
    });
    const overlayB = overlaySocketFor({
      v: 1, kind: "overlay", channelId: "kanal-a", tokenId: "token-b", overlayId: "overlay-b",
      expiresAt: null,
    });
    const overlayWithoutChanges = overlaySocketFor({
      v: 1, kind: "overlay", channelId: "kanal-a", tokenId: "token-c", overlayId: "overlay-c",
      expiresAt: null,
    });
    const legacy = overlaySocketFor({
      v: 1, kind: "overlay", channelId: "kanal-a", tokenId: "token-legacy", overlayId: null,
      expiresAt: null,
    });
    const object = objectFor([panel, overlayA, overlayB, overlayWithoutChanges, legacy]);
    const variablesMessage: RealtimeEnvelope<"variables.changed"> = {
      version: 1,
      id: "variables-filtered-1",
      createdAt: "2026-09-24T12:00:01.000Z",
      channelId: "kanal-a",
      type: "variables.changed",
      payload: {
        set: [{ name: "score", value: 12 }, { name: "wins", value: 8 }],
        removed: ["streak", "rank"],
        overlayIdsByVariable: {
          score: ["overlay-a"],
          wins: ["overlay-b"],
          streak: ["overlay-a"],
          rank: ["overlay-unconnected"],
        },
      },
    };

    await object.publish([variablesMessage]);

    expect(JSON.parse(overlayA.send.mock.calls[0]?.[0] ?? "null")).toMatchObject({
      payload: { set: [{ name: "score", value: 12 }], removed: ["streak"] },
    });
    expect(JSON.parse(overlayB.send.mock.calls[0]?.[0] ?? "null")).toMatchObject({
      payload: { set: [{ name: "wins", value: 8 }], removed: [] },
    });
    expect(overlayWithoutChanges.send.mock.calls).toHaveLength(0);
    expect(JSON.parse(legacy.send.mock.calls[0]?.[0] ?? "null")).toMatchObject({
      payload: {
        set: [{ name: "score", value: 12 }, { name: "wins", value: 8 }],
        removed: ["streak", "rank"],
      },
    });
    expect(JSON.parse(panel.send.mock.calls[0]?.[0] ?? "null")).toEqual({
      ...variablesMessage,
      payload: { set: variablesMessage.payload.set, removed: variablesMessage.payload.removed },
    });
  });

  it("filters using write-time recipients when an overlay hint failed before reaching the DO", async () => {
    const overlay = overlaySocketFor({
      v: 1, kind: "overlay", channelId: "kanal-a", tokenId: "token-a", overlayId: "overlay-a", expiresAt: null,
    });
    const object = objectFor([overlay]);
    const variableChange: RealtimeEnvelope<"variables.changed"> = {
      version: 1,
      id: "variables-after-unpublished-overlay-edit",
      createdAt: "2026-09-24T12:00:01.000Z",
      channelId: "kanal-a",
      type: "variables.changed",
      payload: {
        set: [{ name: "score", value: 12 }],
        removed: [],
        overlayIdsByVariable: { score: ["overlay-b"] },
      },
    };

    await object.publish([variableChange]);

    expect(overlay.send.mock.calls).toHaveLength(0);
    expect(overlay.deserializeAttachment()).toEqual(expect.objectContaining({ overlayId: "overlay-a" }));
  });

  it("uses the socket's immutable overlay id after hibernation and leaves legacy delivery unfiltered", async () => {
    const bound = overlaySocketFor({
      v: 1, kind: "overlay", channelId: "kanal-a", tokenId: "token-bound", overlayId: "overlay-a", expiresAt: null,
    });
    const other = overlaySocketFor({
      v: 1, kind: "overlay", channelId: "kanal-a", tokenId: "token-other", overlayId: "overlay-b", expiresAt: null,
    });
    const legacy = overlaySocketFor({
      v: 1, kind: "overlay", channelId: "kanal-a", tokenId: "token-legacy", expiresAt: null,
    });
    const previousInstance = objectFor([bound, other, legacy]);
    const internals = previousInstance as unknown as { ctx: DurableObjectState; env: Env };
    const afterWake = Object.create(ChannelObject.prototype) as ChannelObject;
    (afterWake as unknown as { ctx: DurableObjectState }).ctx = internals.ctx;
    (afterWake as unknown as { env: Env }).env = internals.env;
    (afterWake as unknown as { recentlyBoundOverlayTokenIds: Set<string> }).recentlyBoundOverlayTokenIds = new Set();
    const variableChange: RealtimeEnvelope<"variables.changed"> = {
      version: 1,
      id: "variables-after-wake",
      createdAt: "2026-09-24T12:00:01.000Z",
      channelId: "kanal-a",
      type: "variables.changed",
      payload: {
        set: [{ name: "score", value: 12 }, { name: "wins", value: 8 }],
        removed: ["streak"],
        overlayIdsByVariable: {
          score: ["overlay-a"],
          wins: ["overlay-b"],
          streak: ["overlay-a"],
        },
      },
    };

    await afterWake.publish([variableChange]);

    expect(JSON.parse(bound.send.mock.calls[0]?.[0] ?? "null")).toMatchObject({
      payload: { set: [{ name: "score", value: 12 }], removed: ["streak"] },
    });
    expect(JSON.parse(other.send.mock.calls[0]?.[0] ?? "null")).toMatchObject({
      payload: { set: [{ name: "wins", value: 8 }], removed: [] },
    });
    expect(JSON.parse(legacy.send.mock.calls[0]?.[0] ?? "null")).toMatchObject({
      payload: { set: [{ name: "score", value: 12 }, { name: "wins", value: 8 }], removed: ["streak"] },
    });
    expect(bound.serializeAttachment.mock.calls).toEqual([]);
  });

  it("closes an already-connected legacy source when its token becomes bound", async () => {
    const legacy = overlaySocketFor({
      v: 1, kind: "overlay", channelId: "kanal-a", tokenId: "token-legacy", overlayId: null, expiresAt: null,
    });
    const sockets = [legacy];
    legacy.close.mockImplementation(() => { sockets.splice(sockets.indexOf(legacy), 1); });
    const object = objectFor(sockets);

    const closed = await object.closeUnboundOverlayTokenSockets("token-legacy");
    const variablesMessage: RealtimeEnvelope<"variables.changed"> = {
      version: 1,
      id: "variables-after-binding",
      createdAt: "2026-09-24T12:00:01.000Z",
      channelId: "kanal-a",
      type: "variables.changed",
      payload: {
        set: [{ name: "score", value: 12 }, { name: "wins", value: 8 }],
        removed: ["streak"],
        overlayIdsByVariable: { score: ["overlay-a"], wins: ["overlay-b"], streak: ["overlay-a"] },
      },
    };
    await object.publish([variablesMessage]);

    expect(closed).toBe(true);
    expect(legacy.close.mock.calls).toEqual([[OVERLAY_ACCESS_BOUND_CLOSE_CODE, OVERLAY_ACCESS_BOUND_CLOSE_REASON]]);
    expect(legacy.send.mock.calls).toHaveLength(0);
  });

  it("rejects a legacy handshake that reaches accept after the binding close scan", async () => {
    const token: RealtimeOverlayPrincipal = {
      v: 1,
      kind: "overlay",
      channelId: "kanal-a",
      tokenId: "token-bound-during-handshake",
      overlayId: null,
      expiresAt: null,
    };
    const prepare = vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn().mockResolvedValue({ token_id: token.tokenId, overlay_id: null }),
      })),
    }));
    const object = objectFor([], { prepare } as unknown as D1Database);
    const storage = storageOf(object);
    const pair = new WebSocketPair();
    const close = vi.spyOn(pair[1], "close");
    vi.stubGlobal("WebSocketPair", function WebSocketPairDouble() { return pair; });
    let releaseMarker!: () => void;
    let signalMarkerRead!: () => void;
    const markerGate = new Promise<void>((resolve) => { releaseMarker = resolve; });
    const markerRead = new Promise<void>((resolve) => { signalMarkerRead = resolve; });
    storage.get.mockImplementation(async (key: string) => {
      if (key === `overlay_revoked:${token.tokenId}`) {
        signalMarkerRead();
        await markerGate;
      }
      return storage.values.get(key);
    });
    const accept = (object as unknown as { ctx: { acceptWebSocket: ReturnType<typeof vi.fn> } }).ctx.acceptWebSocket;

    const handshake = object.fetch(upgradeRequest(token));
    await markerRead;
    await object.closeUnboundOverlayTokenSockets(token.tokenId);
    releaseMarker();
    const response = await handshake;

    expect(response.status).toBe(403);
    expect(accept).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(OVERLAY_ACCESS_BOUND_CLOSE_CODE, OVERLAY_ACCESS_BOUND_CLOSE_REASON);
  });

  it("does not deliver variables after a binding close fails and retries the close", async () => {
    const legacy = overlaySocketFor({
      v: 1, kind: "overlay", channelId: "kanal-a", tokenId: "token-legacy", overlayId: null, expiresAt: null,
    });
    const sockets = [legacy];
    legacy.close.mockImplementationOnce(() => { throw new Error("socket close failed"); })
      .mockImplementation(() => { sockets.splice(sockets.indexOf(legacy), 1); });
    const object = objectFor(sockets);
    const variablesMessage: RealtimeEnvelope<"variables.changed"> = {
      version: 1,
      id: "variables-after-failed-binding-close",
      createdAt: "2026-09-24T12:00:01.000Z",
      channelId: "kanal-a",
      type: "variables.changed",
      payload: { set: [{ name: "score", value: 12 }], removed: [] },
    };

    await expect(object.closeUnboundOverlayTokenSockets("token-legacy")).resolves.toBe(false);
    await object.publish([variablesMessage]);

    expect(legacy.close.mock.calls).toEqual([
      [OVERLAY_ACCESS_BOUND_CLOSE_CODE, OVERLAY_ACCESS_BOUND_CLOSE_REASON],
      [OVERLAY_ACCESS_BOUND_CLOSE_CODE, OVERLAY_ACCESS_BOUND_CLOSE_REASON],
    ]);
    expect(legacy.send.mock.calls).toHaveLength(0);
    expect(sockets).toHaveLength(0);
  });

  it("checks the changed binding periodically after an import close fails", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-09-24T12:00:00.000Z");
    vi.setSystemTime(now);
    const legacy = overlaySocketFor({
      v: 1, kind: "overlay", channelId: "kanal-a", tokenId: "token-legacy", overlayId: null, expiresAt: null,
    });
    const sockets = [legacy];
    legacy.close.mockImplementationOnce(() => { throw new Error("socket close failed"); })
      .mockImplementation(() => { sockets.splice(sockets.indexOf(legacy), 1); });
    const database = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          all: vi.fn().mockResolvedValue({
            results: [{ token_id: "token-legacy", overlay_id: "overlay-current" }],
          }),
        })),
      })),
    } as unknown as D1Database;
    const object = objectFor(sockets, database);
    const storage = storageOf(object);
    await (object as unknown as { scheduleSecurityAlarm: () => Promise<void> }).scheduleSecurityAlarm();
    const securityDeadline = storage.values.get("security_round");
    expect(typeof securityDeadline).toBe("number");

    await expect(object.closeUnboundOverlayTokenSockets("token-legacy")).resolves.toBe(false);
    expect(storage.values.get("security_round")).toBe(securityDeadline);

    vi.setSystemTime(securityDeadline as number);
    await object.alarm();

    expect(legacy.close.mock.calls).toEqual([
      [OVERLAY_ACCESS_BOUND_CLOSE_CODE, OVERLAY_ACCESS_BOUND_CLOSE_REASON],
      [OVERLAY_ACCESS_BOUND_CLOSE_CODE, OVERLAY_ACCESS_BOUND_CLOSE_REASON],
    ]);
    expect(sockets).toHaveLength(0);
  });

  it("does not read D1 while filtering write-routed variable changes", async () => {
    const overlay = overlaySocketFor({
      v: 1, kind: "overlay", channelId: "kanal-a", tokenId: "token-a", overlayId: "overlay-a", expiresAt: null,
    });
    const prepare = vi.fn();
    const object = objectFor([overlay], { prepare } as unknown as D1Database);
    const variablesMessage: RealtimeEnvelope<"variables.changed"> = {
      version: 1,
      id: "variables-chat-path",
      createdAt: "2026-09-24T12:00:01.000Z",
      channelId: "kanal-a",
      type: "variables.changed",
      payload: {
        set: [{ name: "score", value: 12 }],
        removed: [],
        overlayIdsByVariable: { score: ["overlay-a"] },
      },
    };

    await object.publish([variablesMessage]);

    expect(prepare).not.toHaveBeenCalled();
    expect(overlay.send.mock.calls).toHaveLength(1);
    const delivered: unknown = JSON.parse(overlay.send.mock.calls[0]?.[0] ?? "null");
    expect(delivered).not.toHaveProperty("payload.overlayIdsByVariable");
  });

  it("routes overlay changes by the durable overlay tag after a fresh object instance", async () => {
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
    (objectAfterWake as unknown as { recentlyBoundOverlayTokenIds: Set<string> }).recentlyBoundOverlayTokenIds = new Set();
    const changed: RealtimeEnvelope<"overlay.changed"> = {
      version: 1,
      id: "overlay-change-1",
      createdAt: "2026-09-24T12:00:00.000Z",
      channelId: "kanal-a",
      type: "overlay.changed",
      payload: { overlayId: "overlay-a", revision: 2 },
    };

    await objectAfterWake.publish([changed]);

    expect(firstOverlay.send.mock.calls.map(([message]) => typeOfSerializedMessage(message))).toEqual(["overlay.changed"]);
    expect(secondOverlay.send.mock.calls).toHaveLength(0);
    expect(legacyOverlay.send.mock.calls).toHaveLength(0);
    expect(panel.send.mock.calls.map(([message]) => typeOfSerializedMessage(message))).toEqual(["overlay.changed"]);
  });

  it("coalesces ad-schedule refreshes and pushes panel-only updates while reconciling alarms", async () => {
    const panel = socketFor(validPrincipal());
    const overlay = overlaySocketFor({ v: 1, kind: "overlay", channelId: "kanal-a", tokenId: "token-1", expiresAt: null });
    const object = objectFor([panel, overlay]);
    const schedule = adSchedule("2026-09-24T19:00:00.000Z");
    let resolveFetch: ((result: { fetched: boolean; reason: string | null; detail: Record<string, string | number | boolean | null>; schedule: AdsSchedule }) => void) | undefined;
    mocks.getAdSchedule.mockImplementationOnce(() => new Promise((resolve) => { resolveFetch = resolve; }));

    const firstRefresh = object.refreshAdSchedule();
    const coalescedRefresh = object.refreshAdSchedule();
    await vi.waitFor(() => { expect(mocks.getAdSchedule).toHaveBeenCalledTimes(1); });
    resolveFetch?.({ fetched: true, reason: null, detail: {}, schedule });
    const [first, coalesced] = await Promise.all([firstRefresh, coalescedRefresh]);
    expect(first).toEqual(coalesced);
    expect(first.changed).toBe(true);
    expect(mocks.refreshAdPrewarningAlarm).toHaveBeenCalledTimes(1);
    expect(panel.send.mock.calls).toHaveLength(1);
    expect(typeOfSerializedMessage(panel.send.mock.calls[0]?.[0] ?? "")).toBe("ads.schedule.updated");
    expect(overlay.send.mock.calls).toHaveLength(0);

    mocks.getAdSchedule.mockResolvedValueOnce({ fetched: true, reason: null, detail: {}, schedule });
    const second = await object.refreshAdSchedule();
    expect(second.changed).toBe(false);
    expect(mocks.refreshAdPrewarningAlarm).toHaveBeenCalledTimes(2);
    expect(panel.send.mock.calls).toHaveLength(2);
    const updated = JSON.parse(panel.send.mock.calls[1]?.[0] ?? "{}") as { payload?: { asOf?: string } };
    expect(updated.payload?.asOf).toBe(second.cache?.asOf);
    expect(overlay.send.mock.calls).toHaveLength(0);
  });

  it("does not let an in-flight schedule fetch overwrite a newer snooze", async () => {
    const object = objectFor([]);
    const original = adSchedule("2026-09-24T19:00:00.000Z");
    const snoozed = adSchedule("2026-09-24T19:15:00.000Z");
    await object.storeAdSchedule(original, "2026-09-24T12:00:00.000Z");
    let resolveFetch: ((result: { fetched: boolean; reason: string | null; detail: Record<string, string | number | boolean | null>; schedule: AdsSchedule }) => void) | undefined;
    mocks.getAdSchedule.mockImplementationOnce(() => new Promise((resolve) => {
      resolveFetch = resolve;
    }));

    const refresh = object.refreshAdSchedule();
    await vi.waitFor(() => { expect(mocks.getAdSchedule).toHaveBeenCalledTimes(1); });
    await object.storeAdSchedule(snoozed, "2026-09-24T12:01:00.000Z");
    resolveFetch?.({ fetched: true, reason: null, detail: {}, schedule: original });

    const result = await refresh;
    expect(result.changed).toBe(false);
    await expect(object.getCachedAdSchedule()).resolves.toEqual({ schedule: snoozed, asOf: "2026-09-24T12:01:00.000Z" });
  });

  it("rejects an EventSub schedule save based on an older cache generation", async () => {
    const object = objectFor([]);
    const initial = adSchedule("2026-09-24T19:00:00.000Z");
    const latest = adSchedule("2026-09-24T19:30:00.000Z");
    const staleFetch = adSchedule("2026-09-24T18:45:00.000Z");
    await object.storeAdSchedule(initial, "2026-09-24T12:00:00.000Z");
    const fetchGeneration = await object.getAdScheduleGeneration();
    await object.storeAdSchedule(latest, "2026-09-24T12:01:00.000Z");

    await expect(object.storeAdSchedule(
      staleFetch,
      "2026-09-24T12:02:00.000Z",
      undefined,
      fetchGeneration,
    )).resolves.toBeNull();
    await expect(object.getCachedAdSchedule()).resolves.toEqual({ schedule: latest, asOf: "2026-09-24T12:01:00.000Z" });
  });

  it("serializes cached alarm reconciliation with a newer schedule save", async () => {
    const object = objectFor([]);
    const older = adSchedule("2026-09-24T19:00:00.000Z");
    const newer = adSchedule("2026-09-24T19:30:00.000Z");
    await object.storeAdSchedule(older, "2026-09-24T12:00:00.000Z");
    mocks.refreshAdPrewarningAlarm.mockClear();
    let finishOlderReconcile!: () => void;
    const olderReconcileBlocked = new Promise<void>((resolve) => { finishOlderReconcile = resolve; });
    const alarmScheduleWrites: Array<string | null> = [];
    mocks.refreshAdPrewarningAlarm.mockImplementation(async (_env: unknown, _channelId: string, schedule: AdsSchedule) => {
      if (schedule.nextAdAt === older.nextAdAt) await olderReconcileBlocked;
      alarmScheduleWrites.push(schedule.nextAdAt);
    });

    const olderReconcile = object.reconcileCachedAdPrewarning();
    await vi.waitFor(() => { expect(mocks.refreshAdPrewarningAlarm).toHaveBeenCalledTimes(1); });
    const newerSave = object.storeAdSchedule(newer, "2026-09-24T12:01:00.000Z");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(mocks.refreshAdPrewarningAlarm).toHaveBeenCalledTimes(1);

    finishOlderReconcile();
    await Promise.all([olderReconcile, newerSave]);

    expect(alarmScheduleWrites).toEqual([older.nextAdAt, newer.nextAdAt]);
    await expect(object.getCachedAdSchedule()).resolves.toEqual({ schedule: newer, asOf: "2026-09-24T12:01:00.000Z" });
  });

  it("retries failed alarm reconciliation independently of schedule changes and notices scope changes", async () => {
    const object = objectFor([]);
    const schedule = adSchedule("2026-09-24T19:00:00.000Z");
    mocks.refreshAdPrewarningAlarm.mockRejectedValueOnce(new Error("D1 unavailable"));

    await expect(object.storeAdSchedule(schedule, "2026-09-24T12:00:00.000Z", ["channel:manage:ads"])).resolves.toEqual({
      schedule,
      asOf: "2026-09-24T12:00:00.000Z",
    });
    await object.reconcileCachedAdPrewarning(["channel:manage:ads"]);
    await object.reconcileCachedAdPrewarning([]);

    expect(mocks.refreshAdPrewarningAlarm).toHaveBeenCalledTimes(3);
    expect(storageOf(object).values.has("ads:prewarning_reconciled")).toBe(true);
  });

  it("expires a stuck refresh coalescer so a later caller can start another fetch", async () => {
    vi.useFakeTimers();
    const object = objectFor([]);
    mocks.getAdSchedule.mockImplementation(() => new Promise(() => undefined));

    const first = object.refreshAdSchedule();
    await vi.waitFor(() => { expect(mocks.getAdSchedule).toHaveBeenCalledTimes(1); });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(first).resolves.toMatchObject({ reason: "timeout" });

    const second = object.refreshAdSchedule();
    await vi.waitFor(() => { expect(mocks.getAdSchedule).toHaveBeenCalledTimes(2); });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(second).resolves.toMatchObject({ reason: "timeout" });
  });

  it("leases stream-state refreshes durably for one channel at a time", async () => {
    const object = objectFor([]);
    const first = await object.beginStreamStateRefresh(100);
    expect(first).toEqual(expect.any(String));
    await expect(object.beginStreamStateRefresh(101)).resolves.toBeNull();
    await object.endStreamStateRefresh(first ?? "");
    const next = await object.beginStreamStateRefresh(102);
    expect(next).toEqual(expect.any(String));
    await object.endStreamStateRefresh(next ?? "");
  });

  it("closes an expired overlay socket before considering its recipient type", async () => {
    const overlay = overlaySocketFor({
      v: 1,
      kind: "overlay",
      channelId: "kanal-a",
      tokenId: "token-1",
      expiresAt: "2000-01-01T00:00:00.000Z",
    });
    const object = objectFor([overlay]);

    await object.publish([eventMessage]);

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
                  : values.slice(1, -1).map((tokenId) => ({ token_id: tokenId, overlay_id: null })),
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
