import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleAlarmContext } from "../../src/modules/contract";
import { discordReconcileAlarm } from "../../src/modules/discord/reconcile";
import { saveDiscordRoleMappings } from "../../src/modules/discord/repository";
import {
  countDiscordGrants,
  cancelDiscordTeardownBeforeEnable,
  clearDiscordLifecycle,
  clearDiscordMappingLocksForChangedMappings,
  ensureDiscordDurableSchema,
  insertDiscordPendingGrant,
  markDiscordGrantGranted,
  readDiscordGrants,
  readDiscordLifecycle,
  readDiscordMappingLocks,
  readDiscordRetryAt,
  setDiscordLifecycle,
  setDiscordMappingLock,
  setDiscordServerLock,
} from "../../src/modules/discord/durable";
import { setDiscordBotTokenLock } from "../../src/worker/discord/token-lock";
import { TestD1Database } from "./test-d1";
import { insertChannel } from "./fixtures";

const CHANNEL_ID = "discord-reconcile-channel-fictional";
const GUILD_ID = "990000000000000101";
const DISCORD_USER_ID = "990000000000000201";
const TWITCH_USER_ID = "990000000000000301";
const VIP_ROLE_ID = "990000000000000102";
const BOT_USER_ID = "990000000000000202";

const databases: DatabaseSync[] = [];
const d1Databases: TestD1Database[] = [];

const sqlFor = (): SqlStorage => {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  return {
    exec: <Row extends Record<string, unknown>>(query: string, ...values: SQLInputValue[]) => {
      const statement = database.prepare(query);
      const rows = /^\s*(SELECT|PRAGMA)/iu.test(query) ? statement.all(...values) as Row[] : (statement.run(...values), [] as Row[]);
      return { toArray: () => rows, one: () => rows[0] };
    },
  } as unknown as SqlStorage;
};

interface ReconcileHarnessOptions {
  noConnection?: boolean;
  members?: readonly { discordUserId: string; twitchUserId: string; login?: string }[];
  mapping?: { vip: string | null; moderator: string | null };
  rolePresent?: boolean;
  joinedAt?: string;
  canManageRoles?: boolean;
}

