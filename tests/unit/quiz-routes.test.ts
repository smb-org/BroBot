import { afterEach, describe, expect, it } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { prepareModuleAudit } from "../../src/worker/module-audit";
import { panelRouter } from "../../src/worker/panel/routes";
import { quizModule } from "../../src/modules/quiz";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey } from "./fixtures";
import { TestD1Database, type TestPreparedStatement } from "./test-d1";

const keys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "fictional-cookie", key: testKey(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "fictional-encryption", key: testKey(2) }, retired: [] }),
};
const channelId = "fictional_channel";
const request = async (userId: string, method: string, suffix: string, body?: unknown, collectionPath = "/sets"): Promise<Request> => {
  const sessionId = `session-${userId}`;
  const cookie = await createSessionCookie({ sessionId }, keys.SESSION_COOKIE_KEYS, keys.SESSION_ENCRYPTION_KEYS);
  const csrf = await createCsrfToken(sessionId, keys.SESSION_COOKIE_KEYS, new Date().toISOString());
  return new Request(`https://brobot.example/api/channels/${channelId}/modules/quiz${collectionPath}${suffix}`, {
    method,
    headers: { Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrf}`, "Content-Type": "application/json", "X-CSRF-Token": csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
};

let database: TestD1Database;
afterEach(() => { database.close(); });

const setup = async (role: "manager" | "operator" = "manager") => {
  database = new TestD1Database();
  await insertChannel(database, channelId);
  await insertLoginIdentityAndSession(database, "fictional_editor");
  await insertMember(database, channelId, "fictional_editor", role);
  const env = {
    DB: database as unknown as D1Database,
    TWITCH_CLIENT_ID: "fictional-client",
    TWITCH_CLIENT_SECRET: "fictional-secret",
    ...keys,
  } as unknown as Env;
  return env;
};

const validQuestion = {
  text: "Which planet has rings?",
  options: ["Mars", "Saturn", "Venus"],
  correctIndex: 1,
  enabled: true,
};

describe("quiz set HTTP routes", () => {
  it("creates and explicitly saves a set with ordered questions and audit entries", async () => {
    const env = await setup();
    const createdResponse = await panelRouter.fetch(await request("fictional_editor", "POST", "", { name: "Space" }), env);
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json<{ set: { id: string; revision: number } }>();

    const savedResponse = await panelRouter.fetch(await request("fictional_editor", "PUT", `/${created.set.id}`, {
      name: "Space quiz",
      revision: created.set.revision,
      questions: [validQuestion, { ...validQuestion, text: "What color is a clear daytime sky?", options: ["Blue", "Green"], correctIndex: 0 }],
    }), env);
    expect(savedResponse.status).toBe(200);
    await expect(savedResponse.json()).resolves.toMatchObject({
      set: { id: created.set.id, name: "Space quiz", revision: 2, questions: [
        { position: 0, text: validQuestion.text, correctIndex: 1 },
        { position: 1, text: "What color is a clear daytime sky?", correctIndex: 0 },
      ] },
    });

    const reloaded = await panelRouter.fetch(await request("fictional_editor", "GET", `/${created.set.id}`), env);
    expect(reloaded.status).toBe(200);
    await expect(reloaded.json()).resolves.toMatchObject({ set: { name: "Space quiz", questions: [
      { options: ["Mars", "Saturn", "Venus"] }, { options: ["Blue", "Green"] },
    ] } });
    await expect(database.prepare("SELECT action FROM audit_log WHERE channel_id = ? AND module_id = 'quiz' ORDER BY rowid")
      .bind(channelId).all()).resolves.toMatchObject({ results: [{ action: "quiz.set.created" }, { action: "quiz.set.updated" }] });
  });

  it("rejects invalid option lengths without changing the set", async () => {
    const env = await setup();
    const created = await panelRouter.fetch(await request("fictional_editor", "POST", "", { name: "Space" }), env);
    const savedSet = await created.json<{ set: { id: string; revision: number } }>();
    const invalid = await panelRouter.fetch(await request("fictional_editor", "PUT", `/${savedSet.set.id}`, {
      name: "Space", revision: savedSet.set.revision,
      questions: [{ ...validQuestion, options: ["x".repeat(81), "B"], correctIndex: 0 }],
    }), env);

    expect(invalid.status).toBe(400);
    await expect(database.prepare("SELECT revision FROM quiz_sets WHERE set_id = ?").bind(savedSet.set.id).first())
      .resolves.toEqual({ revision: 1 });
  });

  it("requires a manager to create or edit a set", async () => {
    const env = await setup("operator");
    const response = await panelRouter.fetch(await request("fictional_editor", "POST", "", { name: "Space" }), env);

    expect(response.status).toBe(403);
    await expect(database.prepare("SELECT COUNT(*) AS count FROM quiz_sets").first()).resolves.toEqual({ count: 0 });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE module_id = 'quiz'").first()).resolves.toEqual({ count: 0 });
  });

  it("enforces the 50-set channel cap and the 100-question payload cap", async () => {
    const env = await setup();
    await database.prepare(
      `INSERT INTO quiz_sets (channel_id, set_id, name, revision, created_at, updated_at)
       SELECT ?, 'fictional-set-' || value, 'Set ' || value, 1, '2030-01-01', '2030-01-01' FROM json_each(?)`,
    ).bind(channelId, JSON.stringify(Array.from({ length: 50 }, (_, index) => index))).run();
    const overSetLimit = await panelRouter.fetch(await request("fictional_editor", "POST", "", { name: "Over limit" }), env);
    expect(overSetLimit.status).toBe(409);

    await database.prepare("DELETE FROM quiz_sets WHERE channel_id = ?").bind(channelId).run();
    const created = await panelRouter.fetch(await request("fictional_editor", "POST", "", { name: "Space" }), env);
    const set = await created.json<{ set: { id: string; revision: number } }>();
    const overQuestionLimit = await panelRouter.fetch(await request("fictional_editor", "PUT", `/${set.set.id}`, {
      name: "Space", revision: 1, questions: Array.from({ length: 101 }, (_, index) => ({ ...validQuestion, text: `Question ${String(index)}` })),
    }), env);

    expect(overQuestionLimit.status).toBe(400);
    await expect(overQuestionLimit.json()).resolves.toMatchObject({ error: "question_count_invalid" });
  });

  it("returns not found when a set belongs to another channel", async () => {
    const env = await setup();
    await insertChannel(database, "another_channel");
    await database.prepare(
      "INSERT INTO quiz_sets (channel_id, set_id, name, revision, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)",
    ).bind("another_channel", "foreign-set", "Foreign", "2030-01-01", "2030-01-01").run();

    const response = await panelRouter.fetch(await request("fictional_editor", "GET", "/foreign-set"), env);
    expect(response.status).toBe(404);
  });

  it("searches question sets and paginates the matching collection", async () => {
    const env = await setup();
    await database.prepare(
      `INSERT INTO quiz_sets (channel_id, set_id, name, revision, created_at, updated_at)
       SELECT ?, 'space-set-' || value, 'Space ' || value, 1, '2030-01-01', '2030-01-01' FROM json_each(?)`,
    ).bind(channelId, JSON.stringify(Array.from({ length: 12 }, (_, index) => index))).run();

    const response = await panelRouter.fetch(await request("fictional_editor", "GET", "?page=2&q=space"), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      total: 12,
      page: 2,
      sets: [{ name: "Space 8" }, { name: "Space 9" }],
    });
  });

  it("matches German uppercase characters when searching set names", async () => {
    const env = await setup();
    const created = await panelRouter.fetch(await request("fictional_editor", "POST", "", { name: "Äpfel und Bäume" }), env);
    expect(created.status).toBe(201);

    const response = await panelRouter.fetch(await request("fictional_editor", "GET", "?q=äPFEL"), env);
    await expect(response.json()).resolves.toMatchObject({
      total: 1,
      sets: [{ name: "Äpfel und Bäume" }],
    });
  });

  it("seeds five questions once in the channel language and preserves edits on re-enable", async () => {
    const env = await setup();
    await database.prepare("UPDATE channels SET language = 'en' WHERE channel_id = ?").bind(channelId).run();
    await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'quiz', 0, '{}')")
      .bind(channelId).run();
    const enableContext: Parameters<NonNullable<typeof quizModule.onEnable>>[0] = {
      DB: env.DB,
      authorizeMutation: () => ({ sql: "", values: [] }),
      prepareModuleAudit: (entry, changedAt) => prepareModuleAudit(env.DB, "fictional_editor", changedAt, entry),
      actor: { userId: "fictional_editor" },
      now: "2030-01-01T00:00:00.000Z",
    };
    const rejectedActivation = await quizModule.onEnable?.(enableContext, channelId) ?? [];
    await (database as unknown as { batch: (statements: TestPreparedStatement[]) => Promise<unknown> }).batch([...rejectedActivation] as unknown as TestPreparedStatement[]);
    await expect(database.prepare("SELECT COUNT(*) AS count FROM quiz_sets WHERE channel_id = ?").bind(channelId).first())
      .resolves.toEqual({ count: 0 });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE channel_id = ? AND module_id = 'quiz' AND action = 'quiz.set.created'")
      .bind(channelId).first()).resolves.toEqual({ count: 0 });

    await database.prepare("UPDATE channel_modules SET enabled = 1 WHERE channel_id = ? AND module_id = 'quiz'").bind(channelId).run();
    const first = await quizModule.onEnable?.(enableContext, channelId) ?? [];
    await (database as unknown as { batch: (statements: TestPreparedStatement[]) => Promise<unknown> }).batch([...first] as unknown as TestPreparedStatement[]);
    const seeded = await database.prepare("SELECT set_id FROM quiz_sets WHERE channel_id = ?").bind(channelId).first<{ set_id: string }>();
    expect(seeded).not.toBeNull();
    await database.prepare("UPDATE quiz_sets SET name = 'My questions' WHERE set_id = ?").bind(seeded?.set_id ?? "").run();

    await database.prepare("UPDATE channel_modules SET enabled = 0 WHERE channel_id = ? AND module_id = 'quiz'").bind(channelId).run();
    const second = await quizModule.onEnable?.(enableContext, channelId) ?? [];
    await (database as unknown as { batch: (statements: TestPreparedStatement[]) => Promise<unknown> }).batch([...second] as unknown as TestPreparedStatement[]);
    await database.prepare("UPDATE channel_modules SET enabled = 1 WHERE channel_id = ? AND module_id = 'quiz'").bind(channelId).run();
    const third = await quizModule.onEnable?.(enableContext, channelId) ?? [];
    await (database as unknown as { batch: (statements: TestPreparedStatement[]) => Promise<unknown> }).batch([...third] as unknown as TestPreparedStatement[]);

    await expect(database.prepare("SELECT name FROM quiz_sets WHERE channel_id = ?").bind(channelId).first())
      .resolves.toEqual({ name: "My questions" });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM quiz_questions WHERE set_id = ?").bind(seeded?.set_id ?? "").first())
      .resolves.toEqual({ count: 5 });
    await expect(database.prepare("SELECT text, options_json FROM quiz_questions WHERE set_id = ? AND position = 0")
      .bind(seeded?.set_id ?? "").first()).resolves.toEqual({
      text: "Which color do blue and yellow make?",
      options_json: '["Purple","Green","Orange"]',
    });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE channel_id = ? AND module_id = 'quiz' AND action = 'quiz.set.created'")
      .bind(channelId).first()).resolves.toEqual({ count: 1 });

    await insertChannel(database, "fictional_german_channel");
    await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'quiz', 1, '{}')")
      .bind("fictional_german_channel").run();
    const germanSeed = await quizModule.onEnable?.(enableContext, "fictional_german_channel") ?? [];
    await (database as unknown as { batch: (statements: TestPreparedStatement[]) => Promise<unknown> }).batch([...germanSeed] as unknown as TestPreparedStatement[]);
    await expect(database.prepare(
      `SELECT quiz_questions.text, quiz_questions.options_json FROM quiz_questions
        JOIN quiz_sets ON quiz_sets.set_id = quiz_questions.set_id
       WHERE quiz_sets.channel_id = ? AND quiz_questions.position = 0`,
    ).bind("fictional_german_channel").first()).resolves.toEqual({
      text: "Welche Farbe entsteht aus Blau und Gelb?",
      options_json: '["Violett","Grün","Orange"]',
    });
  });
});
