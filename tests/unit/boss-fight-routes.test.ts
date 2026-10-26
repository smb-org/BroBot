import { afterEach, describe, expect, it } from "vitest";
import { bossFightDefaultsForLanguage } from "../../src/modules/boss_fight/contracts";
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
const request = async (method: string, suffix: string): Promise<Request> => {
  const sessionId = "session-fictional_operator";
  const cookie = await createSessionCookie({ sessionId }, keys.SESSION_COOKIE_KEYS, keys.SESSION_ENCRYPTION_KEYS);
  const csrf = await createCsrfToken(sessionId, keys.SESSION_COOKIE_KEYS, new Date().toISOString());
  return new Request(`https://brobot.example/api/channels/${channelId}/modules/boss_fight/${suffix}`, {
    method, headers: { Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrf}`, "X-CSRF-Token": csrf },
  });
};
let database: TestD1Database;
afterEach(() => { database.close(); });
const setup = async () => {
  database = new TestD1Database();
  await insertChannel(database, channelId);
  await insertLoginIdentityAndSession(database, "fictional_operator");
  await insertMember(database, channelId, "fictional_operator", "operator");
  await database.prepare("INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'boss_fight', 1, ?, 1)")
    .bind(channelId, JSON.stringify(bossFightDefaultsForLanguage("en"))).run();
  return { DB: database as unknown as D1Database, TWITCH_CLIENT_ID: "fictional-client", TWITCH_CLIENT_SECRET: "fictional-secret", ...keys } as unknown as Env;
};

describe("boss fight start gating", () => {
  it("refuses to start and reports the reason while the stream is offline [protects=a boss round needs a live stream, checked by the start route and the availability probe; fails_when=a round opens or availability stays silent without a live stream; no_claim=opening a round while live is covered by the worker flow test]", async () => {
    const env = await setup();
    const availability = await panelRouter.fetch(await request("GET", "availability"), env);
    expect(await availability.json()).toEqual({ reason: "stream_offline" });
    const start = await panelRouter.fetch(await request("POST", "start"), env);
    expect(start.status).toBe(409);
    expect(await start.json()).toEqual({ error: "stream_offline" });
  });
});
