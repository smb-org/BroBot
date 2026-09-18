import { describe, expect, it, vi } from "vitest";

import { authRouter, getSessionFromRequest } from "../../src/worker/auth/routes";
import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { TestD1Database } from "./test-d1";

const key = (byte: number): string =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const makeEnvironment = (firstResult: unknown = null) => {
  const statement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(firstResult),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
    all: vi.fn().mockResolvedValue({ results: [] }),
  };
  const environment = {
    DB: { prepare: vi.fn().mockReturnValue(statement) } as unknown as D1Database,
    TWITCH_CLIENT_ID: "client-id",
    TWITCH_CLIENT_SECRET: "client-secret",
    TWITCH_BOT_LOGIN: "brobot",
    TWITCH_EVENTSUB_SECRET: JSON.stringify({ active: { id: "eventsub-v1", key: key(3) }, retired: [] }),
    PUBLIC_ORIGIN: "https://brobot.example",
    SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
    SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
    OVERLAY_TOKEN_PEPPER: key(4),
  } as unknown as Env;
  return { environment, statement };
};

const fetchWith = (...responses: Response[]) => {
  const fetcher = vi.fn();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};

describe("Auth-Routen", () => {
  it("startet Login mit einem Twitch-Redirect und ohne Session-Cookie", async () => {
    const { environment } = makeEnvironment();
    const response = await authRouter.fetch(new Request("https://brobot.example/auth/login"), environment);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("https://id.twitch.tv/oauth2/authorize");
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("weist einen falschen State zurück", async () => {
    const { environment } = makeEnvironment();
    const response = await authRouter.fetch(
      new Request("https://brobot.example/auth/twitch/callback?state=manipuliert&code=code"),
      environment,
    );

    expect(response.status).toBe(400);
  });

  it("legt nach erfolgreichem Login eine serverseitige Session ohne Token im Cookie an", async () => {
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "login",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
    };
    const { environment, statement } = makeEnvironment(transaction);
    const login = await authRouter.fetch(new Request("https://brobot.example/auth/login"), environment);
    const loginUrl = new URL(login.headers.get("location") ?? "https://invalid");
    const fetcher = fetchWith(
      new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: ["user:read:moderated_channels"] }), { status: 200 }),
      new Response(JSON.stringify({ data: [{ id: "user-1", login: "tester" }] }), { status: 200 }),
    );
    const response = await authRouter.fetch(
      new Request(`https://brobot.example/auth/twitch/callback?state=${encodeURIComponent(loginUrl.searchParams.get("state") ?? "")}&code=code`),
      environment,
    );
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(302);
    expect(cookie).toContain("__Host-brobot_session=");
    expect(cookie).toContain("HttpOnly; Secure; SameSite=Lax");
    expect(cookie).not.toContain("access");
    expect(statement.bind.mock.calls.some((args: unknown[]) => args.includes("user-1") && args.includes("tester"))).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("legt bei der Betreiberautorisierung nur die globale Bot-Identität an", async () => {
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "bot",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
    };
    const { environment, statement } = makeEnvironment(transaction);
    const login = await authRouter.fetch(new Request("https://brobot.example/auth/bot/login"), environment);
    const loginUrl = new URL(login.headers.get("location") ?? "https://invalid");
    fetchWith(
      new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: ["user:bot"] }), { status: 200 }),
      new Response(JSON.stringify({ data: [{ id: "foreign-user", login: "someone-else" }] }), { status: 200 }),
    );

    const response = await authRouter.fetch(
      new Request(`https://brobot.example/auth/twitch/callback?state=${encodeURIComponent(loginUrl.searchParams.get("state") ?? "")}&code=code`),
      environment,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(statement.bind.mock.calls.some((args: unknown[]) => args.includes("foreign-user") || args.includes("someone-else"))).toBe(false);
    expect(statement.bind.mock.calls.some((args: unknown[]) => args[0] === "bot_identity_mismatch")).toBe(true);
  });

  it("akzeptiert den konfigurierten Bot-Login case-insensitiv", async () => {
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "bot",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
    };
    const { environment, statement } = makeEnvironment(transaction);
    const login = await authRouter.fetch(new Request("https://brobot.example/auth/bot/login"), environment);
    const loginUrl = new URL(login.headers.get("location") ?? "https://invalid");
    fetchWith(
      new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: ["user:bot"] }), { status: 200 }),
      new Response(JSON.stringify({ data: [{ id: "bot-user", login: "BROBOT" }] }), { status: 200 }),
    );

    const response = await authRouter.fetch(
      new Request(`https://brobot.example/auth/twitch/callback?state=${encodeURIComponent(loginUrl.searchParams.get("state") ?? "")}&code=code`),
      environment,
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(statement.bind.mock.calls.some((args: unknown[]) => args.includes("bot-user") && args.includes("BROBOT"))).toBe(true);
  });

  it("stellt einer gültigen Session ein gebundenes CSRF-Token aus", async () => {
    const { environment } = makeEnvironment({
      session_id: "session-1",
      user_id: "user-1",
      login: "tester",
      expires_at: "2099-09-19T00:00:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
      updated_at: "2099-09-18T00:00:00.000Z",
      revoked_at: null,
      revocation_reason: null,
    });
    const sessionCookie = await createSessionCookie(
      { sessionId: "session-1" },
      environment.SESSION_COOKIE_KEYS,
      environment.SESSION_ENCRYPTION_KEYS,
    );

    const response = await authRouter.fetch(
      new Request("https://brobot.example/api/csrf", {
        headers: { Cookie: `__Host-brobot_session=${sessionCookie}` },
      }),
      environment,
    );

    const body = await response.json<{ token: string }>();
    expect(response.status).toBe(200);
    expect(body.token).toBeTruthy();
    expect(response.headers.get("set-cookie")).toContain("__Host-brobot_csrf=");
    expect(response.headers.get("set-cookie")).not.toContain("HttpOnly");
  });

  it("weist einen schreibenden Logout ohne CSRF-Token zurück", async () => {
    const { environment } = makeEnvironment({
      session_id: "session-1",
      user_id: "user-1",
      login: "tester",
      expires_at: "2099-09-19T00:00:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
      updated_at: "2099-09-18T00:00:00.000Z",
      revoked_at: null,
      revocation_reason: null,
    });
    const sessionCookie = await createSessionCookie(
      { sessionId: "session-1" },
      environment.SESSION_COOKIE_KEYS,
      environment.SESSION_ENCRYPTION_KEYS,
    );

    const response = await authRouter.fetch(
      new Request("https://brobot.example/auth/logout", {
        method: "POST",
        headers: { Cookie: `__Host-brobot_session=${sessionCookie}` },
      }),
      environment,
    );

    expect(response.status).toBe(403);
  });

  it("beendet eine Session serverseitig und löscht das Cookie mit CSRF-Token", async () => {
    const { environment } = makeEnvironment({
      session_id: "session-1",
      user_id: "user-1",
      login: "tester",
      expires_at: "2099-09-19T00:00:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
      updated_at: "2099-09-18T00:00:00.000Z",
      revoked_at: null,
      revocation_reason: null,
    });
    const sessionCookie = await createSessionCookie(
      { sessionId: "session-1" },
      environment.SESSION_COOKIE_KEYS,
      environment.SESSION_ENCRYPTION_KEYS,
    );
    const csrfToken = await createCsrfToken(
      "session-1",
      environment.SESSION_COOKIE_KEYS,
      "2026-09-18T00:00:00.000Z",
    );

    const response = await authRouter.fetch(
      new Request("https://brobot.example/auth/logout", {
        method: "POST",
        headers: {
          Cookie: `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrfToken}`,
          "X-CSRF-Token": csrfToken,
        },
      }),
      environment,
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it.each([
    ["nicht parsebarer", "kein-datum"],
    ["tatsächlich abgelaufener", "2000-01-01T00:00:00.000Z"],
  ])("verwirft eine %s Session-Ablaufzeit aus der Datenbank", async (_description, expiresAt) => {
    const { environment } = makeEnvironment({
      session_id: "session-1",
      user_id: "user-1",
      login: "tester",
      expires_at: expiresAt,
      created_at: "2026-09-18T00:00:00.000Z",
      updated_at: "2026-09-18T00:00:00.000Z",
      revoked_at: null,
      revocation_reason: null,
    });
    const sessionCookie = await createSessionCookie(
      { sessionId: "session-1" },
      environment.SESSION_COOKIE_KEYS,
      environment.SESSION_ENCRYPTION_KEYS,
    );

    await expect(getSessionFromRequest(
      new Request("https://brobot.example/", {
        headers: { Cookie: `__Host-brobot_session=${sessionCookie}` },
      }),
      environment,
    )).resolves.toBeNull();
  });

  it("akzeptiert den CSRF-Token nach dem Logout nicht erneut", async () => {
    const { environment, statement } = makeEnvironment({
      session_id: "session-1",
      user_id: "user-1",
      login: "tester",
      expires_at: "2099-09-19T00:00:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
      updated_at: "2099-09-18T00:00:00.000Z",
      revoked_at: null,
      revocation_reason: null,
    });
    let revoked = false;
    statement.run.mockImplementation(() => {
      revoked = true;
      return { success: true, meta: { changes: 1 } };
    });
    statement.first.mockImplementation(() => revoked ? {
      session_id: "session-1",
      user_id: "user-1",
      login: "tester",
      expires_at: "2099-09-19T00:00:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
      updated_at: "2099-09-18T00:00:00.000Z",
      revoked_at: "2026-09-18T00:00:00.000Z",
      revocation_reason: "logout",
    } : {
      session_id: "session-1",
      user_id: "user-1",
      login: "tester",
      expires_at: "2099-09-19T00:00:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
      updated_at: "2099-09-18T00:00:00.000Z",
      revoked_at: null,
      revocation_reason: null,
    });
    const sessionCookie = await createSessionCookie(
      { sessionId: "session-1" },
      environment.SESSION_COOKIE_KEYS,
      environment.SESSION_ENCRYPTION_KEYS,
    );
    const csrfToken = await createCsrfToken(
      "session-1",
      environment.SESSION_COOKIE_KEYS,
      "2026-09-18T00:00:00.000Z",
    );
    const request = new Request("https://brobot.example/auth/logout", {
      method: "POST",
      headers: {
        Cookie: `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrfToken}`,
        "X-CSRF-Token": csrfToken,
      },
    });

    await expect(authRouter.fetch(request, environment)).resolves.toHaveProperty("status", 204);
    await expect(authRouter.fetch(request, environment)).resolves.toHaveProperty("status", 401);
  });

  it("liefert die Identität aus der D1-Session und nicht aus dem Cookie", async () => {
    const { environment } = makeEnvironment({
      session_id: "session-1",
      user_id: "db-user",
      login: "db-login",
      expires_at: "2099-09-19T00:00:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
      updated_at: "2099-09-18T00:00:00.000Z",
      revoked_at: null,
      revocation_reason: null,
    });
    const cookie = await createSessionCookie(
      {
        sessionId: "session-1",
        userId: "cookie-user",
        login: "cookie-login",
        expiresAt: "2099-09-19T00:00:00.000Z",
      } as { sessionId: string },
      environment.SESSION_COOKIE_KEYS,
      environment.SESSION_ENCRYPTION_KEYS,
    );

    await expect(getSessionFromRequest(
      new Request("https://brobot.example/", { headers: { Cookie: `__Host-brobot_session=${cookie}` } }),
      environment,
    )).resolves.toMatchObject({ userId: "db-user", login: "db-login" });
  });

  it("akzeptiert keine Session mit widerrufener Login-Identität über den echten SQLite-Join", async () => {
    const database = new TestD1Database();
    try {
      await database.prepare(
        `INSERT INTO twitch_login_identity
          (user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
           expires_at, status, reason, created_at, updated_at)
         VALUES (?, ?, '[]', 'access', 'refresh', ?, 'revoked', ?, ?, ?)`,
      ).bind(
        "user-1",
        "tester",
        "2099-09-19T00:00:00.000Z",
        "authorization_revoked",
        "2026-09-18T00:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
      ).run();
      await database.prepare(
        `INSERT INTO auth_sessions
          (session_id, user_id, login, expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        "session-1",
        "user-1",
        "tester",
        "2099-09-19T00:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
      ).run();
      const { environment } = makeEnvironment();
      environment.DB = database as unknown as D1Database;
      const cookie = await createSessionCookie(
        { sessionId: "session-1" },
        environment.SESSION_COOKIE_KEYS,
        environment.SESSION_ENCRYPTION_KEYS,
      );

      await expect(getSessionFromRequest(
        new Request("https://brobot.example/", {
          headers: { Cookie: `__Host-brobot_session=${cookie}` },
        }),
        environment,
      )).resolves.toBeNull();
    } finally {
      database.close();
    }
  });

  it("meldet einen abgelehnten Code-Tausch ohne Tokeninhalte", async () => {
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "login",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
    };
    const { environment, statement } = makeEnvironment(transaction);
    const login = await authRouter.fetch(new Request("https://brobot.example/auth/login"), environment);
    const state = new URL(login.headers.get("location") ?? "https://invalid").searchParams.get("state");
    fetchWith(new Response(JSON.stringify({ error: "access_denied" }), { status: 400 }));
    const response = await authRouter.fetch(
      new Request(`https://brobot.example/auth/twitch/callback?state=${encodeURIComponent(state ?? "")}&code=code`),
      environment,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("access");
    expect(statement.bind.mock.calls.some((args: unknown[]) => args.includes("code_exchange_rejected"))).toBe(true);
  });
});
