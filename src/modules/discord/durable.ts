import type { DiscordGrantRecord } from "./reconcile-domain";
import type { DiscordServerRole } from "./contracts";

type DiscordLifecycleMode = "disconnecting" | "teardown";

export interface DiscordLifecycleState {
  mode: DiscordLifecycleMode;
  startedAt: number;
  deferred?: boolean;
  actorUserId: string | null;
  expectedRevision: number | null;
  disconnectMemberUserId: string | null;
  guildId: string | null;
  connectedAt: string | null;
}

export interface DiscordReconcileMutationBarrier {
  token: string;
  expiresAt: number;
}

export interface DiscordMappingLock {
  guildId: string;
  rankType: "vip" | "moderator";
  roleId: string;
  lockedAt: number;
  lastProbeAt: number;
}

export interface DiscordServerLock {
  guildId: string;
  lockedAt: number;
  lastProbeAt: number;
  reason: string;
}

export const DISCORD_MEMBER_PROBE_INTERVAL_MS = 6 * 60 * 60_000;
export const DISCORD_TOKEN_PROBE_INTERVAL_MS = 60 * 60_000;
export const DISCORD_DISCONNECT_GIVE_UP_MS = 30 * 24 * 60 * 60_000;
export const DISCORD_IMMEDIATE_CLEANUP_GRACE_MS = 60_000;

const initializedDiscordSchemas = new WeakSet<object>();

export const ensureDiscordDurableSchema = (sql: SqlStorage): void => {
  if (initializedDiscordSchemas.has(sql)) return;
  sql.exec(`CREATE TABLE IF NOT EXISTS discord_role_grants (
    guild_id TEXT NOT NULL,
    discord_user_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    twitch_user_id TEXT NOT NULL,
    joined_at TEXT NOT NULL,
    granted_at INTEGER,
    status TEXT NOT NULL CHECK (status IN ('pending', 'granted')),
    PRIMARY KEY (guild_id, discord_user_id, role_id)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS discord_reconcile_state (
    state_key TEXT PRIMARY KEY CHECK (state_key = 'channel'),
    mode TEXT NOT NULL CHECK (mode IN ('disconnecting', 'teardown')),
    started_at INTEGER NOT NULL,
    actor_user_id TEXT,
    expected_revision INTEGER,
    disconnect_member_user_id TEXT,
    guild_id TEXT,
    connected_at TEXT,
    deferred INTEGER NOT NULL DEFAULT 1 CHECK (deferred IN (0, 1))
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS discord_reconcile_mutation_barrier (
    state_key TEXT PRIMARY KEY CHECK (state_key = 'channel'),
    token TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS discord_reconcile_retry (
    state_key TEXT PRIMARY KEY CHECK (state_key = 'channel'),
    retry_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS discord_reconcile_runs (
    state_key TEXT PRIMARY KEY CHECK (state_key = 'channel'),
    work_json TEXT NOT NULL,
    cursor INTEGER NOT NULL,
    generation INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    granted INTEGER NOT NULL DEFAULT 0,
    removed INTEGER NOT NULL DEFAULT 0,
    failed INTEGER NOT NULL DEFAULT 0,
    skipped INTEGER NOT NULL DEFAULT 0,
    examples_json TEXT NOT NULL DEFAULT '[]'
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS discord_reconcile_control (
    state_key TEXT PRIMARY KEY CHECK (state_key = 'channel'),
    revision INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS discord_member_states (
    guild_id TEXT NOT NULL,
    discord_user_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('not_in_server')),
    checked_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, discord_user_id)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS discord_member_role_states (
    guild_id TEXT NOT NULL,
    discord_user_id TEXT NOT NULL,
    role_id TEXT NOT NULL,
    present INTEGER NOT NULL CHECK (present IN (0, 1)),
    joined_at TEXT NOT NULL,
    checked_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, discord_user_id, role_id)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS discord_server_locks (
    guild_id TEXT PRIMARY KEY,
    locked_at INTEGER NOT NULL,
    last_probe_at INTEGER NOT NULL,
    reason TEXT NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS discord_mapping_locks (
    guild_id TEXT NOT NULL,
    rank_type TEXT NOT NULL CHECK (rank_type IN ('vip', 'moderator')),
    role_id TEXT NOT NULL,
    locked_at INTEGER NOT NULL,
    last_probe_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, rank_type, role_id)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS discord_role_names (
    role_id TEXT PRIMARY KEY,
    role_name TEXT NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS discord_role_catalog (
    role_id TEXT PRIMARY KEY,
    role_json TEXT NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS discord_chat_hints (
    twitch_user_id TEXT PRIMARY KEY,
    sent_at INTEGER NOT NULL
  )`);
  initializedDiscordSchemas.add(sql);
};

