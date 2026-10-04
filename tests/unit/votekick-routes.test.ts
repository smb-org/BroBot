import { afterEach, describe, expect, it, vi } from "vitest";

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
  return database;
};

const environmentFor = (database: TestD1Database, runModuleAlarm = vi.fn(() => Promise.resolve())): Env => ({
  DB: database as unknown as D1Database,
  CHANNEL: {
    idFromName: (channelId: string) => channelId,
    get: () => ({ runModuleAlarm }),
  },
  ...keys,
} as unknown as Env);

const requestFor = async (userId: string, path: string, method = "GET"): Promise<Request> => {
  const sessionId = `session-${userId}`;
  const cookie = await createSessionCookie({ sessionId }, keys.SESSION_COOKIE_KEYS, keys.SESSION_ENCRYPTION_KEYS);
  const csrf = await createCsrfToken(sessionId, keys.SESSION_COOKIE_KEYS, new Date().toISOString());
  return new Request(`https://brobot.example${path}`, {
    method,
    headers: {
      Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrf}`,
      "X-CSRF-Token": csrf,
    },
  });
};

const insertRunning = async (database: TestD1Database, channelId: string, id: string): Promise<void> => {
  const now = new Date().toISOString();
  await database.prepare(
    `INSERT INTO votekicks
      (channel_id, votekick_id, target_user_id, target_login, initiator_user_id, status, threshold,
       yes_votes, no_votes, ballot_revision, started_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'running', 3, 1, 0, 1, ?, ?)`,
  ).bind(channelId, id, `${id}-target`, `${id}-target`, `${id}-starter`, now, new Date(Date.now() + 60_000).toISOString()).run();
};

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("Votekick routes", () => {
  it("scopes panel history to the authorized channel and rejects cross-tenant reads", async () => {
    const database = await databaseFor();
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    await insertRunning(database, "channel-a", "ballot-a");
    await insertRunning(database, "channel-b", "ballot-b");
    const runModuleAlarm = vi.fn(() => Promise.resolve());
    const environment = environmentFor(database, runModuleAlarm);

    const own = await panelRouter.fetch(
      await requestFor("manager-a", "/api/channels/channel-a/modules/votekick/votekicks"), environment,
    );
    const foreign = await panelRouter.fetch(
      await requestFor("manager-a", "/api/channels/channel-b/modules/votekick/votekicks"), environment,
    );
    const foreignCancel = await panelRouter.fetch(
      await requestFor("manager-a", "/api/channels/channel-b/modules/votekick/votekicks/ballot-b/cancel", "POST"), environment,
    );
    const foreignRow = await database.prepare("SELECT status FROM votekicks WHERE channel_id = 'channel-b' AND votekick_id = 'ballot-b'")
      .first<{ status: string }>();

    expect(own.status).toBe(200);
    await expect(own.json()).resolves.toMatchObject({ running: { id: "ballot-a" }, votekicks: [{ id: "ballot-a" }] });
    expect(runModuleAlarm).toHaveBeenCalledWith("votekick", "close", "close:ballot-a");
    expect(foreign.status).toBe(403);
    expect(foreignCancel.status).toBe(403);
    expect(foreignRow).toEqual({ status: "running" });
  });

  it("allows an operator to cancel the running ballot they can operate", async () => {
    const database = await databaseFor();
    await insertLoginIdentityAndSession(database, "operator-a");
    await insertMember(database, "channel-a", "operator-a", "operator");
    await insertRunning(database, "channel-a", "ballot-a");
    const response = await panelRouter.fetch(
      await requestFor("operator-a", "/api/channels/channel-a/modules/votekick/votekicks/ballot-a/cancel", "POST"),
      environmentFor(database),
    );
    const row = await database.prepare("SELECT status FROM votekicks WHERE channel_id = 'channel-a' AND votekick_id = 'ballot-a'")
      .first<{ status: string }>();

    expect(response.status).toBe(204);
    expect(row).toEqual({ status: "cancelled" });
  });

  it("reconciles a running votekick through its alarm handler on panel access", async () => {
    const database = await databaseFor();
    await insertLoginIdentityAndSession(database, "operator-a");
    await insertMember(database, "channel-a", "operator-a", "operator");
    await insertRunning(database, "channel-a", "ballot-panel");
    const runModuleAlarm = vi.fn(() => Promise.resolve());
    const response = await panelRouter.fetch(
      await requestFor("operator-a", "/api/channels/channel-a/modules/votekick/votekicks"),
      environmentFor(database, runModuleAlarm),
    );

    expect(response.status).toBe(200);
    expect(runModuleAlarm).toHaveBeenCalledWith("votekick", "close", "close:ballot-panel");
  });
});
