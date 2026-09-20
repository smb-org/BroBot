import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { createSessionCookie } from "../../src/worker/auth/session";
import { writeModuleDiagnostics } from "../../src/worker/event-log";
import { panelRouter } from "../../src/worker/panel/routes";
import { scheduled } from "../../src/worker/scheduled";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

const environmentKeys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE" }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI" }, retired: [] }),
};

const insertEvent = async (
  database: TestD1Database,
  eventId: string,
  channelId: string,
  createdAt: string,
  actorUserId: string | null = null,
  triggerId = eventId,
): Promise<void> => {
  await database.prepare(
    `INSERT INTO event_log
      (event_id, channel_id, created_at, module_id, code, detail_json, actor_user_id, trigger_id)
     VALUES (?, ?, ?, 'raid', 'test', '{}', ?, ?)`,
  ).bind(eventId, channelId, createdAt, actorUserId, triggerId).run();
};

const insertBotIdentity = async (database: TestD1Database): Promise<void> => {
  const accessTokenCiphertext = await encryptJson(
    { token: "access-token" },
    parseKeyRing(environmentKeys.SESSION_ENCRYPTION_KEYS),
  );
  await database.prepare(
    `INSERT INTO bot_identity
      (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
       expires_at, created_at, updated_at)
     VALUES (1, 'bot-id', 'brobot', '[]', ?, 'refresh', ?, ?, ?)`,
  ).bind(
    accessTokenCiphertext,
    "2099-09-19T00:00:00.000Z",
    "2026-09-01T00:00:00.000Z",
    "2026-09-01T00:00:00.000Z",
  ).run();
};

const makeEnvironment = (database: TestD1Database): Env => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  ...environmentKeys,
} as Env);

const makeRequest = async (userId: string, path: string): Promise<Request> => {
  const cookie = await createSessionCookie(
    { sessionId: `session-${userId}` },
    environmentKeys.SESSION_COOKIE_KEYS,
    environmentKeys.SESSION_ENCRYPTION_KEYS,
  );
  return new Request(`https://brobot.example${path}`, {
    headers: { Cookie: `__Host-brobot_session=${cookie}` },
  });
};

const requestUrl = (input: RequestInfo | URL): URL => input instanceof URL
  ? input
  : typeof input === "string" ? new URL(input) : new URL(input.url);

