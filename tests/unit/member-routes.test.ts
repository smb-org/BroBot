import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { panelRouter } from "../../src/worker/panel/routes";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey as key } from "./fixtures";
import { createReadBarrierDatabase, TestD1Database, type TestPreparedStatement } from "./test-d1";

type MemberRole = "broadcaster" | "manager" | "operator";

const environmentKeys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
};

const setupChannel = async (
  database: TestD1Database,
  role: MemberRole = "broadcaster",
  channelId = "kanal-a",
  userId = "user-1",
): Promise<void> => {
  await insertChannel(database, channelId);
  await insertLoginIdentityAndSession(database, userId);
  await insertMember(database, channelId, userId, role);
};

const deleteMemberImmediately = (database: TestD1Database, channelId: string, userId: string): void => {
  database.prepare("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?")
    .bind(channelId, userId).runSync();
};

const insertMemberImmediately = (
  database: TestD1Database,
  channelId: string,
  userId: string,
  role: MemberRole,
): void => {
  database.prepare(
    `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(
    channelId,
    userId,
    role,
    "2026-09-18T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
  ).runSync();
};

const insertBotIdentity = async (database: TestD1Database): Promise<void> => {
  const accessTokenCiphertext = await encryptJson(
    { token: "bot-access-token" },
    parseKeyRing(environmentKeys.SESSION_ENCRYPTION_KEYS),
  );
  const refreshTokenCiphertext = await encryptJson(
    { token: "bot-refresh-token" },
    parseKeyRing(environmentKeys.SESSION_ENCRYPTION_KEYS),
  );
  await database.prepare(
    `INSERT INTO bot_identity
      (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
       expires_at, created_at, updated_at)
     VALUES (1, 'bot-user', 'brobot', '[]', ?, ?, ?, ?, ?)`,
  ).bind(
    accessTokenCiphertext,
    refreshTokenCiphertext,
    "2099-09-19T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
  ).run();
};

const environmentFor = (database: TestD1Database): Env => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  TWITCH_BOT_LOGIN: "brobot",
  PUBLIC_ORIGIN: "https://brobot.example",
  ...environmentKeys,
} as unknown as Env);

const requestFor = async (
  userId: string,
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
  withCsrf = true,
): Promise<Request> => {
  const sessionCookie = await createSessionCookie(
    { sessionId: `session-${userId}` },
    environmentKeys.SESSION_COOKIE_KEYS,
    environmentKeys.SESSION_ENCRYPTION_KEYS,
  );
  const csrfToken = await createCsrfToken(
    `session-${userId}`,
    environmentKeys.SESSION_COOKIE_KEYS,
    new Date().toISOString(),
  );
  const headers = new Headers({
    Cookie: `__Host-brobot_session=${sessionCookie}${withCsrf ? `; __Host-brobot_csrf=${csrfToken}` : ""}`,
    "Content-Type": "application/json",
  });
  if (withCsrf) headers.set("X-CSRF-Token", csrfToken);
  const init: RequestInit = {
    method,
    headers,
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`https://brobot.example${path}`, init);
};

const auditCount = async (database: TestD1Database): Promise<number> => {
  const result = await database.prepare("SELECT COUNT(*) AS count FROM audit_log").first<{ count: number }>();
  return result?.count ?? 0;
};

const requestUrl = (input: RequestInfo | URL): URL => {
  if (input instanceof Request) return new URL(input.url);
  if (input instanceof URL) return input;
  return new URL(input);
};

const databaseRacingAroundMemberRead = (
  database: TestD1Database,
  race: () => void,
  timing: "before" | "after",
): D1Database => {
  let raced = false;
  return {
    prepare: (sql: string) => {
      const statement = database.prepare(sql);
      if (!sql.includes("SELECT channel_id, user_id, role, created_at, updated_at") || !sql.includes("WHERE channel_id = ? AND user_id = ?")) {
        return statement;
      }
      const racedStatement = {
        bind: (...values: Parameters<TestPreparedStatement["bind"]>) => {
          statement.bind(...values);
          return racedStatement;
        },
        first: async <T>() => {
          if (timing === "before" && !raced) {
            raced = true;
            race();
          }
          const result = await statement.first<T>();
          if (timing === "after" && !raced) {
            raced = true;
            race();
          }
          return result;
        },
      };
      return racedStatement as unknown as TestPreparedStatement;
    },
    batch: database.batch.bind(database),
  } as unknown as D1Database;
};

const revokeSessionImmediately = (database: TestD1Database, userId: string): void => {
  database.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE session_id = ?")
    .bind("2026-09-18T00:30:00.000Z", `session-${userId}`).runSync();
};

const databaseRacingAfterMemberRead = (database: TestD1Database, race: () => void): D1Database =>
  databaseRacingAroundMemberRead(database, race, "after");

const databaseRacingBeforeMemberRead = (database: TestD1Database, race: () => void): D1Database =>
  databaseRacingAroundMemberRead(database, race, "before");

describe("Member management", () => {
  let database: TestD1Database;
  let environment: Env;

  beforeEach(() => {
    database = new TestD1Database();
    environment = environmentFor(database);
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    database.close();
    vi.unstubAllGlobals();
  });

  it("lets an operator read the list but not perform any change", async () => {
    await setupChannel(database, "operator");
    await insertMember(database, "kanal-a", "user-2", "operator");

    const listResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members"),
      environment,
    );
    const addResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members", "POST", { userId: "user-3", role: "operator" }),
      environment,
    );
    const changeResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-2", "PATCH", { role: "manager" }),
      environment,
    );
    const removeResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-2", "DELETE"),
      environment,
    );

    expect(listResponse.status).toBe(200);
    expect(addResponse.status).toBe(403);
    expect(changeResponse.status).toBe(403);
    expect(removeResponse.status).toBe(403);
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("returns login and display name from Helix for resolvable members", async () => {
    await setupChannel(database);
    await insertMember(database, "kanal-a", "user-2", "operator");
    await insertBotIdentity(database);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      data: [
        { id: "user-1", login: "streamer", display_name: "Streamerin", profile_image_url: "https://cdn.example/streamer.png" },
        { id: "user-2", login: "helfer", display_name: "Helfer", profile_image_url: "" },
      ],
    }), { status: 200 }));

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members"),
      environment,
    );
    const body = await response.json<{ members: Array<Record<string, unknown>> }>();

    expect(response.status).toBe(200);
    expect(body.members).toEqual([
      { userId: "user-1", login: "streamer", displayName: "Streamerin", profileImageUrl: "https://cdn.example/streamer.png", role: "broadcaster", joinedAt: "2026-09-18T00:00:00.000Z" },
      { userId: "user-2", login: "helfer", displayName: "Helfer", profileImageUrl: null, role: "operator", joinedAt: "2026-09-18T00:00:00.000Z" },
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.twitch.tv/helix/users?id=user-1&id=user-2",
      expect.objectContaining({ headers: { "Client-ID": "client-id", Authorization: "Bearer bot-access-token" } }),
    );

    const stored = await database.prepare("SELECT * FROM channel_members ORDER BY user_id").all<Record<string, unknown>>();
    expect(stored.results).toEqual([
      { channel_id: "kanal-a", user_id: "user-1", role: "broadcaster", created_at: "2026-09-18T00:00:00.000Z", updated_at: "2026-09-18T00:00:00.000Z" },
      { channel_id: "kanal-a", user_id: "user-2", role: "operator", created_at: "2026-09-18T00:00:00.000Z", updated_at: "2026-09-18T00:00:00.000Z" },
    ]);
  });

  it("keeps unresolvable members in the list and still allows revoking them", async () => {
    await setupChannel(database);
    await insertMember(database, "kanal-a", "user-2", "operator");
    await insertBotIdentity(database);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ id: "user-1", login: "streamer", display_name: "Streamerin" }],
    }), { status: 200 }));

    const listResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members"),
      environment,
    );
    const body = await listResponse.json<{ members: Array<Record<string, unknown>> }>();
    const removeResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-2", "DELETE"),
      environment,
    );

    expect(body.members).toEqual([
      expect.objectContaining({ userId: "user-1", login: "streamer", displayName: "Streamerin", profileImageUrl: null }),
      expect.objectContaining({ userId: "user-2", login: null, displayName: null, profileImageUrl: null }),
    ]);
    expect(removeResponse.status).toBe(204);
  });

  it("returns the member list with unresolvable names even on a Helix error", async () => {
    await setupChannel(database);
    await insertMember(database, "kanal-a", "user-2", "operator");
    await insertBotIdentity(database);
    vi.mocked(fetch).mockResolvedValueOnce(new Response("Twitch ist nicht erreichbar.", { status: 503 }));

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members"),
      environment,
    );
    const body = await response.json<{ members: Array<Record<string, unknown>> }>();

    expect(response.status).toBe(200);
    expect(body.members).toEqual([
      expect.objectContaining({ userId: "user-1", login: null, displayName: null }),
      expect.objectContaining({ userId: "user-2", login: null, displayName: null }),
    ]);
  });

  it("limits member pages to 100 and resolves each page with at most one Helix call", async () => {
    await setupChannel(database);
    for (let index = 0; index < 100; index += 1) {
      await insertMember(database, "kanal-a", `user-${String(index).padStart(3, "0")}`, "operator");
    }
    await insertBotIdentity(database);
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const firstResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members?limit=100"),
      environment,
    );
    const first = await firstResponse.json<{ members: Array<Record<string, unknown>>; nextCursor: string | null }>();
    const secondResponse = await panelRouter.fetch(
      await requestFor("user-1", `/api/channels/kanal-a/members?limit=100&cursor=${encodeURIComponent(first.nextCursor ?? "")}`),
      environment,
    );
    const second = await secondResponse.json<{ members: Array<Record<string, unknown>>; nextCursor: string | null }>();

    expect(firstResponse.status).toBe(200);
    expect(first.members).toHaveLength(100);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(secondResponse.status).toBe(200);
    expect(second.members).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(requestUrl(vi.mocked(fetch).mock.calls[0]?.[0] as RequestInfo | URL).searchParams.getAll("id")).toHaveLength(100);
    expect(requestUrl(vi.mocked(fetch).mock.calls[1]?.[0] as RequestInfo | URL).searchParams.getAll("id")).toHaveLength(1);
  });

  it("rejects an unbounded or too-large member page size", async () => {
    await setupChannel(database);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members?limit=101"),
      environment,
    );

    expect(response.status).toBe(400);
  });

  it("prevents a manager from making themselves broadcaster", async () => {
    await setupChannel(database, "manager");

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-1", "PATCH", { role: "broadcaster" }),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "self_role_escalation_denied" });
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("prevents a self-DELETE racing a self-POST even with a deletion in between", async () => {
    await setupChannel(database, "manager");
    const racingDatabase = databaseRacingBeforeMemberRead(database, () => {
      deleteMemberImmediately(database, "kanal-a", "user-1");
    });
    environment = { ...environment, DB: racingDatabase };

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members", "POST", { userId: "user-1", role: "broadcaster" }),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "self_membership_denied" });
    await expect(database.prepare(
      "SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "user-1").first()).resolves.toEqual({ user_id: "user-1" });
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("doesn't turn a DELETE racing a PATCH of the same member into a new member", async () => {
    await setupChannel(database, "manager");
    await insertMember(database, "kanal-a", "user-2", "operator");
    const racingDatabase = databaseRacingAfterMemberRead(database, () => {
      deleteMemberImmediately(database, "kanal-a", "user-2");
    });
    environment = { ...environment, DB: racingDatabase };

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-2", "PATCH", { role: "manager" }),
      environment,
    );

    expect(response.status).toBe(409);
    await expect(database.prepare(
      "SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "user-2").first()).resolves.toBeNull();
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("doesn't turn a POST racing a concurrent create into an UPDATE", async () => {
    await setupChannel(database, "manager");
    const racingDatabase = databaseRacingAfterMemberRead(database, () => {
      insertMemberImmediately(database, "kanal-a", "user-2", "operator");
    });
    environment = { ...environment, DB: racingDatabase };

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members", "POST", { userId: "user-2", role: "manager" }),
      environment,
    );

    expect(response.status).toBe(409);
    await expect(database.prepare(
      "SELECT role FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "user-2").first()).resolves.toEqual({ role: "operator" });
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("uses only the channelId from the route for POST, PATCH, and DELETE", async () => {
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");

    const addResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members", "POST", { userId: "user-2", role: "operator", channelId: "kanal-b" }),
      environment,
    );
    const changeResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-2", "PATCH", { role: "manager", channelId: "kanal-b" }),
      environment,
    );
    const removeResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-2", "DELETE", { channelId: "kanal-b" }),
      environment,
    );

    expect(addResponse.status).toBe(201);
    expect(changeResponse.status).toBe(200);
    expect(removeResponse.status).toBe(204);
    await expect(database.prepare(
      "SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "user-2").first()).resolves.toBeNull();
    await expect(database.prepare(
      "SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-b", "user-2").first()).resolves.toBeNull();
  });

  it("protects the last broadcaster from removal and demotion", async () => {
    await setupChannel(database);

    const changeResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-1", "PATCH", { role: "manager" }),
      environment,
    );
    const removeResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-1", "DELETE"),
      environment,
    );

    expect(changeResponse.status).toBe(409);
    expect(removeResponse.status).toBe(409);
    await expect(changeResponse.json()).resolves.toEqual({ error: "last_broadcaster_cannot_be_demoted" });
    await expect(removeResponse.json()).resolves.toEqual({ error: "last_broadcaster_cannot_be_removed" });
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("denies changes in a foreign channel despite a valid session", async () => {
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-b/members", "POST", { userId: "user-2", role: "operator" }),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("creates exactly one audit entry for each successful mutation", async () => {
    await setupChannel(database);

    const addResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members", "POST", { userId: "user-2", role: "operator" }),
      environment,
    );
    expect(addResponse.status).toBe(201);
    await expect(auditCount(database)).resolves.toBe(1);

    const changeResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-2", "PATCH", { role: "manager" }),
      environment,
    );
    expect(changeResponse.status).toBe(200);
    await expect(auditCount(database)).resolves.toBe(2);

    const removeResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-2", "DELETE"),
      environment,
    );
    expect(removeResponse.status).toBe(204);
    await expect(auditCount(database)).resolves.toBe(3);

    const failedResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members", "POST", { userId: "user-3", role: "fremdrolle" }),
      environment,
    );
    expect(failedResponse.status).toBe(400);
    await expect(auditCount(database)).resolves.toBe(3);
  });

  it("clearly reports an unknown Twitch name and creates no member", async () => {
    await setupChannel(database);
    await insertBotIdentity(database);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/search?login=gibt-es-nicht"),
      environment,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "twitch_user_not_found" });
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("searches known Twitch users with the stored bot token", async () => {
    await setupChannel(database);
    await insertBotIdentity(database);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ id: "300", login: "neue-person", display_name: "Neue Person", profile_image_url: "https://cdn.example/neue-person.png" }],
    }), { status: 200 }));

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/search?login=neue-person"),
      environment,
    );
    const body = await response.json<{ user: { userId: string; login: string; displayName: string; profileImageUrl: string | null } }>();

    expect(response.status).toBe(200);
    expect(body).toEqual({ user: { userId: "300", login: "neue-person", displayName: "Neue Person", profileImageUrl: "https://cdn.example/neue-person.png" } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.twitch.tv/helix/users?login=neue-person",
      expect.objectContaining({ headers: { "Client-ID": "client-id", Authorization: "Bearer bot-access-token" } }),
    );
  });

  it("doesn't store the image URL returned by the search in channel_members", async () => {
    await setupChannel(database);
    await insertBotIdentity(database);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ id: "300", login: "neue-person", display_name: "Neue Person", profile_image_url: "https://cdn.example/neue-person.png" }],
    }), { status: 200 }));

    const searchResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/search?login=neue-person"),
      environment,
    );
    const searchedUser = await searchResponse.json<{ user: { userId: string } }>();
    const addResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members", "POST", { userId: searchedUser.user.userId, role: "operator" }),
      environment,
    );

    expect(addResponse.status).toBe(201);
    const stored = await database.prepare(
      "SELECT * FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "300").first<Record<string, unknown>>();
    const createdAt = stored?.created_at;
    const updatedAt = stored?.updated_at;
    expect(stored).toEqual({
      channel_id: "kanal-a",
      user_id: "300",
      role: "operator",
      created_at: createdAt,
      updated_at: updatedAt,
    });
    expect(Object.keys(stored ?? {})).toEqual([
      "channel_id",
      "user_id",
      "role",
      "created_at",
      "updated_at",
    ]);
  });

  it("forbids an operator from the Twitch user search without a Helix call", async () => {
    await setupChannel(database, "operator");

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/search?login=neue-person"),
      environment,
    );

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns all names as unresolvable on a Helix timeout", async () => {
    await setupChannel(database);
    await insertBotIdentity(database);
    vi.mocked(fetch).mockImplementationOnce((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => { reject(new DOMException("Aborted", "AbortError")); }, { once: true });
    }));

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members"),
      environment,
    );
    const body = await response.json<{ members: Array<Record<string, unknown>> }>();

    expect(response.status).toBe(200);
    expect(body.members).toEqual([
      expect.objectContaining({ userId: "user-1", login: null, displayName: null }),
    ]);
  }, 10_000);

  it("doesn't let a manager create a broadcaster", async () => {
    // Otherwise the manager makes their second account a broadcaster and then
    // removes the original one — the last-broadcaster protection
    // doesn't kick in then, because two exist in the meantime.
    await setupChannel(database, "manager");

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members", "POST", { userId: "user-2", role: "broadcaster" }),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(database.prepare(
      "SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "user-2").first()).resolves.toBeNull();
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("doesn't let a manager promote anyone to broadcaster", async () => {
    await setupChannel(database, "manager");
    await insertMember(database, "kanal-a", "user-2", "operator");

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-2", "PATCH", { role: "broadcaster" }),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(database.prepare(
      "SELECT role FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "user-2").first()).resolves.toEqual({ role: "operator" });
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("lets a broadcaster create another broadcaster", async () => {
    // Control check: the rule must not also block the allowed case.
    await setupChannel(database, "broadcaster");

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members", "POST", { userId: "user-2", role: "broadcaster" }),
      environment,
    );

    expect(response.status).toBe(201);
    await expect(database.prepare(
      "SELECT role FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "user-2").first()).resolves.toEqual({ role: "broadcaster" });
  });

  it("lets a broadcaster demote and remove a broadcaster as long as one remains", async () => {
    await setupChannel(database, "broadcaster");
    await insertMember(database, "kanal-a", "user-2", "broadcaster");
    await insertMember(database, "kanal-a", "user-3", "broadcaster");

    const changeResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-2", "PATCH", { role: "manager" }),
      environment,
    );
    const removeResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-3", "DELETE"),
      environment,
    );

    expect(changeResponse.status).toBe(200);
    expect(removeResponse.status).toBe(204);
    await expect(database.prepare(
      "SELECT role FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "user-2").first()).resolves.toEqual({ role: "manager" });
    await expect(database.prepare(
      "SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "user-3").first()).resolves.toBeNull();
  });

  it("lets a manager continue managing managers and operators as before", async () => {
    await setupChannel(database, "manager");
    await insertMember(database, "kanal-a", "user-2", "manager");
    await insertMember(database, "kanal-a", "user-3", "operator");

    const lowerResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-2", "PATCH", { role: "operator" }),
      environment,
    );
    const raiseResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-3", "PATCH", { role: "manager" }),
      environment,
    );
    const removeResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-3", "DELETE"),
      environment,
    );

    expect(lowerResponse.status).toBe(200);
    expect(raiseResponse.status).toBe(200);
    expect(removeResponse.status).toBe(204);
    await expect(database.prepare(
      "SELECT role FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "user-2").first()).resolves.toEqual({ role: "operator" });
    await expect(database.prepare(
      "SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "user-3").first()).resolves.toBeNull();
  });

  it("creates no member when the session is revoked after the guard", async () => {
    // The guard checks the session, then the handler waits for the body.
    // A client can keep it open until its session has been revoked.
    // The mutation must notice this, not just the guard.
    await setupChannel(database, "manager");
    const racingDatabase = databaseRacingBeforeMemberRead(database, () => {
      revokeSessionImmediately(database, "user-1");
    });
    environment = { ...environment, DB: racingDatabase };

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members", "POST", { userId: "user-2", role: "manager" }),
      environment,
    );

    expect(response.status).toBe(409);
    await expect(database.prepare(
      "SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "user-2").first()).resolves.toBeNull();
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("changes no role when the session is revoked after the guard", async () => {
    await setupChannel(database, "manager");
    await insertMember(database, "kanal-a", "user-2", "operator");
    const racingDatabase = databaseRacingAfterMemberRead(database, () => {
      revokeSessionImmediately(database, "user-1");
    });
    environment = { ...environment, DB: racingDatabase };

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-2", "PATCH", { role: "manager" }),
      environment,
    );

    expect(response.status).toBe(409);
    await expect(database.prepare(
      "SELECT role FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "user-2").first()).resolves.toEqual({ role: "operator" });
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("removes no member when the session is revoked after the guard", async () => {
    await setupChannel(database, "manager");
    await insertMember(database, "kanal-a", "user-2", "operator");
    const racingDatabase = databaseRacingAfterMemberRead(database, () => {
      revokeSessionImmediately(database, "user-1");
    });
    environment = { ...environment, DB: racingDatabase };

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-2", "DELETE"),
      environment,
    );

    expect(response.status).toBe(409);
    await expect(database.prepare(
      "SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "user-2").first()).resolves.toEqual({ user_id: "user-2" });
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("returns the broadcaster count and own user id with the member list", async () => {
    // The UI needs both to recognize the last broadcaster and its own
    // entry. With a paginated list it must not count this itself:
    // the count applies to the channel, not the page.
    await setupChannel(database, "broadcaster");
    await insertMember(database, "kanal-a", "user-2", "manager");

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members"),
      environment,
    );
    const body = await response.json<{ broadcasterCount: number; viewerUserId: string }>();

    expect(response.status).toBe(200);
    expect(body.broadcasterCount).toBe(1);
    expect(body.viewerUserId).toBe("user-1");
  });

  it("counts broadcasters across the whole channel, not the fetched page", async () => {
    await setupChannel(database, "broadcaster");
    await insertMember(database, "kanal-a", "user-2", "broadcaster");
    await insertMember(database, "kanal-a", "user-3", "operator");

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members?limit=1"),
      environment,
    );
    const body = await response.json<{ members: unknown[]; broadcasterCount: number }>();

    expect(body.members).toHaveLength(1);
    expect(body.broadcasterCount).toBe(2);
  });

  it("starts the member page and broadcaster count reads together", async () => {
    await setupChannel(database, "broadcaster");
    const traced = createReadBarrierDatabase(database, (sql, operation) => {
      if (operation === "all" && sql.includes("ORDER BY created_at, user_id")) return "member-page";
      if (operation === "first" && sql.includes("COUNT(*) AS count")) return "broadcaster-count";
      return null;
    }, 2);
    environment = { ...environment, DB: traced.database };

    const responsePending = panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members"),
      environment,
    );
    await vi.waitFor(() => { expect(traced.started).toHaveLength(2); });
    expect(traced.started).toEqual(["member-page", "broadcaster-count"]);
    const response = await responsePending;

    expect(response.status).toBe(200);
  });

  it("rejects a write member route without a CSRF token", async () => {
    await setupChannel(database);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members", "POST", { userId: "user-2", role: "operator" }, false),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(auditCount(database)).resolves.toBe(0);
  });
});
