import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { insertAppAccessToken, insertChannel, insertLoginIdentityAndSession, insertMember, testKey as key } from "./fixtures";
import { TestD1Database } from "./test-d1";
import { getAdSchedule } from "../../src/modules/ads/adapters/ad-schedule";
import { getAppAccessToken } from "../../src/worker/app-token";
import { helixRequest } from "../../src/worker/twitch/helix";
import type { AdsSchedule } from "../../src/modules/ads/contracts";

const environmentKeys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
};

const tokenKeys = JSON.stringify({
  active: { id: "schedule-key", key: Buffer.from(new Uint8Array(32).fill(8)).toString("base64url") },
  retired: [],
});

const environmentFor = (
  database: TestD1Database,
  schedule: () => void,
  clear: () => void,
  initialCache: { schedule: AdsSchedule; asOf: string } | null = null,
): Env => {
  let cache = initialCache;
  type RefreshResult = {
    cache: typeof cache;
    reason: string | null;
    detail: Readonly<Record<string, string | number | boolean | null>>;
    d1Ms: number;
    helixMs: number;
    changed: boolean;
  };
  let refresh: Promise<RefreshResult> | null = null;
  const save = (next: AdsSchedule, asOf: string): boolean => {
    const changed = cache === null || JSON.stringify(cache.schedule) !== JSON.stringify(next);
    cache = { schedule: next, asOf };
    if (changed) schedule();
    return changed;
  };
  const object = {
    getCachedAdSchedule: () => Promise.resolve(cache),
    refreshAdSchedule: () => {
      if (refresh !== null) return refresh;
      refresh = (async () => {
        const startedAt = performance.now();
        const result = await getAdSchedule(
          { DB: database as unknown as D1Database, TWITCH_CLIENT_ID: "client-id", TWITCH_CLIENT_SECRET: "client-secret", TOKEN_ENCRYPTION_KEYS: tokenKeys, ...environmentKeys } as Env,
          "kanal-a",
          new Date().toISOString(),
          getAppAccessToken,
          helixRequest,
          fetch,
        );
        const helixMs = performance.now() - startedAt;
        if (!result.fetched || result.schedule === null) return { cache, reason: result.reason, detail: result.detail, d1Ms: 0, helixMs, changed: false };
        const asOf = new Date().toISOString();
        const changed = save(result.schedule, asOf);
        return { cache, reason: null, detail: result.detail, d1Ms: 0, helixMs, changed };
      })().finally(() => { refresh = null; });
      return refresh;
    },
    storeAdSchedule: (next: AdsSchedule, asOf: string) => {
      save(next, asOf);
      return Promise.resolve({ schedule: next, asOf });
    },
    scheduleAdPrewarning: () => { schedule(); return Promise.resolve(); },
    clearAdPrewarning: () => { clear(); return Promise.resolve(); },
  };
  return {
    DB: database as unknown as D1Database,
    TWITCH_CLIENT_ID: "client-id",
    TWITCH_CLIENT_SECRET: "client-secret",
    TOKEN_ENCRYPTION_KEYS: tokenKeys,
    ...environmentKeys,
    CHANNEL: {
      idFromName: (channelId: string) => channelId,
      get: () => object,
    } as unknown as Env["CHANNEL"],
  } as unknown as Env;
};

