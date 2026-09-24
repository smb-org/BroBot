import { afterEach, describe, expect, it, vi } from "vitest";

import { OVERLAY_TOKEN_SUBPROTOCOL_PREFIX, REALTIME_PROTOCOL } from "../../src/realtime-contract";
import { hashOverlayToken } from "../../src/worker/auth/crypto";
import { realtimeRouter } from "../../src/worker/realtime";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const token = "a".repeat(43);
const pepper = btoa(String.fromCharCode(...new Uint8Array(32).fill(4)))
  .replaceAll("+", "-")
  .replaceAll("/", "_")
  .replaceAll("=", "");

const insertToken = async (
  database: TestD1Database,
  channelId: string,
  options: { expiresAt?: string | null; revokedAt?: string | null; token?: string } = {},
): Promise<void> => {
  const value = options.token ?? token;
  await database.prepare(
    `INSERT INTO overlay_tokens
      (token_id, channel_id, token_hash, expires_at, created_at, revoked_at, revocation_reason, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
  ).bind(
    `token-${channelId}`,
    channelId,
    await hashOverlayToken(value, pepper),
    options.expiresAt ?? null,
    "2026-09-18T00:00:00.000Z",
    options.revokedAt ?? null,
    options.revokedAt === undefined ? null : "Testwiderruf",
  ).run();
};

const overlayRequest = (
  value: string,
  options: { protocols?: string; url?: string } = {},
): Request => new Request(options.url ?? "https://brobot.example/ws/overlay", {
  headers: {
    Upgrade: "websocket",
    "Sec-WebSocket-Protocol": options.protocols ?? `${REALTIME_PROTOCOL}, ${OVERLAY_TOKEN_SUBPROTOCOL_PREFIX}${value}`,
  },
});

const setup = async (): Promise<{
  database: TestD1Database;
  env: Env;
  idFromName: ReturnType<typeof vi.fn>;
  fetchStub: ReturnType<typeof vi.fn>;
  forwarded: () => Request | null;
}> => {
  const database = new TestD1Database();
  await insertChannel(database, "kanal-a");
  await insertChannel(database, "kanal-b");
  let request: Request | null = null;
  const fetchStub = vi.fn((internalRequest: Request) => {
    request = internalRequest;
    return Promise.resolve(new Response("forwarded"));
  });
  const idFromName = vi.fn((channelId: string) => `object:${channelId}`);
  const env = {
    DB: database as unknown as D1Database,
    OVERLAY_TOKEN_PEPPER: pepper,
    CHANNEL: {
      idFromName,
      get: () => ({ fetch: fetchStub }),
    },
  } as unknown as Env;
  return { database, env, idFromName, fetchStub, forwarded: () => request };
};

describe("overlay realtime route", () => {
  let database: TestD1Database | null = null;

  afterEach(() => {
    database?.close();
    database = null;
  });

  it("authenticates the token subprotocol and sends only its channel principal to the DO", async () => {
    const state = await setup();
    database = state.database;
    await insertToken(state.database, "kanal-b");
    await state.database.prepare(
      `INSERT INTO overlays (overlay_id, channel_id, name, created_at, updated_at)
       VALUES ('overlay-b', 'kanal-b', 'Bound', '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z')`,
    ).run();
    await state.database.prepare("UPDATE overlay_tokens SET overlay_id = 'overlay-b' WHERE token_id = 'token-kanal-b'").run();

    const response = await realtimeRouter.fetch(overlayRequest(token), state.env);

    expect(response.status).toBe(200);
    expect(state.idFromName).toHaveBeenCalledWith("kanal-b");
    const forwarded = state.forwarded();
    expect(forwarded?.url).toBe("https://channel-object.internal/ws");
    expect(forwarded?.headers.get("Sec-WebSocket-Protocol")).toBe(REALTIME_PROTOCOL);
    expect(forwarded?.headers.get("Sec-WebSocket-Protocol")).not.toContain(token);
    expect(JSON.parse(forwarded?.headers.get("X-BroBot-Principal") ?? "null")).toEqual({
      v: 1,
      kind: "overlay",
      channelId: "kanal-b",
      tokenId: "token-kanal-b",
      overlayId: "overlay-b",
      expiresAt: null,
    });
  });

  it("rejects missing, revoked, and expired overlay tokens before reaching a channel object", async () => {
    const state = await setup();
    database = state.database;
    await insertToken(state.database, "kanal-a", { token: "b".repeat(43), revokedAt: "2026-09-20T00:00:00.000Z" });
    await insertToken(state.database, "kanal-b", { token: "c".repeat(43), expiresAt: "2026-09-20T00:00:00.000Z" });

    const missing = await realtimeRouter.fetch(overlayRequest("", { protocols: REALTIME_PROTOCOL }), state.env);
    const revoked = await realtimeRouter.fetch(overlayRequest("b".repeat(43)), state.env);
    const expired = await realtimeRouter.fetch(overlayRequest("c".repeat(43)), state.env);

    expect(missing.status).toBe(401);
    expect(revoked.status).toBe(401);
    expect(expired.status).toBe(401);
    expect(state.fetchStub).not.toHaveBeenCalled();
  });

  it("ignores caller-selected channel data and routes by the token tenant", async () => {
    const state = await setup();
    database = state.database;
    await insertToken(state.database, "kanal-b");

    const response = await realtimeRouter.fetch(overlayRequest(token, {
      url: "https://brobot.example/ws/overlay?channelId=kanal-a",
    }), state.env);

    expect(response.status).toBe(200);
    expect(state.idFromName).toHaveBeenCalledTimes(1);
    expect(state.idFromName).toHaveBeenCalledWith("kanal-b");
    expect(state.fetchStub).toHaveBeenCalledTimes(1);
  });

  it("requires a WebSocket upgrade and the version protocol", async () => {
    const state = await setup();
    database = state.database;
    const noUpgrade = await realtimeRouter.fetch(new Request("https://brobot.example/ws/overlay"), state.env);
    const noVersion = await realtimeRouter.fetch(overlayRequest(token, { protocols: `${OVERLAY_TOKEN_SUBPROTOCOL_PREFIX}${token}` }), state.env);

    expect(noUpgrade.status).toBe(426);
    expect(noVersion.status).toBe(426);
    expect(state.fetchStub).not.toHaveBeenCalled();
  });
});
