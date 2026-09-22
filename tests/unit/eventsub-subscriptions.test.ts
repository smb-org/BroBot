import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchEventSubSubscriptions,
  listDesiredEventSubTargets,
  maintainEventSubSubscriptions,
} from "../../src/worker/eventsub-subscriptions";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { insertChannel, insertLoginIdentityAndSession } from "./fixtures";
import { TestD1Database } from "./test-d1";

vi.mock("../../src/modules/registry", () => ({
  MODULES: [
    { id: "chat", eventSubTypes: ["channel.chat.message"] },
    { id: "channel_events", eventSubTypes: ["channel.shoutout.create"] },
    { id: "moderation", eventSubTypes: ["channel.moderate"] },
    { id: "aus", eventSubTypes: ["channel.follow"] },
  ],
}));

const asD1 = (database: TestD1Database): D1Database => database as unknown as D1Database;

const key = (byte: number): string => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
  .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const environment = (database: TestD1Database): Env => ({
  DB: asD1(database),
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  TWITCH_EVENTSUB_SECRET: JSON.stringify({ active: { id: "eventsub-v1", key: key(3) }, retired: [] }),
  PUBLIC_ORIGIN: "https://brobot.example",
  TOKEN_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "token-v1", key: key(4) }, retired: [] }),
} as unknown as Env);

const insertAppToken = async (database: TestD1Database): Promise<void> => {
  const keys = JSON.stringify({ active: { id: "token-v1", key: key(4) }, retired: [] });
  const ciphertext = await encryptJson({ token: "app-token" }, parseKeyRing(keys));
  await database.prepare(
    `INSERT INTO twitch_app_access_token
      (id, access_token_ciphertext, expires_at, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?)`,
  ).bind(ciphertext, "2099-09-19T00:00:00.000Z", "2026-09-19T00:00:00.000Z", "2026-09-19T00:00:00.000Z").run();
};

