import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { createSessionCookie } from "../../src/worker/auth/session";
import {
  changePlatformMember,
  removePlatformMember,
  addPlatformMember,
} from "../../src/worker/platform/repository";
import { platformRouter } from "../../src/worker/platform/routes";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

const key = (byte: number): string =>
  btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const environmentKey = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
};

const platformId = "26876135";

const environmentFor = (database: TestD1Database, platform = [platformId]): Env => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  TWITCH_BOT_LOGIN: "brobot",
  PUBLIC_ORIGIN: "https://brobot.example",
  PLATFORM_USER_IDS: JSON.stringify(platform),
  ...environmentKey,
} as unknown as Env);

const requestFor = async (
  userId: string,
  pfad: string,
  methode = "GET",
  rumpf?: Record<string, unknown>,
): Promise<Request> => {
  const sessionCookie = await createSessionCookie(
    { sessionId: `session-${userId}` },
    environmentKey.SESSION_COOKIE_KEYS,
    environmentKey.SESSION_ENCRYPTION_KEYS,
  );
  const csrfToken = await createCsrfToken(
    `session-${userId}`,
    environmentKey.SESSION_COOKIE_KEYS,
    new Date().toISOString(),
  );
  const kopfzeilen = new Headers({
    Cookie: `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrfToken}`,
    "Content-Type": "application/json",
    "X-CSRF-Token": csrfToken,
  });
  const init: RequestInit = { method: methode, headers: kopfzeilen };
  if (rumpf !== undefined) init.body = JSON.stringify(rumpf);
  return new Request(`https://brobot.example${pfad}`, init);
};

const setPlatform = async (database: TestD1Database): Promise<void> => {
  await insertLoginIdentityAndSession(database, platformId);
};

const setBotIdentity = async (database: TestD1Database): Promise<void> => {
  const keyRing = parseKeyRing(environmentKey.SESSION_ENCRYPTION_KEYS);
  const accessToken = await encryptJson({ token: "bot-zugriffstoken" }, keyRing);
  const refreshToken = await encryptJson({ token: "bot-auffrischungstoken" }, keyRing);
  await database.prepare(
    `INSERT INTO bot_identity
      (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
       expires_at, created_at, updated_at)
     VALUES (1, 'bot-user', 'brobot', '[]', ?, ?, ?, ?, ?)`,
  ).bind(
    accessToken,
    refreshToken,
    "2099-09-19T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
  ).run();
};

const responseFromHelix = (user: Record<string, unknown>[]): Response =>
  new Response(JSON.stringify({ data: user }), { status: 200 });

const leseAudit = async (database: TestD1Database): Promise<Record<string, unknown>[]> =>
  (await database.prepare(
    "SELECT actor_user_id, actor_kind, action, channel_id FROM audit_log ORDER BY created_at, audit_id",
  ).all<Record<string, unknown>>()).results;

