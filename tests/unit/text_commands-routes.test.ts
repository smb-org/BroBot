import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
import { textFingerprint } from "../../src/text";
import { createTextBlockRepository } from "../../src/modules/text_library/adapters/d1";
import { createTextLibraryService } from "../../src/modules/text_library/service";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey as key } from "./fixtures";
import { TestD1Database } from "./test-d1";

const environmentKeys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
};

const environmentFor = (database: TestD1Database): Env => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  ...environmentKeys,
} as unknown as Env);

let database: TestD1Database;

const requestFor = async (
  userId: string,
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
): Promise<Request> => {
  let requestBody = body;
  const commandPath = /^\/api\/channels\/([^/]+)\/modules\/text_commands\/commands\/([^/]+)$/u.exec(path);
  if (method === "PATCH" && body !== undefined && body.revision === undefined && commandPath !== null) {
    const channelId = decodeURIComponent(commandPath[1] ?? "");
    const name = decodeURIComponent(commandPath[2] ?? "");
    const current = await database.prepare(
      "SELECT revision FROM text_commands WHERE channel_id = ? AND command_name = ?",
    ).bind(channelId, name).first<{ revision: number }>();
    if (current !== null) requestBody = { ...body, revision: current.revision };
  }
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
    ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
  });
};

describe("Text commands panel", () => {
  beforeEach(() => { database = new TestD1Database(); });
  afterEach(() => { vi.useRealTimers(); database.close(); });

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

    const saved = await database.prepare(
      "SELECT revision FROM text_commands WHERE channel_id = 'kanal-a' AND command_name = 'hallo'",
    ).first<{ revision: number }>();
    if (saved === null) throw new Error("Updated command was not found.");

    const remove = await panelRouter.fetch(
      await requestFor("user-1", `/api/channels/kanal-a/modules/text_commands/commands/hallo?revision=${String(saved.revision)}`, "DELETE"),
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
    const longTextHash = await textFingerprint("A".repeat(205));
    expect(audits.results).toEqual(expect.arrayContaining([
      expect.objectContaining({
        actor_user_id: "user-1",
        channel_id: "kanal-a",
        module_id: "text_commands",
        action: "text_commands.command.created",
        before_json: "null",
        after_json: JSON.stringify({ name: "hallo", kind: "text", enabled: true, minimumTier: "everyone", text: `${"A".repeat(199)}…`, textHash: longTextHash, cooldownSeconds: 5, aliases: [], userCooldownSeconds: 0, streamCondition: "any", games: [], responseType: "say", chatTarget: "source_only" }),
      }),
      expect.objectContaining({
        actor_user_id: "user-1",
        channel_id: "kanal-a",
        module_id: "text_commands",
        action: "text_commands.command.updated",
        before_json: JSON.stringify({ name: "hallo", kind: "text", enabled: true, minimumTier: "everyone", text: `${"A".repeat(199)}…`, textHash: longTextHash, cooldownSeconds: 5, aliases: [], userCooldownSeconds: 0, streamCondition: "any", games: [], responseType: "say", chatTarget: "source_only" }),
        after_json: JSON.stringify({ name: "hallo", kind: "text", enabled: true, minimumTier: "everyone", text: "Neue Antwort", cooldownSeconds: 10, aliases: [], userCooldownSeconds: 0, streamCondition: "any", games: [], responseType: "say", chatTarget: "source_only" }),
      }),
      expect.objectContaining({
        actor_user_id: "user-1",
        channel_id: "kanal-a",
        module_id: "text_commands",
        action: "text_commands.command.removed",
        before_json: JSON.stringify({ name: "hallo", kind: "text", enabled: true, minimumTier: "everyone", text: "Neue Antwort", cooldownSeconds: 10, aliases: [], userCooldownSeconds: 0, streamCondition: "any", games: [], responseType: "say", chatTarget: "source_only" }),
        after_json: "null",
      }),
    ]));
  });

  it("persists Twitch box art with a command game filter", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    const game = {
      id: "123",
      name: "Example Game",
      boxArtUrlTemplate: "https://static-cdn.jtvnw.net/ttv-boxart/123-{width}x{height}.jpg",
    };
    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands", "POST", {
        name: "game", text: "Game response", cooldownSeconds: 0, games: [game],
      }),
      environmentFor(database),
    );

    expect(response.status).toBe(201);
    await expect(database.prepare(
      "SELECT games_json FROM text_commands WHERE channel_id = 'kanal-a' AND command_name = 'game'",
    ).first<{ games_json: string }>()).resolves.toEqual({ games_json: JSON.stringify([game]) });
  });

  it("validates and audits structured caller timeouts and only exposes their variables when enabled", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    const environment = environmentFor(database);
    const collection = "/api/channels/kanal-a/modules/text_commands/commands";
    const timeoutAction = {
      minSeconds: 30,
      maxSeconds: 60,
      fallbackText: "Cannot time out for {timeout.duration} ({timeout.seconds}).",
      reason: "Repeated spam",
    };
    const created = await panelRouter.fetch(
      await requestFor("user-1", collection, "POST", {
        name: "roulette",
        kind: "timeout",
        text: "Timed out for {timeout.duration} ({timeout.seconds}).",
        cooldownSeconds: 0,
        timeoutAction,
      }),
      environment,
    );
    expect(created.status).toBe(201);
    await expect(created.json<{ command: { timeoutAction: unknown }; warnings: unknown[] }>()).resolves.toMatchObject({
      command: { timeoutAction },
      warnings: [],
    });
    await expect(database.prepare(
      `SELECT timeout_min_seconds, timeout_max_seconds, timeout_fallback_text, timeout_reason
         FROM text_commands WHERE channel_id = 'kanal-a' AND command_name = 'roulette'`,
    ).first()).resolves.toEqual({
      timeout_min_seconds: 30,
      timeout_max_seconds: 60,
      timeout_fallback_text: timeoutAction.fallbackText,
      timeout_reason: timeoutAction.reason,
    });

    const updatedAction = { minSeconds: 45, maxSeconds: 45, fallbackText: "Try again for {timeout.seconds} seconds.", reason: "Repeated spam" };
    const updated = await panelRouter.fetch(
      await requestFor("user-1", `${collection}/roulette`, "PATCH", { timeoutAction: updatedAction }),
      environment,
    );
    expect(updated.status).toBe(200);
    await expect(database.prepare(
      "SELECT timeout_min_seconds, timeout_max_seconds, timeout_fallback_text, timeout_reason FROM text_commands WHERE command_name = 'roulette'",
    ).first()).resolves.toEqual({
      timeout_min_seconds: 45,
      timeout_max_seconds: 45,
      timeout_fallback_text: updatedAction.fallbackText,
      timeout_reason: updatedAction.reason,
    });
    const audit = await database.prepare(
      "SELECT after_json FROM audit_log WHERE action = 'text_commands.command.updated'",
    ).first<{ after_json: string }>();
    expect(JSON.parse(audit?.after_json ?? "null") as Record<string, unknown>).toMatchObject({
      timeoutMinSeconds: 45,
      timeoutMaxSeconds: 45,
      timeoutFallbackText: updatedAction.fallbackText,
      timeoutReason: updatedAction.reason,
    });

    const invalidRange = await panelRouter.fetch(
      await requestFor("user-1", collection, "POST", {
        name: "invalidrange", kind: "timeout", text: "Response", cooldownSeconds: 0,
        timeoutAction: { minSeconds: 0, maxSeconds: 2, fallbackText: "Fallback" },
      }),
      environment,
    );
    const wrongKind = await panelRouter.fetch(
      await requestFor("user-1", collection, "POST", {
        name: "invalidkind", kind: "list", text: "", cooldownSeconds: 0,
        timeoutAction: { minSeconds: 1, maxSeconds: 1, fallbackText: "Fallback" },
      }),
      environment,
    );
    const longFallback = await panelRouter.fetch(
      await requestFor("user-1", collection, "POST", {
        name: "longfallback", kind: "timeout", text: "Response", cooldownSeconds: 0,
        timeoutAction: { minSeconds: 1, maxSeconds: 1, fallbackText: "x".repeat(501) },
      }),
      environment,
    );
    expect([invalidRange.status, wrongKind.status, longFallback.status]).toEqual([400, 400, 400]);

    const withoutAction = await panelRouter.fetch(
      await requestFor("user-1", collection, "POST", {
        name: "literal", text: "{timeout.seconds}", cooldownSeconds: 0,
      }),
      environment,
    );
    expect(withoutAction.status).toBe(201);
    await expect(withoutAction.json<{ warnings: Array<{ code: string; unknownVariables?: string[] }> }>())
      .resolves.toMatchObject({ warnings: [expect.objectContaining({ unknownVariables: ["timeout.seconds"] })] });
  });

  it("accepts empty timeout reply and fallback text on create and update", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    const environment = environmentFor(database);
    const collection = "/api/channels/kanal-a/modules/text_commands/commands";
    const created = await panelRouter.fetch(
      await requestFor("user-1", collection, "POST", {
        name: "silent",
        kind: "timeout",
        text: "",
        cooldownSeconds: 0,
        timeoutAction: { minSeconds: 1, maxSeconds: 1, fallbackText: "" },
      }),
      environment,
    );
    expect(created.status).toBe(201);

    const updated = await panelRouter.fetch(
      await requestFor("user-1", `${collection}/silent`, "PATCH", {
        text: " ",
        timeoutAction: { minSeconds: 1, maxSeconds: 1, fallbackText: " " },
      }),
      environment,
    );
    expect(updated.status).toBe(200);
    await expect(updated.json<{ command: { text: string; timeoutAction: { fallbackText: string } } }>()).resolves.toMatchObject({
      command: { text: " ", timeoutAction: { fallbackText: " " } },
    });
  });

  it("returns the current command when a second editor saves an old revision", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    const environment = environmentFor(database);
    const collection = "/api/channels/kanal-a/modules/text_commands/commands";
    const created = await panelRouter.fetch(
      await requestFor("user-1", collection, "POST", { name: "hello", text: "Original", cooldownSeconds: 0 }),
      environment,
    );
    expect(created.status).toBe(201);
    const loadedAResponse = await panelRouter.fetch(await requestFor("user-1", collection), environment);
    const loadedA = await loadedAResponse.json<{ commands: Array<{ name: string; createdAt: string; revision: number }> }>();
    const revision = loadedA.commands[0]?.revision;
    expect(revision).toBe(Date.parse(loadedA.commands[0]?.createdAt ?? ""));
    if (revision === undefined) throw new Error("Created command has no revision.");
    const nextRevision = revision + 1;

    const savedA = await panelRouter.fetch(
      await requestFor("user-1", `${collection}/hello`, "PATCH", { revision, text: "Saved by editor A" }),
      environment,
    );
    expect(savedA.status).toBe(200);
    const savedB = await panelRouter.fetch(
      await requestFor("user-1", `${collection}/hello`, "PATCH", { revision, text: "Stale editor B" }),
      environment,
    );
    expect(savedB.status).toBe(409);
    await expect(savedB.json()).resolves.toMatchObject({
      error: "command_changed_concurrently",
      current: { name: "hello", text: "Saved by editor A", revision: nextRevision },
    });
    await expect(database.prepare(
      "SELECT response_text, revision FROM text_commands WHERE channel_id = 'kanal-a' AND command_name = 'hello'",
    ).first()).resolves.toEqual({ response_text: "Saved by editor A", revision: nextRevision });
  });

  it("requires the displayed revision to delete and preserves a newer command", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    const environment = environmentFor(database);
    const collection = "/api/channels/kanal-a/modules/text_commands/commands";
    await panelRouter.fetch(
      await requestFor("user-1", collection, "POST", { name: "hello", text: "Original", cooldownSeconds: 0 }),
      environment,
    );
    const original = await database.prepare(
      "SELECT revision FROM text_commands WHERE channel_id = 'kanal-a' AND command_name = 'hello'",
    ).first<{ revision: number }>();
    if (original === null) throw new Error("Created command was not found.");

    const missingRevision = await panelRouter.fetch(
      await requestFor("user-1", `${collection}/hello`, "DELETE"),
      environment,
    );
    expect(missingRevision.status).toBe(400);
    await expect(missingRevision.json()).resolves.toEqual({ error: "command_data_invalid" });

    await panelRouter.fetch(
      await requestFor("user-1", `${collection}/hello`, "PATCH", { revision: original.revision, text: "Saved elsewhere" }),
      environment,
    );
    const staleDelete = await panelRouter.fetch(
      await requestFor("user-1", `${collection}/hello?revision=${String(original.revision)}`, "DELETE"),
      environment,
    );

    expect(staleDelete.status).toBe(409);
    await expect(staleDelete.json()).resolves.toMatchObject({
      error: "command_changed_concurrently",
      current: { name: "hello", text: "Saved elsewhere", revision: original.revision + 1 },
    });
    await expect(database.prepare(
      "SELECT response_text, revision FROM text_commands WHERE channel_id = 'kanal-a' AND command_name = 'hello'",
    ).first()).resolves.toEqual({ response_text: "Saved elsewhere", revision: original.revision + 1 });
  });

  it("rejects a stale save after deleting and recreating the same command name", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T12:00:00.000Z"));
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    const environment = environmentFor(database);
    const collection = "/api/channels/kanal-a/modules/text_commands/commands";
    const firstCreate = await panelRouter.fetch(
      await requestFor("user-1", collection, "POST", { name: "hello", text: "Original", cooldownSeconds: 0 }),
      environment,
    );
    expect(firstCreate.status).toBe(201);
    const loaded = await panelRouter.fetch(await requestFor("user-1", collection), environment);
    const originalCommands = await loaded.json<{ commands: Array<{ revision: number }> }>();
    const originalRevision = originalCommands.commands[0]?.revision;
    if (originalRevision === undefined) throw new Error("Created command has no revision.");

    const remove = await panelRouter.fetch(
      await requestFor("user-1", `${collection}/hello?revision=${String(originalRevision)}`, "DELETE"),
      environment,
    );
    expect(remove.status).toBe(204);
    vi.setSystemTime(new Date("2026-09-19T12:00:00.010Z"));
    const replacement = await panelRouter.fetch(
      await requestFor("user-1", collection, "POST", { name: "hello", text: "Replacement", cooldownSeconds: 0 }),
      environment,
    );
    expect(replacement.status).toBe(201);

    const staleSave = await panelRouter.fetch(
      await requestFor("user-1", `${collection}/hello`, "PATCH", { revision: originalRevision, text: "Stale save" }),
      environment,
    );
    expect(staleSave.status).toBe(409);
    await expect(staleSave.json()).resolves.toMatchObject({
      error: "command_changed_concurrently",
      current: { name: "hello", text: "Replacement", revision: Date.parse("2026-09-19T12:00:00.010Z") },
    });
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
    await expect(edit.json()).resolves.toEqual({ error: "command_not_found" });
    expect(remove.status).toBe(404);
    await expect(remove.json()).resolves.toEqual({ error: "command_not_found" });
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

  it("accepts the supported command kinds and rejects retired kinds", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    const environment = environmentFor(database);
    const responses = await Promise.all([
      panelRouter.fetch(await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands", "POST", {
        name: "simple", kind: "text", text: "Hello {user}", usageText: "Try !simple 12.50", cooldownSeconds: 5,
      }), environment),
      panelRouter.fetch(await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands", "POST", {
        name: "list", kind: "list", cooldownSeconds: 5,
      }), environment),
      panelRouter.fetch(await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands", "POST", {
        name: "shoutout", kind: "shoutout", text: "Visit {target}", cooldownSeconds: 5,
      }), environment),
      panelRouter.fetch(await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands", "POST", {
        name: "quietso", kind: "shoutout", text: "Visit {target}", usageText: "", cooldownSeconds: 5,
      }), environment),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201, 201, 201]);
    const commands = await Promise.all(responses.map(async (response) => {
      const payload: unknown = await response.json();
      if (typeof payload !== "object" || payload === null || !("command" in payload)) {
        throw new Error("The command was missing from the response.");
      }
      return payload.command;
    }));
    expect(commands[0]).toMatchObject({ kind: "text", text: "Hello {user}", usageText: "Try !simple 12.50" });
    expect(commands[1]).toMatchObject({ kind: "list", text: "" });
    expect(commands[2]).toMatchObject({ kind: "shoutout", text: "Visit {target}", usageText: "Nutzung: !so <name>" });
    expect(commands[3]).toMatchObject({ kind: "shoutout", text: "Visit {target}", usageText: "" });

    for (const [index, kind] of ["uptime", "followage", "game"].entries()) {
      const rejected = await panelRouter.fetch(
        await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands", "POST", {
          name: `retired${String(index)}`, kind, text: "Legacy", cooldownSeconds: 5,
        }),
        environment,
      );
      expect(rejected.status).toBe(400);
    }
  });

  it("defaults new command options, and requires a manager to change response type", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    const environment = environmentFor(database);
    const created = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands", "POST", {
        name: "hallo", text: "Antwort", cooldownSeconds: 0,
      }),
      environment,
    );

    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      command: {
        aliases: [], userCooldownSeconds: 0, streamCondition: "any", responseType: "say",
      },
    });
    const changed = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands/hallo", "PATCH", {
        responseType: "reply",
      }),
      environment,
    );
    expect(changed.status).toBe(200);
    await database.prepare("UPDATE channel_members SET role = 'operator' WHERE channel_id = 'kanal-a' AND user_id = 'user-1'").run();
    const denied = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands/hallo", "PATCH", {
        responseType: "announcement",
      }),
      environment,
    );
    expect(denied.status).toBe(403);
    await expect(database.prepare(
      "SELECT response_type FROM text_commands WHERE command_name = 'hallo'",
    ).first()).resolves.toEqual({ response_type: "reply" });
  });

  it("validates alias shape and reports atomic cross-command alias conflicts", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    const environment = environmentFor(database);
    const createPath = "/api/channels/kanal-a/modules/text_commands/commands";
    const create = async (body: Record<string, unknown>) => panelRouter.fetch(
      await requestFor("user-1", createPath, "POST", body), environment,
    );
    const first = await create({ name: "first", text: "First", cooldownSeconds: 0, aliases: ["friendly"] });
    const second = await create({ name: "second", text: "Second", cooldownSeconds: 0, aliases: ["second-alias"] });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const invalidBodies = [
      { name: "self", text: "x", cooldownSeconds: 0, aliases: ["self"] },
      { name: "duplicate", text: "x", cooldownSeconds: 0, aliases: ["same", "same"] },
      { name: "too-many", text: "x", cooldownSeconds: 0, aliases: Array.from({ length: 11 }, (_value, index) => `a${String(index)}`) },
      { name: "punctuation", text: "x", cooldownSeconds: 0, aliases: ["!hello"] },
      { name: "uppercase", text: "x", cooldownSeconds: 0, aliases: ["Hello"] },
    ];
    for (const body of invalidBodies) expect((await create(body)).status).toBe(400);

    const aliasOfName = await create({ name: "new-one", text: "x", cooldownSeconds: 0, aliases: ["first"] });
    expect(aliasOfName.status).toBe(409);
    await expect(aliasOfName.json()).resolves.toEqual({
      error: "command_alias_conflict",
      conflict: { field: "aliases", trigger: "first", command: "first" },
    });
    const aliasOfAlias = await create({ name: "new-two", text: "x", cooldownSeconds: 0, aliases: ["second-alias"] });
    expect(aliasOfAlias.status).toBe(409);
    await expect(aliasOfAlias.json()).resolves.toEqual({
      error: "command_alias_conflict",
      conflict: { field: "aliases", trigger: "second-alias", command: "second" },
    });

    const renamedToAlias = await panelRouter.fetch(
      await requestFor("user-1", `${createPath}/first`, "PATCH", { name: "second-alias" }),
      environment,
    );
    expect(renamedToAlias.status).toBe(409);
    await expect(renamedToAlias.json()).resolves.toEqual({
      error: "command_alias_conflict",
      conflict: { field: "name", trigger: "second-alias", command: "second" },
    });
    const renamed = await panelRouter.fetch(
      await requestFor("user-1", `${createPath}/first`, "PATCH", { name: "renamed" }),
      environment,
    );
    expect(renamed.status).toBe(200);
    await expect(renamed.json()).resolves.toMatchObject({ command: { name: "renamed", aliases: ["friendly"] } });
  });

  it("accepts unknown template variables with warnings and rejects templates above 500 characters", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    const environment = environmentFor(database);

    const created = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands", "POST", {
        name: "vorlage",
        text: `${"x".repeat(480)} {user} {zzz}`,
        cooldownSeconds: 5,
      }),
      environment,
    );

    expect(created.status).toBe(201);
    await expect(created.json()).resolves.toMatchObject({
      warnings: [
        { field: "text", code: "unknown_template_variables", unknownVariables: ["zzz"] },
        { field: "text", code: "template_worst_case_too_long", worstCaseLength: 512 },
      ],
    });
    await expect(database.prepare(
      "SELECT response_text FROM text_commands WHERE command_name = 'vorlage'",
    ).first()).resolves.toEqual({ response_text: `${"x".repeat(480)} {user} {zzz}` });

    const oversized = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands/vorlage", "PATCH", {
        text: "x".repeat(501),
      }),
      environment,
    );
    expect(oversized.status).toBe(400);
  });

  it("recognizes registered text-library variables when validating a command", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    const library = createTextLibraryService(createTextBlockRepository(
      database as unknown as D1Database,
      () => ({ sql: "AND 1 = 1", values: [] }),
    ));
    const snapshot = await library.list("kanal-a");
    const createdBlock = await library.create({
      channelId: "kanal-a",
      name: "welcome",
      categoryId: "social",
      games: [],
      variants: [{ id: "default", conditions: {}, texts: ["Welcome!"] }],
      expectedGraphRevision: snapshot.settings.graphRevision,
      now: new Date().toISOString(),
    }, { userId: "user-1", sessionId: "session-user-1" }, snapshot);
    expect(createdBlock.ok).toBe(true);

    const createdCommand = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/text_commands/commands", "POST", {
        name: "greeting", text: "Hello {welcome}", cooldownSeconds: 0,
      }),
      environmentFor(database),
    );

    expect(createdCommand.status).toBe(201);
    const body = await createdCommand.json<{ warnings: Array<{ code: string; unknownVariables?: string[] }> }>();
    expect(body.warnings.flatMap((warning) => warning.unknownVariables ?? [])).not.toContain("welcome");
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
      before_json: JSON.stringify({ name: "hallo", kind: "text", enabled: true, minimumTier: "everyone", text: "Antwort", cooldownSeconds: 5, aliases: [], userCooldownSeconds: 0, streamCondition: "any", games: [], responseType: "say", chatTarget: "source_only" }),
      after_json: JSON.stringify({ name: "hallo", kind: "text", enabled: false, minimumTier: "everyone", text: "Antwort", cooldownSeconds: 5, aliases: [], userCooldownSeconds: 0, streamCondition: "any", games: [], responseType: "say", chatTarget: "source_only" }),
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
      before_json: JSON.stringify({ name: "hallo", kind: "text", enabled: true, minimumTier: "everyone", text: "Antwort", cooldownSeconds: 5, aliases: [], userCooldownSeconds: 0, streamCondition: "any", games: [], responseType: "say", chatTarget: "source_only" }),
      after_json: JSON.stringify({ name: "hallo", kind: "text", enabled: true, minimumTier: "moderator", text: "Antwort", cooldownSeconds: 5, aliases: [], userCooldownSeconds: 0, streamCondition: "any", games: [], responseType: "say", chatTarget: "source_only" }),
    });
  });
});