export const readDiscordGrants = (sql: SqlStorage, guildId: string): DiscordGrantRecord[] => {
  ensureDiscordDurableSchema(sql);
  return sql.exec<DiscordGrantRecord>(
    `SELECT guild_id AS guildId, discord_user_id AS discordUserId, twitch_user_id AS twitchUserId,
            role_id AS roleId, joined_at AS joinedAt, granted_at AS grantedAt, status
       FROM discord_role_grants WHERE guild_id = ? ORDER BY discord_user_id, role_id`,
    guildId,
  ).toArray();
};

export const countDiscordGrants = (sql: SqlStorage, guildId: string): number => {
  ensureDiscordDurableSchema(sql);
  return sql.exec<{ count: number }>(
    "SELECT COUNT(*) AS count FROM discord_role_grants WHERE guild_id = ?",
    guildId,
  ).one().count;
};

export const readDiscordLifecycle = (sql: SqlStorage): DiscordLifecycleState | null => {
  ensureDiscordDurableSchema(sql);
  return sql.exec<{
    mode: DiscordLifecycleMode;
    started_at: number;
    actor_user_id: string | null;
    expected_revision: number | null;
    disconnect_member_user_id: string | null;
    guild_id: string | null;
    connected_at: string | null;
    deferred: number;
  }>("SELECT mode, started_at, actor_user_id, expected_revision, disconnect_member_user_id, guild_id, connected_at, deferred FROM discord_reconcile_state WHERE state_key = 'channel'")
    .toArray().map((row) => ({
      mode: row.mode,
      startedAt: row.started_at,
      actorUserId: row.actor_user_id,
      expectedRevision: row.expected_revision,
      disconnectMemberUserId: row.disconnect_member_user_id,
      guildId: row.guild_id,
      connectedAt: row.connected_at,
      deferred: row.deferred === 1,
    }))[0] ?? null;
};

export const setDiscordLifecycle = (sql: SqlStorage, state: DiscordLifecycleState): void => {
  ensureDiscordDurableSchema(sql);
  sql.exec(
    `INSERT INTO discord_reconcile_state
       (state_key, mode, started_at, actor_user_id, expected_revision, disconnect_member_user_id, guild_id, connected_at, deferred)
     VALUES ('channel', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (state_key) DO UPDATE SET mode = excluded.mode, started_at = excluded.started_at,
       actor_user_id = excluded.actor_user_id, expected_revision = excluded.expected_revision,
       disconnect_member_user_id = excluded.disconnect_member_user_id, guild_id = excluded.guild_id,
       connected_at = excluded.connected_at, deferred = excluded.deferred`,
    state.mode,
    state.startedAt,
    state.actorUserId,
    state.expectedRevision,
    state.disconnectMemberUserId,
    state.guildId,
    state.connectedAt,
    state.deferred === false ? 0 : 1,
  );
};

export const beginDiscordReconcileMutation = (sql: SqlStorage, token: string, now: number, leaseMs: number): boolean => {
  ensureDiscordDurableSchema(sql);
  sql.exec(
    `INSERT INTO discord_reconcile_mutation_barrier (state_key, token, expires_at) VALUES ('channel', ?, ?)
     ON CONFLICT (state_key) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at`,
    token,
    now + leaseMs,
  );
  bumpDiscordReconcileRevision(sql);
  return true;
};

export const readDiscordReconcileMutationBarrier = (sql: SqlStorage): DiscordReconcileMutationBarrier | null => {
  ensureDiscordDurableSchema(sql);
  const row = sql.exec<{ token: string; expires_at: number }>(
    "SELECT token, expires_at FROM discord_reconcile_mutation_barrier WHERE state_key = 'channel'",
  ).toArray()[0];
  return row === undefined ? null : { token: row.token, expiresAt: row.expires_at };
};

export const clearDiscordReconcileMutationBarrier = (sql: SqlStorage, token: string): boolean => {
  ensureDiscordDurableSchema(sql);
  sql.exec("DELETE FROM discord_reconcile_mutation_barrier WHERE state_key = 'channel' AND token = ?", token);
  if (sql.exec<{ changes: number }>("SELECT changes() AS changes").one().changes === 0) return false;
  bumpDiscordReconcileRevision(sql);
  return true;
};

