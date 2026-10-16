import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import type { ModuleRouteEnvironment } from "../../src/modules/contract";
import { timerRoutes } from "../../src/modules/timers/routes";
import { authorizeModuleMutation } from "../../src/worker/module-authorization";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { createReadInterleavingDatabase, TestD1Database } from "./test-d1";

const channelId = "timers-module-active-race";
const actorId = "timers-module-active-operator";
const timestamp = "2026-10-16T10:00:00.000Z";
const databases: TestD1Database[] = [];

const createDatabase = async (): Promise<TestD1Database> => {
  const database = new TestD1Database();
  databases.push(database);
  await insertChannel(database, channelId);
  await insertLoginIdentityAndSession(database, actorId);
  await insertMember(database, channelId, actorId, "operator");
  await database.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'timers', 1, '{}')",
  ).bind(channelId).run();
  await database.prepare(
    `INSERT INTO timers
      (timer_id, channel_id, name, enabled, message_text, trigger_type, trigger_json,
       revision, next_run_at, next_run_state, last_run_at, created_at, updated_at)
     VALUES ('timer-race', ?, 'Race timer', 0, 'Hello!', 'interval', ?, 1, NULL, NULL, NULL, ?, ?)`,
  ).bind(channelId, JSON.stringify({ type: "interval", live: { minutes: 30 } }), timestamp, timestamp).run();
  return database;
};

const appFor = (database: D1Database): Hono<ModuleRouteEnvironment> => {
  const app = new Hono<ModuleRouteEnvironment>();
  app.use("*", async (context, next) => {
    context.set("channelRole", "operator");
    context.set("actor", { userId: actorId, sessionId: `session-${actorId}` });
    context.set("authorizeMutation", authorizeModuleMutation);
    context.set("prepareModuleAudit", () => database.prepare("SELECT 1"));
    await next();
  });
  app.route("/channels/:channelId", timerRoutes);
  return app;
};

const environmentFor = (database: D1Database): Env => ({
  DB: database,
  CHANNEL: {
    idFromName: () => "channel-object",
    get: () => ({
      upsertTimerConfig: () => Promise.resolve(),
      reconcileTimerSchedules: () => Promise.resolve(),
    }),
  },
} as unknown as Env);

const enableTimer = (app: Hono<ModuleRouteEnvironment>, database: D1Database) => app.fetch(
  new Request(`https://brobot.example/channels/${channelId}/timers/timer-race/enabled`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true, revision: 1 }),
  }),
  environmentFor(database),
);

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("timer activation checks module and membership in the mutation", () => {
  it("allows an authenticated operator to activate a timer while the module is active", async () => {
    const database = await createDatabase();
    const databaseApi = database as unknown as D1Database;

    const response = await enableTimer(appFor(databaseApi), databaseApi);

    expect(response.status).toBe(200);
    await expect(database.prepare("SELECT enabled, revision FROM timers WHERE timer_id = 'timer-race'").first())
      .resolves.toEqual({ enabled: 1, revision: 2 });
  });

  it.each(["module deactivation", "membership removal"])("rejects an enable request raced by %s", async (race) => {
    const database = await createDatabase();
    const interleavedDatabase = createReadInterleavingDatabase(
      database,
      (sql) => sql.includes("FROM timers") && sql.includes("WHERE channel_id = ? AND timer_id = ?"),
      async () => {
        if (race === "module deactivation") {
          await database.prepare("UPDATE channel_modules SET enabled = 0 WHERE channel_id = ? AND module_id = 'timers'")
            .bind(channelId).run();
        } else {
          await database.prepare("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?")
            .bind(channelId, actorId).run();
        }
      },
    );

    const response = await enableTimer(appFor(interleavedDatabase), interleavedDatabase);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "timer_conflict" });
    await expect(database.prepare("SELECT enabled, revision FROM timers WHERE timer_id = 'timer-race'").first())
      .resolves.toEqual({ enabled: 0, revision: 1 });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM timer_schedule_reconciliation WHERE timer_id = 'timer-race'").first())
      .resolves.toEqual({ count: 0 });
  });
});
