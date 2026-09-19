import { afterEach, beforeEach, describe, expect, it } from "vitest";

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
  const headers = new Headers({
    Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrf}`,
    "Content-Type": "application/json",
    "X-CSRF-Token": csrf,
  });
  return new Request(`https://brobot.example${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
};

describe("Textbefehle-Panel", () => {
  let database: TestD1Database;

  beforeEach(() => { database = new TestD1Database(); });
  afterEach(() => { database.close(); });

  it("lässt einen Bediener Befehle anlegen, bearbeiten und löschen", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "bediener");
    const environment = environmentFor(database);

    const create = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/textbefehle/befehle", "POST", {
        name: "hallo", text: "Antwort", cooldownSekunden: 5,
      }),
      environment,
    );
    expect(create.status).toBe(201);

    const edit = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/textbefehle/befehle/hallo", "PATCH", {
        text: "Neue Antwort", cooldownSekunden: 10,
      }),
      environment,
    );
    expect(edit.status).toBe(200);

    const remove = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/textbefehle/befehle/hallo", "DELETE"),
      environment,
    );
    expect(remove.status).toBe(204);
    await expect(database.prepare("SELECT COUNT(*) AS count FROM textbefehle_commands").first<{ count: number }>())
      .resolves.toEqual({ count: 0 });
  });

  it("verweigert Nicht-Mitgliedern einen Befehl im fremden Kanal", async () => {
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "bediener");

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-b/modules/textbefehle/befehle", "POST", {
        name: "fremd", text: "Darf nicht", cooldownSekunden: 5,
      }),
      environmentFor(database),
    );

    expect(response.status).toBe(403);
    await expect(database.prepare("SELECT COUNT(*) AS count FROM textbefehle_commands").first<{ count: number }>())
      .resolves.toEqual({ count: 0 });
  });
});
