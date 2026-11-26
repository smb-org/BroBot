import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleRouteEnvironment } from "../../src/modules/contract";
import { discordServerRoutes } from "../../src/modules/discord/routes";
import { beginDiscordServerOAuth, DISCORD_SERVER_OAUTH_STATE_COOKIE } from "../../src/worker/auth/discord-server-oauth";
import { createSessionCookie } from "../../src/worker/auth/session";
import {
  connectDiscordServer,
  getDiscordRoleMappings,
  getDiscordServerConnection,
  saveDiscordRoleMappings,
} from "../../src/modules/discord/repository";
import { discordRouter } from "../../src/worker/discord/routes";
import { createCsrfToken } from "../../src/worker/auth/csrf";
import { moduleRouter } from "../../src/worker/panel/module-routes";
import { authorizeModuleManagementMutation } from "../../src/worker/module-authorization";
import { insertChannel, insertLoginIdentityAndSession, insertMember, testKey } from "./fixtures";
import { TestD1Database } from "./test-d1";

const ORIGIN = "https://brobot.example";
const SESSION_KEYS = JSON.stringify({ active: { id: "discord-server-route-cookie", key: testKey(85) }, retired: [] });
const ENCRYPTION_KEYS = JSON.stringify({ active: { id: "discord-server-route-encryption", key: testKey(86) }, retired: [] });
const GUILD_ID = "990000000000000101";
const databases: TestD1Database[] = [];

const createEnvironment = (database: TestD1Database, channelObject: Record<string, unknown> = {}): Env => ({
  DB: database as unknown as D1Database,
  PUBLIC_ORIGIN: ORIGIN,
  APP_ENV: "local",
  SESSION_COOKIE_KEYS: SESSION_KEYS,
  TOKEN_ENCRYPTION_KEYS: ENCRYPTION_KEYS,
  DISCORD_CLIENT_ID: "fictional-discord-client",
  DISCORD_CLIENT_SECRET: "fictional-discord-secret",
  DISCORD_BOT_TOKEN: "fictional-discord-bot-token",
  DISCORD_API_BASE: "http://127.0.0.1:8792/api/v10",
  CHANNEL: {
    idFromName: (channelId: string) => channelId,
    get: () => ({
      discordChannelState: () => Promise.resolve({
        teardown: false, disconnecting: false, teardownRemaining: 0, ledgerCount: 0,
        locked: false, serverLocked: false, mappingLocked: false, globalTokenLocked: false,
      }),
      cacheDiscordRoleNames: () => Promise.resolve(undefined),
      readDiscordCachedRoles: () => Promise.resolve([]),
      discordMappingsChanged: () => Promise.resolve(undefined),
      beginDiscordReconcileMutation: () => Promise.resolve("fictional-mutation-token"),
      endDiscordReconcileMutation: () => Promise.resolve(undefined),
      beginDiscordDisconnect: () => Promise.resolve({ deferred: false, remaining: 0 }),
      clearDiscordGuildStateAfterDisconnect: () => Promise.resolve(true),
      cancelImmediateDiscordDisconnect: () => Promise.resolve(undefined),
      lockDiscordServer: () => Promise.resolve(true),
      previewDiscordMappings: () => Promise.resolve({ gain: { count: 0, roleName: "" }, lose: [] }),
      ...channelObject,
    }),
  },
} as unknown as Env);

const memberSession = async (database: TestD1Database, userId: string): Promise<string> => {
  await insertLoginIdentityAndSession(database, userId);
  return await createSessionCookie({ sessionId: `session-${userId}` }, SESSION_KEYS, ENCRYPTION_KEYS);
};

const startServerOAuth = async (
  environment: Env,
  channelId: string,
  memberUserId: string,
  authorization = authorizeModuleManagementMutation(channelId, {
    userId: memberUserId,
    sessionId: `session-${memberUserId}`,
  }, new Date().toISOString()),
) => {
  const now = new Date().toISOString();
  return await beginDiscordServerOAuth(
    environment,
    channelId,
    memberUserId,
    `${ORIGIN}/auth/discord/server/callback`,
    now,
    authorization,
  );
};

