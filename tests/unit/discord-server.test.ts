import { afterEach, describe, expect, it, vi } from "vitest";

import {
  discordServerAuthorizationUrl,
  discordSelectableRoles,
  readDiscordGuildState,
} from "../../src/modules/discord/adapters/discord";
import {
  beginDiscordServerOAuth,
  consumeDiscordServerOAuthTransaction,
  verifyDiscordServerOAuthState,
} from "../../src/worker/auth/discord-server-oauth";
import {
  connectDiscordServer,
  disconnectDiscordServer,
  getDiscordServerConnection,
  getDiscordRoleMappings,
  saveDiscordRoleMappings,
} from "../../src/modules/discord/repository";
import { insertChannel, testKey } from "./fixtures";
import { TestD1Database } from "./test-d1";

const ORIGIN = "https://brobot.example";
const COOKIE_KEYS = JSON.stringify({ active: { id: "discord-server-state", key: testKey(84) }, retired: [] });
const NOW = "2026-11-26T10:00:00.000Z";
const GUILD_ID = "990000000000000101";
const BOT_USER_ID = "902100000000000001";
const databases: TestD1Database[] = [];

const environment = (db: D1Database) => ({
  APP_ENV: "local" as const,
  DISCORD_CLIENT_ID: "fictional-discord-client",
  DISCORD_CLIENT_SECRET: "fictional-discord-secret",
  DISCORD_API_BASE: "http://discord.example/api/v10",
  DISCORD_BOT_TOKEN: "fictional-discord-bot-token",
  SESSION_COOKIE_KEYS: COOKIE_KEYS,
  DB: db,
});

const role = (id: string, position: number, permissions = "0", managed = false) => ({
  id,
  name: id === GUILD_ID ? "@everyone" : id,
  color: 0,
  hoist: false,
  icon: null,
  unicode_emoji: null,
  position,
  permissions,
  managed,
  mentionable: false,
  flags: 0,
});

const botApi = (options: { status?: number; code?: number; botRoleIds?: string[]; roles?: ReturnType<typeof role>[]; memberStatus?: number } = {}) => {
  const requests: Array<{ url: string; authorization: string | null }> = [];
  const fetcher = vi.fn<typeof fetch>((input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    requests.push({ url, authorization: new Headers(init?.headers).get("Authorization") });
    if (url.endsWith("/users/@me")) return Promise.resolve(Response.json({ id: BOT_USER_ID, username: "brobot_test", bot: true }));
    if (url.endsWith(`/guilds/${GUILD_ID}`) && options.status !== undefined) {
      return Promise.resolve(Response.json({ message: "Unknown Guild", code: options.code ?? 10004 }, { status: options.status }));
    }
    if (url.endsWith(`/guilds/${GUILD_ID}`)) return Promise.resolve(Response.json({ id: GUILD_ID, name: "Lantern Harbor", roles: [] }));
    if (url.endsWith(`/guilds/${GUILD_ID}/roles`)) return Promise.resolve(Response.json(options.roles ?? [
      role(GUILD_ID, 0), role("990000000000000102", 2), role("990000000000000105", 5),
      role("990000000000000104", 5, "268435456", true),
    ]));
    if (url.endsWith(`/guilds/${GUILD_ID}/members/${BOT_USER_ID}`) && options.memberStatus !== undefined) {
      return Promise.resolve(Response.json({ message: "Missing Access", code: 50001 }, { status: options.memberStatus }));
    }
    if (url.endsWith(`/guilds/${GUILD_ID}/members/${BOT_USER_ID}`)) {
      return Promise.resolve(Response.json({ user: { id: BOT_USER_ID, username: "brobot_test", bot: true }, roles: options.botRoleIds ?? ["990000000000000104"] }));
    }
    return Promise.resolve(Response.json({ message: "Unexpected endpoint", code: 0 }, { status: 404 }));
  });
  return { fetcher, requests };
};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const database of databases.splice(0)) database.close();
});

describe("Discord server OAuth state", () => {
  it("binds a short-lived single-use state to channel, member, and browser", async () => {
    const database = new TestD1Database();
    databases.push(database);
    await insertChannel(database, "discord-server-one");
    const configured = environment(database as unknown as D1Database);
    const started = await beginDiscordServerOAuth(configured, "discord-server-one", "member-one", `${ORIGIN}/auth/discord/server/callback`, NOW);
    const url = new URL(started.authorizationUrl);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      scope: "bot",
      permissions: "268435456",
      response_type: "code",
      redirect_uri: `${ORIGIN}/auth/discord/server/callback`,
    });

    const state = await verifyDiscordServerOAuthState(started.state, started.stateNonce, COOKIE_KEYS, NOW);
    expect(state).toMatchObject({ channelId: "discord-server-one", memberUserId: "member-one" });
    if (state === null) throw new Error("The server OAuth state should verify in its starting browser.");
    await expect(consumeDiscordServerOAuthTransaction(configured.DB, state, NOW)).resolves.toMatchObject({
      channelId: "discord-server-one", memberUserId: "member-one",
    });
    await expect(consumeDiscordServerOAuthTransaction(configured.DB, state, NOW)).resolves.toBeNull();
    await expect(verifyDiscordServerOAuthState(started.state, "another-browser", COOKIE_KEYS, NOW)).resolves.toBeNull();
    await expect(verifyDiscordServerOAuthState(started.state, started.stateNonce, COOKIE_KEYS, started.expiresAt)).resolves.toBeNull();
  });
});

