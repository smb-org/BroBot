import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

const key = (byte: number): string => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
  .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const environmentKeys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
};

let database: TestD1Database;

const environmentFor = (database: TestD1Database): Env => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  ...environmentKeys,
} as unknown as Env);

const requestFor = async (
  userId: string,
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
): Promise<Request> => {
  const cookie = await createSessionCookie(
    { sessionId: `session-${userId}` },
    environmentKeys.SESSION_COOKIE_KEYS,
    environmentKeys.SESSION_ENCRYPTION_KEYS,
  );
  const csrf = await createCsrfToken(`session-${userId}`, environmentKeys.SESSION_COOKIE_KEYS, new Date().toISOString());
  return new Request(`https://brobot.example${path}`, {
    method,
    headers: new Headers({
      Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrf}`,
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
    }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
};

const fetchPanel = async (
  userId: string,
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
): Promise<Response> => panelRouter.fetch(
  await requestFor(userId, path, method, body),
  environmentFor(database),
);

describe("Channel variable routes", () => {
  beforeEach(() => { database = new TestD1Database(); });
  afterEach(() => { vi.useRealTimers(); database.close(); });

  it("lets operators change values while keeping variable management for managers", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertLoginIdentityAndSession(database, "operator-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    await insertMember(database, "channel-a", "operator-a", "operator");

    const created = await fetchPanel("manager-a", "/api/channels/channel-a/variables", "POST", {
      name: "score", value: 4, description: "Current score", resetOnStreamStart: false,
    });
    expect(created.status).toBe(201);

    const changed = await fetchPanel("operator-a", "/api/channels/channel-a/variables/score/value", "POST", {
      operation: "add", amount: 3,
    });
    expect(changed.status).toBe(200);
    await expect(database.prepare(
      "SELECT value FROM channel_variables WHERE channel_id = 'channel-a' AND name = 'score'",
    ).first()).resolves.toEqual({ value: 7 });

    const createDenied = await fetchPanel("operator-a", "/api/channels/channel-a/variables", "POST", { name: "other" });
    const renameDenied = await fetchPanel("operator-a", "/api/channels/channel-a/variables/score", "PATCH", { newName: "points" });
    const deleteDenied = await fetchPanel("operator-a", "/api/channels/channel-a/variables/score", "DELETE");
    expect(createDenied.status).toBe(403);
    expect(renameDenied.status).toBe(403);
    expect(deleteDenied.status).toBe(403);
  });

  it("renames template and action references atomically and protects action usage from deletion", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");

    await fetchPanel("manager-a", "/api/channels/channel-a/variables", "POST", {
      name: "score", value: 0, description: "", resetOnStreamStart: false,
    });
    await database.prepare(
      `INSERT INTO text_commands
        (channel_id, command_name, response_text, created_at, updated_at, variable_name, variable_operation, variable_amount)
       VALUES ('channel-a', 'points', 'Score: {var.score}', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z', 'score', 'add', 1)`,
    ).run();
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('channel-a', 'ads', 1, '{"prewarningText":"Score {var.score}"}')`,
    ).run();

    const renamed = await fetchPanel("manager-a", "/api/channels/channel-a/variables/score", "PATCH", { newName: "points" });
    expect(renamed.status).toBe(200);
    await expect(database.prepare(
      "SELECT response_text, variable_name, revision FROM text_commands WHERE channel_id = 'channel-a' AND command_name = 'points'",
    ).first()).resolves.toEqual({ response_text: "Score: {var.points}", variable_name: "points", revision: 2 });
    await expect(database.prepare(
      "SELECT settings, revision FROM channel_modules WHERE channel_id = 'channel-a' AND module_id = 'ads'",
    ).first()).resolves.toEqual({ settings: '{"prewarningText":"Score {var.points}"}', revision: 2 });

    const deletion = await fetchPanel("manager-a", "/api/channels/channel-a/variables/points", "DELETE");
    expect(deletion.status).toBe(409);
    await expect(deletion.json()).resolves.toMatchObject({ error: "variable_in_use" });
  });
});