describe("Platform admin level", () => {
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

  it("rejects a non-platform-admin with 403", async () => {
    await insertLoginIdentityAndSession(database, "kein-betreiber");

    const response = await platformRouter.fetch(
      await requestFor("kein-betreiber", "/api/platform"),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toBe("Kein Betreiberzugang.");
  });

  it("returns the cross-channel overview and searches users via Helix", async () => {
    await setPlatform(database);
    await insertChannel(database, "kanal-a", "Alpha");
    await insertChannel(database, "kanal-b", "Beta");
    await insertMember(database, "kanal-a", "kanal-a", "broadcaster");
    await insertMember(database, "kanal-a", "verwalter-1", "manager");
    await insertMember(database, "kanal-a", "bediener-1", "operator");
    await insertMember(database, "kanal-b", "kanal-b", "broadcaster");
    await database.prepare("UPDATE channels SET full_consent = 1 WHERE channel_id = ?").bind("kanal-a").run();
    await insertLoginIdentityAndSession(database, "kanal-a");
    await setBotIdentity(database);
    vi.mocked(fetch).mockResolvedValueOnce(responseFromHelix([
      { id: "user-7", login: "neuerkanal", display_name: "Neuer Kanal" },
    ]));

    const overviewResponse = await platformRouter.fetch(
      await requestFor(platformId, "/api/platform"),
      environment,
    );
    const overview = await overviewResponse.json<{
      channels: Array<Record<string, unknown>>;
    }>();
    const searchResponse = await platformRouter.fetch(
      await requestFor(platformId, "/api/platform/users?login=neuerkanal"),
      environment,
    );

    expect(overviewResponse.status).toBe(200);
    expect(overview.channels).toEqual([
      {
        channelId: "kanal-a",
        login: "kanal-a",
        displayName: "Alpha",
        fullConsent: true,
        memberCounts: { broadcaster: 1, manager: 1, operator: 1 },
        broadcasterConnected: true,
      },
      {
        channelId: "kanal-b",
        login: "kanal-b",
        displayName: "Beta",
        fullConsent: false,
        memberCounts: { broadcaster: 1, manager: 0, operator: 0 },
        broadcasterConnected: false,
      },
    ]);
    expect(searchResponse.status).toBe(200);
    await expect(searchResponse.json()).resolves.toEqual({
      user: { userId: "user-7", login: "neuerkanal", displayName: "Neuer Kanal", profileImageUrl: null },
    });
  });

  it("creates the channel, broadcaster row, and platform-admin audit entry in one batch on approval", async () => {
    await setPlatform(database);
    await setBotIdentity(database);
    vi.mocked(fetch).mockResolvedValueOnce(responseFromHelix([
      { id: "kanal-7", login: "kanal-sieben", display_name: "Kanal Sieben" },
    ]));

    const response = await platformRouter.fetch(
      await requestFor(platformId, "/api/platform/channels", "POST", {
        login: "kanal-sieben",
        fullConsent: true,
      }),
      environment,
    );
    const channel = await database.prepare(
      "SELECT channel_id, login, full_consent FROM channels WHERE channel_id = ?",
    ).bind("kanal-7").first();
    const member = await database.prepare(
      "SELECT channel_id, user_id, role FROM channel_members WHERE channel_id = ?",
    ).bind("kanal-7").first();

    expect(response.status).toBe(201);
    expect(channel).toEqual({ channel_id: "kanal-7", login: "kanal-sieben", full_consent: 1 });
    expect(member).toEqual({ channel_id: "kanal-7", user_id: "kanal-7", role: "broadcaster" });
    await expect(leseAudit(database)).resolves.toEqual([
      {
        actor_user_id: platformId,
        actor_kind: "platform_admin",
        action: "kanal.freigegeben",
        channel_id: "kanal-7",
      },
    ]);
  });

  it("performs the three allowed member mutations with platform-admin audit", async () => {
    await setPlatform(database);
    await insertChannel(database, "kanal-a");
    await insertMember(database, "kanal-a", "kanal-a", "broadcaster");

    const add = await platformRouter.fetch(
      await requestFor(platformId, "/api/platform/channels/kanal-a/members", "POST", {
        userId: "user-2",
        role: "operator",
      }),
      environment,
    );
    const change = await platformRouter.fetch(
      await requestFor(platformId, "/api/platform/channels/kanal-a/members/user-2", "PATCH", {
        role: "manager",
      }),
      environment,
    );
    const remove = await platformRouter.fetch(
      await requestFor(platformId, "/api/platform/channels/kanal-a/members/user-2", "DELETE"),
      environment,
    );

    expect(add.status).toBe(201);
    expect(change.status).toBe(200);
    expect(remove.status).toBe(204);
    await expect(leseAudit(database)).resolves.toEqual(expect.arrayContaining([
      { actor_user_id: platformId, actor_kind: "platform_admin", action: "mitglied.hinzugefuegt", channel_id: "kanal-a" },
      { actor_user_id: platformId, actor_kind: "platform_admin", action: "mitglied.rolle_geaendert", channel_id: "kanal-a" },
      { actor_user_id: platformId, actor_kind: "platform_admin", action: "mitglied.entfernt", channel_id: "kanal-a" },
    ]));
    await expect(leseAudit(database)).resolves.toHaveLength(3);
  });

  it("sets and clears full consent with an audit entry in the affected channel", async () => {
    await setPlatform(database);
    await insertChannel(database, "kanal-a");

    const setzen = await platformRouter.fetch(
      await requestFor(platformId, "/api/platform/channels/kanal-a", "PATCH", { fullConsent: true }),
      environment,
    );
    const resolve = await platformRouter.fetch(
      await requestFor(platformId, "/api/platform/channels/kanal-a", "PATCH", { fullConsent: false }),
      environment,
    );

    expect(setzen.status).toBe(200);
    expect(resolve.status).toBe(200);
    await expect(database.prepare(
      "SELECT full_consent FROM channels WHERE channel_id = ?",
    ).bind("kanal-a").first()).resolves.toEqual({ full_consent: 0 });
    await expect(leseAudit(database)).resolves.toEqual(expect.arrayContaining([
      { actor_user_id: platformId, actor_kind: "platform_admin", action: "kanal.vollzustimmung_geaendert", channel_id: "kanal-a" },
    ]));
    await expect(leseAudit(database)).resolves.toHaveLength(2);
  });

  it("denies setting, changing, and deleting any broadcaster row", async () => {
    await setPlatform(database);
    await insertChannel(database, "kanal-a");
    await insertMember(database, "kanal-a", "kanal-a", "broadcaster");

    const setzen = await platformRouter.fetch(
      await requestFor(platformId, "/api/platform/channels/kanal-a/members", "POST", {
        userId: "user-2",
        role: "broadcaster",
      }),
      environment,
    );
    const change = await platformRouter.fetch(
      await requestFor(platformId, "/api/platform/channels/kanal-a/members/kanal-a", "PATCH", {
        role: "operator",
      }),
      environment,
    );
    const deleteResponse = await platformRouter.fetch(
      await requestFor(platformId, "/api/platform/channels/kanal-a/members/kanal-a", "DELETE"),
      environment,
    );

    expect(setzen.status).toBe(403);
    expect(change.status).toBe(403);
    expect(deleteResponse.status).toBe(403);
    await expect(database.prepare(
      "SELECT role FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "kanal-a").first()).resolves.toEqual({ role: "broadcaster" });
    await expect(leseAudit(database)).resolves.toEqual([]);
  });

  it("also enforces the broadcaster lock in the SQL mutations", async () => {
    await setPlatform(database);
    await insertChannel(database, "kanal-a");
    await insertMember(database, "kanal-a", "kanal-a", "broadcaster");
    await insertMember(database, "kanal-a", "user-2", "operator");
    const actor = { userId: platformId, sessionId: `session-${platformId}` };
    const timestamp = "2026-09-18T00:30:00.000Z";

    await expect(addPlatformMember(database as unknown as D1Database, actor, {
      channelId: "kanal-a",
      userId: "user-3",
      role: "broadcaster",
      createdAt: timestamp,
      updatedAt: timestamp,
    }, timestamp)).resolves.toBe(false);
    const vorher = await database.prepare(
      "SELECT channel_id, user_id, role, created_at, updated_at FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "user-2").first<{
      channel_id: string;
      user_id: string;
      role: "broadcaster" | "manager" | "operator";
      created_at: string;
      updated_at: string;
    }>();
    expect(vorher).not.toBeNull();
    if (vorher === null) throw new Error("Testmitglied fehlt.");
    const previousMember = {
      channelId: vorher.channel_id,
      userId: vorher.user_id,
      role: vorher.role,
      createdAt: vorher.created_at,
      updatedAt: vorher.updated_at,
    };
    await expect(changePlatformMember(
      database as unknown as D1Database,
      actor,
      previousMember,
      { ...previousMember, role: "broadcaster", updatedAt: timestamp },
      timestamp,
    )).resolves.toBe(false);
    const broadcaster = {
      channelId: "kanal-a",
      userId: "kanal-a",
      role: "broadcaster" as const,
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-18T00:00:00.000Z",
    };
    await expect(removePlatformMember(
      database as unknown as D1Database,
      actor,
      broadcaster,
      timestamp,
    )).resolves.toBe(false);
    await expect(leseAudit(database)).resolves.toEqual([]);
    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM channel_members WHERE channel_id = ?",
    ).bind("kanal-a").first()).resolves.toEqual({ count: 2 });
  });

  it("writes no audit row after a denied mutation", async () => {
    await setPlatform(database);
    await insertChannel(database, "kanal-a");
    await insertMember(database, "kanal-a", "kanal-a", "broadcaster");
    await insertMember(database, "kanal-a", "user-2", "operator");
    const basis = database as unknown as D1Database;
    const racingDatabase = {
      prepare: basis.prepare.bind(basis),
      batch: async (anweisungen: Parameters<D1Database["batch"]>[0]) => {
        database.prepare(
          "UPDATE auth_sessions SET revoked_at = ? WHERE session_id = ?",
    ).bind("2026-09-18T00:30:00.000Z", `session-${platformId}`).runSync();
        return basis.batch(anweisungen);
      },
    } as unknown as D1Database;
    environment = { ...environment, DB: racingDatabase };

    const response = await platformRouter.fetch(
      await requestFor(platformId, "/api/platform/channels/kanal-a/members/user-2", "PATCH", {
        role: "manager",
      }),
      environment,
    );

    expect(response.status).toBe(409);
    await expect(leseAudit(database)).resolves.toEqual([]);
    await expect(database.prepare(
      "SELECT role FROM channel_members WHERE channel_id = ? AND user_id = ?",
    ).bind("kanal-a", "user-2").first()).resolves.toEqual({ role: "operator" });
  });

  it("resolves member names via the existing Helix resolution", async () => {
    await setPlatform(database);
    await insertChannel(database, "kanal-a");
    await insertMember(database, "kanal-a", "kanal-a", "broadcaster");
    await insertMember(database, "kanal-a", "user-2", "operator");
    await setBotIdentity(database);
    vi.mocked(fetch).mockResolvedValueOnce(responseFromHelix([
      { id: "kanal-a", login: "alpha", display_name: "Alpha" },
      { id: "user-2", login: "helfer", display_name: "Helfer", profile_image_url: "https://cdn.example/helfer.png" },
    ]));

    const response = await platformRouter.fetch(
      await requestFor(platformId, "/api/platform/channels/kanal-a/members"),
      environment,
    );
    const body = await response.json<{ members: Array<Record<string, unknown>> }>();

    expect(response.status).toBe(200);
    expect(body.members).toEqual([
      { userId: "kanal-a", login: "alpha", displayName: "Alpha", profileImageUrl: null, role: "broadcaster", joinedAt: "2026-09-18T00:00:00.000Z" },
      { userId: "user-2", login: "helfer", displayName: "Helfer", profileImageUrl: "https://cdn.example/helfer.png", role: "operator", joinedAt: "2026-09-18T00:00:00.000Z" },
    ]);
  });

  it("lists only platform-admin audit entries across channels, paginated", async () => {
    await setPlatform(database);
    await insertChannel(database, "kanal-a");
    await insertMember(database, "kanal-a", "kanal-a", "broadcaster");
    await insertMember(database, "kanal-a", "user-2", "operator");
    await database.prepare(
      `INSERT INTO audit_log
        (audit_id, actor_user_id, created_at, channel_id, module_id, action, before_json, after_json, actor_kind)
       VALUES (?, ?, ?, ?, NULL, ?, '{}', '{}', ?)`,
    ).bind("audit-mitglied", "mitglied", "2026-09-18T00:00:01.000Z", "kanal-a", "mitglied.entfernt", "member").run();
    await database.prepare(
      `INSERT INTO audit_log
        (audit_id, actor_user_id, created_at, channel_id, module_id, action, before_json, after_json, actor_kind)
       VALUES (?, ?, ?, ?, NULL, ?, '{}', '{}', ?)`,
    ).bind("audit-betreiber-1", "betreiber", "2026-09-18T00:00:02.000Z", "kanal-a", "mitglied.hinzugefuegt", "platform_admin").run();
    await database.prepare(
      `INSERT INTO audit_log
        (audit_id, actor_user_id, created_at, channel_id, module_id, action, before_json, after_json, actor_kind)
       VALUES (?, ?, ?, ?, NULL, ?, '{}', '{}', ?)`,
    ).bind("audit-betreiber-2", "betreiber", "2026-09-18T00:00:03.000Z", "kanal-a", "kanal.vollzustimmung_geaendert", "platform_admin").run();

    const firstResponse = await platformRouter.fetch(
      await requestFor(platformId, "/api/platform/audit?limit=1"),
      environment,
    );
    const firstPage = await firstResponse.json<{ entries: Array<Record<string, unknown>>; nextCursor: string | null }>();
    const secondResponse = await platformRouter.fetch(
      await requestFor(platformId, `/api/platform/audit?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor ?? "")}`),
      environment,
    );
    const secondPage = await secondResponse.json<{ entries: Array<Record<string, unknown>>; nextCursor: string | null }>();

    expect(firstPage.entries).toHaveLength(1);
    expect(firstPage.entries[0]).toMatchObject({ auditId: "audit-betreiber-2", actorKind: "platform_admin", channelId: "kanal-a" });
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(secondPage.entries).toHaveLength(1);
    expect(secondPage.entries[0]).toMatchObject({ auditId: "audit-betreiber-1", actorKind: "platform_admin" });
    expect(secondPage.nextCursor).toBeNull();
  });

  it("resolves platform-admin audit actors in bulk and keeps unresolved ids", async () => {
    await setPlatform(database);
    await insertChannel(database, "kanal-a");
    await insertMember(database, "kanal-a", "kanal-a", "broadcaster");
    await setBotIdentity(database);
    await database.prepare(
      `INSERT INTO audit_log
        (audit_id, actor_user_id, created_at, channel_id, module_id, action, before_json, after_json, actor_kind)
       VALUES (?, ?, ?, ?, NULL, ?, '{}', '{}', ?), (?, ?, ?, ?, NULL, ?, '{}', '{}', ?)`,
    ).bind(
      "audit-aufgelöst", "betreiber", "2026-09-18T00:00:02.000Z", "kanal-a", "kanal.freigegeben", "platform_admin",
      "audit-ungelöst", "gelöscht", "2026-09-18T00:00:01.000Z", "kanal-a", "kanal.vollzustimmung_geaendert", "platform_admin",
    ).run();
    const twitch = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(url.pathname).toBe("/helix/users");
      expect(url.searchParams.getAll("id")).toEqual(["betreiber", "gelöscht"]);
      return Promise.resolve(responseFromHelix([{ id: "betreiber", login: "esembe", display_name: "Esembe" }]));
    });
    vi.stubGlobal("fetch", twitch);

    const response = await platformRouter.fetch(
      await requestFor(platformId, "/api/platform/audit"),
      environment,
    );
    const body = await response.json<{ entries: Array<Record<string, unknown>> }>();

    expect(response.status).toBe(200);
    expect(twitch).toHaveBeenCalledTimes(1);
    expect(body.entries).toEqual([
      expect.objectContaining({ actorUserId: "betreiber", actorLogin: "esembe", actorDisplayName: "Esembe", actorKind: "platform_admin" }),
      expect.objectContaining({ actorUserId: "gelöscht", actorLogin: null, actorDisplayName: null, actorKind: "platform_admin" }),
    ]);
  });
});
