import { afterEach, describe, expect, it, vi } from "vitest";

import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
import { faqTexts } from "../../src/modules/faq/panel/locale";
import { insertAppAccessToken, insertChannel, insertLoginIdentityAndSession, insertMember, testKey } from "./fixtures";
import { TestD1Database } from "./test-d1";

const keys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: testKey(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: testKey(2) }, retired: [] }),
};

const environmentFor = (database: TestD1Database): Env => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  ...keys,
} as unknown as Env);

const requestFor = async (
  userId: string,
  path: string,
  method: string,
  body: Record<string, unknown>,
): Promise<Request> => {
  const sessionId = `session-${userId}`;
  const cookie = await createSessionCookie({ sessionId }, keys.SESSION_COOKIE_KEYS, keys.SESSION_ENCRYPTION_KEYS);
  const csrf = await createCsrfToken(sessionId, keys.SESSION_COOKIE_KEYS, new Date().toISOString());
  return new Request(`https://brobot.example${path}`, {
    method,
    headers: {
      Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrf}`,
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
    },
    body: JSON.stringify(body),
  });
};

const insertFaqEntry = async (database: TestD1Database): Promise<void> => {
  await database.prepare(
    `INSERT INTO faq_entries
      (faq_id, channel_id, name, enabled, matcher_type, matcher_json, answer_block, cooldown_seconds,
       games_json, chat_target, sort_order, revision, last_used_at, created_at, updated_at)
     VALUES ('entry-1', 'channel-a', 'Greeting', 1, 'keywords', ?, 'sun', 30, '[]', 'source_only', 0, 1, NULL, ?, ?)`,
  ).bind(JSON.stringify({ type: "keywords", patterns: ["hello"] }), "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
};

const insertRestrictedFaqEntry = async (database: TestD1Database): Promise<void> => {
  await database.prepare(
    `INSERT INTO faq_entries
      (faq_id, channel_id, name, enabled, matcher_type, matcher_json, answer_block, cooldown_seconds,
       games_json, chat_target, sort_order, revision, last_used_at, created_at, updated_at)
     VALUES ('entry-2', 'channel-a', 'Boss fight', 1, 'keywords', ?, 'sun', 30, ?, 'source_only', 1, 1, NULL, ?, ?)`,
  ).bind(
    JSON.stringify({ type: "keywords", patterns: ["boss"] }),
    JSON.stringify([{ id: "77", name: "Elden Ring" }]),
    "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z",
  ).run();
};

describe("FAQ routes", () => {
  let database: TestD1Database;

  afterEach(() => { database.close(); vi.unstubAllGlobals(); });

  it("lets operators toggle an existing entry while keeping content edits restricted", async () => {
    database = new TestD1Database();
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "operator-1");
    await insertMember(database, "channel-a", "operator-1", "operator");
    await insertFaqEntry(database);

    const toggle = await panelRouter.fetch(
      await requestFor("operator-1", "/api/channels/channel-a/modules/faq/entries/entry-1/enabled", "PATCH", {
        enabled: false,
        revision: 1,
      }),
      environmentFor(database),
    );
    expect(toggle.status).toBe(200);
    await expect(database.prepare("SELECT enabled, revision FROM faq_entries WHERE faq_id = 'entry-1'")
      .first<{ enabled: number; revision: number }>()).resolves.toEqual({ enabled: 0, revision: 2 });

    const edit = await panelRouter.fetch(
      await requestFor("operator-1", "/api/channels/channel-a/modules/faq/entries/entry-1", "PATCH", {
        name: "Changed",
        matcher: { type: "keywords", patterns: ["hello"] },
        answerBlock: "sun",
        cooldownSeconds: 30,
        games: [],
        chatTarget: "source_only",
        revision: 2,
      }),
      environmentFor(database),
    );
    expect(edit.status).toBe(403);
  });

  it("returns a dedicated validation error below the minimum cooldown", async () => {
    database = new TestD1Database();
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-1");
    await insertMember(database, "channel-a", "manager-1", "manager");

    const response = await panelRouter.fetch(
      await requestFor("manager-1", "/api/channels/channel-a/modules/faq/entries", "POST", { cooldownSeconds: 0 }),
      environmentFor(database),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "faq_cooldown_too_short" });
    expect(faqTexts("de").cooldownMinError).toBe("Die Abkühlzeit muss mindestens 30 Sekunden betragen.");
    expect(faqTexts("en").cooldownMinError).toBe("Cooldown must be at least 30 seconds.");
  });

  it("defaults the tester to the channel's live game and explains a skipped restricted entry", async () => {
    database = new TestD1Database();
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-1");
    await insertMember(database, "channel-a", "manager-1", "manager");
    await insertRestrictedFaqEntry(database);
    await insertAppAccessToken(
      database,
      await encryptJson({ token: "app-token" }, parseKeyRing(keys.SESSION_ENCRYPTION_KEYS)),
      "2099-09-21T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
      "2026-09-18T00:00:00.000Z",
    );
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [{ game_id: "999", game_name: "Some Other Game", title: "Live" }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(
      await requestFor("manager-1", "/api/channels/channel-a/modules/faq/test", "POST", { message: "watch the boss" }),
      environmentFor(database),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      matches: false,
      reason: "no_match",
      gameId: "999",
      skippedByGame: [{ entryId: "entry-2", entryName: "Boss fight", matchedPattern: "boss", games: ["Elden Ring"] }],
    });
  });

  it("lets an explicit simulated game override the live lookup", async () => {
    database = new TestD1Database();
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-1");
    await insertMember(database, "channel-a", "manager-1", "manager");
    await insertRestrictedFaqEntry(database);
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error("network disabled in tests"));
    vi.stubGlobal("fetch", fetcher);

    const response = await panelRouter.fetch(
      await requestFor("manager-1", "/api/channels/channel-a/modules/faq/test", "POST", { message: "watch the boss", gameId: "77" }),
      environmentFor(database),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      matches: true,
      reason: "matched",
      gameId: "77",
      entry: { id: "entry-2", name: "Boss fight" },
      matchedPattern: "boss",
      skippedByGame: [],
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
