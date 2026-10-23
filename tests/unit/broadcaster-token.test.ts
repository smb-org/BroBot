import { describe, expect, it, vi } from "vitest";

import type { HelixResult } from "../../src/modules/contract";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { refreshLoginIdentityTokens } from "../../src/worker/auth/login-token-refresh";
import { maintainLoginIdentities } from "../../src/worker/login-maintenance";
import { getLoginIdentity, setLoginIdentityTokenScopes, upsertLoginIdentity } from "../../src/worker/db/login-identity";
import { withBroadcasterToken } from "../../src/worker/auth/broadcaster-token";
import { createReadInterleavingDatabase, TestD1Database, type TestPreparedStatement } from "./test-d1";

const CHANNEL_ID = "1000001";
const NOW = "2026-10-23T10:00:00.000Z";
const KEY_RING = JSON.stringify({
  active: { id: "test-key", key: Buffer.from(new Uint8Array(32).fill(9)).toString("base64url") },
  retired: [],
});
const SUCCESS: HelixResult<{ value: string }> = { ok: true, status: 200, data: { value: "done" } };
const UNAUTHORIZED: HelixResult<{ value: string }> = {
  ok: false,
  status: 401,
  reason: "http_401",
  message: "Invalid OAuth token",
  body: {},
};

const environmentFor = (database: TestD1Database): Env => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "test-client",
  TWITCH_CLIENT_SECRET: "test-secret",
  TOKEN_ENCRYPTION_KEYS: KEY_RING,
  CHANNEL: {
    idFromName: (name: string) => name,
    get: () => ({ revokeUser: () => Promise.resolve() }),
  } as unknown as Env["CHANNEL"],
} as unknown as Env);

const encryptedToken = async (token: string): Promise<string> =>
  encryptJson({ token }, parseKeyRing(KEY_RING));

const seedIdentity = async (
  database: TestD1Database,
  options: { expiresAt?: string; status?: "connected" | "revoked"; scopes?: string[]; updatedAt?: string } = {},
): Promise<void> => {
  await upsertLoginIdentity(database as unknown as D1Database, {
    userId: CHANNEL_ID,
    login: "test-channel",
    scopesJson: JSON.stringify(options.scopes ?? ["channel:manage:broadcast"]),
    tokenScopesJson: JSON.stringify(options.scopes ?? ["channel:manage:broadcast"]),
    accessTokenCiphertext: await encryptedToken("old-access-token"),
    refreshTokenCiphertext: await encryptedToken("old-refresh-token"),
    expiresAt: options.expiresAt ?? "2099-10-23T10:00:00.000Z",
    status: options.status ?? "connected",
    reason: null,
    createdAt: NOW,
    updatedAt: options.updatedAt ?? NOW,
  });
};

const replaceIdentity = async (
  database: TestD1Database,
  accessToken: string,
  refreshToken: string,
  expiresAt: string,
  updatedAt: string,
): Promise<void> => {
  await upsertLoginIdentity(database as unknown as D1Database, {
    userId: CHANNEL_ID,
    login: "test-channel",
    scopesJson: '["channel:manage:broadcast"]',
    tokenScopesJson: '["channel:manage:broadcast"]',
    accessTokenCiphertext: await encryptedToken(accessToken),
    refreshTokenCiphertext: await encryptedToken(refreshToken),
    expiresAt,
    status: "connected",
    reason: null,
    createdAt: NOW,
    updatedAt,
  });
};

const refreshedTokenResponse = (scopes = ["channel:manage:broadcast"]): Response => new Response(JSON.stringify({
  access_token: "new-access-token",
  refresh_token: "new-refresh-token",
  expires_in: 7_200,
  scope: scopes,
}), { status: 200, headers: { "Content-Type": "application/json" } });

const requestUrl = (input: RequestInfo | URL): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

