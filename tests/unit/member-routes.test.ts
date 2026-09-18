import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { panelRouter } from "../../src/worker/panel/routes";
import { TestD1Database, type TestPreparedStatement } from "./test-d1";

type MemberRole = "broadcaster" | "verwalter" | "bediener";

const key = (byte: number): string =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const environmentKeys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
};

const insertChannel = async (database: TestD1Database, channelId: string): Promise<void> => {
  await database.prepare(
    `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(channelId, channelId, channelId, "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
};

const insertSession = async (database: TestD1Database, userId: string): Promise<void> => {
  await database.prepare(
    `INSERT INTO twitch_login_identity
      (user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
       expires_at, status, reason, created_at, updated_at)
     VALUES (?, ?, '[]', 'access', 'refresh', ?, 'connected', NULL, ?, ?)`,
  ).bind(userId, userId, "2099-09-19T00:00:00.000Z", "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
  await database.prepare(
    `INSERT INTO auth_sessions
      (session_id, user_id, login, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    `session-${userId}`,
    userId,
    userId,
    "2099-09-19T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
  ).run();
};

const insertMember = async (
  database: TestD1Database,
  channelId: string,
  userId: string,
  role: MemberRole,
): Promise<void> => {
  await database.prepare(
    `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(channelId, userId, role, "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
};

const setupChannel = async (
  database: TestD1Database,
  role: MemberRole = "broadcaster",
  channelId = "kanal-a",
  userId = "user-1",
): Promise<void> => {
  await insertChannel(database, channelId);
  await insertSession(database, userId);
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

describe("Mitgliederverwaltung", () => {
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

  it("lässt einen Bediener die Liste lesen, aber keine Änderung ausführen", async () => {
    await setupChannel(database, "bediener");
    await insertMember(database, "kanal-a", "user-2", "bediener");

    const listResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members"),
      environment,
    );
    const addResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members", "POST", { userId: "user-3", role: "bediener" }),
      environment,
    );
    const changeResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-2", "PATCH", { role: "verwalter" }),
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

  it("liefert für auflösbare Mitglieder Login und Anzeigename aus Helix", async () => {
    await setupChannel(database);
    await insertMember(database, "kanal-a", "user-2", "bediener");
    await insertBotIdentity(database);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      data: [
        { id: "user-1", login: "streamer", display_name: "Streamerin" },
        { id: "user-2", login: "helfer", display_name: "Helfer" },
      ],
    }), { status: 200 }));

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members"),
      environment,
    );
    const body = await response.json<{ members: Array<Record<string, unknown>> }>();

    expect(response.status).toBe(200);
    expect(body.members).toEqual([
      { userId: "user-1", login: "streamer", displayName: "Streamerin", role: "broadcaster", joinedAt: "2026-09-18T00:00:00.000Z" },
      { userId: "user-2", login: "helfer", displayName: "Helfer", role: "bediener", joinedAt: "2026-09-18T00:00:00.000Z" },
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.twitch.tv/helix/users?id=user-1&id=user-2",
      expect.objectContaining({ headers: { "Client-ID": "client-id", Authorization: "Bearer bot-access-token" } }),
    );

    const stored = await database.prepare("SELECT * FROM channel_members ORDER BY user_id").all<Record<string, unknown>>();
    expect(stored.results).toEqual([
      { channel_id: "kanal-a", user_id: "user-1", role: "broadcaster", created_at: "2026-09-18T00:00:00.000Z", updated_at: "2026-09-18T00:00:00.000Z" },
      { channel_id: "kanal-a", user_id: "user-2", role: "bediener", created_at: "2026-09-18T00:00:00.000Z", updated_at: "2026-09-18T00:00:00.000Z" },
    ]);
  });

  it("behält unauflösbare Mitglieder in der Liste und macht ihren Entzug weiter möglich", async () => {
    await setupChannel(database);
    await insertMember(database, "kanal-a", "user-2", "bediener");
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
      expect.objectContaining({ userId: "user-1", login: "streamer", displayName: "Streamerin" }),
      expect.objectContaining({ userId: "user-2", login: null, displayName: null }),
    ]);
    expect(removeResponse.status).toBe(204);
  });

  it("liefert die Mitgliederliste auch bei einem Helix-Fehler mit nicht auflösbaren Namen", async () => {
    await setupChannel(database);
    await insertMember(database, "kanal-a", "user-2", "bediener");
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

  it("begrenzt Mitgliederseiten auf 100 und löst jede Seite mit höchstens einem Helix-Aufruf auf", async () => {
    await setupChannel(database);
    for (let index = 0; index < 100; index += 1) {
      await insertMember(database, "kanal-a", `user-${String(index).padStart(3, "0")}`, "bediener");
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

  it("weist eine unbegrenzte oder zu große Mitglieder-Seitengröße zurück", async () => {
    await setupChannel(database);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members?limit=101"),
      environment,
    );

    expect(response.status).toBe(400);
  });

  it("verhindert, dass ein Verwalter sich selbst zum Broadcaster macht", async () => {
    await setupChannel(database, "verwalter");

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-1", "PATCH", { role: "broadcaster" }),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain("eigene Rolle");
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("verhindert Self-DELETE gegen Self-POST auch bei einer Löschung im Zwischenzustand", async () => {
    await setupChannel(database, "verwalter");
    const racingDatabase = databaseRacingBeforeMemberRead(database, () => {
      deleteMemberImmediately(database, "kanal-a", "user-1");
    });
    environment = { ...environment, DB: racingDatabase };

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members", "POST", { userId: "user-1", role: "broadcaster" }),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain("eigene Mitgliedschaft");
    await expect(database.prepare(
      "SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "user-1").first()).resolves.toEqual({ user_id: "user-1" });
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("macht aus DELETE gegen PATCH desselben Mitglieds kein neues Mitglied", async () => {
    await setupChannel(database, "verwalter");
    await insertMember(database, "kanal-a", "user-2", "bediener");
    const racingDatabase = databaseRacingAfterMemberRead(database, () => {
      deleteMemberImmediately(database, "kanal-a", "user-2");
    });
    environment = { ...environment, DB: racingDatabase };

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-2", "PATCH", { role: "verwalter" }),
      environment,
    );

    expect(response.status).toBe(409);
    await expect(database.prepare(
      "SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "user-2").first()).resolves.toBeNull();
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("macht aus POST gegen ein gleichzeitiges Anlegen kein UPDATE", async () => {
    await setupChannel(database, "verwalter");
    const racingDatabase = databaseRacingAfterMemberRead(database, () => {
      insertMemberImmediately(database, "kanal-a", "user-2", "bediener");
    });
    environment = { ...environment, DB: racingDatabase };

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members", "POST", { userId: "user-2", role: "verwalter" }),
      environment,
    );

    expect(response.status).toBe(409);
    await expect(database.prepare(
      "SELECT role FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "user-2").first()).resolves.toEqual({ role: "bediener" });
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("verwendet für POST, PATCH und DELETE ausschließlich die channelId aus der Route", async () => {
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");

    const addResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members", "POST", { userId: "user-2", role: "bediener", channelId: "kanal-b" }),
      environment,
    );
    const changeResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-2", "PATCH", { role: "verwalter", channelId: "kanal-b" }),
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

  it("schützt den letzten Broadcaster vor Entzug und Herabstufung", async () => {
    await setupChannel(database);

    const changeResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-1", "PATCH", { role: "verwalter" }),
      environment,
    );
    const removeResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-1", "DELETE"),
      environment,
    );

    expect(changeResponse.status).toBe(409);
    expect(removeResponse.status).toBe(409);
    await expect(changeResponse.text()).resolves.toContain("letzte Broadcaster");
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("verweigert Änderungen in einem fremden Kanal trotz gültiger Session", async () => {
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-b/members", "POST", { userId: "user-2", role: "bediener" }),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("erzeugt für jede erfolgreiche Mutation genau einen Audit-Eintrag", async () => {
    await setupChannel(database);

    const addResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members", "POST", { userId: "user-2", role: "bediener" }),
      environment,
    );
    expect(addResponse.status).toBe(201);
    await expect(auditCount(database)).resolves.toBe(1);

    const changeResponse = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-2", "PATCH", { role: "verwalter" }),
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

  it("meldet einen unbekannten Twitch-Namen klar und legt kein Mitglied an", async () => {
    await setupChannel(database);
    await insertBotIdentity(database);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/search?login=gibt-es-nicht"),
      environment,
    );

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toContain("Twitch-Nutzer nicht gefunden");
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("sucht bekannte Twitch-Nutzer mit dem gespeicherten Bot-Token", async () => {
    await setupChannel(database);
    await insertBotIdentity(database);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({
      data: [{ id: "300", login: "neue-person", display_name: "Neue Person" }],
    }), { status: 200 }));

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/search?login=neue-person"),
      environment,
    );
    const body = await response.json<{ user: { userId: string; login: string; displayName: string } }>();

    expect(response.status).toBe(200);
    expect(body).toEqual({ user: { userId: "300", login: "neue-person", displayName: "Neue Person" } });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.twitch.tv/helix/users?login=neue-person",
      expect.objectContaining({ headers: { "Client-ID": "client-id", Authorization: "Bearer bot-access-token" } }),
    );
  });

  it("verbietet einem Bediener die Twitch-Nutzersuche ohne Helix-Aufruf", async () => {
    await setupChannel(database, "bediener");

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/search?login=neue-person"),
      environment,
    );

    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("liefert bei einer Helix-Zeitüberschreitung alle Namen als nicht auflösbar", async () => {
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

  it("lässt einen Verwalter keinen Broadcaster anlegen", async () => {
    // Sonst macht der Verwalter sein Zweitkonto zum Broadcaster und entfernt
    // danach den ursprünglichen — der Schutz des letzten Broadcasters greift
    // dann nicht, weil zwischenzeitlich zwei existieren.
    await setupChannel(database, "verwalter");

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

  it("lässt einen Verwalter niemanden zum Broadcaster befördern", async () => {
    await setupChannel(database, "verwalter");
    await insertMember(database, "kanal-a", "user-2", "bediener");

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-2", "PATCH", { role: "broadcaster" }),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(database.prepare(
      "SELECT role FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "user-2").first()).resolves.toEqual({ role: "bediener" });
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("lässt einen Broadcaster einen weiteren Broadcaster anlegen", async () => {
    // Gegenprobe: Die Regel darf den erlaubten Fall nicht mitsperren.
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

  it("legt kein Mitglied an, wenn die Session nach dem Guard widerrufen wird", async () => {
    // Der Guard prüft die Session, danach wartet der Handler auf den Body.
    // Ein Client kann ihn offen lassen, bis seine Session widerrufen ist.
    // Die Mutation muss das bemerken, nicht nur der Guard.
    await setupChannel(database, "verwalter");
    const racingDatabase = databaseRacingBeforeMemberRead(database, () => {
      revokeSessionImmediately(database, "user-1");
    });
    environment = { ...environment, DB: racingDatabase };

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members", "POST", { userId: "user-2", role: "verwalter" }),
      environment,
    );

    expect(response.status).toBe(409);
    await expect(database.prepare(
      "SELECT user_id FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "user-2").first()).resolves.toBeNull();
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("ändert keine Rolle, wenn die Session nach dem Guard widerrufen wird", async () => {
    await setupChannel(database, "verwalter");
    await insertMember(database, "kanal-a", "user-2", "bediener");
    const racingDatabase = databaseRacingAfterMemberRead(database, () => {
      revokeSessionImmediately(database, "user-1");
    });
    environment = { ...environment, DB: racingDatabase };

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members/user-2", "PATCH", { role: "verwalter" }),
      environment,
    );

    expect(response.status).toBe(409);
    await expect(database.prepare(
      "SELECT role FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "user-2").first()).resolves.toEqual({ role: "bediener" });
    await expect(auditCount(database)).resolves.toBe(0);
  });

  it("entfernt kein Mitglied, wenn die Session nach dem Guard widerrufen wird", async () => {
    await setupChannel(database, "verwalter");
    await insertMember(database, "kanal-a", "user-2", "bediener");
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

  it("weist eine schreibende Mitgliederroute ohne CSRF-Token ab", async () => {
    await setupChannel(database);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/members", "POST", { userId: "user-2", role: "bediener" }, false),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(auditCount(database)).resolves.toBe(0);
  });
});