const tokenFetcher = (guildId = GUILD_ID) => vi.fn<typeof fetch>(() => Promise.resolve(Response.json({
  access_token: "temporary-bot-invite-token",
  token_type: "Bearer",
  expires_in: 604800,
  refresh_token: "temporary-refresh-token",
  scope: "bot",
  guild: {
    id: guildId,
    name: "Lantern Harbor",
    icon: null,
    owner_id: "990000000000000044",
    roles: [],
  },
})));

const callback = async (
  environment: Env,
  state: string,
  nonce: string,
  sessionCookie: string,
  query = "",
): Promise<Response> => discordRouter.fetch(new Request(
  `${ORIGIN}/auth/discord/server/callback?code=fictional-code&state=${encodeURIComponent(state)}${query}`,
  { headers: { Cookie: `${DISCORD_SERVER_OAUTH_STATE_COOKIE}=${nonce}; __Host-brobot_session=${sessionCookie}` } },
), environment);

const protectedServerRoutes = (memberId = "discord-server-member"): Hono<ModuleRouteEnvironment> => {
  const app = new Hono<ModuleRouteEnvironment>();
  app.use("*", async (context, next) => {
    context.set("channelRole", "manager");
    context.set("session", { userId: memberId, sessionId: `session-${memberId}` });
    context.set("actor", { userId: memberId, sessionId: `session-${memberId}` });
    context.set("authorizeManagementMutation", authorizeModuleManagementMutation);
    await next();
  });
  app.route("/channels/:channelId/discord", discordServerRoutes);
  return app;
};

afterEach(() => {
  vi.unstubAllGlobals();
  for (const database of databases.splice(0)) database.close();
});

