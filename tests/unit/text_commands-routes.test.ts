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

describe("Text commands panel", () => {
  let database: TestD1Database;

  beforeEach(() => { database = new TestD1Database(); });
  afterEach(() => { database.close(); });

  it("lets a manager create, edit, and delete commands", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    const environment = environmentFor(database);

    const create = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands", "POST", {
        name: "hallo", text: "A".repeat(205), cooldownSeconds: 5,
      }),
      environment,
    );
    expect(create.status).toBe(201);

    const edit = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands/hallo", "PATCH", {
        text: "Neue Antwort", cooldownSeconds: 10,
      }),
      environment,
    );
    expect(edit.status).toBe(200);

    const remove = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands/hallo", "DELETE"),
      environment,
    );
    expect(remove.status).toBe(204);
    await expect(database.prepare("SELECT COUNT(*) AS count FROM text_commands").first<{ count: number }>())
      .resolves.toEqual({ count: 0 });

    const audits = await database.prepare(
      `SELECT actor_user_id, created_at, channel_id, module_id, action, before_json, after_json
         FROM audit_log
        WHERE channel_id = ?
        ORDER BY action`,
    ).bind("kanal-a").all<{
      actor_user_id: string;
      created_at: string;
      channel_id: string;
      module_id: string | null;
      action: string;
      before_json: string;
      after_json: string;
    }>();
    expect(audits.results).toHaveLength(3);
    expect(audits.results.every((audit) => audit.created_at.length > 0)).toBe(true);
    expect(audits.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actor_user_id: "user-1",
        channel_id: "kanal-a",
        module_id: "text_commands",
        action: "text_commands.command.created",
        before_json: "null",
        after_json: JSON.stringify({ name: "hallo", kind: "text", enabled: true, minimumTier: "everyone", text: `${"A".repeat(199)}…`, cooldownSeconds: 5 }),
      }),
      expect.objectContaining({
        actor_user_id: "user-1",
        channel_id: "kanal-a",
        module_id: "text_commands",
        action: "text_commands.command.updated",
        before_json: JSON.stringify({ name: "hallo", kind: "text", enabled: true, minimumTier: "everyone", text: `${"A".repeat(199)}…`, cooldownSeconds: 5 }),
        after_json: JSON.stringify({ name: "hallo", kind: "text", enabled: true, minimumTier: "everyone", text: "Neue Antwort", cooldownSeconds: 10 }),
      }),
      expect.objectContaining({
        actor_user_id: "user-1",
        channel_id: "kanal-a",
        module_id: "text_commands",
        action: "text_commands.command.removed",
        before_json: JSON.stringify({ name: "hallo", kind: "text", enabled: true, minimumTier: "everyone", text: "Neue Antwort", cooldownSeconds: 10 }),
        after_json: "null",
      }),
    ]));
  });

  it("distinguishes missing commands when editing and deleting", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    const environment = environmentFor(database);

    const edit = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands/fehlt", "PATCH", {
        text: "Neue Antwort", cooldownSeconds: 10,
      }),
      environment,
    );
    const remove = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands/fehlt", "DELETE"),
      environment,
    );

    expect(edit.status).toBe(404);
    await expect(edit.json()).resolves.toEqual({ error: "Der Befehl wurde nicht gefunden." });
    expect(remove.status).toBe(404);
    await expect(remove.json()).resolves.toEqual({ error: "Der Befehl wurde nicht gefunden." });
  });

  it("denies non-members a command in a foreign channel", async () => {
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-b/modules/text_commands/commands", "POST", {
        name: "fremd", text: "Darf nicht", cooldownSeconds: 5,
      }),
      environmentFor(database),
    );

    expect(response.status).toBe(403);
    await expect(database.prepare("SELECT COUNT(*) AS count FROM text_commands").first<{ count: number }>())
      .resolves.toEqual({ count: 0 });
  });

  it("allows a list line without text and requires text for the text kind", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    const environment = environmentFor(database);

    const list = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands", "POST", {
        name: "befehle", kind: "list", cooldownSeconds: 5,
      }),
      environment,
    );
    const text = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands", "POST", {
        name: "leer", kind: "text", cooldownSeconds: 5,
      }),
      environment,
    );

    expect(list.status).toBe(201);
    expect(text.status).toBe(400);
    await expect(database.prepare(
      "SELECT command_name, response_text, kind, enabled FROM text_commands",
    ).all()).resolves.toMatchObject({
      results: [{ command_name: "befehle", response_text: "", kind: "list", enabled: 1 }],
    });
  });

  it("lets a manager toggle a command and audits the toggle", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    const environment = environmentFor(database);

    const create = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands", "POST", {
        name: "hallo", text: "Antwort", kind: "text", cooldownSeconds: 5,
      }),
      environment,
    );
    const toggle = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands/hallo", "PATCH", {
        enabled: false,
      }),
      environment,
    );

    expect(create.status).toBe(201);
    expect(toggle.status).toBe(200);
    await expect(database.prepare(
      "SELECT enabled FROM text_commands WHERE command_name = 'hallo'",
    ).first()).resolves.toEqual({ enabled: 0 });
    await expect(database.prepare(
      "SELECT action, before_json, after_json FROM audit_log WHERE action = 'text_commands.command.updated'",
    ).first()).resolves.toEqual({
      action: "text_commands.command.updated",
      before_json: JSON.stringify({ name: "hallo", kind: "text", enabled: true, minimumTier: "everyone", text: "Antwort", cooldownSeconds: 5 }),
      after_json: JSON.stringify({ name: "hallo", kind: "text", enabled: false, minimumTier: "everyone", text: "Antwort", cooldownSeconds: 5 }),
    });
  });

  it("lets an operator toggle a command", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    const environment = environmentFor(database);

    await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands", "POST", {
        name: "hallo", text: "Antwort", cooldownSeconds: 5,
      }),
      environment,
    );
    await database.prepare("UPDATE channel_members SET role = 'operator' WHERE channel_id = 'kanal-a' AND user_id = 'user-1'").run();
    const toggle = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands/hallo", "PATCH", {
        enabled: false,
      }),
      environment,
    );

    expect(toggle.status).toBe(200);
    await expect(database.prepare(
      "SELECT enabled FROM text_commands WHERE command_name = 'hallo'",
    ).first()).resolves.toEqual({ enabled: 0 });
  });

  it("denies an operator create, edit, and delete", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    const environment = environmentFor(database);

    const create = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands", "POST", {
        name: "hallo", text: "Antwort", cooldownSeconds: 5,
      }),
      environment,
    );
    await database.prepare("UPDATE channel_members SET role = 'operator' WHERE channel_id = 'kanal-a' AND user_id = 'user-1'").run();

    const deniedCreate = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands", "POST", {
        name: "neu", text: "Neue Antwort", cooldownSeconds: 5,
      }),
      environment,
    );
    const deniedEdit = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands/hallo", "PATCH", {
        text: "Geändert",
      }),
      environment,
    );
    const deniedDelete = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands/hallo", "DELETE"),
      environment,
    );

    expect(create.status).toBe(201);
    expect(deniedCreate.status).toBe(403);
    expect(deniedEdit.status).toBe(403);
    expect(deniedDelete.status).toBe(403);
    await expect(database.prepare(
      "SELECT command_name, response_text FROM text_commands ORDER BY command_name",
    ).all()).resolves.toMatchObject({ results: [{ command_name: "hallo", response_text: "Antwort" }] });
  });

  it("requires the managing threshold for a combined toggle-and-text change", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    const environment = environmentFor(database);

    await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands", "POST", {
        name: "hallo", text: "Antwort", cooldownSeconds: 5,
      }),
      environment,
    );
    await database.prepare("UPDATE channel_members SET role = 'operator' WHERE channel_id = 'kanal-a' AND user_id = 'user-1'").run();

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands/hallo", "PATCH", {
        enabled: false, text: "Neue Antwort",
      }),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(database.prepare(
      "SELECT response_text, enabled FROM text_commands WHERE command_name = 'hallo'",
    ).first()).resolves.toEqual({ response_text: "Antwort", enabled: 1 });
  });

  it("requires the managing threshold for changing the minimum tier and audits it", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    const environment = environmentFor(database);

    await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands", "POST", {
        name: "hallo", text: "Antwort", cooldownSeconds: 5,
      }),
      environment,
    );
    await database.prepare("UPDATE channel_members SET role = 'operator' WHERE channel_id = 'kanal-a' AND user_id = 'user-1'").run();
    const denied = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands/hallo", "PATCH", {
        minimumTier: "moderator",
      }),
      environment,
    );
    expect(denied.status).toBe(403);

    await database.prepare("UPDATE channel_members SET role = 'manager' WHERE channel_id = 'kanal-a' AND user_id = 'user-1'").run();
    const changed = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands/hallo", "PATCH", {
        minimumTier: "moderator",
      }),
      environment,
    );

    expect(changed.status).toBe(200);
    await expect(database.prepare(
      "SELECT minimum_level FROM text_commands WHERE command_name = 'hallo'",
    ).first()).resolves.toEqual({ minimum_level: "moderator" });
    await expect(database.prepare(
      "SELECT before_json, after_json FROM audit_log WHERE action = 'text_commands.command.updated'",
    ).first()).resolves.toEqual({
      before_json: JSON.stringify({ name: "hallo", kind: "text", enabled: true, minimumTier: "everyone", text: "Antwort", cooldownSeconds: 5 }),
      after_json: JSON.stringify({ name: "hallo", kind: "text", enabled: true, minimumTier: "moderator", text: "Antwort", cooldownSeconds: 5 }),
    });
  });
});
