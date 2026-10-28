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
    { id: "timers", eventSubTypes: ["channel.chat.message", "stream.online", "stream.offline"] },
    { id: "channel_events", mandatory: true, eventSubTypes: ["channel.shoutout.create"] },
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

const prepareChatMaintenance = async (database: TestD1Database, channelIds: string[]): Promise<void> => {
  for (const channelId of channelIds) {
    await insertChannel(database, channelId);
    await insertLoginIdentityAndSession(database, channelId, ["channel:bot"]);
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'chat', 1, '{}')",
    ).bind(channelId).run();
  }
  await database.prepare(
    `INSERT INTO bot_identity
      (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
       expires_at, created_at, updated_at)
     VALUES (1, 'bot-user', 'bot', '[]', 'access', 'refresh', ?, ?, ?)`,
  ).bind("2099-09-19T00:00:00.000Z", "2026-09-19T00:00:00.000Z", "2026-09-19T00:00:00.000Z").run();
  await insertAppToken(database);
};

const confirmBotModerator = async (database: TestD1Database, channelId: string): Promise<void> => {
  await database.prepare(
    `INSERT INTO bot_channel_status (channel_id, is_moderator, checked_at, reason)
     VALUES (?, 1, '2026-09-19T00:00:00.000Z', NULL)`,
  ).bind(channelId).run();
};