describe("Discord server adapter", () => {
  it("uses the dedicated bot invite URL and its callback path", () => {
    const url = new URL(discordServerAuthorizationUrl(environment({} as D1Database), `${ORIGIN}/auth/discord/server/callback`, "signed-state"));
    expect(url.origin).toBe("http://discord.example");
    expect(url.pathname).toBe("/oauth2/authorize");
    expect(url.searchParams.get("scope")).toBe("bot");
    expect(url.searchParams.get("permissions")).toBe("268435456");
    expect(url.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/auth/discord/server/callback`);
  });

  it("computes all connection states with bot role permissions and hierarchy", async () => {
    const configured = environment({} as D1Database);
    const connected = botApi();
    await expect(readDiscordGuildState(configured, GUILD_ID, { vip: "990000000000000102", moderator: null }, connected.fetcher))
      .resolves.toMatchObject({ state: "connected" });
    expect((await readDiscordGuildState(configured, GUILD_ID, { vip: "990000000000000102", moderator: null }, connected.fetcher)).roles.map(({ id }) => id)).toContain("990000000000000102");
    expect(connected.requests.every(({ authorization }) => authorization === "Bot fictional-discord-bot-token")).toBe(true);

    const unknownGuild = botApi({ status: 404, code: 10004 });
    await expect(readDiscordGuildState(configured, GUILD_ID, { vip: null, moderator: null }, unknownGuild.fetcher))
      .resolves.toMatchObject({ state: "bot_removed" });
    const missingAccess = botApi({ memberStatus: 403 });
    await expect(readDiscordGuildState(configured, GUILD_ID, { vip: null, moderator: null }, missingAccess.fetcher))
      .resolves.toMatchObject({ state: "bot_removed" });

    const permissionsMissing = botApi({ roles: [role(GUILD_ID, 0), role("990000000000000104", 5, "0", true)] });
    await expect(readDiscordGuildState(configured, GUILD_ID, { vip: null, moderator: null }, permissionsMissing.fetcher))
      .resolves.toMatchObject({ state: "permissions_missing" });
    const administrator = botApi({ roles: [role(GUILD_ID, 0), role("990000000000000104", 5, "8", true)] });
    await expect(readDiscordGuildState(configured, GUILD_ID, { vip: null, moderator: null }, administrator.fetcher))
      .resolves.toMatchObject({ state: "connected" });
    const roleTooLow = botApi();
    await expect(readDiscordGuildState(configured, GUILD_ID, { vip: "990000000000000105", moderator: null }, roleTooLow.fetcher))
      .resolves.toMatchObject({ state: "role_too_low" });
    await expect(readDiscordGuildState(configured, GUILD_ID, { vip: null, moderator: null }, vi.fn<typeof fetch>(() => Promise.reject(new Error("timeout")))))
      .resolves.toMatchObject({ state: "could_not_check" });
  });

  it("excludes @everyone and managed roles from selectable mappings", () => {
    const roles = [role(GUILD_ID, 0), role("990000000000000106", 1), role("990000000000000107", 2, "0", true)];
    expect(discordSelectableRoles(roles, GUILD_ID).map(({ id }) => id)).toEqual(["990000000000000106"]);
  });
});

describe("Discord server repository", () => {
  it("keeps one guild per channel, rejects a guild claimed by another channel, and persists raw role ids", async () => {
    const database = new TestD1Database();
    databases.push(database);
    await insertChannel(database, "discord-server-one");
    await insertChannel(database, "discord-server-two");
    const first = await connectDiscordServer(database as unknown as D1Database, {
      channelId: "discord-server-one", guildId: GUILD_ID, connectedBy: "member-one", connectedAt: NOW,
    });
    expect(first).toBe("connected");
    await saveDiscordRoleMappings(database as unknown as D1Database, "discord-server-one", { vip: "990000000000000102", moderator: null }, NOW);

    const duplicate = await connectDiscordServer(database as unknown as D1Database, {
      channelId: "discord-server-two", guildId: GUILD_ID, connectedBy: "member-two", connectedAt: NOW,
    });
    expect(duplicate).toBe("already_connected");
    await expect(getDiscordServerConnection(database as unknown as D1Database, "discord-server-one"))
      .resolves.toMatchObject({ guildId: GUILD_ID, connectedBy: "member-one" });
    await expect(getDiscordServerConnection(database as unknown as D1Database, "discord-server-two")).resolves.toBeNull();
    await expect(getDiscordRoleMappings(database as unknown as D1Database, "discord-server-one"))
      .resolves.toEqual({ vip: "990000000000000102", moderator: null });

    await disconnectDiscordServer(database as unknown as D1Database, "discord-server-one");
    await expect(getDiscordServerConnection(database as unknown as D1Database, "discord-server-one")).resolves.toBeNull();
    await expect(getDiscordRoleMappings(database as unknown as D1Database, "discord-server-one"))
      .resolves.toEqual({ vip: null, moderator: null });
  });

  it("replaces a channel's previous server and clears its role mappings", async () => {
    const database = new TestD1Database();
    databases.push(database);
    await insertChannel(database, "discord-server-replacement");
    await connectDiscordServer(database as unknown as D1Database, {
      channelId: "discord-server-replacement", guildId: GUILD_ID, connectedBy: "member-one", connectedAt: NOW,
    });
    await saveDiscordRoleMappings(database as unknown as D1Database, "discord-server-replacement", {
      vip: "990000000000000102", moderator: null,
    }, NOW);

    await expect(connectDiscordServer(database as unknown as D1Database, {
      channelId: "discord-server-replacement", guildId: "990000000000000109", connectedBy: "member-one", connectedAt: NOW,
    })).resolves.toBe("connected");
    await expect(getDiscordServerConnection(database as unknown as D1Database, "discord-server-replacement"))
      .resolves.toMatchObject({ guildId: "990000000000000109" });
    await expect(getDiscordRoleMappings(database as unknown as D1Database, "discord-server-replacement"))
      .resolves.toEqual({ vip: null, moderator: null });
  });
});
