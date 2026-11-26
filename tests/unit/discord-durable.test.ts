import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  clearDiscordGuildState,
  countDiscordGrants,
  ensureDiscordDurableSchema,
  insertDiscordPendingGrant,
  markDiscordGrantGranted,
  readDiscordGrants,
  readDiscordLifecycle,
  setDiscordLifecycle,
} from "../../src/modules/discord/durable";

const databases: DatabaseSync[] = [];

const sqlFor = (queries: string[] = []): SqlStorage => {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  return {
    exec: <Row extends Record<string, unknown>>(query: string, ...values: SQLInputValue[]) => {
      queries.push(query);
      const statement = database.prepare(query);
      const rows = /^\s*(SELECT|PRAGMA)/iu.test(query) ? statement.all(...values) as Row[] : (statement.run(...values), [] as Row[]);
      return { toArray: () => rows, one: () => rows[0] };
    },
  } as unknown as SqlStorage;
};

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("Discord durable state", () => {
  it("creates the Discord schema once per storage without a lifecycle-column migration probe", () => {
    const queries: string[] = [];
    const sql = sqlFor(queries);

    ensureDiscordDurableSchema(sql);
    const schemaQueryCount = queries.length;
    ensureDiscordDurableSchema(sql);

    expect(queries).toHaveLength(schemaQueryCount);
    expect(queries.some((query) => /PRAGMA table_info\(discord_reconcile_state\)|ALTER TABLE discord_reconcile_state/iu.test(query))).toBe(false);
  });

  it("commits a pending grant before a role write and later promotes it", () => {
    const sql = sqlFor();
    ensureDiscordDurableSchema(sql);
    const pending = {
      guildId: "990000000000000101",
      discordUserId: "990000000000000201",
      twitchUserId: "990000000000000301",
      roleId: "990000000000000102",
      joinedAt: "2026-11-01T10:00:00.000Z",
    };

    insertDiscordPendingGrant(sql, pending);
    expect(readDiscordGrants(sql, pending.guildId)).toEqual([{ ...pending, grantedAt: null, status: "pending" }]);
    markDiscordGrantGranted(sql, pending, 2_000);
    expect(readDiscordGrants(sql, pending.guildId)).toEqual([{ ...pending, grantedAt: 2_000, status: "granted" }]);
  });

  it("persists disconnect or teardown state with the initiating actor and revision", () => {
    const sql = sqlFor();
    setDiscordLifecycle(sql, {
      mode: "teardown",
      startedAt: 2_000,
      deferred: true,
      actorUserId: "twitch-operator-fictional",
      expectedRevision: 7,
      disconnectMemberUserId: null,
      guildId: "990000000000000101",
      connectedAt: "2026-11-26T10:00:00.000Z",
    });

    expect(readDiscordLifecycle(sql)).toEqual({
      mode: "teardown",
      startedAt: 2_000,
      deferred: true,
      actorUserId: "twitch-operator-fictional",
      expectedRevision: 7,
      disconnectMemberUserId: null,
      guildId: "990000000000000101",
      connectedAt: "2026-11-26T10:00:00.000Z",
    });
  });

  it("drops every ledger row and local hint state when a guild disconnects", () => {
    const sql = sqlFor();
    const first = {
      guildId: "990000000000000101",
      discordUserId: "990000000000000201",
      twitchUserId: "990000000000000301",
      roleId: "990000000000000102",
      joinedAt: "2026-11-01T10:00:00.000Z",
    };
    insertDiscordPendingGrant(sql, first);
    setDiscordLifecycle(sql, {
      mode: "disconnecting",
      startedAt: 2_000,
      actorUserId: null,
      expectedRevision: null,
      disconnectMemberUserId: null,
      guildId: first.guildId,
      connectedAt: "2026-11-26T10:00:00.000Z",
    });

    clearDiscordGuildState(sql, first.guildId);

    expect(countDiscordGrants(sql, first.guildId)).toBe(0);
    expect(readDiscordLifecycle(sql)).toBeNull();
  });
});