describe("EventSub reconciliation", () => {
  let database: TestD1Database;

  beforeEach(() => {
    database = new TestD1Database();
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    database.close();
    vi.unstubAllGlobals();
  });

  it("keeps chat activity subscribed when timers are the only enabled chat consumer", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('kanal-a', 'timers', 1, '{}')",
    ).run();

    const targets = await listDesiredEventSubTargets(asD1(database), "kanal-a");

    expect(targets).toContainEqual({
      channelId: "kanal-a",
      subscriptionType: "channel.chat.message",
      variant: "",
      version: "1",
    });
  });

  it("subscribes to ad breaks from broadcaster consent even when ads is disabled", async () => {
    await insertChannel(database, "ad-connected");
    await insertChannel(database, "ad-connected-no-scope");
    await insertChannel(database, "ad-unconnected");
    await insertLoginIdentityAndSession(database, "ad-connected", ["channel:read:ads"]);
    await insertLoginIdentityAndSession(database, "ad-connected-no-scope");

    const connectedTargets = await listDesiredEventSubTargets(asD1(database), "ad-connected");
    const connectedWithoutScopeTargets = await listDesiredEventSubTargets(asD1(database), "ad-connected-no-scope");
    const unconnectedTargets = await listDesiredEventSubTargets(asD1(database), "ad-unconnected");

    expect(connectedTargets).toContainEqual({
      channelId: "ad-connected",
      subscriptionType: "channel.ad_break.begin",
      variant: "",
      version: "1",
    });
    expect(connectedWithoutScopeTargets).not.toContainEqual(expect.objectContaining({ subscriptionType: "channel.ad_break.begin" }));
    expect(unconnectedTargets).not.toContainEqual(expect.objectContaining({ subscriptionType: "channel.ad_break.begin" }));
  });

  it("includes only enabled modules with channel:bot consent in the target state", async () => {
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
      { channelId: "kanal-a", subscriptionType: "channel.shoutout.create", variant: "", version: "1", deferredReason: "moderator_required" },
    ]);
    await expect(listDesiredEventSubTargets(asD1(database), "kanal-a")).resolves.toEqual([
      { channelId: "kanal-a", subscriptionType: "channel.chat.message", variant: "", version: "1" },
      { channelId: "kanal-a", subscriptionType: "channel.shoutout.create", variant: "", version: "1", deferredReason: "moderator_required" },
    ]);
  });

  it("defers moderator subscriptions until status is confirmed", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('kanal-a', 'moderation', 1, '{}')`,
    ).run();

    const deferred = await listDesiredEventSubTargets(asD1(database), "kanal-a");
    expect(deferred).toContainEqual({
      channelId: "kanal-a",
      subscriptionType: "channel.moderate",
      variant: "",
      version: "2",
      deferredReason: "moderator_required",
    });
    await confirmBotModerator(database, "kanal-a");
    expect(await listDesiredEventSubTargets(asD1(database), "kanal-a")).toContainEqual({
      channelId: "kanal-a",
      subscriptionType: "channel.moderate",
      variant: "",
      version: "2",
    });
  });

  it("reads the Twitch subscription list through pagination and stops on a cursor loop", async () => {
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

    // Every call needs its own Response: a body can only be read once, and a
    // shared object would already fail on the second call with an empty
    // body — the loop detection would then never even be reached.
    const loopingFetcher = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ data: [], pagination: { cursor: "immer" } }), { status: 200 })));
    await expect(fetchEventSubSubscriptions(loopingFetcher, "client-id", "app-token")).rejects.toMatchObject({ code: "pagination_loop" });
  });

  it("creates a missing chat subscription with app token, bot ID, and broadcaster ID", async () => {
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

  it("fetches the application subscription inventory once for a multi-channel maintenance run", async () => {
    for (const channelId of ["kanal-a", "kanal-b"]) {
      await insertChannel(database, channelId);
      await insertLoginIdentityAndSession(database, channelId, ["channel:bot"]);
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'chat', 1, '{}')",
      ).bind(channelId).run();
    }
    await database.prepare(
      `INSERT INTO bot_identity
        (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
         expires_at, created_at, updated_at)
       VALUES (1, 'bot-user', 'bot', '[]', 'access', 'refresh', ?, ?, ?)`,
    ).bind("2099-09-19T00:00:00.000Z", "2026-09-19T00:00:00.000Z", "2026-09-19T00:00:00.000Z").run();
    await insertAppToken(database);
    let created = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_input, init) => {
      if (init?.method !== "POST" || typeof init.body !== "string") {
        return Promise.resolve(new Response(JSON.stringify({ data: [], pagination: {} }), { status: 200 }));
      }
      created += 1;
      const body = JSON.parse(init.body) as {
        type: string;
        version: string;
        condition: { broadcaster_user_id: string; user_id: string };
        transport: { callback: string };
      };
      return Promise.resolve(new Response(JSON.stringify({ data: [{
        id: `subscription-${String(created)}`,
        type: body.type,
        version: body.version,
        status: "enabled",
        condition: body.condition,
        transport: { method: "webhook", callback: body.transport.callback },
      }] }), { status: 202 }));
    });

    await maintainEventSubSubscriptions(environment(database), "2026-09-19T01:00:00.000Z", fetcher);

    const inventoryRequests = fetcher.mock.calls.filter(([, init]) => init?.method !== "POST");
    expect(inventoryRequests).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM eventsub_subscriptions WHERE status = 'enabled'",
    ).first()).resolves.toEqual({ count: 2 });
  });

  it("refreshes a pending webhook subscription during a coalesced pass after verification enables it", async () => {
    await prepareChatMaintenance(database, ["kanal-a"]);
    const subscription = (status: string) => ({
      id: "subscription-a",
      type: "channel.chat.message",
      version: "1",
      status,
      condition: { broadcaster_user_id: "kanal-a", user_id: "bot-user" },
      transport: { method: "webhook", callback: "https://brobot.example/api/twitch/eventsub" },
    });
    let releasePendingCreation!: (response: Response) => void;
    const pendingCreation = new Promise<Response>((resolve) => {
      releasePendingCreation = (response) => { resolve(response); };
    });
    let requestCount = 0;
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      requestCount += 1;
      if (init?.method === "POST") return await pendingCreation;
      if (requestCount === 1) return Response.json({ data: [], pagination: {} });
      return Response.json({ data: [subscription("enabled")], pagination: {} });
    });

    const firstRun = maintainEventSubSubscriptions(environment(database), "2026-09-19T01:00:00.000Z", fetcher, "kanal-a");
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(2); });
    await maintainEventSubSubscriptions(environment(database), "2026-09-19T01:01:00.000Z", fetcher, "kanal-a");
    releasePendingCreation(Response.json({ data: [subscription("webhook_callback_verification_pending")] }, { status: 202 }));
    await firstRun;

    expect(fetcher.mock.calls.map(([, init]) => init?.method ?? "GET"))
      .toEqual(["GET", "POST", "GET"]);
    await expect(database.prepare(
      "SELECT status, subscription_id FROM eventsub_subscriptions WHERE channel_id = 'kanal-a' AND subscription_type = 'channel.chat.message'",
    ).first()).resolves.toEqual({ status: "enabled", subscription_id: "subscription-a" });
  });

  it("adopts a subscription created by an overlapping channel worker without replacing it", async () => {
    await prepareChatMaintenance(database, ["kanal-a", "kanal-b"]);
    const remoteSubscriptions: Array<Record<string, unknown>> = [];
    let releaseChannelACreation!: (response: Response) => void;
    const channelACreation = new Promise<Response>((resolve) => {
      releaseChannelACreation = (response) => { resolve(response); };
    });
    const parseCreateRequest = (init: RequestInit | undefined): {
      type: string;
      version: string;
      condition: Record<string, string>;
      transport: { callback: string };
    } => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON EventSub request body.");
      return JSON.parse(init.body) as {
        type: string;
        version: string;
        condition: Record<string, string>;
        transport: { callback: string };
      };
    };
    const createdFromRequest = (init: RequestInit | undefined, id: string): Record<string, unknown> => {
      const body = parseCreateRequest(init);
      return {
        id,
        type: body.type,
        version: body.version,
        status: "enabled",
        condition: body.condition,
        transport: { method: "webhook", callback: body.transport.callback },
      };
    };
    const globalFetcher = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.method === "POST") {
        const body = parseCreateRequest(init);
        if (body.condition.broadcaster_user_id === "kanal-a") {
          const response = await channelACreation;
          return response;
        }
        if (remoteSubscriptions.some((subscription) =>
          (subscription.condition as Record<string, string>).broadcaster_user_id === "kanal-b")) {
          return Response.json({ error: "Conflict", message: "subscription already exists" }, { status: 409 });
        }
        const subscription = createdFromRequest(init, "unexpected-global-channel-b");
        remoteSubscriptions.push(subscription);
        return Response.json({ data: [subscription] }, { status: 202 });
      }
      return Response.json({ data: remoteSubscriptions, pagination: {} });
    });
    const channelFetcher = vi.fn<typeof fetch>((_input, init) => {
      if (init?.method === "POST") {
        const subscription = createdFromRequest(init, "subscription-b-from-channel-worker");
        remoteSubscriptions.push(subscription);
        return Promise.resolve(Response.json({ data: [subscription] }, { status: 202 }));
      }
      return Promise.resolve(Response.json({ data: remoteSubscriptions, pagination: {} }));
    });

    const globalRun = maintainEventSubSubscriptions(environment(database), "2026-09-19T01:00:00.000Z", globalFetcher);
    await vi.waitFor(() => { expect(globalFetcher).toHaveBeenCalledTimes(2); });
    await maintainEventSubSubscriptions(environment(database), "2026-09-19T01:01:00.000Z", channelFetcher, "kanal-b");
    const channelBSubscription = remoteSubscriptions.find((subscription) =>
      (subscription.condition as Record<string, string>).broadcaster_user_id === "kanal-b");
    expect(channelBSubscription?.id).toBe("subscription-b-from-channel-worker");
    releaseChannelACreation(Response.json({ data: [createdFromRequest(globalFetcher.mock.calls[1]?.[1], "subscription-a")] }, { status: 202 }));
    await globalRun;

    expect(globalFetcher.mock.calls.map(([, init]) => init?.method ?? "GET"))
      .toEqual(["GET", "POST", "POST", "GET"]);
    expect(globalFetcher.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    await expect(database.prepare(
      "SELECT status, subscription_id FROM eventsub_subscriptions WHERE channel_id = 'kanal-b' AND subscription_type = 'channel.chat.message'",
    ).first()).resolves.toEqual({ status: "enabled", subscription_id: "subscription-b-from-channel-worker" });
  });

  it("retries the shared inventory after a transient failure", async () => {
    await prepareChatMaintenance(database, ["kanal-a", "kanal-b"]);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ message: "temporary unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ data: [], pagination: {} }, { status: 200 }))
      .mockResolvedValueOnce(Response.json({ data: [{
        id: "subscription-b",
        type: "channel.chat.message",
        version: "1",
        status: "enabled",
        condition: { broadcaster_user_id: "kanal-b", user_id: "bot-user" },
        transport: { method: "webhook", callback: "https://brobot.example/api/twitch/eventsub" },
      }] }, { status: 202 }));

    await maintainEventSubSubscriptions(environment(database), "2026-09-19T01:00:00.000Z", fetcher);

    expect(fetcher.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.method ?? "GET"))
      .toEqual(["GET", "GET", "POST"]);
    await expect(database.prepare(
      "SELECT status, subscription_id FROM eventsub_subscriptions WHERE channel_id = 'kanal-a' AND subscription_type = 'channel.chat.message'",
    ).first()).resolves.toMatchObject({ status: "error" });
    await expect(database.prepare(
      "SELECT status, subscription_id FROM eventsub_subscriptions WHERE channel_id = 'kanal-b' AND subscription_type = 'channel.chat.message'",
    ).first()).resolves.toEqual({ status: "enabled", subscription_id: "subscription-b" });
  });

  it("adopts an untracked owned subscription after create returns the already-exists conflict", async () => {
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
    const remote = {
      id: "e6c8e776-adopted",
      type: "channel.chat.message",
      version: "1",
      status: "enabled",
      condition: { broadcaster_user_id: "kanal-a", user_id: "bot-user" },
      transport: { method: "webhook", callback: "https://brobot.example/api/twitch/eventsub" },
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [], pagination: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Conflict", message: "subscription already exists; id=e6c8e776-adopted" }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [remote], pagination: {} }), { status: 200 }));

    await maintainEventSubSubscriptions(environment(database), "2026-09-19T01:00:00.000Z", fetcher, "kanal-a");

    expect(fetcher.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.method ?? "GET"))
      .toEqual(["GET", "POST", "GET"]);
    await expect(database.prepare(
      "SELECT status, reason, subscription_id, secret_id FROM eventsub_subscriptions WHERE channel_id = 'kanal-a' AND subscription_type = 'channel.chat.message'",
    ).first()).resolves.toEqual({
      status: "enabled",
      reason: null,
      subscription_id: "e6c8e776-adopted",
      secret_id: null,
    });
  });

  it("keeps a not-yet-listed 409 subscription neutral until a later adoption pass", async () => {
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
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Conflict", message: "subscription already exists; id=e6c8e776-adopted" }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [], pagination: {} }), { status: 200 }));

    await maintainEventSubSubscriptions(environment(database), "2026-09-19T01:00:00.000Z", fetcher, "kanal-a");

    await expect(database.prepare(
      "SELECT status, reason, subscription_id, secret_id, error_message, error_status FROM eventsub_subscriptions WHERE channel_id = 'kanal-a' AND subscription_type = 'channel.chat.message'",
    ).first()).resolves.toEqual({
      status: "missing",
      reason: "pending_adoption",
      subscription_id: null,
      secret_id: null,
      error_message: null,
      error_status: null,
    });
  });

  it("serializes overlapping maintenance for a channel and runs one coalesced pass afterwards", async () => {
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
    let releaseInitialList!: (response: Response) => void;
    const initialList = new Promise<Response>((resolve) => { releaseInitialList = resolve; });
    let requestCount = 0;
    let activeCalls = 0;
    let maximumConcurrentCalls = 0;
    const remote = {
      id: "subscription-after-create",
      type: "channel.chat.message",
      version: "1",
      status: "enabled",
      condition: { broadcaster_user_id: "kanal-a", user_id: "bot-user" },
      transport: { method: "webhook", callback: "https://brobot.example/api/twitch/eventsub" },
    };
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      requestCount += 1;
      activeCalls += 1;
      maximumConcurrentCalls = Math.max(maximumConcurrentCalls, activeCalls);
      try {
        if (requestCount === 1) return await initialList;
        if (init?.method === "POST") return Response.json({ data: [remote] }, { status: 202 });
        return Response.json({ data: [remote], pagination: {} });
      } finally {
        activeCalls -= 1;
      }
    });

    const firstRun = maintainEventSubSubscriptions(environment(database), "2026-09-19T01:00:00.000Z", fetcher, "kanal-a");
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(1); });
    await maintainEventSubSubscriptions(environment(database), "2026-09-19T01:01:00.000Z", fetcher, "kanal-a");
    expect(fetcher).toHaveBeenCalledTimes(1);
    releaseInitialList(Response.json({ data: [], pagination: {} }));
    await firstRun;

    expect(requestCount).toBe(2);
    expect(maximumConcurrentCalls).toBe(1);
    await expect(database.prepare(
      "SELECT status, subscription_id FROM eventsub_subscriptions WHERE channel_id = 'kanal-a' AND subscription_type = 'channel.chat.message'",
    ).first()).resolves.toEqual({ status: "enabled", subscription_id: "subscription-after-create" });
  });

  it("creates channel.moderate with version 2 and moderator_user_id", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('kanal-a', 'moderation', 1, '{}')`,
    ).run();
    await confirmBotModerator(database, "kanal-a");
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
      }), { status: 202 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{
        id: "shoutout-subscription",
        type: "channel.shoutout.create",
        version: "1",
        status: "enabled",
        condition: { broadcaster_user_id: "kanal-a", moderator_user_id: "bot-user" },
        transport: { method: "webhook", callback: "https://brobot.example/api/twitch/eventsub" },
      }] }), { status: 202 }));

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

  it("recognizes an existing channel.moderate v2 subscription, but not a v1 subscription, as matching", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('kanal-a', 'moderation', 1, '{}')`,
    ).run();
    await confirmBotModerator(database, "kanal-a");
    await database.prepare(
      `INSERT INTO bot_identity
        (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
         expires_at, created_at, updated_at)
       VALUES (1, 'bot-user', 'bot', '[]', 'access', 'refresh', ?, ?, ?)`,
    ).bind("2099-09-19T00:00:00.000Z", "2026-09-19T00:00:00.000Z", "2026-09-19T00:00:00.000Z").run();
    await insertAppToken(database);
    await database.prepare(
      `INSERT INTO eventsub_subscriptions
        (channel_id, subscription_type, variant, version, subscription_id, secret_id, status, reason, updated_at)
       VALUES
        ('kanal-a', 'channel.moderate', '', '2', 'v2', 'eventsub-v1', 'enabled', NULL, '2026-09-19T00:00:00.000Z'),
        ('kanal-a', 'channel.shoutout.create', '', '1', 'shoutout-subscription', 'eventsub-v1', 'enabled', NULL, '2026-09-19T00:00:00.000Z')`,
    ).run();
    const subscription = (version: string, id: string) => ({
      id,
      type: "channel.moderate",
      version,
      status: "enabled",
      condition: { broadcaster_user_id: "kanal-a", moderator_user_id: "bot-user" },
      transport: { method: "webhook", callback: "https://brobot.example/api/twitch/eventsub" },
    });
    const shoutout = {
      id: "shoutout-subscription",
      type: "channel.shoutout.create",
      version: "1",
      status: "enabled",
      condition: { broadcaster_user_id: "kanal-a", moderator_user_id: "bot-user" },
      transport: { method: "webhook", callback: "https://brobot.example/api/twitch/eventsub" },
    };
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [subscription("2", "v2"), shoutout], pagination: {} }), { status: 200 }));

    await maintainEventSubSubscriptions(environment(database), "2026-09-19T01:00:00.000Z", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0]?.[1] as RequestInit).method).toBeUndefined();

    const v1Fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [subscription("1", "v1"), shoutout], pagination: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [subscription("1", "v1"), shoutout], pagination: {} }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [subscription("2", "v2-replaced")], pagination: {} }), { status: 202 }));
    await maintainEventSubSubscriptions(environment(database), "2026-09-19T02:00:00.000Z", v1Fetcher);
    expect(v1Fetcher.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.method ?? "GET")).toEqual(["GET", "GET", "DELETE", "POST"]);
    const replacementBody = (v1Fetcher.mock.calls[3]?.[1] as RequestInit).body;
    expect(typeof replacementBody).toBe("string");
    const parsedReplacementBody: unknown = JSON.parse(typeof replacementBody === "string" ? replacementBody : "{}");
    expect(parsedReplacementBody).toMatchObject({ version: "2" });
  });

  it("stores a distinguishable Twitch rejection reason per v2 target", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('kanal-a', 'moderation', 1, '{}')`,
    ).run();
    await confirmBotModerator(database, "kanal-a");
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
      }), { status: 403 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{
        id: "shoutout-subscription",
        type: "channel.shoutout.create",
        version: "1",
        status: "enabled",
        condition: { broadcaster_user_id: "kanal-a", moderator_user_id: "bot-user" },
        transport: { method: "webhook", callback: "https://brobot.example/api/twitch/eventsub" },
      }] }), { status: 202 }));

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

  it("recognizes an existing shoutout subscription with a moderator ID and leaves it unchanged on follow-up reconciliations", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('kanal-a', 'channel_events', 1, '{}')`,
    ).run();
    await confirmBotModerator(database, "kanal-a");
    await database.prepare(
      `INSERT INTO bot_identity
        (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
         expires_at, created_at, updated_at)
       VALUES (1, 'bot-user', 'bot', '[]', 'access', 'refresh', ?, ?, ?)`,
    ).bind("2099-09-19T00:00:00.000Z", "2026-09-19T00:00:00.000Z", "2026-09-19T00:00:00.000Z").run();
    await insertAppToken(database);
    await database.prepare(
      `INSERT INTO eventsub_subscriptions
        (channel_id, subscription_type, variant, version, subscription_id, secret_id, status, reason, updated_at)
       VALUES ('kanal-a', 'channel.shoutout.create', '', '1', 'shoutout-subscription', 'eventsub-v1', 'enabled', NULL, '2026-09-19T00:00:00.000Z')`,
    ).run();

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

  it("records Twitch errors per channel and continues with the next channel", async () => {
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

    expect(fetcher.mock.calls.map(([, init]) => (init as RequestInit | undefined)?.method ?? "GET"))
      .toEqual(["GET", "POST", "POST"]);

    await expect(database.prepare(
      "SELECT channel_id, status, reason FROM eventsub_subscriptions ORDER BY channel_id, subscription_type",
    ).all()).resolves.toEqual({
      results: [
        { channel_id: "kanal-a", status: "error", reason: "rate_limited" },
        { channel_id: "kanal-a", status: "missing", reason: "moderator_required" },
        { channel_id: "kanal-b", status: "enabled", reason: null },
        { channel_id: "kanal-b", status: "missing", reason: "moderator_required" },
      ],
      success: true,
      meta: { changes: 0, size: 0 },
    });
  });

  it("doesn't touch a second channel's EventSub subscriptions during a filtered run", async () => {
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
      "SELECT channel_id, status, subscription_id, reason FROM eventsub_subscriptions ORDER BY channel_id, subscription_type",
    ).all()).resolves.toEqual({
      results: [
        { channel_id: "kanal-a", status: "enabled", subscription_id: "subscription-a", reason: null },
        { channel_id: "kanal-a", status: "missing", subscription_id: null, reason: "moderator_required" },
        { channel_id: "kanal-b", status: "enabled", subscription_id: "subscription-b", reason: null },
      ],
      success: true,
      meta: { changes: 0, size: 0 },
    });
  });

  it("cleans up a subscription after the broadcaster consent is revoked", async () => {
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

    expect(fetcher).toHaveBeenNthCalledWith(3, "https://api.twitch.tv/helix/eventsub/subscriptions?id=subscription-a", expect.objectContaining({ method: "DELETE" }));
    await expect(database.prepare(
      "SELECT status, subscription_id, reason FROM eventsub_subscriptions WHERE channel_id = 'kanal-a'",
    ).first()).resolves.toEqual({ status: "missing", subscription_id: null, reason: "channel_or_consent_missing" });
  });
});