const createTokenWriteBarrierDatabase = (
  database: TestD1Database,
  beforeWrite: () => Promise<void>,
): D1Database => {
  let tokenRotationPrepared = false;
  let barrierUsed = false;
  return {
    prepare: (sql: string) => {
      if (sql.includes("UPDATE twitch_login_identity") && sql.includes("SET access_token_ciphertext")) {
        tokenRotationPrepared = true;
      }
      return database.prepare(sql);
    },
    batch: (statements: D1PreparedStatement[]) => {
      const shouldWait = tokenRotationPrepared && !barrierUsed;
      tokenRotationPrepared = false;
      if (!shouldWait) return database.batch(statements as unknown as TestPreparedStatement[]);
      barrierUsed = true;
      return beforeWrite().then(() => database.batch(statements as unknown as TestPreparedStatement[]));
    },
  } as unknown as D1Database;
};

describe("withBroadcasterToken", () => {
  it("uses a connected broadcaster token without requiring an active session", async () => {
    const database = new TestD1Database();
    try {
      await seedIdentity(database);
      const call = vi.fn((token: string) => {
        expect(token).toBe("old-access-token");
        return Promise.resolve(SUCCESS);
      });

      await expect(withBroadcasterToken(
        environmentFor(database), CHANNEL_ID, ["channel:manage:broadcast"], call,
        { now: () => NOW, fetcher: vi.fn<typeof fetch>() },
      )).resolves.toEqual({ kind: "ok", value: { value: "done" } });
      expect(call).toHaveBeenCalledOnce();
    } finally {
      database.close();
    }
  });

  it("refreshes a token that expires within the proactive window before calling Helix", async () => {
    const database = new TestD1Database();
    try {
      await seedIdentity(database, { expiresAt: "2026-10-23T10:04:00.000Z" });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(refreshedTokenResponse());
      const call = vi.fn((token: string) => Promise.resolve(token === "new-access-token" ? SUCCESS : UNAUTHORIZED));

      await expect(withBroadcasterToken(
        environmentFor(database), CHANNEL_ID, ["channel:manage:broadcast"], call,
        { now: () => NOW, fetcher },
      )).resolves.toEqual({ kind: "ok", value: { value: "done" } });

      expect(fetcher).toHaveBeenCalledOnce();
      expect(call).toHaveBeenCalledOnce();
      expect(await getLoginIdentity(database as unknown as D1Database, CHANNEL_ID)).toMatchObject({
        expiresAt: "2026-10-23T12:00:00.000Z",
        tokenScopesJson: '["channel:manage:broadcast"]',
      });
    } finally {
      database.close();
    }
  });

  it("shares one refresh across three concurrent calls for an expiring token", async () => {
    const database = new TestD1Database();
    try {
      await seedIdentity(database, { expiresAt: "2026-10-23T10:04:00.000Z" });
      const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(refreshedTokenResponse()));
      const call = vi.fn(() => Promise.resolve(SUCCESS));
      const operations = Array.from({ length: 3 }, () => withBroadcasterToken(
        environmentFor(database), CHANNEL_ID, ["channel:manage:broadcast"], call,
        { now: () => NOW, fetcher },
      ));

      await expect(Promise.all(operations)).resolves.toEqual(Array.from({ length: 3 }, () => ({
        kind: "ok",
        value: { value: "done" },
      })));

      expect(fetcher).toHaveBeenCalledOnce();
      expect(call).toHaveBeenCalledTimes(3);
    } finally {
      database.close();
    }
  });

  it("shares an in-flight cron refresh with a request started at a later timestamp", async () => {
    const database = new TestD1Database();
    let releaseTokenWrite!: () => void;
    let markTokenWriteStarted!: () => void;
    let releaseInitialRequest!: () => void;
    let markInitialRequestStarted!: () => void;
    const tokenWriteGate = new Promise<void>((resolve) => { releaseTokenWrite = resolve; });
    const tokenWriteStarted = new Promise<void>((resolve) => { markTokenWriteStarted = resolve; });
    const initialRequestGate = new Promise<void>((resolve) => { releaseInitialRequest = resolve; });
    const initialRequestStarted = new Promise<void>((resolve) => { markInitialRequestStarted = resolve; });
    try {
      await seedIdentity(database, { updatedAt: "2026-10-22T10:00:00.000Z" });
      await database.prepare(
        `INSERT INTO auth_sessions (session_id, user_id, login, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind("session-1", CHANNEL_ID, "test-channel", "2099-10-23T10:00:00.000Z", NOW, NOW).run();

      const cronFetcher = vi.fn<typeof fetch>().mockImplementation((input) => {
        if (requestUrl(input).endsWith("/validate")) {
          return Promise.resolve(new Response(JSON.stringify({ error: "invalid_token" }), { status: 401 }));
        }
        if (requestUrl(input).endsWith("/token")) {
          return Promise.resolve(refreshedTokenResponse());
        }
        return Promise.reject(new Error("Unexpected maintenance request."));
      });
      vi.stubGlobal("fetch", cronFetcher);

      const environment = environmentFor(database);
      environment.DB = createTokenWriteBarrierDatabase(database, async () => {
        markTokenWriteStarted();
        await tokenWriteGate;
      });
      const maintenance = maintainLoginIdentities(environment, NOW);
      await tokenWriteStarted;

      const requestFetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(
        JSON.stringify({ error: "invalid_grant" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ));
      const requestCall = vi.fn(async (token: string) => {
        if (token === "old-access-token") {
          markInitialRequestStarted();
          await initialRequestGate;
          return UNAUTHORIZED;
        }
        return token === "new-access-token" ? SUCCESS : UNAUTHORIZED;
      });
      const request = withBroadcasterToken(
        environment, CHANNEL_ID, ["channel:manage:broadcast"], requestCall,
        { now: () => "2026-10-23T10:00:01.000Z", fetcher: requestFetcher },
      );

      await initialRequestStarted;
      releaseInitialRequest();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      const requestRefreshCallsBeforeCronPersists = requestFetcher.mock.calls.length;

      releaseTokenWrite();
      await maintenance;

      await expect(request).resolves.toEqual({ kind: "ok", value: { value: "done" } });
      expect(cronFetcher.mock.calls.filter(([input]) => requestUrl(input).endsWith("/token"))).toHaveLength(1);
      expect(requestRefreshCallsBeforeCronPersists).toBe(0);
      expect(requestFetcher).not.toHaveBeenCalled();
      expect(requestCall.mock.calls.map(([token]) => token)).toEqual(["old-access-token", "new-access-token"]);
      expect(await getLoginIdentity(database as unknown as D1Database, CHANNEL_ID)).toMatchObject({
        status: "connected",
        reason: null,
      });
    } finally {
      releaseInitialRequest();
      releaseTokenWrite();
      vi.unstubAllGlobals();
      database.close();
    }
  });

  it("refreshes after a metadata-only update that changes updatedAt", async () => {
    const database = new TestD1Database();
    try {
      await seedIdentity(database, {
        expiresAt: "2026-10-23T10:04:00.000Z",
        updatedAt: "2026-10-22T10:00:00.000Z",
      });
      const identity = await getLoginIdentity(database as unknown as D1Database, CHANNEL_ID);
      if (identity === null) throw new Error("The seeded login identity was not stored.");
      const environment = environmentFor(database);
      environment.DB = createReadInterleavingDatabase(
        database,
        (sql) => sql.includes("FROM twitch_login_identity") && sql.includes("WHERE user_id = ?"),
        () => setLoginIdentityTokenScopes(
          database as unknown as D1Database,
          CHANNEL_ID,
          JSON.stringify(["channel:manage:broadcast", "user:read:email"]),
          "2026-10-23T10:00:01.000Z",
          identity.accessTokenCiphertext,
          identity.refreshTokenCiphertext,
        ),
      );
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(refreshedTokenResponse());
      const call = vi.fn((token: string) => Promise.resolve(token === "new-access-token" ? SUCCESS : UNAUTHORIZED));

      await expect(withBroadcasterToken(
        environment, CHANNEL_ID, ["channel:manage:broadcast"], call,
        { now: () => NOW, fetcher },
      )).resolves.toEqual({ kind: "ok", value: { value: "done" } });

      expect(fetcher).toHaveBeenCalledOnce();
      expect(call).toHaveBeenCalledOnce();
      expect(call).toHaveBeenCalledWith("new-access-token");
    } finally {
      database.close();
    }
  });

  it("refreshes once after a 401 and retries with the replacement access token", async () => {
    const database = new TestD1Database();
    try {
      await seedIdentity(database);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(refreshedTokenResponse());
      const call = vi.fn<(token: string) => Promise<HelixResult<{ value: string }>>>()
        .mockResolvedValueOnce(UNAUTHORIZED)
        .mockResolvedValueOnce(SUCCESS);

      await expect(withBroadcasterToken(
        environmentFor(database), CHANNEL_ID, ["channel:manage:broadcast"], call,
        { now: () => NOW, fetcher },
      )).resolves.toEqual({ kind: "ok", value: { value: "done" } });

      expect(call.mock.calls.map(([token]) => token)).toEqual(["old-access-token", "new-access-token"]);
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      database.close();
    }
  });

  it("uses a replacement committed while the initial Helix call is pending", async () => {
    const database = new TestD1Database();
    try {
      await seedIdentity(database);
      let markInitialCallStarted!: () => void;
      let releaseInitialCall!: () => void;
      const initialCallStarted = new Promise<void>((resolve) => { markInitialCallStarted = resolve; });
      const initialCallGate = new Promise<void>((resolve) => { releaseInitialCall = resolve; });
      const fetcher = vi.fn<typeof fetch>();
      const call = vi.fn(async (token: string) => {
        if (token === "old-access-token") {
          markInitialCallStarted();
          await initialCallGate;
          return UNAUTHORIZED;
        }
        return token === "replacement-access-token" ? SUCCESS : UNAUTHORIZED;
      });
      const operation = withBroadcasterToken(
        environmentFor(database), CHANNEL_ID, ["channel:manage:broadcast"], call,
        { now: () => NOW, fetcher },
      );

      await initialCallStarted;
      await replaceIdentity(
        database,
        "replacement-access-token",
        "replacement-refresh-token",
        "2026-10-23T12:00:00.000Z",
        "2026-10-23T10:00:01.000Z",
      );
      releaseInitialCall();

      await expect(operation).resolves.toEqual({ kind: "ok", value: { value: "done" } });
      expect(call.mock.calls.map(([token]) => token)).toEqual(["old-access-token", "replacement-access-token"]);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("does not refresh twice when a proactive refresh is followed by a 401", async () => {
    const database = new TestD1Database();
    try {
      await seedIdentity(database, { expiresAt: "2026-10-23T10:04:00.000Z" });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(refreshedTokenResponse());
      const call = vi.fn<(token: string) => Promise<HelixResult<{ value: string }>>>().mockResolvedValue(UNAUTHORIZED);

      await expect(withBroadcasterToken(
        environmentFor(database), CHANNEL_ID, ["channel:manage:broadcast"], call,
        { now: () => NOW, fetcher },
      )).resolves.toEqual({ kind: "http_error", result: UNAUTHORIZED });

      expect(fetcher).toHaveBeenCalledOnce();
      expect(call).toHaveBeenCalledOnce();
    } finally {
      database.close();
    }
  });

  it("fails without network or writes when a read-only token is expired", async () => {
    const database = new TestD1Database();
    try {
      await seedIdentity(database, { expiresAt: "2026-10-23T09:59:00.000Z" });
      const before = await getLoginIdentity(database as unknown as D1Database, CHANNEL_ID);
      const fetcher = vi.fn<typeof fetch>();
      const call = vi.fn<(token: string) => Promise<HelixResult<{ value: string }>>>();

      await expect(withBroadcasterToken(
        environmentFor(database), CHANNEL_ID, ["channel:manage:broadcast"], call,
        { now: () => NOW, fetcher, refresh: "never" },
      )).resolves.toEqual({ kind: "refresh_failed" });

      expect(fetcher).not.toHaveBeenCalled();
      expect(call).not.toHaveBeenCalled();
      expect(await getLoginIdentity(database as unknown as D1Database, CHANNEL_ID)).toEqual(before);
    } finally {
      database.close();
    }
  });

  it("does not refresh or write when a read-only token gets a Helix 401", async () => {
    const database = new TestD1Database();
    try {
      await seedIdentity(database);
      const before = await getLoginIdentity(database as unknown as D1Database, CHANNEL_ID);
      const fetcher = vi.fn<typeof fetch>();
      const call = vi.fn<(token: string) => Promise<HelixResult<{ value: string }>>>().mockResolvedValue(UNAUTHORIZED);

      await expect(withBroadcasterToken(
        environmentFor(database), CHANNEL_ID, ["channel:manage:broadcast"], call,
        { now: () => NOW, fetcher, refresh: "never" },
      )).resolves.toEqual({ kind: "http_error", result: UNAUTHORIZED });

      expect(fetcher).not.toHaveBeenCalled();
      expect(call).toHaveBeenCalledOnce();
      expect(await getLoginIdentity(database as unknown as D1Database, CHANNEL_ID)).toEqual(before);
    } finally {
      database.close();
    }
  });

  it("clears a rejected shared refresh so a later call can recover", async () => {
    const database = new TestD1Database();
    let releaseRejectedRefresh!: () => void;
    let markRejectedRefreshStarted!: () => void;
    const rejectedRefreshGate = new Promise<void>((resolve) => { releaseRejectedRefresh = resolve; });
    const rejectedRefreshStarted = new Promise<void>((resolve) => { markRejectedRefreshStarted = resolve; });
    try {
      await seedIdentity(database);
      const identity = await getLoginIdentity(database as unknown as D1Database, CHANNEL_ID);
      if (identity === null) throw new Error("The seeded login identity was not stored.");
      const fetcher = vi.fn<typeof fetch>(async () => {
        markRejectedRefreshStarted();
        await rejectedRefreshGate;
        return new Response(JSON.stringify({ error: "invalid_client" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      });

      const firstRefresh = refreshLoginIdentityTokens(environmentFor(database), identity, NOW, fetcher);
      await rejectedRefreshStarted;
      const overlappingRefresh = refreshLoginIdentityTokens(environmentFor(database), identity, NOW, fetcher);
      releaseRejectedRefresh();
      await expect(Promise.all([firstRefresh, overlappingRefresh])).rejects.toThrow();
      expect(fetcher).toHaveBeenCalledOnce();

      fetcher.mockResolvedValueOnce(refreshedTokenResponse());
      await expect(refreshLoginIdentityTokens(environmentFor(database), identity, NOW, fetcher)).resolves.toMatchObject({
        userId: CHANNEL_ID,
        status: "connected",
        expiresAt: "2026-10-23T12:00:00.000Z",
      });

      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      releaseRejectedRefresh();
      database.close();
    }
  });

  it("does not refresh again when the retry also returns 401", async () => {
    const database = new TestD1Database();
    try {
      await seedIdentity(database);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(refreshedTokenResponse());
      const call = vi.fn<(token: string) => Promise<HelixResult<{ value: string }>>>().mockResolvedValue(UNAUTHORIZED);

      await expect(withBroadcasterToken(
        environmentFor(database), CHANNEL_ID, ["channel:manage:broadcast"], call,
        { now: () => NOW, fetcher },
      )).resolves.toEqual({ kind: "http_error", result: UNAUTHORIZED });

      expect(call).toHaveBeenCalledTimes(2);
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      database.close();
    }
  });

  it("revokes the identity and clears scopes when refresh returns invalid_grant", async () => {
    const database = new TestD1Database();
    try {
      await seedIdentity(database);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(
        JSON.stringify({ error: "invalid_grant" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ));
      const call = vi.fn<(token: string) => Promise<HelixResult<{ value: string }>>>().mockResolvedValue(UNAUTHORIZED);

      await expect(withBroadcasterToken(
        environmentFor(database), CHANNEL_ID, ["channel:manage:broadcast"], call,
        { now: () => NOW, fetcher },
      )).resolves.toEqual({ kind: "revoked", source: "refresh" });

      expect(await getLoginIdentity(database as unknown as D1Database, CHANNEL_ID)).toMatchObject({
        status: "revoked",
        reason: "authorization_revoked",
        scopesJson: "[]",
        tokenScopesJson: "[]",
      });
      expect(call).toHaveBeenCalledOnce();
    } finally {
      database.close();
    }
  });

  it("leaves identity state unchanged when refresh fails for a non-revocation reason", async () => {
    const database = new TestD1Database();
    try {
      await seedIdentity(database);
      const before = await getLoginIdentity(database as unknown as D1Database, CHANNEL_ID);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(
        JSON.stringify({ error: "invalid_client" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      ));
      const call = vi.fn().mockResolvedValue(UNAUTHORIZED);

      await expect(withBroadcasterToken(
        environmentFor(database), CHANNEL_ID, ["channel:manage:broadcast"], call,
        { now: () => NOW, fetcher },
      )).resolves.toEqual({ kind: "refresh_failed" });

      expect(await getLoginIdentity(database as unknown as D1Database, CHANNEL_ID)).toEqual(before);
      expect(call).toHaveBeenCalledOnce();
    } finally {
      database.close();
    }
  });

  it("returns missing scopes without calling the network", async () => {
    const database = new TestD1Database();
    try {
      await seedIdentity(database, { scopes: ["moderation:read"] });
      const fetcher = vi.fn<typeof fetch>();
      const call = vi.fn<(token: string) => Promise<HelixResult<{ value: string }>>>();

      await expect(withBroadcasterToken(
        environmentFor(database), CHANNEL_ID, ["channel:manage:broadcast"], call,
        { now: () => NOW, fetcher },
      )).resolves.toEqual({ kind: "scope_missing", missing: ["channel:manage:broadcast"] });

      expect(call).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("reports a previously revoked identity without calling the network", async () => {
    const database = new TestD1Database();
    try {
      await seedIdentity(database, { status: "revoked" });
      const fetcher = vi.fn<typeof fetch>();
      const call = vi.fn<(token: string) => Promise<HelixResult<{ value: string }>>>();

      await expect(withBroadcasterToken(
        environmentFor(database), CHANNEL_ID, ["channel:manage:broadcast"], call,
        { now: () => NOW, fetcher },
      )).resolves.toEqual({ kind: "revoked", source: "stored" });

      expect(call).not.toHaveBeenCalled();
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("uses a concurrently stored replacement token after a stale refresh gets invalid_grant", async () => {
    const database = new TestD1Database();
    try {
      await seedIdentity(database);
      const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => {
        await upsertLoginIdentity(database as unknown as D1Database, {
          userId: CHANNEL_ID,
          login: "test-channel",
          scopesJson: '["channel:manage:broadcast"]',
          tokenScopesJson: '["channel:manage:broadcast"]',
          accessTokenCiphertext: await encryptedToken("concurrent-access-token"),
          refreshTokenCiphertext: await encryptedToken("concurrent-refresh-token"),
          expiresAt: "2026-10-23T12:00:00.000Z",
          status: "connected",
          reason: null,
          createdAt: NOW,
          updatedAt: NOW,
        });
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      });
      const call = vi.fn((token: string) => Promise.resolve(token === "concurrent-access-token" ? SUCCESS : UNAUTHORIZED));

      await expect(withBroadcasterToken(
        environmentFor(database), CHANNEL_ID, ["channel:manage:broadcast"], call,
        { now: () => NOW, fetcher },
      )).resolves.toEqual({ kind: "ok", value: { value: "done" } });

      expect(call.mock.calls.map(([token]) => token)).toEqual(["old-access-token", "concurrent-access-token"]);
      expect((await getLoginIdentity(database as unknown as D1Database, CHANNEL_ID))?.status).toBe("connected");
    } finally {
      database.close();
    }
  });
});
