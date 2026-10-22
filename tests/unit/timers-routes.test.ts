import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleRegisteredTemplateVariable, ModuleRouteEnvironment } from "../../src/modules/contract";
import type { ChannelRole } from "../../src/contracts/values";
import type { DurableTimerConfig } from "../../src/modules/timers/durable";
import { makeTimerPlan } from "../../src/modules/timers/durable";
import { timerRoutes } from "../../src/modules/timers/routes";
import { insertChannel } from "./fixtures";
import { createReadInterleavingDatabase, TestD1Database } from "./test-d1";

const CHANNEL_ID = "timers-route-channel";
const ACTOR_ID = "timers-route-actor";
const EVENT_SOURCE_ID = "sun.sunrise";
const databases: TestD1Database[] = [];

interface SkipTimerRouteOptions {
  role?: ChannelRole | "viewer";
  authorizationSql?: string;
  result?: { result: string; skippedOccurrenceAt?: string; nextOccurrenceAt?: string | null };
  skipped?: (channelId: string, timerId: string, revision: number, actor: { userId: string; sessionId: string }) => void;
  auditActions?: string[];
}

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

const appFor = (
  database: D1Database,
  variables: readonly ModuleRegisteredTemplateVariable[] = [],
  options: SkipTimerRouteOptions = {},
): Hono<ModuleRouteEnvironment> => {
  const app = new Hono<ModuleRouteEnvironment>();
  app.use("*", async (context, next) => {
    context.set("channelRole", (options.role ?? "manager") as ChannelRole);
    context.set("actor", { userId: ACTOR_ID, sessionId: "timers-route-session" });
    context.set("authorizeMutation", () => ({ sql: options.authorizationSql ?? "AND 1 = 1", values: [] }));
    context.set("authorizeManagementMutation", () => ({ sql: "AND 1 = 1", values: [] }));
    context.set("prepareModuleAudit", (input) => {
      options.auditActions?.push(input.action);
      return database.prepare("SELECT 1");
    });
    context.set("writeModuleAudit", (input) => {
      options.auditActions?.push(input.action);
      return Promise.resolve();
    });
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

const environmentFor = (
  database: D1Database,
  scheduled: ScheduledAlarm[],
  failScheduler = false,
  options: SkipTimerRouteOptions = {},
): Env => ({
  DB: database,
  CHANNEL: {
    idFromName: () => "channel-object",
    get: () => ({
      upsertTimerConfig: async (config: DurableTimerConfig) => {
        if (failScheduler) throw new Error("Channel Durable Object is unavailable.");
        const now = Date.now();
        const [stream, channel] = await Promise.all([
          database.prepare("SELECT state, stream_id, started_at, transition_generation FROM channel_stream_state WHERE channel_id = ?")
            .bind("timers-route-channel").first<{
              state: "online" | "offline" | "unknown";
              stream_id: string | null;
              started_at: string | null;
              transition_generation: number;
            }>(),
          database.prepare("SELECT time_zone FROM channels WHERE channel_id = ?")
            .bind("timers-route-channel").first<{ time_zone: string }>(),
        ]);
        const inputs = { now, timeZone: channel?.time_zone ?? "Europe/Berlin", eventTimes: [] };
        const plan = makeTimerPlan(config, {
          state: stream?.state ?? "unknown",
          streamId: stream?.stream_id ?? null,
          startedAt: stream?.started_at ?? null,
          generation: stream?.transition_generation ?? 0,
        }, null, inputs);
        const mirrorSequence = await database.prepare(
          "SELECT schedule_mirror_sequence FROM timers WHERE channel_id = ? AND timer_id = ?",
        ).bind("timers-route-channel", config.id).first<{ schedule_mirror_sequence: number }>();
        const nextSequence = (mirrorSequence?.schedule_mirror_sequence ?? 0) + 1;
        await database.prepare(
          `UPDATE timers SET next_run_at = ?, next_run_state = ?, schedule_mirror_sequence = ?
            WHERE channel_id = ? AND timer_id = ? AND revision = ?`,
        ).bind(
          plan.identity === null ? null : new Date(plan.identity.deadline).toISOString(),
          plan.identity?.state === "live" || plan.identity?.state === "offline" ? plan.identity.state : null,
          nextSequence,
          "timers-route-channel",
          config.id,
          config.revision,
        ).run();
        if (plan.identity !== null) {
          scheduled.push({ moduleId: "timers", handlerKey: "run", alarmKey: `timer:${config.id}`, deadline: plan.identity.deadline });
        }
        if (plan.refreshAt !== null) {
          scheduled.push({
            moduleId: "timers", handlerKey: "run", alarmKey: `timer:${config.id}:refresh:${String(plan.refreshAt)}`,
            deadline: plan.refreshAt,
          });
        }
      },
      deleteTimerConfig: () => failScheduler
        ? Promise.reject(new Error("Channel Durable Object is unavailable."))
        : Promise.resolve(),
      skipNextTimerOccurrence: (timerId: string, revision: number, actor: { userId: string; sessionId: string }) => {
        options.skipped?.("timers-route-channel", timerId, revision, actor);
        return Promise.resolve(options.result ?? {
          result: "skipped",
          skippedOccurrenceAt: "2026-10-13T12:10:00.000Z",
          nextOccurrenceAt: "2026-10-13T12:20:00.000Z",
        });
      },
      reconcileTimerSchedules: () => failScheduler
        ? Promise.reject(new Error("Channel Durable Object is unavailable."))
        : Promise.resolve(),
    }),
  },
} as unknown as Env);

const insertSkipTimerFixture = async (database: TestD1Database, channelId = CHANNEL_ID): Promise<void> => {
  await database.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'timers', 1, '{}')",
  ).bind(channelId).run();
  await database.prepare(
    `INSERT INTO timers
      (timer_id, channel_id, name, enabled, message_text, trigger_type, trigger_json, revision,
       next_run_at, next_run_state, schedule_mirror_sequence, last_run_at, created_at, updated_at)
     VALUES ('timer-1', ?, 'Reminder', 1, 'Hello', 'interval', ?, 3, '2026-10-13T12:10:00.000Z', 'live', 1, NULL, ?, ?)`,
  ).bind(channelId, JSON.stringify({ type: "interval", live: { minutes: 10 } }), "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z").run();
};

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

  it("keeps a committed timer mutation in the D1 reconciliation outbox when the DO and fallback both fail", async () => {
    const database = await createDatabase();
    const response = await appFor(database as unknown as D1Database).fetch(
      new Request(`https://brobot.example/channels/${CHANNEL_ID}/timers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Recoverable timer",
          messageText: "Hello!",
          trigger: { type: "interval", live: { minutes: 10 } },
        }),
      }),
      environmentFor(database as unknown as D1Database, [], true),
    );

    expect(response.status).toBe(201);
    const pendingRepair = await database.prepare(
      "SELECT channel_id, mutation_id FROM timer_schedule_reconciliation WHERE channel_id = ?",
    ).bind(CHANNEL_ID).first<{ channel_id: string; mutation_id: string }>();
    expect(pendingRepair?.channel_id).toBe(CHANNEL_ID);
    expect(typeof pendingRepair?.mutation_id).toBe("string");
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

describe("skip next timer quick-action route", () => {
  it.each([
    [{ result: "skipped", skippedOccurrenceAt: "2026-10-13T12:10:00.000Z", nextOccurrenceAt: "2026-10-13T12:20:00.000Z" }, 200],
    [{ result: "already_skipped" }, 200],
    [{ result: "nothing_planned" }, 200],
    [{ result: "not_found" }, 200],
  ] as const)("returns the typed scheduler result %j", async (result, expectedStatus) => {
    const database = await createDatabase();
    await insertSkipTimerFixture(database);
    const auditActions: string[] = [];
    const options: SkipTimerRouteOptions = { result, auditActions };
    const app = appFor(database as unknown as D1Database, [], options);
    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/quick-actions/skip-next`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ timerId: "timer-1" }),
    }), environmentFor(database as unknown as D1Database, [], false, options));

    expect(response.status).toBe(expectedStatus);
    await expect(response.json()).resolves.toEqual(result);
    expect(auditActions).toEqual([]);
  });

  it("passes the session actor to the queued scheduler and returns its authorization denial", async () => {
    const database = await createDatabase();
    await insertSkipTimerFixture(database);
    const actors: Array<{ userId: string; sessionId: string }> = [];
    const auditActions: string[] = [];
    const options: SkipTimerRouteOptions = {
      result: { result: "denied" },
      auditActions,
      skipped: (_channelId, _timerId, _revision, actor) => actors.push(actor),
    };
    const response = await appFor(database as unknown as D1Database, [], options).fetch(
      new Request(`https://brobot.example/channels/${CHANNEL_ID}/quick-actions/skip-next`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timerId: "timer-1" }),
      }),
      environmentFor(database as unknown as D1Database, [], false, options),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "timer_skip_denied" });
    expect(actors).toEqual([{ userId: ACTOR_ID, sessionId: "timers-route-session" }]);
    expect(auditActions).toEqual([]);
  });

  it("rejects a non-member before asking the channel scheduler to skip", async () => {
    const database = await createDatabase();
    await insertSkipTimerFixture(database);
    let schedulerCalls = 0;
    const options: SkipTimerRouteOptions = {
      authorizationSql: "AND 1 = 0",
      skipped: () => { schedulerCalls += 1; },
    };
    const response = await appFor(database as unknown as D1Database, [], options).fetch(
      new Request(`https://brobot.example/channels/${CHANNEL_ID}/quick-actions/skip-next`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timerId: "timer-1" }),
      }), environmentFor(database as unknown as D1Database, [], false, options),
    );

    expect(response.status).toBe(403);
    expect(schedulerCalls).toBe(0);
  });

  it("rejects a role below operator before asking the channel scheduler to skip", async () => {
    const database = await createDatabase();
    await insertSkipTimerFixture(database);
    let schedulerCalls = 0;
    const options: SkipTimerRouteOptions = {
      role: "viewer",
      skipped: () => { schedulerCalls += 1; },
    };
    const response = await appFor(database as unknown as D1Database, [], options).fetch(
      new Request(`https://brobot.example/channels/${CHANNEL_ID}/quick-actions/skip-next`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timerId: "timer-1" }),
      }), environmentFor(database as unknown as D1Database, [], false, options),
    );

    expect(response.status).toBe(403);
    expect(schedulerCalls).toBe(0);
  });

  it("does not expose a timer that belongs to another channel", async () => {
    const database = await createDatabase();
    await insertChannel(database, "other-timer-channel");
    await insertSkipTimerFixture(database, "other-timer-channel");
    let schedulerCalls = 0;
    const options: SkipTimerRouteOptions = {
      skipped: () => { schedulerCalls += 1; },
    };
    const response = await appFor(database as unknown as D1Database, [], options).fetch(
      new Request(`https://brobot.example/channels/${CHANNEL_ID}/quick-actions/skip-next`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timerId: "timer-1" }),
      }), environmentFor(database as unknown as D1Database, [], false, options),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ result: "not_found" });
    expect(schedulerCalls).toBe(0);
  });
});

