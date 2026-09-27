import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import type { ModuleRouteEnvironment } from "../../src/modules/contract";
import { sunRoutes } from "../../src/modules/sun/routes";
import { readSunSettings } from "../../src/modules/sun/adapters/d1";
import { prepareModuleAudit } from "../../src/worker/module-audit";
import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey as key } from "./fixtures";
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

const appFor = (database: D1Database, publishedHostEvents: string[] = []): Hono<ModuleRouteEnvironment> => {
  const app = new Hono<ModuleRouteEnvironment>();
  app.use("*", async (context, next) => {
    context.set("channelRole", "manager");
    context.set("actor", { userId: ACTOR_ID, sessionId: "sun-route-session" });
    context.set("authorizeManagementMutation", () => ({ sql: "AND 1 = 1", values: [] }));
    context.set("prepareModuleAudit", (entry, changedAt) =>
      prepareModuleAudit(database, ACTOR_ID, changedAt, entry));
    context.set("publishOverlayHostEvent", (channelId, event) => {
      publishedHostEvents.push(`${channelId}:${event}`);
      return Promise.resolve();
    });
    await next();
  });
  app.route("/channels/:channelId", sunRoutes);
  return app;
};

const requestFor = (location: unknown, revision: number, errorTexts = { de: "German error", en: "English error" }): Request =>
  new Request(`https://brobot.example/channels/${CHANNEL_ID}/location`, {
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
});

describe("sun settings mutations", () => {
  it("stores the location time zone and audits the location and fallback texts", async () => {
    const database = await createDatabase();
    const errorTexts = { de: "D".repeat(200), en: "E".repeat(200) };
    const hostEvents: string[] = [];
    const app = appFor(database as unknown as D1Database, hostEvents);
    const environment = { DB: database as unknown as D1Database };
    const response = await app.fetch(requestFor({ ...location("Honolulu", 21.3069), longitude: -157.8583, timeZone: "Pacific/Honolulu" }, 1, errorTexts), environment);
    const saved = await response.json<{ location: { timeZone: string } }>();
    const textOnlyResponse = await app.fetch(
      requestFor({ ...location("Honolulu", 21.3069), longitude: -157.8583, timeZone: "Pacific/Honolulu" }, 2,
        { de: "Updated German text", en: "Updated English text" }),
      environment,
    );
    const removedResponse = await app.fetch(requestFor(null, 3), environment);
    const audits = await database.prepare(
      "SELECT before_json, after_json FROM audit_log WHERE channel_id = ? AND action = ? ORDER BY rowid",
    ).bind(CHANNEL_ID, "sun.settings_changed").all<{ before_json: string; after_json: string }>();

    expect(response.status).toBe(200);
    expect(saved.location.timeZone).toBe("Pacific/Honolulu");
    expect(textOnlyResponse.status).toBe(200);
    expect(removedResponse.status).toBe(200);
    expect(hostEvents).toEqual([
      `${CHANNEL_ID}:template.data.changed`,
      `${CHANNEL_ID}:template.data.changed`,
      `${CHANNEL_ID}:template.data.changed`,
    ]);
    expect(audits.results).toHaveLength(3);
    expect(JSON.parse(audits.results[0]?.before_json ?? "{}") as Record<string, unknown>).toMatchObject({
      errorTextDe: "Sonnendaten sind derzeit nicht verfügbar.",
      errorTextEn: "Sun data is currently unavailable.",
    });
    expect(JSON.parse(audits.results[0]?.after_json ?? "{}") as Record<string, unknown>).toMatchObject({
      locationName: "Honolulu",
      locationTimeZone: "Pacific/Honolulu",
      errorTextDe: errorTexts.de,
      errorTextEn: errorTexts.en,
    });
    const textOnlyBefore = JSON.parse(audits.results[1]?.before_json ?? "{}") as Record<string, unknown>;
    const textOnlyAfter = JSON.parse(audits.results[1]?.after_json ?? "{}") as Record<string, unknown>;
    expect(textOnlyBefore.locationName).toBe(textOnlyAfter.locationName);
    expect(textOnlyBefore.errorTextDe).not.toBe(textOnlyAfter.errorTextDe);
    expect(textOnlyBefore.errorTextEn).not.toBe(textOnlyAfter.errorTextEn);
    expect(JSON.parse(audits.results[2]?.after_json ?? "{}") as Record<string, unknown>).toMatchObject({
      locationName: null,
      locationTimeZone: null,
    });
  });

  it("does not audit a losing concurrent update", async () => {
    const database = await createDatabase();
    await database.prepare(
      `INSERT INTO sun_locations (channel_id, name, latitude, longitude, location_time_zone, revision)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(CHANNEL_ID, "Berlin", 52.52, 13.405, "Europe/Berlin", 2).run();

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
    const winner = await winnerResponse.json<{ location: { name: string } }>();
    releaseLosingBatch();
    const responses = await Promise.all([firstRequest, secondRequest]);
    const audits = await database.prepare(
      "SELECT COUNT(*) AS count FROM audit_log WHERE channel_id = ? AND action = ?",
    ).bind(CHANNEL_ID, "sun.settings_changed").first<{ count: number }>();
    const saved = await readSunSettings(database as unknown as D1Database, CHANNEL_ID);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(winner.location.name).toMatch(/^Berlin [AB]$/u);
    expect(audits?.count).toBe(1);
    expect(saved.location?.name).toBe(winner.location.name);
  });
});

const REAL_ROUTER_CHANNEL_ID = "sun-real-router-channel";
const environmentKeys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
};

const requestForRealRouter = async (userId: string, path: string): Promise<Request> => {
  const sessionCookie = await createSessionCookie(
    { sessionId: `session-${userId}` },
    environmentKeys.SESSION_COOKIE_KEYS,
    environmentKeys.SESSION_ENCRYPTION_KEYS,
  );
  // GET requests are CSRF-exempt; the token is only included for parity with
  // how the panel actually calls the route.
  const csrfToken = await createCsrfToken(`session-${userId}`, environmentKeys.SESSION_COOKIE_KEYS, new Date().toISOString());
  return new Request(`https://brobot.example${path}`, {
    headers: { Cookie: `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrfToken}` },
  });
};

describe("sun settings via the real worker router", () => {
  it("resolves GET .../modules/sun/location to the sun shape instead of the generic module settings route", async () => {
    const database = await createDatabase();
    await insertChannel(database, REAL_ROUTER_CHANNEL_ID);
    await insertLoginIdentityAndSession(database, "sun-real-router-user");
    await insertMember(database, REAL_ROUTER_CHANNEL_ID, "sun-real-router-user", "manager");
    const environment = { DB: database as unknown as D1Database, ...environmentKeys } as unknown as Env;

    const response = await panelRouter.fetch(
      await requestForRealRouter("sun-real-router-user", `/api/channels/${REAL_ROUTER_CHANNEL_ID}/modules/sun/location`),
      environment,
    );
    const body = await response.json<{ location: unknown; errorTexts: { de: string; en: string }; revision: number }>();

    expect(response.status).toBe(200);
    expect(body.location).toBeNull();
    expect(body.revision).toBe(1);
    expect(body.errorTexts).toEqual({
      de: "Sonnendaten sind derzeit nicht verfügbar.",
      en: "Sun data is currently unavailable.",
    });
  });
});