export const readDiscordRetryAt = (sql: SqlStorage): number | null => {
  ensureDiscordDurableSchema(sql);
  return sql.exec<{ retry_at: number }>("SELECT retry_at FROM discord_reconcile_retry WHERE state_key = 'channel'")
    .toArray()[0]?.retry_at ?? null;
};

export const setDiscordRetryAt = (sql: SqlStorage, retryAt: number): void => {
  ensureDiscordDurableSchema(sql);
  sql.exec(
    `INSERT INTO discord_reconcile_retry (state_key, retry_at) VALUES ('channel', ?)
     ON CONFLICT (state_key) DO UPDATE SET retry_at = MAX(retry_at, excluded.retry_at)`,
    retryAt,
  );
};

export const clearDiscordRetryAt = (sql: SqlStorage): void => {
  ensureDiscordDurableSchema(sql);
  sql.exec("DELETE FROM discord_reconcile_retry WHERE state_key = 'channel'");
};

export const clearDiscordLifecycle = (sql: SqlStorage): void => {
  ensureDiscordDurableSchema(sql);
  sql.exec("DELETE FROM discord_reconcile_state WHERE state_key = 'channel'");
  sql.exec("DELETE FROM discord_reconcile_runs WHERE state_key = 'channel'");
};

export const cancelDiscordTeardownBeforeEnable = (sql: SqlStorage, enabledRevision: number): boolean => {
  ensureDiscordDurableSchema(sql);
  const lifecycle = readDiscordLifecycle(sql);
  if (lifecycle?.mode !== "teardown" || lifecycle.expectedRevision === null ||
      lifecycle.expectedRevision >= enabledRevision) return false;
  clearDiscordLifecycle(sql);
  bumpDiscordReconcileRevision(sql);
  return true;
};

export const readDiscordReconcileRevision = (sql: SqlStorage): number => {
  ensureDiscordDurableSchema(sql);
  return sql.exec<{ revision: number }>("SELECT revision FROM discord_reconcile_control WHERE state_key = 'channel'").toArray()[0]?.revision ?? 0;
};

export const bumpDiscordReconcileRevision = (sql: SqlStorage): number => {
  ensureDiscordDurableSchema(sql);
  sql.exec(
    `INSERT INTO discord_reconcile_control (state_key, revision) VALUES ('channel', 1)
     ON CONFLICT (state_key) DO UPDATE SET revision = revision + 1`,
  );
  return readDiscordReconcileRevision(sql);
};

export const insertDiscordPendingGrant = (sql: SqlStorage, grant: Omit<DiscordGrantRecord, "grantedAt" | "status">): void => {
  ensureDiscordDurableSchema(sql);
  sql.exec(
    `INSERT OR IGNORE INTO discord_role_grants
       (guild_id, discord_user_id, role_id, twitch_user_id, joined_at, granted_at, status)
     VALUES (?, ?, ?, ?, ?, NULL, 'pending')`,
    grant.guildId,
    grant.discordUserId,
    grant.roleId,
    grant.twitchUserId,
    grant.joinedAt,
  );
};

export const resetDiscordGrantPending = (sql: SqlStorage, grant: Omit<DiscordGrantRecord, "grantedAt" | "status">): void => {
  ensureDiscordDurableSchema(sql);
  sql.exec(
    `INSERT INTO discord_role_grants
       (guild_id, discord_user_id, role_id, twitch_user_id, joined_at, granted_at, status)
     VALUES (?, ?, ?, ?, ?, NULL, 'pending')
     ON CONFLICT (guild_id, discord_user_id, role_id) DO UPDATE SET
       twitch_user_id = excluded.twitch_user_id, joined_at = excluded.joined_at,
       granted_at = NULL, status = 'pending'`,
    grant.guildId,
    grant.discordUserId,
    grant.roleId,
    grant.twitchUserId,
    grant.joinedAt,
  );
};

export const markDiscordGrantGranted = (
  sql: SqlStorage,
  grant: Pick<DiscordGrantRecord, "guildId" | "discordUserId" | "roleId" | "joinedAt">,
  grantedAt: number,
): void => {
  ensureDiscordDurableSchema(sql);
  sql.exec(
    `UPDATE discord_role_grants SET status = 'granted', granted_at = ?
      WHERE guild_id = ? AND discord_user_id = ? AND role_id = ? AND joined_at = ?`,
    grantedAt,
    grant.guildId,
    grant.discordUserId,
    grant.roleId,
    grant.joinedAt,
  );
};

