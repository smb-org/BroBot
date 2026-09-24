import { afterEach, describe, expect, it } from "vitest";

import { authRouter } from "../../src/worker/auth/routes";
import { createSessionCookie } from "../../src/worker/auth/session";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey as key } from "./fixtures";
import { TestD1Database } from "./test-d1";

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

describe("broadcaster scope route", () => {
  let database: TestD1Database;

  afterEach(() => { database.close(); });

  it("requests the scopes of a disabled registry module", async () => {
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

  it("renders a localized forbidden page for a signed-in user without channel access", async () => {
    database = new TestD1Database();
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "viewer");
    const request = await requestForPath("viewer", "/auth/channels/kanal-a/channel-bot");
    const headers = new Headers(request.headers);
    headers.set("Accept-Language", "en-US,en;q=0.9");

    const response = await authRouter.fetch(new Request(request, { headers }), environment(database));

    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("text/plain");
    await expect(response.text()).resolves.toContain("You do not have access to this channel.");
  });

  it("doesn't pull scopes from other channels into the consent dialog", async () => {
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
  ])("rejects a broadcaster member without the channel-owner identity on %s", async (path) => {
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

  it("returns 404 for an unknown registry module without authorization", async () => {
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
  ] as const)("denies %s the broadcaster consent path, even for a different channel", async (role) => {
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
