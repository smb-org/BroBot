import { afterEach, describe, expect, it } from "vitest";

import { createSessionCookie } from "../../src/worker/auth/session";
import { createCsrfToken } from "../../src/worker/auth/csrf";
import { panelRouter } from "../../src/worker/panel/routes";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "location-weather-access-channel";
const USER_ID = "location-weather-access-operator";
const UNRELATED_USER_ID = "location-weather-access-unrelated";
const keys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: testKey(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: testKey(2) }, retired: [] }),
};
const liveRoutePaths = [
  `/api/channels/${CHANNEL_ID}/modules/weather/current`,
  `/api/channels/${CHANNEL_ID}/modules/sun/today`,
  `/api/channels/${CHANNEL_ID}/modules/moon/today`,
];

const authenticatedRequest = async (path: string, userId: string): Promise<Request> => {
  const sessionId = `session-${userId}`;
  const cookie = await createSessionCookie({ sessionId }, keys.SESSION_COOKIE_KEYS, keys.SESSION_ENCRYPTION_KEYS);
  const csrf = await createCsrfToken(sessionId, keys.SESSION_COOKIE_KEYS, new Date().toISOString());
  return new Request(`https://brobot.example${path}`, {
    headers: { Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrf}` },
  });
};

describe("location live route access", () => {
  let database: TestD1Database | null = null;

  afterEach(() => {
    database?.close();
    database = null;
  });

  it("requires channel membership and allows an operator to read each live route", async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    await insertLoginIdentityAndSession(database, USER_ID);
    await insertLoginIdentityAndSession(database, UNRELATED_USER_ID);
    await insertMember(database, CHANNEL_ID, USER_ID, "operator");
    const environment = { DB: database as unknown as D1Database, ...keys } as unknown as Env;

    for (const path of liveRoutePaths) {
      const anonymous = await panelRouter.fetch(new Request(`https://brobot.example${path}`), environment);
      expect(anonymous.status).toBe(401);

      const unrelated = await panelRouter.fetch(await authenticatedRequest(path, UNRELATED_USER_ID), environment);
      expect(unrelated.status).toBe(403);

      const response = await panelRouter.fetch(await authenticatedRequest(path, USER_ID), environment);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: "location_missing" });
    }
  });
});
