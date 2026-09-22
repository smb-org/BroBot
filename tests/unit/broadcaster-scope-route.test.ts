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

const requestForPath = async (userId: string, path: string): Promise<Request> => {
  const sessionCookie = await createSessionCookie(
    { sessionId: `session-${userId}` },
    keys.SESSION_COOKIE_KEYS,
    keys.SESSION_ENCRYPTION_KEYS,
  );
  return new Request(`https://brobot.example${path}`, {
    headers: { Cookie: `__Host-brobot_session=${sessionCookie}` },
  });
};

const requestFor = async (userId: string, channelId: string, moduleId: string): Promise<Request> =>
  requestForPath(userId, `/auth/channels/${channelId}/broadcaster-scopes/${moduleId}`);

describe("Broadcaster-Scope-Route", () => {
  let database: TestD1Database;

  afterEach(() => { database.close(); });

  it("fragt die Scopes eines ausgeschalteten Registry-Moduls an", async () => {
    database = new TestD1Database();
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "kanal-a");
    await insertMember(database, "kanal-a", "kanal-a", "broadcaster");
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('kanal-a', 'ads', 0, '{}')",
    ).run();

    const response = await authRouter.fetch(await requestFor("kanal-a", "kanal-a", "ads"), environment(database));
    const location = new URL(response.headers.get("location") ?? "https://invalid");
    const scopes = location.searchParams.get("scope")?.split(" ") ?? [];

    expect(response.status).toBe(302);
    expect(scopes).toEqual(["user:read:moderated_channels", "channel:bot", "channel:read:ads"]);
    await expect(database.prepare(
      "SELECT redirect_path FROM oauth_transactions",
    ).first()).resolves.toEqual({ redirect_path: "/channels/kanal-a/modules/ads" });
  });

  it("zieht keine Scopes aus fremden Kanälen in den Zustimmungsdialog", async () => {
    database = new TestD1Database();
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "kanal-a");
    await insertMember(database, "kanal-a", "kanal-a", "broadcaster");
    await insertMember(database, "kanal-b", "kanal-a", "broadcaster");
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('kanal-b', 'ads', 1, '{}')",
    ).run();

    const response = await authRouter.fetch(await requestFor("kanal-a", "kanal-a", "text_commands"), environment(database));
    const location = new URL(response.headers.get("location") ?? "https://invalid");
    const scopes = location.searchParams.get("scope")?.split(" ") ?? [];

    expect(response.status).toBe(302);
    expect(scopes).toEqual(["user:read:moderated_channels", "channel:bot"]);
  });

  it.each([
    "/auth/channels/kanal-a/channel-bot",
    "/auth/channels/kanal-a/broadcaster-scopes/ads",
  ])("weist ein Broadcaster-Mitglied ohne Kanalinhaber-Identität auf %s ab", async (path) => {
    database = new TestD1Database();
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "zweites-konto");
    await insertMember(database, "kanal-a", "zweites-konto", "broadcaster");

    const response = await authRouter.fetch(
      await requestForPath("zweites-konto", path),
      environment(database),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
    await expect(database.prepare("SELECT COUNT(*) AS count FROM oauth_transactions").first())
      .resolves.toEqual({ count: 0 });
  });

  it("liefert für ein unbekanntes Registry-Modul 404 ohne Autorisierung", async () => {
    database = new TestD1Database();
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "kanal-a");
    await insertMember(database, "kanal-a", "kanal-a", "broadcaster");

    const response = await authRouter.fetch(await requestFor("kanal-a", "kanal-a", "unbekannt"), environment(database));

    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
    await expect(database.prepare("SELECT COUNT(*) AS count FROM oauth_transactions").first())
      .resolves.toEqual({ count: 0 });
  });

  it.each([
    "manager",
    "operator",
  ] as const)("verweigert %s den Broadcaster-Zustimmungsweg auch für einen fremden Kanal", async (role) => {
    database = new TestD1Database();
    await insertChannel(database, "kanal-a");
    await insertChannel(database, "kanal-b");
    await insertLoginIdentityAndSession(database, "user-1");
    await insertMember(database, "kanal-a", "user-1", role);
    await insertMember(database, "kanal-b", "user-1", "broadcaster");

    const response = await authRouter.fetch(await requestFor("user-1", "kanal-a", "ads"), environment(database));

    expect(response.status).toBe(403);
    expect(response.headers.get("location")).toBeNull();
  });
});
