import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SQLInputValue } from "node:sqlite";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { authRouter } from "../../src/worker/auth/routes";
import { createSessionCookie } from "../../src/worker/auth/session";
import { getOverlayBindingForToken } from "../../src/worker/auth/overlay-token-repository";
import { encryptJson, hashOverlayToken, parseKeyRing } from "../../src/worker/auth/crypto";
import { revokeOverlayToken } from "../../src/worker/auth/overlay-token-service";
import { TestD1Database } from "./test-d1";

const key = (byte: number): string =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

type TestEnvironment = Env & { DB: D1Database };

const makeEnvironment = (database: TestD1Database): TestEnvironment => ({
  DB: database as unknown as D1Database,
  CF_VERSION_METADATA: {
    id: "version-2026-09-18",
    tag: "staging",
    timestamp: "2026-09-18T00:00:00.000Z",
  },
  PUBLIC_ORIGIN: "https://brobot.example",
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
  TWITCH_CLIENT_ID: "test-client-id",
  OVERLAY_TOKEN_PEPPER: key(4),
} as TestEnvironment);

const insertChannel = async (database: TestD1Database, channelId: string): Promise<void> => {
  await database.prepare(
    `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(channelId, channelId, channelId, "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
};

const insertSession = async (database: TestD1Database): Promise<void> => {
  await database.prepare(
    `INSERT INTO twitch_login_identity
      (user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
       expires_at, status, reason, created_at, updated_at)
     VALUES ('user-1', 'tester', '[]', 'access', 'refresh', ?, 'connected', NULL, ?, ?)`,
  ).bind("2099-09-19T00:00:00.000Z", "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
  await database.prepare(
    `INSERT INTO auth_sessions
      (session_id, user_id, login, expires_at, created_at, updated_at)
     VALUES ('session-1', 'user-1', 'tester', ?, ?, ?)`,
  ).bind("2099-09-19T00:00:00.000Z", "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
};

const insertBotIdentity = async (database: TestD1Database, environment: TestEnvironment): Promise<void> => {
  const keys = parseKeyRing(environment.SESSION_ENCRYPTION_KEYS ?? "");
  const access = await encryptJson({ token: "bot-access-token" }, keys);
  const refresh = await encryptJson({ token: "bot-refresh-token" }, keys);
  await database.prepare(
    `INSERT INTO bot_identity
      (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
       expires_at, created_at, updated_at)
     VALUES (1, 'bot-user', 'bot', '[]', ?, ?, ?, ?, ?)`,
  ).bind(access, refresh, "2099-09-19T00:00:00.000Z", "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
};

const insertMember = async (database: TestD1Database, channelId = "kanal-a"): Promise<void> => {
  await database.prepare(
    `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
     VALUES (?, 'user-1', 'manager', ?, ?)`,
  ).bind(channelId, "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
};

const TEST_ACTOR = { userId: "user-1", sessionId: "session-1" };

let testTokenNumber = 0;

const insertUnboundToken = async (
  database: TestD1Database,
  input: { channelId: string; pepper: string; publicOrigin: string; expiresAt: string | null; createdAt: string },
): Promise<{ tokenId: string; overlayUrl: string; expiresAt: string | null }> => {
  testTokenNumber += 1;
  const tokenBytes = new Uint8Array(32).fill(testTokenNumber % 255);
  tokenBytes[31] = testTokenNumber % 255;
  const token = btoa(String.fromCharCode(...tokenBytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const tokenId = `test-token-${String(testTokenNumber)}`;
  await database.prepare(
    `INSERT INTO overlay_tokens
      (token_id, channel_id, token_hash, expires_at, created_at, created_by_user_id)
     VALUES (?, ?, ?, ?, ?, 'user-1')`,
  ).bind(tokenId, input.channelId, await hashOverlayToken(token, input.pepper), input.expiresAt, input.createdAt).run();
  const overlayUrl = new URL("/overlay", input.publicOrigin);
  overlayUrl.hash = new URLSearchParams({ token }).toString();
  return { tokenId, overlayUrl: overlayUrl.toString(), expiresAt: input.expiresAt };
};

const sessionHeaders = async (
  environment: TestEnvironment,
  withCsrf: boolean,
): Promise<Headers> => {
  const sessionCookie = await createSessionCookie(
    { sessionId: "session-1" },
    environment.SESSION_COOKIE_KEYS,
    environment.SESSION_ENCRYPTION_KEYS ?? "",
  );
  const csrfToken = await createCsrfToken(
    "session-1",
    environment.SESSION_COOKIE_KEYS,
    new Date().toISOString(),
  );
  const headers = new Headers({
    Cookie: `__Host-brobot_session=${sessionCookie}${withCsrf ? `; __Host-brobot_csrf=${csrfToken}` : ""}`,
    "Content-Type": "application/json",
  });
  if (withCsrf) headers.set("X-CSRF-Token", csrfToken);
  return headers;
};

const overlayTokensPath = "https://brobot.example/api/channels/kanal-a/overlay-tokens";
const variablePath = (name: string): string =>
  `https://brobot.example/api/overlay/variables/${encodeURIComponent(name)}`;
const bootstrapPath = "https://brobot.example/api/overlay/bootstrap";
const revokePath = (channelId: string, tokenId: string): string =>
  `https://brobot.example/api/channels/${channelId}/overlay-tokens/${tokenId}/revoke`;

const tokenFromIssuedUrl = (overlayUrl: string): string => {
  const token = new URLSearchParams(new URL(overlayUrl).hash.slice(1)).get("token");
  if (token === null) throw new Error("Ausgabe-URL enthält kein Overlay-Token.");
  return token;
};

const bootstrapForToken = async (token: string, env: TestEnvironment): Promise<Response> =>
  await authRouter.fetch(new Request(bootstrapPath, {
    headers: { Authorization: `Bearer ${token}` },
  }), env);

const databaseWithTouchBehavior = (
  database: TestD1Database,
  behavior: "reject" | "concurrent",
): D1Database => ({
  prepare(sql: string) {
    if (!sql.includes("SET last_used_at")) return database.prepare(sql) as unknown as D1PreparedStatement;
    return {
      bind() {
        return {
          first: () => {
            if (behavior === "reject") throw new Error("D1 write quota exhausted");
            return null;
          },
        };
      },
    } as unknown as D1PreparedStatement;
  },
} as D1Database);

describe("Overlay routes", () => {
  let database: TestD1Database;
  let environment: TestEnvironment;

  beforeEach(async () => {
    database = new TestD1Database();
    environment = makeEnvironment(database);
    await insertChannel(database, "kanal-a");
    await insertSession(database);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    database.close();
  });

  it.each([
    ["revoke", revokePath("kanal-a", "token-1"), JSON.stringify({ reason: "Test" })],
  ])("rejects %s without a session", async (_name, path, body) => {
    const response = await authRouter.fetch(new Request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }), environment);

    expect(response.status).toBe(401);
  });

  it("requires channel membership to list overlay tokens", async () => {
    const response = await authRouter.fetch(new Request(overlayTokensPath, {
      headers: await sessionHeaders(environment, false),
    }), environment);

    expect(response.status).toBe(403);
  });

  it("lists only active same-channel tokens, resolves and caches creators, and omits secrets", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T10:00:00.000Z"));
    await insertMember(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await database.prepare(
      `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
       VALUES ('kanal-b', 'user-1', 'manager', ?, ?)`,
    ).bind("2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
    const createdAt = new Date().toISOString();
    const tokenA = await insertUnboundToken(database, {
      channelId: "kanal-a", pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN, expiresAt: null, createdAt,
    });
    const tokenB = await insertUnboundToken(database, {
      channelId: "kanal-b", pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN, expiresAt: null, createdAt,
    });
    // The list must use its token row's creator reference, not rejoin audit JSON.
    await database.prepare("UPDATE overlay_tokens SET created_by_user_id = ? WHERE token_id = ?")
      .bind("stored-creator", tokenA.tokenId).run();
    const revokedToken = await insertUnboundToken(database, {
      channelId: "kanal-a", pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN, expiresAt: null, createdAt,
    });
    const expiredToken = await insertUnboundToken(database, {
      channelId: "kanal-a", pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN, expiresAt: null, createdAt,
    });
    await revokeOverlayToken(database as unknown as D1Database, {
      channelId: "kanal-a", tokenId: revokedToken.tokenId, actor: TEST_ACTOR,
      reason: "Route fixture", revokedAt: new Date().toISOString(),
    });
    await database.prepare("UPDATE overlay_tokens SET expires_at = ? WHERE token_id = ?")
      .bind("2020-01-01T00:00:00.000Z", expiredToken.tokenId).run();
    await insertBotIdentity(database, environment);
    const helix = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(url.pathname).toBe("/helix/users");
      expect(url.searchParams.getAll("id")).toEqual(["stored-creator"]);
      return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "stored-creator", login: "tester", display_name: "Sample Creator" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    });
    vi.stubGlobal("fetch", helix);
    const secret = tokenFromIssuedUrl(tokenA.overlayUrl);

    const listRequest = async (): Promise<Response> => authRouter.fetch(new Request(overlayTokensPath, {
      headers: await sessionHeaders(environment, false),
    }), environment);
    const [response, concurrentRefresh] = await Promise.all([listRequest(), listRequest()]);
    const responseText = await response.text();
    const body: unknown = JSON.parse(responseText);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      tokens: [{
        id: tokenA.tokenId,
        name: null,
        createdAt,
        createdBy: "Sample Creator",
        lastUsedAt: null,
        expiresAt: null,
      }],
      nextOffset: null,
    });
    expect(responseText).not.toContain(secret);
    expect(responseText).not.toContain("tokenHash");
    expect(responseText).not.toContain("token_hash");
    expect(responseText).not.toContain(tokenB.tokenId);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(concurrentRefresh.status).toBe(200);
    expect(helix).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(body)).not.toContain(revokedToken.tokenId);
    expect(JSON.stringify(body)).not.toContain(expiredToken.tokenId);
    expect(JSON.stringify(body)).not.toContain(tokenB.tokenId);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    const refreshed = await listRequest();
    expect(refreshed.status).toBe(200);
    expect(helix).toHaveBeenCalledTimes(2);
  });

  it("paginates active token lists in stable 50-row pages", async () => {
    await insertMember(database);
    for (let index = 0; index < 51; index += 1) {
      const id = `page-token-${String(index).padStart(2, "0")}`;
      await database.prepare(
        `INSERT INTO overlay_tokens (token_id, channel_id, token_hash, created_at)
         VALUES (?, 'kanal-a', ?, ?)`,
      ).bind(id, `hash-${id}`, `2026-09-24T09:${String(index).padStart(2, "0")}:00.000Z`).run();
    }
    const headers = await sessionHeaders(environment, false);
    const firstPage = await authRouter.fetch(new Request(overlayTokensPath, { headers }), environment);
    const firstBody = await firstPage.json<{ tokens: Array<{ id: string }>; nextOffset: number | null }>();
    const secondPage = await authRouter.fetch(new Request(`${overlayTokensPath}?offset=50`, {
      headers: await sessionHeaders(environment, false),
    }), environment);
    const secondBody = await secondPage.json<{ tokens: Array<{ id: string }>; nextOffset: number | null }>();

    expect(firstBody.tokens).toHaveLength(50);
    expect(firstBody.nextOffset).toBe(50);
    expect(secondBody.tokens).toHaveLength(1);
    expect(secondBody.nextOffset).toBeNull();
    expect(firstBody.tokens.at(-1)?.id).not.toBe(secondBody.tokens[0]?.id);
  });

  it.each([
    ["revoke", revokePath("kanal-a", "token-1"), JSON.stringify({ reason: "Test" })],
  ])("rejects %s without CSRF", async (_name, path, body) => {
    const response = await authRouter.fetch(new Request(path, {
      method: "POST",
      headers: await sessionHeaders(environment, false),
      body,
    }), environment);

    expect(response.status).toBe(403);
  });

  it("rejects an operator revoking a legacy overlay token", async () => {
    await insertMember(database);
    const issued = await insertUnboundToken(database, {
      channelId: "kanal-a",
      pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN,
      expiresAt: null,
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    await database.prepare("UPDATE channel_members SET role = 'operator' WHERE channel_id = ? AND user_id = ?")
      .bind("kanal-a", "user-1").run();
    const revoke = await authRouter.fetch(new Request(revokePath("kanal-a", issued.tokenId), {
      method: "POST",
      headers: await sessionHeaders(environment, true),
      body: JSON.stringify({ reason: "Test" }),
    }), environment);

    expect(revoke.status).toBe(403);
    expect(await database.prepare("SELECT revoked_at FROM overlay_tokens WHERE token_id = ?").bind(issued.tokenId).first())
      .toEqual({ revoked_at: null });
  });

  it("waits for the realtime token close before returning a successful revocation", async () => {
    await insertMember(database);
    const issued = await insertUnboundToken(database, {
      channelId: "kanal-a",
      pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN,
      expiresAt: null,
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    let finishClose: (() => void) | undefined;
    let signalCloseStarted: (() => void) | undefined;
    const closeGate = new Promise<boolean>((resolve) => { finishClose = () => { resolve(true); }; });
    const closeStarted = new Promise<void>((resolve) => { signalCloseStarted = resolve; });
    const close = vi.fn(() => {
      signalCloseStarted?.();
      return closeGate;
    });
    environment.CHANNEL = {
      idFromName: vi.fn(() => "channel-object"),
      get: vi.fn(() => ({ revokeToken: close })),
    } as unknown as Env["CHANNEL"];
    let responseReturned = false;

    const responsePromise = Promise.resolve(authRouter.fetch(new Request(revokePath("kanal-a", issued.tokenId), {
      method: "POST",
      headers: await sessionHeaders(environment, true),
      body: JSON.stringify({ reason: "Round two test" }),
    }), environment)).then((response) => {
      responseReturned = true;
      return response;
    });

    await closeStarted;
    await Promise.resolve();
    expect(responseReturned).toBe(false);
    finishClose?.();
    const response = await responsePromise;

    expect(response.status).toBe(204);
    expect(close).toHaveBeenCalledWith(issued.tokenId);
  });

  it("reports pending when the realtime token close rejects", async () => {
    await insertMember(database);
    const issued = await insertUnboundToken(database, {
      channelId: "kanal-a",
      pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN,
      expiresAt: null,
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    environment.CHANNEL = {
      idFromName: vi.fn(() => "channel-object"),
      get: vi.fn(() => ({ revokeToken: vi.fn().mockRejectedValue(new Error("DO unavailable")) })),
    } as unknown as Env["CHANNEL"];

    try {
      const response = await authRouter.fetch(new Request(revokePath("kanal-a", issued.tokenId), {
        method: "POST",
        headers: await sessionHeaders(environment, true),
        body: JSON.stringify({ reason: "Round two failure" }),
      }), environment);

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({ closingPending: true });
      expect(warning).toHaveBeenCalledWith("Realtime revocation for token failed.", expect.any(Error));
      const revokedRow = await database.prepare("SELECT revoked_at FROM overlay_tokens WHERE token_id = ?")
        .bind(issued.tokenId).first<{ revoked_at: string | null }>();
      expect(revokedRow?.revoked_at).toBeTruthy();
    } finally {
      warning.mockRestore();
    }
  });

  it("reports pending when the realtime close times out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T10:00:00.000Z"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await insertMember(database);
      const issued = await insertUnboundToken(database, {
        channelId: "kanal-a",
        pepper: environment.OVERLAY_TOKEN_PEPPER,
        publicOrigin: environment.PUBLIC_ORIGIN,
        expiresAt: null,
        createdAt: "2026-09-18T00:00:00.000Z",
      });
      const neverSettles = new Promise<void>(() => undefined);
      const close = vi.fn(() => neverSettles);
      environment.CHANNEL = {
        idFromName: vi.fn(() => "channel-object"),
        get: vi.fn(() => ({ revokeToken: close })),
      } as unknown as Env["CHANNEL"];
      const responsePromise = authRouter.fetch(new Request(revokePath("kanal-a", issued.tokenId), {
        method: "POST",
        headers: await sessionHeaders(environment, true),
        body: JSON.stringify({ reason: "Round two timeout" }),
      }), environment);

      await vi.waitFor(() => { expect(close).toHaveBeenCalledTimes(1); });
      await vi.advanceTimersByTimeAsync(2_000);
      const response = await responsePromise;

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({ closingPending: true });
      expect(warning).toHaveBeenCalledWith(
        "Realtime token revocation is pending; the Durable Object will retry.",
      );
      const revokedRow = await database.prepare("SELECT revoked_at FROM overlay_tokens WHERE token_id = ?")
        .bind(issued.tokenId).first<{ revoked_at: string | null }>();
      expect(revokedRow?.revoked_at).toBeTruthy();
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });

  it("retries realtime closure when revocation is requested for an already-revoked row", async () => {
    await insertMember(database);
    const issued = await insertUnboundToken(database, {
      channelId: "kanal-a",
      pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN,
      expiresAt: null,
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    const close = vi.fn().mockResolvedValue(false).mockResolvedValueOnce(true);
    environment.CHANNEL = {
      idFromName: vi.fn(() => "channel-object"),
      get: vi.fn(() => ({ revokeToken: close })),
    } as unknown as Env["CHANNEL"];
    const headers = await sessionHeaders(environment, true);
    const first = await authRouter.fetch(new Request(revokePath("kanal-a", issued.tokenId), {
      method: "POST", headers, body: JSON.stringify({ reason: "Retry test" }),
    }), environment);
    expect(first.status).toBe(204);
    const secondHeaders = await sessionHeaders(environment, true);
    const second = await authRouter.fetch(new Request(revokePath("kanal-a", issued.tokenId), {
      method: "POST", headers: secondHeaders, body: JSON.stringify({ reason: "Retry test" }),
    }), environment);
    expect(second.status).toBe(202);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["revoke", revokePath("kanal-a", "token-1"), JSON.stringify({ reason: "Test" })],
  ])("rejects %s without channel membership", async (_name, path, body) => {
    const response = await authRouter.fetch(new Request(path, {
      method: "POST",
      headers: await sessionHeaders(environment, true),
      body,
    }), environment);

    expect(response.status).toBe(403);
  });

  it("returns the language stored on the channel in the legacy bootstrap", async () => {
    await insertMember(database);
    await database.prepare("UPDATE channels SET language = ? WHERE channel_id = ?")
      .bind("en", "kanal-a").run();
    const issued = await insertUnboundToken(database, {
      channelId: "kanal-a",
      pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN,
      expiresAt: null,
      createdAt: "2026-09-18T00:00:00.000Z",
    });

    const response = await bootstrapForToken(tokenFromIssuedUrl(issued.overlayUrl), environment);

    await expect(response.json()).resolves.toMatchObject({ language: "en", overlay: null, variables: {} });
  });

  it("rejects an expired token at the route level", async () => {
    await insertMember(database);
    const issued = await insertUnboundToken(database, {
      channelId: "kanal-a",
      pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN,
      expiresAt: "2099-09-18T12:00:00.000Z",
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    await database.prepare("UPDATE overlay_tokens SET expires_at = ? WHERE token_id = ?")
      .bind("2026-09-18T00:00:00.000Z", issued.tokenId)
      .run();

    const response = await bootstrapForToken(tokenFromIssuedUrl(issued.overlayUrl), environment);

    expect(response.status).toBe(401);
  });

  it("rejects a revoked token at the route level", async () => {
    await insertMember(database);
    const issued = await insertUnboundToken(database, {
      channelId: "kanal-a",
      pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN,
      expiresAt: null,
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    await revokeOverlayToken(database as unknown as D1Database, {
      channelId: "kanal-a",
      actor: TEST_ACTOR,
      tokenId: issued.tokenId,
      reason: "Quelle entfernt",
      revokedAt: "2026-09-18T00:01:00.000Z",
    });

    const response = await bootstrapForToken(tokenFromIssuedUrl(issued.overlayUrl), environment);

    expect(response.status).toBe(401);
  });

  it("rejects a token at the route level after its channel is deleted", async () => {
    await insertMember(database);
    const issued = await insertUnboundToken(database, {
      channelId: "kanal-a",
      pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN,
      expiresAt: null,
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    await database.prepare("DELETE FROM channels WHERE channel_id = ?").bind("kanal-a").run();

    const response = await bootstrapForToken(tokenFromIssuedUrl(issued.overlayUrl), environment);

    expect(response.status).toBe(401);
  });

  it.each([
    ["failed", "reject" as const],
    ["concurrent", "concurrent" as const],
  ])("still returns bootstrap data despite a %s last_used_at update", async (_description, behavior) => {
    await insertMember(database);
    const issued = await insertUnboundToken(database, {
      channelId: "kanal-a",
      pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN,
      expiresAt: null,
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    environment.DB = databaseWithTouchBehavior(database, behavior);

    const response = await bootstrapForToken(tokenFromIssuedUrl(issued.overlayUrl), environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ language: "de", overlay: null, variables: {} });
  });

  it("revokes exactly the token of the specified channel", async () => {
    await insertMember(database);
    await insertChannel(database, "kanal-b");
    await insertMember(database, "kanal-b");
    const issued = await insertUnboundToken(database, {
      channelId: "kanal-a",
      pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN,
      expiresAt: null,
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    const response = await authRouter.fetch(new Request(revokePath("kanal-b", issued.tokenId), {
      method: "POST",
      headers: await sessionHeaders(environment, true),
      body: JSON.stringify({ reason: "Quelle entfernt" }),
    }), environment);
    const bootstrap = await bootstrapForToken(tokenFromIssuedUrl(issued.overlayUrl), environment);

    expect(response.status).toBe(404);
    expect(bootstrap.status).toBe(200);
  });

  it("reads only a named variable from the token tenant", async () => {
    await insertChannel(database, "kanal-b");
    await insertMember(database, "kanal-a");
    await insertMember(database, "kanal-b");
    await database.prepare("UPDATE channels SET language = 'en' WHERE channel_id = 'kanal-a'").run();
    await database.prepare(
      `INSERT INTO channel_variables (channel_id, name, value, created_at, updated_at)
       VALUES ('kanal-b', 'score', 99, '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z')`,
    ).run();
    await database.prepare(
      `INSERT INTO channel_variables (channel_id, name, value, created_at, updated_at)
       VALUES ('kanal-a', 'lives', 7, '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z')`,
    ).run();
    const tokenA = await insertUnboundToken(database, {
      channelId: "kanal-a", pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN, expiresAt: null, createdAt: "2026-09-18T00:00:00.000Z",
    });
    const tokenB = await insertUnboundToken(database, {
      channelId: "kanal-b", pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN, expiresAt: null, createdAt: "2026-09-18T00:00:00.000Z",
    });
    const bearer = (issuedUrl: string): string => `Bearer ${tokenFromIssuedUrl(issuedUrl)}`;

    const crossTenant = await authRouter.fetch(new Request(variablePath("score"), {
      headers: { Authorization: bearer(tokenA.overlayUrl) },
    }), environment);
    const scopedValue = await authRouter.fetch(new Request(variablePath("score"), {
      headers: { Authorization: bearer(tokenB.overlayUrl) },
    }), environment);
    const channelLanguage = await authRouter.fetch(new Request(variablePath("lives"), {
      headers: { Authorization: bearer(tokenA.overlayUrl) },
    }), environment);

    expect(crossTenant.status).toBe(404);
    expect(scopedValue.status).toBe(200);
    expect(await scopedValue.json()).toEqual({ name: "score", value: 99 });
    expect(scopedValue.headers.get("Cache-Control")).toBe("no-store");
    expect(channelLanguage.status).toBe(200);
    expect(await channelLanguage.json()).toEqual({ name: "lives", value: 7 });
    expect(channelLanguage.headers.get("Content-Language")).toBe("en");
  });

  it("returns the bound overlay and only its referenced variables from bootstrap", async () => {
    await insertMember(database, "kanal-a");
    await database.prepare("UPDATE channels SET language = 'en' WHERE channel_id = 'kanal-a'").run();
    await database.prepare(
      `INSERT INTO channel_variables (channel_id, name, value, created_at, updated_at)
       VALUES ('kanal-a', 'lives', 7, '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z'),
              ('kanal-a', 'score', 99, '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z')`,
    ).run();
    await database.prepare(
      `INSERT INTO overlays (overlay_id, channel_id, name, width, height, css, revision, created_at, updated_at)
       VALUES ('overlay-a', 'kanal-a', 'Gameplay', 1920, 1080, '.score { color: gold; }', 3, ?, ?),
              ('overlay-b', 'kanal-a', 'Private', 1280, 720, '.private { display: none; }', 4, ?, ?)`,
    ).bind("2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
    await database.prepare(
      `INSERT INTO overlay_elements
        (element_id, channel_id, overlay_id, kind, label, variable_name, text, config_json, x, y, scale_percent, z, in_composition)
       VALUES ('element-a', 'kanal-a', 'overlay-a', 'variable', 'Lives', 'lives', '{value}', '{}', 8, 9, 100, 0, 1),
              ('element-b', 'kanal-a', 'overlay-b', 'variable', 'Score', 'score', '{value}', '{}', 10, 11, 125, 0, 1)`,
    ).run();
    const tokenA = await insertUnboundToken(database, {
      channelId: "kanal-a", pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN, expiresAt: null, createdAt: "2026-09-18T00:00:00.000Z",
    });
    const tokenB = await insertUnboundToken(database, {
      channelId: "kanal-a", pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN, expiresAt: null, createdAt: "2026-09-18T00:00:00.000Z",
    });
    await database.prepare("UPDATE overlay_tokens SET overlay_id = 'overlay-a' WHERE token_id = ?")
      .bind(tokenA.tokenId).run();
    await database.prepare("UPDATE overlay_tokens SET overlay_id = 'overlay-b' WHERE token_id = ?")
      .bind(tokenB.tokenId).run();
    const bearer = (overlayUrl: string): HeadersInit => ({
      Authorization: `Bearer ${tokenFromIssuedUrl(overlayUrl)}`,
    });

    const bootstrapA = await authRouter.fetch(new Request(bootstrapPath, { headers: bearer(tokenA.overlayUrl) }), environment);
    const bootstrapB = await authRouter.fetch(new Request(bootstrapPath, { headers: bearer(tokenB.overlayUrl) }), environment);
    const unreferenced = await authRouter.fetch(new Request(variablePath("score"), {
      headers: bearer(tokenA.overlayUrl),
    }), environment);

    expect(bootstrapA.status).toBe(200);
    expect(bootstrapA.headers.get("Cache-Control")).toBe("no-store");
    await expect(bootstrapA.json()).resolves.toEqual({
      language: "en",
      overlay: {
        id: "overlay-a",
        revision: 3,
        width: 1920,
        height: 1080,
        css: ".score { color: gold; }",
        elements: [{
          id: "element-a", kind: "variable", label: "Lives", variableName: "lives", text: "{value}",
          config: {}, x: 8, y: 9, scalePercent: 100, z: 0, inComposition: true,
        }],
      },
      variables: { lives: 7 },
    });
    await expect(bootstrapB.json()).resolves.toMatchObject({ overlay: { id: "overlay-b", revision: 4 }, variables: { score: 99 } });
    expect(unreferenced.status).toBe(404);
  });

  it("does not return a bound variable dropped while its reader runs", async () => {
    await insertMember(database, "kanal-a");
    await database.prepare(
      `INSERT INTO channel_variables (channel_id, name, value, created_at, updated_at)
       VALUES ('kanal-a', 'score', 99, '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z')`,
    ).run();
    await database.prepare(
      `INSERT INTO overlays (overlay_id, channel_id, name, width, height, css, revision, created_at, updated_at)
       VALUES ('overlay-a', 'kanal-a', 'Gameplay', 1920, 1080, '', 1, ?, ?)`,
    ).bind("2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
    await database.prepare(
      `INSERT INTO overlay_elements (element_id, channel_id, overlay_id, kind, variable_name)
       VALUES ('element-a', 'kanal-a', 'overlay-a', 'variable', 'score')`,
    ).run();
    const issued = await insertUnboundToken(database, {
      channelId: "kanal-a", pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN, expiresAt: null, createdAt: "2026-09-18T00:00:00.000Z",
    });
    await database.prepare("UPDATE overlay_tokens SET overlay_id = 'overlay-a' WHERE token_id = ?")
      .bind(issued.tokenId).run();

    const originalPrepare = database.prepare.bind(database);
    const preparedSql: string[] = [];
    let overlayElementDropped = false;
    const dropOverlayElement = async (): Promise<void> => {
      if (overlayElementDropped) return;
      overlayElementDropped = true;
      await originalPrepare(
        "DELETE FROM overlay_elements WHERE channel_id = 'kanal-a' AND overlay_id = 'overlay-a' AND variable_name = 'score'",
      ).run();
    };
    const interleavedDatabase = {
      prepare(sql: string): D1PreparedStatement {
        preparedSql.push(sql);
        const statement = originalPrepare(sql);
        return {
          bind(...values: SQLInputValue[]): D1PreparedStatement {
            const bound = statement.bind(...values);
            return {
              first: async () => {
                const isJoinedRead = sql.includes("FROM channel_variables AS variable") &&
                  sql.includes("JOIN overlay_elements AS element");
                const isMembershipRead = sql.includes("SELECT 1 AS present") &&
                  sql.includes("FROM overlay_elements");
                if (isJoinedRead) await dropOverlayElement();
                const result = await bound.first();
                if (isMembershipRead) await dropOverlayElement();
                return result;
              },
              all: () => bound.all(),
              run: () => bound.run(),
            } as unknown as D1PreparedStatement;
          },
        } as unknown as D1PreparedStatement;
      },
    } as unknown as D1Database;
    environment.DB = interleavedDatabase;

    const response = await authRouter.fetch(new Request(variablePath("score"), {
      headers: { Authorization: `Bearer ${tokenFromIssuedUrl(issued.overlayUrl)}` },
    }), environment);

    expect(response.status).toBe(404);
    expect(preparedSql.filter((sql) => sql.includes("JOIN overlay_elements AS element"))).toHaveLength(1);
    expect(preparedSql.some((sql) => sql.includes("SELECT 1 AS present") && sql.includes("FROM overlay_elements"))).toBe(false);
  });

  it("keeps channel-wide legacy tokens on the existing variable path", async () => {
    await insertMember(database, "kanal-a");
    await database.prepare(
      `INSERT INTO channel_variables (channel_id, name, value, created_at, updated_at)
       VALUES ('kanal-a', 'score', 99, '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z')`,
    ).run();
    const issued = await insertUnboundToken(database, {
      channelId: "kanal-a", pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN, expiresAt: null, createdAt: "2026-09-18T00:00:00.000Z",
    });

    const bootstrap = await authRouter.fetch(new Request(bootstrapPath, {
      headers: { Authorization: `Bearer ${tokenFromIssuedUrl(issued.overlayUrl)}` },
    }), environment);
    const variable = await authRouter.fetch(new Request(variablePath("score"), {
      headers: { Authorization: `Bearer ${tokenFromIssuedUrl(issued.overlayUrl)}` },
    }), environment);

    await expect(bootstrap.json()).resolves.toEqual({ language: "de", overlay: null, variables: {} });
    expect(variable.status).toBe(200);
    await expect(variable.json()).resolves.toEqual({ name: "score", value: 99 });
  });

  it("does not treat a token missing from the requested channel as a legacy token", async () => {
    await insertMember(database, "kanal-a");
    const issued = await insertUnboundToken(database, {
      channelId: "kanal-a", pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN, expiresAt: null, createdAt: "2026-09-18T00:00:00.000Z",
    });

    await expect(getOverlayBindingForToken(database as unknown as D1Database, "kanal-b", issued.tokenId))
      .rejects.toThrow("Authenticated overlay token binding could not be read.");
  });

  it("rejects an invalid overlay variable name", async () => {
    await insertMember(database, "kanal-a");
    const issued = await insertUnboundToken(database, {
      channelId: "kanal-a", pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN, expiresAt: null, createdAt: "2026-09-18T00:00:00.000Z",
    });

    const response = await authRouter.fetch(new Request(variablePath("Bad Name"), {
      headers: { Authorization: `Bearer ${tokenFromIssuedUrl(issued.overlayUrl)}` },
    }), environment);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "variable_data_invalid" });
  });
});
