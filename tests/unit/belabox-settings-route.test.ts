import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "belabox-settings-channel";
const MANAGER_ID = "belabox-settings-manager";
const SESSION_COOKIE_KEYS = JSON.stringify({ active: { id: "cookie", key: testKey(71) }, retired: [] });
const TOKEN_ENCRYPTION_KEYS = JSON.stringify({ active: { id: "token", key: testKey(72) }, retired: [] });

const requestFor = async (body: unknown): Promise<Request> => {
  const sessionId = `session-${MANAGER_ID}`;
  const cookie = await createSessionCookie({ sessionId }, SESSION_COOKIE_KEYS, TOKEN_ENCRYPTION_KEYS);
  const csrf = await createCsrfToken(sessionId, SESSION_COOKIE_KEYS, new Date().toISOString());
  return new Request(`https://brobot.example/api/channels/${CHANNEL_ID}/modules/belabox/settings`, {
    method: "PATCH",
    headers: {
      Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrf}`,
      "X-CSRF-Token": csrf,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
};

describe("BELABOX settings route", () => {
  let database: TestD1Database;

  beforeEach(async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    await insertLoginIdentityAndSession(database, MANAGER_ID);
    await insertMember(database, CHANNEL_ID, MANAGER_ID, "manager");
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'belabox', 1, ?)",
    ).bind(CHANNEL_ID, JSON.stringify({ mode: "interval", intervalSeconds: 15 })).run();
  });

  afterEach(() => { database.close(); });

  it("runs the declared poll alarm immediately after a successful settings save", async () => {
    const runModuleAlarm = vi.fn(() => Promise.resolve());
    const environment = {
      DB: database as unknown as D1Database,
      SESSION_COOKIE_KEYS,
      TOKEN_ENCRYPTION_KEYS,
      CHANNEL: {
        idFromName: (channelId: string) => channelId,
        get: () => ({ runModuleAlarm }),
      },
    } as unknown as Env;

    const response = await panelRouter.fetch(await requestFor({
      revision: 1,
      settings: { mode: "on_demand", intervalSeconds: 30 },
    }), environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      settings: { mode: "on_demand", intervalSeconds: 30 },
      revision: 2,
    });
    expect(runModuleAlarm).toHaveBeenCalledOnce();
    expect(runModuleAlarm).toHaveBeenCalledWith("belabox", "poll", "poll");
  });
});
