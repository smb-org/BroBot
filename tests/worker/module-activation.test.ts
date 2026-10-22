import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { duelSettingsForLanguage } from "../../src/modules/duel/contracts";
import { notifyModuleScheduleInputsChanged, reconcileChannelTimerSchedules } from "../../src/worker/module-schedules";
import { panelRouter } from "../../src/worker/panel/routes";

const migrationSources = import.meta.glob<string>("../../migrations/*.sql", {
  query: "?raw",
  import: "default",
  eager: true,
});

const migrationStatements = (source: string): string[] => {
  const segments = source.split(/\r?\n/u).map((line) => line.replace(/^\s*--.*$/u, "")).join("\n").split(";");
  const statements: string[] = [];
  let trigger: string[] | null = null;
  for (const segment of segments) {
    const statement = segment.trim();
    if (statement.length === 0) continue;
    if (trigger !== null) {
      if (statement.toUpperCase() === "END") {
        statements.push(`${trigger.join(";")};${statement}`);
        trigger = null;
      } else trigger.push(statement);
    } else if (/^CREATE\s+TRIGGER\b/iu.test(statement)) trigger = [statement];
    else statements.push(statement);
  }
  return statements;
};

const workerEnvironment = env as unknown as Env;
const database = workerEnvironment.DB;
const testKey = (byte: number): string => Buffer.from(new Uint8Array(32).fill(byte)).toString("base64url");
const testKeyRing = (id: string, byte: number): string => JSON.stringify({
  active: { id, key: testKey(byte) },
  retired: [],
});
const testSessionCookieKeys = testKeyRing("module-activation-cookie", 1);
const testTokenEncryptionKeys = testKeyRing("module-activation-encryption", 2);
const testEnvironment = {
  ...workerEnvironment,
  SESSION_COOKIE_KEYS: testSessionCookieKeys,
  TOKEN_ENCRYPTION_KEYS: testTokenEncryptionKeys,
} as Env;

beforeAll(async () => {
  for (const path of Object.keys(migrationSources).sort((left, right) => left.localeCompare(right))) {
    for (const statement of migrationStatements(migrationSources[path] ?? "")) {
      await database.prepare(statement).run();
    }
  }
});

