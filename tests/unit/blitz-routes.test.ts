import { afterEach, describe, expect, it } from "vitest";
import { createCsrfToken } from "../../src/worker/auth/csrf";
import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey } from "./fixtures";
import { TestD1Database } from "./test-d1";

const keys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "fictional-cookie", key: testKey(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "fictional-encryption", key: testKey(2) }, retired: [] }),
};
const channelId = "fictional_channel";
const request = async (userId: string, method: string, suffix: string, body?: unknown): Promise<Request> => {
  const sessionId = `session-${userId}`;
  const cookie = await createSessionCookie({ sessionId }, keys.SESSION_COOKIE_KEYS, keys.SESSION_ENCRYPTION_KEYS);
  const csrf = await createCsrfToken(sessionId, keys.SESSION_COOKIE_KEYS, new Date().toISOString());
  return new Request(`https://brobot.example/api/channels/${channelId}/modules/blitz_round/questions${suffix}`, {
    method, headers: { Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrf}`, "Content-Type": "application/json", "X-CSRF-Token": csrf },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
};
let database: TestD1Database;
afterEach(() => { database.close(); });
const setup = async (role: "manager" | "operator") => {
  database = new TestD1Database();
  await insertChannel(database, channelId);
  await insertLoginIdentityAndSession(database, "fictional_editor");
  await insertMember(database, channelId, "fictional_editor", role);
  return { DB: database as unknown as D1Database, TWITCH_CLIENT_ID: "fictional-client", TWITCH_CLIENT_SECRET: "fictional-secret", ...keys } as unknown as Env;
};
const quiz = { kind: "quiz", prompt: "Which star is nearest?", answers: ["Sun"], enabled: true };

describe("blitz question HTTP writes", () => {
  it("creates, disables, and deletes with matching audit entries and rejects invalid content [protects=authorized question writes commit their audit and validate accepted answers; fails_when=CRUD loses fields, audit is missing, or invalid questions persist; no_claim=uses SQLite D1 harness and does not verify production sessions]", async () => {
    const env = await setup("manager");
    const create = await panelRouter.fetch(await request("fictional_editor", "POST", "", quiz), env);
    expect(create.status).toBe(201);
    const created: { question: { id: string } } = await create.json();
    const suffix = `/${created.question.id}`;
    const update = await panelRouter.fetch(await request("fictional_editor", "PATCH", suffix, { ...quiz, enabled: false, revision: 1 }), env);
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ question: { enabled: false, revision: 2 } });
    const invalid = await panelRouter.fetch(await request("fictional_editor", "POST", "", { ...quiz, answers: [] }), env);
    expect(invalid.status).toBe(400);
    const remove = await panelRouter.fetch(await request("fictional_editor", "DELETE", `${suffix}?revision=2`), env);
    expect(remove.status).toBe(200);
    await expect(remove.json()).resolves.toMatchObject({
      removed: true,
      question: { id: created.question.id, enabled: false, revision: 2 },
    });
    expect(await database.prepare("SELECT COUNT(*) AS count FROM blitz_questions WHERE channel_id = ?").bind(channelId).first()).toEqual({ count: 0 });
    const audits = await database.prepare("SELECT action FROM audit_log WHERE channel_id = ? AND module_id = ? ORDER BY rowid").bind(channelId, "blitz_round").all<{ action: string }>();
    expect(audits.results.map(({ action }) => action)).toEqual([
      "blitz_round.question.created", "blitz_round.question.updated", "blitz_round.question.deleted",
    ]);
  });

  it("denies pool management to operators without changing rows [protects=operators may start games but cannot edit the question pool; fails_when=an operator creates a question; no_claim=does not simulate permission revocation during a D1 batch]", async () => {
    const env = await setup("operator");
    const response = await panelRouter.fetch(await request("fictional_editor", "POST", "", quiz), env);
    expect(response.status).toBe(403);
    expect(await database.prepare("SELECT COUNT(*) AS count FROM blitz_questions").first()).toEqual({ count: 0 });
  });

  it("rejects a stale question update and returns the latest saved question [protects=the expected revision guards question edits and preserves the winner's corrected answer; fails_when=a stale edit overwrites a newer answer or returns no current entity; no_claim=does not exercise concurrent requests across separate database connections]", async () => {
    const env = await setup("manager");
    const create = await panelRouter.fetch(await request("fictional_editor", "POST", "", quiz), env);
    const created = await create.json<{ question: { id: string } }>();
    const suffix = `/${created.question.id}`;
    const firstEdit = await panelRouter.fetch(await request("fictional_editor", "PATCH", suffix, {
      ...quiz, answers: ["Sun", "Sol"], revision: 1,
    }), env);
    expect(firstEdit.status).toBe(200);

    const staleEdit = await panelRouter.fetch(await request("fictional_editor", "PATCH", suffix, {
      ...quiz, enabled: false, answers: ["Old answer"], revision: 1,
    }), env);

    expect(staleEdit.status).toBe(409);
    await expect(staleEdit.json()).resolves.toMatchObject({
      error: "question_conflict",
      current: { prompt: quiz.prompt, answers: ["Sun", "Sol"], enabled: true, revision: 2 },
    });
  });

  it("returns this manager's saved revision when another manager saves before the response [protects=the PATCH response keeps the exact snapshot returned by its successful write; fails_when=an interleaved later save changes the response to revision 3; no_claim=the interleaving is deterministic in the SQLite D1 route harness rather than separate Cloudflare connections]", async () => {
    const env = await setup("manager");
    const create = await panelRouter.fetch(await request("fictional_editor", "POST", "", quiz), env);
    const created = await create.json<{ question: { id: string } }>();
    let interleaved = false;
    const interleavedDb = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: async (statements: Parameters<D1Database["batch"]>[0]) => {
        const result = await env.DB.batch(statements);
        if (!interleaved) {
          interleaved = true;
          await env.DB.prepare(
            "UPDATE blitz_questions SET prompt = ?, answers_json = ?, search_text = ?, revision = revision + 1, updated_at = ? WHERE channel_id = ? AND question_id = ?",
          ).bind("Another manager's edit", JSON.stringify(["Sun", "Helios"]), "another manager's edit sun helios", "2100-01-01T00:00:01.000Z", channelId, created.question.id).run();
        }
        return result;
      },
    } as D1Database;
    const patchEnv = { ...env, DB: interleavedDb };

    const firstEdit = await panelRouter.fetch(await request("fictional_editor", "PATCH", `/${created.question.id}`, {
      ...quiz, answers: ["Sun", "Sol"], revision: 1,
    }), patchEnv);

    expect(firstEdit.status).toBe(200);
    await expect(firstEdit.json()).resolves.toMatchObject({
      question: { answers: ["Sun", "Sol"], prompt: quiz.prompt, revision: 2 },
    });
    await expect(env.DB.prepare("SELECT prompt, revision FROM blitz_questions WHERE channel_id = ? AND question_id = ?")
      .bind(channelId, created.question.id).first()).resolves.toEqual({ prompt: "Another manager's edit", revision: 3 });
  });

  it("rejects a stale question deletion and returns the current question [protects=delete uses the question's expected revision and cannot erase an edit made after the manager loaded it; fails_when=a stale delete removes the newer question or returns no current entity; no_claim=does not exercise concurrent requests across separate database connections]", async () => {
    const env = await setup("manager");
    const create = await panelRouter.fetch(await request("fictional_editor", "POST", "", quiz), env);
    const created = await create.json<{ question: { id: string } }>();
    const suffix = `/${created.question.id}`;
    const firstEdit = await panelRouter.fetch(await request("fictional_editor", "PATCH", suffix, {
      ...quiz, enabled: false, revision: 1,
    }), env);
    expect(firstEdit.status).toBe(200);

    const staleDelete = await panelRouter.fetch(await request("fictional_editor", "DELETE", `${suffix}?revision=1`), env);

    expect(staleDelete.status).toBe(409);
    await expect(staleDelete.json()).resolves.toMatchObject({
      error: "question_conflict",
      current: { prompt: quiz.prompt, enabled: false, revision: 2 },
    });
    expect(await database.prepare("SELECT COUNT(*) AS count FROM blitz_questions WHERE channel_id = ?").bind(channelId).first())
      .toEqual({ count: 1 });
  });

  it("loads a question by id independent of list pagination [protects=conflict recovery can fetch the selected question even when it is outside page one; fails_when=the by-id route is missing or returns a different question; no_claim=uses the SQLite D1 harness and does not exercise production authentication]", async () => {
    const env = await setup("manager");
    const create = await panelRouter.fetch(await request("fictional_editor", "POST", "", quiz), env);
    const created = await create.json<{ question: { id: string } }>();

    const response = await panelRouter.fetch(await request("fictional_editor", "GET", `/${created.question.id}`), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ question: { id: created.question.id, prompt: quiz.prompt } });
  });

  it("returns question_deleted for stale PATCH and DELETE after another manager removed the question [protects=deleted question edits and removals use the recoverable conflict contract; fails_when=either stale mutation returns 404 or lacks the question_deleted code; no_claim=uses the SQLite D1 harness and does not simulate separate database connections]", async () => {
    const env = await setup("manager");
    const create = await panelRouter.fetch(await request("fictional_editor", "POST", "", quiz), env);
    const created = await create.json<{ question: { id: string } }>();
    const suffix = `/${created.question.id}`;
    const remove = await panelRouter.fetch(await request("fictional_editor", "DELETE", `${suffix}?revision=1`), env);
    expect(remove.status).toBe(200);

    const patch = await panelRouter.fetch(await request("fictional_editor", "PATCH", suffix, { ...quiz, revision: 1 }), env);
    const removeAgain = await panelRouter.fetch(await request("fictional_editor", "DELETE", `${suffix}?revision=1`), env);

    expect(patch.status).toBe(409);
    await expect(patch.json()).resolves.toMatchObject({ error: "question_deleted" });
    expect(removeAgain.status).toBe(409);
    await expect(removeAgain.json()).resolves.toMatchObject({ error: "question_deleted" });
  });
});
