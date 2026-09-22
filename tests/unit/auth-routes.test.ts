import { beforeEach, describe, expect, it, vi } from "vitest";

import { authRouter, getSessionFromRequest } from "../../src/worker/auth/routes";
import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { LOGIN_SCOPES } from "../../src/worker/auth/oauth";
import { maintainBotIdentity } from "../../src/worker/bot-maintenance";
import { maintainEventSubSubscriptions } from "../../src/worker/eventsub-subscriptions";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";
import { listAllBroadcasterScopes } from "../../src/worker/module-scopes";

vi.mock("../../src/worker/bot-maintenance", () => ({
  maintainBotIdentity: vi.fn(),
}));

vi.mock("../../src/worker/eventsub-subscriptions", () => ({
  maintainEventSubSubscriptions: vi.fn(),
}));

const mockedMaintainBotIdentity = vi.mocked(maintainBotIdentity);
const mockedMaintainEventSubSubscriptions = vi.mocked(maintainEventSubSubscriptions);

/**
 * A CSRF token for the current moment. A fixed date would be a time bomb:
 * the routes under test use the real clock, so the token would expire seven
 * days later and the test would go red without anyone having changed
 * anything. csrf.test.ts tests the expiry itself with explicitly passed
 * timestamps.
 */
const freshTimestamp = (): string => new Date().toISOString();

const key = (byte: number): string =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const PLATFORM_USER_ID = "4711";

const sessionRowFor = (userId: string, login = userId) => ({
  session_id: `session-${userId}`,
  user_id: userId,
  login,
  expires_at: "2099-09-19T00:00:00.000Z",
  created_at: "2026-09-18T00:00:00.000Z",
  updated_at: "2026-09-18T00:00:00.000Z",
  revoked_at: null,
  revocation_reason: null,
});

/**
 * `sessionRow` specifically answers the session query, `botIdentityRow` the
 * bot identity query; all other queries return `firstResult`. Without this
 * separation, the same row would come back as both the session AND the bot
 * identity, which tests against a mock artifact instead of actual behavior.
 * Rows that aren't set fall back to `firstResult`, so existing tests keep
 * running unchanged.
 */
const makeEnvironment = (
  firstResult: unknown = null,
  sessionRow?: unknown,
  botIdentityRow: unknown = null,
) => {
  let lastSql = "";
  const statement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockImplementation(() => {
      if (lastSql.includes("FROM auth_sessions")) {
        return Promise.resolve(sessionRow === undefined ? firstResult : sessionRow);
      }
      if (lastSql.includes("FROM bot_identity")) return Promise.resolve(botIdentityRow);
      return Promise.resolve(firstResult);
    }),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
    all: vi.fn().mockResolvedValue({ results: [] }),
  };
  const environment = {
    DB: {
      prepare: vi.fn().mockImplementation((sql: string) => {
        lastSql = sql;
        return statement;
      }),
      batch: vi.fn(async (statements: D1PreparedStatement[]) => Promise.all(
        statements.map((batchStatement) => batchStatement.run()),
      )),
    } as unknown as D1Database,
    TWITCH_CLIENT_ID: "client-id",
    TWITCH_CLIENT_SECRET: "client-secret",
    TWITCH_BOT_LOGIN: "brobot",
    TWITCH_EVENTSUB_SECRET: JSON.stringify({ active: { id: "eventsub-v1", key: key(3) }, retired: [] }),
    PUBLIC_ORIGIN: "https://brobot.example",
    SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
    SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
    OVERLAY_TOKEN_PEPPER: key(4),
    // The bot connection is platform level. The id must be numeric: the
    // parser rejects anything else, so a readable name would silently fail.
    PLATFORM_USER_IDS: JSON.stringify([PLATFORM_USER_ID]),
  } as unknown as Env & { SESSION_ENCRYPTION_KEYS: string };
  return { environment, statement };
};

/** Reads the nonce from the state cookie that the login start set. */
const stateNonceFrom = (response: Response): string => {
  const cookie = response.headers.get("set-cookie") ?? "";
  return /__Host-brobot_oauth_state=([^;]*)/.exec(cookie)?.[1] ?? "";
};

/** Builds the callback together with the state cookie, the way the browser that started the flow would send it. */
const callbackRequest = (login: Response, query = "&code=code"): Request => {
  const loginUrl = new URL(login.headers.get("location") ?? "https://invalid");
  const state = encodeURIComponent(loginUrl.searchParams.get("state") ?? "");
  return new Request(`https://brobot.example/auth/twitch/callback?state=${state}${query}`, {
    headers: { Cookie: `__Host-brobot_oauth_state=${stateNonceFrom(login)}` },
  });
};

