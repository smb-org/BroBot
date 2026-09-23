import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EVENTSUB_MAX_BODY_BYTES,
  eventSubRouter,
  eventSubMessageCutoff,
  isEventSubTimestampFresh,
  listDesiredEventSubTargets,
  parseEventSubTimestamp,
} from "../../src/worker/eventsub";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import {
  purgeOldEventSubMessages,
} from "../../src/worker/db/eventsub-state";
import { scheduled } from "../../src/worker/scheduled";
import { insertChannel, insertLoginIdentityAndSession } from "./fixtures";
import { TestD1Database, type TestPreparedStatement } from "./test-d1";

const key = (byte: number): string => Buffer.from(new Uint8Array(32).fill(byte)).toString("base64url");
const secretRing = (activeByte: number, retiredByte?: number): string => JSON.stringify({
  active: { id: `active-${String(activeByte)}`, key: key(activeByte) },
  retired: retiredByte === undefined
    ? []
    : [{ id: `retired-${String(retiredByte)}`, key: key(retiredByte) }],
});
const encryptionKeys = secretRing(7);

const independentSignature = (
  secret: string,
  messageId: string,
  timestamp: string,
  body: string,
): string => createHmac("sha256", Buffer.from(secret, "ascii"))
  .update(Buffer.from(`${messageId}${timestamp}${body}`, "utf8"))
  .digest("hex");

/*
 * Independent Twitch test vector, computed once offline with
 * node:crypto/createHmac. This value must not come from hmacSha256,
 * because the test is meant to guard exactly this helper against a wrong
 * interpretation of transport.secret.
 */
const INDEPENDENT_VECTOR = {
  messageId: "message-independent",
  timestamp: "2026-09-19T10:00:00.000Z",
  body: JSON.stringify({ challenge: "unabhaengig" }),
  signature: "f78b937a255d0b796deb4f61761cea21febd1596d5faaca4916bd3f4b60d81ed",
};

const signedRequest = (
  secret: string,
  messageType: string,
  body: string,
  messageId = "message-1",
  timestamp = "2026-09-19T10:00:00.123456789Z",
): Request => {
  const ring = JSON.parse(secret) as { active: { key: string } };
  const signature = independentSignature(ring.active.key, messageId, timestamp, body);
  return new Request("https://brobot.example/api/twitch/eventsub", {
    method: "POST",
    body,
    headers: {
      "Twitch-Eventsub-Message-Id": messageId,
      "Twitch-Eventsub-Message-Timestamp": timestamp,
      "Twitch-Eventsub-Message-Signature": `sha256=${signature}`,
      "Twitch-Eventsub-Message-Type": messageType,
    },
  });
};

const revocationBody = (channelId: string, subscriptionId: string): string => JSON.stringify({
  subscription: {
    id: subscriptionId,
    type: "channel.chat.message",
    status: "authorization_revoked",
    condition: { broadcaster_user_id: channelId },
  },
});

const botRevocationBody = (subscriptionId: string): string => JSON.stringify({
  subscription: {
    id: subscriptionId,
    type: "channel.moderate",
    version: "2",
    status: "authorization_revoked",
    condition: { broadcaster_user_id: "200", moderator_user_id: "777" },
  },
});

const insertBotIdentity = async (database: TestD1Database, userId = "777"): Promise<void> => {
  const accessTokenCiphertext = await encryptJson({ token: "bot-access" }, parseKeyRing(encryptionKeys));
  const refreshTokenCiphertext = await encryptJson({ token: "bot-refresh" }, parseKeyRing(encryptionKeys));
  await database.prepare(
    `INSERT INTO bot_identity
      (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
       expires_at, created_at, updated_at)
     VALUES (1, ?, 'bot', '[]', ?, ?, ?, ?, ?)`,
  ).bind(
    userId,
    accessTokenCiphertext,
    refreshTokenCiphertext,
    "2099-09-19T00:00:00.000Z",
    "2026-09-19T00:00:00.000Z",
    "2026-09-19T00:00:00.000Z",
  ).run();
  await database.prepare(
    `INSERT INTO bot_identity_status (id, status, reason, updated_at)
     VALUES (1, 'connected', NULL, ?)`,
  ).bind("2026-09-19T00:00:00.000Z").run();
};

