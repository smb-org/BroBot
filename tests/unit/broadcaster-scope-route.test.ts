import { afterEach, describe, expect, it } from "vitest";

import { authRouter } from "../../src/worker/auth/routes";
import { createSessionCookie } from "../../src/worker/auth/session";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

const key = (byte: number): string => btoa(String.fromCharCode(...new Uint8Array(32).fill(byte)))
  .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const keys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: key(1) }, retired: [] }),
  SESSION_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "encryption-v1", key: key(2) }, retired: [] }),
};

const environment = (database: TestD1Database): Env => ({
  DB: database as unknown as D1Database,
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  PUBLIC_ORIGIN: "https://brobot.example",
  ...keys,
} as unknown as Env);

const requestFor = async (userId: string, channelId: string): Promise<Request> => {
  const sessionCookie = await createSessionCookie(
    { sessionId: `session-${userId}` },
    keys.SESSION_COOKIE_KEYS,
    keys.SESSION_ENCRYPTION_KEYS,
  );
  return new Request(`https://brobot.example/auth/channels/${channelId}/broadcaster-scopes`, {
    headers: { Cookie: `__Host-brobot_session=${sessionCookie}` },
  });
};

describe("Broadcaster-Scope-Route", () => {
  let database: TestD1Database;

  afterEach(() => { database.close(); });

  it("fragt LOGIN_SCOPES plus aktivierte eigene Modul-Scopes an", async () => {
    database = new TestD1Database();
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "broadcaster");
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('kanal-a', 'werbung', 1, '{}')",
    ).run();

    const response = await authRouter.fetch(await requestFor("user-1", "kanal-a"), environment(database));
    const location = new URL(response.headers.get("location") ?? "https://invalid");
    const scopes = location.searchParams.get("scope")?.split(" ") ?? [];

    expect(response.status).toBe(302);
    expect(scopes).toEqual(expect.arrayContaining(["user:read:moderated_channels", "channel:bot", "channel:read:ads"]));
    expect(scopes).not.toContain("channel:manage:ads");
  });

  it("verweigert Verwaltern den Broadcaster-Zustimmungsweg", async () => {
    database = new TestD1Database();
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", "verwalter");

    const response = await authRouter.fetch(await requestFor("user-1", "kanal-a"), environment(database));

    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
  });
});