describe("Ereignisprotokoll", () => {
  let database: TestD1Database;

  beforeEach(() => {
    database = new TestD1Database();
  });

  afterEach(() => {
    database.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("protokolliert eine Entscheidung ohne Aktion mit ihrer Begründung", async () => {
    await insertChannel(database, "kanal-a");

    await writeModuleDiagnostics(
      database as unknown as D1Database,
      "kanal-a",
      "raid",
      "trigger-raid-1",
      null,
      [{
        code: "shoutout.unterdrueckt",
        detail: { grund: "raid_erkannt", zuschauer: 8, schwelle: 10 },
      }],
      "2026-09-18T04:00:00.000Z",
    );

    const row = await database.prepare(
      `SELECT module_id, code, detail_json, actor_user_id, trigger_id
         FROM event_log
        WHERE channel_id = ?`,
    ).bind("kanal-a").first<{
      module_id: string;
      code: string;
      detail_json: string;
      actor_user_id: string | null;
      trigger_id: string;
    }>();

    expect(row).toEqual({
      module_id: "raid",
      code: "shoutout.unterdrueckt",
      detail_json: '{"grund":"raid_erkannt","zuschauer":8,"schwelle":10}',
      actor_user_id: null,
      trigger_id: "trigger-raid-1",
    });
  });

  it("legt bei leeren Diagnosen keine Zeile an und startet keinen Batch", async () => {
    await insertChannel(database, "kanal-a");
    const batch = vi.spyOn(database, "batch");

    await writeModuleDiagnostics(
      database as unknown as D1Database,
      "kanal-a",
      "raid",
      "trigger-empty",
      null,
      [],
      "2026-09-18T04:00:00.000Z",
    );

    expect(batch).not.toHaveBeenCalled();
    const row = await database.prepare("SELECT COUNT(*) AS count FROM event_log").first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  it("speichert denselben Auslöser für mehrere Host-Diagnosen", async () => {
    await insertChannel(database, "kanal-a");

    await writeModuleDiagnostics(
      database as unknown as D1Database,
      "kanal-a",
      "raid",
      "trigger-raid-2",
      null,
      [
        { code: "chat.gesendet", detail: { nachricht: "shoutout" } },
        { code: "shoutout.fehlgeschlagen", detail: { ursache: "429" } },
      ],
      "2026-09-18T04:00:00.000Z",
    );

    const rows = await database.prepare(
      "SELECT code, trigger_id, detail_json FROM event_log ORDER BY event_id",
    ).all<{ code: string; trigger_id: string; detail_json: string }>();

    expect(rows.results).toHaveLength(2);
    expect(rows.results).toEqual(expect.arrayContaining([
      { code: "chat.gesendet", trigger_id: "trigger-raid-2", detail_json: '{"nachricht":"shoutout"}' },
      { code: "shoutout.fehlgeschlagen", trigger_id: "trigger-raid-2", detail_json: '{"ursache":"429"}' },
    ]));
  });

 it("behält beim Schreiben je Kanal nur die 500 neuesten Zeilen", async () => {
   await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertEvent(database, "kanal-b-alt", "kanal-b", "2026-09-17T00:00:00.000Z");

    for (let index = 0; index <= 500; index += 1) {
      await writeModuleDiagnostics(
        database as unknown as D1Database,
        "kanal-a",
        "raid",
        `trigger-${String(index)}`,
        null,
        [{ code: `code-${String(index).padStart(3, "0")}` }],
        new Date(Date.parse("2026-09-18T00:00:00.000Z") + index * 1000).toISOString(),
      );
    }

    const rows = await database.prepare(
      "SELECT code FROM event_log WHERE channel_id = ? ORDER BY created_at",
    ).bind("kanal-a").all<{ code: string }>();

   expect(rows.results).toHaveLength(500);
   expect(rows.results[0]?.code).toBe("code-001");
   expect(rows.results.at(-1)?.code).toBe("code-500");
    const otherChannelRows = await database.prepare(
      "SELECT event_id FROM event_log WHERE channel_id = ?",
    ).bind("kanal-b").all<{ event_id: string }>();
    expect(otherChannelRows.results.map((row) => row.event_id)).toEqual(["kanal-b-alt"]);
 });

  it("räumt im stündlichen Cron nur Ereignisse älter als 14 Tage auf", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T12:00:00.000Z"));
    await insertChannel(database, "kanal-a");
    await insertEvent(database, "zu-alt", "kanal-a", "2026-09-04T11:59:59.000Z");
    await insertEvent(database, "grenze", "kanal-a", "2026-09-04T12:00:00.000Z");
    await insertEvent(database, "jung", "kanal-a", "2026-09-10T12:00:00.000Z");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ access_token: "scheduled-token", expires_in: 7200 }),
      { status: 200 },
    )));

    await scheduled(
      {} as ScheduledController,
      makeEnvironment(database),
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    const rows = await database.prepare(
      "SELECT event_id FROM event_log ORDER BY event_id",
    ).all<{ event_id: string }>();
    expect(rows.results.map((row) => row.event_id)).toEqual(["grenze", "jung"]);
  });

 it("lässt einen Bediener Ereignisse seitenweise lesen", async () => {
   await insertChannel(database, "kanal-a");
   await insertLoginIdentityAndSession(database, "user-1");
   await insertMember(database, "kanal-a", "user-1", "bediener");
    await insertEvent(database, "event-a", "kanal-a", "2026-09-18T04:00:00.000Z");
    await insertEvent(database, "event-b", "kanal-a", "2026-09-18T04:00:00.000Z");
    await insertEvent(database, "event-c", "kanal-a", "2026-09-18T04:00:00.000Z", "user-1");

   const firstResponse = await panelRouter.fetch(
     await makeRequest("user-1", "/api/channels/kanal-a/events?limit=1"),
     makeEnvironment(database),
   );
   const first = await firstResponse.json<{
      entries: Array<{
        eventId: string;
        code: string;
        detail: string;
        actorUserId: string | null;
        actorLogin: string | null;
        actorDisplayName: string | null;
      }>;
     nextCursor: string | null;
   }>();

   expect(firstResponse.status).toBe(200);
    expect(first.entries).toEqual([{
      eventId: "event-c",
      createdAt: "2026-09-18T04:00:00.000Z",
        moduleId: "raid",
        triggerId: "event-c",
        code: "test",
      detail: "{}",
      actorUserId: "user-1",
      actorLogin: null,
      actorDisplayName: null,
    }]);
   expect(first.nextCursor).toEqual(expect.any(String));
   const firstCursor = JSON.parse(atob((first.nextCursor ?? "").replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil((first.nextCursor ?? "").length / 4) * 4, "="))) as unknown;
   expect(firstCursor).toEqual({ createdAt: "2026-09-18T04:00:00.000Z", id: "event-c" });

   const secondResponse = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/events?limit=1&cursor=" + encodeURIComponent(first.nextCursor ?? "")),
     makeEnvironment(database),
   );
    const second = await secondResponse.json<{ entries: Array<{ eventId: string }>; nextCursor: string | null }>();

   expect(secondResponse.status).toBe(200);
    expect(second.entries).toEqual([expect.objectContaining({ eventId: "event-b" })]);
    expect(second.nextCursor).toEqual(expect.any(String));

    const thirdResponse = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/events?limit=1&cursor=" + encodeURIComponent(second.nextCursor ?? "")),
      makeEnvironment(database),
    );
    const third = await thirdResponse.json<{ entries: Array<{ eventId: string }>; nextCursor: string | null }>();

    expect(thirdResponse.status).toBe(200);
    expect(third.entries).toEqual([expect.objectContaining({ eventId: "event-a" })]);
    expect(third.nextCursor).toBeNull();
 });

  it("löst einen gespeicherten Akteur über Twitch auf und behält die ID", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "viewer-1");
    await insertMember(database, "kanal-a", "viewer-1", "bediener");
    await insertBotIdentity(database);
    await insertEvent(database, "event-actor", "kanal-a", "2026-09-18T04:00:00.000Z", "user-1");
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      expect(url.pathname).toBe("/helix/users");
      expect(url.searchParams.getAll("id")).toEqual(["user-1"]);
      return Response.json({ data: [{ id: "user-1", login: "alice", display_name: "Alice" }] });
    }));

    const response = await panelRouter.fetch(
      await makeRequest("viewer-1", "/api/channels/kanal-a/events"),
      makeEnvironment(database),
    );
    const body = await response.json<{ entries: Array<Record<string, unknown>> }>();

    expect(response.status).toBe(200);
    expect(body.entries[0]).toEqual(expect.objectContaining({
      actorUserId: "user-1",
      actorLogin: "alice",
      actorDisplayName: "Alice",
    }));
  });

  it("fällt bei fehlender Twitch-Auflösung auf die Akteur-ID zurück", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "viewer-1");
    await insertMember(database, "kanal-a", "viewer-1", "bediener");
    await insertBotIdentity(database);
    await insertEvent(database, "event-unresolved", "kanal-a", "2026-09-18T04:00:00.000Z", "user-1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Twitch down", { status: 503 })));

    const response = await panelRouter.fetch(
      await makeRequest("viewer-1", "/api/channels/kanal-a/events"),
      makeEnvironment(database),
    );
    const body = await response.json<{ entries: Array<Record<string, unknown>> }>();

    expect(response.status).toBe(200);
    expect(body.entries[0]).toEqual(expect.objectContaining({
      actorUserId: "user-1",
      actorLogin: null,
      actorDisplayName: null,
    }));
  });

  it("verweigert Ereignisse aus einem fremden Kanal mit 403", async () => {
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "bediener");

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-b/events"),
      makeEnvironment(database),
    );

    expect(response.status).toBe(403);
  });
});
