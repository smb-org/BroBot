import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleRegisteredTemplateVariable, ModuleRouteEnvironment } from "../../src/modules/contract";
import { timerRoutes } from "../../src/modules/timers/routes";
import { insertChannel } from "./fixtures";
import { createReadInterleavingDatabase, TestD1Database } from "./test-d1";

const CHANNEL_ID = "timers-route-channel";
const ACTOR_ID = "timers-route-actor";
const EVENT_SOURCE_ID = "sun.sunrise";
const databases: TestD1Database[] = [];

const createDatabase = async (): Promise<TestD1Database> => {
  const database = new TestD1Database();
  databases.push(database);
  await insertChannel(database, CHANNEL_ID);
  await database.prepare("INSERT INTO text_library_settings (channel_id, graph_revision, updated_at) VALUES (?, 1, ?)")
    .bind(CHANNEL_ID, "2026-01-01T00:00:00.000Z").run();
  await database.prepare("INSERT INTO text_library_categories (channel_id, category_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .bind(CHANNEL_ID, "custom", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z").run();
  await database.prepare("INSERT INTO text_blocks (channel_id, block_name, category_id, revision, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)")
    .bind(CHANNEL_ID, "welcome", "custom", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z").run();
  await database.prepare("INSERT INTO text_block_variants (channel_id, block_name, variant_id, position, conditions_json, texts_json) VALUES (?, ?, ?, 0, '{}', ?)")
    .bind(CHANNEL_ID, "welcome", "welcome-variant", JSON.stringify(["Welcome!"])).run();
  return database;
};

type ScheduledAlarm = { moduleId: string; handlerKey: string; alarmKey: string; deadline: number };

const raidViewersVariable = {
  name: "viewers",
  sample: "42",
  maxLength: 7,
  group: "event",
  moduleId: "raid",
  isTextBlock: false,
  contexts: ["event"],
  availableInEventTemplates: false,
} satisfies ModuleRegisteredTemplateVariable;

const appFor = (database: D1Database, variables: readonly ModuleRegisteredTemplateVariable[] = []): Hono<ModuleRouteEnvironment> => {
  const app = new Hono<ModuleRouteEnvironment>();
  app.use("*", async (context, next) => {
    context.set("channelRole", "manager");
    context.set("actor", { userId: ACTOR_ID, sessionId: "timers-route-session" });
    context.set("authorizeManagementMutation", () => ({ sql: "AND 1 = 1", values: [] }));
    context.set("prepareModuleAudit", () => database.prepare("SELECT 1"));
    context.set("listEventTimeSources", () => [{ id: EVENT_SOURCE_ID, label: { de: "Sonnenaufgang", en: "Sunrise" } }]);
    context.set("listRegisteredTemplateVariables", () => Promise.resolve(variables));
    // No occurrence within the source's own horizon -- the polar-night case
    // this route must not leave dormant.
    context.set("resolveEventTimes", () => Promise.resolve([]));
    await next();
  });
  app.route("/channels/:channelId", timerRoutes);
  return app;
};

const environmentFor = (database: D1Database, scheduled: ScheduledAlarm[]): Env => ({
  DB: database,
  CHANNEL: {
    idFromName: () => "channel-object",
    get: () => ({
      scheduleModuleAlarm: (moduleId: string, handlerKey: string, alarmKey: string, deadline: number) => {
        scheduled.push({ moduleId, handlerKey, alarmKey, deadline });
        return Promise.resolve();
      },
      clearModuleAlarm: () => Promise.resolve(),
    }),
  },
} as unknown as Env);

afterEach(() => {
  vi.useRealTimers();
  for (const database of databases.splice(0)) database.close();
});

describe("timer scheduling and validation routes", () => {
  it("arms an offline interval when the timer is saved while the channel is offline", async () => {
    const database = await createDatabase();
    await database.prepare(
      "INSERT INTO channel_stream_state (channel_id, state, changed_at, source) VALUES (?, 'offline', ?, 'eventsub')",
    ).bind(CHANNEL_ID, "2026-10-13T12:00:00.000Z").run();
    const scheduled: ScheduledAlarm[] = [];
    const app = appFor(database as unknown as D1Database);
    const now = Date.parse("2026-10-13T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/timers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Offline reminder",
        messageText: "See you in chat!",
        trigger: { type: "interval", offline: { minutes: 5, minimumMessages: 2 } },
      }),
    }), environmentFor(database as unknown as D1Database, scheduled));
    const body = await response.json<{ timer: { id: string; trigger: unknown; nextRunAt: string | null; nextRunState: string | null } }>();

    expect(response.status).toBe(201);
    expect(body.timer.trigger).toEqual({ type: "interval", offline: { minutes: 5, minimumMessages: 2 } });
    expect(body.timer.nextRunAt).toBe(new Date(now + 5 * 60_000).toISOString());
    expect(body.timer.nextRunState).toBe("offline");
    expect(scheduled).toEqual([expect.objectContaining({ deadline: now + 5 * 60_000 })]);
    await expect(database.prepare("SELECT next_run_state FROM timers WHERE timer_id = ?")
      .bind(body.timer.id).first()).resolves.toEqual({ next_run_state: "offline" });
  });

  it("rejects an interval with neither a live nor offline part", async () => {
    const database = await createDatabase();
    const response = await appFor(database as unknown as D1Database).fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/timers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Empty interval", messageText: "Hello!", trigger: { type: "interval" } }),
    }), environmentFor(database as unknown as D1Database, []));

    expect(response.status).toBe(400);
    await expect(database.prepare("SELECT COUNT(*) AS count FROM timers WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).resolves.toEqual({ count: 0 });
  });

  it("accepts the host viewers token when raid also declares an unavailable local viewers variable", async () => {
    const database = await createDatabase();
    const app = appFor(database as unknown as D1Database, [raidViewersVariable]);
    const response = await app.fetch(
      new Request(`https://brobot.example/channels/${CHANNEL_ID}/timers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Viewer reminder",
          messageText: "We have {viewers} viewers",
          trigger: { type: "interval", live: { minutes: 10 } },
        }),
      }),
      environmentFor(database as unknown as D1Database, []),
    );

    expect(response.status).toBe(201);
    await expect(database.prepare("SELECT message_text FROM timers WHERE channel_id = ? AND name = ?")
      .bind(CHANNEL_ID, "Viewer reminder").first()).resolves.toEqual({ message_text: "We have {viewers} viewers" });
  });

  it("schedules a horizon replan instead of going dormant when creating during a source's polar night", async () => {
    const database = await createDatabase();
    const scheduled: ScheduledAlarm[] = [];
    const app = appFor(database as unknown as D1Database);
    const environment = environmentFor(database as unknown as D1Database, scheduled);
    const now = Date.parse("2026-12-21T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);

    const response = await app.fetch(
      new Request(`https://brobot.example/channels/${CHANNEL_ID}/timers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Sunrise reminder",
          messageText: "Welcome to the chat!",
          trigger: { type: "before_event", sourceId: EVENT_SOURCE_ID, minutes: 30 },
        }),
      }),
      environment,
    );
    const body = await response.json<{ timer: { id: string; nextRunAt: string | null } }>();

    expect(response.status).toBe(201);
    expect(body.timer.nextRunAt).toBeNull();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.alarmKey).not.toBe(`timer:${body.timer.id}`);
    expect(scheduled[0]?.deadline).toBe(now + 14 * 24 * 60 * 60_000);
    const row = await database.prepare("SELECT next_run_at FROM timers WHERE channel_id = ? AND timer_id = ?")
      .bind(CHANNEL_ID, body.timer.id).first<{ next_run_at: string | null }>();
    expect(row).toEqual({ next_run_at: null });
  });

  it("rejects a timer save when its validated block is deleted before the SQL write", async () => {
    const database = await createDatabase();
    const interleavedDatabase = createReadInterleavingDatabase(
      database,
      (sql) => sql.includes("SELECT variant.texts_json"),
      async () => {
        await database.batch([
          database.prepare("UPDATE text_library_settings SET graph_revision = graph_revision + 1 WHERE channel_id = ?").bind(CHANNEL_ID),
          database.prepare("DELETE FROM text_blocks WHERE channel_id = ? AND block_name = ?").bind(CHANNEL_ID, "welcome"),
        ]);
      },
    );
    const app = appFor(interleavedDatabase);
    const response = await app.fetch(
      new Request(`https://brobot.example/channels/${CHANNEL_ID}/timers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Reminder", messageText: "{text.welcome}", trigger: { type: "interval", live: { minutes: 10 } } }),
      }),
      environmentFor(interleavedDatabase, []),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "timer_conflict" });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM timers WHERE channel_id = ?")
      .bind(CHANNEL_ID).first<{ count: number }>()).resolves.toEqual({ count: 0 });
  });
});

describe("timer edit keeps the stream id in sync with next_run_at", () => {
  it("clears next_run_stream_id in the same write that clears next_run_at, even if the follow-up schedule write is skipped", async () => {
    const realDatabase = await createDatabase();
    await realDatabase.prepare(
      `INSERT INTO timers
        (timer_id, channel_id, name, enabled, message_text, trigger_type, trigger_json, revision,
         next_run_at, next_run_stream_id, last_run_at, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, 1, ?, ?, NULL, ?, ?)`,
    ).bind(
      "timer-1", CHANNEL_ID, "Reminder", "Welcome back!", "interval", JSON.stringify({ type: "interval", live: { minutes: 10 } }),
      new Date("2026-09-27T12:10:00.000Z").toISOString(), "stream-1",
      "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
    ).run();

    // Makes setScheduledAlarm's own reconciling write (which would otherwise
    // also null both columns together) a no-op, so only the edit mutation's
    // own clearing of `next_run_at` can be responsible for whatever
    // `next_run_stream_id` ends up holding.
    const skippingDatabase = {
      prepare: (sql: string) => {
        if (sql.includes("SET next_run_at = ?, next_run_stream_id = ?, next_run_state = ?")) {
          return { bind: () => ({ run: () => Promise.resolve({ results: [], success: true, meta: { changes: 0, rows_written: 0 } }) }) };
        }
        return realDatabase.prepare(sql);
      },
      batch: (statements: Parameters<typeof realDatabase.batch>[0]) => realDatabase.batch(statements),
    } as unknown as D1Database;
    const app = appFor(skippingDatabase);
    const environment = environmentFor(skippingDatabase, []);

    const response = await app.fetch(
      new Request(`https://brobot.example/channels/${CHANNEL_ID}/timers/timer-1`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Reminder (edited)",
          messageText: "New free text",
          trigger: { type: "interval", live: { minutes: 10 } },
          revision: 1,
        }),
      }),
      environment,
    );

    expect(response.status).toBe(200);
    expect(await realDatabase.prepare("SELECT next_run_at, next_run_stream_id FROM timers WHERE timer_id = ?")
      .bind("timer-1").first()).toEqual({ next_run_at: null, next_run_stream_id: null });
  });
});
