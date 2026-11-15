import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import { encryptJson, parseKeyRing } from "../../src/worker/auth/crypto";
import { createSessionCookie } from "../../src/worker/auth/session";
import { panelRouter } from "../../src/worker/panel/routes";
import { insertAppAccessToken, insertChannel, insertLoginIdentityAndSession, insertMember, testKey } from "./fixtures";
import { TestD1Database } from "./test-d1";

const keys = {
  SESSION_COOKIE_KEYS: JSON.stringify({ active: { id: "cookie-v1", key: testKey(1) }, retired: [] }),
  TOKEN_ENCRYPTION_KEYS: JSON.stringify({ active: { id: "token-v1", key: testKey(2) }, retired: [] }),
};

interface RecentChatter {
  userId: string;
  login: string;
  displayName: string;
  profileImageUrl: string | null;
}

const chatter: RecentChatter = {
  userId: "100",
  login: "chatfreund",
  displayName: "Chatfreund",
  profileImageUrl: "https://static.example/chatfreund.png",
};

let database: TestD1Database;
let helixCalls: string[];

const environmentFor = (recentChatters: readonly RecentChatter[] = [chatter]): Env => ({
  DB: database as unknown as D1Database,
  ...keys,
  TWITCH_CLIENT_ID: "client-id",
  TWITCH_CLIENT_SECRET: "client-secret",
  CHANNEL: {
    idFromName: (channelId: string) => channelId,
    get: () => ({ getRecentChatters: () => Promise.resolve(recentChatters) }),
  },
} as unknown as Env);

const requestFor = async (userId: string, query: string, channelId = "channel-a"): Promise<Request> => {
  const sessionId = `session-${userId}`;
  const cookie = await createSessionCookie({ sessionId }, keys.SESSION_COOKIE_KEYS, keys.TOKEN_ENCRYPTION_KEYS);
  const csrf = await createCsrfToken(sessionId, keys.SESSION_COOKIE_KEYS, new Date().toISOString());
  return new Request(`https://brobot.example/api/channels/${channelId}/twitch/user-suggestions?q=${encodeURIComponent(query)}`, {
    headers: { Cookie: `__Host-brobot_session=${cookie}; __Host-brobot_csrf=${csrf}` },
  });
};

const installHelix = (fail = false): void => {
  helixCalls = [];
  vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    helixCalls.push(url.toString());
    if (fail) return Promise.reject(new Error("Helix unavailable"));
    if (url.pathname.endsWith("/users")) {
      return Promise.resolve(Response.json({ data: url.searchParams.get("login") === "chatfreund"
        ? [{ id: "200", login: "chatfreund", display_name: "Chatfreund Exact", profile_image_url: null }]
        : [] }));
    }
    return Promise.resolve(Response.json({ data: [
      { id: "100", broadcaster_login: "chatfreund", display_name: "Chatfreund", thumbnail_url: "https://static.example/chatfreund.png", is_live: false },
      { id: "300", broadcaster_login: "beispielkanal", display_name: "Beispielkanal", thumbnail_url: "https://static.example/beispielkanal.png", is_live: true },
    ] }));
  }));
};

