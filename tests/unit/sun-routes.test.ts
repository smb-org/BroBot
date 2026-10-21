import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleRouteEnvironment } from "../../src/modules/contract";
import * as sunDomain from "../../src/modules/sun/domain";
import { sunRoutes } from "../../src/modules/sun/routes";
import { readSunSettings } from "../../src/modules/sun/adapters/d1";
import { prepareModuleAudit } from "../../src/worker/module-audit";
import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
import { readChannelLocation } from "../../src/worker/db/channel-settings";
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
    context.set("channelLocation", (channelId) => readChannelLocation(database, channelId));
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

const errorTexts = { de: "German error", en: "English error" };

const requestFor = (revision: number, nextTexts = errorTexts): Request =>
  new Request(`https://brobot.example/channels/${CHANNEL_ID}/error-texts`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ revision, errorTexts: nextTexts }),
  });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

describe("sun error text settings", () => {
  it("stores and audits only the module-owned error texts", async () => {
    const database = await createDatabase();
    const errorTexts = { de: "D".repeat(200), en: "E".repeat(200) };
    const hostEvents: string[] = [];
    const app = appFor(database as unknown as D1Database, hostEvents);
    const environment = { DB: database as unknown as D1Database };
    const response = await app.fetch(requestFor(1, errorTexts), environment);
    const saved = await response.json<{ errorTexts: { de: string; en: string }; revision: number }>();
    const audits = await database.prepare(
      "SELECT before_json, after_json FROM audit_log WHERE channel_id = ? AND action = ? ORDER BY rowid",
    ).bind(CHANNEL_ID, "sun.settings_changed").all<{ before_json: string; after_json: string }>();

    expect(response.status).toBe(200);
    expect(saved).toEqual({ errorTexts, revision: 2 });
    expect(await readSunSettings(database as unknown as D1Database, CHANNEL_ID)).toEqual(saved);
    expect(hostEvents).toEqual([`${CHANNEL_ID}:template.data.changed`]);
    expect(audits.results).toHaveLength(1);
    expect(JSON.parse(audits.results[0]?.before_json ?? "{}") as Record<string, unknown>).toEqual({
      errorTextDe: "Sonnendaten sind derzeit nicht verfügbar.",
      errorTextEn: "Sun data is currently unavailable.",
    });
    expect(JSON.parse(audits.results[0]?.after_json ?? "{}") as Record<string, unknown>).toEqual({
      errorTextDe: errorTexts.de,
      errorTextEn: errorTexts.en,
    });
  });

  it("does not audit a losing concurrent error text update", async () => {
    const database = await createDatabase();
    let releaseInitialReads!: () => void;
    const initialReadsReady = new Promise<void>((resolve) => { releaseInitialReads = resolve; });
    let initialReadCount = 0;
    const preparedStatements = new WeakMap<D1PreparedStatement, TestPreparedStatement>();
    const concurrentDatabase = {
      prepare(sql: string): D1PreparedStatement {
        const statement = database.prepare(sql);
        const wrapper = {
          bind(...values: Parameters<TestPreparedStatement["bind"]>) {
            statement.bind(...values);
            return wrapper;
          },
          first<T>() {
            if (sql.startsWith("SELECT error_text_de, error_text_en, revision") && initialReadCount < 2) {
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
        return database.batch(statements.map((statement) => preparedStatements.get(statement) as TestPreparedStatement));
      },
    } as unknown as D1Database;
    const app = appFor(concurrentDatabase);
    const firstRequest = app.fetch(requestFor(1, { de: "First DE", en: "First EN" }), { DB: concurrentDatabase });
    const secondRequest = app.fetch(requestFor(1, { de: "Second DE", en: "Second EN" }), { DB: concurrentDatabase });
    const responses = await Promise.all([firstRequest, secondRequest]);
    const auditCount = await database.prepare(
      "SELECT COUNT(*) AS count FROM audit_log WHERE channel_id = ? AND action = ?",
    ).bind(CHANNEL_ID, "sun.settings_changed").first<{ count: number }>();
    const saved = await readSunSettings(database as unknown as D1Database, CHANNEL_ID);

    expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([200, 409]);
    expect(auditCount?.count).toBe(1);
    expect(["First DE", "Second DE"]).toContain(saved.errorTexts.de);
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
  const csrfToken = await createCsrfToken(`session-${userId}`, environmentKeys.SESSION_COOKIE_KEYS, new Date().toISOString());
  return new Request(`https://brobot.example${path}`, {
    headers: { Cookie: `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrfToken}` },
  });
};

describe("sun settings via the real worker router", () => {
  it("keeps the sun module route scoped to its error text settings", async () => {
    const database = await createDatabase();
    await insertChannel(database, REAL_ROUTER_CHANNEL_ID);
    await insertLoginIdentityAndSession(database, "sun-real-router-user");
    await insertMember(database, REAL_ROUTER_CHANNEL_ID, "sun-real-router-user", "manager");
    const environment = { DB: database as unknown as D1Database, ...environmentKeys } as unknown as Env;

    const response = await panelRouter.fetch(
      await requestForRealRouter("sun-real-router-user", `/api/channels/${REAL_ROUTER_CHANNEL_ID}/modules/sun/error-texts`),
      environment,
    );
    const body = await response.json<{ errorTexts: { de: string; en: string }; revision: number }>();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      revision: 1,
      errorTexts: {
        de: "Sonnendaten sind derzeit nicht verfügbar.",
        en: "Sun data is currently unavailable.",
      },
    });
  });
});

describe("sun today route", () => {
  it("returns today's solar events and golden and blue hour intervals as ISO instants", async () => {
    const database = await createDatabase();
    await database.prepare(
      "UPDATE channels SET location_name = ?, location_latitude = ?, location_longitude = ?, location_time_zone = ? WHERE channel_id = ?",
    ).bind("Berlin", 52.52, 13.405, "Europe/Berlin", CHANNEL_ID).run();
    vi.setSystemTime(new Date("2026-10-21T12:00:00.000Z"));
    const app = appFor(database as unknown as D1Database);

    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/today`), {
      DB: database as unknown as D1Database,
    });
    const body = await response.json<{ status: string; day?: { localDate: string; sunriseAt: string | null; sunsetAt: string | null }; goldenHourIntervals?: { startAt: string; endAt: string }[]; blueHourIntervals?: { startAt: string; endAt: string }[]; nextDawnAt?: string | null }>();

    expect(response.status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.day?.localDate).toBe("2026-10-21");
    expect(Number.isFinite(Date.parse(body.day?.sunriseAt ?? ""))).toBe(true);
    expect(Number.isFinite(Date.parse(body.day?.sunsetAt ?? ""))).toBe(true);
    expect(body.nextDawnAt === null || Date.parse(body.nextDawnAt ?? "") > Date.now()).toBe(true);
    expect(body.goldenHourIntervals?.every(({ startAt, endAt }) => Date.parse(startAt) < Date.parse(endAt))).toBe(true);
    expect(body.blueHourIntervals?.every(({ startAt, endAt }) => Date.parse(startAt) < Date.parse(endAt))).toBe(true);
  });

  it("returns golden intervals overlapping Reykjavik's summer-solstice day across local midnight", async () => {
    const database = await createDatabase();
    await database.prepare(
      "UPDATE channels SET location_name = ?, location_latitude = ?, location_longitude = ?, location_time_zone = ? WHERE channel_id = ?",
    ).bind("Reykjavik", 64.1466, -21.9426, "Atlantic/Reykjavik", CHANNEL_ID).run();
    vi.setSystemTime(new Date("2026-06-21T12:00:00.000Z"));
    const app = appFor(database as unknown as D1Database);

    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/today`), {
      DB: database as unknown as D1Database,
    });
    const body = await response.json<{ status: string; goldenHourIntervals?: { startAt: string; endAt: string }[] }>();
    const intervals = body.goldenHourIntervals ?? [];
    const expected = [
      [Date.parse("2026-06-20T22:07:00.000Z"), Date.parse("2026-06-21T04:52:00.000Z")],
      [Date.parse("2026-06-21T22:07:00.000Z"), Date.parse("2026-06-22T04:52:00.000Z")],
    ] as const;

    expect(body.status).toBe("ok");
    expect(intervals).toHaveLength(2);
    for (const [index, interval] of intervals.entries()) {
      expect(Date.parse(interval.startAt)).toBeCloseTo(expected[index]?.[0] ?? 0, -6);
      expect(Date.parse(interval.endAt)).toBeCloseTo(expected[index]?.[1] ?? 0, -6);
    }
  });

  it("does not widen the blue-hour scan when Reykjavik has no blue-hour interval", async () => {
    const database = await createDatabase();
    await database.prepare(
      "UPDATE channels SET location_name = ?, location_latitude = ?, location_longitude = ?, location_time_zone = ? WHERE channel_id = ?",
    ).bind("Reykjavik", 64.15, -21.95, "Atlantic/Reykjavik", CHANNEL_ID).run();
    vi.setSystemTime(new Date("2026-06-21T12:00:00.000Z"));
    const calculateIntervals = vi.spyOn(sunDomain, "calculateSunAltitudeIntervals");
    const app = appFor(database as unknown as D1Database);

    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/today`), {
      DB: database as unknown as D1Database,
    });
    const body = await response.json<{ status: string; blueHourIntervals?: { startAt: string; endAt: string }[] }>();

    expect(body.status).toBe("ok");
    expect(body.blueHourIntervals).toEqual([]);
    expect(calculateIntervals.mock.calls.filter((call) => call[3] === "blue")).toHaveLength(1);
  });

  it("reuses solar intervals for the same rounded location, time zone, and local date", async () => {
    const database = await createDatabase();
    await database.prepare(
      "UPDATE channels SET location_name = ?, location_latitude = ?, location_longitude = ?, location_time_zone = ? WHERE channel_id = ?",
    ).bind("Valdivia", -39.82, -73.24, "America/Santiago", CHANNEL_ID).run();
    vi.setSystemTime(new Date("2026-11-04T12:00:00.000Z"));
    const calculateIntervals = vi.spyOn(sunDomain, "calculateSunAltitudeIntervals");
    const app = appFor(database as unknown as D1Database);
    const request = () => app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/today`), {
      DB: database as unknown as D1Database,
    });

    await request();
    const callsAfterFirstRequest = calculateIntervals.mock.calls.length;
    await request();

    expect(callsAfterFirstRequest).toBeGreaterThan(0);
    expect(calculateIntervals).toHaveBeenCalledTimes(callsAfterFirstRequest);
  });

  it("returns concrete golden and blue intervals for Berlin's local day", async () => {
    const database = await createDatabase();
    await database.prepare(
      "UPDATE channels SET location_name = ?, location_latitude = ?, location_longitude = ?, location_time_zone = ? WHERE channel_id = ?",
    ).bind("Berlin", 52.52, 13.405, "Europe/Berlin", CHANNEL_ID).run();
    vi.setSystemTime(new Date("2026-10-21T12:00:00.000Z"));
    const app = appFor(database as unknown as D1Database);

    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/today`), {
      DB: database as unknown as D1Database,
    });
    const body = await response.json<{
      status: string;
      goldenHourIntervals?: { startAt: string; endAt: string }[];
      blueHourIntervals?: { startAt: string; endAt: string }[];
    }>();
    const golden = body.goldenHourIntervals ?? [];
    const blue = body.blueHourIntervals ?? [];
    const withinMinutes = (actual: string | undefined, expected: string): boolean =>
      Math.abs(Date.parse(actual ?? "") - Date.parse(expected)) <= 15 * 60_000;

    expect(body.status).toBe("ok");
    expect(golden).toHaveLength(2);
    expect(withinMinutes(golden[0]?.startAt, "2026-10-21T05:18:00.000Z")).toBe(true);
    expect(withinMinutes(golden[0]?.endAt, "2026-10-21T06:24:00.000Z")).toBe(true);
    expect(withinMinutes(golden[1]?.startAt, "2026-10-21T15:14:00.000Z")).toBe(true);
    expect(withinMinutes(golden[1]?.endAt, "2026-10-21T16:20:00.000Z")).toBe(true);
    expect(blue).toHaveLength(2);
    expect(withinMinutes(blue[0]?.startAt, "2026-10-21T04:57:00.000Z")).toBe(true);
    expect(withinMinutes(blue[0]?.endAt, "2026-10-21T05:18:00.000Z")).toBe(true);
    expect(withinMinutes(blue[1]?.startAt, "2026-10-21T16:20:00.000Z")).toBe(true);
    expect(withinMinutes(blue[1]?.endAt, "2026-10-21T16:42:00.000Z")).toBe(true);
  });

  it("returns a missing-location state for channel members without a saved place", async () => {
    const database = await createDatabase();
    const app = appFor(database as unknown as D1Database);

    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/today`), {
      DB: database as unknown as D1Database,
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "location_missing" });
  });
});
