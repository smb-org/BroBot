import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey } from "./fixtures";
import { TestD1Database, type TestPreparedStatement } from "./test-d1";

const keys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: testKey(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: testKey(2) }, retired: [] }),
};

let database: TestD1Database;

const environmentFor = (DB: D1Database): Env => ({
  DB,
  ...keys,
  TWITCH_CLIENT_ID: "client-id",
} as unknown as Env);

const patchSettings = async (): Promise<Request> => {
  const cookie = await createSessionCookie({ sessionId: "session-manager" }, keys.SESSION_COOKIE_KEYS, keys.SESSION_ENCRYPTION_KEYS);
  const csrf = await createCsrfToken("session-manager", keys.SESSION_COOKIE_KEYS, new Date().toISOString());
  return new Request("https://brobot.example/api/channels/channel-a/settings", {
    method: "PATCH",
    headers: new Headers({
      Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrf}`,
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
    }),
    body: JSON.stringify({ timeZone: "Europe/Berlin", revision: 1 }),
  });
};

describe("channel time zone settings route", () => {
  beforeEach(async () => {
    database = new TestD1Database();
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager");
    await insertMember(database, "channel-a", "manager", "manager");
  });

  afterEach(() => { database.close(); });

  it("updates the time zone and batches a host audit record", async () => {
    const response = await panelRouter.fetch(await patchSettings(), environmentFor(database as unknown as D1Database));
    const channel = await database.prepare("SELECT time_zone, time_zone_revision FROM channels WHERE channel_id = 'channel-a'")
      .first<{ time_zone: string; time_zone_revision: number }>();
    const audit = await database.prepare(
      "SELECT module_id, action, before_json, after_json FROM audit_log WHERE channel_id = 'channel-a'",
    ).first<{ module_id: string | null; action: string; before_json: string; after_json: string }>();

    expect(response.status).toBe(200);
    expect(channel).toEqual({ time_zone: "Europe/Berlin", time_zone_revision: 2 });
    expect(audit).toMatchObject({
      module_id: null,
      action: "channel.time_zone.updated",
      before_json: JSON.stringify({ timeZone: "Europe/Berlin" }),
      after_json: JSON.stringify({ timeZone: "Europe/Berlin" }),
    });
  });

  it.each(["session", "membership"] as const)("blocks a %s revocation before the SQL mutation", async (revocation) => {
    const guardedDb = {
      prepare: (sql: string): TestPreparedStatement => {
        if (/^\s*UPDATE channels SET time_zone/iu.test(sql)) {
          if (revocation === "session") {
            database.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE session_id = 'session-manager'")
              .bind(new Date().toISOString()).runSync();
          } else {
            database.prepare("DELETE FROM channel_members WHERE channel_id = 'channel-a' AND user_id = 'manager'").runSync();
          }
        }
        return database.prepare(sql);
      },
      batch: (statements: TestPreparedStatement[]) => database.batch(statements),
    } as unknown as D1Database;

    const response = await panelRouter.fetch(await patchSettings(), environmentFor(guardedDb));
    const channel = await database.prepare("SELECT time_zone, time_zone_revision FROM channels WHERE channel_id = 'channel-a'")
      .first<{ time_zone: string; time_zone_revision: number }>();
    const auditCount = await database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE channel_id = 'channel-a'")
      .first<{ count: number }>();

    expect(response.status).toBe(409);
    expect(channel).toEqual({ time_zone: "Europe/Berlin", time_zone_revision: 1 });
    expect(auditCount).toEqual({ count: 0 });
  });
});