const requestFor = async (
  userId: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<Request> => {
  const sessionId = `session-${userId}`;
  const cookie = await createSessionCookie(
    { sessionId },
    environmentKeys.SESSION_COOKIE_KEYS,
    tokenKeys,
  );
  const csrf = await createCsrfToken(sessionId, environmentKeys.SESSION_COOKIE_KEYS, new Date().toISOString());
  return new Request(`https://brobot.example${path}`, {
    method,
    headers: {
      Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrf}`,
      "X-CSRF-Token": csrf,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
};

const scheduleBody = (nextAdAt: string | null = "2026-09-21T12:05:00Z"): string => JSON.stringify({
  data: [{
    next_ad_at: nextAdAt,
    duration: 60,
    last_ad_at: "2026-09-21T11:00:00Z",
    preroll_free_time: 120,
    snooze_count: 1,
    snooze_refresh_at: "2026-09-21T11:30:00Z",
  }],
});

describe("ad routes", () => {
  let database: TestD1Database;
  let appTokenCiphertext: string;
  let schedule: ReturnType<typeof vi.fn>;
  let clear: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    database = new TestD1Database();
    appTokenCiphertext = await encryptJson({ token: "app-token" }, parseKeyRing(tokenKeys));
    await insertAppAccessToken(
      database,
      appTokenCiphertext,
      "2099-09-21T00:00:00.000Z",
      "2026-09-20T00:00:00.000Z",
      "2026-09-20T00:00:00.000Z",
    );
    schedule = vi.fn<() => void>();
    clear = vi.fn<() => void>();
  });

  afterEach(() => {
    database.close();
    vi.unstubAllGlobals();
  });

  const setup = async (
    role: "broadcaster" | "manager" | "operator",
    scopes: string[] = ["channel:read:ads", "channel:manage:ads"],
    initialCache: { schedule: AdsSchedule; asOf: string } | null = null,
  ): Promise<Env> => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "kanal-a", scopes);
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", role);
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('kanal-a', 'ads', 1, '{"automatic":"auto","manual":"manuell","prewarning":true,"leadSeconds":60,"prewarningText":"gleich {seconds}"}')`,
    ).run();
    return environmentFor(database, schedule as unknown as () => void, clear as unknown as () => void, initialCache);
  };

  it("lets an operator snooze and writes the outcome to the event log", async () => {
    const environment = await setup("operator");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(scheduleBody(), { status: 200 })));

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/ads/snooze", "POST"),
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ schedule: { nextAdAt: "2026-09-21T12:05:00Z", snoozeCount: 1 } });
    await expect(database.prepare(
      "SELECT code, actor_user_id FROM event_log WHERE channel_id = 'kanal-a'",
    ).first()).resolves.toEqual({ code: "ads.snooze", actor_user_id: "user-1" });
    expect(schedule).toHaveBeenCalled();
  });

  it("keeps Twitch's own message under the API's message key on a failed snooze (issue #201 follow-up)", async () => {
    const environment = await setup("operator");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ message: "slow down" }),
      { status: 429 },
    )));

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/ads/snooze", "POST"),
      environment,
    );

    expect(response.status).toBe(429);
    await expect(database.prepare(
      "SELECT code FROM event_log WHERE channel_id = 'kanal-a'",
    ).first()).resolves.toEqual({ code: "ads.snooze" });
    // The event-log diagnostic carries this same message under
    // `twitchMessage`, but the API error response has always used `message`.
    const body = await response.json<{ error: string; reason: string; detail: Record<string, unknown> }>();
    expect(body).toMatchObject({ error: "ad_snooze_failed", reason: "rate_limited" });
    expect(body.detail.message).toBe("slow down");
    expect(body.detail.twitchMessage).toBeUndefined();
  });

  it("separates snooze operation from the managing settings threshold", async () => {
    const environment = await setup("operator");
    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/ads/settings", "PATCH"),
      environment,
    );

    expect(response.status).toBe(403);
  });

  it("returns non-blocking template warnings and enforces the 500-character setting limit", async () => {
    const environment = await setup("manager");
    const settings = {
      automatic: "Hello {viewer}",
      manual: "x".repeat(500),
      prewarning: true,
      leadSeconds: 60,
      prewarningText: "Ad in {seconds}",
    };

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/ads/settings", "PATCH", { revision: 1, settings }),
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      warnings: [
        { field: "automatic", code: "unknown_template_variables", unknownVariables: ["viewer"] },
        { field: "manual", code: "template_worst_case_too_long", worstCaseLength: 515 },
      ],
    });

    const oversized = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/ads/settings", "PATCH", {
        revision: 1,
        settings: { ...settings, automatic: "x".repeat(501) },
      }),
      environment,
    );
    expect(oversized.status).toBe(400);
  });

  it("re-arms the prewarning alarm on a successful schedule fetch and writes no event", async () => {
    const environment = await setup("operator");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(scheduleBody("2026-09-21T12:00:00Z"), { status: 200 })));

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/ads/schedule"),
      environment,
    );

    expect(response.status).toBe(200);
    expect(schedule).toHaveBeenCalledWith();
    await expect(database.prepare("SELECT COUNT(*) AS count FROM event_log").first()).resolves.toEqual({ count: 0 });
  });

  it("serves a fresh cached schedule without calling Helix", async () => {
    const cached = {
      schedule: { nextAdAt: "2026-09-24T18:00:00.000Z", duration: 60, lastAdAt: null, prerollFreeTime: 120, snoozeCount: 1, snoozeRefreshAt: null },
      asOf: new Date().toISOString(),
    } satisfies { schedule: AdsSchedule; asOf: string };
    const environment = await setup("operator", ["channel:read:ads", "channel:manage:ads"], cached);
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/ads/schedule"),
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ...cached, snoozeScopeAvailable: true });
    expect(fetcher).not.toHaveBeenCalled();
    expect(schedule).not.toHaveBeenCalled();
  });

  it("coalesces stale schedule refreshes and serves the last good value while they run", async () => {
    const cached = {
      schedule: { nextAdAt: "2026-09-24T18:00:00.000Z", duration: 60, lastAdAt: null, prerollFreeTime: 120, snoozeCount: 1, snoozeRefreshAt: null },
      asOf: new Date(Date.now() - 61_000).toISOString(),
    } satisfies { schedule: AdsSchedule; asOf: string };
    const environment = await setup("operator", ["channel:read:ads", "channel:manage:ads"], cached);
    let resolveHelix: ((response: Response) => void) | undefined;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise<Response>((resolve) => { resolveHelix = resolve; }));
    vi.stubGlobal("fetch", fetcher);
    const tasks: Promise<unknown>[] = [];
    const executionContext = {
      waitUntil: (promise: Promise<unknown>) => { tasks.push(promise); },
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext;
    const request = () => requestFor("user-1", "/api/channels/kanal-a/modules/ads/schedule");

    const [left, right] = await Promise.all([
      request().then((input) => panelRouter.fetch(input, environment, executionContext)),
      request().then((input) => panelRouter.fetch(input, environment, executionContext)),
    ]);
    expect(left.status).toBe(200);
    expect(right.status).toBe(200);
    await expect(left.json()).resolves.toMatchObject(cached);
    await expect(right.json()).resolves.toMatchObject(cached);
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(1); });
    expect(tasks).toHaveLength(2);
    resolveHelix?.(new Response(scheduleBody("2026-09-24T18:30:00.000Z"), { status: 200 }));
    await Promise.all(tasks);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  it("keeps the cached schedule and as-of time when a stale refresh is rate-limited", async () => {
    const cached = {
      schedule: { nextAdAt: "2026-09-24T18:00:00.000Z", duration: 60, lastAdAt: null, prerollFreeTime: 120, snoozeCount: 1, snoozeRefreshAt: null },
      asOf: new Date(Date.now() - 61_000).toISOString(),
    } satisfies { schedule: AdsSchedule; asOf: string };
    const environment = await setup("operator", ["channel:read:ads", "channel:manage:ads"], cached);
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ message: "slow down" }), { status: 429 })));
    const tasks: Promise<unknown>[] = [];
    const executionContext = {
      waitUntil: (promise: Promise<unknown>) => { tasks.push(promise); },
      passThroughOnException: () => undefined,
    } as unknown as ExecutionContext;

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/ads/schedule"),
      environment,
      executionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject(cached);
    await Promise.all(tasks);
    expect(schedule).not.toHaveBeenCalled();
  });

  it("keeps schedule-read failures out of D1 diagnostics", async () => {
    const environment = await setup("operator");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ message: "Twitch nicht erreichbar" }),
      { status: 429 },
    )));

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/ads/schedule"),
      environment,
    );

    expect(response.status).toBe(429);
    await expect(database.prepare("SELECT COUNT(*) AS count FROM event_log WHERE channel_id = 'kanal-a'").first())
      .resolves.toEqual({ count: 0 });
    const body = await response.json<{ detail: Record<string, unknown> }>();
    expect(body.detail.message).toBe("Twitch nicht erreichbar");
    expect(body.detail.twitchMessage).toBeUndefined();
  });

  it("handles an empty successful schedule without an event", async () => {
    const environment = await setup("operator");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(scheduleBody(null), { status: 200 })));

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/ads/schedule"),
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ schedule: { nextAdAt: null } });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM event_log").first()).resolves.toEqual({ count: 0 });
  });
});

