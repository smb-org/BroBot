import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import type * as LoginIdentityModule from "../../src/worker/db/login-identity";
import {
  insertAppAccessToken,
  insertChannel,
  insertLoginIdentityAndSession,
  insertMember,
  testKey,
} from "./fixtures";
import { TestD1Database } from "./test-d1";

vi.mock("../../src/worker/db/login-identity", async (importOriginal) => {
  const original = await importOriginal<typeof LoginIdentityModule>();
  return { ...original, getLoginIdentity: vi.fn(original.getLoginIdentity) };
});

const loginIdentityModule = await import("../../src/worker/db/login-identity");
const getLoginIdentity = vi.mocked(loginIdentityModule.getLoginIdentity);
const originalGetLoginIdentity = getLoginIdentity.getMockImplementation();
const { panelRouter } = await import("../../src/worker/panel/routes");

const environmentKeys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: testKey(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: testKey(2) }, retired: [] }),
};

const environmentFor = (database: TestD1Database): Env => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  TWITCH_EVENTSUB_SECRET: JSON.stringify({ active: { id: "eventsub-v1", key: testKey(3) }, retired: [] }),
  PUBLIC_ORIGIN: "https://brobot.example",
  ...environmentKeys,
} as unknown as Env);

const requestFor = async (
  userId: string,
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
): Promise<Request> => {
  const sessionCookie = await createSessionCookie(
    { sessionId: `session-${userId}` },
    environmentKeys.SESSION_COOKIE_KEYS,
    environmentKeys.SESSION_ENCRYPTION_KEYS,
  );
  const csrfToken = await createCsrfToken(`session-${userId}`, environmentKeys.SESSION_COOKIE_KEYS, new Date().toISOString());
  const headers = new Headers({
    Cookie: `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrfToken}`,
    "Content-Type": "application/json",
    "X-CSRF-Token": csrfToken,
  });
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`https://brobot.example${path}`, init);
};

const seedBroadcastChannel = async (
  database: TestD1Database,
  currentScopes: string[] = ["channel:manage:broadcast"],
  historicalScopes: string[] = currentScopes,
): Promise<void> => {
  await insertChannel(database, "kanal-a");
  await insertLoginIdentityAndSession(database, "manager-1");
  await insertMember(database, "kanal-a", "manager-1", "manager");
  await insertLoginIdentityAndSession(database, "kanal-a", historicalScopes);
  const keys = parseKeyRing(environmentKeys.SESSION_ENCRYPTION_KEYS);
  const accessTokenCiphertext = await encryptJson({ token: "channel-token" }, keys);
  const refreshTokenCiphertext = await encryptJson({ token: "channel-refresh-token" }, keys);
  await database.prepare(
    `UPDATE twitch_login_identity
        SET token_scopes_json = ?, access_token_ciphertext = ?, refresh_token_ciphertext = ?
      WHERE user_id = 'kanal-a'`,
  ).bind(JSON.stringify(currentScopes), accessTokenCiphertext, refreshTokenCiphertext).run();
  const appAccessTokenCiphertext = await encryptJson({ token: "app-token" }, keys);
  await insertAppAccessToken(database, appAccessTokenCiphertext, "2099-09-19T00:00:00.000Z", "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z");
};

const broadcastPath = "/api/channels/kanal-a/broadcast";
const broadcastUpdate = { title: "New stream title", gameId: "509658" };

const urlForFetchInput = (input: RequestInfo | URL | undefined): URL => {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  if (input instanceof Request) return new URL(input.url);
  throw new Error("Expected a Twitch request URL.");
};

