import { describe, expect, it, vi } from "vitest";

import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { setLoginIdentityStatus } from "../../src/worker/auth/repository";
import { maintainLoginIdentities } from "../../src/worker/login-maintenance";
import { TestD1Database } from "./test-d1";

const keyRingSerialized = JSON.stringify({
  active: {
    id: "encryption-v1",
    key: Buffer.from(new Uint8Array(32).fill(7)).toString("base64url"),
  },
  retired: [],
});

const makeEnvironment = async (
  expiresAt: string,
  options: {
    failTokenWriteOnce?: boolean;
    failTokenWriteAfterCommitOnce?: boolean;
    beforeTokenWrite?: () => Promise<void>;
    onSuccessfulTokenWrite?: () => void;
  } = {},
) => {
  const keys = parseKeyRing(keyRingSerialized);
  const initialAccessTokenCiphertext = await encryptJson({ token: "access-alt" }, keys);
  const initialRefreshTokenCiphertext = await encryptJson({ token: "refresh-alt" }, keys);
  let row = {
    user_id: "user-1",
    login: "tester",
    scopes_json: "[\"user:read:moderated_channels\"]",
    access_token_ciphertext: initialAccessTokenCiphertext,
    refresh_token_ciphertext: initialRefreshTokenCiphertext,
    expires_at: expiresAt,
    status: "connected",
    reason: null as string | null,
    created_at: "2026-09-17T00:00:00.000Z",
    updated_at: "2026-09-17T00:00:00.000Z",
  };
  let sessions = [{
    session_id: "session-1",
    user_id: "user-1",
    revoked_at: null as string | null,
    revocation_reason: null as string | null,
  }];
  const bind = vi.fn().mockReturnThis();
  let tokenWriteAttempts = 0;
  const prepare = vi.fn((sql: string) => {
    let values: unknown[] = [];
    const statement = {
      bind: vi.fn((...args: unknown[]) => {
        values = args;
        bind(...args);
        return statement;
      }),
      all: vi.fn().mockImplementation(() =>
        sql.includes("FROM twitch_login_identity") ? { results: [row] } : { results: [] }),
      run: vi.fn().mockImplementation(async () => {
        if (sql.includes("UPDATE twitch_login_identity") && sql.includes("SET access_token_ciphertext")) {
          tokenWriteAttempts += 1;
          if (options.failTokenWriteOnce && tokenWriteAttempts === 1) throw new Error("D1 write failed");
          if (options.beforeTokenWrite && tokenWriteAttempts === 1) await options.beforeTokenWrite();
          const [access, refresh, expires, recoveryCutoff, , updated, userId, expectedAccess, expectedRefresh] = values;
          if (row.user_id !== userId ||
              row.access_token_ciphertext !== expectedAccess ||
              row.refresh_token_ciphertext !== expectedRefresh) {
            return { success: true, meta: { changes: 0 } };
          }
          const wasRevokedAfterStart = row.status !== "revoked" ||
            row.updated_at <= String(recoveryCutoff);
          row = {
            ...row,
            access_token_ciphertext: String(access),
            refresh_token_ciphertext: String(refresh),
            expires_at: String(expires),
            status: wasRevokedAfterStart ? "connected" : row.status,
            reason: wasRevokedAfterStart ? null : row.reason,
            updated_at: String(updated),
          };
          options.onSuccessfulTokenWrite?.();
          if (options.failTokenWriteAfterCommitOnce && tokenWriteAttempts === 1) {
            throw new Error("D1 response lost after commit");
          }
        }
        if (sql.includes("UPDATE twitch_login_identity") && sql.includes("SET status = ?") && sql.includes("access_token_ciphertext")) {
          const [status, reason, updatedAt, userId, expectedAccess, expectedRefresh] = values;
          if (row.user_id !== userId || row.status === "revoked" ||
              row.access_token_ciphertext !== expectedAccess ||
              row.refresh_token_ciphertext !== expectedRefresh) {
            return { success: true, meta: { changes: 0 } };
          }
          row = {
            ...row,
            status: status as "connected" | "revoked" | "error",
            reason: reason as string | null,
            updated_at: String(updatedAt),
          };
          return { success: true, meta: { changes: 1 } };
        }
        if (sql.includes("UPDATE twitch_login_identity") && sql.includes("status = 'revoked'")) {
          const [reason, updatedAt, userId, expectedAccess, expectedRefresh] = values;
          if (row.user_id !== userId || row.status === "revoked" ||
              row.access_token_ciphertext !== expectedAccess ||
              row.refresh_token_ciphertext !== expectedRefresh) {
            return { success: true, meta: { changes: 0 } };
          }
          row = {
            ...row,
            status: "revoked",
            reason: String(reason),
            updated_at: String(updatedAt),
          };
        }
        if (sql.includes("UPDATE twitch_login_identity") && !sql.includes("access_token_ciphertext")) {
          row = {
            ...row,
            status: values[0] as "connected" | "revoked" | "error",
            reason: values[1] as string | null,
            updated_at: String(values[2]),
          };
        }
        if (sql.includes("UPDATE auth_sessions") && sql.includes("SET revoked_at = NULL")) {
          const [updatedAt, userId, expectedRevokedAfter, expectedRevokedBefore, identityUserId, expectedAccess, expectedRefresh] = values;
          const revokedAt = sessions[0]?.revoked_at;
          if (row.user_id !== identityUserId ||
              revokedAt === null || revokedAt === undefined ||
              revokedAt <= String(expectedRevokedAfter) ||
              revokedAt > String(expectedRevokedBefore) ||
              row.access_token_ciphertext !== expectedAccess ||
              row.refresh_token_ciphertext !== expectedRefresh) {
            return { success: true, meta: { changes: 0 } };
          }
          sessions = sessions.map((session) => session.user_id === userId
            ? { ...session, revoked_at: null, revocation_reason: null, updated_at: String(updatedAt) }
            : session);
        }
        if (sql.includes("UPDATE auth_sessions") && sql.includes("SET revoked_at = ?,")) {
          const [revokedAt, reason, , userId, identityUserId, expectedAccess, expectedRefresh] = values;
          if (row.status !== "revoked" || row.user_id !== identityUserId ||
              row.access_token_ciphertext !== expectedAccess ||
              row.refresh_token_ciphertext !== expectedRefresh) {
            return { success: true, meta: { changes: 0 } };
          }
          sessions = sessions.map((session) => session.user_id === userId
            ? { ...session, revoked_at: String(revokedAt), revocation_reason: String(reason) }
            : session);
        }
        return { success: true, meta: { changes: 1 } };
      }),
    };
    return statement;
  });
  const batch = async (statements: D1PreparedStatement[]) => {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  };
  return {
    environment: {
      DB: { prepare, batch } as unknown as D1Database,
      TWITCH_CLIENT_ID: "client-id",
      TWITCH_CLIENT_SECRET: "client-secret",
      SESSION_ENCRYPTION_KEYS: keyRingSerialized,
    } as unknown as Env,
    bind,
    prepare,
    getTokenWriteAttempts: () => tokenWriteAttempts,
    read: () => row,
    readSessions: () => sessions,
    getInitialAccessTokenCiphertext: () => initialAccessTokenCiphertext,
    getInitialRefreshTokenCiphertext: () => initialRefreshTokenCiphertext,
  };
};