const sessionCookieHeaderFor = async (userId: string): Promise<string> => {
  const cookie = await createSessionCookie(
    { sessionId: `session-${userId}` },
    JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
    JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
  );
  return `__Host-brobot_session=${cookie}`;
};

const csrfTokenFrom = async (response: Response): Promise<string> => {
  const body: unknown = await response.json();
  if (body === null || typeof body !== "object" || !("token" in body) ||
      typeof body.token !== "string") {
    throw new Error("Antwort enthält kein CSRF-Token.");
  }
  return body.token;
};

const fetchWith = (...responses: Response[]) => {
  const fetcher = vi.fn();
  for (const response of responses) fetcher.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
};

const environmentForDatabase = (database: TestD1Database) => {
  const { environment } = makeEnvironment();
  environment.DB = database as unknown as D1Database;
  return environment;
};

const setFullConsent = async (database: TestD1Database, channelId: string): Promise<void> => {
  await database.prepare(
    "UPDATE channels SET full_consent = 1 WHERE channel_id = ?",
  ).bind(channelId).run();
};

const tokenResponse = (scopes: readonly string[]): Response => new Response(
  JSON.stringify({
    access_token: "access",
    refresh_token: "refresh",
    expires_in: 3600,
    scope: scopes,
  }),
  { status: 200 },
);

const identityResponse = (userId: string, login: string): Response => new Response(
  JSON.stringify({ data: [{ id: userId, login }] }),
  { status: 200 },
);

const countRows = async (database: TestD1Database, tabelle: string): Promise<number> => {
  const zeile = await database.prepare(`SELECT COUNT(*) AS count FROM ${tabelle}`).first<{ count: number }>();
  return zeile?.count ?? 0;
};

