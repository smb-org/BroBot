import { afterEach, describe, expect, it, vi } from "vitest";

import { createCsrfToken } from "../../src/worker/auth/csrf";
import {
  createDiscordViewerSession,
  DISCORD_OAUTH_STATE_COOKIE,
  serializeDiscordViewerSession,
} from "../../src/worker/auth/discord-oauth";
import { discordRouter } from "../../src/worker/discord/routes";
import { getDiscordLink, replaceDiscordLink } from "../../src/modules/discord/repository";
import { panelRouter } from "../../src/worker/panel/routes";
import { TestD1Database } from "./test-d1";
import { testKey } from "./fixtures";

const ORIGIN = "https://brobot.example";
const SESSION_KEYS = JSON.stringify({ active: { id: "discord-route-cookie", key: testKey(72) }, retired: [] });
const databases: TestD1Database[] = [];

const createEnvironment = (database: TestD1Database, configured = true): Env => ({
  DB: database as unknown as D1Database,
  PUBLIC_ORIGIN: ORIGIN,
  APP_ENV: "local",
  SESSION_COOKIE_KEYS: SESSION_KEYS,
  DISCORD_CLIENT_ID: configured ? "fictional-discord-client" : "",
  DISCORD_CLIENT_SECRET: configured ? "fictional-discord-secret" : "",
  DISCORD_API_BASE: "http://127.0.0.1:8792/api/v10",
} as unknown as Env);

const cookieValue = (response: Response, cookieName: string): string => {
  const match = new RegExp(`${cookieName}=([^;,]+)`, "u").exec(response.headers.get("set-cookie") ?? "");
  if (match?.[1] === undefined) throw new Error(`${cookieName} cookie was not returned.`);
  return match[1];
};

const startOAuth = async (environment: Env): Promise<{ response: Response; state: string; nonce: string }> => {
  const response = await discordRouter.fetch(new Request(`${ORIGIN}/auth/discord`), environment);
  const authorizationUrl = new URL(response.headers.get("location") ?? "https://invalid.example");
  return {
    response,
    state: authorizationUrl.searchParams.get("state") ?? "",
    nonce: cookieValue(response, DISCORD_OAUTH_STATE_COOKIE),
  };
};

const mockDiscordApi = (connections: unknown[]) => {
  const requests: string[] = [];
  const respond = (url: string): Response => {
    requests.push(url);
    if (url.endsWith("/api/oauth2/token")) {
      return Response.json({
        access_token: "fictional-discord-access-token",
        token_type: "Bearer",
        expires_in: 604800,
        refresh_token: "fictional-discord-refresh-token",
        scope: "identify connections",
      });
    }
    if (url.endsWith("/users/@me")) {
      return Response.json({ id: "80351110224678912", username: "nightowl", global_name: "Night Owl", discriminator: "0", avatar: null });
    }
    return Response.json(connections);
  };
  const fetcher = vi.fn<typeof fetch>((input) =>
    Promise.resolve(respond(input instanceof Request ? input.url : input.toString())));
  return { fetcher, requests };
};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const database of databases.splice(0)) database.close();
});

