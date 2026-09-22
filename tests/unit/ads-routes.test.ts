import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { insertAppAccessToken, insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

const key = (byte: number): string => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
  .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

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
): Env => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  TOKEN_ENCRYPTION_KEYS: tokenKeys,
  ...environmentKeys,
  CHANNEL: {
    idFromName: (channelId: string) => channelId,
    get: () => ({
      scheduleAdPrewarning: () => { schedule(); return Promise.resolve(); },
      clearAdPrewarning: () => { clear(); return Promise.resolve(); },
    }),
  } as unknown as Env["CHANNEL"],
} as unknown as Env);

const requestFor = async (
  userId: string,
  path: string,
  method = "GET",
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
    },
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

  const setup = async (role: "broadcaster" | "manager" | "operator", scopes: string[] = ["channel:read:ads", "channel:manage:ads"]): Promise<Env> => {
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

  it("separates snooze operation from the managing settings threshold", async () => {
    const environment = await setup("operator");
    const response = await panelRouter.fetch(
      await requestFor("user-1", "/api/channels/kanal-a/modules/ads/settings", "PATCH"),
      environment,
    );

    expect(response.status).toBe(403);
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

  it("logs a failed schedule fetch", async () => {
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
    await expect(database.prepare(
      "SELECT code FROM event_log WHERE channel_id = 'kanal-a'",
    ).first()).resolves.toEqual({ code: "ads.vorwarnung.zeitplan_fehler" });
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