describe("EventSub-Abgleich", () => {
  let database: TestD1Database;

  beforeEach(() => {
    database = new TestD1Database();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    database.close();
    vi.unstubAllGlobals();
  });

  it("nimmt nur aktivierte Module mit channel:bot-Zustimmung in den Sollstand", async () => {
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertChannel(database, "kanal-c");
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
    await insertLoginIdentityAndSession(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "kanal-c", ["channel:bot"]);
    await database.prepare(
      "UPDATE twitch_login_identity SET status = 'revoked' WHERE user_id = 'kanal-c'",
    ).run();
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('kanal-a', 'chat', 1, '{}'), ('kanal-a', 'aus', 0, '{}'), ('kanal-b', 'chat', 1, '{}'), ('kanal-c', 'chat', 1, '{}')`,
    ).run();

    await expect(listDesiredEventSubTargets(asD1(database))).resolves.toEqual([
      { channelId: "kanal-a", subscriptionType: "channel.chat.message", variant: "", version: "1" },
    ]);
    await expect(listDesiredEventSubTargets(asD1(database), "kanal-a")).resolves.toEqual([
      { channelId: "kanal-a", subscriptionType: "channel.chat.message", variant: "", version: "1" },
    ]);
  });

  it("liest die Twitch-Aboliste durchpaginiert und stoppt bei einem Cursor-Kreis", async () => {
    const subscription = {
      id: "subscription-1",
      type: "channel.chat.message",
      version: "1",
      status: "enabled",
      condition: { broadcaster_user_id: "kanal-a", user_id: "bot-user" },
      transport: { method: "webhook", callback: "https://brobot.example/api/twitch/eventsub" },
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [subscription], pagination: { cursor: "seite-2" } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [], pagination: {} }), { status: 200 }));

    await expect(fetchEventSubSubscriptions(fetcher, "client-id", "app-token")).resolves.toEqual([subscription]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[1]?.[0])).toContain("after=seite-2");

    // Jeder Aufruf braucht eine eigene Response: Ein Körper laesst sich nur
    // einmal lesen, und ein geteiltes Objekt scheitert beim zweiten Mal schon
    // am leeren Körper — die Kreiserkennung wuerde dann gar nicht erreicht.
    const loopingFetcher = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ data: [], pagination: { cursor: "immer" } }), { status: 200 })));
    await expect(fetchEventSubSubscriptions(loopingFetcher, "client-id", "app-token")).rejects.toMatchObject({ code: "pagination_loop" });
  });

  it("legt ein fehlendes Chat-Abo mit App-Token, Bot-ID und Broadcaster-ID an", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('kanal-a', 'chat', 1, '{}')`,
    ).run();
    await database.prepare(
      `INSERT INTO bot_identity
        (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
         expires_at, created_at, updated_at)
       VALUES (1, 'bot-user', 'bot', '[]', 'access', 'refresh', ?, ?, ?)`,
    ).bind("2099-09-19T00:00:00.000Z", "2026-09-19T00:00:00.000Z", "2026-09-19T00:00:00.000Z").run();
    await insertAppToken(database);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [], pagination: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: "subscription-1", type: "channel.chat.message", version: "1", status: "enabled", condition: { broadcaster_user_id: "kanal-a", user_id: "bot-user" }, transport: { method: "webhook", callback: "https://brobot.example/api/twitch/eventsub" } }],
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: "subscription-1", type: "channel.chat.message", version: "1", status: "enabled", condition: { broadcaster_user_id: "kanal-a", user_id: "bot-user" }, transport: { method: "webhook", callback: "https://brobot.example/api/twitch/eventsub" } }],
        pagination: {},
      }), { status: 200 }));

    await maintainEventSubSubscriptions(environment(database), "2026-09-19T01:00:00.000Z", fetcher);
    await maintainEventSubSubscriptions(environment(database), "2026-09-19T02:00:00.000Z", fetcher);

    expect(fetcher).toHaveBeenNthCalledWith(2, "https://api.twitch.tv/helix/eventsub/subscriptions", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({
        type: "channel.chat.message",
        version: "1",
        condition: { broadcaster_user_id: "kanal-a", user_id: "bot-user" },
        transport: {
          method: "webhook",
          callback: "https://brobot.example/api/twitch/eventsub",
          secret: key(3),
        },
      }),
    }));
    const createRequest = fetcher.mock.calls[1]?.[1] as RequestInit;
    const headers = new Headers(createRequest.headers);
    expect(headers.get("Authorization")).toBe("Bearer app-token");
    expect(headers.get("Client-ID")).toBe("client-id");
    expect(fetcher).toHaveBeenCalledTimes(3);
    await expect(database.prepare(
      "SELECT status, subscription_id FROM eventsub_subscriptions WHERE channel_id = 'kanal-a' AND subscription_type = 'channel.chat.message'",
    ).first()).resolves.toEqual({ status: "enabled", subscription_id: "subscription-1" });
  });

  it("legt channel.moderate mit Version 2 und moderator_user_id an", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('kanal-a', 'moderation', 1, '{}')`,
    ).run();
    await database.prepare(
      `INSERT INTO bot_identity
        (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
         expires_at, created_at, updated_at)
       VALUES (1, 'bot-user', 'bot', '[]', 'access', 'refresh', ?, ?, ?)`,
    ).bind("2099-09-19T00:00:00.000Z", "2026-09-19T00:00:00.000Z", "2026-09-19T00:00:00.000Z").run();
    await insertAppToken(database);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [], pagination: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{
          id: "moderation-subscription",
          type: "channel.moderate",
          version: "2",
          status: "enabled",
          condition: { broadcaster_user_id: "kanal-a", moderator_user_id: "bot-user" },
          transport: { method: "webhook", callback: "https://brobot.example/api/twitch/eventsub" },
        }],
      }), { status: 202 }));

    await maintainEventSubSubscriptions(environment(database), "2026-09-19T01:00:00.000Z", fetcher);

    expect((fetcher.mock.calls[1]?.[1] as RequestInit).method).toBe("POST");
    const createBody = (fetcher.mock.calls[1]?.[1] as RequestInit).body;
    expect(typeof createBody).toBe("string");
    const parsedCreateBody: unknown = JSON.parse(typeof createBody === "string" ? createBody : "{}");
    expect(parsedCreateBody).toMatchObject({
      type: "channel.moderate",
      version: "2",
      condition: { broadcaster_user_id: "kanal-a", moderator_user_id: "bot-user" },
    });
    await expect(database.prepare(
      "SELECT version, status, subscription_id FROM eventsub_subscriptions WHERE channel_id = 'kanal-a' AND subscription_type = 'channel.moderate'",
    ).first()).resolves.toEqual({ version: "2", status: "enabled", subscription_id: "moderation-subscription" });
  });

  it("erkennt ein vorhandenes channel.moderate-v2-Abo, aber kein v1-Abo als passend", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('kanal-a', 'moderation', 1, '{}')`,
    ).run();
    await database.prepare(
      `INSERT INTO bot_identity
        (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
         expires_at, created_at, updated_at)
       VALUES (1, 'bot-user', 'bot', '[]', 'access', 'refresh', ?, ?, ?)`,
    ).bind("2099-09-19T00:00:00.000Z", "2026-09-19T00:00:00.000Z", "2026-09-19T00:00:00.000Z").run();
    await insertAppToken(database);
    const subscription = (version: string, id: string) => ({
      id,
      type: "channel.moderate",
      version,
      status: "enabled",
      condition: { broadcaster_user_id: "kanal-a", moderator_user_id: "bot-user" },
      transport: { method: "webhook", callback: "https://brobot.example/api/twitch/eventsub" },
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [subscription("2", "v2")], pagination: {} }), { status: 200 }));

    await maintainEventSubSubscriptions(environment(database), "2026-09-19T01:00:00.000Z", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0]?.[1] as RequestInit).method).toBeUndefined();

    const v1Fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [subscription("1", "v1")], pagination: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [subscription("2", "v2-replaced")], pagination: {} }), { status: 202 }));
    await maintainEventSubSubscriptions(environment(database), "2026-09-19T02:00:00.000Z", v1Fetcher);
    expect(v1Fetcher.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.method ?? "GET")).toEqual(["GET", "DELETE", "POST"]);
    const replacementBody = (v1Fetcher.mock.calls[2]?.[1] as RequestInit).body;
    expect(typeof replacementBody).toBe("string");
    const parsedReplacementBody: unknown = JSON.parse(typeof replacementBody === "string" ? replacementBody : "{}");
    expect(parsedReplacementBody).toMatchObject({ version: "2" });
  });

  it("speichert einen unterscheidbaren Twitch-Ablehnungsgrund je v2-Ziel", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('kanal-a', 'moderation', 1, '{}')`,
    ).run();
    await database.prepare(
      `INSERT INTO bot_identity
        (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
         expires_at, created_at, updated_at)
       VALUES (1, 'bot-user', 'bot', '[]', 'access', 'refresh', ?, ?, ?)`,
    ).bind("2099-09-19T00:00:00.000Z", "2026-09-19T00:00:00.000Z", "2026-09-19T00:00:00.000Z").run();
    await insertAppToken(database);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [], pagination: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "missing_scope",
        message: "Scope fehlt",
        access_token: "access-token-geheim",
        refresh_token: "refresh-token-geheim",
        client_secret: "client-secret-geheim",
        signature: "signature-geheim",
        chat_message: "Chatnachricht-geheim",
      }), { status: 403 }));

    await maintainEventSubSubscriptions(environment(database), "2026-09-19T01:00:00.000Z", fetcher);

    await expect(database.prepare(
      "SELECT version, status, reason, error_message, error_status FROM eventsub_subscriptions WHERE channel_id = 'kanal-a' AND subscription_type = 'channel.moderate'",
    ).first()).resolves.toEqual({
      version: "2",
      status: "error",
      reason: "missing_scope",
      error_message: "Scope fehlt",
      error_status: 403,
    });
    const written = errorLog.mock.calls.flat().join(" ");
    expect(written).toContain("channel=kanal-a");
    expect(written).toContain("subscription_type=channel.moderate");
    expect(written).toContain("status=403");
    expect(written).toContain("code=missing_scope");
    expect(written).toContain("message=Scope fehlt");
    expect(written).not.toContain("access-token-geheim");
    expect(written).not.toContain("refresh-token-geheim");
    expect(written).not.toContain("client-secret-geheim");
    expect(written).not.toContain("signature-geheim");
    expect(written).not.toContain("Chatnachricht-geheim");
    errorLog.mockRestore();
  });

  it("erkennt ein bestehendes Shoutout-Abo mit Moderator-ID wieder und lässt es bei Folgeabgleichen unverändert", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('kanal-a', 'channel_events', 1, '{}')`,
    ).run();
    await database.prepare(
      `INSERT INTO bot_identity
        (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
         expires_at, created_at, updated_at)
       VALUES (1, 'bot-user', 'bot', '[]', 'access', 'refresh', ?, ?, ?)`,
    ).bind("2099-09-19T00:00:00.000Z", "2026-09-19T00:00:00.000Z", "2026-09-19T00:00:00.000Z").run();
    await insertAppToken(database);

    const subscription = {
      id: "shoutout-subscription",
      type: "channel.shoutout.create",
      version: "1",
      status: "enabled",
      condition: { broadcaster_user_id: "kanal-a", moderator_user_id: "bot-user" },
      transport: { method: "webhook", callback: "https://brobot.example/api/twitch/eventsub" },
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [subscription], pagination: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [subscription], pagination: {} }), { status: 200 }));

    await maintainEventSubSubscriptions(environment(database), "2026-09-19T01:00:00.000Z", fetcher);
    await maintainEventSubSubscriptions(environment(database), "2026-09-19T02:00:00.000Z", fetcher);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([, init]) => (init as RequestInit).method ?? "GET")).toEqual(["GET", "GET"]);
    await expect(database.prepare(
      "SELECT status, subscription_id FROM eventsub_subscriptions WHERE channel_id = 'kanal-a' AND subscription_type = 'channel.shoutout.create'",
    ).first()).resolves.toEqual({ status: "enabled", subscription_id: "shoutout-subscription" });
  });

  it("merkt Twitch-Fehler je Kanal und arbeitet mit dem nächsten Kanal weiter", async () => {
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
    await insertLoginIdentityAndSession(database, "kanal-b", ["channel:bot"]);
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('kanal-a', 'chat', 1, '{}'), ('kanal-b', 'chat', 1, '{}')`,
    ).run();
    await database.prepare(
      `INSERT INTO bot_identity
        (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
         expires_at, created_at, updated_at)
       VALUES (1, 'bot-user', 'bot', '[]', 'access', 'refresh', ?, ?, ?)`,
    ).bind("2099-09-19T00:00:00.000Z", "2026-09-19T00:00:00.000Z", "2026-09-19T00:00:00.000Z").run();
    await insertAppToken(database);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [], pagination: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "quota" }), { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{ id: "subscription-b", type: "channel.chat.message", version: "1", status: "enabled", condition: { broadcaster_user_id: "kanal-b", user_id: "bot-user" }, transport: { method: "webhook", callback: "https://brobot.example/api/twitch/eventsub" } }],
      }), { status: 202 }));

    await maintainEventSubSubscriptions(environment(database), "2026-09-19T01:00:00.000Z", fetcher);

    await expect(database.prepare(
      "SELECT channel_id, status, reason FROM eventsub_subscriptions ORDER BY channel_id",
    ).all()).resolves.toEqual({
      results: [
        { channel_id: "kanal-a", status: "error", reason: "rate_limited" },
        { channel_id: "kanal-b", status: "enabled", reason: null },
      ],
      success: true,
      meta: { changes: 0, size: 0 },
    });
  });

  it("fasst ein gefilterter Lauf keine EventSub-Abos eines zweiten Kanals an", async () => {
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
    await insertLoginIdentityAndSession(database, "kanal-b", ["channel:bot"]);
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('kanal-a', 'chat', 1, '{}'), ('kanal-b', 'chat', 1, '{}')`,
    ).run();
    await database.prepare(
      `INSERT INTO bot_identity
        (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
         expires_at, created_at, updated_at)
       VALUES (1, 'bot-user', 'bot', '[]', 'access', 'refresh', ?, ?, ?)`,
    ).bind("2099-09-19T00:00:00.000Z", "2026-09-19T00:00:00.000Z", "2026-09-19T00:00:00.000Z").run();
    await insertAppToken(database);
    await database.prepare(
      `INSERT INTO eventsub_subscriptions
        (channel_id, subscription_type, subscription_id, secret_id, status, reason, updated_at)
       VALUES
        ('kanal-a', 'channel.chat.message', 'subscription-a', 'eventsub-v1', 'enabled', NULL, ?),
        ('kanal-b', 'channel.chat.message', 'subscription-b', 'eventsub-v1', 'enabled', NULL, ?)`,
    ).bind("2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();

    const subscription = (channelId: string, id: string) => ({
      id,
      type: "channel.chat.message",
      version: "1",
      status: "enabled",
      condition: { broadcaster_user_id: channelId, user_id: "bot-user" },
      transport: { method: "webhook", callback: "https://brobot.example/api/twitch/eventsub" },
    });
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      data: [subscription("kanal-a", "subscription-a"), subscription("kanal-b", "subscription-b")],
      pagination: {},
    }), { status: 200 }));

    await maintainEventSubSubscriptions(environment(database), "2026-09-19T01:00:00.000Z", fetcher, "kanal-a");

    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(database.prepare(
      "SELECT channel_id, status, subscription_id, reason FROM eventsub_subscriptions ORDER BY channel_id",
    ).all()).resolves.toEqual({
      results: [
        { channel_id: "kanal-a", status: "enabled", subscription_id: "subscription-a", reason: null },
        { channel_id: "kanal-b", status: "enabled", subscription_id: "subscription-b", reason: null },
      ],
      success: true,
      meta: { changes: 0, size: 0 },
    });
  });

  it("räumt ein Abo nach dem Entzug der Broadcaster-Zustimmung auf", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('kanal-a', 'chat', 1, '{}')`,
    ).run();
    await database.prepare(
      `INSERT INTO bot_identity
        (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
         expires_at, created_at, updated_at)
       VALUES (1, 'bot-user', 'bot', '[]', 'access', 'refresh', ?, ?, ?)`,
    ).bind("2099-09-19T00:00:00.000Z", "2026-09-19T00:00:00.000Z", "2026-09-19T00:00:00.000Z").run();
    await insertAppToken(database);
    await database.prepare(
      `INSERT INTO eventsub_subscriptions
        (channel_id, subscription_type, subscription_id, secret_id, status, reason, updated_at)
       VALUES ('kanal-a', 'channel.chat.message', 'subscription-a', 'eventsub-v1', 'enabled', NULL, ?)`,
    ).bind("2026-09-18T00:00:00.000Z").run();
    await database.prepare(
      "UPDATE twitch_login_identity SET scopes_json = '[]' WHERE user_id = 'kanal-a'",
    ).run();

    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: [{
          id: "subscription-a",
          type: "channel.chat.message",
          version: "1",
          status: "enabled",
          condition: { broadcaster_user_id: "kanal-a", user_id: "bot-user" },
          transport: { method: "webhook", callback: "https://brobot.example/api/twitch/eventsub" },
        }],
        pagination: {},
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await maintainEventSubSubscriptions(environment(database), "2026-09-19T01:00:00.000Z", fetcher);

    expect(fetcher).toHaveBeenNthCalledWith(2, "https://api.twitch.tv/helix/eventsub/subscriptions?id=subscription-a", expect.objectContaining({ method: "DELETE" }));
    await expect(database.prepare(
      "SELECT status, subscription_id, reason FROM eventsub_subscriptions WHERE channel_id = 'kanal-a'",
    ).first()).resolves.toEqual({ status: "missing", subscription_id: null, reason: "channel_or_consent_missing" });
  });
});
