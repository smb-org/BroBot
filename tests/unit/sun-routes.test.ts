import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleRouteEnvironment } from "../../src/modules/contract";
import { handleSunAlarm } from "../../src/modules/sun/service";
import { sunRoutes } from "../../src/modules/sun/routes";
import { nextSunRefreshAt } from "../../src/modules/sun/domain";
import { readSunSettings } from "../../src/modules/sun/adapters/d1";
import { prepareModuleAudit } from "../../src/worker/module-audit";
import { reconcileUnscheduledSunAlarms } from "../../src/worker/sun-alarm-reconciliation";
import { insertChannel } from "./fixtures";
import { TestD1Database, type TestPreparedStatement } from "./test-d1";

const CHANNEL_ID = "sun-route-channel";
const ACTOR_ID = "sun-route-actor";
const databases: TestD1Database[] = [];

const createDatabase = async (): Promise<TestD1Database> => {
  const database = new TestD1Database();
  databases.push(database);
  await insertChannel(database, CHANNEL_ID);
  return database;
};

const appFor = (
  database: D1Database,
  refreshModuleAlarms: (channelId: string) => Promise<void> = vi.fn().mockResolvedValue(undefined),
): Hono<ModuleRouteEnvironment> => {
  const app = new Hono<ModuleRouteEnvironment>();
  app.use("*", async (context, next) => {
    context.set("channelRole", "manager");
    context.set("actor", { userId: ACTOR_ID, sessionId: "sun-route-session" });
    context.set("authorizeManagementMutation", () => ({ sql: "AND 1 = 1", values: [] }));
    context.set("prepareModuleAudit", (entry, changedAt) =>
      prepareModuleAudit(database, ACTOR_ID, changedAt, entry));
    context.set("refreshModuleAlarms", refreshModuleAlarms);
    await next();
  });
  app.route("/channels/:channelId", sunRoutes);
  return app;
};

