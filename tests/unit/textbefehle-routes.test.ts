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

  it("lässt einen Verwalter Befehle anlegen, bearbeiten und löschen", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "verwalter");
    const environment = environmentFor(database);

    const create = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/textbefehle/befehle", "POST", {
        name: "hallo", text: "A".repeat(205), cooldownSekunden: 5,
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
        module_id: "textbefehle",
        action: "textbefehle.befehl.angelegt",
        before_json: "null",
        after_json: JSON.stringify({ name: "hallo", art: "text", enabled: true, mindeststufe: "alle", text: `${"A".repeat(199)}…`, cooldownSekunden: 5 }),
      }),
      expect.objectContaining({
        actor_user_id: "user-1",
        channel_id: "kanal-a",
        module_id: "textbefehle",
        action: "textbefehle.befehl.geändert",
        before_json: JSON.stringify({ name: "hallo", art: "text", enabled: true, mindeststufe: "alle", text: `${"A".repeat(199)}…`, cooldownSekunden: 5 }),
        after_json: JSON.stringify({ name: "hallo", art: "text", enabled: true, mindeststufe: "alle", text: "Neue Antwort", cooldownSekunden: 10 }),
      }),
      expect.objectContaining({
        actor_user_id: "user-1",
        channel_id: "kanal-a",
        module_id: "textbefehle",
        action: "textbefehle.befehl.entfernt",
        before_json: JSON.stringify({ name: "hallo", art: "text", enabled: true, mindeststufe: "alle", text: "Neue Antwort", cooldownSekunden: 10 }),
        after_json: "null",
      }),
    ]));
  });

  it("unterscheidet beim Ändern und Löschen fehlende Befehle", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "bediener");
    const environment = environmentFor(database);

    const edit = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/textbefehle/befehle/fehlt", "PATCH", {
        text: "Neue Antwort", cooldownSekunden: 10,
      }),
      environment,
    );
    const remove = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/textbefehle/befehle/fehlt", "DELETE"),
      environment,
    );

    expect(edit.status).toBe(404);
    await expect(edit.json()).resolves.toEqual({ error: "Der Befehl wurde nicht gefunden." });
    expect(remove.status).toBe(404);
    await expect(remove.json()).resolves.toEqual({ error: "Der Befehl wurde nicht gefunden." });
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

  it("erlaubt eine Listenzeile ohne Text und verlangt Text für die Art text", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "verwalter");
    const environment = environmentFor(database);

    const liste = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/textbefehle/befehle", "POST", {
        name: "befehle", art: "liste", cooldownSekunden: 5,
      }),
      environment,
    );
    const text = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/textbefehle/befehle", "POST", {
        name: "leer", art: "text", cooldownSekunden: 5,
      }),
      environment,
    );

    expect(liste.status).toBe(201);
    expect(text.status).toBe(400);
    await expect(database.prepare(
      "SELECT command_name, response_text, art, enabled FROM textbefehle_commands",
    ).all()).resolves.toMatchObject({
      results: [{ command_name: "befehle", response_text: "", art: "liste", enabled: 1 }],
    });
  });

  it("lässt einen Verwalter einen Befehl schalten und auditiert die Schaltung", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "verwalter");
    const environment = environmentFor(database);

    const create = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/textbefehle/befehle", "POST", {
        name: "hallo", text: "Antwort", art: "text", cooldownSekunden: 5,
      }),
      environment,
    );
    const toggle = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/textbefehle/befehle/hallo", "PATCH", {
        enabled: false,
      }),
      environment,
    );

    expect(create.status).toBe(201);
    expect(toggle.status).toBe(200);
    await expect(database.prepare(
      "SELECT enabled FROM textbefehle_commands WHERE command_name = 'hallo'",
    ).first()).resolves.toEqual({ enabled: 0 });
    await expect(database.prepare(
      "SELECT action, before_json, after_json FROM audit_log WHERE action = 'textbefehle.befehl.geändert'",
    ).first()).resolves.toEqual({
      action: "textbefehle.befehl.geändert",
      before_json: JSON.stringify({ name: "hallo", art: "text", enabled: true, mindeststufe: "alle", text: "Antwort", cooldownSekunden: 5 }),
      after_json: JSON.stringify({ name: "hallo", art: "text", enabled: false, mindeststufe: "alle", text: "Antwort", cooldownSekunden: 5 }),
    });
  });

  it("lässt einen Bediener einen Befehl schalten", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "verwalter");
    const environment = environmentFor(database);

    await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/textbefehle/befehle", "POST", {
        name: "hallo", text: "Antwort", cooldownSekunden: 5,
      }),
      environment,
    );
    await database.prepare("UPDATE channel_members SET role = 'bediener' WHERE channel_id = 'kanal-a' AND user_id = 'user-1'").run();
    const toggle = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/textbefehle/befehle/hallo", "PATCH", {
        enabled: false,
      }),
      environment,
    );

    expect(toggle.status).toBe(200);
    await expect(database.prepare(
      "SELECT enabled FROM textbefehle_commands WHERE command_name = 'hallo'",
    ).first()).resolves.toEqual({ enabled: 0 });
  });

  it("verweigert einem Bediener Anlegen, Ändern und Löschen", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "verwalter");
    const environment = environmentFor(database);

    const create = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/textbefehle/befehle", "POST", {
        name: "hallo", text: "Antwort", cooldownSekunden: 5,
      }),
      environment,
    );
    await database.prepare("UPDATE channel_members SET role = 'bediener' WHERE channel_id = 'kanal-a' AND user_id = 'user-1'").run();

    const deniedCreate = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/textbefehle/befehle", "POST", {
        name: "neu", text: "Neue Antwort", cooldownSekunden: 5,
      }),
      environment,
    );
    const deniedEdit = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/textbefehle/befehle/hallo", "PATCH", {
        text: "Geändert",
      }),
      environment,
    );
    const deniedDelete = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/textbefehle/befehle/hallo", "DELETE"),
      environment,
    );

    expect(create.status).toBe(201);
    expect(deniedCreate.status).toBe(403);
    expect(deniedEdit.status).toBe(403);
    expect(deniedDelete.status).toBe(403);
    await expect(database.prepare(
      "SELECT command_name, response_text FROM textbefehle_commands ORDER BY command_name",
    ).all()).resolves.toMatchObject({ results: [{ command_name: "hallo", response_text: "Antwort" }] });
  });

  it("verlangt für eine gemeinsame Schalter- und Textänderung die verwaltende Schwelle", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "verwalter");
    const environment = environmentFor(database);

    await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/textbefehle/befehle", "POST", {
        name: "hallo", text: "Antwort", cooldownSekunden: 5,
      }),
      environment,
    );
    await database.prepare("UPDATE channel_members SET role = 'bediener' WHERE channel_id = 'kanal-a' AND user_id = 'user-1'").run();

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/textbefehle/befehle/hallo", "PATCH", {
        enabled: false, text: "Neue Antwort",
      }),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(database.prepare(
      "SELECT response_text, enabled FROM textbefehle_commands WHERE command_name = 'hallo'",
    ).first()).resolves.toEqual({ response_text: "Antwort", enabled: 1 });
  });

  it("verlangt für das Ändern der Mindeststufe die verwaltende Schwelle und auditiert es", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "verwalter");
    const environment = environmentFor(database);

    await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/textbefehle/befehle", "POST", {
        name: "hallo", text: "Antwort", cooldownSekunden: 5,
      }),
      environment,
    );
    await database.prepare("UPDATE channel_members SET role = 'bediener' WHERE channel_id = 'kanal-a' AND user_id = 'user-1'").run();
    const denied = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/textbefehle/befehle/hallo", "PATCH", {
        mindeststufe: "moderator",
      }),
      environment,
    );
    expect(denied.status).toBe(403);

    await database.prepare("UPDATE channel_members SET role = 'verwalter' WHERE channel_id = 'kanal-a' AND user_id = 'user-1'").run();
    const changed = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/textbefehle/befehle/hallo", "PATCH", {
        mindeststufe: "moderator",
      }),
      environment,
    );

    expect(changed.status).toBe(200);
    await expect(database.prepare(
      "SELECT minimum_level FROM textbefehle_commands WHERE command_name = 'hallo'",
    ).first()).resolves.toEqual({ minimum_level: "moderator" });
    await expect(database.prepare(
      "SELECT before_json, after_json FROM audit_log WHERE action = 'textbefehle.befehl.geändert'",
    ).first()).resolves.toEqual({
      before_json: JSON.stringify({ name: "hallo", art: "text", enabled: true, mindeststufe: "alle", text: "Antwort", cooldownSekunden: 5 }),
      after_json: JSON.stringify({ name: "hallo", art: "text", enabled: true, mindeststufe: "moderator", text: "Antwort", cooldownSekunden: 5 }),
    });
  });
});