describe("Discord link routes", () => {
  it("links a verified Twitch connection and does not persist the Discord access token", async () => {
    const database = new TestD1Database();
    databases.push(database);
    const environment = createEnvironment(database);
    const started = await startOAuth(environment);
    const { fetcher, requests } = mockDiscordApi([{
      id: "141981764", name: "nightowl_dev", type: "twitch", verified: true,
      visibility: 0, friend_sync: false, show_activity: true, two_way_link: false, revoked: false,
    }]);
    vi.stubGlobal("fetch", fetcher);

    const callback = await discordRouter.fetch(new Request(
      `${ORIGIN}/auth/discord/callback?code=fictional-code&state=${encodeURIComponent(started.state)}`,
      { headers: { Cookie: `${DISCORD_OAUTH_STATE_COOKIE}=${started.nonce}` } },
    ), environment);
    const viewerCookie = cookieValue(callback, "__Host-brobot_discord_viewer");

    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(`${ORIGIN}/discord/link?discord=linked`);
    expect(requests).toEqual([
      "http://127.0.0.1:8792/api/oauth2/token",
      "http://127.0.0.1:8792/api/v10/users/@me",
      "http://127.0.0.1:8792/api/v10/users/@me/connections",
    ]);
    await expect(getDiscordLink(environment.DB, "80351110224678912")).resolves.toMatchObject({
      discordUsername: "nightowl",
      twitchUserId: "141981764",
      twitchLogin: "nightowl_dev",
    });
    const columns = await database.prepare("PRAGMA table_info(discord_links)").all<{ name: string }>();
    expect(columns.results.map(({ name }) => name)).not.toContain("access_token");
    const state = await discordRouter.fetch(new Request(`${ORIGIN}/api/discord/link`, {
      headers: { Cookie: `__Host-brobot_discord_viewer=${viewerCookie}` },
    }), environment);
    expect(await state.json()).toMatchObject({ configured: true, signedIn: true, link: { discordUsername: "nightowl" } });
  });

  it.each([
    { name: "unverified", connections: [{ id: "141981764", name: "nightowl_dev", type: "twitch", verified: false, revoked: false }] },
    { name: "revoked", connections: [{ id: "141981764", name: "nightowl_dev", type: "twitch", verified: true, revoked: true }] },
    { name: "missing", connections: [] },
  ])("shows the Twitch setup help and writes no row for a $name connection", async ({ connections }) => {
    const database = new TestD1Database();
    databases.push(database);
    const environment = createEnvironment(database);
    const started = await startOAuth(environment);
    vi.stubGlobal("fetch", mockDiscordApi(connections).fetcher);

    const callback = await discordRouter.fetch(new Request(
      `${ORIGIN}/auth/discord/callback?code=fictional-code&state=${encodeURIComponent(started.state)}`,
      { headers: { Cookie: `${DISCORD_OAUTH_STATE_COOKIE}=${started.nonce}` } },
    ), environment);

    expect(callback.headers.get("location")).toBe(`${ORIGIN}/discord/link?discord=no-twitch`);
    await expect(database.prepare("SELECT count(*) AS count FROM discord_links").first()).resolves.toEqual({ count: 0 });
  });

  it("rejects a callback whose state cookie belongs to another browser", async () => {
    const database = new TestD1Database();
    databases.push(database);
    const environment = createEnvironment(database);
    const started = await startOAuth(environment);
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);

    const callback = await discordRouter.fetch(new Request(
      `${ORIGIN}/auth/discord/callback?code=fictional-code&state=${encodeURIComponent(started.state)}`,
      { headers: { Cookie: `${DISCORD_OAUTH_STATE_COOKIE}=different-browser` } },
    ), environment);

    expect(callback.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("shows an unavailable state without Discord credentials", async () => {
    const database = new TestD1Database();
    databases.push(database);
    const response = await discordRouter.fetch(new Request(`${ORIGIN}/api/discord/link`), createEnvironment(database, false));

    await expect(response.json()).resolves.toEqual({ configured: false, signedIn: false, link: null });
  });

  it("requires same-origin CSRF protection to unlink and deletes the row when both checks pass", async () => {
    const database = new TestD1Database();
    databases.push(database);
    const environment = createEnvironment(database);
    await replaceDiscordLink(environment.DB, {
      discordUserId: "80351110224678912", twitchUserId: "141981764", discordUsername: "nightowl",
      twitchLogin: "nightowl_dev", linkedAt: "2026-11-24T10:00:00.000Z", verifiedAt: "2026-11-24T10:00:00.000Z",
    });
    const viewer = createDiscordViewerSession("80351110224678912", new Date().toISOString());
    const viewerCookie = await serializeDiscordViewerSession(viewer, SESSION_KEYS);
    const csrfToken = await createCsrfToken(viewer.sessionId, SESSION_KEYS, new Date().toISOString());
    const cookieHeader = `${viewerCookie.split(";", 1)[0] ?? ""};__Host-brobot_discord_csrf=${csrfToken}`;
    const request = (origin?: string, csrf = csrfToken) => new Request(`${ORIGIN}/api/discord/unlink`, {
      method: "POST",
      headers: {
        Cookie: cookieHeader,
        "X-CSRF-Token": csrf,
        ...(origin === undefined ? {} : { Origin: origin }),
      },
    });

    expect((await discordRouter.fetch(request(), environment)).status).toBe(403);
    expect((await discordRouter.fetch(request(ORIGIN, "wrong-token"), environment)).status).toBe(403);
    expect((await discordRouter.fetch(request(ORIGIN), environment)).status).toBe(204);
    await expect(getDiscordLink(environment.DB, "80351110224678912")).resolves.toBeNull();
  });

  it("does not accept a Discord viewer cookie as a dashboard session", async () => {
    const database = new TestD1Database();
    databases.push(database);
    const environment = createEnvironment(database);
    const viewer = createDiscordViewerSession("80351110224678912", new Date().toISOString());
    const viewerCookie = await serializeDiscordViewerSession(viewer, SESSION_KEYS);

    const response = await panelRouter.fetch(new Request(`${ORIGIN}/api/channels/fictional-channel/settings`, {
      headers: { Cookie: viewerCookie.split(";", 1)[0] ?? "" },
    }), environment);

    expect(response.status).toBe(401);
  });
});
