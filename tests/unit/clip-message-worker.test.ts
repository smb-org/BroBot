import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { clipsSettingsSchema } from "../../src/modules/clips/contracts";
import { upsertBotIdentity } from "../../src/worker/db/bot-identity";
import { panelRouter } from "../../src/worker/panel/routes";
import { insertAppAccessToken, insertChannel, insertLoginIdentityAndSession, insertMember, testKey as key } from "./fixtures";
import { TestD1Database } from "./test-d1";

const keyRing = JSON.stringify({ active: { id: "token-v1", key: key(2) }, retired: [] });
const sessionKeys = JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] });
const now = "2026-10-19T10:00:00.000Z";

const environmentFor = (database: TestD1Database): Env => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  TOKEN_ENCRYPTION_KEYS: keyRing,
  SESSION_COOKIE_KEYS: sessionKeys,
} as unknown as Env);

const requestFor = async (): Promise<Request> => {
  const cookie = await createSessionCookie({ sessionId: "session-user-1" }, sessionKeys, keyRing);
  const csrf = await createCsrfToken("session-user-1", sessionKeys, new Date().toISOString());
  return new Request("https://brobot.example/api/channels/channel-a/clips", {
    method: "POST",
    headers: {
      Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrf}`,
      "X-CSRF-Token": csrf,
    },
  });
};

const response = (body: unknown, status: number): Response => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

describe("confirmed clip link messages", () => {
  let database: TestD1Database;
  let environment: Env;

  beforeEach(async () => {
    database = new TestD1Database();
    environment = environmentFor(database);
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "channel-a", "user-1", "operator");
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'clips', 1, ?)",
    ).bind("channel-a", JSON.stringify(clipsSettingsSchema.parse({
      postClipLinkInChat: true,
      chatLinkTemplate: "Found: {clip.title} {clip.url}",
    }))).run();
    await upsertBotIdentity(database as unknown as D1Database, {
      id: 1,
      userId: "bot-1",
      login: "brobot",
      scopesJson: '["clips:edit"]',
      accessTokenCiphertext: await encryptJson({ token: "user-token" }, parseKeyRing(keyRing)),
      refreshTokenCiphertext: "unused",
      expiresAt: "2099-09-21T00:00:00.000Z",
      createdAt: now,
      updatedAt: now,
    });
    await insertAppAccessToken(
      database,
      await encryptJson({ token: "app-token" }, parseKeyRing(keyRing)),
      "2099-09-21T00:00:00.000Z",
      now,
      now,
    );
  });

  afterEach(() => {
    database.close();
    vi.unstubAllGlobals();
  });

  it("posts the configured title and public URL after Twitch confirms availability", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: [{ id: "clip-a", edit_url: "https://clips.twitch.tv/clip-a/edit" }] }, 202))
      .mockResolvedValueOnce(response({ data: [{ id: "clip-a", title: "A good moment", url: "https://clips.twitch.tv/clip-a" }] }, 200))
      .mockResolvedValueOnce(response({ data: [{ is_sent: true, message_id: "chat-1" }] }, 200));
    vi.stubGlobal("fetch", fetcher);

    const result = await panelRouter.fetch(await requestFor(), environment);

    expect(result.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const chatRequest = fetcher.mock.calls[2]?.[1];
    expect(typeof chatRequest?.body).toBe("string");
    expect(typeof chatRequest?.body === "string" ? JSON.parse(chatRequest.body) : null)
      .toMatchObject({ message: "Found: A good moment https://clips.twitch.tv/clip-a" });
  });

  it("does not post a link when Twitch does not confirm the clip", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: [{ id: "clip-pending", edit_url: null }] }, 202))
      .mockResolvedValueOnce(response({ message: "availability unavailable" }, 503));
    vi.stubGlobal("fetch", fetcher);

    const result = await panelRouter.fetch(await requestFor(), environment);

    expect(result.status).toBe(503);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(database.prepare("SELECT action FROM audit_log WHERE channel_id = ?").bind("channel-a").first())
      .resolves.toBeNull();
  });
});