describe("auth routes", () => {
  beforeEach(() => {
    mockedMaintainBotIdentity.mockReset();
    mockedMaintainEventSubSubscriptions.mockReset();
  });

  it("starts login with a Twitch redirect and binds the state to the browser", async () => {
    const { environment } = makeEnvironment();
    const response = await authRouter.fetch(new Request("https://brobot.example/auth/login"), environment);
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("https://id.twitch.tv/oauth2/authorize");
    // No session cookie — the login isn't complete yet.
    expect(cookie).not.toContain("__Host-brobot_session=");
    expect(cookie).toContain("__Host-brobot_oauth_state=");
    expect(cookie).toContain("HttpOnly; Secure; SameSite=Lax");
    expect(stateNonceFrom(response).length).toBeGreaterThan(0);
    expect(new URL(response.headers.get("location") ?? "https://invalid").searchParams.get("force_verify")).toBeNull();
  });

  it("forces Twitch account selection for switch login and keeps the root return path", async () => {
    const { environment, statement } = makeEnvironment();
    const response = await authRouter.fetch(
      new Request("https://brobot.example/auth/login?switch=1&returnTo=%2F"),
      environment,
    );
    const authorizeUrl = new URL(response.headers.get("location") ?? "https://invalid");

    expect(response.status).toBe(302);
    expect(authorizeUrl.searchParams.get("force_verify")).toBe("true");
    expect(statement.bind.mock.calls.some((args: unknown[]) => args.includes("/"))).toBe(true);
  });

  it("gives a flagged channel the full scope via the invite link", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-voll");
      await setFullConsent(database, "kanal-voll");
      const environment = environmentForDatabase(database);

      const response = await authRouter.fetch(
        new Request("https://brobot.example/auth/login?channel=KANAL-VOLL"),
        environment,
      );
      const umfang = new URL(response.headers.get("location") ?? "https://ungültig").searchParams
        .get("scope")?.split(" ");

      expect(response.status).toBe(302);
      expect(umfang).toEqual(listAllBroadcasterScopes());
    } finally {
      database.close();
    }
  });

  it("gives an unflagged channel only the previous login scope via the invite link", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-normal");
      const environment = environmentForDatabase(database);

      const response = await authRouter.fetch(
        new Request("https://brobot.example/auth/login?channel=kanal-normal"),
        environment,
      );
      const umfang = new URL(response.headers.get("location") ?? "https://ungültig").searchParams
        .get("scope")?.split(" ");

      expect(response.status).toBe(302);
      expect(umfang).toEqual([...LOGIN_SCOPES]);
    } finally {
      database.close();
    }
  });

  it("ignores an unknown invite-link channel entirely", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-voll");
      await setFullConsent(database, "kanal-voll");
      const environment = environmentForDatabase(database);
      const erfundenerLogin = "kanal-voll-aber-erfunden";

      const response = await authRouter.fetch(
        new Request(`https://brobot.example/auth/login?channel=${erfundenerLogin}`),
        environment,
      );
      const url = new URL(response.headers.get("location") ?? "https://ungültig");

      expect(response.status).toBe(302);
      expect(url.searchParams.get("scope")?.split(" ")).toEqual([...LOGIN_SCOPES]);
      expect(url.toString()).not.toContain(erfundenerLogin);
    } finally {
      database.close();
    }
  });

  it("stores neither identity nor session on an incomplete token and starts the second attempt", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-voll");
      await setFullConsent(database, "kanal-voll");
      const environment = environmentForDatabase(database);
      const login = await authRouter.fetch(
        new Request("https://brobot.example/auth/login"),
        environment,
      );
      const fetcher = fetchWith(
        tokenResponse(LOGIN_SCOPES),
        identityResponse("kanal-voll", "kanal-voll"),
      );

      const response = await authRouter.fetch(callbackRequest(login), environment);
      const zweiteUrl = new URL(response.headers.get("location") ?? "https://ungültig");

      expect(response.status).toBe(302);
      expect(zweiteUrl.searchParams.get("scope")?.split(" ")).toEqual(listAllBroadcasterScopes());
      expect(await countRows(database, "twitch_login_identity")).toBe(0);
      expect(await countRows(database, "auth_sessions")).toBe(0);
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      database.close();
    }
  });

  it("ends the second incomplete callback with 403 instead of looping", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-voll");
      await setFullConsent(database, "kanal-voll");
      const environment = environmentForDatabase(database);
      const login = await authRouter.fetch(
        new Request("https://brobot.example/auth/login"),
        environment,
      );
      const fetcher = fetchWith(
        tokenResponse(LOGIN_SCOPES),
        identityResponse("kanal-voll", "kanal-voll"),
        tokenResponse(LOGIN_SCOPES),
        identityResponse("kanal-voll", "kanal-voll"),
      );

      const firstResponse = await authRouter.fetch(callbackRequest(login), environment);
      const secondResponse = await authRouter.fetch(callbackRequest(firstResponse), environment);

      expect(secondResponse.status).toBe(403);
      await expect(secondResponse.text()).resolves.toContain("vollständige Zustimmung");
      expect(await countRows(database, "twitch_login_identity")).toBe(0);
      expect(await countRows(database, "auth_sessions")).toBe(0);
      await expect(database.prepare(
        "SELECT failure_reason FROM oauth_transactions WHERE failure_reason = ?",
      ).bind("full_consent_second_attempt_incomplete").all()).resolves.toMatchObject({
        results: [{ failure_reason: "full_consent_second_attempt_incomplete" }],
      });
      expect(fetcher).toHaveBeenCalledTimes(4);
    } finally {
      database.close();
    }
  });

  it("creates a complete token without a second redirect", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-voll");
      await setFullConsent(database, "kanal-voll");
      const environment = environmentForDatabase(database);
      const login = await authRouter.fetch(
        new Request("https://brobot.example/auth/login?channel=kanal-voll"),
        environment,
      );
      const fetcher = fetchWith(
        tokenResponse(listAllBroadcasterScopes()),
        identityResponse("kanal-voll", "kanal-voll"),
      );

      const response = await authRouter.fetch(callbackRequest(login), environment);

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("https://brobot.example/");
      expect(await countRows(database, "twitch_login_identity")).toBe(1);
      expect(await countRows(database, "auth_sessions")).toBe(1);
      expect(fetcher).toHaveBeenCalledTimes(2);
    } finally {
      database.close();
    }
  });

  it("rejects an incorrect state", async () => {
    const { environment } = makeEnvironment();
    const response = await authRouter.fetch(
      new Request("https://brobot.example/auth/twitch/callback?state=manipuliert&code=code"),
      environment,
    );

    expect(response.status).toBe(400);
  });

  it("creates a server-side session without a token in the cookie after a successful login", async () => {
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "login",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
    };
    const { environment, statement } = makeEnvironment(transaction);
    const login = await authRouter.fetch(new Request("https://brobot.example/auth/login"), environment);
    const fetcher = fetchWith(
      new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: ["user:read:moderated_channels"] }), { status: 200 }),
      new Response(JSON.stringify({ data: [{ id: "user-1", login: "tester" }] }), { status: 200 }),
    );
    const response = await authRouter.fetch(
      callbackRequest(login),
      environment,
    );
    const cookie = response.headers.get("set-cookie") ?? "";

    expect(response.status).toBe(302);
    expect(cookie).toContain("__Host-brobot_session=");
    expect(cookie).toContain("HttpOnly; Secure; SameSite=Lax");
    expect(cookie).not.toContain("access");
    expect(statement.bind.mock.calls.some((args: unknown[]) => args.includes("user-1") && args.includes("tester"))).toBe(true);
    expect(statement.bind.mock.calls.some((args: unknown[]) =>
      args[0] === "user-1" && args[2] === JSON.stringify(["user:read:moderated_channels"]))).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("follows a server-stored module return path", async () => {
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "login",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
      redirect_path: "/channels/kanal-a/modules/ads",
    };
    const { environment } = makeEnvironment(transaction);
    const login = await authRouter.fetch(new Request("https://brobot.example/auth/login"), environment);
    fetchWith(
      new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: [] }), { status: 200 }),
      new Response(JSON.stringify({ data: [{ id: "user-1", login: "tester" }] }), { status: 200 }),
    );

    const response = await authRouter.fetch(callbackRequest(login), environment);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://brobot.example/channels/kanal-a/modules/ads");
  });

  it("ignores a stored return target that isn't a simple path", async () => {
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "login",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
      redirect_path: "https://angreifer.example/weiter",
    };
    const { environment } = makeEnvironment(transaction);
    const login = await authRouter.fetch(new Request("https://brobot.example/auth/login"), environment);
    fetchWith(
      new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: [] }), { status: 200 }),
      new Response(JSON.stringify({ data: [{ id: "user-1", login: "tester" }] }), { status: 200 }),
    );

    const response = await authRouter.fetch(callbackRequest(login), environment);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://brobot.example/");
  });

  it("creates only the global bot identity during bot account authorization", async () => {
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "bot",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
    };
    const { environment, statement } = makeEnvironment(transaction, sessionRowFor("bot-user", "brobot"));
    const login = await authRouter.fetch(
      new Request("https://brobot.example/auth/bot/login", {
        headers: { Cookie: await sessionCookieHeaderFor("bot-user") },
      }),
      environment,
    );
    fetchWith(
      new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: ["user:bot"] }), { status: 200 }),
      new Response(JSON.stringify({ data: [{ id: "foreign-user", login: "someone-else" }] }), { status: 200 }),
    );

    const response = await authRouter.fetch(
      callbackRequest(login),
      environment,
    );

    expect(response.status).toBe(403);
    // The consumed state cookie gets cleared; no session is created.
    expect(response.headers.get("set-cookie") ?? "").not.toContain("__Host-brobot_session=");
    expect(statement.bind.mock.calls.some((args: unknown[]) => args.includes("foreign-user") || args.includes("someone-else"))).toBe(false);
    expect(statement.bind.mock.calls.some((args: unknown[]) => args[0] === "bot_identity_mismatch")).toBe(true);
    expect(mockedMaintainBotIdentity).not.toHaveBeenCalled();
    expect(mockedMaintainEventSubSubscriptions).not.toHaveBeenCalled();
  });

  it("accepts the configured bot login case-insensitively", async () => {
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "bot",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
    };
    const { environment, statement } = makeEnvironment(transaction, sessionRowFor("bot-user", "BROBOT"));
    const login = await authRouter.fetch(
      new Request("https://brobot.example/auth/bot/login", {
        headers: { Cookie: await sessionCookieHeaderFor("bot-user") },
      }),
      environment,
    );
    fetchWith(
      new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: ["user:bot"] }), { status: 200 }),
      new Response(JSON.stringify({ data: [{ id: "bot-user", login: "BROBOT" }] }), { status: 200 }),
    );

    const response = await authRouter.fetch(
      callbackRequest(login),
      environment,
    );

    expect(response.status).toBe(302);
    // Bot authorization doesn't create a login session.
    expect(response.headers.get("set-cookie") ?? "").not.toContain("__Host-brobot_session=");
    expect(statement.bind.mock.calls.some((args: unknown[]) => args.includes("bot-user") && args.includes("BROBOT"))).toBe(true);
  });

  it("kicks off both global maintenance runs sequentially after successful bot authorization", async () => {
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "bot",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
    };
    const { environment, statement } = makeEnvironment(transaction, sessionRowFor("bot-user", "brobot"));
    const login = await authRouter.fetch(
      new Request("https://brobot.example/auth/bot/login", {
        headers: { Cookie: await sessionCookieHeaderFor("bot-user") },
      }),
      environment,
    );
    fetchWith(
      new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: ["user:bot"] }), { status: 200 }),
      new Response(JSON.stringify({ data: [{ id: "bot-user", login: "brobot" }] }), { status: 200 }),
    );
    const order: string[] = [];
    mockedMaintainBotIdentity.mockImplementation(() => {
      order.push("identity");
      return Promise.resolve();
    });
    mockedMaintainEventSubSubscriptions.mockImplementation(() => {
      order.push("eventsub");
      return Promise.resolve();
    });
    const waitUntil = vi.fn();

    const response = await authRouter.fetch(
      callbackRequest(login),
      environment,
      { waitUntil } as unknown as ExecutionContext,
    );
    const maintenance = waitUntil.mock.calls[0]?.[0] as Promise<void> | undefined;
    expect(response.status).toBe(302);
    expect(maintenance).toBeDefined();
    await maintenance;

    expect(order).toEqual(["identity", "eventsub"]);
    expect(mockedMaintainBotIdentity).toHaveBeenCalledWith(environment, expect.any(String));
    expect(mockedMaintainEventSubSubscriptions).toHaveBeenCalledWith(environment, expect.any(String));
    expect(mockedMaintainEventSubSubscriptions.mock.calls[0]).toHaveLength(2);
    expect(statement.bind.mock.calls.some((args: unknown[]) => args.includes("bot-user") && args.includes("brobot"))).toBe(true);
  });

  it("doesn't wait for maintenance during the redirect", async () => {
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "bot",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
    };
    const { environment } = makeEnvironment(transaction, sessionRowFor("bot-user", "brobot"));
    const login = await authRouter.fetch(
      new Request("https://brobot.example/auth/bot/login", {
        headers: { Cookie: await sessionCookieHeaderFor("bot-user") },
      }),
      environment,
    );
    fetchWith(
      new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: ["user:bot"] }), { status: 200 }),
      new Response(JSON.stringify({ data: [{ id: "bot-user", login: "brobot" }] }), { status: 200 }),
    );
    let releaseIdentity: (() => void) | undefined;
    const identityPending = new Promise<void>((resolve) => {
      releaseIdentity = resolve;
    });
    mockedMaintainBotIdentity.mockReturnValue(identityPending);
    const waitUntil = vi.fn();

    const response = await authRouter.fetch(
      callbackRequest(login),
      environment,
      { waitUntil } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(302);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(mockedMaintainBotIdentity).toHaveBeenCalledTimes(1);
    expect(mockedMaintainEventSubSubscriptions).not.toHaveBeenCalled();

    releaseIdentity?.();
    const maintenance = waitUntil.mock.calls[0]?.[0] as Promise<void> | undefined;
    await maintenance;
    expect(mockedMaintainEventSubSubscriptions).toHaveBeenCalledTimes(1);
  });

  it.each(["Bot-Identität", "EventSub-Abos"])(
    "keeps the redirect and the stored identity valid when the %s run fails",
    async (failedRun) => {
      const transaction = {
        transaction_id: "transaction-1",
        purpose: "bot",
        expires_at: "2099-09-18T00:05:00.000Z",
        created_at: "2099-09-18T00:00:00.000Z",
      };
      const { environment, statement } = makeEnvironment(transaction, sessionRowFor("bot-user", "brobot"));
      const login = await authRouter.fetch(
        new Request("https://brobot.example/auth/bot/login", {
          headers: { Cookie: await sessionCookieHeaderFor("bot-user") },
        }),
        environment,
      );
      fetchWith(
        new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: ["user:bot"] }), { status: 200 }),
        new Response(JSON.stringify({ data: [{ id: "bot-user", login: "brobot" }] }), { status: 200 }),
      );
      if (failedRun === "Bot-Identität") {
        mockedMaintainBotIdentity.mockRejectedValueOnce(new Error("identity failed"));
      } else {
        mockedMaintainEventSubSubscriptions.mockRejectedValueOnce(new Error("eventsub failed"));
      }
      const waitUntil = vi.fn();

      const response = await authRouter.fetch(
        callbackRequest(login),
        environment,
        { waitUntil } as unknown as ExecutionContext,
      );
      const maintenance = waitUntil.mock.calls[0]?.[0] as Promise<void> | undefined;
      await maintenance;

      expect(response.status).toBe(302);
      expect(statement.bind.mock.calls.some((args: unknown[]) => args.includes("bot-user") && args.includes("brobot"))).toBe(true);
      expect(mockedMaintainBotIdentity).toHaveBeenCalledTimes(1);
      expect(mockedMaintainEventSubSubscriptions).toHaveBeenCalledTimes(1);
    },
  );

  it("doesn't kick off bot maintenance on the login return path", async () => {
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "login",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
    };
    const { environment } = makeEnvironment(transaction);
    const login = await authRouter.fetch(new Request("https://brobot.example/auth/login"), environment);
    fetchWith(
      new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: [] }), { status: 200 }),
      new Response(JSON.stringify({ data: [{ id: "user-1", login: "tester" }] }), { status: 200 }),
    );

    const response = await authRouter.fetch(callbackRequest(login), environment);

    expect(response.status).toBe(302);
    expect(mockedMaintainBotIdentity).not.toHaveBeenCalled();
    expect(mockedMaintainEventSubSubscriptions).not.toHaveBeenCalled();
  });

  it("issues a bound CSRF token for a valid session", async () => {
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

  it("rejects a mutating logout without a CSRF token", async () => {
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

  it("ends a session server-side and clears the cookie, with a CSRF token", async () => {
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
      freshTimestamp(),
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
  ])("rejects a %s session expiry from the database", async (_description, expiresAt) => {
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

  it("doesn't accept the CSRF token again after logout", async () => {
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
      freshTimestamp(),
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

  it("returns the identity from the D1 session, not from the cookie", async () => {
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

  it("doesn't accept a session with a revoked login identity, via the real SQLite join", async () => {
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

  it("reports a rejected code exchange without token contents", async () => {
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "login",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
    };
    const { environment, statement } = makeEnvironment(transaction);
    const login = await authRouter.fetch(new Request("https://brobot.example/auth/login"), environment);
    fetchWith(new Response(JSON.stringify({ error: "access_denied" }), { status: 400 }));
    const response = await authRouter.fetch(
      callbackRequest(login),
      environment,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("access");
    expect(statement.bind.mock.calls.some((args: unknown[]) => args.includes("code_exchange_rejected"))).toBe(true);
  });

  it("logs no one in when the callback is called without a state cookie", async () => {
    // Reenacted: the attacker starts the login for their own account, intercepts
    // the unused callback URL, and gets the victim to open it. Without the
    // browser binding, the victim would then be logged in as the attacker.
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "login",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
    };
    const { environment } = makeEnvironment(transaction);
    const login = await authRouter.fetch(new Request("https://brobot.example/auth/login"), environment);
    const loginUrl = new URL(login.headers.get("location") ?? "https://invalid");
    const fetcher = fetchWith(
      new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: [] }), { status: 200 }),
      new Response(JSON.stringify({ data: [{ id: "angreifer", login: "angreifer" }] }), { status: 200 }),
    );

    const response = await authRouter.fetch(
      new Request(
        `https://brobot.example/auth/twitch/callback?state=${encodeURIComponent(loginUrl.searchParams.get("state") ?? "")}&code=code`,
      ),
      environment,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie") ?? "").not.toContain("__Host-brobot_session=");
    // The code never even gets redeemed.
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("logs no one in when the state cookie comes from a different login", async () => {
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "login",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
    };
    const { environment } = makeEnvironment(transaction);
    const angreiferLogin = await authRouter.fetch(new Request("https://brobot.example/auth/login"), environment);
    const opferLogin = await authRouter.fetch(new Request("https://brobot.example/auth/login"), environment);
    const angreiferUrl = new URL(angreiferLogin.headers.get("location") ?? "https://invalid");
    const fetcher = fetchWith(
      new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: [] }), { status: 200 }),
      new Response(JSON.stringify({ data: [{ id: "angreifer", login: "angreifer" }] }), { status: 200 }),
    );

    const response = await authRouter.fetch(
      new Request(
        `https://brobot.example/auth/twitch/callback?state=${encodeURIComponent(angreiferUrl.searchParams.get("state") ?? "")}&code=code`,
        { headers: { Cookie: `__Host-brobot_oauth_state=${stateNonceFrom(opferLogin)}` } },
      ),
      environment,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("set-cookie") ?? "").not.toContain("__Host-brobot_session=");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("redirects an unauthenticated browser to sign-in with a return path for the bot connection", async () => {
    // Otherwise anyone unauthenticated could decide which Twitch account the bot uses.
    const { environment, statement } = makeEnvironment();
    const response = await authRouter.fetch(
      new Request("https://brobot.example/auth/bot/login"),
      environment,
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "/", "https://brobot.example");
    expect(location.pathname).toBe("/auth/login");
    expect(location.searchParams.get("returnTo")).toBe("/auth/bot/login");
    await authRouter.fetch(new Request(`https://brobot.example${location.pathname}${location.search}`), environment);
    expect(statement.bind.mock.calls.some((args: unknown[]) => args.includes("/auth/bot/login"))).toBe(true);
  });

  it.each([
    "/auth/channels/kanal-a/channel-bot?source=dashboard",
    "/auth/channels/kanal-a/broadcaster-scopes/ads",
  ])("redirects an unauthenticated browser to sign-in from %s", async (path) => {
    const { environment } = makeEnvironment();
    const response = await authRouter.fetch(new Request(`https://brobot.example${path}`), environment);

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "/", "https://brobot.example");
    expect(location.pathname).toBe("/auth/login");
    expect(location.searchParams.get("returnTo")).toBe(path);
  });

  it("renders a localized 403 page when a signed-in viewer cannot start bot authorization", async () => {
    const { environment } = makeEnvironment(null, sessionRowFor(PLATFORM_USER_ID));
    const response = await authRouter.fetch(
      new Request("https://brobot.example/auth/bot/login", {
        headers: { Cookie: await sessionCookieHeaderFor(PLATFORM_USER_ID), "Accept-Language": "en-US,en;q=0.9" },
      }),
      environment,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("text/plain");
    await expect(response.text()).resolves.toContain("Only the bot account can connect itself.");
  });

  it("refuses bot authorization for another signed-in Twitch account", async () => {
    const { environment } = makeEnvironment(null, sessionRowFor("user-1", "viewer"));
    const response = await authRouter.fetch(
      new Request("https://brobot.example/auth/bot/login", {
        headers: { Cookie: await sessionCookieHeaderFor("user-1") },
      }),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain("Nur das Bot-Konto darf sich selbst verbinden.");
  });

  it("allows the bot account to start authorization with a case-insensitive login match", async () => {
    const { environment } = makeEnvironment(null, sessionRowFor("bot-user", "BrObOt"));
    const response = await authRouter.fetch(
      new Request("https://brobot.example/auth/bot/login", {
        headers: { Cookie: await sessionCookieHeaderFor("bot-user") },
      }),
      environment,
    );
    const authorizeUrl = new URL(response.headers.get("location") ?? "https://invalid");

    expect(response.status).toBe(302);
    expect(authorizeUrl.hostname).toBe("id.twitch.tv");
    expect(authorizeUrl.searchParams.get("scope")?.split(" ")).toContain("user:bot");
  });

  it("refuses the configured bot login when its signed-in user ID differs from the stored identity", async () => {
    const existingBotIdentity = {
      id: 1,
      user_id: "stored-bot-user",
      login: "brobot",
      scopes_json: "[]",
      access_token_ciphertext: "access",
      refresh_token_ciphertext: "refresh",
      expires_at: "2099-09-19T00:00:00.000Z",
      created_at: "2026-09-18T00:00:00.000Z",
      updated_at: "2026-09-18T00:00:00.000Z",
    };
    const { environment } = makeEnvironment(null, sessionRowFor("different-user", "brobot"), existingBotIdentity);
    const response = await authRouter.fetch(
      new Request("https://brobot.example/auth/bot/login", {
        headers: { Cookie: await sessionCookieHeaderFor("different-user") },
      }),
      environment,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
    await expect(response.text()).resolves.toContain("Nur das Bot-Konto darf sich selbst verbinden.");
  });

  it("doesn't let a manager start the channel:bot consent on behalf of the broadcaster", async () => {
    const { environment } = makeEnvironment(
      { role: "manager" },
      sessionRowFor("verwalter"),
    );
    const response = await authRouter.fetch(
      new Request("https://brobot.example/auth/channels/kanal-a/channel-bot", {
        headers: { Cookie: await sessionCookieHeaderFor("verwalter"), "Accept-Language": "en-US" },
      }),
      environment,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
    await expect(response.text()).resolves.toContain("Only the channel owner can re-request this consent.");
  });

  it("starts the channel:bot follow-up request for the channel's broadcaster", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertLoginIdentityAndSession(database, "kanal-a");
      await insertMember(database, "kanal-a", "kanal-a", "broadcaster");
      const { environment } = makeEnvironment();
      environment.DB = database as unknown as D1Database;

      const response = await authRouter.fetch(
        new Request("https://brobot.example/auth/channels/kanal-a/channel-bot", {
          headers: { Cookie: await sessionCookieHeaderFor("kanal-a") },
        }),
        environment,
      );

      expect(response.status).toBe(302);
      expect(new URL(response.headers.get("location") ?? "https://invalid").searchParams.get("scope"))
        .toContain("channel:bot");
    } finally {
      database.close();
    }
  });

  it("discards the callback with a different channel-owner identity without storing anything", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertLoginIdentityAndSession(database, "kanal-a");
      await insertMember(database, "kanal-a", "kanal-a", "broadcaster");
      const environment = environmentForDatabase(database);

      const login = await authRouter.fetch(
        new Request("https://brobot.example/auth/channels/kanal-a/broadcaster-scopes/ads", {
          headers: { Cookie: await sessionCookieHeaderFor("kanal-a") },
        }),
        environment,
      );
      expect(login.status).toBe(302);
      await expect(database.prepare(
        "SELECT expected_user_id FROM oauth_transactions",
      ).first()).resolves.toEqual({ expected_user_id: "kanal-a" });

      fetchWith(tokenResponse(LOGIN_SCOPES), identityResponse("fremdes-konto", "fremdes-konto"));
      const response = await authRouter.fetch(callbackRequest(login), environment);

      expect(response.status).toBe(403);
      await expect(response.text()).resolves.toContain("Kanalinhaber");
      await expect(database.prepare(
        "SELECT user_id FROM twitch_login_identity ORDER BY user_id",
      ).all()).resolves.toMatchObject({ results: [{ user_id: "kanal-a" }] });
      await expect(database.prepare(
        "SELECT failure_reason FROM oauth_transactions WHERE transaction_id = (SELECT transaction_id FROM oauth_transactions LIMIT 1)",
      ).first()).resolves.toEqual({ failure_reason: "login_identity_user_mismatch" });
    } finally {
      database.close();
    }
  });

  it("doesn't adopt a bot identity with a differing Twitch user ID", async () => {
    // Logins can be changed and reassigned. If the bot account gets renamed
    // and someone registers the name that became free, they must not be able
    // to take over the bot identity — otherwise the bot would post in every
    // channel from a stranger's account.
    const transaction = {
      transaction_id: "transaction-1",
      purpose: "bot",
      expires_at: "2099-09-18T00:05:00.000Z",
      created_at: "2099-09-18T00:00:00.000Z",
    };
    const { environment, statement } = makeEnvironment(
      transaction,
      sessionRowFor("echter-bot", "brobot"),
      {
        id: 1,
        user_id: "echter-bot",
        login: "brobot",
        scopes_json: "[]",
        access_token_ciphertext: "access",
        refresh_token_ciphertext: "refresh",
        expires_at: "2099-09-19T00:00:00.000Z",
        created_at: "2026-09-18T00:00:00.000Z",
        updated_at: "2026-09-18T00:00:00.000Z",
      },
    );
    const login = await authRouter.fetch(
      new Request("https://brobot.example/auth/bot/login", {
        headers: { Cookie: await sessionCookieHeaderFor("echter-bot") },
      }),
      environment,
    );
    fetchWith(
      new Response(JSON.stringify({ access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: ["user:bot"] }), { status: 200 }),
      // Same login, different user ID: the name was reassigned.
      new Response(JSON.stringify({ data: [{ id: "uebernehmer", login: "brobot" }] }), { status: 200 }),
    );

    const response = await authRouter.fetch(callbackRequest(login), environment);

    expect(response.status).toBe(403);
    expect(statement.bind.mock.calls.some((args: unknown[]) => args.includes("uebernehmer"))).toBe(false);
    expect(statement.bind.mock.calls.some((args: unknown[]) => args[0] === "bot_identity_user_mismatch")).toBe(true);
    expect(mockedMaintainBotIdentity).not.toHaveBeenCalled();
    expect(mockedMaintainEventSubSubscriptions).not.toHaveBeenCalled();
  });

  it("gives two fetches the same CSRF token, so a second tab doesn't invalidate the first", async () => {
    // If every fetch overwrote the shared cookie, the first tab's logout would
    // fail with 403 — and the worker would revoke nothing.
    const { environment } = makeEnvironment(sessionRowFor("user-1"));
    const cookieHeader = await sessionCookieHeaderFor("user-1");

    const erster = await authRouter.fetch(
      new Request("https://brobot.example/api/csrf", { headers: { Cookie: cookieHeader } }),
      environment,
    );
    const firstToken = await csrfTokenFrom(erster);

    const zweiter = await authRouter.fetch(
      new Request("https://brobot.example/api/csrf", {
        headers: { Cookie: `${cookieHeader}; __Host-brobot_csrf=${firstToken}` },
      }),
      environment,
    );
    const secondToken = await csrfTokenFrom(zweiter);

    expect(secondToken).toBe(firstToken);
    // No new cookie, so the first tab's token stays valid.
    expect(zweiter.headers.get("set-cookie")).toBeNull();
  });

  /**
   * The bot account is installation-wide: one account posts in every channel.
   * A broadcaster has no business starting that flow, even though the callback
   * would refuse a foreign login anyway.
   */
  it("refuses to start the bot connection for a channel-level session", async () => {
    const { environment } = makeEnvironment(null, sessionRowFor("broadcaster-1"));
    const response = await authRouter.fetch(
      new Request("https://brobot.example/auth/bot/login", {
        headers: { Cookie: await sessionCookieHeaderFor("broadcaster-1") },
      }),
      environment,
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
  });
});
