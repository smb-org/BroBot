import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { authRouter } from "../../src/worker/auth/routes";
import { createSessionCookie } from "../../src/worker/auth/session";
import {
  issueOverlayToken,
  revokeOverlayToken,
  type IssueOverlayTokenInput,
} from "../../src/worker/auth/overlay-token-service";
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

const insertMember = async (database: TestD1Database, channelId = "kanal-a"): Promise<void> => {
  await database.prepare(
    `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
     VALUES (?, 'user-1', 'manager', ?, ?)`,
  ).bind(channelId, "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
};

const TEST_ACTOR = { userId: "user-1", sessionId: "session-1" };

const issueTestToken = async (
  database: TestD1Database,
  input: Omit<IssueOverlayTokenInput, "actor">,
) => {
  const issued = await issueOverlayToken(database as unknown as D1Database, { ...input, actor: TEST_ACTOR });
  if (issued === null) throw new Error("Overlay-Token-Ausgabe im Test fehlgeschlagen.");
  return issued;
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

const issuePath = "https://brobot.example/api/channels/kanal-a/overlay-tokens";
const statusPath = "https://brobot.example/api/overlay/status";
const revokePath = (channelId: string, tokenId: string): string =>
  `https://brobot.example/api/channels/${channelId}/overlay-tokens/${tokenId}/revoke`;

const tokenFromIssuedUrl = (overlayUrl: string): string => {
  const token = new URLSearchParams(new URL(overlayUrl).hash.slice(1)).get("token");
  if (token === null) throw new Error("Ausgabe-URL enthält kein Overlay-Token.");
  return token;
};

const statusForToken = async (token: string, env: TestEnvironment): Promise<Response> =>
  await authRouter.fetch(new Request(statusPath, {
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
    database.close();
  });

  it.each([
    ["issue", issuePath, "{}"],
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
    const response = await authRouter.fetch(new Request(issuePath, {
      headers: await sessionHeaders(environment, false),
    }), environment);

    expect(response.status).toBe(403);
  });

  it("lists only active tokens for the authorized channel without returning secrets or hashes", async () => {
    await insertMember(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await database.prepare(
      `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
       VALUES ('kanal-b', 'user-1', 'manager', ?, ?)`,
    ).bind("2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
    const createdAt = new Date().toISOString();
    const tokenA = await issueTestToken(database, {
      channelId: "kanal-a", pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN, expiresAt: null, createdAt,
    });
    const tokenB = await issueTestToken(database, {
      channelId: "kanal-b", pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN, expiresAt: null, createdAt,
    });
    const secret = tokenFromIssuedUrl(tokenA.overlayUrl);

    const response = await authRouter.fetch(new Request(issuePath, {
      headers: await sessionHeaders(environment, false),
    }), environment);
    const responseText = await response.text();
    const body: unknown = JSON.parse(responseText);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      tokens: [{
        id: tokenA.tokenId,
        name: null,
        createdAt,
        createdBy: null,
        lastUsedAt: null,
        expiresAt: null,
      }],
    });
    expect(responseText).not.toContain(secret);
    expect(responseText).not.toContain("tokenHash");
    expect(responseText).not.toContain("token_hash");
    expect(responseText).not.toContain(tokenB.tokenId);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each([
    ["issue", issuePath, "{}"],
    ["revoke", revokePath("kanal-a", "token-1"), JSON.stringify({ reason: "Test" })],
  ])("rejects %s without CSRF", async (_name, path, body) => {
    const response = await authRouter.fetch(new Request(path, {
      method: "POST",
      headers: await sessionHeaders(environment, false),
      body,
    }), environment);

    expect(response.status).toBe(403);
  });

  it("rejects issuing for a foreign channel despite membership in channel A", async () => {
    await insertMember(database, "kanal-a");
    await insertChannel(database, "kanal-b");

    const response = await authRouter.fetch(new Request(
      "https://brobot.example/api/channels/kanal-b/overlay-tokens",
      {
        method: "POST",
        headers: await sessionHeaders(environment, true),
        body: "{}",
      },
    ), environment);

    expect(response.status).toBe(403);
  });

  it("rejects an operator issuing and revoking an overlay token", async () => {
    await insertMember(database);
    const issue = await authRouter.fetch(new Request(issuePath, {
      method: "POST",
      headers: await sessionHeaders(environment, true),
      body: "{}",
    }), environment);

    expect(issue.status).toBe(201);
    const issued = await issue.json<{ tokenId: string }>();
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
    const issued = await issueTestToken(database, {
      channelId: "kanal-a",
      pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN,
      expiresAt: null,
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    let finishClose: (() => void) | undefined;
    let signalCloseStarted: (() => void) | undefined;
    const closeGate = new Promise<void>((resolve) => { finishClose = resolve; });
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

  it("still returns success and logs when the realtime token close rejects", async () => {
    await insertMember(database);
    const issued = await issueTestToken(database, {
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

      expect(response.status).toBe(204);
      expect(warning).toHaveBeenCalledWith("Realtime revocation for token failed.", expect.any(Error));
      const revokedRow = await database.prepare("SELECT revoked_at FROM overlay_tokens WHERE token_id = ?")
        .bind(issued.tokenId).first<{ revoked_at: string | null }>();
      expect(revokedRow?.revoked_at).toBeTruthy();
    } finally {
      warning.mockRestore();
    }
  });

  it("returns success and logs when the realtime close fails or times out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-24T10:00:00.000Z"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await insertMember(database);
      const issued = await issueTestToken(database, {
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

      expect(response.status).toBe(204);
      expect(warning).toHaveBeenCalledWith(
        "Realtime token revocation timed out; the security round remains the backstop.",
      );
      const revokedRow = await database.prepare("SELECT revoked_at FROM overlay_tokens WHERE token_id = ?")
        .bind(issued.tokenId).first<{ revoked_at: string | null }>();
      expect(revokedRow?.revoked_at).toBeTruthy();
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });

  it.each([
    ["a missing Authorization header", undefined],
    ["an empty bearer token", "Bearer "],
    ["an unusually encoded token", "Bearer abc%2Fdef"],
    ["a syntactically invalid bearer token", "Bearer abc.def"],
  ])("rejects the status fetch with %s", async (_description, authorization) => {
    const headers = authorization === undefined ? {} : { Authorization: authorization };
    const response = await authRouter.fetch(new Request(statusPath, { headers }), environment);

    expect(response.status).toBe(401);
  });

  it.each([
    ["issue", issuePath, "{}"],
    ["revoke", revokePath("kanal-a", "token-1"), JSON.stringify({ reason: "Test" })],
  ])("rejects %s without channel membership", async (_name, path, body) => {
    const response = await authRouter.fetch(new Request(path, {
      method: "POST",
      headers: await sessionHeaders(environment, true),
      body,
    }), environment);

    expect(response.status).toBe(403);
  });

  it("issues a fragment URL on the canonical delivery path and returns the deployment version from status", async () => {
    await insertMember(database);
    const response = await authRouter.fetch(new Request(issuePath, {
      method: "POST",
      headers: await sessionHeaders(environment, true),
      body: "{}",
    }), environment);
    const body = await response.json<{ tokenId: string; overlayUrl: string; expiresAt: string | null }>();
    const overlayUrl = new URL(body.overlayUrl);
    const token = new URLSearchParams(overlayUrl.hash.slice(1)).get("token");

    expect(response.status).toBe(201);
    expect(body.tokenId).toBeTruthy();
    expect(body).not.toHaveProperty("token");
    expect(body.expiresAt).toBeNull();
    expect(overlayUrl.pathname).toBe("/overlay");
    expect(overlayUrl.search).toBe("");
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const status = await authRouter.fetch(new Request("https://brobot.example/api/overlay/status", {
      headers: { Authorization: `Bearer ${token ?? ""}` },
    }), environment);
    await expect(status.json()).resolves.toEqual({ version: "version-2026-09-18", language: "de" });
    expect(status.status).toBe(200);
  });

  it("returns the language stored on the channel in the overlay status", async () => {
    await insertMember(database);
    await database.prepare("UPDATE channels SET language = ? WHERE channel_id = ?")
      .bind("en", "kanal-a").run();
    const issued = await issueTestToken(database, {
      channelId: "kanal-a",
      pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN,
      expiresAt: null,
      createdAt: "2026-09-18T00:00:00.000Z",
    });

    const response = await statusForToken(tokenFromIssuedUrl(issued.overlayUrl), environment);

    await expect(response.json()).resolves.toMatchObject({ language: "en" });
  });

  it("accepts an optional future expiry and rejects a past one", async () => {
    await insertMember(database);
    const valid = await authRouter.fetch(new Request(issuePath, {
      method: "POST",
      headers: await sessionHeaders(environment, true),
      body: JSON.stringify({ expiresAt: "2099-09-18T12:00:00.000Z" }),
    }), environment);
    const validBody = await valid.json<{ expiresAt: string | null }>();
    const invalid = await authRouter.fetch(new Request(issuePath, {
      method: "POST",
      headers: await sessionHeaders(environment, true),
      body: JSON.stringify({ expiresAt: "2000-01-01T00:00:00.000Z" }),
    }), environment);

    expect(valid.status).toBe(201);
    expect(validBody.expiresAt).toBe("2099-09-18T12:00:00.000Z");
    expect(invalid.status).toBe(400);
  });

  it("issues no token if the session expires during the transfer", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-21T00:00:00.000Z"));
      await insertMember(database);
      const headers = await sessionHeaders(environment, true);
      let releaseBody: (() => void) | undefined;
      const bodyGate = new Promise<void>((resolve) => { releaseBody = resolve; });
      const roleQueryDone = new Promise<void>((resolve) => {
        const originalPrepare = database.prepare.bind(database);
        environment.DB = {
          prepare(sql: string) {
            const statement = originalPrepare(sql);
            if (!sql.includes("FROM channels AS channel")) return statement as unknown as D1PreparedStatement;
            return {
              bind(...values: unknown[]) {
                const bound = statement.bind(...values as Parameters<typeof statement.bind>);
                return {
                  first: async <T>() => {
                    const row = await bound.first<T>();
                    resolve();
                    return row;
                  },
                };
              },
            } as unknown as D1PreparedStatement;
          },
          batch: database.batch.bind(database),
        } as unknown as D1Database;
      });
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          return bodyGate.then(() => {
            controller.enqueue(new TextEncoder().encode("{}"));
            controller.close();
          });
        },
      });
      const request = new Request(issuePath, {
        method: "POST",
        headers,
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      const responsePromise = authRouter.fetch(request, environment);

      await roleQueryDone;
      vi.setSystemTime(new Date("2100-01-01T00:00:00.000Z"));
      releaseBody?.();
      const response = await responsePromise;

      expect(response.status).toBe(403);
      await expect(database.prepare("SELECT COUNT(*) AS count FROM overlay_tokens").first())
        .resolves.toEqual({ count: 0 });
      await expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log").first())
        .resolves.toEqual({ count: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an expired token at the route level", async () => {
    await insertMember(database);
    const issued = await issueTestToken(database, {
      channelId: "kanal-a",
      pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN,
      expiresAt: "2099-09-18T12:00:00.000Z",
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    await database.prepare("UPDATE overlay_tokens SET expires_at = ? WHERE token_id = ?")
      .bind("2026-09-18T00:00:00.000Z", issued.tokenId)
      .run();

    const response = await statusForToken(tokenFromIssuedUrl(issued.overlayUrl), environment);

    expect(response.status).toBe(401);
  });

  it("rejects a revoked token at the route level", async () => {
    await insertMember(database);
    const issued = await issueTestToken(database, {
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

    const response = await statusForToken(tokenFromIssuedUrl(issued.overlayUrl), environment);

    expect(response.status).toBe(401);
  });

  it("rejects a token at the route level after its channel is deleted", async () => {
    await insertMember(database);
    const issued = await issueTestToken(database, {
      channelId: "kanal-a",
      pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN,
      expiresAt: null,
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    await database.prepare("DELETE FROM channels WHERE channel_id = ?").bind("kanal-a").run();

    const response = await statusForToken(tokenFromIssuedUrl(issued.overlayUrl), environment);

    expect(response.status).toBe(401);
  });

  it.each([
    ["failed", "reject" as const],
    ["concurrent", "concurrent" as const],
  ])("still returns status despite a %s last_used_at update", async (_description, behavior) => {
    await insertMember(database);
    const issued = await issueTestToken(database, {
      channelId: "kanal-a",
      pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN,
      expiresAt: null,
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    environment.DB = databaseWithTouchBehavior(database, behavior);

    const response = await statusForToken(tokenFromIssuedUrl(issued.overlayUrl), environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ version: "version-2026-09-18", language: "de" });
  });

  it("revokes exactly the token of the specified channel", async () => {
    await insertMember(database);
    await insertChannel(database, "kanal-b");
    await insertMember(database, "kanal-b");
    const issued = await issueTestToken(database, {
      channelId: "kanal-a",
      pepper: environment.OVERLAY_TOKEN_PEPPER,
      publicOrigin: environment.PUBLIC_ORIGIN,
      expiresAt: null,
      createdAt: "2026-09-18T00:00:00.000Z",
    });
    const token = new URLSearchParams(new URL(issued.overlayUrl).hash.slice(1)).get("token");

    const response = await authRouter.fetch(new Request(revokePath("kanal-b", issued.tokenId), {
      method: "POST",
      headers: await sessionHeaders(environment, true),
      body: JSON.stringify({ reason: "Quelle entfernt" }),
    }), environment);
    const status = await authRouter.fetch(new Request("https://brobot.example/api/overlay/status", {
      headers: { Authorization: `Bearer ${token ?? ""}` },
    }), environment);

    expect(response.status).toBe(404);
    expect(status.status).toBe(200);
  });
});