const makeHarness = async (options: ReconcileHarnessOptions = {}) => {
  const db = new TestD1Database();
  d1Databases.push(db);
  await insertChannel(db, CHANNEL_ID, "Fictional Channel");
  const mapping = options.mapping ?? { vip: VIP_ROLE_ID, moderator: null };
  if (options.noConnection !== true) {
    await db.prepare(
      "INSERT INTO discord_guilds (channel_id, guild_id, connected_at, connected_by) VALUES (?, ?, ?, ?)",
    ).bind(CHANNEL_ID, GUILD_ID, "2026-11-26T10:00:00.000Z", "fictional-operator").run();
    for (const rankType of ["vip", "moderator"] as const) {
      const roleId = mapping[rankType];
      if (roleId !== null) await db.prepare(
        "INSERT INTO discord_role_mappings (channel_id, rank_type, role_id, updated_at) VALUES (?, ?, ?, ?)",
      ).bind(CHANNEL_ID, rankType, roleId, "2026-11-26T10:00:00.000Z").run();
    }
  }
  const links = options.members ?? [{ discordUserId: DISCORD_USER_ID, twitchUserId: TWITCH_USER_ID, login: "pixelpilot" }];
  for (const link of links) await db.prepare(
    `INSERT INTO discord_links
      (discord_user_id, twitch_user_id, discord_username, twitch_login, linked_at, verified_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(link.discordUserId, link.twitchUserId, "Fictional Viewer", link.login ?? "pixelpilot", "2026-11-26T10:00:00.000Z", "2026-11-26T10:00:00.000Z").run();

  const sql = sqlFor();
  ensureDiscordDurableSchema(sql);
  const managedRoles = new Map<string, Set<string>>();
  let joinedAt = options.joinedAt ?? "2026-11-20T18:30:00.000000+00:00";
  if (options.rolePresent === true) managedRoles.set(DISCORD_USER_ID, new Set([VIP_ROLE_ID]));
  const knownDiscordUsers = new Set(links.map(({ discordUserId }) => discordUserId));
  const rankUsers = {
    vip: new Set(links.map(({ twitchUserId }) => twitchUserId)),
    moderator: new Set<string>(),
  };
  const rankState = {
    vip: { complete: true, userIds: rankUsers.vip },
    moderator: { complete: true, userIds: rankUsers.moderator },
  };
  let dirty = true;
  let generation = 1;
  const nextRuns: number[] = [];
  const diagnostics: unknown[] = [];
  const requestCalls: Array<{ path: string; method: string }> = [];
  let memberError: { status: number; code: number; retryAfterSeconds?: number } | null = null;
  let putError: { status: number; code: number; retryAfterSeconds?: number } | Error | "lost_applied" | "lost_unapplied" | null = null;
  let guildReadError: { status: number; code: number; retryAfterSeconds?: number } | null = null;
  let deferredDisableCalls = 0;
  let jobClaimValid = true;
  const roleState = { manageRoles: options.canManageRoles ?? true };
  const mappedRoleState = { exists: true };

  const respond = (input: RequestInfo | URL, init?: RequestInit): Response => {
    const requestUrl = input instanceof Request ? input.url : input.toString();
    const url = new URL(requestUrl);
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/api\/v10/u, "");
    requestCalls.push({ path, method });
    const memberMatch = new RegExp(`^/guilds/${GUILD_ID}/members/([0-9]{1,20})$`, "u").exec(path);
    if (memberMatch !== null && method === "GET") {
      const userId = memberMatch[1] ?? "";
      if (userId === BOT_USER_ID) return Response.json({
        user: { id: BOT_USER_ID }, roles: ["990000000000000204"], joined_at: "2026-11-20T18:00:00.000000+00:00",
      });
      if (!knownDiscordUsers.has(userId)) return Response.json({ code: 10007, message: "Unknown Member" }, { status: 404 });
      if (memberError !== null) {
        const error = memberError;
        memberError = null;
        return Response.json({ code: error.code, message: "fictional Discord error", ...(error.retryAfterSeconds === undefined ? {} : { retry_after: error.retryAfterSeconds }) }, { status: error.status });
      }
      return Response.json({
        user: { id: userId },
        roles: [...(managedRoles.get(userId) ?? new Set())],
        joined_at: joinedAt,
      });
    }
    const roleMatch = new RegExp(`^/guilds/${GUILD_ID}/members/([0-9]{1,20})/roles/([0-9]{1,20})$`, "u").exec(path);
    if (roleMatch !== null && method === "PUT") {
      const userId = roleMatch[1] ?? "";
      const roleId = roleMatch[2] ?? "";
      if (!knownDiscordUsers.has(userId)) return Response.json({ code: 10007, message: "Unknown Member" }, { status: 404 });
      if (putError === "lost_applied") {
        managedRoles.set(userId, new Set([...(managedRoles.get(userId) ?? []), roleId]));
        putError = null;
        throw new Error("fictional lost response");
      }
      if (putError === "lost_unapplied") {
        putError = null;
        throw new Error("fictional lost response");
      }
      if (putError instanceof Error) {
        const error = putError;
        putError = null;
        throw error;
      }
      if (putError !== null) {
        const error = putError;
        putError = null;
        if (typeof error === "object" && !(error instanceof Error)) return Response.json({ code: error.code, message: "fictional Discord error", ...(error.retryAfterSeconds === undefined ? {} : { retry_after: error.retryAfterSeconds }) }, { status: error.status });
      }
      managedRoles.set(userId, new Set([...(managedRoles.get(userId) ?? []), roleId]));
      return new Response(null, { status: 204 });
    }
    if (roleMatch !== null && method === "DELETE") {
      managedRoles.get(roleMatch[1] ?? "")?.delete(roleMatch[2] ?? "");
      return new Response(null, { status: 204 });
    }
    if (path === "/users/@me" && method === "GET") return Response.json({ id: BOT_USER_ID, username: "brobot_test", bot: true });
    if (path === `/guilds/${GUILD_ID}` && method === "GET") {
      if (guildReadError !== null) {
        const error = guildReadError;
        guildReadError = null;
        return Response.json({ code: error.code, message: "fictional Discord error", ...(error.retryAfterSeconds === undefined ? {} : { retry_after: error.retryAfterSeconds }) }, { status: error.status });
      }
      return Response.json({ id: GUILD_ID, name: "Fictional Harbor" });
    }
    if (path === `/guilds/${GUILD_ID}/roles` && method === "GET") return Response.json([
      { id: GUILD_ID, name: "@everyone", position: 0, permissions: "0", managed: false },
      ...(mappedRoleState.exists ? [{ id: VIP_ROLE_ID, name: "VIP", position: 2, permissions: "0", managed: false }] : []),
      { id: "990000000000000204", name: "Bot", position: 3, permissions: roleState.manageRoles ? "268435456" : "0", managed: true },
    ]);
    if (path === `/guilds/${GUILD_ID}/members/${BOT_USER_ID}` && method === "GET") return Response.json({
      user: { id: BOT_USER_ID }, roles: ["990000000000000204"], joined_at: "2026-11-20T18:00:00.000000+00:00",
    });
    return Response.json({ code: 0, message: "fictional unexpected endpoint" }, { status: 404 });
  };
  const fakeFetch = vi.fn<typeof fetch>((input, init) => Promise.resolve(respond(input, init)));
  vi.stubGlobal("fetch", fakeFetch);

  const context = {
    DB: db as unknown as D1Database,
    environment: {
      APP_ENV: "local",
      DISCORD_API_BASE: "http://discord.example/api/v10",
      DISCORD_BOT_TOKEN: "fictional-discord-bot-token",
    },
    channelId: CHANNEL_ID,
    channelJob: {
      jobId: "module:discord:reconcile",
      claimToken: "fictional-claim-token",
      isCurrent: () => jobClaimValid,
      assertCurrent: () => { if (!jobClaimValid) throw new Error("fictional revoked channel-job claim"); },
      commit: (write: (storage: SqlStorage) => void) => {
        if (!jobClaimValid) return false;
        write(sql);
        return true;
      },
      scheduleNextAt: (deadline: number) => { nextRuns.push(deadline); },
    },
    twitchRanks: {
      getTwitchRanks: (rankType: "vip" | "moderator") => Promise.resolve({
        available: true,
        complete: rankState[rankType].complete,
        userIds: new Set(rankState[rankType].userIds),
      }),
      isDirty: () => Promise.resolve({ dirty, generation }),
      markReconciled: (seenGeneration: number) => {
        if (seenGeneration !== generation) return false;
        dirty = false;
        return true;
      },
    },
    writeDiagnostics: (_triggerId: string, values: readonly unknown[]) => {
      diagnostics.push(...values);
      return Promise.resolve();
    },
    completeDeferredModuleDisable: () => {
      deferredDisableCalls += 1;
      clearDiscordLifecycle(sql);
      jobClaimValid = false;
      return Promise.resolve(true);
    },
  } as unknown as ModuleAlarmContext;

  return {
    context,
    db,
    sql,
    managedRoles,
    rankState,
    nextRuns,
    diagnostics,
    requestCalls,
    fakeFetch,
    setMemberError: (error: { status: number; code: number; retryAfterSeconds?: number } | null) => { memberError = error; },
    setPutError: (error: typeof putError) => { putError = error; },
    setGuildReadError: (error: typeof guildReadError) => { guildReadError = error; },
    setDirty: (value: boolean) => { dirty = value; if (value) generation += 1; },
    setRankUsers: (rankType: "vip" | "moderator", users: readonly string[], complete = true) => {
      rankState[rankType] = { complete, userIds: new Set(users) };
      dirty = true;
      generation += 1;
    },
    setRankCompleteness: (rankType: "vip" | "moderator", complete: boolean) => {
      rankState[rankType] = { ...rankState[rankType], complete };
    },
    setManageRoles: (value: boolean) => { roleState.manageRoles = value; },
    setRoleExists: (value: boolean) => { mappedRoleState.exists = value; },
    setJoinedAt: (value: string) => { joinedAt = value; },
    deferredDisableCalls: () => deferredDisableCalls,
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const database of databases.splice(0)) database.close();
  for (const database of d1Databases.splice(0)) database.sqlite.close();
});

describe("Discord channel job reconciliation", () => {
  it("grants a missing mapped role, records it, and removes it after a complete rank loss", async () => {
    const harness = await makeHarness();

    await discordReconcileAlarm(harness.context);
    expect(harness.managedRoles.get(DISCORD_USER_ID)?.has(VIP_ROLE_ID)).toBe(true);
    expect(readDiscordGrants(harness.sql, GUILD_ID)).toMatchObject([{ status: "granted", roleId: VIP_ROLE_ID, twitchUserId: TWITCH_USER_ID }]);

    harness.setRankUsers("vip", []);
    await discordReconcileAlarm(harness.context);
    expect(harness.managedRoles.get(DISCORD_USER_ID)?.has(VIP_ROLE_ID)).toBe(false);
    expect(countDiscordGrants(harness.sql, GUILD_ID)).toBe(0);
    expect(harness.requestCalls.filter(({ method }) => method === "DELETE")).toHaveLength(1);
  });

  it("leaves a manually present role without a ledger row and never removes it", async () => {
    const harness = await makeHarness({ rolePresent: true });

    await discordReconcileAlarm(harness.context);
    expect(countDiscordGrants(harness.sql, GUILD_ID)).toBe(0);
    harness.setRankUsers("vip", []);
    await discordReconcileAlarm(harness.context);

    expect(harness.managedRoles.get(DISCORD_USER_ID)?.has(VIP_ROLE_ID)).toBe(true);
    expect(harness.requestCalls.filter(({ method }) => method === "DELETE")).toHaveLength(0);
  });

  it("resolves a lost PUT response from the next member read without losing ownership", async () => {
    const harness = await makeHarness();
    harness.setPutError("lost_applied");

    await discordReconcileAlarm(harness.context);
    expect(readDiscordGrants(harness.sql, GUILD_ID)).toMatchObject([{ status: "pending", roleId: VIP_ROLE_ID }]);
    await discordReconcileAlarm(harness.context);

    expect(readDiscordGrants(harness.sql, GUILD_ID)).toMatchObject([{ status: "granted", roleId: VIP_ROLE_ID }]);
    expect(harness.requestCalls.filter(({ method }) => method === "PUT")).toHaveLength(1);
  });

  it("drops an unapplied pending grant after the member read proves the role absent", async () => {
    const harness = await makeHarness();
    harness.setPutError("lost_unapplied");
    await discordReconcileAlarm(harness.context);
    expect(countDiscordGrants(harness.sql, GUILD_ID)).toBe(1);

    harness.setRankUsers("vip", []);
    await discordReconcileAlarm(harness.context);
    expect(countDiscordGrants(harness.sql, GUILD_ID)).toBe(0);
    expect(harness.managedRoles.get(DISCORD_USER_ID)?.has(VIP_ROLE_ID) ?? false).toBe(false);
    expect(harness.requestCalls.filter(({ method }) => method === "DELETE")).toHaveLength(0);
  });

  it("drops an owned grant after leave and rejoin without deleting the role", async () => {
    const harness = await makeHarness();
    await discordReconcileAlarm(harness.context);
    harness.setJoinedAt("2026-11-25T08:00:00.000000+00:00");
    harness.setRankUsers("vip", []);

    await discordReconcileAlarm(harness.context);

    expect(countDiscordGrants(harness.sql, GUILD_ID)).toBe(0);
    expect(harness.managedRoles.get(DISCORD_USER_ID)?.has(VIP_ROLE_ID)).toBe(true);
    expect(harness.requestCalls.filter(({ method }) => method === "DELETE")).toHaveLength(0);
  });

  it("keeps a missing member for the next run and removes all of that member's guild ledger rows", async () => {
    const harness = await makeHarness({ mapping: { vip: VIP_ROLE_ID, moderator: "990000000000000205" } });
    insertDiscordPendingGrant(harness.sql, {
      guildId: GUILD_ID, discordUserId: DISCORD_USER_ID, twitchUserId: TWITCH_USER_ID, roleId: VIP_ROLE_ID,
      joinedAt: "2026-11-20T18:30:00.000000+00:00",
    });
    insertDiscordPendingGrant(harness.sql, {
      guildId: GUILD_ID, discordUserId: DISCORD_USER_ID, twitchUserId: TWITCH_USER_ID, roleId: "990000000000000205",
      joinedAt: "2026-11-20T18:30:00.000000+00:00",
    });
    harness.setRankUsers("moderator", [TWITCH_USER_ID]);
    harness.setMemberError({ status: 404, code: 10007 });

    await discordReconcileAlarm(harness.context);

    expect(countDiscordGrants(harness.sql, GUILD_ID)).toBe(0);
    expect(harness.requestCalls.filter(({ method, path }) => method === "GET" && path.includes("/members/") && !path.endsWith(BOT_USER_ID))).toHaveLength(1);
  });

  it("drops all guild ownership when a role write reports that the member left", async () => {
    const harness = await makeHarness();
    harness.setPutError({ status: 404, code: 10007 });

    await discordReconcileAlarm(harness.context);

    expect(countDiscordGrants(harness.sql, GUILD_ID)).toBe(0);
    expect(harness.requestCalls.filter(({ method }) => method === "DELETE")).toHaveLength(0);
    expect(harness.requestCalls.filter(({ method }) => method === "PUT")).toHaveLength(1);
  });

  it("keeps a shared VIP and moderator role while either mapped rank is incomplete", async () => {
    const harness = await makeHarness({ mapping: { vip: VIP_ROLE_ID, moderator: VIP_ROLE_ID }, rolePresent: true });
    insertDiscordPendingGrant(harness.sql, {
      guildId: GUILD_ID, discordUserId: DISCORD_USER_ID, twitchUserId: TWITCH_USER_ID, roleId: VIP_ROLE_ID,
      joinedAt: "2026-11-20T18:30:00.000000+00:00",
    });
    harness.setRankUsers("vip", [], true);
    harness.setRankUsers("moderator", [], false);

    await discordReconcileAlarm(harness.context);

    expect(countDiscordGrants(harness.sql, GUILD_ID)).toBe(1);
    expect(harness.managedRoles.get(DISCORD_USER_ID)?.has(VIP_ROLE_ID)).toBe(true);
    expect(harness.requestCalls.filter(({ method }) => method === "DELETE")).toHaveLength(0);
  });

  it("retries a Discord 429 after the exact retry_after delay without returning a job error", async () => {
    const harness = await makeHarness();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T10:00:00.000Z"));
    harness.setMemberError({ status: 429, code: 20028, retryAfterSeconds: 2.75 });
    const startedAt = Date.now();

    const result = await discordReconcileAlarm(harness.context);

    expect(result).toHaveProperty("summary");
    expect(harness.nextRuns).toContain(startedAt + 2_750);
    expect(readDiscordGrants(harness.sql, GUILD_ID)).toEqual([]);
  });

  it("holds a 50013 permission probe until the exact Discord retry deadline", async () => {
    const harness = await makeHarness();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T10:00:00.000Z"));
    harness.setPutError({ status: 403, code: 50013 });
    harness.setGuildReadError({ status: 429, code: 20028, retryAfterSeconds: 2.75 });
    const startedAt = Date.now();

    await expect(discordReconcileAlarm(harness.context)).resolves.toHaveProperty("summary");
    expect(readDiscordRetryAt(harness.sql)).toBe(startedAt + 2_750);
    const callsBeforeEarlyRun = harness.requestCalls.length;
    await discordReconcileAlarm(harness.context);
    expect(harness.requestCalls).toHaveLength(callsBeforeEarlyRun);

    await vi.advanceTimersByTimeAsync(2_750);
    await discordReconcileAlarm(harness.context);
    expect(harness.requestCalls.filter(({ path }) => path === `/guilds/${GUILD_ID}`)).toHaveLength(2);
  });

  it("drops a rejected pending PUT so a later manual role is not adopted", async () => {
    const harness = await makeHarness();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T10:00:00.000Z"));
    const previousGrant = {
      guildId: GUILD_ID,
      discordUserId: DISCORD_USER_ID,
      twitchUserId: TWITCH_USER_ID,
      roleId: VIP_ROLE_ID,
      joinedAt: "2026-11-20T18:30:00.000000+00:00",
    };
    insertDiscordPendingGrant(harness.sql, previousGrant);
    markDiscordGrantGranted(harness.sql, previousGrant, Date.now() - 1_000);
    harness.setPutError({ status: 429, code: 20028, retryAfterSeconds: 2.75 });
    const startedAt = Date.now();

    await expect(discordReconcileAlarm(harness.context)).resolves.toHaveProperty("summary");
    expect(harness.nextRuns).toContain(startedAt + 2_750);
    expect(readDiscordGrants(harness.sql, GUILD_ID)).toEqual([]);

    harness.managedRoles.set(DISCORD_USER_ID, new Set([VIP_ROLE_ID]));
    await vi.advanceTimersByTimeAsync(2_750);
    await discordReconcileAlarm(harness.context);

    expect(readDiscordGrants(harness.sql, GUILD_ID)).toEqual([]);
    expect(harness.requestCalls.filter(({ method }) => method === "DELETE")).toHaveLength(0);
  });

  it("locks the global token after 401 and probes again after sixty minutes", async () => {
    const harness = await makeHarness();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T10:00:00.000Z"));
    harness.setMemberError({ status: 401, code: 0 });
    const firstRunAt = Date.now();

    await expect(discordReconcileAlarm(harness.context)).resolves.toMatchObject({ ok: false, code: "discord_token_invalid" });
    const lock = await harness.db.prepare("SELECT locked_at, last_probe_at FROM discord_bot_token_lock WHERE singleton = 1").first<{ locked_at: string; last_probe_at: string }>();
    expect(lock?.last_probe_at).toBe(new Date(firstRunAt).toISOString());
    expect(harness.nextRuns).toContain(firstRunAt + 60 * 60_000);

    await harness.db.prepare("UPDATE discord_bot_token_lock SET last_probe_at = ? WHERE singleton = 1")
      .bind(new Date(Date.now() - 60 * 60_000).toISOString()).run();
    await discordReconcileAlarm(harness.context);

    expect(await harness.db.prepare("SELECT 1 AS present FROM discord_bot_token_lock WHERE singleton = 1").first()).toBeNull();
    expect(harness.requestCalls.filter(({ path }) => path === "/users/@me")).toHaveLength(1);
  });

  it("sets a mapping lock and drops its ledger rows when Discord reports a deleted role", async () => {
    const harness = await makeHarness();
    harness.setPutError({ status: 404, code: 10011 });

    await discordReconcileAlarm(harness.context);

    expect(readDiscordMappingLocks(harness.sql, GUILD_ID)).toMatchObject([{ rankType: "vip", roleId: VIP_ROLE_ID }]);
    expect(countDiscordGrants(harness.sql, GUILD_ID)).toBe(0);
  });

  it("clears a deleted-role lock after a mapping save and reconciles the replacement role", async () => {
    const harness = await makeHarness();
    harness.setPutError({ status: 404, code: 10011 });
    await discordReconcileAlarm(harness.context);
    expect(readDiscordMappingLocks(harness.sql, GUILD_ID)).toMatchObject([{ rankType: "vip", roleId: VIP_ROLE_ID }]);

    const previous = { vip: VIP_ROLE_ID, moderator: null };
    const next = { vip: "990000000000000103", moderator: null };
    await expect(saveDiscordRoleMappings(
      harness.db as unknown as D1Database,
      CHANNEL_ID,
      GUILD_ID,
      "2026-11-26T10:00:00.000Z",
      next,
      "2026-11-26T10:01:00.000Z",
      { sql: "", values: [] },
    )).resolves.toBe("saved");
    const cleared = clearDiscordMappingLocksForChangedMappings(harness.sql, GUILD_ID, previous, next);
    expect(cleared).toMatchObject([{ rankType: "vip", roleId: VIP_ROLE_ID }]);
    expect(readDiscordMappingLocks(harness.sql, GUILD_ID)).toEqual([]);

    harness.setDirty(true);
    await discordReconcileAlarm(harness.context);

    expect(harness.requestCalls.some(({ method, path }) => method === "PUT" && path.endsWith(`/roles/${next.vip}`))).toBe(true);
    expect(harness.managedRoles.get(DISCORD_USER_ID)?.has(next.vip)).toBe(true);
  });

  it("probes a mapping lock every six hours even when it has no member work", async () => {
    const harness = await makeHarness();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T10:00:00.000Z"));
    setDiscordMappingLock(harness.sql, {
      guildId: GUILD_ID,
      rankType: "vip",
      roleId: VIP_ROLE_ID,
      lockedAt: Date.now() - 7 * 60 * 60_000,
      lastProbeAt: Date.now() - 7 * 60 * 60_000,
    });
    harness.setRankUsers("vip", []);

    await discordReconcileAlarm(harness.context);

    expect(readDiscordMappingLocks(harness.sql, GUILD_ID)).toEqual([]);
    expect(harness.requestCalls.filter(({ method }) => method === "GET")).toHaveLength(4);
  });

  it("drops stale ledger entries when a locked role has been deleted", async () => {
    const harness = await makeHarness();
    const grant = { guildId: GUILD_ID, discordUserId: DISCORD_USER_ID, twitchUserId: TWITCH_USER_ID, roleId: VIP_ROLE_ID, joinedAt: "2026-11-20T18:30:00.000000+00:00" };
    insertDiscordPendingGrant(harness.sql, grant);
    markDiscordGrantGranted(harness.sql, grant, 1_000);
    setDiscordMappingLock(harness.sql, {
      guildId: GUILD_ID, rankType: "vip", roleId: VIP_ROLE_ID,
      lockedAt: Date.now() - 7 * 60 * 60_000, lastProbeAt: Date.now() - 7 * 60 * 60_000,
    });
    harness.setRoleExists(false);
    harness.setRankUsers("vip", []);

    await discordReconcileAlarm(harness.context);

    expect(countDiscordGrants(harness.sql, GUILD_ID)).toBe(0);
    expect(readDiscordMappingLocks(harness.sql, GUILD_ID)).toHaveLength(1);
    expect(harness.requestCalls.filter(({ method }) => method === "DELETE")).toHaveLength(0);
  });

  it("locks the server after 50013 when the bot lacks Manage Roles", async () => {
    const harness = await makeHarness();
    harness.setPutError({ status: 403, code: 50013 });
    harness.setManageRoles(false);

    await discordReconcileAlarm(harness.context);

    expect(readDiscordMappingLocks(harness.sql, GUILD_ID)).toHaveLength(1);
    expect(harness.sql.exec<{ guild_id: string; reason: string }>("SELECT guild_id, reason FROM discord_server_locks").toArray())
      .toMatchObject([{ guild_id: GUILD_ID, reason: "permissions_missing" }]);
  });

  it.each([
    { status: 404, code: 10004, reason: "bot_removed" },
    { status: 403, code: 50001, reason: "missing_access" },
  ])("locks the server when a role write reports Discord code $code", async ({ status, code, reason }) => {
    const harness = await makeHarness();
    harness.setPutError({ status, code });

    await discordReconcileAlarm(harness.context);

    expect(harness.sql.exec<{ guild_id: string; reason: string }>(
      "SELECT guild_id, reason FROM discord_server_locks",
    ).toArray()).toEqual([{ guild_id: GUILD_ID, reason }]);
  });

  it("skips a recent server-lock probe and unlocks after six hours when Discord is reachable", async () => {
    const harness = await makeHarness();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T10:00:00.000Z"));
    const lastProbeAt = Date.now();
    setDiscordServerLock(harness.sql, {
      guildId: GUILD_ID,
      lockedAt: lastProbeAt,
      lastProbeAt,
      reason: "bot_removed",
    });

    await discordReconcileAlarm(harness.context);
    expect(harness.fakeFetch).not.toHaveBeenCalled();
    expect(harness.nextRuns).toContain(lastProbeAt + 6 * 60 * 60_000);

    await vi.advanceTimersByTimeAsync(6 * 60 * 60_000);
    await discordReconcileAlarm(harness.context);

    expect(harness.sql.exec("SELECT guild_id FROM discord_server_locks").toArray()).toEqual([]);
    expect(harness.requestCalls.filter(({ path }) => path === "/users/@me")).toHaveLength(1);
  });

  it("limits each invocation to twenty Discord calls and keeps the remaining cursor", async () => {
    const links = Array.from({ length: 11 }, (_, index) => ({
      discordUserId: `990000000000000${String(300 + index).padStart(3, "0")}`,
      twitchUserId: `990000000000000${String(400 + index).padStart(3, "0")}`,
      login: `fictionalviewer${String(index)}`,
    }));
    const harness = await makeHarness({ members: links });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T10:00:00.000Z"));

    await discordReconcileAlarm(harness.context);

    expect(harness.requestCalls).toHaveLength(20);
    expect(harness.nextRuns).toContain(Date.now() + 1_000);
    await discordReconcileAlarm(harness.context);
    expect(harness.requestCalls).toHaveLength(22);
    expect(countDiscordGrants(harness.sql, GUILD_ID)).toBe(11);
  });

  it("revalidates rank completeness before a rank-loss delete in a continuation", async () => {
    const links = Array.from({ length: 11 }, (_, index) => ({
      discordUserId: `990000000000000${String(300 + index).padStart(3, "0")}`,
      twitchUserId: `990000000000000${String(400 + index).padStart(3, "0")}`,
      login: `fictionalviewer${String(index)}`,
    }));
    const harness = await makeHarness({ members: links });
    harness.setRankUsers("vip", [], true);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-26T10:00:00.000Z"));
    for (const link of links) {
      insertDiscordPendingGrant(harness.sql, {
        guildId: GUILD_ID,
        discordUserId: link.discordUserId,
        twitchUserId: link.twitchUserId,
        roleId: VIP_ROLE_ID,
        joinedAt: "2026-11-20T18:30:00.000000+00:00",
      });
      harness.managedRoles.set(link.discordUserId, new Set([VIP_ROLE_ID]));
    }

    await discordReconcileAlarm(harness.context);
    expect(harness.requestCalls.filter(({ method }) => method === "DELETE")).toHaveLength(10);

    harness.setRankCompleteness("vip", false);
    await discordReconcileAlarm(harness.context);

    expect(harness.requestCalls.filter(({ method }) => method === "DELETE")).toHaveLength(10);
    expect(harness.managedRoles.get(links[10]?.discordUserId ?? "")?.has(VIP_ROLE_ID)).toBe(true);
    expect(countDiscordGrants(harness.sql, GUILD_ID)).toBe(1);
  });

  it("removes unlinked grants without waiting for rank completeness", async () => {
    const harness = await makeHarness();
    await discordReconcileAlarm(harness.context);
    await harness.db.prepare("DELETE FROM discord_links WHERE discord_user_id = ?").bind(DISCORD_USER_ID).run();
    harness.setRankUsers("vip", [], false);

    await discordReconcileAlarm(harness.context);

    expect(harness.managedRoles.get(DISCORD_USER_ID)?.has(VIP_ROLE_ID)).toBe(false);
    expect(countDiscordGrants(harness.sql, GUILD_ID)).toBe(0);
  });

  it("disconnects only after the last owned role is removed and makes no later Discord requests", async () => {
    const harness = await makeHarness({ mapping: { vip: VIP_ROLE_ID, moderator: "990000000000000205" } });
    await discordReconcileAlarm(harness.context);
    // Add another role grant and the Discord member state to exercise ordered multi-role cleanup.
    insertDiscordPendingGrant(harness.sql, {
      guildId: GUILD_ID, discordUserId: DISCORD_USER_ID, twitchUserId: TWITCH_USER_ID, roleId: "990000000000000205",
      joinedAt: "2026-11-20T18:30:00.000000+00:00",
    });
    harness.managedRoles.get(DISCORD_USER_ID)?.add("990000000000000205");
    setDiscordLifecycle(harness.sql, {
      mode: "disconnecting", startedAt: Date.now(), actorUserId: null, expectedRevision: null, disconnectMemberUserId: null,
      guildId: GUILD_ID, connectedAt: "2026-11-26T10:00:00.000Z",
    });
    const originalCalls = harness.requestCalls.length;

    await discordReconcileAlarm(harness.context);

    expect(countDiscordGrants(harness.sql, GUILD_ID)).toBe(0);
    expect(harness.requestCalls.slice(originalCalls).filter(({ method }) => method === "DELETE")).toHaveLength(2);
    expect(await harness.db.prepare("SELECT 1 AS present FROM discord_guilds WHERE channel_id = ?").bind(CHANNEL_ID).first()).toBeNull();
    const callsAfterDisconnect = harness.requestCalls.length;
    await discordReconcileAlarm(harness.context);
    expect(harness.requestCalls).toHaveLength(callsAfterDisconnect);
  });

  it("removes all three owned roles before completing deferred module disable", async () => {
    const secondDiscordUserId = "990000000000000206";
    const secondTwitchUserId = "990000000000000306";
    const harness = await makeHarness({ members: [
      { discordUserId: DISCORD_USER_ID, twitchUserId: TWITCH_USER_ID, login: "pixelpilot" },
      { discordUserId: secondDiscordUserId, twitchUserId: secondTwitchUserId, login: "harborwatch" },
    ], mapping: { vip: VIP_ROLE_ID, moderator: "990000000000000207" } });
    harness.managedRoles.set(DISCORD_USER_ID, new Set([VIP_ROLE_ID, "990000000000000208"]));
    harness.managedRoles.set(secondDiscordUserId, new Set(["990000000000000207"]));
    const grants = [
      { discordUserId: DISCORD_USER_ID, twitchUserId: TWITCH_USER_ID, roleId: VIP_ROLE_ID },
      { discordUserId: DISCORD_USER_ID, twitchUserId: TWITCH_USER_ID, roleId: "990000000000000208" },
      { discordUserId: secondDiscordUserId, twitchUserId: secondTwitchUserId, roleId: "990000000000000207" },
    ];
    for (const grant of grants) {
      const row = { ...grant, guildId: GUILD_ID, joinedAt: "2026-11-20T18:30:00.000000+00:00" };
      insertDiscordPendingGrant(harness.sql, row);
      markDiscordGrantGranted(harness.sql, row, 1_000);
    }
    setDiscordLifecycle(harness.sql, {
      mode: "teardown", startedAt: Date.now(), actorUserId: "fictional-manager", expectedRevision: 8, disconnectMemberUserId: null,
      guildId: GUILD_ID, connectedAt: "2026-11-26T10:00:00.000Z",
    });

    await discordReconcileAlarm(harness.context);

    expect(countDiscordGrants(harness.sql, GUILD_ID)).toBe(0);
    expect(harness.requestCalls.filter(({ method }) => method === "DELETE")).toHaveLength(3);
    expect(harness.deferredDisableCalls()).toBe(1);
    expect(harness.requestCalls).toHaveLength(6);
  });

  it.each(["disconnecting", "teardown"] as const)("finishes an empty %s lifecycle without probing a locked Discord token", async (mode) => {
    const harness = await makeHarness();
    const startedAt = Date.now();
    setDiscordLifecycle(harness.sql, {
      mode,
      startedAt,
      deferred: true,
      actorUserId: mode === "teardown" ? "fictional-operator" : null,
      expectedRevision: mode === "teardown" ? 7 : null,
      disconnectMemberUserId: null,
      guildId: GUILD_ID,
      connectedAt: "2026-11-26T10:00:00.000Z",
    });
    await setDiscordBotTokenLock(harness.context.DB, new Date(startedAt).toISOString());

    const result = await discordReconcileAlarm(harness.context);

    expect(result).toHaveProperty("summary");
    expect(harness.fakeFetch).not.toHaveBeenCalled();
    if (mode === "disconnecting") {
      await expect(harness.db.prepare("SELECT count(*) AS count FROM discord_guilds WHERE channel_id = ?")
        .bind(CHANNEL_ID).first()).resolves.toEqual({ count: 0 });
    } else {
      expect(harness.deferredDisableCalls()).toBe(1);
    }
  });

  it.each(["disconnecting", "teardown"] as const)("waits for the immediate %s request before the job can finish it", async (mode) => {
    const harness = await makeHarness();
    const startedAt = Date.now();
    setDiscordLifecycle(harness.sql, {
      mode,
      startedAt,
      deferred: false,
      actorUserId: mode === "teardown" ? "fictional-operator" : null,
      expectedRevision: mode === "teardown" ? 7 : null,
      disconnectMemberUserId: null,
      guildId: GUILD_ID,
      connectedAt: "2026-11-26T10:00:00.000Z",
    });

    const result = await discordReconcileAlarm(harness.context);

    expect(result).toHaveProperty("summary");
    expect(harness.fakeFetch).not.toHaveBeenCalled();
    expect(harness.nextRuns).toContain(startedAt + 60_000);
    expect(harness.deferredDisableCalls()).toBe(0);
    await expect(harness.db.prepare("SELECT count(*) AS count FROM discord_guilds WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).resolves.toEqual({ count: 1 });
  });

  it("completes a zero-ledger teardown intent when no Discord server is connected", async () => {
    const harness = await makeHarness({ noConnection: true });
    setDiscordLifecycle(harness.sql, {
      mode: "teardown",
      startedAt: Date.now() - 61_000,
      deferred: false,
      actorUserId: "fictional-operator",
      expectedRevision: 7,
      disconnectMemberUserId: null,
      guildId: null,
      connectedAt: null,
    });

    await discordReconcileAlarm(harness.context);

    expect(harness.deferredDisableCalls()).toBe(1);
    expect(readDiscordLifecycle(harness.sql)).toBeNull();
    expect(harness.fakeFetch).not.toHaveBeenCalled();
  });

  it("does not let a delayed enable cancel a teardown started by a newer disable", async () => {
    const harness = await makeHarness();
    setDiscordLifecycle(harness.sql, {
      mode: "teardown",
      startedAt: Date.now(),
      deferred: true,
      actorUserId: "fictional-operator",
      expectedRevision: 12,
      disconnectMemberUserId: null,
      guildId: null,
      connectedAt: null,
    });

    expect(cancelDiscordTeardownBeforeEnable(harness.sql, 12)).toBe(false);
    expect(readDiscordLifecycle(harness.sql)?.expectedRevision).toBe(12);
    expect(cancelDiscordTeardownBeforeEnable(harness.sql, 13)).toBe(true);
    expect(readDiscordLifecycle(harness.sql)).toBeNull();
  });

  it("gives up an unreachable disconnect after thirty days and drops the ledger", async () => {
    const harness = await makeHarness();
    insertDiscordPendingGrant(harness.sql, {
      guildId: GUILD_ID, discordUserId: DISCORD_USER_ID, twitchUserId: TWITCH_USER_ID, roleId: VIP_ROLE_ID,
      joinedAt: "2026-11-20T18:30:00.000000+00:00",
    });
    setDiscordLifecycle(harness.sql, {
      mode: "disconnecting", startedAt: Date.now() - 31 * 24 * 60 * 60_000,
      actorUserId: null, expectedRevision: null, disconnectMemberUserId: null,
      guildId: GUILD_ID, connectedAt: "2026-11-26T10:00:00.000Z",
    });
    setDiscordServerLock(harness.sql, { guildId: GUILD_ID, lockedAt: Date.now(), lastProbeAt: Date.now(), reason: "bot_removed" });

    await discordReconcileAlarm(harness.context);

    expect(countDiscordGrants(harness.sql, GUILD_ID)).toBe(0);
    expect(await harness.db.prepare("SELECT 1 AS present FROM discord_guilds WHERE channel_id = ?").bind(CHANNEL_ID).first()).toBeNull();
    expect(harness.requestCalls).toHaveLength(0);
    expect(harness.diagnostics).toMatchObject([expect.objectContaining({ code: "discord.disconnect_given_up" })]);
  });
});
