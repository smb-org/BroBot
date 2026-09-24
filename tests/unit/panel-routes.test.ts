import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { listAllBroadcasterScopes } from "../../src/worker/module-scopes";
import { panelRouter } from "../../src/worker/panel/routes";
import * as eventsubMaintenance from "../../src/worker/eventsub-subscriptions";
import { insertAppAccessToken, insertChannel, insertLoginIdentityAndSession, insertMember, testKey as key } from "./fixtures";
import { TestD1Database } from "./test-d1";

const requestedUrl = (input?: RequestInfo | URL): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input?.url ?? "";

const environmentKeys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
};

const insertBroadcasterConnection = async (
  database: TestD1Database,
  channelId: string,
): Promise<void> => {
  await database.prepare(
    `INSERT INTO twitch_connections
      (connection_id, channel_id, purpose, scopes_json, access_token_ciphertext,
       refresh_token_ciphertext, expires_at, created_at, updated_at)
     VALUES (?, ?, 'broadcaster', '[]', 'access', 'refresh', ?, ?, ?)`,
  ).bind(
    `connection-${channelId}`,
    channelId,
    "2099-09-19T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
  ).run();
};

const insertBotIdentity = async (database: TestD1Database): Promise<void> => {
  const ciphertext = await encryptJson(
    { token: "bot-access-token" },
    parseKeyRing(environmentKeys.SESSION_ENCRYPTION_KEYS),
  );
  await database.prepare(
    `INSERT INTO bot_identity
      (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
       expires_at, created_at, updated_at)
     VALUES (1, ?, ?, '[]', ?, ?, ?, ?, ?)`,
  ).bind(
    "bot-user",
    "brobot",
    ciphertext,
    "refresh-ciphertext",
    "2099-09-19T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
  ).run();
};

const insertDefaultAppAccessToken = async (database: TestD1Database): Promise<void> => {
  const ciphertext = await encryptJson(
    { token: "app-access-token" },
    parseKeyRing(environmentKeys.SESSION_ENCRYPTION_KEYS),
  );
  await database.prepare(
    `INSERT INTO twitch_app_access_token
      (id, access_token_ciphertext, expires_at, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?)`,
  ).bind(
    ciphertext,
    "2099-09-19T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
    "2026-09-18T00:00:00.000Z",
  ).run();
};

const insertBotChannelStatus = async (
  database: TestD1Database,
  channelId: string,
  isModerator: boolean,
  checkedAt: string,
  reason: string | null,
): Promise<void> => {
  await database.prepare(
    `INSERT INTO bot_channel_status (channel_id, is_moderator, checked_at, reason)
     VALUES (?, ?, ?, ?)`,
  ).bind(channelId, isModerator ? 1 : 0, checkedAt, reason).run();
};

const insertSessionCookie = async (userId: string): Promise<string> => createSessionCookie(
  { sessionId: `session-${userId}` },
  environmentKeys.SESSION_COOKIE_KEYS,
  environmentKeys.SESSION_ENCRYPTION_KEYS,
);

const makeEnvironment = (database: TestD1Database): Env => ({
  DB: database as unknown as D1Database,
  ...environmentKeys,
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_BOT_LOGIN: "brobot",
  PLATFORM_USER_IDS: JSON.stringify(["4711"]),
} as unknown as Env);

const makeStreamRefreshRuntime = (lease: string | null = "stream-refresh") => {
  const tasks: Promise<unknown>[] = [];
  let retryAfter: number | null = null;
  const channelObject = {
    beginStreamStateRefresh: vi.fn(() => Promise.resolve(lease)),
    endStreamStateRefresh: vi.fn(() => Promise.resolve()),
    getTwitchRateLimitRetryAfter: vi.fn(() => Promise.resolve(retryAfter !== null && retryAfter > Date.now() ? retryAfter : null)),
    setTwitchRateLimitRetryAfter: vi.fn((deadline: number) => {
      retryAfter = deadline;
      return Promise.resolve();
    }),
    publish: vi.fn(() => Promise.resolve()),
  };
  const CHANNEL = {
    idFromName: (channelId: string) => channelId,
    get: () => channelObject,
  } as unknown as DurableObjectNamespace;
  const executionContext = {
    waitUntil: (promise: Promise<unknown>) => { tasks.push(promise); },
    passThroughOnException: () => undefined,
  } as unknown as ExecutionContext;
  return { CHANNEL, executionContext, channelObject, tasks };
};

const insertStreamEventSubCoverage = async (database: TestD1Database, channelId: string): Promise<void> => {
  await database.prepare(
    `INSERT INTO eventsub_subscriptions
      (channel_id, subscription_type, subscription_id, status, updated_at)
     VALUES (?, 'stream.online', ?, 'enabled', ?), (?, 'stream.offline', ?, 'enabled', ?)`,
  ).bind(channelId, `online-${channelId}`, "2026-09-23T08:00:00.000Z", channelId, `offline-${channelId}`, "2026-09-23T08:00:00.000Z").run();
};

const makeRequest = async (
  userId: string | null,
  path: string,
  method = "GET",
  withCsrf = true,
): Promise<Request> => {
  const headers = new Headers();
  if (userId !== null) {
    const sessionCookie = await insertSessionCookie(userId);
    if (method === "GET" || !withCsrf) {
      headers.set("Cookie", `__Host-brobot_session=${sessionCookie}`);
    } else {
      const csrfToken = await createCsrfToken(
        `session-${userId}`,
        environmentKeys.SESSION_COOKIE_KEYS,
        "2026-09-18T04:00:00.000Z",
      );
      headers.set("Cookie", `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrfToken}`);
      headers.set("X-CSRF-Token", csrfToken);
    }
  }
  return new Request(`https://brobot.example${path}`, { method, headers });
};