const insertChannel = async (channelId: string): Promise<void> => {
  const now = new Date().toISOString();
  await database.prepare(
    `INSERT INTO channels (channel_id, login, display_name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).bind(channelId, channelId, channelId, now, now).run();
};

const authenticatedRequestFactory = async (
  channelId: string,
): Promise<(path: string, method: "POST" | "PATCH", body: unknown) => Request> => {
  const sessionId = `session-${channelId}`;
  const userId = `user-${channelId}`;
  const now = new Date().toISOString();
  await database.prepare(
    `INSERT INTO twitch_login_identity
      (user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext, expires_at, status, created_at, updated_at)
     VALUES (?, ?, '[]', 'test-access', 'test-refresh', '2099-09-19T00:00:00.000Z', 'connected', ?, ?)`,
  ).bind(userId, userId, now, now).run();
  await database.prepare(
    `INSERT INTO auth_sessions (session_id, user_id, login, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, '2099-09-19T00:00:00.000Z', ?, ?)`,
  ).bind(sessionId, userId, userId, now, now).run();
  await database.prepare(
    `INSERT INTO channel_members (channel_id, user_id, role, created_at, updated_at)
     VALUES (?, ?, 'broadcaster', ?, ?)`,
  ).bind(channelId, userId, now, now).run();

  const cookie = await createSessionCookie(
    { sessionId },
    testSessionCookieKeys,
    testTokenEncryptionKeys,
  );
  const csrf = await createCsrfToken(sessionId, testSessionCookieKeys, now);
  return (path, method, body) => new Request(`https://brobot.example${path}`, {
    method,
    headers: {
      Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrf}`,
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
    },
    body: JSON.stringify(body),
  });
};

const activationRequest = async (channelId: string, moduleId = "points"): Promise<Request> => {
  const request = await authenticatedRequestFactory(channelId);
  return request(`/api/channels/${channelId}/modules/${moduleId}`, "PATCH", { enabled: true });
};

describe("module activation schedule RPCs", () => {
  it("enables points through the real ChannelObject stub and returns the committed state (protects=module activation reaches the real schedule notification RPC and returns 200 after D1 commits; fails_when=the Durable Object receives a remote call named call and activation returns an error after commit; no_claim=external Twitch EventSub health or browser toast rendering)", async () => {
    const channelId = `module-activation-${crypto.randomUUID()}`;
    await insertChannel(channelId);
    const request = await activationRequest(channelId);

    const response = await panelRouter.fetch(request, testEnvironment);
    const body = await response.json<{ module: { id: string; enabled: boolean }; revision: number }>();

    expect(response.status).toBe(200);
    expect(body.module).toMatchObject({ id: "points", enabled: true });
    expect(body.revision).toBe(1);
    await expect(database.prepare(
      "SELECT enabled FROM channel_modules WHERE channel_id = ? AND module_id = 'points'",
    ).bind(channelId).first()).resolves.toEqual({ enabled: 1 });
  });

  it("rejects Text Commands activation when its built-in list command collides with an enabled module [protects=activation's atomic collision guard includes the built-in !befehle row inserted by onEnable; fails_when=Text Commands returns 200 and creates !befehle beside an enabled duel using that token; no_claim=the real panel router uses fixed cookie and token key rings and D1-backed module state]", async () => {
    const channelId = `module-activation-command-collision-${crypto.randomUUID()}`;
    await insertChannel(channelId);
    const duelSettings = { ...duelSettingsForLanguage("en"), challengeCommand: "!befehle" };
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'duel', 1, ?, 1)",
    ).bind(channelId, JSON.stringify(duelSettings)).run();

    const response = await panelRouter.fetch(await activationRequest(channelId, "text_commands"), testEnvironment);
    const body = await response.json<{ error?: string; command?: string }>();
    const module = await database.prepare(
      "SELECT enabled FROM channel_modules WHERE channel_id = ? AND module_id = 'text_commands'",
    ).bind(channelId).first<{ enabled: number }>();
    const command = await database.prepare(
      "SELECT command_name FROM text_commands WHERE channel_id = ? AND command_name = 'befehle'",
    ).bind(channelId).first<{ command_name: string }>();

    expect(response.status).toBe(409);
    expect(body).toEqual({ error: "module_command_collision", command: "!befehle" });
    expect(module).toBeNull();
    expect(command).toBeNull();
  });

  it("reuses a custom befehle command when activating Text Commands through the real router [protects=first activation accepts the existing command row that initializeListCommand reuses; fails_when=activation returns 409 for the row it would preserve; no_claim=commands owned by other modules are allowed to share !befehle]", async () => {
    const channelId = `module-activation-command-reuse-${crypto.randomUUID()}`;
    await insertChannel(channelId);
    const request = await authenticatedRequestFactory(channelId);
    const createResponse = await panelRouter.fetch(request(
      `/api/channels/${channelId}/modules/text_commands/commands`,
      "POST",
      { name: "befehle", text: "Custom command response", cooldownSeconds: 5 },
    ), testEnvironment);

    expect(createResponse.status).toBe(201);

    const activationResponse = await panelRouter.fetch(request(
      `/api/channels/${channelId}/modules/text_commands`,
      "PATCH",
      { enabled: true },
    ), testEnvironment);
    const activationBody = await activationResponse.json<{ module?: { id: string; enabled: boolean } }>();
    const module = await database.prepare(
      "SELECT enabled FROM channel_modules WHERE channel_id = ? AND module_id = 'text_commands'",
    ).bind(channelId).first<{ enabled: number }>();
    const commands = await database.prepare(
      "SELECT command_name, response_text, kind FROM text_commands WHERE channel_id = ? AND command_name = 'befehle'",
    ).bind(channelId).all<{ command_name: string; response_text: string; kind: string }>();

    expect(activationResponse.status).toBe(200);
    expect(activationBody.module).toMatchObject({ id: "text_commands", enabled: true });
    expect(module).toEqual({ enabled: 1 });
    expect(commands.results).toEqual([{
      command_name: "befehle",
      response_text: "Custom command response",
      kind: "text",
    }]);
  });

  it("notifies schedules through a real ChannelObject stub (protects=the schedule-input helper invokes the ChannelObject RPC without a remote call method; fails_when=the helper rejects with the Durable Object call TypeError; no_claim=how a schedule is rendered after its inputs change)", async () => {
    const channelId = `schedule-notify-${crypto.randomUUID()}`;
    await insertChannel(channelId);

    await expect(notifyModuleScheduleInputsChanged(workerEnvironment.CHANNEL, channelId, "activation")).resolves.toBeUndefined();
  });

  it("reconciles timer schedules through a real ChannelObject stub (protects=the timer reconciliation helper invokes the ChannelObject RPC directly; fails_when=the helper rejects with the Durable Object call TypeError; no_claim=whether the channel has timers to schedule)", async () => {
    const channelId = `schedule-reconcile-${crypto.randomUUID()}`;
    await insertChannel(channelId);

    await expect(reconcileChannelTimerSchedules(workerEnvironment.CHANNEL, channelId)).resolves.toBeUndefined();
  });
});
