import { afterEach, describe, expect, it, vi } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
import { faqTexts } from "../../src/modules/faq/panel/locale";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey } from "./fixtures";
import { createReadInterleavingDatabase, TestD1Database } from "./test-d1";

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
      (faq_id, channel_id, name, enabled, matcher_type, matcher_json, answer_text, cooldown_seconds,
       games_json, chat_target, sort_order, revision, last_used_at, created_at, updated_at)
     VALUES ('entry-1', 'channel-a', 'Greeting', 1, 'keywords', ?, 'sun', 30, '[]', 'source_only', 0, 1, NULL, ?, ?)`,
  ).bind(JSON.stringify({ type: "keywords", patterns: ["hello"] }), "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z").run();
};

const insertRestrictedFaqEntry = async (database: TestD1Database): Promise<void> => {
  await database.prepare(
    `INSERT INTO faq_entries
      (faq_id, channel_id, name, enabled, matcher_type, matcher_json, answer_text, cooldown_seconds,
       games_json, chat_target, sort_order, revision, last_used_at, created_at, updated_at)
     VALUES ('entry-2', 'channel-a', 'Boss fight', 1, 'keywords', ?, 'sun', 30, ?, 'source_only', 1, 1, NULL, ?, ?)`,
  ).bind(
    JSON.stringify({ type: "keywords", patterns: ["boss"] }),
    JSON.stringify([{ id: "77", name: "Elden Ring" }]),
    "2026-09-18T00:00:00.000Z", "2026-09-18T00:00:00.000Z",
  ).run();
};

it("provides German copy for the template variable picker", () => {
  expect(faqTexts("de").templateMessages.picker).toEqual(expect.objectContaining({
    title: "Variable auswählen",
    noResults: "Keine Variablen gefunden.",
    groupLabels: { module: "Dieses Modul", channel: "Kanal", own: "Eigene Variablen", text_blocks: "Textbausteine" },
    keyHints: { navigate: "auswählen", insert: "einfügen", close: "schließen" },
  }));
});

describe("FAQ routes", () => {
  let database: TestD1Database;

  afterEach(() => { database.close(); vi.unstubAllGlobals(); });

  it("accepts the host viewers token when raid also declares an unavailable local viewers variable", async () => {
    database = new TestD1Database();
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-1");
    await insertMember(database, "channel-a", "manager-1", "manager");
    await database.prepare("INSERT INTO text_library_settings (channel_id, graph_revision, updated_at) VALUES ('channel-a', 1, '2026-09-18T00:00:00.000Z')").run();

    const response = await panelRouter.fetch(
      await requestFor("manager-1", "/api/channels/channel-a/modules/faq/entries", "POST", {
        name: "Viewers",
        enabled: false,
        matcher: { type: "keywords", patterns: ["viewers"] },
        answerText: "We have {viewers} viewers",
        minimumTier: "moderator",
        cooldownSeconds: 30,
        games: [],
        chatTarget: "source_only",
      }),
      environmentFor(database),
    );

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ entry: {
      answerText: "We have {viewers} viewers", enabled: false, minimumTier: "moderator",
    } });
  });

  it("rejects an FAQ save when its validated block is deleted before the SQL write", async () => {
    database = new TestD1Database();
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-1");
    await insertMember(database, "channel-a", "manager-1", "manager");
    await database.prepare("INSERT INTO text_library_settings (channel_id, graph_revision, updated_at) VALUES ('channel-a', 1, '2026-09-18T00:00:00.000Z')").run();
    await database.prepare("INSERT INTO text_library_categories (channel_id, category_id, created_at, updated_at) VALUES ('channel-a', 'social', '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z')").run();
    await database.prepare("INSERT INTO text_blocks (channel_id, block_name, category_id, revision, created_at, updated_at) VALUES ('channel-a', 'welcome', 'social', 1, '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z')").run();
    await database.prepare("INSERT INTO text_block_variants (channel_id, block_name, variant_id, position, conditions_json, texts_json) VALUES ('channel-a', 'welcome', 'default', 0, '{}', '[\"Welcome\"]')").run();
    const interleavedDatabase = createReadInterleavingDatabase(
      database,
      (sql) => sql.includes("SELECT variant.texts_json"),
      async () => {
        await database.batch([
          database.prepare("UPDATE text_library_settings SET graph_revision = graph_revision + 1 WHERE channel_id = 'channel-a'"),
          database.prepare("DELETE FROM text_blocks WHERE channel_id = 'channel-a' AND block_name = 'welcome'"),
        ]);
      },
    );

    const response = await panelRouter.fetch(
      await requestFor("manager-1", "/api/channels/channel-a/modules/faq/entries", "POST", {
        name: "Greeting",
        matcher: { type: "keywords", patterns: ["hello"] },
        answerText: "{text.welcome}",
        cooldownSeconds: 30,
        games: [],
        chatTarget: "source_only",
      }),
      environmentFor(interleavedDatabase as unknown as TestD1Database),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "faq_entry_conflict" });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM faq_entries WHERE channel_id = 'channel-a'").first<{ count: number }>())
      .resolves.toEqual({ count: 0 });
  });

  it("rejects a module-settings save when a referenced block is deleted before the SQL write", async () => {
    database = new TestD1Database();
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-1");
    await insertMember(database, "channel-a", "manager-1", "manager");
    await database.prepare("INSERT INTO text_library_settings (channel_id, graph_revision, updated_at) VALUES ('channel-a', 1, '2026-09-18T00:00:00.000Z')").run();
    await database.prepare("INSERT INTO text_library_categories (channel_id, category_id, created_at, updated_at) VALUES ('channel-a', 'social', '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z')").run();
    await database.prepare("INSERT INTO text_blocks (channel_id, block_name, category_id, revision, created_at, updated_at) VALUES ('channel-a', 'welcome', 'social', 1, '2026-09-18T00:00:00.000Z', '2026-09-18T00:00:00.000Z')").run();
    await database.prepare("INSERT INTO text_block_variants (channel_id, block_name, variant_id, position, conditions_json, texts_json) VALUES ('channel-a', 'welcome', 'default', 0, '{}', '[\"Welcome\"]')").run();
    await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('channel-a', 'ads', 1, '{\"automatic\":\"Before\",\"manual\":\"Manual\"}')").run();
    const interleavedDatabase = createReadInterleavingDatabase(
      database,
      (sql) => sql.includes("FROM text_blocks AS block"),
      async () => {
        await database.batch([
          database.prepare("UPDATE text_library_settings SET graph_revision = graph_revision + 1 WHERE channel_id = 'channel-a'"),
          database.prepare("DELETE FROM text_blocks WHERE channel_id = 'channel-a' AND block_name = 'welcome'"),
        ]);
      },
    );

    const response = await panelRouter.fetch(
      await requestFor("manager-1", "/api/channels/channel-a/modules/ads/settings", "PATCH", {
        revision: 1,
        settings: { automatic: "{text.welcome}", manual: "Manual" },
      }),
      environmentFor(interleavedDatabase as unknown as TestD1Database),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "module_settings_changed_concurrently" });
    await expect(database.prepare("SELECT settings, revision FROM channel_modules WHERE channel_id = 'channel-a' AND module_id = 'ads'").first())
      .resolves.toEqual({ settings: '{"automatic":"Before","manual":"Manual"}', revision: 1 });
  });

  it("keeps entry edits and priority ordering restricted to managers", async () => {
    database = new TestD1Database();
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "operator-1");
    await insertMember(database, "channel-a", "operator-1", "operator");
    await insertFaqEntry(database);

    const edit = await panelRouter.fetch(
      await requestFor("operator-1", "/api/channels/channel-a/modules/faq/entries/entry-1", "PATCH", {
        name: "Changed",
        enabled: false,
        matcher: { type: "keywords", patterns: ["hello"] },
        answerText: "Sunset is at {sun.set}",
        minimumTier: "moderator",
        cooldownSeconds: 30,
        games: [],
        chatTarget: "source_only",
        revision: 1,
      }),
      environmentFor(database),
    );
    expect(edit.status).toBe(403);

    const reorder = await panelRouter.fetch(
      await requestFor("operator-1", "/api/channels/channel-a/modules/faq/entries/order", "POST", {
        order: [{ id: "entry-1", revision: 1 }],
      }),
      environmentFor(database),
    );
    expect(reorder.status).toBe(403);
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

  it("validates RE2 patterns on save and returns the pattern field with a reason", async () => {
    database = new TestD1Database();
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-1");
    await insertMember(database, "channel-a", "manager-1", "manager");
    await database.prepare("INSERT INTO text_library_settings (channel_id, graph_revision, updated_at) VALUES ('channel-a', 1, '2026-09-18T00:00:00.000Z')").run();

    const invalid = await panelRouter.fetch(
      await requestFor("manager-1", "/api/channels/channel-a/modules/faq/entries", "POST", {
        name: "Lookahead",
        matcher: { type: "regex", pattern: "(?=hello)hello" },
        answerText: "Hello!",
        cooldownSeconds: 30,
        userCooldownSeconds: 60,
        games: [],
        chatTarget: "source_only",
      }),
      environmentFor(database),
    );
    expect(invalid.status).toBe(400);
    const invalidBody: unknown = await invalid.json();
    expect(invalidBody).toMatchObject({
      error: "faq_matcher_invalid",
      path: "matcher.pattern",
      reasonCode: "faq_regex_invalid",
    });
    if (typeof invalidBody !== "object" || invalidBody === null || Array.isArray(invalidBody)) {
      throw new Error("The invalid matcher response must be an object.");
    }
    expect(typeof Object.getOwnPropertyDescriptor(invalidBody, "reason")?.value).toBe("string");

    const valid = await panelRouter.fetch(
      await requestFor("manager-1", "/api/channels/channel-a/modules/faq/entries", "POST", {
        name: "Greeting",
        matcher: { type: "regex", pattern: "(?i)\\bhello\\b" },
        answerText: "Hello!",
        cooldownSeconds: 30,
        userCooldownSeconds: 60,
        games: [],
        chatTarget: "source_only",
      }),
      environmentFor(database),
    );
    expect(valid.status).toBe(201);
    await expect(valid.json()).resolves.toMatchObject({
      entry: {
        matcher: { type: "regex", pattern: "(?i)\\bhello\\b" },
        userCooldownSeconds: 60,
      },
    });
  });

  it("reorders the complete priority list atomically and rejects stale entry revisions", async () => {
    database = new TestD1Database();
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-1");
    await insertMember(database, "channel-a", "manager-1", "manager");
    await insertFaqEntry(database);
    await insertRestrictedFaqEntry(database);

    const reordered = await panelRouter.fetch(
      await requestFor("manager-1", "/api/channels/channel-a/modules/faq/entries/order", "POST", {
        order: [{ id: "entry-2", revision: 1 }, { id: "entry-1", revision: 1 }],
      }),
      environmentFor(database),
    );
    expect(reordered.status).toBe(200);
    await expect(reordered.json()).resolves.toMatchObject({ entries: [
      { id: "entry-2", order: 0, revision: 2 },
      { id: "entry-1", order: 1, revision: 2 },
    ] });

    const stale = await panelRouter.fetch(
      await requestFor("manager-1", "/api/channels/channel-a/modules/faq/entries/order", "POST", {
        order: [{ id: "entry-1", revision: 1 }, { id: "entry-2", revision: 1 }],
      }),
      environmentFor(database),
    );
    expect(stale.status).toBe(409);
    await expect(database.prepare("SELECT faq_id, sort_order, revision FROM faq_entries WHERE channel_id = 'channel-a' ORDER BY sort_order")
      .all()).resolves.toMatchObject({ results: [
        { faq_id: "entry-2", sort_order: 0, revision: 2 },
        { faq_id: "entry-1", sort_order: 1, revision: 2 },
      ] });
  });

});
