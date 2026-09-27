import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey } from "./fixtures";
import { TestD1Database } from "./test-d1";

const keys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: testKey(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: testKey(2) }, retired: [] }),
};

let database: TestD1Database;

const environmentFor = (DB: D1Database): Env => ({ DB, ...keys, TWITCH_CLIENT_ID: "client-id" } as unknown as Env);

const locationRequest = async (location: unknown, revision: number): Promise<Request> => {
  const cookie = await createSessionCookie({ sessionId: "session-manager" }, keys.SESSION_COOKIE_KEYS, keys.SESSION_ENCRYPTION_KEYS);
  const csrf = await createCsrfToken("session-manager", keys.SESSION_COOKIE_KEYS, new Date().toISOString());
  return new Request("https://brobot.example/api/channels/channel-a/settings/location", {
    method: "PATCH",
    headers: new Headers({
      Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrf}`,
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
    }),
    body: JSON.stringify({ revision, location }),
  });
};

describe("channel location setting route", () => {
  beforeEach(async () => {
    database = new TestD1Database();
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager");
    await insertMember(database, "channel-a", "manager", "manager");
  });

  afterEach(() => { database.close(); });

  it("stores the host location, leaves channel time zone unchanged, and records a host audit entry", async () => {
    const location = { name: "Honolulu, Hawaii", latitude: 21.3069, longitude: -157.8583, timeZone: "Pacific/Honolulu" };
    const response = await panelRouter.fetch(await locationRequest(location, 1), environmentFor(database as unknown as D1Database));
    const channel = await database.prepare(
      `SELECT time_zone, location_name, location_latitude, location_longitude, location_time_zone, location_revision
         FROM channels WHERE channel_id = 'channel-a'`,
    ).first<Record<string, unknown>>();
    const audit = await database.prepare(
      "SELECT module_id, action, before_json, after_json FROM audit_log WHERE channel_id = 'channel-a'",
    ).first<{ module_id: string | null; action: string; before_json: string; after_json: string }>();
    const settingsResponse = await panelRouter.fetch(new Request("https://brobot.example/api/channels/channel-a/settings", {
      headers: { Cookie: `__Host-brobot_session=${await createSessionCookie({ sessionId: "session-manager" }, keys.SESSION_COOKIE_KEYS, keys.SESSION_ENCRYPTION_KEYS)}` },
    }), environmentFor(database as unknown as D1Database));
    const settings = await settingsResponse.json<{ timeZone: string; location: unknown; locationRevision: number }>();

    expect(response.status).toBe(200);
    expect(channel).toEqual({
      time_zone: "Europe/Berlin",
      location_name: location.name,
      location_latitude: location.latitude,
      location_longitude: location.longitude,
      location_time_zone: location.timeZone,
      location_revision: 2,
    });
    expect(settingsResponse.status).toBe(200);
    expect(settings).toMatchObject({ timeZone: "Europe/Berlin", location, locationRevision: 2 });
    expect(audit?.module_id).toBeNull();
    expect(audit?.action).toBe("channel.location.updated");
    expect(JSON.parse(audit?.before_json ?? "{}") as Record<string, unknown>).toBeNull();
    expect(JSON.parse(audit?.after_json ?? "{}") as Record<string, unknown>).toEqual({
      locationName: location.name,
      latitude: location.latitude,
      longitude: location.longitude,
      locationTimeZone: location.timeZone,
    });
  });

  it("rejects an out-of-date location revision without an audit entry", async () => {
    const response = await panelRouter.fetch(await locationRequest(null, 2), environmentFor(database as unknown as D1Database));
    const audit = await database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE channel_id = 'channel-a'")
      .first<{ count: number }>();

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "channel_location_conflict" });
    expect(audit).toEqual({ count: 0 });
  });
});