describe("Panel read endpoints", () => {
  let database: TestD1Database;
  let environment: Env;

  beforeEach(() => {
    database = new TestD1Database();
    environment = makeEnvironment(database);
    // Default: no network in tests that don't stub `fetch` themselves. The
    // overview route's Helix stream-state backfill (#178) would otherwise
    // reach the real network whenever a test channel has no stored state.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network disabled in tests")));
  });

  afterEach(() => {
    database.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("rejects a channel-bound read request without a session", async () => {
    await insertChannel(database, "kanal-a");

    const response = await panelRouter.fetch(
      await makeRequest(null, "/api/channels/kanal-a/overview"),
      environment,
    );

    expect(response.status).toBe(401);
  });

  it("rejects the non-channel-bound channel list without a session", async () => {
    const response = await panelRouter.fetch(
      await makeRequest(null, "/api/channels"),
      environment,
    );

    expect(response.status).toBe(401);
  });

  it("rejects an existing but unrelated channel route", async () => {
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await insertBroadcasterConnection(database, "kanal-b");
    await database.prepare(
      `INSERT INTO audit_log
        (audit_id, actor_user_id, created_at, channel_id, action, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "audit-a-1", "user-1", "2026-09-18T02:00:00.000Z", "kanal-a", "neu", "null", "{}",
      "audit-a-2", "user-1", "2026-09-18T01:00:00.000Z", "kanal-a", "alt", "{}", "{}",
    ).run();

    const sourceResponse = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/audit-log?limit=1"),
      environment,
    );
    const source = await sourceResponse.json<{ nextCursor: string | null }>();
    expect(sourceResponse.status).toBe(200);
    expect(source.nextCursor).toEqual(expect.any(String));

    const foreignResponses = await Promise.all([
      panelRouter.fetch(
        await makeRequest("user-1", "/api/channels/kanal-b/overview"),
        environment,
      ),
      panelRouter.fetch(
        await makeRequest("user-1", "/api/channels/kanal-b/system"),
        environment,
      ),
      panelRouter.fetch(
        await makeRequest(
          "user-1",
          `/api/channels/kanal-b/audit-log?limit=1&cursor=${encodeURIComponent(source.nextCursor ?? "")}`,
        ),
        environment,
      ),
    ]);

    expect(foreignResponses.map((response) => response.status)).toEqual([403, 403, 403]);
  });

  it("returns an authorized channel without a broadcaster connection in the list, overview, and system", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");

    const channelsResponse = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels"),
      environment,
    );
    const channels = await channelsResponse.json<{ channels: Array<{ channelId: string }> }>();
    const overviewResponse = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/overview"),
      environment,
    );
    const systemResponse = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/system"),
      environment,
    );

    expect(channelsResponse.status).toBe(200);
    expect(channels.channels).toEqual([
      expect.objectContaining({ channelId: "kanal-a", broadcasterConnection: "not_connected" }),
    ]);
    expect(overviewResponse.status).toBe(200);
    expect(systemResponse.status).toBe(200);
    const overview = await overviewResponse.json<{ broadcasterConnection: string }>();
    const system = await systemResponse.json<{ broadcasterConnection: string }>();
    expect(overview.broadcasterConnection).toBe("not_connected");
    expect(system.broadcasterConnection).toBe("not_connected");
  });

  it("exposes the stored stream state additively in channel overview", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await database.prepare(
      `INSERT INTO channel_stream_state (channel_id, state, changed_at, source)
       VALUES ('kanal-a', 'offline', '2026-09-23T08:00:00.000Z', 'eventsub')`,
    ).run();

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/overview"),
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      channelId: "kanal-a",
      streamState: "offline",
      activeModules: [],
    });
  });

  it("serves the overview before its background Helix lookup finishes (#178)", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertAppAccessToken(
      database,
      await encryptJson({ token: "app-token" }, parseKeyRing(environmentKeys.SESSION_ENCRYPTION_KEYS)),
      "2099-09-21T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
    );
    let resolveHelix: ((response: Response) => void) | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>((resolve) => { resolveHelix = resolve; }));
    vi.stubGlobal("fetch", fetcher);
    const runtime = makeStreamRefreshRuntime();

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/overview"),
      { ...environment, ...runtime, TWITCH_CLIENT_ID: "client-id", TWITCH_CLIENT_SECRET: "client-secret" },
      runtime.executionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ channelId: "kanal-a", streamState: null });
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(1); });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(requestedUrl(fetcher.mock.calls[0]?.[0])).toContain("/helix/streams?");
    resolveHelix?.(new Response(JSON.stringify({ data: [{ id: "live-1" }] }), { status: 200 }));
    await Promise.all(runtime.tasks);
    await expect(database.prepare(
      "SELECT state, source FROM channel_stream_state WHERE channel_id = 'kanal-a'",
    ).first()).resolves.toEqual({ state: "online", source: "helix" });
  });

  it("does not call Helix from the overview route when a fresh stream state row exists", async () => {
    const changedAt = new Date().toISOString();
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await database.prepare(
      `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, checked_at)
       VALUES ('kanal-a', 'offline', ?, 'eventsub', ?)`,
    ).bind(changedAt, changedAt).run();
    await insertStreamEventSubCoverage(database, "kanal-a");
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const runtime = makeStreamRefreshRuntime();

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/overview"),
      { ...environment, ...runtime },
      runtime.executionContext,
    );

    expect(response.status).toBe(200);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(response.clone().json()).resolves.toMatchObject({
      streamStateChangedAt: changedAt,
      streamStateCheckedAt: changedAt,
    });
    expect(runtime.channelObject.beginStreamStateRefresh).not.toHaveBeenCalled();
    expect(runtime.channelObject.endStreamStateRefresh).not.toHaveBeenCalled();
  });

  it("records a per-channel Twitch cooldown after a stream refresh is rate-limited", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertAppAccessToken(
      database,
      await encryptJson({ token: "app-token" }, parseKeyRing(environmentKeys.SESSION_ENCRYPTION_KEYS)),
      "2099-09-21T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
    );
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ message: "slow down" }), { status: 429 }));
    vi.stubGlobal("fetch", fetcher);
    const runtime = makeStreamRefreshRuntime();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    for (let view = 0; view < 2; view++) {
      const response = await panelRouter.fetch(
        await makeRequest("user-1", "/api/channels/kanal-a/overview"),
        { ...environment, ...runtime, TWITCH_CLIENT_ID: "client-id", TWITCH_CLIENT_SECRET: "client-secret" },
        runtime.executionContext,
      );
      expect(response.status).toBe(200);
      if (view === 0) await Promise.all(runtime.tasks);
    }

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(runtime.channelObject.setTwitchRateLimitRetryAfter).toHaveBeenCalledTimes(1);
    expect(runtime.channelObject.beginStreamStateRefresh).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith("Background stream-state refresh was rate-limited.", "kanal-a");
    warning.mockRestore();
  });

  it("serves stale stream state and refreshes it in the background", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T12:00:00.000Z"));
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await database.prepare(
      `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, started_at)
       VALUES ('kanal-a', 'online', '2026-09-23T11:49:00.000Z', 'helix', '2026-09-23T09:00:00.000Z')`,
    ).run();
    await insertAppAccessToken(
      database,
      await encryptJson({ token: "app-token" }, parseKeyRing(environmentKeys.SESSION_ENCRYPTION_KEYS)),
      "2099-09-21T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
    );
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetcher);
    const runtime = makeStreamRefreshRuntime();

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/overview"),
      { ...environment, ...runtime, TWITCH_CLIENT_ID: "client-id", TWITCH_CLIENT_SECRET: "client-secret" },
      runtime.executionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      channelId: "kanal-a",
      streamState: "online",
      streamStartedAt: "2026-09-23T09:00:00.000Z",
    });
    await Promise.all(runtime.tasks);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(requestedUrl(fetcher.mock.calls[0]?.[0])).toContain("/helix/streams?");
  });

  it("serves stored overview controls while Helix binds a pending pause in the background", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T12:00:00.000Z"));
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await database.prepare(
      `INSERT INTO channel_stream_state (channel_id, state, changed_at, source)
       VALUES ('kanal-a', 'offline', '2026-09-23T11:00:00.000Z', 'helix')`,
    ).run();
    await database.prepare(
      `INSERT INTO channel_controls
        (channel_id, paused, pause_until_stream_end, updated_at)
       VALUES ('kanal-a', 1, 1, '2026-09-23T11:30:00.000Z')`,
    ).run();
    await insertAppAccessToken(
      database,
      await encryptJson({ token: "app-token" }, parseKeyRing(environmentKeys.SESSION_ENCRYPTION_KEYS)),
      "2099-09-21T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
    );
    const startedAt = "2026-09-23T11:59:00.000Z";
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "live-1", started_at: startedAt }] }), { status: 200 }),
    ));
    const runtime = makeStreamRefreshRuntime();

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/overview"),
      { ...environment, ...runtime, TWITCH_CLIENT_ID: "client-id", TWITCH_CLIENT_SECRET: "client-secret" },
      runtime.executionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      streamState: "offline",
      streamStartedAt: null,
      controls: { pause: { active: false, pending: true, mode: "until_stream_end" } },
    });
    await Promise.all(runtime.tasks);
    await expect(database.prepare(
      "SELECT pause_stream_started_at FROM channel_controls WHERE channel_id = 'kanal-a'",
    ).first()).resolves.toEqual({ pause_stream_started_at: startedAt });
  });

  it("stores the real Helix stream start, not the check time, after the overview response (#178)", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertAppAccessToken(
      database,
      await encryptJson({ token: "app-token" }, parseKeyRing(environmentKeys.SESSION_ENCRYPTION_KEYS)),
      "2099-09-21T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
    );
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "live-1", started_at: "2026-09-20T10:00:00.000Z" }] }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetcher);
    const runtime = makeStreamRefreshRuntime();

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/overview"),
      { ...environment, ...runtime, TWITCH_CLIENT_ID: "client-id", TWITCH_CLIENT_SECRET: "client-secret" },
      runtime.executionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ channelId: "kanal-a", streamState: null });
    await Promise.all(runtime.tasks);
    await expect(database.prepare(
      "SELECT state, started_at FROM channel_stream_state WHERE channel_id = 'kanal-a'",
    ).first()).resolves.toEqual({ state: "online", started_at: "2026-09-20T10:00:00.000Z" });
  });

  it("returns the stored stream start for an EventSub-sourced online row, not its changed_at (#178)", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await database.prepare(
      `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, started_at)
       VALUES ('kanal-a', 'online', '2026-09-23T08:05:00.000Z', 'eventsub', '2026-09-23T08:00:00.000Z')`,
    ).run();
    await insertStreamEventSubCoverage(database, "kanal-a");

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/overview"),
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      channelId: "kanal-a",
      streamState: "online",
      streamStartedAt: "2026-09-23T08:00:00.000Z",
    });
  });

  it("shows an offline control as pending and hides a control bound to an older stream", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T10:00:00.000Z"));
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertStreamEventSubCoverage(database, "kanal-a");
    await database.prepare(
      `INSERT INTO channel_stream_state
        (channel_id, state, changed_at, source, checked_at, eventsub_changed_at)
       VALUES ('kanal-a', 'offline', '2026-09-23T10:00:00.000Z', 'eventsub', '2026-09-23T10:00:00.000Z', '2026-09-23T10:00:00.000Z')`,
    ).run();
    await database.prepare(
      `INSERT INTO channel_controls (channel_id, muted, mute_until_stream_end, updated_at)
       VALUES ('kanal-a', 1, 1, '2026-09-23T09:00:00.000Z')`,
    ).run();

    const pendingResponse = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/overview"),
      environment,
    );
    await expect(pendingResponse.json()).resolves.toMatchObject({
      streamState: "offline",
      controls: { mute: { active: false, pending: true, mode: "until_stream_end" } },
    });

    await database.prepare(
      `UPDATE channel_stream_state
          SET state = 'online', started_at = '2026-09-23T09:59:00.000Z',
              changed_at = '2026-09-23T10:00:00.000Z', checked_at = '2026-09-23T10:00:00.000Z',
              eventsub_changed_at = '2026-09-23T10:00:00.000Z'
        WHERE channel_id = 'kanal-a'`,
    ).run();
    await database.prepare(
      `UPDATE channel_controls SET mute_stream_started_at = '2026-09-23T09:00:00.000Z'
        WHERE channel_id = 'kanal-a'`,
    ).run();
    const restartedResponse = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/overview"),
      environment,
    );
    await expect(restartedResponse.json()).resolves.toMatchObject({
      streamState: "online",
      streamStartedAt: "2026-09-23T09:59:00.000Z",
      controls: { mute: { active: false, mode: null } },
    });
  });

  it("returns the stored scope state and all EventSub subscriptions in the system contract", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await database.prepare(
      `INSERT INTO bot_identity
        (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext, expires_at, created_at, updated_at)
       VALUES (1, 'bot-user', 'brobot', '[]', 'access', 'refresh', ?, ?, ?)`,
    ).bind("2099-09-19T00:00:00.000Z", "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
    await database.prepare(
      `UPDATE bot_identity SET missing_scopes_json = ? WHERE id = 1`,
    ).bind(JSON.stringify(["user:bot", "user:read:chat"])).run();
    await database.prepare(
      `INSERT INTO eventsub_subscriptions
        (channel_id, subscription_type, variant, version, subscription_id, secret_id, status, reason, error_message, error_status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "kanal-a", "channel.raid", "incoming", "1", "raid-in", "secret", "enabled", null, null, null, "2026-09-18T04:00:00.000Z",
      "kanal-a", "channel.raid", "outgoing", "1", "raid-out", null, "error", "missing_scope", "Scope fehlt", 403, "2026-09-18T03:00:00.000Z",
    ).run();

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/system"),
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      botPermissions: { missingScopes: ["user:bot", "user:read:chat"] },
      subscriptions: [
        { subscriptionType: "channel.raid", variant: "incoming", status: "enabled" },
        { subscriptionType: "channel.raid", variant: "outgoing", status: "error", message: "Scope fehlt", statusCode: 403 },
      ],
    });
  });

  it("returns missing broadcaster scopes from the worker only for flagged channels", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await database.prepare("UPDATE channels SET full_consent = 1 WHERE channel_id = ?").bind("kanal-a").run();
    await insertLoginIdentityAndSession(database, "user-1");
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:read:ads"]);
    await insertMember(database, "kanal-a", "user-1", "manager");

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/overview"),
      environment,
    );

    expect(response.status).toBe(200);
    const body = await response.json<{ broadcasterPermissions: { missingScopes: string[] } }>();
    expect(body.broadcasterPermissions.missingScopes).toEqual(
      expect.arrayContaining(listAllBroadcasterScopes().filter((scope) => scope !== "channel:read:ads")),
    );
  });

  it("returns only the channels with a membership row for the user", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertChannel(database, "kanal-b", "Beta");
    await insertChannel(database, "kanal-c", "Gamma");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertMember(database, "kanal-b", "user-2", "broadcaster");
    await insertMember(database, "kanal-c", "user-1", "operator");
    await insertBroadcasterConnection(database, "kanal-a");
    await insertBroadcasterConnection(database, "kanal-b");
    await insertBroadcasterConnection(database, "kanal-c");

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels"),
      environment,
    );
    const body = await response.json<{
      channels: Array<{ channelId: string; role: string }>;
      viewerIsBot: boolean;
      botLogin?: string;
    }>();

    expect(response.status).toBe(200);
    expect(body.channels).toEqual([
      expect.objectContaining({ channelId: "kanal-a", role: "manager" }),
      expect.objectContaining({ channelId: "kanal-c", role: "operator" }),
    ]);
    expect(body.viewerIsBot).toBe(false);
    expect(body).not.toHaveProperty("botLogin");
  });

  it("returns the bot login to platform admins and identifies bot-account viewers", async () => {
    await insertLoginIdentityAndSession(database, "4711");
    const adminResponse = await panelRouter.fetch(await makeRequest("4711", "/api/channels"), environment);
    const adminBody = await adminResponse.json<{ platformAdmin: boolean; viewerIsBot: boolean; botLogin?: string }>();

    expect(adminBody.platformAdmin).toBe(true);
    expect(adminBody.viewerIsBot).toBe(false);
    expect(adminBody.botLogin).toBe("brobot");

    await insertLoginIdentityAndSession(database, "bot-user");
    await database.prepare("UPDATE auth_sessions SET login = ? WHERE user_id = ?").bind("BROBOT", "bot-user").run();
    await insertBotIdentity(database);
    const botResponse = await panelRouter.fetch(await makeRequest("bot-user", "/api/channels"), environment);
    const botBody = await botResponse.json<{ platformAdmin: boolean; viewerIsBot: boolean; botLogin?: string }>();

    expect(botBody.platformAdmin).toBe(false);
    expect(botBody.viewerIsBot).toBe(true);
    expect(botBody.botLogin).toBe("brobot");
  });

  it("reports the installation's bot status even with zero released channels (#159)", async () => {
    await insertLoginIdentityAndSession(database, "user-1");
    await database.prepare(
      `INSERT INTO bot_identity_status (id, status, reason, updated_at)
       VALUES (1, 'revoked', 'authorization_revoked', ?)`,
    ).bind("2026-09-18T01:00:00.000Z").run();

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels"),
      environment,
    );
    const body = await response.json<{ channels: unknown[]; bot: { status: string; reason: string | null } | null }>();

    expect(response.status).toBe(200);
    expect(body.channels).toEqual([]);
    expect(body.bot).toEqual({ status: "revoked", reason: "authorization_revoked", updatedAt: "2026-09-18T01:00:00.000Z" });
  });

  it("reports a null bot status before the bot has ever signed in", async () => {
    await insertLoginIdentityAndSession(database, "user-1");

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels"),
      environment,
    );
    const body = await response.json<{ bot: unknown }>();

    expect(response.status).toBe(200);
    expect(body.bot).toBeNull();
  });

  it("checks channel:bot on the broadcaster identity of each channel", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertChannel(database, "kanal-b", "Beta");
    await insertLoginIdentityAndSession(database, "user-1", ["channel:bot"]);
    await insertLoginIdentityAndSession(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "kanal-b", ["channel:bot"]);
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertMember(database, "kanal-a", "kanal-a", "broadcaster");
    await insertMember(database, "kanal-b", "user-1", "manager");
    await insertMember(database, "kanal-b", "kanal-b", "broadcaster");

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels"),
      environment,
    );
    const body = await response.json<{ channels: Array<{ channelId: string; channelBotConsent: string }> }>();

    expect(response.status).toBe(200);
    expect(body.channels).toEqual([
      expect.objectContaining({ channelId: "kanal-a", channelBotConsent: "missing" }),
      expect.objectContaining({ channelId: "kanal-b", channelBotConsent: "granted" }),
    ]);
  });

  it("updates the consent after a renewed broadcaster login", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertLoginIdentityAndSession(database, "kanal-a");
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertMember(database, "kanal-a", "kanal-a", "broadcaster");

    const before = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/overview"),
      environment,
    );
    expect((await before.json<{ channelBotConsent: string }>()).channelBotConsent).toBe("missing");

    await database.prepare(
      "UPDATE twitch_login_identity SET scopes_json = ? WHERE user_id = ?",
    ).bind(JSON.stringify(["channel:bot"]), "kanal-a").run();

    const after = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/overview"),
      environment,
    );
    expect((await after.json<{ channelBotConsent: string }>()).channelBotConsent).toBe("granted");
  });

  it("shows a failed chat subscription in the channel state", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await database.prepare(
      `INSERT INTO eventsub_subscriptions
        (channel_id, subscription_type, subscription_id, secret_id, status, reason, error_message, error_status, updated_at)
       VALUES (?, 'channel.chat.message', ?, NULL, 'error', ?, ?, ?, ?)`,
    ).bind(
      "kanal-a",
      "subscription-1",
      "rate_limited",
      "Twitch ist überlastet.",
      429,
      "2026-09-18T04:00:00.000Z",
    ).run();

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/overview"),
      environment,
    );
    const body = await response.json<{
      chatSubscription: { status: string; subscriptionId: string | null; reason: string | null } | null;
      lastError: { source: string; reason: string; message: string | null; status: number | null; subscriptionType: string; subscriptionVariant: string } | null;
    }>();

    expect(response.status).toBe(200);
    expect(body.chatSubscription).toEqual({
      status: "error",
      subscriptionId: "subscription-1",
      reason: "rate_limited",
      updatedAt: "2026-09-18T04:00:00.000Z",
    });
    expect(body.lastError).toEqual({
      source: "eventsub",
      reason: "rate_limited",
      message: "Twitch ist überlastet.",
      status: 429,
      subscriptionType: "channel.chat.message",
      subscriptionVariant: "",
      at: "2026-09-18T04:00:00.000Z",
    });
  });

  it("also shows the moderation subscription's rejection as the last error", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await database.prepare(
      `INSERT INTO eventsub_subscriptions
        (channel_id, subscription_type, variant, version, subscription_id, secret_id, status, reason, error_message, error_status, updated_at)
       VALUES (?, 'channel.moderate', '', '2', NULL, NULL, 'error', ?, ?, ?, ?)`,
    ).bind(
      "kanal-a",
      "missing_scope",
      "Der Bot darf dieses Abo nicht anlegen.",
      403,
      "2026-09-18T05:00:00.000Z",
    ).run();

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/overview"),
      environment,
    );
    const body = await response.json<{ lastError: { source: string; reason: string; message: string | null; status: number | null; subscriptionType: string; subscriptionVariant: string; at: string } | null }>();

    expect(response.status).toBe(200);
    expect(body.lastError).toEqual({
      source: "eventsub",
      reason: "missing_scope",
      message: "Der Bot darf dieses Abo nicht anlegen.",
      status: 403,
      subscriptionType: "channel.moderate",
      subscriptionVariant: "",
      at: "2026-09-18T05:00:00.000Z",
    });
  });

  it("returns the actual channel state, active modules, and stored reasons", async () => {
    await insertChannel(database, "kanal-a", "Alpha");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");
    await insertBroadcasterConnection(database, "kanal-a");
    await database.prepare(
      `INSERT INTO bot_identity
        (id, user_id, login, scopes_json, access_token_ciphertext, refresh_token_ciphertext,
         expires_at, created_at, updated_at)
       VALUES (1, 'bot-1', 'brobot', '[]', 'access', 'refresh', ?, ?, ?)`,
    ).bind(
      "2026-09-19T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
    ).run();
    await database.prepare(
      `INSERT INTO bot_identity_status (id, status, reason, updated_at)
       VALUES (1, 'connected', NULL, ?)`,
    ).bind("2026-09-18T01:00:00.000Z").run();
    await database.prepare(
      `INSERT INTO bot_channel_status (channel_id, is_moderator, checked_at, reason)
       VALUES (?, 0, ?, ?)`,
    ).bind("kanal-a", "2026-09-18T02:00:00.000Z", "moderator_entfernt").run();
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES (?, ?, 1, ?), (?, ?, 0, ?)`,
    ).bind("kanal-a", "polls", '{"frage":"heute"}', "kanal-a", "clips", "{}" ).run();
    await database.prepare(
      `INSERT INTO audit_log
        (audit_id, actor_user_id, created_at, channel_id, action, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "audit-1", "user-1", "2026-09-18T03:00:00.000Z", "kanal-a", "member.updated", "{}", "{}",
      "audit-2", "user-1", "2026-09-18T02:00:00.000Z", "kanal-a", "member.added", "null", "{}",
    ).run();

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/overview"),
      environment,
    );
    const body = await response.json<{
      moderator: { isModerator: boolean; reason: string | null } | null;
      activeModules: Array<{ moduleId: string; settings: string }>;
      tokens: { botExpiresAt: string | null; loginStatus: string | null };
      lastError: { reason: string } | null;
    }>();

    expect(response.status).toBe(200);
    expect(body.moderator).toEqual({
      isModerator: false,
      checkedAt: "2026-09-18T02:00:00.000Z",
      reason: "moderator_entfernt",
    });
    expect(body.activeModules).toEqual([{ moduleId: "polls", settings: '{"frage":"heute"}' }]);
    expect(body.tokens).toEqual({
      botExpiresAt: "2026-09-19T00:00:00.000Z",
      loginStatus: "connected",
      loginReason: null,
      loginExpiresAt: "2099-09-19T00:00:00.000Z",
    });
    expect(body.lastError).toEqual({
      source: "moderator",
      reason: "moderator_entfernt",
      at: "2026-09-18T02:00:00.000Z",
    });
  });

  it("limits the audit log and paginates with the supplied cursor", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await database.prepare(
      `INSERT INTO audit_log
        (audit_id, actor_user_id, created_at, channel_id, action, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "audit-1", "user-1", "2026-09-18T03:00:00.000Z", "kanal-a", "neu", "null", "{}",
      "audit-2", "user-1", "2026-09-18T02:00:00.000Z", "kanal-a", "alt", "{}", "{}",
    ).run();

    const firstResponse = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/audit-log?limit=1"),
      environment,
    );
    const first = await firstResponse.json<{
      entries: Array<{ auditId: string; action: string }>;
      nextCursor: string | null;
    }>();

    expect(firstResponse.status).toBe(200);
    expect(first.entries).toEqual([{ auditId: "audit-1", actorUserId: "user-1", actorLogin: null, actorDisplayName: null, actorKind: "member", createdAt: "2026-09-18T03:00:00.000Z", moduleId: null, action: "neu", before: "null", after: "{}" }]);
    expect(first.nextCursor).toEqual(expect.any(String));

    const secondResponse = await panelRouter.fetch(
      await makeRequest("user-1", `/api/channels/kanal-a/audit-log?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? "")}`),
      environment,
    );
    const second = await secondResponse.json<{ entries: Array<{ auditId: string; action: string }>; nextCursor: string | null }>();

    expect(secondResponse.status).toBe(200);
    expect(second.entries).toEqual([{ auditId: "audit-2", actorUserId: "user-1", actorLogin: null, actorDisplayName: null, actorKind: "member", createdAt: "2026-09-18T02:00:00.000Z", moduleId: null, action: "alt", before: "{}", after: "{}" }]);
    expect(second.nextCursor).toBeNull();
  });

  it("resolves audit actors page by page in a single Twitch call and keeps unresolved ids", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await insertBotIdentity(database);
    await database.prepare(
      `INSERT INTO audit_log
        (audit_id, actor_user_id, created_at, channel_id, action, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "audit-actor", "auflösbar", "2026-09-18T04:00:00.000Z", "kanal-a", "neu", "{}", "{}",
      "audit-unknown", "gelöscht", "2026-09-18T03:00:00.000Z", "kanal-a", "alt", "{}", "{}",
    ).run();
    const twitch = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(url.pathname).toBe("/helix/users");
      expect(url.searchParams.getAll("id")).toEqual(["auflösbar", "gelöscht"]);
      return Promise.resolve(Response.json({ data: [{ id: "auflösbar", login: "alice", display_name: "Alice" }] }));
    });
    vi.stubGlobal("fetch", twitch);

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/audit-log"),
      environment,
    );
    const body = await response.json<{ entries: Array<Record<string, unknown>> }>();

    expect(response.status).toBe(200);
    expect(twitch).toHaveBeenCalledTimes(1);
    expect(body.entries).toEqual([
      expect.objectContaining({ actorUserId: "auflösbar", actorLogin: "alice", actorDisplayName: "Alice" }),
      expect.objectContaining({ actorUserId: "gelöscht", actorLogin: null, actorDisplayName: null }),
    ]);
  });

  it("resolves a member action's subject alongside the actor in the same Twitch call (#181)", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await insertBotIdentity(database);
    await database.prepare(
      `INSERT INTO audit_log
        (audit_id, actor_user_id, created_at, channel_id, action, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "audit-member",
      "user-1",
      "2026-09-18T04:00:00.000Z",
      "kanal-a",
      "member.added",
      "null",
      JSON.stringify({ channelId: "kanal-a", userId: "user-2", role: "operator", createdAt: "2026-09-18T04:00:00.000Z", updatedAt: "2026-09-18T04:00:00.000Z" }),
    ).run();
    const twitch = vi.fn((input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(url.searchParams.getAll("id").sort()).toEqual(["user-1", "user-2"]);
      return Promise.resolve(Response.json({ data: [
        { id: "user-1", login: "alice", display_name: "Alice" },
        { id: "user-2", login: "member_c", display_name: "member_c" },
      ] }));
    });
    vi.stubGlobal("fetch", twitch);

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/audit-log"),
      environment,
    );
    const body = await response.json<{ entries: Array<Record<string, unknown>> }>();

    expect(response.status).toBe(200);
    expect(twitch).toHaveBeenCalledTimes(1);
    expect(body.entries).toEqual([expect.objectContaining({
      actorLogin: "alice",
      actorDisplayName: "Alice",
      subjectUserId: "user-2",
      subjectLogin: "member_c",
      subjectDisplayName: "member_c",
    })]);
  });

  it("still sends the subject's raw id when the Twitch lookup can't resolve it (#181 review)", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await insertBotIdentity(database);
    await database.prepare(
      `INSERT INTO audit_log
        (audit_id, actor_user_id, created_at, channel_id, action, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "audit-member",
      "user-1",
      "2026-09-18T04:00:00.000Z",
      "kanal-a",
      "member.removed",
      JSON.stringify({ channelId: "kanal-a", userId: "gelöscht", role: "operator" }),
      "null",
    ).run();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ data: [{ id: "user-1", login: "alice", display_name: "Alice" }] }))));

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/audit-log"),
      environment,
    );
    const body = await response.json<{ entries: Array<Record<string, unknown>> }>();

    expect(response.status).toBe(200);
    expect(body.entries).toEqual([expect.objectContaining({
      subjectUserId: "gelöscht",
      subjectLogin: null,
      subjectDisplayName: null,
    })]);
  });

  it("filters the audit log by area and by person", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await database.prepare(
      `INSERT INTO audit_log
        (audit_id, actor_user_id, created_at, channel_id, action, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "audit-module", "user-1", "2026-09-18T04:00:00.000Z", "kanal-a", "module.enabled", "{}", "{}",
      "audit-member", "9002", "2026-09-18T03:00:00.000Z", "kanal-a", "member.added", "null", "{}",
    ).run();

    const areaResponse = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/audit-log?area=member"),
      environment,
    );
    const areaBody = await areaResponse.json<{ entries: Array<{ auditId: string }> }>();
    expect(areaResponse.status).toBe(200);
    expect(areaBody.entries.map((entry) => entry.auditId)).toEqual(["audit-member"]);

    const personResponse = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/audit-log?actor=9002"),
      environment,
    );
    const personBody = await personResponse.json<{ entries: Array<{ auditId: string }> }>();
    expect(personResponse.status).toBe(200);
    expect(personBody.entries.map((entry) => entry.auditId)).toEqual(["audit-member"]);

    const invalidAreaResponse = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/audit-log?area=bogus"),
      environment,
    );
    expect(invalidAreaResponse.status).toBe(400);
    expect(await invalidAreaResponse.json()).toEqual({ error: "audit_area_invalid" });
  });

  it("resolves a non-numeric person filter as a login before querying (#181 review)", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await insertDefaultAppAccessToken(database);
    await database.prepare(
      `INSERT INTO audit_log
        (audit_id, actor_user_id, created_at, channel_id, action, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      "audit-9002", "9002", "2026-09-18T04:00:00.000Z", "kanal-a", "module.enabled", "{}", "{}",
      "audit-1", "user-1", "2026-09-18T03:00:00.000Z", "kanal-a", "module.disabled", "{}", "{}",
    ).run();
    const twitch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      expect(url.searchParams.get("login")).toBe("member_c");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer app-access-token");
      return Promise.resolve(Response.json({ data: [{ id: "9002", login: "member_c", display_name: "member_c" }] }));
    });
    vi.stubGlobal("fetch", twitch);

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/audit-log?actor=%40member_c"),
      environment,
    );
    const body = await response.json<{ entries: Array<{ auditId: string }> }>();

    expect(response.status).toBe(200);
    expect(body.entries.map((entry) => entry.auditId)).toEqual(["audit-9002"]);
  });

  it("returns an empty page instead of an error for an unresolvable person login", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await insertDefaultAppAccessToken(database);
    await database.prepare(
      `INSERT INTO audit_log
        (audit_id, actor_user_id, created_at, channel_id, action, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind("audit-1", "user-1", "2026-09-18T04:00:00.000Z", "kanal-a", "module.enabled", "{}", "{}").run();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(Response.json({ data: [] }))));

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/audit-log?actor=no_such_login"),
      environment,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entries: [], nextCursor: null });
  });

  it("returns a Twitch search error when resolving a person login fails", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "operator");
    await insertDefaultAppAccessToken(database);
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("upstream unavailable", { status: 503 }))));

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/audit-log?actor=some_login"),
      environment,
    );

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "twitch_user_search_failed" });
  });
});

describe("manual moderator status check", () => {
  let database: TestD1Database;
  let environment: Env;

  beforeEach(async () => {
    database = new TestD1Database();
    environment = makeEnvironment(database);
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertBotIdentity(database);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T04:00:00.000Z"));
  });

  afterEach(() => {
    database.close();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("rejects an operator in the worker", async () => {
    await insertMember(database, "kanal-a", "user-1", "operator");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/moderator-status", "POST"),
      environment,
    );

    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a valid member of a foreign channel", async () => {
    await insertMember(database, "kanal-a", "user-1", "manager");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-b/moderator-status", "POST"),
      environment,
    );

    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a mutation without a CSRF token before the Twitch call", async () => {
    await insertMember(database, "kanal-a", "user-1", "manager");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/moderator-status", "POST", false),
      environment,
    );

    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("updates only the requested channel and triggers maintenance after moderator status is confirmed", async () => {
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertBotChannelStatus(database, "kanal-a", false, "2026-09-18T03:00:00.000Z", "moderator_entfernt");
    await insertBotChannelStatus(database, "kanal-b", false, "2026-09-18T03:00:00.000Z", "moderator_entfernt");
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ data: [{ broadcaster_id: "kanal-a" }] }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetcher);
    const maintenance = vi.spyOn(eventsubMaintenance, "maintainEventSubSubscriptions");

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/moderator-status", "POST"),
      environment,
    );
    const body = await response.json<{ moderator: { isModerator: boolean; checkedAt: string; reason: string | null } }>();
    const channelA = await database.prepare(
      "SELECT is_moderator, checked_at, reason FROM bot_channel_status WHERE channel_id = ?",
    ).bind("kanal-a").first<{ is_moderator: number; checked_at: string; reason: string | null }>();
    const channelB = await database.prepare(
      "SELECT is_moderator, checked_at, reason FROM bot_channel_status WHERE channel_id = ?",
    ).bind("kanal-b").first<{ is_moderator: number; checked_at: string; reason: string | null }>();

    expect(response.status).toBe(200);
    expect(body.moderator).toEqual({ isModerator: true, checkedAt: "2026-09-18T04:00:00.000Z", reason: null });
    expect(channelA).toEqual({ is_moderator: 1, checked_at: "2026-09-18T04:00:00.000Z", reason: null });
    expect(channelB).toEqual({ is_moderator: 0, checked_at: "2026-09-18T03:00:00.000Z", reason: "moderator_entfernt" });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://api.twitch.tv/helix/moderation/channels?user_id=bot-user&first=100&broadcaster_id=kanal-a",
    );
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes("oauth2/token"))).toBe(true);
    expect(fetcher.mock.calls.some((call) => String(call[0]).includes("channel-b"))).toBe(false);
    expect(maintenance).toHaveBeenCalledWith(environment, "2026-09-18T04:00:00.000Z", fetch, "kanal-a");
    maintenance.mockRestore();
  });

  it("rejects a check within the cooldown and states the earliest allowed time", async () => {
    await insertMember(database, "kanal-a", "user-1", "broadcaster");
    const fetcher = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ data: [{ broadcaster_id: "kanal-a" }] }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetcher);

    await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/moderator-status", "POST"),
      environment,
    );
    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/moderator-status", "POST"),
      environment,
    );
    const body = await response.json<{ error: string; nextAllowedAt: string }>();

    expect(response.status).toBe(429);
    expect(body.error).toBe("moderator_status_check_rate_limited");
    expect(body.nextAllowedAt).toBe("2026-09-18T04:05:00.000Z");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("atomically blocks a concurrent trigger for the same channel", async () => {
    await insertMember(database, "kanal-a", "user-1", "manager");
    let releaseTwitch!: (response: Response) => void;
    const twitchResponse = new Promise<Response>((resolve) => { releaseTwitch = (response) => { resolve(response); }; });
    const fetcher = vi.fn().mockReturnValue(twitchResponse);
    vi.stubGlobal("fetch", fetcher);

    const firstRequest = panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/moderator-status", "POST"),
      environment,
    );
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(1); });
    const secondResponse = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/moderator-status", "POST"),
      environment,
    );
    releaseTwitch(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    const firstResponse = await firstRequest;

    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(429);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("also honors a fresh check from the maintenance run", async () => {
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertBotChannelStatus(database, "kanal-a", true, "2026-09-18T03:57:00.000Z", null);
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/moderator-status", "POST"),
      environment,
    );
    const body = await response.json<{ nextAllowedAt: string }>();

    expect(response.status).toBe(429);
    expect(body.nextAllowedAt).toBe("2026-09-18T04:02:00.000Z");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("leaves the previous value unchanged on a Twitch error and returns the reason", async () => {
    await insertMember(database, "kanal-a", "user-1", "manager");
    await insertBotChannelStatus(database, "kanal-a", true, "2026-09-18T03:00:00.000Z", null);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: "Twitch ist vorübergehend nicht erreichbar." }),
      { status: 503 },
    )));

    const response = await panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/moderator-status", "POST"),
      environment,
    );
    const body = await response.json<{ error: string }>();
    const status = await database.prepare(
      "SELECT is_moderator, checked_at, reason FROM bot_channel_status WHERE channel_id = ?",
    ).bind("kanal-a").first<{ is_moderator: number; checked_at: string; reason: string | null }>();

    expect(response.status).toBe(502);
    expect(body.error).toBe("moderator_status_check_failed");
    expect(status).toEqual({ is_moderator: 1, checked_at: "2026-09-18T03:00:00.000Z", reason: null });
    expect(await database.prepare("SELECT * FROM bot_channel_status_check_locks WHERE channel_id = ?").bind("kanal-a").first()).toBeNull();
  });

  it("ends a hanging Twitch check after the timeout and cleans up only its own lock", async () => {
    await insertMember(database, "kanal-a", "user-1", "manager");
    const fetcher = vi.fn().mockReturnValue(new Promise<Response>(() => undefined));
    vi.stubGlobal("fetch", fetcher);

    const responsePromise = panelRouter.fetch(
      await makeRequest("user-1", "/api/channels/kanal-a/moderator-status", "POST"),
      environment,
    );
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(1); });
    await vi.advanceTimersByTimeAsync(5_000);
    const response = await responsePromise;
    const body = await response.json<{ error: string }>();

    expect(response.status).toBe(504);
    expect(body.error).toBe("moderator_status_check_failed");
    expect(await database.prepare("SELECT * FROM bot_channel_status_check_locks WHERE channel_id = ?").bind("kanal-a").first()).toBeNull();
  });
});
