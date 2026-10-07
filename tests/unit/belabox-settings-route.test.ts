import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
import { BELABOX_DEFAULT_SETTINGS } from "../../src/modules/belabox/contracts";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "belabox-settings-channel";
const MANAGER_ID = "belabox-settings-manager";
const SESSION_COOKIE_KEYS = JSON.stringify({ active: { id: "cookie", key: testKey(71) }, retired: [] });
const TOKEN_ENCRYPTION_KEYS = JSON.stringify({ active: { id: "token", key: testKey(72) }, retired: [] });
const UPDATED_SETTINGS = {
  ...BELABOX_DEFAULT_SETTINGS,
  mode: "on_demand" as const,
  intervalSeconds: 30 as const,
  holdSeconds: 30,
  recoverHoldSeconds: 30,
};

const requestFor = async (body: unknown, path = "/settings"): Promise<Request> => {
  const sessionId = `session-${MANAGER_ID}`;
  const cookie = await createSessionCookie({ sessionId }, SESSION_COOKIE_KEYS, TOKEN_ENCRYPTION_KEYS);
  const csrf = await createCsrfToken(sessionId, SESSION_COOKIE_KEYS, new Date().toISOString());
  return new Request(`https://brobot.example/api/channels/${CHANNEL_ID}/modules/belabox${path}`, {
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

  afterEach(() => {
    vi.restoreAllMocks();
    database.close();
  });

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
      settings: UPDATED_SETTINGS,
    }), environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      settings: { mode: "on_demand", intervalSeconds: 30 },
      revision: 2,
    });
    expect(runModuleAlarm).toHaveBeenCalledOnce();
    expect(runModuleAlarm).toHaveBeenCalledWith("belabox", "ensure", "poll");
  });

  it("returns success after committing settings when poll ensure fails", async () => {
    const runModuleAlarm = vi.fn(() => Promise.reject(new Error("storage details must stay hidden")));
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
      settings: UPDATED_SETTINGS,
    }), environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ revision: 2 });
    await expect(database.prepare(
      "SELECT settings, revision FROM channel_modules WHERE channel_id = ? AND module_id = 'belabox'",
    ).bind(CHANNEL_ID).first()).resolves.toEqual({
      settings: JSON.stringify(UPDATED_SETTINGS),
      revision: 2,
    });
    expect(runModuleAlarm).toHaveBeenCalledWith("belabox", "ensure", "poll");
    const diagnostics = await database.prepare(
      "SELECT code FROM event_log WHERE channel_id = ? ORDER BY rowid",
    ).bind(CHANNEL_ID).all<{ code: string }>();
    expect(diagnostics.results).toEqual([{ code: "belabox.polling_ensure_failed" }]);
  });

  it("ensures the poll alarm when the module is disabled", async () => {
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

    const response = await panelRouter.fetch(await requestFor({ enabled: false }, ""), environment);

    expect(response.status).toBe(200);
    expect(runModuleAlarm).toHaveBeenCalledOnce();
    expect(runModuleAlarm).toHaveBeenCalledWith("belabox", "ensure", "poll");
    await expect(database.prepare(
      "SELECT enabled FROM channel_modules WHERE channel_id = ? AND module_id = 'belabox'",
    ).bind(CHANNEL_ID).first()).resolves.toEqual({ enabled: 0 });
  });
});
