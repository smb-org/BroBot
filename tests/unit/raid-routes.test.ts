import { afterEach, describe, expect, it } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey } from "./fixtures";
import { TestD1Database } from "./test-d1";

const keys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: testKey(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: testKey(2) }, retired: [] }),
};
const databases: TestD1Database[] = [];

const databaseFor = async (): Promise<TestD1Database> => {
  const database = new TestD1Database();
  databases.push(database);
  await insertChannel(database, "channel-a");
  await insertChannel(database, "channel-b");
  await database.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('channel-a', 'raid', 1, ?), ('channel-b', 'raid', 1, ?)",
  ).bind(JSON.stringify({
    shoutoutEnabled: true, shoutoutThreshold: 4, textThreshold: 3, textLong: "Long {channel} {viewers}", textShort: "Short {channel} {viewers}",
  }), JSON.stringify({
    shoutoutEnabled: true, shoutoutThreshold: 9, textThreshold: 3, textLong: "Long {channel} {viewers}", textShort: "Short {channel} {viewers}",
  })).run();
  return database;
};

const environmentFor = (database: TestD1Database): Env => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "test-client",
  ...keys,
} as unknown as Env);

const requestFor = async (userId: string, path: string): Promise<Request> => {
  const sessionId = `session-${userId}`;
  const cookie = await createSessionCookie({ sessionId }, keys.SESSION_COOKIE_KEYS, keys.SESSION_ENCRYPTION_KEYS);
  const csrf = await createCsrfToken(sessionId, keys.SESSION_COOKIE_KEYS, new Date().toISOString());
  return new Request(`https://brobot.example${path}`, {
    headers: { Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrf}`, "X-CSRF-Token": csrf },
  });
};

const insertEvent = async (database: TestD1Database, channelId: string, eventId: string, code: string, detail: unknown, at: string): Promise<void> => {
  await database.prepare(
    `INSERT INTO event_log (event_id, channel_id, created_at, module_id, code, detail_json, trigger_id)
     VALUES (?, ?, ?, 'channel_events', ?, ?, ?)`,
  ).bind(eventId, channelId, at, code, JSON.stringify(detail), eventId).run();
};

afterEach(() => { for (const database of databases.splice(0)) database.close(); });

describe("Raid state route", () => {
  it("returns readiness, latest raid and shoutout for the authorized tenant", async () => {
    const database = await databaseFor();
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    await database.prepare(
      `INSERT INTO eventsub_subscriptions (channel_id, subscription_type, variant, subscription_id, status, updated_at)
       VALUES ('channel-a', 'channel.raid', 'incoming', 'raid-subscription', 'enabled', '2026-10-20T10:00:00.000Z')`,
    ).run();
    await insertEvent(database, "channel-a", "raid-a", "channel_events.raid.incoming", { source: "raider", viewers: 34 }, "2026-10-20T10:00:00.000Z");
    await insertEvent(database, "channel-a", "shoutout-a", "channel_events.shoutout.sent", { target: "raider" }, "2026-10-20T10:01:00.000Z");
    await insertEvent(database, "channel-b", "raid-b", "channel_events.raid.incoming", { source: "foreign_raider" }, "2026-10-20T11:00:00.000Z");

    const response = await panelRouter.fetch(
      await requestFor("manager-a", "/api/channels/channel-a/modules/raid/state"), environmentFor(database),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ready: true,
      shoutoutThreshold: 4,
      lastRaid: { channel: "raider", viewers: 34, at: "2026-10-20T10:00:00.000Z" },
      lastShoutout: { channel: "raider", at: "2026-10-20T10:01:00.000Z" },
    });
  });

  it("returns a stable empty state when there is no event history", async () => {
    const database = await databaseFor();
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");

    const response = await panelRouter.fetch(
      await requestFor("manager-a", "/api/channels/channel-a/modules/raid/state"), environmentFor(database),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ready: false,
      shoutoutThreshold: 4,
      lastRaid: null,
      lastShoutout: null,
    });
  });

  it("requires membership and rejects reads for another tenant", async () => {
    const database = await databaseFor();
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");

    const unauthenticated = await panelRouter.fetch(
      new Request("https://brobot.example/api/channels/channel-a/modules/raid/state"), environmentFor(database),
    );
    const foreign = await panelRouter.fetch(
      await requestFor("manager-a", "/api/channels/channel-b/modules/raid/state"), environmentFor(database),
    );

    expect(unauthenticated.status).toBe(401);
    expect(foreign.status).toBe(403);
    await expect(foreign.json()).resolves.not.toHaveProperty("lastRaid");
  });
});
