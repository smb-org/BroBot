import { afterEach, describe, expect, it } from "vitest";

import { handleSunAlarm, refreshSunRecord } from "../../src/modules/sun/service";
import { TestD1Database } from "./test-d1";
import { insertChannel } from "./fixtures";

const databases: TestD1Database[] = [];

const createDatabase = async (): Promise<TestD1Database> => {
  const database = new TestD1Database();
  databases.push(database);
  await insertChannel(database, "sun-channel");
  await database.prepare(
    `INSERT INTO sun_locations (channel_id, name, latitude, longitude, location_time_zone, revision)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind("sun-channel", "Berlin, Germany", 52.52, 13.405, "Europe/Berlin", 2).run();
  return database;
};

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("sun data persistence", () => {
  it("replaces the channel record with exactly today and tomorrow", async () => {
    const database = await createDatabase();
    const now = Date.parse("2026-06-21T00:16:00.000Z");

    const result = await refreshSunRecord(database as unknown as D1Database, "sun-channel", now);
    const rows = await database.prepare(
      "SELECT local_date, fetched_at, expires_at FROM sun_times WHERE channel_id = ? ORDER BY local_date",
    ).bind("sun-channel").all<{ local_date: string; fetched_at: string; expires_at: string }>();

    expect(result.refreshed).toBe(true);
    expect(rows.results.map((row) => row.local_date)).toEqual(["2026-06-21", "2026-06-22"]);
    expect(rows.results.map((row) => row.fetched_at)).toEqual([new Date(now).toISOString(), new Date(now).toISOString()]);
    expect(rows.results[0]?.expires_at).toBe("2026-06-22T22:00:00.000Z");
    expect(result.nextRefreshAt).toBe("2026-06-21T22:15:00.000Z");
  });

  it("retains the prior tomorrow row as today's data when the midnight refresh fails", async () => {
    const database = await createDatabase();
    const yesterday = Date.parse("2026-06-20T00:16:00.000Z");
    await refreshSunRecord(database as unknown as D1Database, "sun-channel", yesterday);
    const outageDatabase = {
      prepare: database.prepare.bind(database),
      batch: () => Promise.reject(new Error("D1 is temporarily unavailable.")),
    } as unknown as D1Database;

    await handleSunAlarm(outageDatabase, "sun-channel", Date.parse("2026-06-21T00:16:00.000Z"));
    const rows = await database.prepare(
      "SELECT local_date FROM sun_times WHERE channel_id = ? ORDER BY local_date",
    ).bind("sun-channel").all<{ local_date: string }>();

    expect(rows.results.map((row) => row.local_date)).toEqual(["2026-06-20", "2026-06-21"]);
  });

  it("persists civil dusk for a polar-night day", async () => {
    const database = await createDatabase();
    await database.prepare("UPDATE channels SET time_zone = ? WHERE channel_id = ?")
      .bind("Europe/Oslo", "sun-channel").run();
    await database.prepare(
      `UPDATE sun_locations
          SET name = ?, latitude = ?, longitude = ?, location_time_zone = ?
        WHERE channel_id = ?`,
    ).bind("Tromsø", 69.6492, 18.9553, "Europe/Oslo", "sun-channel").run();

    const result = await refreshSunRecord(database as unknown as D1Database, "sun-channel", Date.parse("2026-12-21T12:00:00.000Z"));
    const today = await database.prepare(
      "SELECT sunrise_at, sunset_at, dusk_at, polar_state FROM sun_times WHERE channel_id = ? AND local_date = ?",
    ).bind("sun-channel", "2026-12-21").first<{
      sunrise_at: string | null;
      sunset_at: string | null;
      dusk_at: string | null;
      polar_state: string;
    }>();

    expect(result.refreshed).toBe(true);
    expect(today).toMatchObject({ sunrise_at: null, sunset_at: null, polar_state: "night" });
    expect(today?.dusk_at).not.toBeNull();
  });
});
