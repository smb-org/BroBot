import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
import { publishOverlayChanged } from "../../src/worker/realtime";
import { createFaqRepository } from "../../src/modules/faq/adapters/d1";
import type { RealtimeMessage } from "../../src/realtime-contract";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey as key } from "./fixtures";
import { TestD1Database } from "./test-d1";

const environmentKeys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
};

let database: TestD1Database;
let realtimePublish: ReturnType<typeof vi.fn<(messages: readonly RealtimeMessage[]) => Promise<void>>>;

const environmentFor = (database: TestD1Database): Env => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  CHANNEL: {
    idFromName: (channelId: string) => channelId,
    get: () => ({ publish: realtimePublish }),
  },
  ...environmentKeys,
} as unknown as Env);

const requestFor = async (
  userId: string,
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
): Promise<Request> => {
  const cookie = await createSessionCookie(
    { sessionId: `session-${userId}` },
    environmentKeys.SESSION_COOKIE_KEYS,
    environmentKeys.SESSION_ENCRYPTION_KEYS,
  );
  const csrf = await createCsrfToken(`session-${userId}`, environmentKeys.SESSION_COOKIE_KEYS, new Date().toISOString());
  return new Request(`https://brobot.example${path}`, {
    method,
    headers: new Headers({
      Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrf}`,
      "Content-Type": "application/json",
      "X-CSRF-Token": csrf,
    }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
};

const fetchPanel = async (
  userId: string,
  path: string,
  method = "GET",
  body?: Record<string, unknown>,
): Promise<Response> => panelRouter.fetch(
  await requestFor(userId, path, method, body),
  environmentFor(database),
);

describe("Channel variable routes", () => {
  beforeEach(() => { database = new TestD1Database(); realtimePublish = vi.fn<(messages: readonly RealtimeMessage[]) => Promise<void>>().mockResolvedValue(undefined); });
  afterEach(() => { vi.useRealTimers(); database.close(); });

  it("lets operators change values while keeping variable management for managers", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertLoginIdentityAndSession(database, "operator-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    await insertMember(database, "channel-a", "operator-a", "operator");

    const created = await fetchPanel("manager-a", "/api/channels/channel-a/variables", "POST", {
      name: "score", value: 4, description: "Current score", resetOnStreamStart: false,
    });
    expect(created.status).toBe(201);

    const changed = await fetchPanel("operator-a", "/api/channels/channel-a/variables/score/value", "POST", {
      operation: "add", amount: 3,
    });
    expect(changed.status).toBe(200);
    await expect(database.prepare(
      "SELECT value FROM channel_variables WHERE channel_id = 'channel-a' AND name = 'score'",
    ).first()).resolves.toEqual({ value: 7 });

    const createDenied = await fetchPanel("operator-a", "/api/channels/channel-a/variables", "POST", { name: "other" });
    const renameDenied = await fetchPanel("operator-a", "/api/channels/channel-a/variables/score", "PATCH", { newName: "points" });
    const deleteDenied = await fetchPanel("operator-a", "/api/channels/channel-a/variables/score", "DELETE");
    expect(createDenied.status).toBe(403);
    expect(renameDenied.status).toBe(403);
    expect(deleteDenied.status).toBe(403);
  });

  it("renames template and action references across modules atomically and protects action usage", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");

    await fetchPanel("manager-a", "/api/channels/channel-a/variables", "POST", {
      name: "score", value: 0, description: "", resetOnStreamStart: false,
    });
    await database.prepare(
      `INSERT INTO text_library_settings (channel_id, graph_revision, updated_at)
       VALUES ('channel-a', 1, '2026-09-24T00:00:00.000Z')`,
    ).run();
    await database.prepare(
      `INSERT INTO text_library_categories
        (channel_id, category_id, catalog_key, custom_name, created_at, updated_at)
       VALUES ('channel-a', 'custom_score', NULL, 'Custom', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`,
    ).run();
    await database.prepare(
      `INSERT INTO text_blocks (channel_id, block_name, category_id, revision, created_at, updated_at)
       VALUES ('channel-a', 'score_block', 'custom_score', 1, '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`,
    ).run();
    await database.prepare(
      `INSERT INTO text_block_variants (channel_id, block_name, variant_id, position, conditions_json, texts_json)
       VALUES ('channel-a', 'score_block', 'default', 0, '{}', ?)`,
    ).bind(JSON.stringify(["Score: {var.score}"])).run();
    await database.prepare(
      `INSERT INTO text_commands
        (channel_id, command_name, response_text, created_at, updated_at, variable_name, variable_operation, variable_amount)
       VALUES ('channel-a', 'points', 'Score: {var.score}', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z', 'score', 'add', 1)`,
    ).run();
    await database.prepare(
      `INSERT INTO text_commands
        (channel_id, command_name, response_text, created_at, updated_at, variable_name, variable_operation, variable_amount)
       VALUES ('channel-a', 'increment', '', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z', 'score', 'add', 1)`,
    ).run();
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision, settings_revision)
       VALUES ('channel-a', 'ads', 1, '{"automatic":"Automatic","manual":"Manual","prewarningText":"Score {var.score}"}', 1, 1)`,
    ).run();
    await database.prepare(
      `INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision, settings_revision)
       VALUES ('channel-a', 'raid', 1, '{"textThreshold":3,"shoutoutEnabled":true,"shoutoutThreshold":3,"textLong":"Score {var.score}","textShort":"Score {var.score}"}', 1, 1)`,
    ).run();
    await database.prepare(
      `INSERT INTO faq_entries
        (faq_id, channel_id, name, enabled, matcher_type, matcher_json, answer_text, cooldown_seconds,
         games_json, chat_target, sort_order, revision, last_used_at, created_at, updated_at)
       VALUES ('faq-score', 'channel-a', 'Score FAQ', 1, 'keywords', ?, 'Score: {var.score}', 30,
               '[]', 'source_only', 0, 1, NULL, '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`,
    ).bind(JSON.stringify({ type: "keywords", patterns: ["score"] })).run();
    await database.prepare(
      `INSERT INTO timers
        (timer_id, channel_id, name, enabled, message_text, trigger_type, trigger_json, chat_target,
         revision, next_run_at, last_run_at, created_at, updated_at)
       VALUES ('timer-score', 'channel-a', 'Score reminder', 1, 'Score: {var.score}', 'interval',
               '{"type":"interval","live":{"minutes":10}}', 'source_only', 1, '2026-09-24T00:10:00.000Z', NULL,
               '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`,
    ).run();
    const faqRepository = createFaqRepository(database as unknown as D1Database);
    const cachedFaqEntries = await faqRepository.matchers("channel-a");
    expect(cachedFaqEntries.find(({ entry }) => entry.id === "faq-score")?.entry.answerText).toBe("Score: {var.score}");

    const renamed = await fetchPanel("manager-a", "/api/channels/channel-a/variables/score", "PATCH", { newName: "points" });
    expect(renamed.status).toBe(200);
    const renamedBody = await renamed.json<{ usages: Array<{ moduleId: string; itemName: string; kind: string }> }>();
    expect(renamedBody.usages).toEqual(expect.arrayContaining([
      { moduleId: "text_library", itemName: "score_block", kind: "template" },
      { moduleId: "faq", itemName: "Score FAQ", kind: "template" },
      { moduleId: "timers", itemName: "Score reminder", kind: "template" },
    ]));
    await expect(database.prepare(
      "SELECT revision FROM text_blocks WHERE channel_id = 'channel-a' AND block_name = 'score_block'",
    ).first()).resolves.toEqual({ revision: 2 });
    await expect(database.prepare(
      "SELECT texts_json FROM text_block_variants WHERE channel_id = 'channel-a' AND block_name = 'score_block'",
    ).first()).resolves.toEqual({ texts_json: '["Score: {var.points}"]' });
    await expect(database.prepare(
      "SELECT response_text, variable_name, revision FROM text_commands WHERE channel_id = 'channel-a' AND command_name = 'points'",
    ).first()).resolves.toEqual({ response_text: "Score: {var.points}", variable_name: "points", revision: 2 });
    await expect(database.prepare(
      "SELECT settings, revision, settings_revision FROM channel_modules WHERE channel_id = 'channel-a' AND module_id = 'ads'",
    ).first()).resolves.toEqual({ settings: '{"automatic":"Automatic","manual":"Manual","prewarningText":"Score {var.points}"}', revision: 2, settings_revision: 2 });
    const staleRaidDraft = await fetchPanel("manager-a", "/api/channels/channel-a/modules/raid/settings", "PATCH", {
      revision: 1,
      settings: {
        textThreshold: 3,
        shoutoutEnabled: true,
        shoutoutThreshold: 3,
        textLong: "Score {var.score}",
        textShort: "Score {var.score}",
      },
    });
    expect(staleRaidDraft.status).toBe(409);
    await expect(database.prepare(
      "SELECT settings, revision, settings_revision FROM channel_modules WHERE channel_id = 'channel-a' AND module_id = 'raid'",
    ).first()).resolves.toEqual({
      settings: '{"textThreshold":3,"shoutoutEnabled":true,"shoutoutThreshold":3,"textLong":"Score {var.points}","textShort":"Score {var.points}"}',
      revision: 2,
      settings_revision: 2,
    });
    await expect(database.prepare(
      "SELECT variable_name, revision FROM text_commands WHERE channel_id = 'channel-a' AND command_name = 'increment'",
    ).first()).resolves.toEqual({ variable_name: "points", revision: 2 });
    await expect(database.prepare(
      "SELECT answer_text, revision FROM faq_entries WHERE channel_id = 'channel-a' AND faq_id = 'faq-score'",
    ).first()).resolves.toEqual({ answer_text: "Score: {var.points}", revision: 2 });
    const refreshedFaqEntries = await faqRepository.matchers("channel-a");
    expect(refreshedFaqEntries.find(({ entry }) => entry.id === "faq-score")?.entry.answerText).toBe("Score: {var.points}");
    await expect(database.prepare(
      "SELECT message_text, revision, next_run_at FROM timers WHERE channel_id = 'channel-a' AND timer_id = 'timer-score'",
    ).first()).resolves.toEqual({
      message_text: "Score: {var.points}",
      revision: 2,
      next_run_at: "2026-09-24T00:10:00.000Z",
    });

    const deletion = await fetchPanel("manager-a", "/api/channels/channel-a/variables/points", "DELETE");
    expect(deletion.status).toBe(409);
    await expect(deletion.json()).resolves.toMatchObject({ error: "variable_in_use" });
  });

  it("does not rewrite FAQ or timer references when a concurrent variable rename loses the update", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    await fetchPanel("manager-a", "/api/channels/channel-a/variables", "POST", {
      name: "score", value: 5, description: "", resetOnStreamStart: false,
    });
    await database.prepare(
      `INSERT INTO faq_entries
        (faq_id, channel_id, name, enabled, matcher_type, matcher_json, answer_text, cooldown_seconds,
         games_json, chat_target, sort_order, revision, last_used_at, created_at, updated_at)
       VALUES ('faq-race', 'channel-a', 'Score FAQ', 1, 'keywords', ?, 'Score: {var.score}', 30,
               '[]', 'source_only', 0, 1, NULL, '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`,
    ).bind(JSON.stringify({ type: "keywords", patterns: ["score"] })).run();
    await database.prepare(
      `INSERT INTO timers
        (timer_id, channel_id, name, enabled, message_text, trigger_type, trigger_json, chat_target,
         revision, next_run_at, created_at, updated_at)
       VALUES ('timer-race', 'channel-a', 'Score reminder', 1, 'Score: {var.score}', 'interval',
               '{"type":"interval","live":{"minutes":10}}', 'source_only', 1, NULL,
               '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`,
    ).run();

    let raced = false;
    const interleavedDatabase = {
      prepare: (sql: string) => database.prepare(sql),
      batch: async (statements: Parameters<typeof database.batch>[0]) => {
        if (!raced) {
          raced = true;
          await database.batch([
            database.prepare("DELETE FROM channel_variables WHERE channel_id = 'channel-a' AND name = 'score'"),
            database.prepare(
              `INSERT INTO channel_variables
                (channel_id, name, value, description, reset_on_stream_start, created_at, updated_at)
               VALUES ('channel-a', 'points', 5, '', 0, '2026-09-25T00:00:00.000Z', '2026-09-25T00:00:00.000Z')`,
            ),
          ]);
        }
        return database.batch(statements);
      },
    } as unknown as D1Database;
    const response = await panelRouter.fetch(
      await requestFor("manager-a", "/api/channels/channel-a/variables/score", "PATCH", { newName: "points" }),
      { ...environmentFor(database), DB: interleavedDatabase },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "variable_already_exists" });
    await expect(database.prepare(
      "SELECT answer_text FROM faq_entries WHERE channel_id = 'channel-a' AND faq_id = 'faq-race'",
    ).first()).resolves.toEqual({ answer_text: "Score: {var.score}" });
    await expect(database.prepare(
      "SELECT message_text FROM timers WHERE channel_id = 'channel-a' AND timer_id = 'timer-race'",
    ).first()).resolves.toEqual({ message_text: "Score: {var.score}" });
  });

  it("rejects variable renames that would exceed a referenced template length limit", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    await fetchPanel("manager-a", "/api/channels/channel-a/variables", "POST", {
      name: "score", value: 5, description: "", resetOnStreamStart: false,
    });
    const oldToken = "{var.score}";
    const longTemplate = `${"x".repeat(500 - oldToken.length)}${oldToken}`;
    await database.prepare(
      `INSERT INTO text_library_settings (channel_id, graph_revision, updated_at)
       VALUES ('channel-a', 1, '2026-09-24T00:00:00.000Z')`,
    ).run();
    await database.prepare(
      `INSERT INTO text_library_categories
        (channel_id, category_id, catalog_key, custom_name, created_at, updated_at)
       VALUES ('channel-a', 'custom_score', NULL, 'Custom', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`,
    ).run();
    await database.prepare(
      `INSERT INTO text_blocks (channel_id, block_name, category_id, revision, created_at, updated_at)
       VALUES ('channel-a', 'score_block', 'custom_score', 1, '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`,
    ).run();
    await database.prepare(
      `INSERT INTO text_block_variants (channel_id, block_name, variant_id, position, conditions_json, texts_json)
       VALUES ('channel-a', 'score_block', 'default', 0, '{}', ?)`,
    ).bind(JSON.stringify([longTemplate])).run();
    await database.prepare(
      `INSERT INTO faq_entries
        (faq_id, channel_id, name, enabled, matcher_type, matcher_json, answer_text, cooldown_seconds,
         games_json, chat_target, sort_order, revision, last_used_at, created_at, updated_at)
       VALUES ('faq-long', 'channel-a', 'Long FAQ', 1, 'keywords', ?, ?, 30,
               '[]', 'source_only', 0, 1, NULL, '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`,
    ).bind(JSON.stringify({ type: "keywords", patterns: ["score"] }), longTemplate).run();
    await database.prepare(
      `INSERT INTO timers
        (timer_id, channel_id, name, enabled, message_text, trigger_type, trigger_json, chat_target,
         revision, next_run_at, created_at, updated_at)
       VALUES ('timer-long', 'channel-a', 'Long timer', 1, ?, 'interval',
               '{"type":"interval","live":{"minutes":10}}', 'source_only', 1, NULL,
               '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`,
    ).bind(longTemplate).run();

    const response = await fetchPanel("manager-a", "/api/channels/channel-a/variables/score", "PATCH", { newName: "points" });

    expect(response.status).toBe(400);
    const body = await response.json<{ error: string; usages: Array<{ moduleId: string; itemName: string; kind: string }> }>();
    expect(body.error).toBe("variable_rename_template_too_long");
    expect(body.usages).toEqual(expect.arrayContaining([
      { moduleId: "text_library", itemName: "score_block", kind: "template" },
      { moduleId: "faq", itemName: "Long FAQ", kind: "template" },
      { moduleId: "timers", itemName: "Long timer", kind: "template" },
    ]));
    await expect(database.prepare(
      "SELECT name FROM channel_variables WHERE channel_id = 'channel-a' AND name IN ('score', 'points') ORDER BY name",
    ).all()).resolves.toMatchObject({ results: [{ name: "score" }] });
    await expect(database.prepare(
      "SELECT answer_text FROM faq_entries WHERE channel_id = 'channel-a' AND faq_id = 'faq-long'",
    ).first()).resolves.toEqual({ answer_text: longTemplate });
    await expect(database.prepare(
      "SELECT message_text FROM timers WHERE channel_id = 'channel-a' AND timer_id = 'timer-long'",
    ).first()).resolves.toEqual({ message_text: longTemplate });
  });

  it("rechecks text block length inside the rename batch", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    await fetchPanel("manager-a", "/api/channels/channel-a/variables", "POST", {
      name: "score", value: 5, description: "", resetOnStreamStart: false,
    });
    await database.prepare(
      `INSERT INTO text_library_settings (channel_id, graph_revision, updated_at)
       VALUES ('channel-a', 1, '2026-09-24T00:00:00.000Z')`,
    ).run();
    await database.prepare(
      `INSERT INTO text_library_categories
        (channel_id, category_id, catalog_key, custom_name, created_at, updated_at)
       VALUES ('channel-a', 'custom_score', NULL, 'Custom', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`,
    ).run();
    await database.prepare(
      `INSERT INTO text_blocks (channel_id, block_name, category_id, revision, created_at, updated_at)
       VALUES ('channel-a', 'score_block', 'custom_score', 1, '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`,
    ).run();
    await database.prepare(
      `INSERT INTO text_block_variants (channel_id, block_name, variant_id, position, conditions_json, texts_json)
       VALUES ('channel-a', 'score_block', 'default', 0, '{}', '["Score: {var.score}"]')`,
    ).run();
    const longTemplate = `${"x".repeat(500 - "{var.score}".length)}{var.score}`;
    const interleavedDatabase = {
      prepare: (sql: string) => database.prepare(sql),
      batch: async (statements: Parameters<typeof database.batch>[0]) => {
        await database.prepare(
          "UPDATE text_block_variants SET texts_json = ? WHERE channel_id = 'channel-a' AND block_name = 'score_block'",
        ).bind(JSON.stringify([longTemplate])).run();
        return database.batch(statements);
      },
    } as unknown as D1Database;

    const response = await panelRouter.fetch(
      await requestFor("manager-a", "/api/channels/channel-a/variables/score", "PATCH", { newName: "points" }),
      { ...environmentFor(database), DB: interleavedDatabase },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "variable_rename_template_too_long" });
    await expect(database.prepare(
      "SELECT name FROM channel_variables WHERE channel_id = 'channel-a' AND name IN ('score', 'points') ORDER BY name",
    ).all()).resolves.toMatchObject({ results: [{ name: "score" }] });
    await expect(database.prepare(
      "SELECT texts_json FROM text_block_variants WHERE channel_id = 'channel-a' AND block_name = 'score_block'",
    ).first()).resolves.toEqual({ texts_json: JSON.stringify([longTemplate]) });
  });

  it("bumps overlays on variable rename so an old draft cannot bind a recreated name", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    const originalVariable = await fetchPanel("manager-a", "/api/channels/channel-a/variables", "POST", {
      name: "score", value: 10, description: "", resetOnStreamStart: false,
    });
    expect(originalVariable.status).toBe(201);
    const overlayId = "overlay-a";
    await database.prepare(
      `INSERT INTO overlays (overlay_id, channel_id, name, created_at, updated_at)
       VALUES (?, 'channel-a', 'Gameplay', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`,
    ).bind(overlayId).run();
    const staleDraft = {
      baseRevision: 1,
      name: "Gameplay",
      width: 1920,
      height: 1080,
      css: "",
      elements: [{
        id: "score-element",
        kind: "variable",
        label: "Score",
        variableName: "score",
        text: "Score {value}",
        config: {},
        x: 0,
        y: 0,
        scalePercent: 100,
        z: 0,
        inComposition: true,
      }],
    };
    const firstSave = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${overlayId}`, "PUT", staleDraft);
    expect(firstSave.status).toBe(200);

    const renamed = await fetchPanel("manager-a", "/api/channels/channel-a/variables/score", "PATCH", { newName: "points" });
    expect(renamed.status).toBe(200);
    await expect(database.prepare(
      "SELECT revision FROM overlays WHERE channel_id = 'channel-a' AND overlay_id = ?",
    ).bind(overlayId).first()).resolves.toEqual({ revision: 3 });
    const recreatedVariable = await fetchPanel("manager-a", "/api/channels/channel-a/variables", "POST", {
      name: "score", value: 99, description: "New score", resetOnStreamStart: false,
    });
    expect(recreatedVariable.status).toBe(201);

    const staleSave = await fetchPanel("manager-a", `/api/channels/channel-a/overlays/${overlayId}`, "PUT", staleDraft);
    expect(staleSave.status).toBe(409);
    await expect(staleSave.json()).resolves.toMatchObject({
      error: "overlay_changed_concurrently",
      currentRevision: 3,
    });
    await expect(database.prepare(
      "SELECT variable_name FROM overlay_elements WHERE channel_id = 'channel-a' AND overlay_id = ?",
    ).bind(overlayId).first()).resolves.toEqual({ variable_name: "points" });
  });

  it("warns about overlay display use and detaches elements when deleting a variable", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    const createdVariable = await fetchPanel("manager-a", "/api/channels/channel-a/variables", "POST", {
      name: "score", value: 10, description: "", resetOnStreamStart: false,
    });
    expect(createdVariable.status).toBe(201);
    await database.prepare(
      `INSERT INTO overlays (overlay_id, channel_id, name, created_at, updated_at)
       VALUES ('overlay-a', 'channel-a', 'Gameplay', '2026-09-24T00:00:00.000Z', '2026-09-24T00:00:00.000Z')`,
    ).run();
    await database.prepare(
      `INSERT INTO overlay_elements
        (element_id, channel_id, overlay_id, kind, label, variable_name, text, config_json)
       VALUES ('score-element', 'channel-a', 'overlay-a', 'variable', 'Death Count', 'score', 'Score {value}', '{}')`,
    ).run();

    const listed = await fetchPanel("manager-a", "/api/channels/channel-a/variables");
    const listedBody: unknown = await listed.json();
    expect(listedBody).toMatchObject({ variables: [{ usages: [{
      moduleId: "overlays",
      itemName: "Gameplay",
      elementLabel: "Death Count",
      kind: "display",
    }] }] });

    const deleted = await fetchPanel("manager-a", "/api/channels/channel-a/variables/score", "DELETE");
    expect(deleted.status).toBe(204);
    await expect(database.prepare(
      "SELECT revision FROM overlays WHERE channel_id = 'channel-a' AND overlay_id = 'overlay-a'",
    ).first()).resolves.toEqual({ revision: 2 });
    const recreatedVariable = await fetchPanel("manager-a", "/api/channels/channel-a/variables", "POST", {
      name: "score", value: 99, description: "New score", resetOnStreamStart: false,
    });
    expect(recreatedVariable.status).toBe(201);
    const staleSave = await fetchPanel("manager-a", "/api/channels/channel-a/overlays/overlay-a", "PUT", {
      baseRevision: 1,
      name: "Gameplay",
      width: 1920,
      height: 1080,
      css: "",
      elements: [{
        id: "score-element",
        kind: "variable",
        label: "Death Count",
        variableName: "score",
        text: "Score {value}",
        config: {},
        x: 0,
        y: 0,
        scalePercent: 100,
        z: 0,
        inComposition: true,
      }],
    });
    expect(staleSave.status).toBe(409);
    await expect(database.prepare(
      "SELECT variable_name FROM overlay_elements WHERE channel_id = 'channel-a' AND overlay_id = 'overlay-a'",
    ).first()).resolves.toEqual({ variable_name: null });
    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM channel_variables WHERE channel_id = 'channel-a' AND name = 'score'",
    ).first()).resolves.toEqual({ count: 1 });
  });

  it("rejects a stale value edit and writes no audit for the value written concurrently", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    await fetchPanel("manager-a", "/api/channels/channel-a/variables", "POST", {
      name: "score", value: 0, description: "Score", resetOnStreamStart: false,
    });
    const auditBefore = await database.prepare("SELECT COUNT(*) AS count FROM audit_log").first<{ count: number }>();
    const prepare = database.prepare.bind(database);
    let raced = false;
    database.prepare = (sql: string) => {
      if (!raced && sql.includes("SET value = CASE ?")) {
        raced = true;
        database.sqlite.prepare("UPDATE channel_variables SET value = 7, updated_at = ? WHERE channel_id = 'channel-a' AND name = 'score'")
          .run("2026-09-24T12:00:01.000Z");
      }
      return prepare(sql);
    };

    const changed = await fetchPanel("manager-a", "/api/channels/channel-a/variables/score/value", "POST", {
      operation: "add", amount: 1,
    });

    expect(raced).toBe(true);
    expect(changed.status).toBe(409);
    await expect(database.prepare("SELECT value FROM channel_variables WHERE name = 'score'").first())
      .resolves.toEqual({ value: 7 });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log").first()).resolves.toEqual(auditBefore);
  });

  it("returns a metadata conflict without auditing stale metadata", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    await fetchPanel("manager-a", "/api/channels/channel-a/variables", "POST", {
      name: "score", value: 0, description: "Original", resetOnStreamStart: false,
    });
    const auditBefore = await database.prepare("SELECT COUNT(*) AS count FROM audit_log").first<{ count: number }>();
    const prepare = database.prepare.bind(database);
    let raced = false;
    database.prepare = (sql: string) => {
      if (!raced && sql.includes("SET name = ?, description = ?")) {
        raced = true;
        database.sqlite.prepare("UPDATE channel_variables SET description = ?, updated_at = ? WHERE channel_id = 'channel-a' AND name = 'score'")
          .run("Concurrent", "2026-09-24T12:00:01.000Z");
      }
      return prepare(sql);
    };

    const changed = await fetchPanel("manager-a", "/api/channels/channel-a/variables/score", "PATCH", { description: "Stale edit" });

    expect(raced).toBe(true);
    expect(changed.status).toBe(409);
    await expect(database.prepare("SELECT description FROM channel_variables WHERE name = 'score'").first())
      .resolves.toEqual({ description: "Concurrent" });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log").first()).resolves.toEqual(auditBefore);
  });

  it("publishes created, metadata-updated, value-changed, renamed, and removed variables", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");

    const created = await fetchPanel("manager-a", "/api/channels/channel-a/variables", "POST", {
      name: "score", value: 4, description: "Score", resetOnStreamStart: false,
    });
    await database.prepare(
      `INSERT INTO overlays (overlay_id, channel_id, name, created_at, updated_at)
       VALUES ('overlay-a', 'channel-a', 'Gameplay', ?, ?)`,
    ).bind("2026-09-24T00:00:00.000Z", "2026-09-24T00:00:00.000Z").run();
    await database.prepare(
      `INSERT INTO overlay_elements (element_id, channel_id, overlay_id, kind, variable_name)
       VALUES ('element-a', 'channel-a', 'overlay-a', 'variable', 'score')`,
    ).run();
    const metadataUpdated = await fetchPanel("manager-a", "/api/channels/channel-a/variables/score", "PATCH", {
      description: "Current score", resetOnStreamStart: true,
    });
    const changed = await fetchPanel("manager-a", "/api/channels/channel-a/variables/score/value", "POST", {
      operation: "add", amount: 3,
    });
    const renamed = await fetchPanel("manager-a", "/api/channels/channel-a/variables/score", "PATCH", {
      newName: "points",
    });
    const deleted = await fetchPanel("manager-a", "/api/channels/channel-a/variables/points", "DELETE");

    expect([created.status, metadataUpdated.status, changed.status, renamed.status, deleted.status]).toEqual([201, 200, 200, 200, 204]);
    expect(realtimePublish).toHaveBeenCalledTimes(5);
    expect(realtimePublish.mock.calls.map(([messages]) => messages)).toMatchObject([
      [{ type: "variables.changed", payload: { set: [{ name: "score", value: 4 }], removed: [] } }],
      [{ type: "variables.changed", payload: { set: [{ name: "score", value: 4 }], removed: [] } }],
      [{ type: "variables.changed", payload: { set: [{ name: "score", value: 7 }], removed: [] } }],
      [
        { type: "overlay.changed", payload: { overlayId: "overlay-a", revision: 2 } },
        { type: "variables.changed", payload: { set: [{ name: "points", value: 7 }], removed: ["score"] } },
      ],
      [
        { type: "overlay.changed", payload: { overlayId: "overlay-a", revision: 3 } },
        { type: "variables.changed", payload: { set: [], removed: ["points"] } },
      ],
    ]);
    expect(realtimePublish.mock.calls.map(([messages]) => messages)).toMatchObject([
      [{ type: "variables.changed", payload: { overlayIdsByVariable: { score: [] } } }],
      [{ type: "variables.changed", payload: { overlayIdsByVariable: { score: ["overlay-a"] } } }],
      [{ type: "variables.changed", payload: { overlayIdsByVariable: { score: ["overlay-a"] } } }],
      [
        { type: "overlay.changed" },
        { type: "variables.changed", payload: { overlayIdsByVariable: { score: ["overlay-a"], points: ["overlay-a"] } } },
      ],
      [
        { type: "overlay.changed" },
        { type: "variables.changed", payload: { overlayIdsByVariable: { points: ["overlay-a"] } } },
      ],
    ]);
  });

  it("routes a value change from the overlay references that remain after an edit", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    await fetchPanel("manager-a", "/api/channels/channel-a/variables", "POST", {
      name: "score", value: 0, description: "Score", resetOnStreamStart: false,
    });
    await database.prepare(
      `INSERT INTO overlays (overlay_id, channel_id, name, created_at, updated_at)
       VALUES ('overlay-a', 'channel-a', 'Gameplay', ?, ?)`,
    ).bind("2026-09-24T00:00:00.000Z", "2026-09-24T00:00:00.000Z").run();
    await database.prepare(
      `INSERT INTO overlay_elements (element_id, channel_id, overlay_id, kind, variable_name)
       VALUES ('element-a', 'channel-a', 'overlay-a', 'variable', 'score')`,
    ).run();

    // The overlay edit commits immediately before the value mutation. Its
    // failed realtime hint is immaterial: the later write captures D1 state.
    await database.batch([
      database.prepare("UPDATE overlay_elements SET variable_name = NULL WHERE element_id = 'element-a'"),
      database.prepare("UPDATE overlays SET revision = revision + 1 WHERE overlay_id = 'overlay-a'"),
    ]);
    realtimePublish.mockClear();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    realtimePublish.mockRejectedValueOnce(new Error("DO publish unavailable"))
      .mockRejectedValueOnce(new Error("DO publish unavailable"));
    try {
      await publishOverlayChanged(environmentFor(database).CHANNEL, "channel-a", [
        { overlayId: "overlay-a", revision: 2 },
      ]);
    } finally {
      warning.mockRestore();
    }
    expect(realtimePublish).toHaveBeenCalledTimes(2);
    realtimePublish.mockClear();
    const changed = await fetchPanel("manager-a", "/api/channels/channel-a/variables/score/value", "POST", {
      operation: "add", amount: 1,
    });

    expect(changed.status).toBe(200);
    expect(realtimePublish.mock.calls.at(-1)?.[0]).toMatchObject([
      { type: "variables.changed", payload: { overlayIdsByVariable: { score: [] } } },
    ]);
  });

  it("reloads text block overlays after a channel variable value changes", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    await database.prepare(
      `INSERT INTO channel_variables (channel_id, name, value, description, created_at, updated_at)
       VALUES ('channel-a', 'score', 4, 'Score', '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:00.000Z')`,
    ).run();
    await database.prepare(
      `INSERT INTO overlays (overlay_id, channel_id, name, created_at, updated_at)
       VALUES ('overlay-text', 'channel-a', 'Text only', '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:00.000Z')`,
    ).run();
    await database.prepare(
      `INSERT INTO overlay_elements (element_id, channel_id, overlay_id, kind, config_json)
       VALUES ('element-text', 'channel-a', 'overlay-text', 'text_library.block', '{"blockName":"welcome"}')`,
    ).run();

    const changed = await fetchPanel("manager-a", "/api/channels/channel-a/variables/score/value", "POST", {
      operation: "add", amount: 1,
    });

    expect(changed.status).toBe(200);
    expect(realtimePublish.mock.calls.at(-1)?.[0]).toContainEqual(expect.objectContaining({
      type: "modul.text_library.state_changed",
      payload: { reason: "template.data.changed" },
      overlayIds: ["overlay-text"],
    }));
  });

  it("carries resetOnStreamStart in the channel.variable.renamed audit snapshot for every kind of patch (#254 review)", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    await fetchPanel("manager-a", "/api/channels/channel-a/variables", "POST", {
      name: "score", value: 4, description: "old description", resetOnStreamStart: false,
    });

    const auditRows = async (): Promise<Array<{ before: { name: unknown; description: unknown; resetOnStreamStart: unknown }; after: { name: unknown; description: unknown; resetOnStreamStart: unknown } }>> => {
      const rows = await database.prepare(
        "SELECT before_json, after_json FROM audit_log WHERE action = 'channel.variable.renamed' ORDER BY created_at",
      ).all<{ before_json: string; after_json: string }>();
      return rows.results.map((row) => ({
        before: JSON.parse(row.before_json) as { name: unknown; description: unknown; resetOnStreamStart: unknown },
        after: JSON.parse(row.after_json) as { name: unknown; description: unknown; resetOnStreamStart: unknown },
      }));
    };

    // Description only: the name and the reset setting stay put.
    await fetchPanel("manager-a", "/api/channels/channel-a/variables/score", "PATCH", { description: "new description" });
    let [entry] = (await auditRows()).slice(-1);
    expect(entry).toMatchObject({
      before: { name: "score", description: "old description", resetOnStreamStart: false },
      after: { name: "score", description: "new description", resetOnStreamStart: false },
    });

    // Rename only: description and the reset setting stay put.
    await fetchPanel("manager-a", "/api/channels/channel-a/variables/score", "PATCH", { newName: "points" });
    [entry] = (await auditRows()).slice(-1);
    expect(entry).toMatchObject({
      before: { name: "score", description: "new description", resetOnStreamStart: false },
      after: { name: "points", description: "new description", resetOnStreamStart: false },
    });

    // Both the description and the reset setting change together, without a rename.
    await fetchPanel("manager-a", "/api/channels/channel-a/variables/points", "PATCH", {
      description: "final description", resetOnStreamStart: true,
    });
    [entry] = (await auditRows()).slice(-1);
    expect(entry).toMatchObject({
      before: { name: "points", description: "new description", resetOnStreamStart: false },
      after: { name: "points", description: "final description", resetOnStreamStart: true },
    });
  });

  it("carries resetOnStreamStart in the channel.variable.value_changed audit snapshot (#254 review)", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");
    await fetchPanel("manager-a", "/api/channels/channel-a/variables", "POST", {
      name: "score", value: 4, description: "Score", resetOnStreamStart: true,
    });

    const changed = await fetchPanel("manager-a", "/api/channels/channel-a/variables/score/value", "POST", {
      operation: "add", amount: 1,
    });
    expect(changed.status).toBe(200);

    const row = await database.prepare(
      "SELECT before_json, after_json FROM audit_log WHERE action = 'channel.variable.value_changed' ORDER BY created_at DESC LIMIT 1",
    ).first<{ before_json: string; after_json: string }>();
    const before = JSON.parse(row?.before_json ?? "null") as { value: unknown; resetOnStreamStart: unknown };
    const after = JSON.parse(row?.after_json ?? "null") as { value: unknown; resetOnStreamStart: unknown };
    expect(before).toMatchObject({ value: 4, resetOnStreamStart: true });
    expect(after).toMatchObject({ value: 5, resetOnStreamStart: true });
  });

  it("carries resetOnStreamStart in the channel.variable.created audit snapshot", async () => {
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager-a");
    await insertMember(database, "channel-a", "manager-a", "manager");

    const created = await fetchPanel("manager-a", "/api/channels/channel-a/variables", "POST", {
      name: "score", value: 4, description: "Score", resetOnStreamStart: true,
    });
    expect(created.status).toBe(201);

    const row = await database.prepare(
      "SELECT after_json FROM audit_log WHERE action = 'channel.variable.created' ORDER BY created_at DESC LIMIT 1",
    ).first<{ after_json: string }>();
    const after = JSON.parse(row?.after_json ?? "null") as { resetOnStreamStart: unknown };
    expect(after).toMatchObject({ resetOnStreamStart: true });
  });
});