describe("start commercial", () => {
  let database: TestD1Database;
  let schedule: ReturnType<typeof vi.fn>;
  let clear: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    database = new TestD1Database();
    await insertAppAccessToken(
      database,
      await encryptJson({ token: "app-token" }, parseKeyRing(tokenKeys)),
      "2099-09-21T00:00:00.000Z",
      "2026-09-20T00:00:00.000Z",
      "2026-09-20T00:00:00.000Z",
    );
    schedule = vi.fn<() => void>();
    clear = vi.fn<() => void>();
  });

  afterEach(() => {
    database.close();
    vi.unstubAllGlobals();
  });

  const setup = async (role: "broadcaster" | "manager" | "operator", scopes: string[] = ["channel:edit:commercial"]): Promise<Env> => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "kanal-a", scopes);
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", role);
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
       VALUES ('kanal-a', 'ads', 1, '{"automatic":"auto","manual":"manuell","prewarning":true,"leadSeconds":60,"prewarningText":"gleich {seconds}"}')`,
    ).run();
    return environmentFor(database, schedule as unknown as () => void, clear as unknown as () => void);
  };

  // "Betrieblich" per 0006: an immediate action open to every channel role,
  // the same as ads snooze -- an operator may run it without escalation.
  it("lets an operator start a commercial and writes an audit entry", async () => {
    const environment = await setup("operator");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ data: [{ length: 90, message: "", retry_after: 480 }] }),
      { status: 200 },
    )));

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/ads/commercial", "POST", { length: 90 }),
      environment,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ length: 90, message: null, retryAfter: 480 });
    await expect(database.prepare(
      "SELECT action, module_id FROM audit_log WHERE channel_id = 'kanal-a'",
    ).first()).resolves.toEqual({ action: "ads.commercial_started", module_id: "ads" });
  });

  it("reports a missing channel:edit:commercial scope without calling Twitch", async () => {
    const environment = await setup("operator", []);
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/ads/commercial", "POST", { length: 90 }),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "commercial_start_failed", reason: "scope_missing" });
    expect(fetcher).not.toHaveBeenCalled();
    await expect(database.prepare("SELECT COUNT(*) AS count FROM event_log WHERE channel_id = 'kanal-a'").first())
      .resolves.toEqual({ count: 1 });
  });

  it("reports Twitch's rate limit as its own outcome", async () => {
    const environment = await setup("manager");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ message: "slow down" }),
      { status: 429 },
    )));

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/ads/commercial", "POST", { length: 90 }),
      environment,
    );

    expect(response.status).toBe(429);
    // Issue #201 follow-up: the event-log diagnostic carries this same
    // message under `twitchMessage` (provenance for the dashboard popover),
    // but the API error response has always used `message`.
    const body = await response.json<{ error: string; reason: string; detail: Record<string, unknown> }>();
    expect(body).toMatchObject({ error: "commercial_start_failed", reason: "rate_limited" });
    expect(body.detail.message).toBe("slow down");
    expect(body.detail.twitchMessage).toBeUndefined();
  });

  it("maps Twitch's offline rejection to a closed error and diagnostic reason", async () => {
    const environment = await setup("manager");
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ message: "The broadcaster must be live to start a commercial." }),
      { status: 400 },
    )));

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/ads/commercial", "POST", { length: 90 }),
      environment,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "commercial_stream_offline", reason: "stream_offline" });
    const diagnostic = await database.prepare(
      "SELECT code, detail_json FROM event_log WHERE channel_id = 'kanal-a'",
    ).first<{ code: string; detail_json: string }>();
    expect(diagnostic?.code).toBe("ads.commercial.failed");
    expect(JSON.parse(diagnostic?.detail_json ?? "{}") as unknown).toMatchObject({
      outcome: "failed",
      reason: "stream_offline",
      status: 400,
      twitchMessage: "The broadcaster must be live to start a commercial.",
    });
  });

  it("rejects an invalid length before calling Twitch", async () => {
    const environment = await setup("operator");
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/ads/commercial", "POST", { length: 45 }),
      environment,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "commercial_length_invalid" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a request from someone who isn't a channel member", async () => {
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:edit:commercial"]);
    await insertLoginIdentityAndSession(database, "outsider");
    const environment = environmentFor(database, schedule as unknown as () => void, clear as unknown as () => void);
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(
      await requestFor("outsider", "/api/channels/kanal-a/modules/ads/commercial", "POST", { length: 90 }),
      environment,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "channel_access_denied" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