describe("Login-Token-Wartung", () => {
  it("validiert weit entfernte Login-Tokens, erneuert sie aber noch nicht", async () => {
    const { environment } = await makeEnvironment("2026-09-18T02:00:01.000Z");
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ user_id: "user-1", login: "tester", expires_in: 7200 }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetcher);

    await maintainLoginIdentities(environment, "2026-09-18T00:00:00.000Z");

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://id.twitch.tv/oauth2/validate");
  });

  it("ersetzt bei baldiger Ablaufzeit Access- und Refresh-Token gemeinsam", async () => {
    const {
      environment,
      read,
      getInitialAccessTokenCiphertext,
      getInitialRefreshTokenCiphertext,
    } = await makeEnvironment("2026-09-18T00:59:59.000Z");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ user_id: "user-1", login: "tester", expires_in: 3599 }),
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ access_token: "access-neu", refresh_token: "refresh-neu", expires_in: 7200, scope: [] }),
        { status: 200 },
      ));
    vi.stubGlobal("fetch", fetcher);

    await maintainLoginIdentities(environment, "2026-09-18T00:00:00.000Z");

    expect(fetcher.mock.calls.map((call: unknown[]) => call[0])).toContain("https://id.twitch.tv/oauth2/token");
    expect(read().access_token_ciphertext).not.toBe(getInitialAccessTokenCiphertext());
    expect(read().refresh_token_ciphertext).not.toBe(getInitialRefreshTokenCiphertext());
    expect(read().updated_at).toBe("2026-09-18T00:00:00.000Z");
  });

  it("wiederholt den D1-Write nach erfolgreichem Login-Refresh", async () => {
    const { environment, getTokenWriteAttempts } = await makeEnvironment(
      "2026-09-18T00:59:59.000Z",
      { failTokenWriteOnce: true },
    );
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ user_id: "user-1", login: "tester", expires_in: 3599 }),
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ access_token: "access-neu", refresh_token: "refresh-neu", expires_in: 7200, scope: [] }),
        { status: 200 },
      ));
    vi.stubGlobal("fetch", fetcher);

    await maintainLoginIdentities(environment, "2026-09-18T00:00:00.000Z");

    expect(getTokenWriteAttempts()).toBe(2);
  });

  it("behält einen bereits geschriebenen Login-Token, wenn die D1-Antwort verloren geht", async () => {
    const {
      environment,
      read,
      readSessions,
      getInitialAccessTokenCiphertext,
      getInitialRefreshTokenCiphertext,
      getTokenWriteAttempts,
    } = await makeEnvironment(
      "2026-09-18T00:59:59.000Z",
      { failTokenWriteAfterCommitOnce: true },
    );
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ user_id: "user-1", login: "tester", expires_in: 3599 }),
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ access_token: "access-neu", refresh_token: "refresh-neu", expires_in: 7200, scope: [] }),
        { status: 200 },
      ));
    vi.stubGlobal("fetch", fetcher);

    await maintainLoginIdentities(environment, "2026-09-18T00:00:00.000Z");

    expect(getTokenWriteAttempts()).toBe(2);
    expect(read().access_token_ciphertext).not.toBe(getInitialAccessTokenCiphertext());
    expect(read().refresh_token_ciphertext).not.toBe(getInitialRefreshTokenCiphertext());
    expect(read().status).toBe("connected");
    expect(readSessions()[0]?.revoked_at).toBeNull();
  });

  it("klassifiziert invalid_client als vorübergehenden Refresh-Fehler", async () => {
    const { environment, read } = await makeEnvironment("2026-09-18T00:59:59.000Z");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ user_id: "user-1", login: "tester", expires_in: 3599 }),
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "invalid_client" }), { status: 400 }));
    vi.stubGlobal("fetch", fetcher);

    await maintainLoginIdentities(environment, "2026-09-18T00:00:00.000Z");

    expect(read().status).toBe("error");
    expect(read().reason).toBe("invalid_client");
  });

  it("widerruft bei invalid_grant die Identität und ihre bestehenden Sessions", async () => {
    const { environment, read, readSessions } = await makeEnvironment("2026-09-18T00:59:59.000Z");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ user_id: "user-1", login: "tester", expires_in: 3599 }),
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: "invalid_grant", message: "Invalid OAuth token" }),
        { status: 400 },
      ));
    vi.stubGlobal("fetch", fetcher);

    await maintainLoginIdentities(environment, "2026-09-18T00:00:00.000Z");

    expect(read().status).toBe("revoked");
    expect(read().reason).toBe("authorization_revoked");
    expect(readSessions()).toEqual([{
      session_id: "session-1",
      user_id: "user-1",
      revoked_at: "2026-09-18T00:00:00.000Z",
      revocation_reason: "authorization_revoked",
    }]);
  });

  it("refresh’t auch nach einem 401 bei noch weit entferntem Ablauf genau einmal", async () => {
    const { environment, read, getInitialAccessTokenCiphertext, getInitialRefreshTokenCiphertext } = await makeEnvironment("2026-09-18T02:00:01.000Z");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ message: "Invalid OAuth token" }),
        { status: 401 },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ access_token: "access-neu", refresh_token: "refresh-neu", expires_in: 7200, scope: [] }),
        { status: 200 },
      ));
    vi.stubGlobal("fetch", fetcher);

    await maintainLoginIdentities(environment, "2026-09-18T00:00:00.000Z");

    expect(fetcher.mock.calls.filter((call: unknown[]) => call[0] === "https://id.twitch.tv/oauth2/token")).toHaveLength(1);
    expect(read().status).toBe("connected");
    expect(read().access_token_ciphertext).not.toBe(getInitialAccessTokenCiphertext());
    expect(read().refresh_token_ciphertext).not.toBe(getInitialRefreshTokenCiphertext());
  });

  it("setzt bei einem frischen 401 nur nach dem fehlgeschlagenen Refresh auf revoked", async () => {
    const { environment, read, readSessions } = await makeEnvironment("2026-09-18T02:00:01.000Z");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ message: "Invalid OAuth token" }),
        { status: 401 },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ error: "invalid_grant" }),
        { status: 400 },
      ));
    vi.stubGlobal("fetch", fetcher);

    await maintainLoginIdentities(environment, "2026-09-18T00:00:00.000Z");

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(read().status).toBe("revoked");
    expect(readSessions()[0]?.revoked_at).toBe("2026-09-18T00:00:00.000Z");
  });

  it("lässt eine erfolgreiche Rotation trotz parallelem Status-Update bestehen", async () => {
    const { environment, read } = await makeEnvironment("2026-09-18T00:59:59.000Z");
    let releaseValidation!: (response: Response) => void;
    let markValidationStarted!: () => void;
    const validationStarted = new Promise<void>((resolve) => { markValidationStarted = resolve; });
    const validation = new Promise<Response>((resolve) => { releaseValidation = resolve; });
    const fetcher = vi.fn((url: string) => {
      if (url === "https://id.twitch.tv/oauth2/validate") {
        markValidationStarted();
        return validation;
      }
      return Promise.resolve(new Response(
        JSON.stringify({ access_token: "access-neu", refresh_token: "refresh-neu", expires_in: 7200, scope: [] }),
        { status: 200 },
      ));
    });
    vi.stubGlobal("fetch", fetcher);
    const maintenance = maintainLoginIdentities(environment, "2026-09-18T00:00:00.000Z");
    await validationStarted;
    await setLoginIdentityStatus(environment.DB, "user-1", "error", "temporary", "2026-09-18T00:00:01.000Z");
    releaseValidation(new Response(
      JSON.stringify({ user_id: "user-1", login: "tester", expires_in: 3599 }),
      { status: 200 },
    ));
    await maintenance;

    expect(read().expires_at).toBe("2026-09-18T02:00:00.000Z");
    expect(read().status).toBe("connected");
  });

  it("setzt den erfolgreichen Stand nicht auf revoked, wenn ein paralleler Lauf mit altem Token invalid_grant erhält", async () => {
    let markRotationCommitted!: () => void;
    const rotationCommitted = new Promise<void>((resolve) => { markRotationCommitted = resolve; });
    const { environment, read, readSessions, getInitialAccessTokenCiphertext } = await makeEnvironment(
      "2026-09-18T00:59:59.000Z",
      { onSuccessfulTokenWrite: markRotationCommitted },
    );
    let refreshCalls = 0;
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url === "https://id.twitch.tv/oauth2/validate") {
        return Promise.resolve(new Response(
          JSON.stringify({ user_id: "user-1", login: "tester", expires_in: 3599 }),
          { status: 200 },
        ));
      }
      refreshCalls += 1;
      if (refreshCalls === 1) {
        return Promise.resolve(new Response(JSON.stringify({ access_token: "access-neu", refresh_token: "refresh-neu", expires_in: 7200, scope: [] }), { status: 200 }));
      }
      return rotationCommitted.then(() => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    });
    vi.stubGlobal("fetch", fetcher);

    await Promise.all([
      maintainLoginIdentities(environment, "2026-09-18T00:00:00.000Z"),
      maintainLoginIdentities(environment, "2026-09-18T00:00:00.000Z"),
    ]);

    expect(refreshCalls).toBe(2);
    expect(read().access_token_ciphertext).not.toBe(getInitialAccessTokenCiphertext());
    expect(read().status).toBe("connected");
    expect(readSessions()[0]?.revoked_at).toBeNull();
  });

  it("setzt den Loginstand nach einem vor dem Speichern eintreffenden invalid_grant nicht dauerhaft auf revoked", async () => {
    let releaseTokenWrite!: () => void;
    let markTokenWriteStarted!: () => void;
    const tokenWriteStarted = new Promise<void>((resolve) => { markTokenWriteStarted = resolve; });
    const tokenWrite = new Promise<void>((resolve) => { releaseTokenWrite = resolve; });
    const { environment, read, readSessions, getInitialAccessTokenCiphertext } = await makeEnvironment(
      "2026-09-18T00:59:59.000Z",
      {
        beforeTokenWrite: async () => {
          markTokenWriteStarted();
          await tokenWrite;
        },
      },
    );
    let refreshCalls = 0;
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url === "https://id.twitch.tv/oauth2/validate") {
        return Promise.resolve(new Response(JSON.stringify({ user_id: "user-1", login: "tester", expires_in: 3599 }), { status: 200 }));
      }
      refreshCalls += 1;
      if (refreshCalls === 1) {
        return Promise.resolve(new Response(JSON.stringify({ access_token: "access-neu", refresh_token: "refresh-neu", expires_in: 7200, scope: [] }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }));
    });
    vi.stubGlobal("fetch", fetcher);

    const successfulRun = maintainLoginIdentities(environment, "2026-09-18T00:00:00.000Z");
    await tokenWriteStarted;
    await maintainLoginIdentities(environment, "2026-09-18T00:00:00.000Z");
    releaseTokenWrite();
    await successfulRun;

    expect(refreshCalls).toBe(2);
    expect(read().access_token_ciphertext).not.toBe(getInitialAccessTokenCiphertext());
    expect(read().status).toBe("connected");
    expect(readSessions()[0]?.revoked_at).toBeNull();
  });

  it("setzt revoked nicht durch eine bereits laufende erfolgreiche Rotation wieder auf connected", async () => {
    const { environment, read, readSessions } = await makeEnvironment("2026-09-18T00:59:59.000Z");
    let releaseRefresh!: (response: Response) => void;
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
    const refresh = new Promise<Response>((resolve) => { releaseRefresh = resolve; });
    const fetcher = vi.fn().mockImplementation((url: string) => {
      if (url === "https://id.twitch.tv/oauth2/validate") {
        return Promise.resolve(new Response(
          JSON.stringify({ user_id: "user-1", login: "tester", expires_in: 3599 }),
          { status: 200 },
        ));
      }
      markRefreshStarted();
      return refresh;
    });
    vi.stubGlobal("fetch", fetcher);
    const maintenance = maintainLoginIdentities(environment, "2026-09-18T00:00:00.000Z");
    await refreshStarted;
    await setLoginIdentityStatus(environment.DB, "user-1", "revoked", "authorization_revoked", "2026-09-18T00:00:01.000Z");
    releaseRefresh(new Response(
      JSON.stringify({ access_token: "access-neu", refresh_token: "refresh-neu", expires_in: 7200, scope: [] }),
      { status: 200 },
    ));
    await maintenance;

    expect(read().status).toBe("revoked");
    expect(readSessions()[0]?.revoked_at).toBeNull();
  });

  it("wartet nur Login-Identitäten mit mindestens einer aktiven Session", async () => {
    const database = new TestD1Database();
    try {
      const addIdentity = async (userId: string, status: "connected" | "revoked", withSession: boolean) => {
        const keys = parseKeyRing(keyRingSerialized);
        const access = await encryptJson({ token: `access-${userId}` }, keys);
        const refresh = await encryptJson({ token: `refresh-${userId}` }, keys);
        await database.prepare(
          `INSERT INTO twitch_login_identity
            (user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
             expires_at, status, reason, created_at, updated_at)
           VALUES (?, ?, '[]', ?, ?, ?, ?, NULL, ?, ?)`,
        ).bind(
          userId,
          userId,
          access,
          refresh,
          "2026-09-19T00:00:00.000Z",
          status,
          "2026-09-18T00:00:00.000Z",
          "2026-09-18T00:00:00.000Z",
        ).run();
        if (withSession) {
          await database.prepare(
            `INSERT INTO auth_sessions
              (session_id, user_id, login, expires_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
          ).bind(
            `session-${userId}`,
            userId,
            userId,
            "2026-09-19T00:00:00.000Z",
            "2026-09-18T00:00:00.000Z",
            "2026-09-18T00:00:00.000Z",
          ).run();
        }
      };

      await addIdentity("aktiv", "connected", true);
      await addIdentity("ohne-session", "connected", false);
      await addIdentity("widerrufen", "revoked", true);
      const fetcher = vi.fn().mockResolvedValue(new Response(
        JSON.stringify({ user_id: "aktiv", login: "aktiv", expires_in: 7200 }),
        { status: 200 },
      ));
      vi.stubGlobal("fetch", fetcher);

      await maintainLoginIdentities({
        DB: database as unknown as D1Database,
        TWITCH_CLIENT_ID: "client-id",
        TWITCH_CLIENT_SECRET: "client-secret",
        SESSION_ENCRYPTION_KEYS: keyRingSerialized,
      } as unknown as Env, "2026-09-18T00:00:00.000Z");

      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      database.close();
    }
  });

  it("begrenzt parallele Login-Wartung auf vier aktive Identitäten", async () => {
    const database = new TestD1Database();
    try {
      const keys = parseKeyRing(keyRingSerialized);
      for (let index = 0; index < 6; index += 1) {
        const userId = `aktiv-${String(index)}`;
        const access = await encryptJson({ token: `access-${userId}` }, keys);
        const refresh = await encryptJson({ token: `refresh-${userId}` }, keys);
        await database.prepare(
          `INSERT INTO twitch_login_identity
            (user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
             expires_at, status, reason, created_at, updated_at)
           VALUES (?, ?, '[]', ?, ?, ?, 'connected', NULL, ?, ?)`,
        ).bind(
          userId,
          userId,
          access,
          refresh,
          "2026-09-19T00:00:00.000Z",
          "2026-09-18T00:00:00.000Z",
          "2026-09-18T00:00:00.000Z",
        ).run();
        await database.prepare(
          `INSERT INTO auth_sessions
            (session_id, user_id, login, expires_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).bind(
          `session-${userId}`,
          userId,
          userId,
          "2026-09-19T00:00:00.000Z",
          "2026-09-18T00:00:00.000Z",
          "2026-09-18T00:00:00.000Z",
        ).run();
      }

      let active = 0;
      let maximum = 0;
      const fetcher = vi.fn().mockImplementation(async () => {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return new Response(JSON.stringify({ user_id: "aktiv", login: "aktiv", expires_in: 7200 }), { status: 200 });
      });
      vi.stubGlobal("fetch", fetcher);

      await maintainLoginIdentities({
        DB: database as unknown as D1Database,
        TWITCH_CLIENT_ID: "client-id",
        TWITCH_CLIENT_SECRET: "client-secret",
        SESSION_ENCRYPTION_KEYS: keyRingSerialized,
      } as unknown as Env, "2026-09-18T00:00:00.000Z");

      expect(fetcher).toHaveBeenCalledTimes(6);
      expect(maximum).toBeLessThanOrEqual(4);
      expect(maximum).toBeGreaterThan(1);
    } finally {
      database.close();
    }
  });
});
