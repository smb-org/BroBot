import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { upsertBotIdentity } from "../../src/worker/db/bot-identity";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey as key } from "./fixtures";
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

const requestFor = async (userId: string, path: string, method = "POST"): Promise<Request> => {
  const sessionId = `session-${userId}`;
  const cookie = await createSessionCookie({ sessionId }, environmentKeys.SESSION_COOKIE_KEYS, environmentKeys.TOKEN_ENCRYPTION_KEYS);
  const csrf = await createCsrfToken(sessionId, environmentKeys.SESSION_COOKIE_KEYS, new Date().toISOString());
  return new Request(`https://brobot.example${path}`, {
    method,
    headers: {
      Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrf}`,
      "X-CSRF-Token": csrf,
    },
  });
};

describe("create clip", () => {
  let database: TestD1Database;

  beforeEach(async () => {
    database = new TestD1Database();
    await insertChannel(database, "kanal-a");
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('kanal-a', 'clips', 1, '{}')",
    ).run();
    await upsertBotIdentity(database as unknown as D1Database, {
      id: 1,
      userId: "bot-1",
      login: "brobot",
      scopesJson: "[\"clips:edit\"]",
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

  // "Betrieblich" per 0006: an immediate action open to every channel role.
  it("lets an operator create a clip and writes an audit entry", async () => {
    const environment = await asMember("operator");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ data: [{ id: "clip-1", edit_url: "https://clips.twitch.tv/clip-1/edit" }] }),
      { status: 202 },
    )));

    const response = await panelRouter.fetch(await requestFor("user-1", "/api/channels/kanal-a/clips"), environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ clipId: "clip-1", editUrl: "https://clips.twitch.tv/clip-1/edit" });
    await expect(database.prepare(
      "SELECT action, module_id FROM audit_log WHERE channel_id = 'kanal-a'",
    ).first()).resolves.toEqual({ action: "clip.created", module_id: null });
  });

  it("rejects clip creation after the clips module is disabled", async () => {
    const environment = await asMember("operator");
    await database.prepare("UPDATE channel_modules SET enabled = 0 WHERE channel_id = 'kanal-a' AND module_id = 'clips'").run();
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(await requestFor("user-1", "/api/channels/kanal-a/clips"), environment);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "module_disabled" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports a missing bot scope as its own outcome", async () => {
    const environment = await asMember("manager");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ message: "Missing scope" }),
      { status: 401 },
    )));

    const response = await panelRouter.fetch(await requestFor("user-1", "/api/channels/kanal-a/clips"), environment);

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "clip_create_failed", reason: "scope_missing" });
    await expect(database.prepare(
      "SELECT code FROM event_log WHERE channel_id = 'kanal-a'",
    ).first()).resolves.toEqual({ code: "host.clip.failed" });
  });

  it("reports Twitch's rate limit as its own outcome", async () => {
    const environment = await asMember("broadcaster");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ message: "slow down" }),
      { status: 429 },
    )));

    const response = await panelRouter.fetch(await requestFor("user-1", "/api/channels/kanal-a/clips"), environment);

    expect(response.status).toBe(429);
    // Issue #201 follow-up: the event-log diagnostic carries this same
    // message under `twitchMessage` (provenance for the dashboard popover),
    // but the API error response has always used `message`.
    const body = await response.json<{ error: string; reason: string; detail: Record<string, unknown> }>();
    expect(body).toMatchObject({ error: "clip_create_failed", reason: "rate_limited" });
    expect(body.detail.message).toBe("slow down");
    expect(body.detail.twitchMessage).toBeUndefined();
  });

  it("reports a network error with a null message, not a missing one (issue #201 follow-up)", async () => {
    // A rejected fetch never reaches a Twitch response body at all --
    // `helixRequest` (worker/twitch/helix.ts) sets `message: null` for
    // "network_error"/"timeout", so `detail.twitchMessage` is `null` here
    // too, not a nonempty string. `apiErrorDetail` still has to convert it
    // to `detail.message: null` -- leaving the key out entirely would read
    // to a client as "no diagnostic detail was even attempted".
    const environment = await asMember("broadcaster");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockRejectedValue(new Error("boom")));

    const response = await panelRouter.fetch(await requestFor("user-1", "/api/channels/kanal-a/clips"), environment);

    expect(response.status).toBe(503);
    const body = await response.json<{ error: string; reason: string; detail: Record<string, unknown> }>();
    expect(body).toMatchObject({ error: "clip_create_failed", reason: "network_error" });
    expect(body.detail).toHaveProperty("message", null);
    expect(body.detail.twitchMessage).toBeUndefined();
  });

  it("maps Twitch's offline response to the readable closed reason", async () => {
    const environment = await asMember("operator");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ message: "The broadcaster is not live" }),
      { status: 400 },
    )));

    const response = await panelRouter.fetch(await requestFor("user-1", "/api/channels/kanal-a/clips"), environment);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "clip_stream_offline", reason: "not_live" });
    await expect(database.prepare("SELECT code FROM event_log WHERE channel_id = 'kanal-a'").first())
      .resolves.toEqual({ code: "host.clip.failed" });
  });

  it("rejects a request from someone who isn't a channel member", async () => {
    await insertLoginIdentityAndSession(database, "outsider");
    const environment = environmentFor(database);
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(await requestFor("outsider", "/api/channels/kanal-a/clips"), environment);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "channel_access_denied" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