describe("timer edits hand revisioned config to the Durable Object scheduler", () => {
  it("keeps the D1 schedule mirror owned by the Durable Object after a revision-guarded edit", async () => {
    const realDatabase = await createDatabase();
    await realDatabase.prepare(
      `INSERT INTO channel_stream_state
        (channel_id, state, changed_at, source, started_at, stream_id, transition_generation)
       VALUES (?, 'online', ?, 'eventsub', ?, 'stream-1', 1)`,
    ).bind(CHANNEL_ID, "2026-09-27T12:00:00.000Z", "2026-09-27T11:00:00.000Z").run();
    await realDatabase.prepare(
      `INSERT INTO timers
        (timer_id, channel_id, name, enabled, message_text, trigger_type, trigger_json, revision,
         next_run_at, next_run_state, schedule_mirror_sequence, last_run_at, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, 1, ?, 'live', 4, NULL, ?, ?)`,
    ).bind(
      "timer-1", CHANNEL_ID, "Reminder", "Welcome back!", "interval", JSON.stringify({ type: "interval", live: { minutes: 10 } }),
      new Date("2026-09-27T12:10:00.000Z").toISOString(),
      "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z",
    ).run();
    const scheduled: ScheduledAlarm[] = [];
    const app = appFor(realDatabase as unknown as D1Database);
    const environment = environmentFor(realDatabase as unknown as D1Database, scheduled);
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse("2026-09-27T12:00:00.000Z"));

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
    const body = await response.json<{
      timer: {
        revision: number;
        nextRunAt: string | null;
        nextRunState: string | null;
        trigger: { type: string; live?: { minutes: number }; minutes?: number };
      };
    }>();
    expect(body.timer).toMatchObject({
      revision: 2,
      nextRunAt: new Date("2026-09-27T12:10:00.000Z").toISOString(),
      nextRunState: "live",
    });
    expect(body.timer.trigger).toMatchObject({
      type: "interval",
      live: { minutes: 10 },
      minutes: 10,
    });
    expect(scheduled).toHaveLength(1);
    await expect(realDatabase.prepare(
      "SELECT revision, next_run_at, next_run_state, schedule_mirror_sequence FROM timers WHERE timer_id = ?",
    ).bind("timer-1").first()).resolves.toEqual({
      revision: 2,
      next_run_at: new Date("2026-09-27T12:10:00.000Z").toISOString(),
      next_run_state: "live",
      schedule_mirror_sequence: 5,
    });
  });
});
