import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { createSessionCookie } from "../../src/worker/auth/session";
import { purgeOldEventLogEntries, writeModuleDiagnostics } from "../../src/worker/event-log";
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

/** Inserts many rows in one D1 batch -- fast enough to exercise the 10000 cap. */
const bulkInsertEvents = async (
  database: TestD1Database,
  channelId: string,
  count: number,
  baseTime: string,
): Promise<void> => {
  const statements = Array.from({ length: count }, (_, index) => {
    const eventId = `${channelId}-${String(index).padStart(5, "0")}`;
    return database.prepare(
      `INSERT INTO event_log
        (event_id, channel_id, created_at, module_id, code, detail_json, actor_user_id, trigger_id)
       VALUES (?, ?, ?, 'raid', ?, '{}', NULL, ?)`,
    ).bind(
      eventId,
      channelId,
      new Date(Date.parse(baseTime) + index * 1000).toISOString(),
      `code-${String(index).padStart(5, "0")}`,
      eventId,
    );
  });
  await database.batch(statements);
};

const insertCustomEvent = async (
  database: TestD1Database,
  eventId: string,
  channelId: string,
  moduleId: string,
  code: string,
  actorUserId: string | null = null,
  createdAt = "2026-09-18T04:00:00.000Z",
): Promise<void> => {
  await database.prepare(
    `INSERT INTO event_log
      (event_id, channel_id, created_at, module_id, code, detail_json, actor_user_id, trigger_id)
     VALUES (?, ?, ?, ?, ?, '{}', ?, ?)`,
  ).bind(eventId, channelId, createdAt, moduleId, code, actorUserId, eventId).run();
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

describe("event log", () => {
  let database: TestD1Database;

  beforeEach(() => {
    database = new TestD1Database();
  });

  afterEach(() => {
    database.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("logs a decision without an action along with its justification", async () => {
    await insertChannel(database, "kanal-a");

    await writeModuleDiagnostics(
      database as unknown as D1Database,
      "kanal-a",
      "raid",
      "trigger-raid-1",
      null,
      [{
        code: "shoutout.suppressed",
        detail: { reason: "raid_erkannt", viewers: 8, threshold: 10 },
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
      code: "shoutout.suppressed",
      detail_json: '{"reason":"raid_erkannt","viewers":8,"threshold":10}',
      actor_user_id: null,
      trigger_id: "trigger-raid-1",
    });
  });

  it("caps an unbounded diagnostic message at 300 characters with an ellipsis, leaving everything else untouched (issue #201)", async () => {
    await insertChannel(database, "kanal-a");
    const longTwitchMessage = "x".repeat(400);
    const longLocalMessage = "y".repeat(350);

    await writeModuleDiagnostics(
      database as unknown as D1Database,
      "kanal-a",
      "ads",
      "trigger-cap",
      null,
      [
        { code: "ads.commercial.failed", detail: { reason: "twitch_error", status: 400, twitchMessage: longTwitchMessage } },
        { code: "ads.commercial.failed", detail: { reason: "app_token_unavailable", message: longLocalMessage } },
        { code: "host.shoutout.sent", detail: { status: 204 } },
      ],
      "2026-09-18T04:00:00.000Z",
    );

    const rows = await database.prepare(
      "SELECT detail_json FROM event_log WHERE channel_id = ? ORDER BY rowid",
    ).bind("kanal-a").all<{ detail_json: string }>();
    const details = rows.results.map((row) => JSON.parse(row.detail_json) as Record<string, unknown>);

    expect((details[0]?.twitchMessage as string).length).toBe(300);
    expect(details[0]?.twitchMessage).toBe(`${"x".repeat(299)}…`);
    expect(details[0]?.status).toBe(400);
    expect(details[0]?.reason).toBe("twitch_error");

    expect((details[1]?.message as string).length).toBe(300);
    expect(details[1]?.message).toBe(`${"y".repeat(299)}…`);

    expect(details[2]).toEqual({ status: 204 });
  });

  it("leaves a diagnostic message at or under 300 characters exactly as written", async () => {
    await insertChannel(database, "kanal-a");
    const shortMessage = "The broadcaster is not streaming live or does not have one or more viewers.";

    await writeModuleDiagnostics(
      database as unknown as D1Database,
      "kanal-a",
      "host",
      "trigger-short",
      null,
      [{ code: "host.shoutout.failed", detail: { cause: "twitch_error", twitchMessage: shortMessage } }],
      "2026-09-18T04:00:00.000Z",
    );

    const row = await database.prepare(
      "SELECT detail_json FROM event_log WHERE channel_id = ?",
    ).bind("kanal-a").first<{ detail_json: string }>();
    expect((JSON.parse(row?.detail_json ?? "{}") as { twitchMessage: string }).twitchMessage).toBe(shortMessage);
  });

  it("creates no row on empty diagnostics and starts no batch", async () => {
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

  it("stores the same trigger for multiple host diagnostics", async () => {
    await insertChannel(database, "kanal-a");

    await writeModuleDiagnostics(
      database as unknown as D1Database,
      "kanal-a",
      "raid",
      "trigger-raid-2",
      null,
      [
        { code: "chat.gesendet", detail: { message: "shoutout" } },
        { code: "shoutout.fehlgeschlagen", detail: { cause: "429" } },
      ],
      "2026-09-18T04:00:00.000Z",
    );

    const rows = await database.prepare(
      "SELECT code, trigger_id, detail_json FROM event_log ORDER BY event_id",
    ).all<{ code: string; trigger_id: string; detail_json: string }>();

    expect(rows.results).toHaveLength(2);
    expect(rows.results).toEqual(expect.arrayContaining([
      { code: "chat.gesendet", trigger_id: "trigger-raid-2", detail_json: '{"message":"shoutout"}' },
      { code: "shoutout.fehlgeschlagen", trigger_id: "trigger-raid-2", detail_json: '{"cause":"429"}' },
    ]));
  });

 it("no longer trims on insert, however many rows the channel already has", async () => {
   await insertChannel(database, "kanal-a");
   const batch = vi.spyOn(database, "batch");

   await writeModuleDiagnostics(
     database as unknown as D1Database,
     "kanal-a",
     "raid",
     "trigger-1",
     null,
     [{ code: "code-a" }, { code: "code-b" }],
     "2026-09-18T04:00:00.000Z",
   );

   // Exactly one statement per diagnostic in the batch -- no trailing trim.
   expect(batch.mock.calls[0]?.[0]).toHaveLength(2);

   const rows = await database.prepare(
     "SELECT code FROM event_log WHERE channel_id = ? ORDER BY created_at",
   ).bind("kanal-a").all<{ code: string }>();
   expect(rows.results).toEqual([{ code: "code-a" }, { code: "code-b" }]);
 });

  it("cleans up only events older than 14 days in the hourly cron", async () => {
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

  it("trims every channel to the newest 10000 rows, only in its scheduled hour", async () => {
    vi.useFakeTimers();
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    const base = "2026-09-17T00:00:00.000Z";
    await bulkInsertEvents(database, "kanal-a", 10003, base);
    await bulkInsertEvents(database, "kanal-b", 5, base);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ access_token: "scheduled-token", expires_in: 7200 }),
      { status: 200 },
    )));
    const run = async (): Promise<void> => {
      await scheduled(
        {} as ScheduledController,
        makeEnvironment(database),
        { waitUntil: vi.fn() } as unknown as ExecutionContext,
      );
    };
    const countFor = async (channelId: string): Promise<number> => {
      const row = await database.prepare(
        "SELECT COUNT(*) AS count FROM event_log WHERE channel_id = ?",
      ).bind(channelId).first<{ count: number }>();
      return row?.count ?? 0;
    };

    // Outside the daily trim hour: the hourly 14-day purge runs, but the
    // count trim doesn't -- row counts are untouched.
    vi.setSystemTime(new Date("2026-09-18T12:00:00.000Z"));
    await run();
    expect(await countFor("kanal-a")).toBe(10003);
    expect(await countFor("kanal-b")).toBe(5);

    // In the trim hour: kanal-a is capped to the newest 10000, kanal-b
    // (already under the cap) is untouched.
    vi.setSystemTime(new Date("2026-09-18T03:00:00.000Z"));
    await run();

    const afterTrim = await database.prepare(
      "SELECT code FROM event_log WHERE channel_id = ? ORDER BY created_at",
    ).bind("kanal-a").all<{ code: string }>();
    expect(afterTrim.results).toHaveLength(10000);
    expect(afterTrim.results[0]?.code).toBe("code-00003");
    expect(afterTrim.results.at(-1)?.code).toBe("code-10002");
    expect(await countFor("kanal-b")).toBe(5);
  });

  it("uses the created_at index for event cleanup", async () => {
    const preparedSql: string[] = [];
    const tracedDatabase = {
      prepare: (sql: string) => {
        preparedSql.push(sql);
        return database.prepare(sql);
      },
      batch: database.batch.bind(database),
    } as unknown as D1Database;
    await purgeOldEventLogEntries(tracedDatabase, "2026-09-18T12:00:00.000Z");
    const deleteSql = preparedSql.find((sql) => sql.includes("DELETE FROM event_log"));
    expect(deleteSql).toBeDefined();
    const plan = database.sqlite.prepare(
      `EXPLAIN QUERY PLAN ${deleteSql ?? ""}`,
    ).all("2026-09-04T12:00:00.000Z") as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail).join(" ");

    expect(details).toMatch(/USING (?:COVERING )?INDEX event_log_created_at_idx/);
    expect(details).not.toContain("SCAN event_log");
  });

 it("lets an operator read events page by page", async () => {
   await insertChannel(database, "kanal-a");
   await insertLoginIdentityAndSession(database, "user-1");
   await insertMember(database, "kanal-a", "user-1", "operator");
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

  it("returns a channel-scoped sequence high-water mark in head mode", async () => {
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertChannel(database, "kanal-c");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await insertMember(database, "kanal-b", "user-1", "operator");
    await insertMember(database, "kanal-c", "user-1", "operator");
    await insertEvent(database, "a-1", "kanal-a", "2026-09-18T04:00:00.000Z");
    const channelASequence = await database.prepare("SELECT MAX(seq) AS seq FROM event_log WHERE channel_id = 'kanal-a'").first<{ seq: number }>();
    await insertEvent(database, "b-1", "kanal-b", "2026-09-18T04:00:00.000Z");

    const responseA = await panelRouter.fetch(await makeRequest("user-1", "/api/channels/kanal-a/events"), makeEnvironment(database));
    const responseEmpty = await panelRouter.fetch(await makeRequest("user-1", "/api/channels/kanal-c/events"), makeEnvironment(database));
    const headA = await responseA.json<{ headCursor: number }>();
    const empty = await responseEmpty.json<{ headCursor: number; entries: unknown[] }>();
    const channelBMaximum = await database.prepare("SELECT MAX(seq) AS seq FROM event_log WHERE channel_id = 'kanal-b'").first<{ seq: number }>();

    expect(responseA.status).toBe(200);
    expect(headA.headCursor).toBe(channelASequence?.seq);
    expect(channelBMaximum?.seq).toBeGreaterThan(headA.headCursor);
    expect(responseEmpty.status).toBe(200);
    expect(empty).toMatchObject({ entries: [], headCursor: 0 });
  });

  it("returns channel max for an empty head and includes late inserts in sequence deltas", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    const emptyResponse = await panelRouter.fetch(await makeRequest("user-1", "/api/channels/kanal-a/events"), makeEnvironment(database));
    const emptyHead = await emptyResponse.json<{ entries: unknown[]; headCursor: number }>();
    await insertEvent(database, "recent", "kanal-a", "2026-09-18T04:00:00.000Z");
    const firstHeadResponse = await panelRouter.fetch(await makeRequest("user-1", "/api/channels/kanal-a/events"), makeEnvironment(database));
    const firstHead = await firstHeadResponse.json<{ headCursor: number }>();
    await insertEvent(database, "late", "kanal-a", "2020-01-01T00:00:00.000Z");

    const deltaResponse = await panelRouter.fetch(
      await makeRequest("user-1", `/api/channels/kanal-a/events?after=${String(firstHead.headCursor)}&limit=100`),
      makeEnvironment(database),
    );
    const delta = await deltaResponse.json<{ entries: Array<{ eventId: string }>; headCursor: number; hasMore: boolean }>();

    expect(emptyHead).toMatchObject({ entries: [], headCursor: 0 });
    expect(deltaResponse.status).toBe(200);
    expect(delta.entries.map((entry) => entry.eventId)).toEqual(["late"]);
    expect(delta.headCursor).toBeGreaterThan(firstHead.headCursor);
    expect(delta.hasMore).toBe(false);
  });

  it("applies every event filter to sequence changes and still advances for no matches", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await insertCustomEvent(database, "channel-info", "kanal-a", "channel_events", "channel_events.stream.online");
    await insertCustomEvent(database, "module-info", "kanal-a", "ads", "ads.announcement", "person-a");
    await insertCustomEvent(database, "module-error", "kanal-a", "text_commands", "host.chat.failed", "person-b");
    const before = await database.prepare("SELECT MAX(seq) AS seq FROM event_log WHERE channel_id = 'kanal-a'").first<{ seq: number }>();

    const requests = [
      ["origin=channel", ["channel-info"]],
      ["origin=module", ["module-info", "module-error"]],
      ["module=ads", ["module-info"]],
      ["tone=error", ["module-error"]],
      ["tone=info&tone=error", ["channel-info", "module-info", "module-error"]],
      ["actor=person-b", ["module-error"]],
      ["actor=nobody", []],
    ] as const;
    const results = await Promise.all(requests.map(async ([filters, expected]) => {
      const response = await panelRouter.fetch(
        await makeRequest("user-1", `/api/channels/kanal-a/events?after=0&limit=100&${filters}`),
        makeEnvironment(database),
      );
      const body = await response.json<{ entries: Array<{ eventId: string }>; headCursor: number }>();
      return {
        status: response.status,
        ids: body.entries.map((entry) => entry.eventId).sort((left, right) => left.localeCompare(right)),
        expected: [...expected].sort((left, right) => left.localeCompare(right)),
        cursor: body.headCursor,
      };
    }));

    for (const result of results) {
      expect(result.status).toBe(200);
      expect(result.ids).toEqual(result.expected);
      expect(result.cursor).toBe(before?.seq);
    }
  });

  it("pages sequence changes in order without gaps or duplicates", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await insertEvent(database, "one", "kanal-a", "2026-09-18T04:00:00.000Z");
    await insertEvent(database, "two", "kanal-a", "2026-09-18T04:00:00.000Z");
    await insertEvent(database, "three", "kanal-a", "2026-09-18T04:00:00.000Z");

    const firstResponse = await panelRouter.fetch(await makeRequest("user-1", "/api/channels/kanal-a/events?after=0&limit=2"), makeEnvironment(database));
    const first = await firstResponse.json<{ entries: Array<{ eventId: string }>; headCursor: number; hasMore: boolean }>();
    const secondResponse = await panelRouter.fetch(
      await makeRequest("user-1", `/api/channels/kanal-a/events?after=${String(first.headCursor)}&limit=2`),
      makeEnvironment(database),
    );
    const second = await secondResponse.json<{ entries: Array<{ eventId: string }>; headCursor: number; hasMore: boolean }>();

    expect(first.entries.map((entry) => entry.eventId)).toEqual(["one", "two"]);
    expect(first.hasMore).toBe(true);
    expect(first.headCursor).toBeLessThan(second.headCursor);
    expect(second.entries.map((entry) => entry.eventId)).toEqual(["three"]);
    expect(second.hasMore).toBe(false);
    expect([...first.entries, ...second.entries].map((entry) => entry.eventId)).toEqual(["one", "two", "three"]);
  });

  it("keeps the delta cursor monotonic after highest-row and all-row deletion", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await insertEvent(database, "one", "kanal-a", "2026-09-18T04:00:00.000Z");
    await insertEvent(database, "two", "kanal-a", "2026-09-18T04:00:00.000Z");
    const previousMaximum = await database.prepare("SELECT MAX(seq) AS seq FROM event_log WHERE channel_id = 'kanal-a'").first<{ seq: number }>();
    await database.prepare("DELETE FROM event_log WHERE event_id = 'two'").run();
    await database.prepare("DELETE FROM event_log WHERE event_id = 'one'").run();
    const emptyDeltaResponse = await panelRouter.fetch(
      await makeRequest("user-1", `/api/channels/kanal-a/events?after=${String(previousMaximum?.seq)}`),
      makeEnvironment(database),
    );
    const emptyDelta = await emptyDeltaResponse.json<{ headCursor: number; entries: unknown[] }>();
    await insertEvent(database, "three", "kanal-a", "2020-01-01T00:00:00.000Z");
    const nextResponse = await panelRouter.fetch(
      await makeRequest("user-1", `/api/channels/kanal-a/events?after=${String(emptyDelta.headCursor)}`),
      makeEnvironment(database),
    );
    const next = await nextResponse.json<{ headCursor: number; entries: Array<{ eventId: string }> }>();

    expect(emptyDelta.headCursor).toBe(previousMaximum?.seq);
    expect(emptyDelta.entries).toEqual([]);
    expect(next.entries.map((entry) => entry.eventId)).toEqual(["three"]);
    expect(next.headCursor).toBeGreaterThan(emptyDelta.headCursor);
  });

  it("continues keyset history after retention deletes a row between pages", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await insertEvent(database, "first", "kanal-a", "2026-09-18T04:00:00.000Z");
    await insertEvent(database, "second", "kanal-a", "2026-09-18T03:00:00.000Z");
    await insertEvent(database, "third", "kanal-a", "2026-09-18T02:00:00.000Z");
    const firstResponse = await panelRouter.fetch(await makeRequest("user-1", "/api/channels/kanal-a/events?limit=1"), makeEnvironment(database));
    const first = await firstResponse.json<{ entries: Array<{ eventId: string }>; nextCursor: string }>();
    await database.prepare("DELETE FROM event_log WHERE event_id = 'second'").run();
    const secondResponse = await panelRouter.fetch(
      await makeRequest("user-1", `/api/channels/kanal-a/events?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`),
      makeEnvironment(database),
    );
    const second = await secondResponse.json<{ entries: Array<{ eventId: string }> }>();

    expect(first.entries.map((entry) => entry.eventId)).toEqual(["first"]);
    expect(secondResponse.status).toBe(200);
    expect(second.entries.map((entry) => entry.eventId)).toEqual(["third"]);
  });

  it("rejects invalid after cursors and cursor-after combinations with the usual authorization guard", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await insertLoginIdentityAndSession(database, "user-2");
    const invalidQueries = [
      "cursor=abc&after=1",
      "after=abc",
      "after=-1",
      "after=9007199254740992",
    ];
    const statuses = await Promise.all(invalidQueries.map(async (query) => (await panelRouter.fetch(
      await makeRequest("user-1", `/api/channels/kanal-a/events?${query}`),
      makeEnvironment(database),
    )).status));
    const nonMember = await panelRouter.fetch(
      await makeRequest("user-2", "/api/channels/kanal-a/events?after=abc"),
      makeEnvironment(database),
    );
    const ordinaryHead = await panelRouter.fetch(await makeRequest("user-2", "/api/channels/kanal-a/events"), makeEnvironment(database));

    expect(statuses).toEqual([400, 400, 400, 400]);
    expect(nonMember.status).toBe(ordinaryHead.status);
  });

  it("resolves a stored actor via Twitch and keeps the ID", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "viewer-1");
    await insertMember(database, "kanal-a", "viewer-1", "operator");
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

  it("falls back to the actor ID when Twitch resolution is missing", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "viewer-1");
    await insertMember(database, "kanal-a", "viewer-1", "operator");
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

  it("filters origin, module, tone, and person in the channel-scoped query", async () => {
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "viewer-1");
    await insertMember(database, "kanal-a", "viewer-1", "operator");
    await insertCustomEvent(database, "channel-event", "kanal-a", "channel_events", "channel_events.raid.incoming");
    await insertCustomEvent(database, "channel-stream-event", "kanal-a", "channel_events", "channel_events.stream.offline");
    await insertCustomEvent(database, "module-event", "kanal-a", "text_commands", "text_commands.triggered", "person-a");
    await insertCustomEvent(database, "error-event", "kanal-a", "text_commands", "host.chat.failed", "person-a");
    await insertCustomEvent(database, "warning-event", "kanal-a", "raid", "raid.invalid");
    await insertCustomEvent(database, "info-event", "kanal-a", "text_commands", "host.chat.sent", "person-b");
    await insertCustomEvent(database, "other-channel-event", "kanal-b", "channel_events", "channel_events.raid.incoming");

    const request = async (query: string) => panelRouter.fetch(
      await makeRequest("viewer-1", `/api/channels/kanal-a/events?${query}`),
      makeEnvironment(database),
    );
    const eventIds = async (query: string): Promise<string[]> => {
      const response = await request(query);
      const body = await response.json<{ entries: Array<{ eventId: string }> }>();
      expect(response.status).toBe(200);
      return body.entries.map((entry) => entry.eventId);
    };

    await expect(eventIds("origin=channel")).resolves.toEqual(["channel-stream-event", "channel-event"]);
    await expect(eventIds("module=text_commands")).resolves.toEqual(["module-event", "info-event", "error-event"]);
    await expect(eventIds("tone=error")).resolves.toEqual(["error-event"]);
    await expect(eventIds("tone=warning&tone=error")).resolves.toEqual(["warning-event", "error-event"]);
    await expect(eventIds("actor=person-a")).resolves.toEqual(["module-event", "error-event"]);
    await expect(eventIds("module=text_commands&tone=error")).resolves.toEqual(["error-event"]);
    await expect(eventIds("module=werbung&actor=person-a")).resolves.toEqual([]);
  });

  it("keeps even a filtered event query strictly within the requested channel", async () => {
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await insertCustomEvent(database, "fremd", "kanal-b", "text_commands", "host.chat.sent", "person-a");

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-b/events?origin=module&actor=person-a"),
      makeEnvironment(database),
    );

    expect(response.status).toBe(403);
  });

  it("denies events from a different channel with 403", async () => {
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-b/events"),
      makeEnvironment(database),
    );

    expect(response.status).toBe(403);
  });
});
