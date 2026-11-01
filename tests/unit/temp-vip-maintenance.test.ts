import { afterEach, describe, expect, it, vi } from "vitest";

import { maintainTempVipExpiries } from "../../src/worker/temp-vip-maintenance";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const databases: TestD1Database[] = [];
const createDatabase = async (): Promise<TestD1Database> => {
  const database = new TestD1Database();
  databases.push(database);
  for (const channelId of ["enabled-a", "enabled-b", "disabled", "missing"]) {
    await insertChannel(database, channelId);
  }
  await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('enabled-a', 'temp_vips', 1, '{}')").run();
  await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('enabled-b', 'temp_vips', 1, '{}')").run();
  await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('disabled', 'temp_vips', 0, '{}')").run();
  return database;
};

afterEach(() => {
  vi.restoreAllMocks();
  for (const database of databases.splice(0)) database.close();
});

describe("temporary VIP expiry maintenance", () => {
  it("wakes only enabled channels and continues after one Durable Object fails", async () => {
    const database = await createDatabase();
    const calls: string[] = [];
    const environment = {
      DB: database as unknown as D1Database,
      CHANNEL: {
        idFromName: (id: string) => id,
        get: (id: string) => ({
          runTempVipExpiry: vi.fn((now: string) => {
            calls.push(`${id}:${now}`);
            if (id === "enabled-a") throw new Error("temporarily unavailable");
          }),
        }),
      },
    } as unknown as Env;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await maintainTempVipExpiries(environment, "2026-11-01T12:00:00.000Z");

    expect(calls).toEqual([
      "enabled-a:2026-11-01T12:00:00.000Z",
      "enabled-b:2026-11-01T12:00:00.000Z",
    ]);
    expect(warning).toHaveBeenCalledTimes(1);
  });
});