export const removeDiscordGrant = (sql: SqlStorage, guildId: string, discordUserId: string, roleId: string): void => {
  ensureDiscordDurableSchema(sql);
  sql.exec("DELETE FROM discord_role_grants WHERE guild_id = ? AND discord_user_id = ? AND role_id = ?", guildId, discordUserId, roleId);
};

export const removeDiscordMemberGrants = (sql: SqlStorage, guildId: string, discordUserId: string): void => {
  ensureDiscordDurableSchema(sql);
  sql.exec("DELETE FROM discord_role_grants WHERE guild_id = ? AND discord_user_id = ?", guildId, discordUserId);
};

const removeDiscordGuildGrants = (sql: SqlStorage, guildId: string): void => {
  ensureDiscordDurableSchema(sql);
  sql.exec("DELETE FROM discord_role_grants WHERE guild_id = ?", guildId);
};

export const readDiscordMemberState = (sql: SqlStorage, guildId: string, discordUserId: string): "not_in_server" | null => {
  ensureDiscordDurableSchema(sql);
  return sql.exec<{ state: "not_in_server" }>(
    "SELECT state FROM discord_member_states WHERE guild_id = ? AND discord_user_id = ?",
    guildId,
    discordUserId,
  ).toArray()[0]?.state ?? null;
};

export const setDiscordMemberNotInServer = (sql: SqlStorage, guildId: string, discordUserId: string, checkedAt: number): void => {
  ensureDiscordDurableSchema(sql);
  sql.exec(
    `INSERT INTO discord_member_states (guild_id, discord_user_id, state, checked_at)
     VALUES (?, ?, 'not_in_server', ?)
     ON CONFLICT (guild_id, discord_user_id) DO UPDATE SET state = 'not_in_server', checked_at = excluded.checked_at`,
    guildId,
    discordUserId,
    checkedAt,
  );
};

export const clearDiscordMemberState = (sql: SqlStorage, guildId: string, discordUserId: string): void => {
  ensureDiscordDurableSchema(sql);
  sql.exec("DELETE FROM discord_member_states WHERE guild_id = ? AND discord_user_id = ?", guildId, discordUserId);
};

export const clearDiscordMemberRoleState = (sql: SqlStorage, guildId: string, discordUserId: string): void => {
  ensureDiscordDurableSchema(sql);
  sql.exec("DELETE FROM discord_member_role_states WHERE guild_id = ? AND discord_user_id = ?", guildId, discordUserId);
};