describe("Discord server callback", () => {
  it("stores the guild from the token response and ignores appended guild_id and permissions", async () => {
    const database = new TestD1Database();
    databases.push(database);
    const channelId = "discord-server-callback-one";
    const memberId = "discord-server-member-one";
    await insertChannel(database, channelId);
    await insertMember(database, channelId, memberId, "manager");
    const sessionCookie = await memberSession(database, memberId);
    const environment = createEnvironment(database);
    const started = await startServerOAuth(environment, channelId, memberId);
    vi.stubGlobal("fetch", tokenFetcher());

    const response = await callback(environment, started.state, started.stateNonce, sessionCookie,
      `&guild_id=111111111111111111&permissions=0`);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("discord=connected");
    await expect(getDiscordServerConnection(environment.DB, channelId)).resolves.toMatchObject({ guildId: GUILD_ID, connectedBy: memberId });
    const tables = await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'discord_%'").all<{ name: string }>();
    expect(tables.results.map(({ name }) => name)).not.toContain("discord_server_tokens");
    const connectionColumns = await database.prepare("PRAGMA table_info(discord_guilds)").all<{ name: string }>();
    expect(connectionColumns.results.map(({ name }) => name)).toEqual(["channel_id", "guild_id", "connected_at", "connected_by"]);
  });

  it("does not connect when the member loses management rights during the token exchange", async () => {
    const database = new TestD1Database();
    databases.push(database);
    const channelId = "discord-server-demoted-during-callback";
    const memberId = "discord-server-demoted-member";
    await insertChannel(database, channelId);
    await insertMember(database, channelId, memberId, "manager");
    const sessionCookie = await memberSession(database, memberId);
    const environment = createEnvironment(database);
    const started = await startServerOAuth(environment, channelId, memberId);
    const fetcher = vi.fn<typeof fetch>(async () => {
      await database.prepare("UPDATE channel_members SET role = 'operator' WHERE channel_id = ? AND user_id = ?")
        .bind(channelId, memberId).run();
      return Response.json({
        access_token: "temporary-bot-invite-token",
        token_type: "Bearer",
        expires_in: 604800,
        scope: "bot",
        guild: { id: GUILD_ID, name: "Lantern Harbor", roles: [] },
      });
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await callback(environment, started.state, started.stateNonce, sessionCookie);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("discord=error");
    expect(response.headers.get("location")).not.toContain("discord=connected");
    await expect(getDiscordServerConnection(environment.DB, channelId)).resolves.toBeNull();
    await expect(getDiscordRoleMappings(environment.DB, channelId)).resolves.toEqual({ vip: null, moderator: null });
  });

  it("rejects a second channel claiming the same guild without changing the first connection", async () => {
    const database = new TestD1Database();
    databases.push(database);
    const channels = ["discord-server-owner-one", "discord-server-owner-two"];
    const members = ["discord-server-owner-member-one", "discord-server-owner-member-two"];
    for (const [index, channelId] of channels.entries()) {
      const memberId = members[index];
      if (memberId === undefined) throw new Error("A fixture member is required.");
      await insertChannel(database, channelId);
      await insertMember(database, channelId, memberId, "manager");
    }
    const firstCookie = await memberSession(database, members[0] ?? "");
    const secondCookie = await memberSession(database, members[1] ?? "");
    const environment = createEnvironment(database);
    const first = await startServerOAuth(environment, channels[0] ?? "", members[0] ?? "");
    const second = await startServerOAuth(environment, channels[1] ?? "", members[1] ?? "");
    vi.stubGlobal("fetch", tokenFetcher());

    const firstResponse = await callback(environment, first.state, first.stateNonce, firstCookie);
    const firstConnection = await getDiscordServerConnection(environment.DB, channels[0] ?? "");
    expect(firstConnection).toMatchObject({ guildId: GUILD_ID, connectedBy: members[0] });
    const secondResponse = await callback(environment, second.state, second.stateNonce, secondCookie);

    expect(firstResponse.headers.get("location")).toContain("discord=connected");
    expect(secondResponse.headers.get("location")).toContain("discord=already-connected");
    await expect(getDiscordServerConnection(environment.DB, channels[0] ?? "")).resolves.toEqual(firstConnection);
    await expect(getDiscordServerConnection(environment.DB, channels[1] ?? "")).resolves.toBeNull();
  });

  it("rejects a disconnect without a CSRF token through the real panel guard", async () => {
    const database = new TestD1Database();
    databases.push(database);
    const channelId = "discord-server-guard";
    const memberId = "discord-server-guard-member";
    await insertChannel(database, channelId);
    await insertMember(database, channelId, memberId, "manager");
    const sessionCookie = await memberSession(database, memberId);
    const environment = createEnvironment(database);
    const connectedAt = new Date().toISOString();
    await database.prepare(
      "INSERT INTO discord_guilds (channel_id, guild_id, connected_at, connected_by) VALUES (?, ?, ?, ?)",
    ).bind(channelId, GUILD_ID, connectedAt, memberId).run();
    const csrf = await createCsrfToken(`session-${memberId}`, SESSION_KEYS, new Date().toISOString());
    const send = (token: string | null) => moduleRouter.fetch(new Request(
      `${ORIGIN}/api/channels/${channelId}/modules/discord/server/disconnect`,
      {
        method: "POST",
        headers: {
          Origin: ORIGIN,
          Cookie: `__Host-brobot_session=${sessionCookie}; __Host-brobot_csrf=${csrf}`,
          "Content-Type": "application/json",
          ...(token === null ? {} : { "X-CSRF-Token": token }),
        },
        body: JSON.stringify({ guildId: GUILD_ID, connectedAt }),
      },
    ), environment);

    expect((await send(null)).status).toBe(403);
    await expect(getDiscordServerConnection(environment.DB, channelId)).resolves.toMatchObject({ guildId: GUILD_ID });
    expect((await send(csrf)).status).toBe(204);
    await expect(getDiscordServerConnection(environment.DB, channelId)).resolves.toBeNull();
  });

  it("does not disconnect a replacement connection after a stale disconnect request", async () => {
    const database = new TestD1Database();
    databases.push(database);
    const channelId = "discord-server-stale-disconnect";
    const memberId = "discord-server-stale-disconnect-member";
    const originalConnectedAt = "2026-11-26T10:00:00.000Z";
    const replacementConnectedAt = "2026-11-26T10:30:00.000Z";
    await insertChannel(database, channelId);
    await insertMember(database, channelId, memberId, "manager");
    await insertLoginIdentityAndSession(database, memberId);
    await database.prepare(
      "INSERT INTO discord_guilds (channel_id, guild_id, connected_at, connected_by) VALUES (?, ?, ?, ?)",
    ).bind(channelId, GUILD_ID, replacementConnectedAt, memberId).run();
    const beginDiscordDisconnect = vi.fn(() => Promise.resolve({ deferred: false, remaining: 0 }));
    const environment = createEnvironment(database, { beginDiscordDisconnect });

    const response = await protectedServerRoutes(memberId).fetch(new Request(
      `${ORIGIN}/channels/${channelId}/discord/server/disconnect`,
      {
        method: "POST",
        headers: { Origin: ORIGIN, "Content-Type": "application/json" },
        body: JSON.stringify({ guildId: GUILD_ID, connectedAt: originalConnectedAt }),
      },
    ), environment);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "discord_server_changed" });
    await expect(getDiscordServerConnection(environment.DB, channelId))
      .resolves.toMatchObject({ guildId: GUILD_ID, connectedAt: replacementConnectedAt });
    expect(beginDiscordDisconnect).not.toHaveBeenCalled();
  });

  it.each([
    { name: "a different member", stateMember: "discord-server-starter", callbackMember: "discord-server-caller", callbackChannel: "discord-server-state-channel", memberChannel: "discord-server-state-channel" },
    { name: "a different channel", stateMember: "discord-server-channel-member", callbackMember: "discord-server-channel-member", callbackChannel: "discord-server-state-channel", memberChannel: "discord-server-other-channel" },
  ])("rejects state used by $name", async ({ stateMember, callbackMember, callbackChannel, memberChannel }) => {
    const database = new TestD1Database();
    databases.push(database);
    await insertChannel(database, callbackChannel);
    if (memberChannel !== callbackChannel) await insertChannel(database, memberChannel);
    if (memberChannel === callbackChannel) await insertMember(database, callbackChannel, stateMember, "manager");
    if (callbackMember !== stateMember || memberChannel !== callbackChannel) {
      await insertMember(database, memberChannel, callbackMember, "manager");
    }
    if (callbackMember !== stateMember) await insertLoginIdentityAndSession(database, stateMember);
    const sessionCookie = await memberSession(database, callbackMember);
    const environment = createEnvironment(database);
    const started = await startServerOAuth(
      environment,
      callbackChannel,
      stateMember,
      memberChannel === callbackChannel
        ? authorizeModuleManagementMutation(callbackChannel, { userId: stateMember, sessionId: `session-${stateMember}` }, new Date().toISOString())
        : { sql: "AND 1 = 1", values: [] },
    );
    const fetcher = tokenFetcher();
    vi.stubGlobal("fetch", fetcher);

    const response = await callback(environment, started.state, started.stateNonce, sessionCookie);

    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
    await expect(getDiscordServerConnection(environment.DB, callbackChannel)).resolves.toBeNull();
  });

  it.each([
    { name: "bot token", overrides: { DISCORD_BOT_TOKEN: "" } },
    { name: "client id", overrides: { DISCORD_CLIENT_ID: "" } },
    { name: "client secret", overrides: { DISCORD_CLIENT_SECRET: "" } },
  ])("returns a neutral unavailable state when the $name is missing", async ({ overrides }) => {
    const database = new TestD1Database();
    databases.push(database);
    const environment = { ...createEnvironment(database), ...overrides } as Env;

    const response = await discordServerRoutes.fetch(new Request(`${ORIGIN}/server`), environment);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ configured: false, state: "not_available" });
  });

  it("requires the panel Origin before disconnecting and deletes the connection and mapping", async () => {
    const database = new TestD1Database();
    databases.push(database);
    const channelId = "discord-server-disconnect";
    await insertChannel(database, channelId);
    await insertMember(database, channelId, "discord-server-member", "manager");
    await insertLoginIdentityAndSession(database, "discord-server-member");
    const environment = createEnvironment(database);
    const connectedAt = new Date().toISOString();
    await database.prepare(
      "INSERT INTO discord_guilds (channel_id, guild_id, connected_at, connected_by) VALUES (?, ?, ?, ?)",
    ).bind(channelId, GUILD_ID, connectedAt, "discord-server-member").run();
    await database.prepare(
      "INSERT INTO discord_role_mappings (channel_id, rank_type, role_id, updated_at) VALUES (?, 'vip', ?, ?)",
    ).bind(channelId, "990000000000000102", new Date().toISOString()).run();
    const app = protectedServerRoutes();
    const send = (origin: string | null) => app.fetch(new Request(
      `${ORIGIN}/channels/${channelId}/discord/server/disconnect`,
      {
        method: "POST",
        headers: { ...(origin === null ? {} : { Origin: origin }), "Content-Type": "application/json" },
        body: JSON.stringify({ guildId: GUILD_ID, connectedAt }),
      },
    ), environment);

    expect((await send("https://attacker.example")).status).toBe(403);
    expect((await send(null)).status).toBe(403);
    await expect(getDiscordServerConnection(environment.DB, channelId)).resolves.toMatchObject({ guildId: GUILD_ID });
    await expect(database.prepare("SELECT count(*) AS count FROM discord_role_mappings WHERE channel_id = ?")
      .bind(channelId).first()).resolves.toEqual({ count: 1 });
    expect((await send(ORIGIN)).status).toBe(204);
    await expect(getDiscordServerConnection(environment.DB, channelId)).resolves.toBeNull();
    const mappings = await database.prepare("SELECT count(*) AS count FROM discord_role_mappings WHERE channel_id = ?").bind(channelId).first<{ count: number }>();
    expect(mappings?.count).toBe(0);
  });

  it("rejects mappings fetched before the same guild reconnects during the fetch", async () => {
    const database = new TestD1Database();
    databases.push(database);
    const channelId = "discord-server-reconnect-during-mapping-save";
    const memberId = "discord-server-mapping-member";
    const guildA = "990000000000000111";
    const reconnectedAt = "2026-11-26T10:30:00.000Z";
    const connectedAt = "2026-11-26T10:00:00.000Z";
    const selectableRole = "990000000000000113";
    const botRole = "990000000000000114";
    const oldRole = "990000000000000116";
    await insertChannel(database, channelId);
    await insertMember(database, channelId, memberId, "manager");
    await insertLoginIdentityAndSession(database, memberId);
    const cacheDiscordRoleNames = vi.fn(() => Promise.resolve(undefined));
    const environment = createEnvironment(database, { cacheDiscordRoleNames });
    const actor = { userId: memberId, sessionId: `session-${memberId}` };
    await connectDiscordServer(environment.DB, {
      channelId, guildId: guildA, connectedAt, connectedBy: memberId,
    }, authorizeModuleManagementMutation(channelId, actor, new Date().toISOString()));
    await saveDiscordRoleMappings(environment.DB, channelId, guildA, connectedAt, {
      vip: oldRole, moderator: null,
    }, new Date().toISOString(), authorizeModuleManagementMutation(channelId, actor, new Date().toISOString()));

    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/users/@me")) return Response.json({ id: "990000000000000115", username: "bot_fixture" });
      if (url.endsWith(`/guilds/${guildA}`)) return Response.json({ id: guildA, name: "Guild A" });
      if (url.endsWith(`/guilds/${guildA}/roles`)) {
        await database.prepare("DELETE FROM discord_guilds WHERE channel_id = ?").bind(channelId).run();
        await connectDiscordServer(environment.DB, {
          channelId, guildId: guildA, connectedAt: reconnectedAt, connectedBy: memberId,
        }, authorizeModuleManagementMutation(channelId, actor, new Date().toISOString()));
        return Response.json([
          { id: guildA, name: "@everyone", position: 0, permissions: "0", managed: false },
          { id: selectableRole, name: "VIP", position: 1, permissions: "0", managed: false },
          { id: botRole, name: "BroBot", position: 5, permissions: "268435456", managed: true },
        ]);
      }
      if (url.endsWith(`/guilds/${guildA}/members/990000000000000115`)) {
        return Response.json({ user: { id: "990000000000000115" }, roles: [botRole] });
      }
      return Response.json({ message: "Unexpected Discord request", code: 0 }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await protectedServerRoutes(memberId).fetch(new Request(`${ORIGIN}/channels/${channelId}/discord/server/mappings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guildId: guildA, vip: selectableRole, moderator: null }),
    }), environment);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "discord_server_changed" });
    expect(cacheDiscordRoleNames).not.toHaveBeenCalled();
    await expect(getDiscordServerConnection(environment.DB, channelId)).resolves.toMatchObject({ guildId: guildA, connectedAt: reconnectedAt });
    await expect(getDiscordRoleMappings(environment.DB, channelId)).resolves.toEqual({ vip: null, moderator: null });
  });

  it("allows another mapping to change while preserving an unchanged role that Discord deleted", async () => {
    const database = new TestD1Database();
    databases.push(database);
    const channelId = "discord-server-preserve-deleted-role";
    const memberId = "discord-server-preserve-member";
    const guildId = "990000000000000121";
    const connectedAt = "2026-11-26T10:00:00.000Z";
    const deletedRole = "990000000000000122";
    const moderatorRole = "990000000000000123";
    const botRole = "990000000000000124";
    const botId = "990000000000000125";
    await insertChannel(database, channelId);
    await insertMember(database, channelId, memberId, "manager");
    await insertLoginIdentityAndSession(database, memberId);
    const discordMappingsChanged = vi.fn().mockResolvedValue(undefined);
    const environment = createEnvironment(database, { discordMappingsChanged });
    const actor = { userId: memberId, sessionId: `session-${memberId}` };
    await connectDiscordServer(environment.DB, {
      channelId, guildId, connectedAt, connectedBy: memberId,
    }, authorizeModuleManagementMutation(channelId, actor, new Date().toISOString()));
    await saveDiscordRoleMappings(environment.DB, channelId, guildId, connectedAt, {
      vip: deletedRole, moderator: null,
    }, new Date().toISOString(), authorizeModuleManagementMutation(channelId, actor, new Date().toISOString()));
    const respond = (input: RequestInfo | URL): Response => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/users/@me")) return Response.json({ id: botId, username: "fixture_bot" });
      if (url.endsWith(`/guilds/${guildId}`)) return Response.json({ id: guildId, name: "Fixture Harbor" });
      if (url.endsWith(`/guilds/${guildId}/roles`)) return Response.json([
        { id: guildId, name: "@everyone", position: 0, permissions: "0", managed: false },
        { id: moderatorRole, name: "Moderators", position: 1, permissions: "0", managed: false },
        { id: botRole, name: "BroBot", position: 5, permissions: "268435456", managed: true },
      ]);
      if (url.endsWith(`/guilds/${guildId}/members/${botId}`)) {
        return Response.json({ user: { id: botId }, roles: [botRole] });
      }
      return Response.json({ code: 0, message: "Unexpected Discord request" }, { status: 404 });
    };
    vi.stubGlobal("fetch", vi.fn<typeof fetch>((input) => Promise.resolve(respond(input))));

    const response = await protectedServerRoutes(memberId).fetch(new Request(
      `${ORIGIN}/channels/${channelId}/discord/server/mappings`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ guildId, vip: deletedRole, moderator: moderatorRole }),
      },
    ), environment);

    expect(response.status).toBe(200);
    await expect(getDiscordRoleMappings(environment.DB, channelId))
      .resolves.toEqual({ vip: deletedRole, moderator: moderatorRole });
    expect(discordMappingsChanged).toHaveBeenCalledWith(
      { vip: deletedRole, moderator: null },
      { vip: deletedRole, moderator: moderatorRole },
      expect.any(Array),
    );
  });
});
