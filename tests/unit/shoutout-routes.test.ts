import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { upsertBotIdentity } from "../../src/worker/db/bot-identity";
import { insertAppAccessToken, insertChannel, insertLoginIdentityAndSession, insertMember, testKey as key } from "./fixtures";
import { TestD1Database } from "./test-d1";

const environmentKeys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
  TOKEN_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "token-v1", key: key(2) }, retired: [] }),
};

const environmentFor = (database: TestD1Database): Env => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  ...environmentKeys,
} as unknown as Env);

const requestFor = async (userId: string, path: string, body?: unknown): Promise<Request> => {
  const sessionId = `session-${userId}`;
  const cookie = await createSessionCookie({ sessionId }, environmentKeys.SESSION_COOKIE_KEYS, environmentKeys.TOKEN_ENCRYPTION_KEYS);
  const csrf = await createCsrfToken(sessionId, environmentKeys.SESSION_COOKIE_KEYS, new Date().toISOString());
  return new Request(`https://brobot.example${path}`, {
    method: "POST",
    headers: {
      Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrf}`,
      "X-CSRF-Token": csrf,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
};

describe("manual shoutout", () => {
  let database: TestD1Database;

  beforeEach(async () => {
    database = new TestD1Database();
    await insertChannel(database, "kanal-a");
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('kanal-a', 'raid', 1, '{}')",
    ).run();
    await insertAppAccessToken(
      database,
      await encryptJson({ token: "app-token" }, parseKeyRing(environmentKeys.TOKEN_ENCRYPTION_KEYS)),
      "2099-09-21T00:00:00.000Z",
      "2026-09-20T00:00:00.000Z",
      "2026-09-20T00:00:00.000Z",
    );
    await upsertBotIdentity(database as unknown as D1Database, {
      id: 1,
      userId: "bot-1",
      login: "brobot",
      scopesJson: "[\"moderator:manage:shoutouts\"]",
      accessTokenCiphertext: await encryptJson({ token: "bot-token" }, parseKeyRing(environmentKeys.TOKEN_ENCRYPTION_KEYS)),
      refreshTokenCiphertext: "unreadable",
      expiresAt: "2099-09-21T00:00:00.000Z",
      createdAt: "2026-09-19T00:00:00.000Z",
      updatedAt: "2026-09-19T00:00:00.000Z",
    });
  });

  afterEach(() => {
    database.close();
    vi.unstubAllGlobals();
  });

  const asMember = async (role: "broadcaster" | "manager" | "operator"): Promise<Env> => {
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", role);
    return environmentFor(database);
  };

  it("lets an operator send a shoutout by login", async () => {
    const environment = await asMember("operator");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "target-1", login: "streamerin", display_name: "Streamerin" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 })));

    const response = await panelRouter.fetch(await requestFor("user-1", "/api/channels/kanal-a/shoutout", { login: "streamerin" }), environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ sent: true });
    await expect(database.prepare(
      "SELECT code FROM event_log WHERE channel_id = 'kanal-a'",
    ).first()).resolves.toEqual({ code: "host.shoutout.sent" });
  });

  it("rejects a shoutout after the raid module is disabled", async () => {
    const environment = await asMember("operator");
    await database.prepare("UPDATE channel_modules SET enabled = 0 WHERE channel_id = 'kanal-a' AND module_id = 'raid'").run();
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(await requestFor("user-1", "/api/channels/kanal-a/shoutout", { login: "streamerin" }), environment);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "module_disabled" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports an unknown login without calling shoutout", async () => {
    const environment = await asMember("manager");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(await requestFor("user-1", "/api/channels/kanal-a/shoutout", { login: "unbekannt" }), environment);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "twitch_user_not_found" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports Twitch's rate limit as its own outcome", async () => {
    const environment = await asMember("broadcaster");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ id: "target-1", login: "streamerin", display_name: "Streamerin" }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "slow down" }), { status: 429 })));

    const response = await panelRouter.fetch(await requestFor("user-1", "/api/channels/kanal-a/shoutout", { login: "streamerin" }), environment);

    expect(response.status).toBe(429);
    // Issue #201 follow-up: the event-log diagnostic carries this same
    // message under `twitchMessage` (provenance for the dashboard popover),
    // but the API error response has always used `message` -- a client
    // reading it must not lose Twitch's own explanation.
    const body = await response.json<{ error: string; reason: string; detail: Record<string, unknown> }>();
    expect(body).toMatchObject({ error: "shoutout_send_failed", reason: "rate_limited" });
    expect(body.detail.message).toBe("slow down");
    expect(body.detail.twitchMessage).toBeUndefined();
  });

  it("rejects a request from someone who isn't a channel member", async () => {
    await insertLoginIdentityAndSession(database, "outsider");
    const environment = environmentFor(database);
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(await requestFor("outsider", "/api/channels/kanal-a/shoutout", { login: "streamerin" }), environment);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "channel_access_denied" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
