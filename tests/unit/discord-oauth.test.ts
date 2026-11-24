import { afterEach, describe, expect, it, vi } from "vitest";

import {
  beginDiscordOAuth,
  consumeDiscordOAuthTransaction,
  createDiscordViewerSession,
  readDiscordViewerSession,
  serializeDiscordViewerSession,
  verifyDiscordOAuthState,
} from "../../src/worker/auth/discord-oauth";
import {
  discordAuthorizationUrl,
  exchangeDiscordCode,
  fetchDiscordConnections,
  fetchDiscordUser,
  verifiedTwitchConnection,
} from "../../src/modules/discord/adapters/discord";
import { TestD1Database } from "./test-d1";
import { testKey } from "./fixtures";

const keys = JSON.stringify({ active: { id: "discord-oauth", key: testKey(71) }, retired: [] });
const databases: TestD1Database[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const database of databases.splice(0)) database.close();
});

describe("Discord OAuth state", () => {
  it("binds state to the starting browser and consumes it once", async () => {
    const database = new TestD1Database();
    databases.push(database);
    const environment = {
      SESSION_COOKIE_KEYS: keys,
      DISCORD_CLIENT_ID: "fictional-discord-client",
      DISCORD_CLIENT_SECRET: "fictional-discord-secret",
    };
    const started = await beginDiscordOAuth(
      database as unknown as D1Database,
      environment,
      "https://brobot.example/auth/discord/callback",
      "2026-11-24T10:00:00.000Z",
    );
    const authorization = new URL(started.authorizationUrl);
    const serializedState = authorization.searchParams.get("state") ?? "";

    expect(authorization.searchParams.get("scope")).toBe("identify connections");
    expect([...authorization.searchParams.keys()].sort((left, right) => left.localeCompare(right))).toEqual(["client_id", "redirect_uri", "response_type", "scope", "state"]);
    expect(await verifyDiscordOAuthState(serializedState, "wrong-browser-nonce", keys, "2026-11-24T10:01:00.000Z")).toBeNull();

    const state = await verifyDiscordOAuthState(serializedState, started.stateNonce, keys, "2026-11-24T10:01:00.000Z");
    expect(state).not.toBeNull();
    if (state === null) throw new Error("The Discord OAuth state must verify in its starting browser.");
    await expect(consumeDiscordOAuthTransaction(database as unknown as D1Database, state, "2026-11-24T10:01:00.000Z"))
      .resolves.toBe(true);
    await expect(consumeDiscordOAuthTransaction(database as unknown as D1Database, state, "2026-11-24T10:01:01.000Z"))
      .resolves.toBe(false);
    expect(await verifyDiscordOAuthState(serializedState, started.stateNonce, keys, "2026-11-24T10:10:00.000Z")).toBeNull();
  });
});

describe("Discord API adapter", () => {
  const environment = {
    APP_ENV: "local" as const,
    DISCORD_CLIENT_ID: "fictional-discord-client",
    DISCORD_CLIENT_SECRET: "fictional-discord-secret",
    DISCORD_API_BASE: "http://127.0.0.1:8792/api/v10",
  };

  it("uses the configured API host and asks only for identify and connections", () => {
    const url = new URL(discordAuthorizationUrl(environment, "https://brobot.example/auth/discord/callback", "fictional-state"));

    expect(url.origin).toBe("http://127.0.0.1:8792");
    expect(url.searchParams.get("scope")).toBe("identify connections");
  });

  it("sends token and profile requests to the configured mock base", async () => {
    const requestedUrls: string[] = [];
    const respond = (url: string): Response => {
      requestedUrls.push(url);
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
      return Response.json([{
        id: "141981764", name: "nightowl_dev", type: "twitch", verified: true,
        visibility: 0, friend_sync: false, show_activity: true, two_way_link: false, revoked: false,
      }]);
    };
    const fetcher = vi.fn<typeof fetch>((input) =>
      Promise.resolve(respond(input instanceof Request ? input.url : input.toString())));

    const token = await exchangeDiscordCode(environment, "https://brobot.example/auth/discord/callback", "fictional-code", fetcher);
    const user = await fetchDiscordUser(environment, token.access_token, fetcher);
    const connections = await fetchDiscordConnections(environment, token.access_token, fetcher);

    expect(requestedUrls).toEqual([
      "http://127.0.0.1:8792/api/oauth2/token",
      "http://127.0.0.1:8792/api/v10/users/@me",
      "http://127.0.0.1:8792/api/v10/users/@me/connections",
    ]);
    expect(user).toEqual({ id: "80351110224678912", username: "nightowl" });
    expect(verifiedTwitchConnection(connections)).toEqual({ twitchUserId: "141981764", twitchLogin: "nightowl_dev" });
  });

  it.each([
    { name: "unverified", connection: { id: "141981764", name: "nightowl_dev", type: "twitch", verified: false, revoked: false } },
    { name: "revoked", connection: { id: "141981764", name: "nightowl_dev", type: "twitch", verified: true, revoked: true } },
    { name: "missing", connection: null },
  ])("ignores a $name Twitch connection", ({ connection }) => {
    expect(verifiedTwitchConnection(connection === null ? [] : [connection])).toBeNull();
  });
});

describe("Discord viewer session", () => {
  it("expires the signed viewer cookie after thirty minutes", async () => {
    const session = createDiscordViewerSession("80351110224678912", "2026-11-24T10:00:00.000Z");
    const cookie = await serializeDiscordViewerSession(session, keys);
    const serialized = /__Host-brobot_discord_viewer=([^;]+)/u.exec(cookie)?.[1] ?? null;

    expect(cookie).toContain("Max-Age=1800");
    expect(cookie).toContain("HttpOnly; Secure; SameSite=Lax");
    await expect(readDiscordViewerSession(serialized, keys, "2026-11-24T10:29:59.999Z")).resolves.toMatchObject({
      discordUserId: "80351110224678912",
    });
    await expect(readDiscordViewerSession(serialized, keys, "2026-11-24T10:30:00.000Z")).resolves.toBeNull();
  });
});