describe("Twitch user suggestion route", () => {
  beforeEach(async () => {
    database = new TestD1Database();
    await insertChannel(database, "channel-a");
    await insertLoginIdentityAndSession(database, "manager");
    await insertMember(database, "channel-a", "manager", "manager");
    const ciphertext = await encryptJson({ token: "app-token" }, parseKeyRing(keys.TOKEN_ENCRYPTION_KEYS));
    await insertAppAccessToken(database, ciphertext, "2099-09-21T00:00:00.000Z", "2026-09-20T00:00:00.000Z", "2026-09-20T00:00:00.000Z");
  });

  afterEach(() => {
    database.close();
    vi.unstubAllGlobals();
  });

  it("puts recent chatters first, deduplicates by ID, then adds the exact and channel-search matches", async () => {
    installHelix();

    const response = await panelRouter.fetch(await requestFor("manager", "chatfreund"), environmentFor());
    const body = await response.json<{ users: Array<Record<string, unknown>>; partial: boolean }>();

    expect(response.status).toBe(200);
    expect(body.partial).toBe(false);
    expect(body.users).toEqual([
      { ...chatter, isLive: false },
      { userId: "200", login: "chatfreund", displayName: "Chatfreund Exact", profileImageUrl: null },
      { userId: "300", login: "beispielkanal", displayName: "Beispielkanal", profileImageUrl: "https://static.example/beispielkanal.png", isLive: true },
    ]);
    expect(helixCalls).toHaveLength(2);
    expect(helixCalls.some((url) => url.includes("/helix/users?login=chatfreund"))).toBe(true);
    expect(helixCalls.some((url) => url.includes("/helix/search/channels?query=chatfreund&first=8"))).toBe(true);
    const cachedResponse = await panelRouter.fetch(await requestFor("manager", "chatfreund"), environmentFor());
    expect(cachedResponse.status).toBe(200);
    expect(helixCalls).toHaveLength(2);
  });

  it("merges live status from a duplicate channel search into the first chatter suggestion", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname.endsWith("/users")) {
        return Promise.resolve(Response.json({ data: [
          { id: "200", login: "chatfreund", display_name: "Chatfreund Exact", profile_image_url: null },
        ] }));
      }
      return Promise.resolve(Response.json({ data: [
        { id: "100", broadcaster_login: "chatfreund", display_name: "Chatfreund Live", thumbnail_url: "https://static.example/chatfreund-live.png", is_live: true },
      ] }));
    }));
    await insertChannel(database, "channel-live");
    await insertMember(database, "channel-live", "manager", "manager");

    const response = await panelRouter.fetch(await requestFor("manager", "chatfreund", "channel-live"), environmentFor());
    const body = await response.json<{ users: Array<Record<string, unknown>>; partial: boolean }>();

    expect(response.status).toBe(200);
    expect(body.users.filter((user) => user.userId === "100")).toHaveLength(1);
    expect(body.users[0]).toMatchObject({ userId: "100", isLive: true });
  });

  it("keeps the exact login within the eight-result limit when the chatter roster is full", async () => {
    installHelix();
    await insertChannel(database, "channel-limit");
    await insertMember(database, "channel-limit", "manager", "manager");
    const recentChatters = Array.from({ length: 10 }, (_, index) => ({
      userId: `chatter-${String(index)}`,
      login: `chatfreund${String(index)}`,
      displayName: `Chatfreund ${String(index)}`,
      profileImageUrl: null,
    }));

    const response = await panelRouter.fetch(
      await requestFor("manager", "chatfreund", "channel-limit"),
      environmentFor(recentChatters),
    );
    const body = await response.json<{ users: Array<Record<string, unknown>>; partial: boolean }>();

    expect(body.users).toHaveLength(8);
    expect(body.users.slice(0, 7)).toEqual(recentChatters.slice(0, 7));
    expect(body.users[7]).toMatchObject({ userId: "200", login: "chatfreund" });
  });

  it("rejects queries outside Twitch login characters", async () => {
    installHelix();

    const response = await panelRouter.fetch(await requestFor("manager", "bad-login"), environmentFor());

    expect(response.status).toBe(400);
    expect(helixCalls).toHaveLength(0);
  });

  it("requires channel membership", async () => {
    installHelix();
    await insertLoginIdentityAndSession(database, "outsider");

    const response = await panelRouter.fetch(await requestFor("outsider", "chatfreund"), environmentFor());

    expect(response.status).toBe(403);
    expect(helixCalls).toHaveLength(0);
  });

  it("keeps identical queries cached separately for each channel", async () => {
    installHelix();
    await insertChannel(database, "channel-b");
    await insertMember(database, "channel-b", "manager", "manager");

    await panelRouter.fetch(await requestFor("manager", "beispielkanal", "channel-a"), environmentFor());
    await panelRouter.fetch(await requestFor("manager", "beispielkanal", "channel-b"), environmentFor());

    expect(helixCalls).toHaveLength(4);
  });

  it("returns recent chatters with partial status when Helix fails", async () => {
    installHelix(true);

    const recentChatter = { ...chatter, userId: "101", login: "chatfreunde", displayName: "Chatfreunde" };
    const response = await panelRouter.fetch(await requestFor("manager", "chatfreunde"), environmentFor([recentChatter]));
    const body = await response.json<{ users: Array<Record<string, unknown>>; partial: boolean }>();

    expect(response.status).toBe(200);
    expect(body.partial).toBe(true);
    expect(body.users).toEqual([recentChatter]);
  });
});