const requestUrl = (input: RequestInfo | URL): string =>
  typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

const invalidTokenFetcher = (): ReturnType<typeof vi.fn> => vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
  const url = requestUrl(input);
  if (url === "https://id.twitch.tv/oauth2/validate") {
    return new Response(JSON.stringify({ message: "Token ungültig" }), { status: 401 });
  }
  if (url === "https://id.twitch.tv/oauth2/token" && init?.method === "POST") {
    return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
  }
  throw new Error(`unerwarteter Twitch-Aufruf: ${url}`);
});

const failingBatchDatabase = (database: TestD1Database): D1Database => ({
  prepare: database.prepare.bind(database),
  batch: (statements: TestPreparedStatement[]) => {
    database.sqlite.exec("BEGIN");
    try {
      statements[0]?.runSync();
      throw new Error("simulierter Widerrufsspeicherfehler");
    } catch (error) {
      database.sqlite.exec("ROLLBACK");
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  },
} as unknown as D1Database);

describe("EventSub inbound", () => {
  let database: TestD1Database;
  const secret = secretRing(3);
  const environment = () => ({
    DB: database as unknown as D1Database,
    TWITCH_EVENTSUB_SECRET: secret,
    TWITCH_CLIENT_ID: "client-id",
    TWITCH_CLIENT_SECRET: "client-secret",
    TOKEN_ENCRYPTION_KEYS: encryptionKeys,
  } as unknown as Env);

  beforeEach(() => {
    database = new TestD1Database();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-19T10:00:00.000Z"));
  });

  afterEach(() => {
    database.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("returns a valid verification challenge as plain text", async () => {
    const body = JSON.stringify({ challenge: "challenge-wert", subscription: {} });
    const response = await eventSubRouter.fetch(
      signedRequest(secret, "webhook_callback_verification", body),
      environment(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("challenge-wert");
    expect(response.headers.get("content-type")).toContain("text/plain");
  });

  it("verifies an independently computed Twitch signature vector", async () => {
    const response = await eventSubRouter.fetch(
      new Request("https://brobot.example/api/twitch/eventsub", {
        method: "POST",
        body: INDEPENDENT_VECTOR.body,
        headers: {
          "Twitch-Eventsub-Message-Id": INDEPENDENT_VECTOR.messageId,
          "Twitch-Eventsub-Message-Timestamp": INDEPENDENT_VECTOR.timestamp,
          "Twitch-Eventsub-Message-Signature": `sha256=${INDEPENDENT_VECTOR.signature}`,
          "Twitch-Eventsub-Message-Type": "webhook_callback_verification",
        },
      }),
      environment(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("unabhaengig");
  });

  it("rejects a verification message without a challenge", async () => {
    const body = JSON.stringify({ subscription: {} });
    const response = await eventSubRouter.fetch(
      signedRequest(secret, "webhook_callback_verification", body, "message-no-challenge"),
      environment(),
    );

    expect(response.status).toBe(400);
  });

  it("verifies signature and timestamp before the JSON body", async () => {
    const request = new Request("https://brobot.example/api/twitch/eventsub", {
      method: "POST",
      body: "kein-json",
      headers: {
        "Twitch-Eventsub-Message-Id": "message-invalid",
        "Twitch-Eventsub-Message-Timestamp": "2026-09-19T10:00:00.000Z",
        "Twitch-Eventsub-Message-Signature": "sha256=" + "00".repeat(32),
        "Twitch-Eventsub-Message-Type": "notification",
      },
    });

    const response = await eventSubRouter.fetch(request, environment());

    expect(response.status).toBe(403);
    const row = await database.prepare("SELECT COUNT(*) AS count FROM eventsub_messages").first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  it("rejects messages older than ten minutes", async () => {
    const timestamp = "2026-09-19T09:49:29.999999999Z";
    const body = JSON.stringify({ subscription: {}, event: {} });
    const response = await eventSubRouter.fetch(
      signedRequest(secret, "notification", body, "message-old", timestamp),
      environment(),
    );

    expect(response.status).toBe(403);
    await expect(database.prepare("SELECT COUNT(*) AS count FROM eventsub_messages").first()).resolves.toEqual({ count: 0 });
  });

  it("recognizes a message within the retry window as a repeat again", async () => {
    await insertChannel(database, "channel-replay");
    const body = JSON.stringify({
      subscription: { type: "channel.chat.message", condition: { broadcaster_user_id: "channel-replay" } },
      event: {},
    });
    const first = await eventSubRouter.fetch(
      signedRequest(secret, "notification", body, "message-replay"),
      environment(),
    );
    vi.setSystemTime(new Date("2026-09-19T10:00:01.000Z"));
    const repeat = await eventSubRouter.fetch(
      signedRequest(secret, "notification", body, "message-replay", "2026-09-19T10:00:00.000Z"),
      environment(),
    );

    expect(first.status).toBe(204);
    expect(repeat.status).toBe(204);
    await expect(database.prepare("SELECT COUNT(*) AS count FROM eventsub_messages").first()).resolves.toEqual({ count: 1 });
  });

  it("keeps newer online state and stream-end brakes when a delayed offline reaches the HTTP handler", async () => {
    const channelId = "channel-stream-order";
    await insertChannel(database, channelId);
    await database.prepare(
      `INSERT INTO channel_stream_state (channel_id, state, changed_at, source)
       VALUES (?, 'online', '2026-09-19T10:00:00.500Z', 'eventsub')`,
    ).bind(channelId).run();
    await database.prepare(
      `INSERT INTO channel_controls
        (channel_id, muted, muted_until, mute_until_stream_end, paused, paused_until, pause_until_stream_end, updated_at)
       VALUES (?, 1, NULL, 1, 1, NULL, 1, '2026-09-19T10:00:00.500Z')`,
    ).bind(channelId).run();
    vi.setSystemTime(new Date("2026-09-19T10:00:01.000Z"));

    const body = JSON.stringify({
      subscription: {
        type: "stream.offline",
        condition: { broadcaster_user_id: channelId },
      },
      event: {},
    });
    const response = await eventSubRouter.fetch(
      signedRequest(secret, "notification", body, "delayed-offline", "2026-09-19T10:00:00.100Z"),
      environment(),
    );

    expect(response.status).toBe(204);
    await expect(database.prepare(
      "SELECT state, changed_at FROM channel_stream_state WHERE channel_id = ?",
    ).bind(channelId).first()).resolves.toEqual({ state: "online", changed_at: "2026-09-19T10:00:00.500Z" });
    await expect(database.prepare(
      "SELECT muted, mute_until_stream_end, paused, pause_until_stream_end FROM channel_controls WHERE channel_id = ?",
    ).bind(channelId).first()).resolves.toEqual({
      muted: 1,
      mute_until_stream_end: 1,
      paused: 1,
      pause_until_stream_end: 1,
    });
  });

  it("rejects a timestamp too far in the future", async () => {
    const timestamp = "2026-09-19T10:10:30.001Z";
    const body = JSON.stringify({ challenge: "zukünftig" });
    const response = await eventSubRouter.fetch(
      signedRequest(secret, "webhook_callback_verification", body, "message-future", timestamp),
      environment(),
    );

    expect(response.status).toBe(403);
  });

  it("rejects a payload above the hard limit before reading it as JSON", async () => {
    const body = new Uint8Array(EVENTSUB_MAX_BODY_BYTES + 1).fill(65);
    const response = await eventSubRouter.fetch(
      new Request("https://brobot.example/api/twitch/eventsub", {
        method: "POST",
        body,
        headers: {
          "Twitch-Eventsub-Message-Id": "message-too-large",
          "Twitch-Eventsub-Message-Timestamp": "2026-09-19T10:00:00.000Z",
          "Twitch-Eventsub-Message-Signature": `sha256=${"00".repeat(32)}`,
          "Twitch-Eventsub-Message-Type": "notification",
        },
      }),
      environment(),
    );

    expect(response.status).toBe(413);
    const row = await database.prepare("SELECT COUNT(*) AS count FROM eventsub_messages").first<{ count: number }>();
    expect(row?.count).toBe(0);
  });

  it("verifies the signature over the received raw bytes instead of decoded text", async () => {
    const body = JSON.stringify({ challenge: "bom" });
    const bodyWithBom = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode(body),
    ]);
    const response = await eventSubRouter.fetch(
      new Request("https://brobot.example/api/twitch/eventsub", {
        method: "POST",
        body: bodyWithBom,
        headers: {
          "Twitch-Eventsub-Message-Id": "message-bom",
          "Twitch-Eventsub-Message-Timestamp": "2026-09-19T10:00:00.000Z",
          "Twitch-Eventsub-Message-Signature": "sha256=b5e8ddf2aaccf920dcf657538b2e1036910c7b22f616868071cba64e96e8bf3d",
          "Twitch-Eventsub-Message-Type": "webhook_callback_verification",
        },
      }),
      environment(),
    );

    expect(response.status).toBe(403);
  });

  it("accepts a retired signing key", async () => {
    const ring = secretRing(3, 4);
    const body = JSON.stringify({ challenge: "rotations-challenge" });
    const timestamp = "2026-09-19T10:00:00.000Z";
    const retiredSignature = independentSignature(key(4), "message-retired", timestamp, body);
    const request = new Request("https://brobot.example/api/twitch/eventsub", {
      method: "POST",
      body,
      headers: {
        "Twitch-Eventsub-Message-Id": "message-retired",
        "Twitch-Eventsub-Message-Timestamp": timestamp,
        "Twitch-Eventsub-Message-Signature": `sha256=${retiredSignature}`,
        "Twitch-Eventsub-Message-Type": "webhook_callback_verification",
      },
    });

    const response = await eventSubRouter.fetch(request, {
      ...environment(),
      TWITCH_EVENTSUB_SECRET: ring,
    });

    expect(response.status).toBe(200);
  });

  it("processes the same message ID only once", async () => {
    await insertChannel(database, "channel-dedupe");
    const body = JSON.stringify({
      subscription: {
        id: "subscription-dedupe",
        type: "channel.chat.message",
        status: "authorization_revoked",
        condition: { broadcaster_user_id: "channel-dedupe" },
      },
    });
    const first = await eventSubRouter.fetch(
      signedRequest(secret, "revocation", body),
      environment(),
    );
    const firstRow = await database.prepare(
      "SELECT updated_at FROM eventsub_revocations WHERE subscription_id = 'subscription-dedupe'",
    ).first<{ updated_at: string }>();
    vi.setSystemTime(new Date("2026-09-19T10:00:01.000Z"));
    const second = await eventSubRouter.fetch(
      signedRequest(secret, "revocation", body),
      environment(),
    );

    expect(first.status).toBe(204);
    expect(second.status).toBe(204);
    const row = await database.prepare(
      "SELECT updated_at FROM eventsub_revocations WHERE subscription_id = 'subscription-dedupe'",
    ).first<{ updated_at: string }>();
    expect(row).toEqual(firstRow);
  });

  it("locks the bot identity on a confirmed revocation of the moderator subscription", async () => {
    await insertChannel(database, "200");
    await insertLoginIdentityAndSession(database, "200", ["channel:read:ads"]);
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('200', 'ads', 1, '{}')`,
    ).run();
    await insertBotIdentity(database);
    vi.stubGlobal("fetch", invalidTokenFetcher());

    const response = await eventSubRouter.fetch(
      signedRequest(secret, "revocation", botRevocationBody("moderate-revoked"), "message-bot-revoked"),
      environment(),
    );

    expect(response.status).toBe(204);
    await expect(database.prepare(
      "SELECT status, reason FROM bot_identity_status WHERE id = 1",
    ).first()).resolves.toEqual({ status: "revoked", reason: "authorization_revoked" });
    await expect(database.prepare(
      "SELECT status, scopes_json FROM twitch_login_identity WHERE user_id = '200'",
    ).first()).resolves.toEqual({ status: "connected", scopes_json: JSON.stringify(["channel:read:ads"]) });
    await expect(listDesiredEventSubTargets(environment().DB, "200")).resolves.toContainEqual({
      channelId: "200",
      subscriptionType: "channel.ad_break.begin",
      variant: "",
      version: "1",
    });
  });

  it("doesn't lock despite a revocation message when the bot token is still valid", async () => {
    await insertChannel(database, "200");
    await insertLoginIdentityAndSession(database, "200", ["channel:bot"]);
    await insertBotIdentity(database);
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url !== "https://id.twitch.tv/oauth2/validate") {
        throw new Error(`unerwarteter Twitch-Aufruf: ${url}`);
      }
      return new Response(JSON.stringify({
        client_id: "client-id",
        user_id: "777",
        login: "bot",
        expires_in: 3600,
      }), { status: 200 });
    }));

    const response = await eventSubRouter.fetch(
      signedRequest(secret, "revocation", botRevocationBody("moderate-still-valid"), "message-still-valid"),
      environment(),
    );

    expect(response.status).toBe(204);
    await expect(database.prepare(
      "SELECT status, reason FROM bot_identity_status WHERE id = 1",
    ).first()).resolves.toEqual({ status: "connected", reason: null });
    await expect(database.prepare(
      "SELECT status, scopes_json FROM twitch_login_identity WHERE user_id = '200'",
    ).first()).resolves.toEqual({ status: "connected", scopes_json: JSON.stringify(["channel:bot"]) });
  });

  it("doesn't reapply the identity effect of a known message ID after reconnecting", async () => {
    await insertChannel(database, "200");
    await insertLoginIdentityAndSession(database, "200", ["channel:bot"]);
    await insertBotIdentity(database);
    vi.stubGlobal("fetch", invalidTokenFetcher());
    const body = botRevocationBody("moderate-reconnected");

    await expect(eventSubRouter.fetch(
      signedRequest(secret, "revocation", body, "message-reconnected"),
      environment(),
    )).resolves.toMatchObject({ status: 204 });
    await database.prepare(
      "UPDATE bot_identity_status SET status = 'connected', reason = NULL WHERE id = 1",
    ).run();
    await database.prepare(
      "UPDATE twitch_login_identity SET status = 'connected', scopes_json = '[\"channel:bot\"]' WHERE user_id = '200'",
    ).run();

    const repeated = await eventSubRouter.fetch(
      signedRequest(secret, "revocation", body, "message-reconnected"),
      environment(),
    );

    expect(repeated.status).toBe(204);
    await expect(database.prepare(
      "SELECT status, reason FROM bot_identity_status WHERE id = 1",
    ).first()).resolves.toEqual({ status: "connected", reason: null });
    await expect(database.prepare(
      "SELECT status, scopes_json FROM twitch_login_identity WHERE user_id = '200'",
    ).first()).resolves.toEqual({ status: "connected", scopes_json: JSON.stringify(["channel:bot"]) });
  });

  it("attributes a raid to the subscription's channel despite a different channel ID in the event body", async () => {
    await insertChannel(database, "channel-condition");
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('channel-condition', 'channel_events', 1, '{}')`,
    ).run();
    const body = JSON.stringify({
      subscription: {
        type: "channel.raid",
        condition: { to_broadcaster_user_id: "channel-condition" },
      },
      event: {
        from_broadcaster_user_id: "raid-source",
        from_broadcaster_user_name: "Quelle",
        to_broadcaster_user_id: "foreign-channel",
        to_broadcaster_user_name: "Fremd",
        viewers: 23,
      },
    });
    const realtimeMessages: unknown[] = [];
    const withRealtime = {
      ...environment(),
      CHANNEL: {
        idFromName: (channelId: string) => channelId,
        get: () => ({ publish: (message: unknown) => { realtimeMessages.push(message); } }),
      },
    } as unknown as Env;

    const response = await eventSubRouter.fetch(
      signedRequest(secret, "notification", body, "message-condition"),
      withRealtime,
    );

    expect(response.status).toBe(204);
    await expect(database.prepare(
      `SELECT channel_id, module_id, code, detail_json
         FROM event_log`,
    ).first()).resolves.toEqual({
      channel_id: "channel-condition",
      module_id: "channel_events",
      code: "channel_events.raid.incoming",
      detail_json: JSON.stringify({ source: "Quelle", viewers: 23 }),
    });
    expect(realtimeMessages).toHaveLength(1);
    expect(realtimeMessages[0]).toMatchObject({
      type: "event_log.new",
      channelId: "channel-condition",
      payload: { entries: [{ code: "channel_events.raid.incoming", moduleId: "channel_events" }] },
    });
  });

  it("doesn't consume the message ID when storing a revocation fails", async () => {
    await insertChannel(database, "200");
    await insertLoginIdentityAndSession(database, "200", ["channel:bot"]);
    await insertBotIdentity(database);
    vi.stubGlobal("fetch", invalidTokenFetcher());
    const body = botRevocationBody("subscription-retry");
    const first = await eventSubRouter.fetch(
      signedRequest(secret, "revocation", body, "message-retry"),
      { ...environment(), DB: failingBatchDatabase(database) },
    );

    expect(first.status).toBe(500);
    const afterFailure = await database.prepare(
      "SELECT COUNT(*) AS count FROM eventsub_messages",
    ).first<{ count: number }>();
    expect(afterFailure?.count).toBe(0);
    await expect(database.prepare(
      "SELECT status, reason FROM bot_identity_status WHERE id = 1",
    ).first()).resolves.toEqual({ status: "connected", reason: null });

    const second = await eventSubRouter.fetch(
      signedRequest(secret, "revocation", body, "message-retry"),
      environment(),
    );

    expect(second.status).toBe(204);
    await expect(database.prepare(
      "SELECT subscription_id FROM eventsub_revocations WHERE subscription_id = 'subscription-retry'",
    ).first()).resolves.toEqual({ subscription_id: "subscription-retry" });
    await expect(database.prepare(
      "SELECT status, reason FROM bot_identity_status WHERE id = 1",
    ).first()).resolves.toEqual({ status: "revoked", reason: "authorization_revoked" });
  });

  it("stores a revocation scoped to the channel for the later panel", async () => {
    await insertChannel(database, "channel-42");
    await insertLoginIdentityAndSession(database, "channel-42", ["channel:bot"]);
    const body = JSON.stringify({
      subscription: {
        id: "subscription-1",
        type: "channel.chat.message",
        status: "authorization_revoked",
        condition: { broadcaster_user_id: "channel-42" },
      },
    });
    const response = await eventSubRouter.fetch(
      signedRequest(secret, "revocation", body, "message-revoked"),
      environment(),
    );

    expect(response.status).toBe(204);
    const row = await database.prepare(
      `SELECT subscription_id, channel_id, status, reason
         FROM eventsub_revocations`,
    ).first<Record<string, string>>();
    expect(row).toEqual({
      subscription_id: "subscription-1",
      channel_id: "channel-42",
      status: "revoked",
      reason: "authorization_revoked",
    });
    await expect(database.prepare(
      `SELECT channel_id, subscription_type, subscription_id, status, reason
         FROM eventsub_subscriptions`,
    ).first()).resolves.toEqual({
      channel_id: "channel-42",
      subscription_type: "channel.chat.message",
      subscription_id: "subscription-1",
      status: "revoked",
      reason: "authorization_revoked",
    });
    await expect(database.prepare(
      "SELECT status, scopes_json FROM twitch_login_identity WHERE user_id = 'channel-42'",
    ).first()).resolves.toEqual({ status: "connected", scopes_json: JSON.stringify(["channel:bot"]) });
  });

  it("recovers the channel of a shoutout revocation via the shared condition definition", async () => {
    await insertChannel(database, "channel-shoutout");
    const body = JSON.stringify({
      subscription: {
        id: "shoutout-subscription",
        type: "channel.shoutout.create",
        status: "authorization_revoked",
        condition: { broadcaster_user_id: "channel-shoutout", moderator_user_id: "bot-user" },
      },
    });

    const response = await eventSubRouter.fetch(
      signedRequest(secret, "revocation", body, "message-shoutout-revoked"),
      environment(),
    );

    expect(response.status).toBe(204);
    await expect(database.prepare(
      "SELECT channel_id, subscription_type, subscription_id FROM eventsub_revocations",
    ).first()).resolves.toEqual({
      channel_id: "channel-shoutout",
      subscription_type: "channel.shoutout.create",
      subscription_id: "shoutout-subscription",
    });
    await expect(database.prepare(
      "SELECT channel_id, subscription_type, variant, subscription_id, status, reason FROM eventsub_subscriptions",
    ).first()).resolves.toEqual({
      channel_id: "channel-shoutout",
      subscription_type: "channel.shoutout.create",
      variant: "",
      subscription_id: "shoutout-subscription",
      status: "revoked",
      reason: "authorization_revoked",
    });
  });

  it("keeps a revocation for an unknown channel visibly preserved", async () => {
    const body = revocationBody("channel-unknown", "subscription-unknown");
    const response = await eventSubRouter.fetch(
      signedRequest(secret, "revocation", body, "message-unknown"),
      environment(),
    );

    expect(response.status).toBe(204);
    await expect(database.prepare(
      "SELECT subscription_id, channel_id, status FROM eventsub_revocations WHERE subscription_id = 'subscription-unknown'",
    ).first()).resolves.toEqual({
      subscription_id: "subscription-unknown",
      channel_id: "channel-unknown",
      status: "revoked",
    });
    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM channels WHERE channel_id = 'channel-unknown'",
    ).first()).resolves.toEqual({ count: 0 });
  });

  it("parses nanoseconds and rejects invalid timestamps", () => {
    expect(parseEventSubTimestamp("2026-09-19T10:00:00.123456789Z")).toBe(
      Date.parse("2026-09-19T10:00:00.123Z"),
    );
    expect(parseEventSubTimestamp("2026-09-19 10:00:00Z")).toBeNull();
    expect(isEventSubTimestampFresh("2026-09-19T09:50:00.000Z", Date.parse("2026-09-19T10:00:00.000Z"))).toBe(true);
    expect(isEventSubTimestampFresh("2026-09-19T09:49:29.999Z", Date.parse("2026-09-19T10:00:00.000Z"))).toBe(false);
    expect(isEventSubTimestampFresh("2026-09-19T10:10:30.000Z", Date.parse("2026-09-19T10:00:00.000Z"))).toBe(true);
    expect(isEventSubTimestampFresh("2026-09-19T10:10:30.001Z", Date.parse("2026-09-19T10:00:00.000Z"))).toBe(false);
  });

  it("derives the retention from whichever retry window is set", () => {
    const now = "2026-09-19T10:00:00.000Z";

    expect(eventSubMessageCutoff(now, 10 * 60 * 1000)).toBe("2026-09-19T09:40:00.000Z");
    expect(eventSubMessageCutoff(now, 60 * 60 * 1000)).toBe("2026-09-19T08:00:00.000Z");
  });

  it("uses the time index for EventSub cleanup", async () => {
    const preparedSql: string[] = [];
    const databaseProxy = {
      prepare: (sql: string): TestPreparedStatement => {
        preparedSql.push(sql);
        return database.prepare(sql);
      },
    } as unknown as D1Database;
    await purgeOldEventSubMessages(databaseProxy, "2026-09-19T09:40:00.000Z");
    const deleteSql = preparedSql.find((sql) => sql.includes("DELETE FROM eventsub_messages"));
    expect(deleteSql).toBeDefined();
    const plan = database.sqlite.prepare(
      `EXPLAIN QUERY PLAN ${deleteSql ?? ""}`,
    ).all("2026-09-19T09:40:00.000Z") as Array<{ detail: string }>;
    const details = plan.map((row) => row.detail).join(" ");

    expect(details).toMatch(/USING (?:COVERING )?INDEX eventsub_messages_received_idx/);
    expect(details).not.toContain("SCAN eventsub_messages");
  });


  it("cleans up old message IDs in the hourly cron", async () => {
    await database.prepare(
      "INSERT INTO eventsub_messages (message_id, received_at) VALUES (?, ?), (?, ?)",
    ).bind(
      "old-message",
      "2026-09-19T09:39:59.999Z",
      "boundary-message",
      "2026-09-19T09:40:00.000Z",
    ).run();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ access_token: "scheduled-token", expires_in: 7200 }),
      { status: 200 },
    )));

    await scheduled(
      {} as ScheduledController,
      environment(),
      { waitUntil: vi.fn() } as unknown as ExecutionContext,
    );

    const rows = await database.prepare(
      "SELECT message_id FROM eventsub_messages ORDER BY message_id",
    ).all<{ message_id: string }>();
    expect(rows.results.map((row) => row.message_id)).toEqual(["boundary-message"]);
  });
});
