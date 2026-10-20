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
    const update = await panelRouter.fetch(await request("fictional_editor", "PATCH", suffix, { ...quiz, enabled: false }), env);
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ question: { enabled: false } });
    const invalid = await panelRouter.fetch(await request("fictional_editor", "POST", "", { ...quiz, answers: [] }), env);
    expect(invalid.status).toBe(400);
    const remove = await panelRouter.fetch(await request("fictional_editor", "DELETE", suffix), env);
    expect(remove.status).toBe(200);
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
});