describe("broadcast route review regressions", () => {
  let database: TestD1Database;
  let environment: Env;

  beforeEach(() => {
    database = new TestD1Database();
    environment = environmentFor(database);
  });

  afterEach(() => {
    database.close();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("rechecks the manager role after reading the broadcaster identity", async () => {
    await seedBroadcastChannel(database);
    if (originalGetLoginIdentity === undefined) throw new Error("Expected the original identity reader.");
    getLoginIdentity.mockImplementationOnce(async (db, userId) => {
      const identity = await originalGetLoginIdentity(db, userId);
      if (userId === "kanal-a") {
        await db.prepare("UPDATE channel_members SET role = 'operator' WHERE channel_id = ? AND user_id = ?")
          .bind("kanal-a", "manager-1").run();
      }
      return identity;
    });
    const twitchFetch = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", twitchFetch);

    const response = await panelRouter.fetch(
      await requestFor("manager-1", broadcastPath, "PATCH", broadcastUpdate),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "broadcast_manage_denied" });
    expect(twitchFetch).not.toHaveBeenCalled();
  });

  it("refreshes an expired broadcaster token once and retries the broadcast update", async () => {
    await seedBroadcastChannel(database);
    let patchCount = 0;
    const twitchFetch = vi.fn<typeof fetch>((input, init) => {
      const url = urlForFetchInput(input);
      if (url.hostname === "id.twitch.tv") {
        return Promise.resolve(new Response(JSON.stringify({
          access_token: "fresh-channel-token",
          refresh_token: "rotated-refresh-token",
          expires_in: 3_600,
          scope: ["channel:manage:broadcast"],
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      if (url.pathname !== "/helix/channels" || init?.method !== "PATCH") {
        throw new Error("Unexpected Twitch request.");
      }
      patchCount += 1;
      return Promise.resolve(patchCount === 1
        ? new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 })
        : new Response(null, { status: 204 }));
    });
    vi.stubGlobal("fetch", twitchFetch);

    const response = await panelRouter.fetch(
      await requestFor("manager-1", broadcastPath, "PATCH", broadcastUpdate),
      environment,
    );

    expect(response.status).toBe(204);
    expect(patchCount).toBe(2);
    expect(twitchFetch.mock.calls.filter(([input]) => urlForFetchInput(input).hostname === "id.twitch.tv")).toHaveLength(1);
    const storedIdentity = await database.prepare(
      "SELECT token_scopes_json FROM twitch_login_identity WHERE user_id = ?",
    ).bind("kanal-a").first<{ token_scopes_json: string }>();
    expect(storedIdentity?.token_scopes_json).toBe('["channel:manage:broadcast"]');
  });

  it("reports availability from the stored token scopes, not historical consent", async () => {
    await seedBroadcastChannel(database, [], ["channel:manage:broadcast"]);
    const twitchFetch = vi.fn<typeof fetch>((input, init) => {
      const url = urlForFetchInput(input);
      if (url.pathname !== "/helix/channels" || init?.method !== undefined) throw new Error("Unexpected Twitch request.");
      return Promise.resolve(new Response(JSON.stringify({ data: [{ title: "Current title", game_id: "509658", game_name: "Just Chatting" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    });
    vi.stubGlobal("fetch", twitchFetch);

    const response = await panelRouter.fetch(await requestFor("manager-1", broadcastPath), environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ manageScopeAvailable: false });
  });

  it("records the actor, channel, title, and category in the audit log", async () => {
    await seedBroadcastChannel(database);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(() => Promise.resolve(new Response(null, { status: 204 }))));

    const response = await panelRouter.fetch(
      await requestFor("manager-1", broadcastPath, "PATCH", broadcastUpdate),
      environment,
    );
    const audit = await database.prepare(
      `SELECT actor_user_id, channel_id, action, before_json, after_json
         FROM audit_log WHERE action = ?`,
    ).bind("channel.broadcast.updated").first<{
      actor_user_id: string;
      channel_id: string;
      action: string;
      before_json: string | null;
      after_json: string | null;
    }>();
    expect(response.status).toBe(204);
    expect(audit).toMatchObject({
      actor_user_id: "manager-1",
      channel_id: "kanal-a",
      action: "channel.broadcast.updated",
      before_json: "null",
      after_json: JSON.stringify(broadcastUpdate),
    });
  });
});