const requestFor = (location: unknown, revision: number, errorTexts = { de: "German error", en: "English error" }): Request =>
  new Request(`https://brobot.example/channels/${CHANNEL_ID}/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision, location, errorTexts }),
  });

const location = (name: string, latitude = 52.52) => ({
  name,
  latitude,
  longitude: 13.405,
  timeZone: "Europe/Berlin",
});

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  vi.useRealTimers();
});

describe("sun settings mutations", () => {
  it("audits the first location save and both configured fallback texts", async () => {
    const database = await createDatabase();
    const errorTexts = { de: "D".repeat(200), en: "E".repeat(200) };
    const app = appFor(database as unknown as D1Database);
    const environment = { DB: database as unknown as D1Database };
    const response = await app.fetch(
      requestFor(location("Berlin"), 1, errorTexts),
      environment,
    );
    const textOnlyResponse = await app.fetch(
      requestFor(location("Berlin"), 2, { de: "Updated German text", en: "Updated English text" }),
      environment,
    );
    const audits = await database.prepare(
      "SELECT before_json, after_json FROM audit_log WHERE channel_id = ? AND action = ? ORDER BY rowid",
    ).bind(CHANNEL_ID, "sun.settings_changed").all<{ before_json: string; after_json: string }>();

    expect(response.status).toBe(200);
    expect(textOnlyResponse.status).toBe(200);
    expect(audits.results).toHaveLength(2);
    expect(JSON.parse(audits.results[0]?.before_json ?? "{}") as Record<string, unknown>).toMatchObject({
      errorTextDe: "Sonnendaten sind derzeit nicht verfügbar.",
      errorTextEn: "Sun data is currently unavailable.",
    });
    expect(JSON.parse(audits.results[0]?.after_json ?? "{}") as Record<string, unknown>).toMatchObject({
      locationName: "Berlin",
      errorTextDe: errorTexts.de,
      errorTextEn: errorTexts.en,
    });
    const textOnlyBefore = JSON.parse(audits.results[1]?.before_json ?? "{}") as Record<string, unknown>;
    const textOnlyAfter = JSON.parse(audits.results[1]?.after_json ?? "{}") as Record<string, unknown>;
    expect(textOnlyBefore.locationName).toBe(textOnlyAfter.locationName);
    expect(textOnlyBefore.errorTextDe).not.toBe(textOnlyAfter.errorTextDe);
    expect(textOnlyBefore.errorTextEn).not.toBe(textOnlyAfter.errorTextEn);
  });

  it("does not let a losing concurrent update delete refreshed rows or create an audit", async () => {
    const database = await createDatabase();
    await database.prepare(
      `INSERT INTO sun_locations (channel_id, name, latitude, longitude, location_time_zone, revision)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(CHANNEL_ID, "Berlin", 52.52, 13.405, "Europe/Berlin", 2).run();
    await database.prepare(
      `INSERT INTO sun_times
        (channel_id, local_date, sunrise_at, sunset_at, dusk_at, polar_state, fetched_at, expires_at, channel_time_zone, location_revision)
       VALUES (?, ?, ?, ?, ?, 'normal', ?, ?, ?, ?)`,
    ).bind(CHANNEL_ID, "2026-06-20", "2026-06-20T02:00:00.000Z", "2026-06-20T20:00:00.000Z", null,
      "2026-06-20T00:00:00.000Z", "2026-06-22T00:00:00.000Z", "Europe/Berlin", 2).run();

    let releaseInitialReads!: () => void;
    const initialReadsReady = new Promise<void>((resolve) => { releaseInitialReads = resolve; });
    let initialReadCount = 0;
    let releaseLosingBatch!: () => void;
    const losingBatchGate = new Promise<void>((resolve) => { releaseLosingBatch = resolve; });
    let losingBatchStarted!: () => void;
    const losingBatchReady = new Promise<void>((resolve) => { losingBatchStarted = resolve; });
    let batchCount = 0;
    const preparedStatements = new WeakMap<D1PreparedStatement, TestPreparedStatement>();
    const concurrentDb = {
      prepare(sql: string): D1PreparedStatement {
        const statement = database.prepare(sql);
        const wrapper = {
          bind(...values: Parameters<TestPreparedStatement["bind"]>) {
            statement.bind(...values);
            return wrapper;
          },
          first<T>() {
            if (sql.startsWith("SELECT name, latitude, longitude, location_time_zone") && initialReadCount < 2) {
              initialReadCount += 1;
              if (initialReadCount === 2) releaseInitialReads();
              return initialReadsReady.then(() => statement.first<T>());
            }
            return statement.first<T>();
          },
          all<T>(...typeHint: readonly T[]) {
            return statement.all<T>(...typeHint);
          },
          run() {
            return statement.run();
          },
        } as unknown as D1PreparedStatement;
        preparedStatements.set(wrapper, statement);
        return wrapper;
      },
      async batch(statements: D1PreparedStatement[]) {
        batchCount += 1;
        if (batchCount === 2) {
          losingBatchStarted();
          await losingBatchGate;
        }
        return database.batch(statements.map((statement) => preparedStatements.get(statement) as TestPreparedStatement));
      },
    } as unknown as D1Database;
    const app = appFor(concurrentDb);
    const firstRequest = app.fetch(requestFor(location("Berlin A", 52.5), 2), { DB: concurrentDb });
    const secondRequest = app.fetch(requestFor(location("Berlin B", 52.6), 2), { DB: concurrentDb });
    await losingBatchReady;
    const winnerResponse = await Promise.race([firstRequest, secondRequest]);
    const winner = await winnerResponse.json<{
      revision: number;
      location: { name: string };
    }>();

    await database.prepare(
      `INSERT INTO sun_times
        (channel_id, local_date, sunrise_at, sunset_at, dusk_at, polar_state, fetched_at, expires_at, channel_time_zone, location_revision)
       VALUES (?, ?, ?, ?, ?, 'normal', ?, ?, ?, ?)`,
    ).bind(CHANNEL_ID, "2026-06-21", "2026-06-21T02:00:00.000Z", "2026-06-21T20:00:00.000Z", null,
      "2026-06-21T00:00:00.000Z", "2026-06-23T00:00:00.000Z", "Europe/Berlin", winner.revision).run();
    releaseLosingBatch();
    const responses = await Promise.all([firstRequest, secondRequest]);
    const audits = await database.prepare(
      "SELECT COUNT(*) AS count FROM audit_log WHERE channel_id = ? AND action = ?",
    ).bind(CHANNEL_ID, "sun.settings_changed").first<{ count: number }>();
    const refreshed = await database.prepare(
      "SELECT location_revision FROM sun_times WHERE channel_id = ? AND local_date = ?",
    ).bind(CHANNEL_ID, "2026-06-21").first<{ location_revision: number }>();

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(winner.location.name).toMatch(/^Berlin [AB]$/u);
    expect(audits?.count).toBe(1);
    expect(refreshed?.location_revision).toBe(winner.revision);
  });

  it("recovers a first save after the channel object call fails", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-06-21T00:16:00.000Z");
    vi.setSystemTime(now);
    const database = await createDatabase();
    const failedSchedule = vi.fn(() => Promise.reject(new Error("Channel object unavailable")));
    const response = await appFor(database as unknown as D1Database, failedSchedule).fetch(
      requestFor(location("Berlin"), 1),
      { DB: database as unknown as D1Database },
    );
    const afterSave = await readSunSettings(database as unknown as D1Database, CHANNEL_ID);
    let registeredDeadline: number | null = null;

    await reconcileUnscheduledSunAlarms(database as unknown as D1Database, async (channelId) => {
      await handleSunAlarm(database as unknown as D1Database, channelId, now);
      const refreshedSettings = await readSunSettings(database as unknown as D1Database, channelId);
      registeredDeadline = refreshedSettings.nextRefreshAt === null ? null : Date.parse(refreshedSettings.nextRefreshAt);
    });

    const stored = await database.prepare("SELECT COUNT(*) AS count FROM sun_times WHERE channel_id = ?")
      .bind(CHANNEL_ID).first<{ count: number }>();
    expect(response.status).toBe(200);
    expect(failedSchedule).toHaveBeenCalledOnce();
    expect(afterSave.nextRefreshAt).toBeNull();
    expect(registeredDeadline).toBe(nextSunRefreshAt(now, "Europe/Berlin"));
    expect(stored?.count).toBe(2);
  });

  it("reconciles an update even if its previous refresh deadline was scheduled", async () => {
    const database = await createDatabase();
    await database.prepare(
      `INSERT INTO sun_locations
        (channel_id, name, latitude, longitude, location_time_zone, revision, next_refresh_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(CHANNEL_ID, "Berlin", 52.52, 13.405, "Europe/Berlin", 2, "2099-01-01T00:15:00.000Z").run();
    const response = await appFor(database as unknown as D1Database, () =>
      Promise.reject(new Error("Channel object unavailable"))).fetch(
      requestFor(location("Updated Berlin"), 2),
      { DB: database as unknown as D1Database },
    );
    const updated = await response.json<{ nextRefreshAt: string | null }>();
    const reconciled: string[] = [];

    await reconcileUnscheduledSunAlarms(database as unknown as D1Database, (channelId) => {
      reconciled.push(channelId);
      return Promise.resolve();
    });

    expect(response.status).toBe(200);
    expect(updated.nextRefreshAt).toBeNull();
    expect(reconciled).toEqual([CHANNEL_ID]);
  });
});