export const recordDiscordMemberRoleState = (
  sql: SqlStorage,
  input: { guildId: string; discordUserId: string; roleIds: readonly string[]; presentRoleIds: readonly string[]; joinedAt: string; checkedAt: number },
): void => {
  ensureDiscordDurableSchema(sql);
  sql.exec("DELETE FROM discord_member_role_states WHERE guild_id = ? AND discord_user_id = ?", input.guildId, input.discordUserId);
  const present = new Set(input.presentRoleIds);
  for (const roleId of new Set(input.roleIds)) sql.exec(
    `INSERT INTO discord_member_role_states (guild_id, discord_user_id, role_id, present, joined_at, checked_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    input.guildId,
    input.discordUserId,
    roleId,
    present.has(roleId) ? 1 : 0,
    input.joinedAt,
    input.checkedAt,
  );
};

export const readDiscordMemberRoleStates = (sql: SqlStorage, guildId: string, discordUserId: string): Array<{
  role_id: string;
  present: number;
  joined_at: string;
}> => {
  ensureDiscordDurableSchema(sql);
  return sql.exec<{ role_id: string; present: number; joined_at: string }>(
    `SELECT role_id, present, joined_at FROM discord_member_role_states
      WHERE guild_id = ? AND discord_user_id = ?`,
    guildId,
    discordUserId,
  ).toArray();
};

export const setDiscordMemberRoleState = (
  sql: SqlStorage,
  input: { guildId: string; discordUserId: string; roleId: string; present: boolean; joinedAt: string; checkedAt: number },
): void => {
  ensureDiscordDurableSchema(sql);
  sql.exec(
    `INSERT INTO discord_member_role_states (guild_id, discord_user_id, role_id, present, joined_at, checked_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (guild_id, discord_user_id, role_id) DO UPDATE SET present = excluded.present,
       joined_at = excluded.joined_at, checked_at = excluded.checked_at`,
    input.guildId,
    input.discordUserId,
    input.roleId,
    input.present ? 1 : 0,
    input.joinedAt,
    input.checkedAt,
  );
};

const cacheDiscordRoleNames = (sql: SqlStorage, roles: readonly { id: string; name: string }[]): void => {
  ensureDiscordDurableSchema(sql);
  sql.exec("DELETE FROM discord_role_names");
  for (const role of roles) {
    sql.exec("INSERT INTO discord_role_names (role_id, role_name) VALUES (?, ?)", role.id, role.name);
  }
};

export const readDiscordRoleNames = (sql: SqlStorage): Map<string, string> => {
  ensureDiscordDurableSchema(sql);
  return new Map(sql.exec<{ role_id: string; role_name: string }>(
    "SELECT role_id, role_name FROM discord_role_names",
  ).toArray().map(({ role_id, role_name }) => [role_id, role_name]));
};

export const cacheDiscordRoleCatalog = (sql: SqlStorage, roles: readonly DiscordServerRole[]): void => {
  ensureDiscordDurableSchema(sql);
  sql.exec("DELETE FROM discord_role_catalog");
  for (const role of roles) {
    sql.exec("INSERT INTO discord_role_catalog (role_id, role_json) VALUES (?, ?)", role.id, JSON.stringify(role));
  }
  cacheDiscordRoleNames(sql, roles);
};

export const readDiscordRoleCatalog = (sql: SqlStorage): DiscordServerRole[] => {
  ensureDiscordDurableSchema(sql);
  return sql.exec<{ role_json: string }>("SELECT role_json FROM discord_role_catalog ORDER BY role_id")
    .toArray().flatMap(({ role_json }) => {
      try {
        const role: unknown = JSON.parse(role_json);
        if (typeof role !== "object" || role === null || Array.isArray(role)) return [];
        const record = role as Record<string, unknown>;
        return typeof record.id === "string" && typeof record.name === "string" && Number.isSafeInteger(record.position) &&
          typeof record.permissions === "string" && typeof record.managed === "boolean"
          ? [{ id: record.id, name: record.name, position: record.position as number, permissions: record.permissions, managed: record.managed }]
          : [];
      } catch { return []; }
    });
};

export const setDiscordServerLock = (sql: SqlStorage, lock: DiscordServerLock): void => {
  ensureDiscordDurableSchema(sql);
  sql.exec(
    `INSERT INTO discord_server_locks (guild_id, locked_at, last_probe_at, reason)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (guild_id) DO UPDATE SET locked_at = excluded.locked_at,
       last_probe_at = excluded.last_probe_at, reason = excluded.reason`,
    lock.guildId,
    lock.lockedAt,
    lock.lastProbeAt,
    lock.reason,
  );
};

export const readDiscordServerLock = (sql: SqlStorage, guildId: string): DiscordServerLock | null => {
  ensureDiscordDurableSchema(sql);
  const row = sql.exec<{
    guild_id: string;
    locked_at: number;
    last_probe_at: number;
    reason: string;
  }>("SELECT guild_id, locked_at, last_probe_at, reason FROM discord_server_locks WHERE guild_id = ?", guildId).toArray()[0];
  return row === undefined ? null : { guildId: row.guild_id, lockedAt: row.locked_at, lastProbeAt: row.last_probe_at, reason: row.reason };
};

export const updateDiscordServerProbe = (sql: SqlStorage, guildId: string, lastProbeAt: number): void => {
  ensureDiscordDurableSchema(sql);
  sql.exec("UPDATE discord_server_locks SET last_probe_at = ? WHERE guild_id = ?", lastProbeAt, guildId);
};

export const clearDiscordServerLock = (sql: SqlStorage, guildId: string): void => {
  ensureDiscordDurableSchema(sql);
  sql.exec("DELETE FROM discord_server_locks WHERE guild_id = ?", guildId);
};

export const setDiscordMappingLock = (sql: SqlStorage, lock: DiscordMappingLock): void => {
  ensureDiscordDurableSchema(sql);
  sql.exec(
    `INSERT INTO discord_mapping_locks (guild_id, rank_type, role_id, locked_at, last_probe_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (guild_id, rank_type, role_id) DO UPDATE SET locked_at = excluded.locked_at,
       last_probe_at = excluded.last_probe_at`,
    lock.guildId,
    lock.rankType,
    lock.roleId,
    lock.lockedAt,
    lock.lastProbeAt,
  );
};

export const readDiscordMappingLocks = (sql: SqlStorage, guildId: string): DiscordMappingLock[] => {
  ensureDiscordDurableSchema(sql);
  return sql.exec<{
    guild_id: string;
    rank_type: "vip" | "moderator";
    role_id: string;
    locked_at: number;
    last_probe_at: number;
  }>("SELECT guild_id, rank_type, role_id, locked_at, last_probe_at FROM discord_mapping_locks WHERE guild_id = ?", guildId)
    .toArray().map((row) => ({
      guildId: row.guild_id,
      rankType: row.rank_type,
      roleId: row.role_id,
      lockedAt: row.locked_at,
      lastProbeAt: row.last_probe_at,
    }));
};

export const updateDiscordMappingProbe = (sql: SqlStorage, lock: Pick<DiscordMappingLock, "guildId" | "rankType" | "roleId">, lastProbeAt: number): void => {
  ensureDiscordDurableSchema(sql);
  sql.exec(
    "UPDATE discord_mapping_locks SET last_probe_at = ? WHERE guild_id = ? AND rank_type = ? AND role_id = ?",
    lastProbeAt,
    lock.guildId,
    lock.rankType,
    lock.roleId,
  );
};

export const clearDiscordMappingLock = (sql: SqlStorage, lock: Pick<DiscordMappingLock, "guildId" | "rankType" | "roleId">): void => {
  ensureDiscordDurableSchema(sql);
  sql.exec(
    "DELETE FROM discord_mapping_locks WHERE guild_id = ? AND rank_type = ? AND role_id = ?",
    lock.guildId,
    lock.rankType,
    lock.roleId,
  );
};

export const clearDiscordMappingLocksForChangedMappings = (
  sql: SqlStorage,
  guildId: string,
  previous: { vip: string | null; moderator: string | null },
  next: { vip: string | null; moderator: string | null },
): DiscordMappingLock[] => {
  ensureDiscordDurableSchema(sql);
  const locksToClear = readDiscordMappingLocks(sql, guildId).filter(({ rankType }) => previous[rankType] !== next[rankType]);
  for (const lock of locksToClear) clearDiscordMappingLock(sql, lock);
  return locksToClear;
};

export const discordChatHintWasSent = (sql: SqlStorage, twitchUserId: string): boolean => {
  ensureDiscordDurableSchema(sql);
  return sql.exec<{ present: number }>("SELECT 1 AS present FROM discord_chat_hints WHERE twitch_user_id = ?", twitchUserId).toArray().length > 0;
};

export const recordDiscordChatHint = (sql: SqlStorage, twitchUserId: string, sentAt: number): boolean => {
  ensureDiscordDurableSchema(sql);
  sql.exec("INSERT OR IGNORE INTO discord_chat_hints (twitch_user_id, sent_at) VALUES (?, ?)", twitchUserId, sentAt);
  return sql.exec<{ changes: number }>("SELECT changes() AS changes").one().changes > 0;
};

export const clearDiscordChatHints = (sql: SqlStorage): void => {
  ensureDiscordDurableSchema(sql);
  sql.exec("DELETE FROM discord_chat_hints");
};

export const clearDiscordGuildState = (sql: SqlStorage, guildId: string): void => {
  ensureDiscordDurableSchema(sql);
  removeDiscordGuildGrants(sql, guildId);
  sql.exec("DELETE FROM discord_member_states WHERE guild_id = ?", guildId);
  sql.exec("DELETE FROM discord_member_role_states WHERE guild_id = ?", guildId);
  sql.exec("DELETE FROM discord_server_locks WHERE guild_id = ?", guildId);
  sql.exec("DELETE FROM discord_mapping_locks WHERE guild_id = ?", guildId);
  sql.exec("DELETE FROM discord_role_names");
  sql.exec("DELETE FROM discord_role_catalog");
  const barrier = readDiscordReconcileMutationBarrier(sql);
  if (barrier !== null && barrier.expiresAt <= Date.now()) clearDiscordReconcileMutationBarrier(sql, barrier.token);
  clearDiscordRetryAt(sql);
  clearDiscordChatHints(sql);
  clearDiscordLifecycle(sql);
};
