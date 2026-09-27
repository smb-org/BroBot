import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleRouteEnvironment } from "../../src/modules/contract";
import { timerRoutes } from "../../src/modules/timers/routes";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "timers-route-channel";
const ACTOR_ID = "timers-route-actor";
const EVENT_SOURCE_ID = "sun.sunrise";
const databases: TestD1Database[] = [];

const createDatabase = async (): Promise<TestD1Database> => {
  const database = new TestD1Database();
  databases.push(database);
  await insertChannel(database, CHANNEL_ID);
  await database.prepare("INSERT INTO text_library_categories (channel_id, category_id, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .bind(CHANNEL_ID, "custom", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z").run();
  await database.prepare("INSERT INTO text_blocks (channel_id, block_name, category_id, revision, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)")
    .bind(CHANNEL_ID, "welcome", "custom", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z").run();
  await database.prepare("INSERT INTO text_block_variants (channel_id, block_name, variant_id, position, conditions_json, texts_json) VALUES (?, ?, ?, 0, '{}', ?)")
    .bind(CHANNEL_ID, "welcome", "welcome-variant", JSON.stringify(["Welcome!"])).run();
  return database;
};

type ScheduledAlarm = { moduleId: string; handlerKey: string; alarmKey: string; deadline: number };

const appFor = (database: D1Database): Hono<ModuleRouteEnvironment> => {
  const app = new Hono<ModuleRouteEnvironment>();
  app.use("*", async (context, next) => {
    context.set("channelRole", "manager");
    context.set("actor", { userId: ACTOR_ID, sessionId: "timers-route-session" });
    context.set("authorizeManagementMutation", () => ({ sql: "AND 1 = 1", values: [] }));
    context.set("prepareModuleAudit", () => database.prepare("SELECT 1"));
    context.set("listEventTimeSources", () => [{ id: EVENT_SOURCE_ID, label: { de: "Sonnenaufgang", en: "Sunrise" } }]);
    context.set("listRegisteredTemplateVariables", () => Promise.resolve([]));
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

describe("before_event timer scheduling routes", () => {
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
          blockName: "welcome",
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
});
