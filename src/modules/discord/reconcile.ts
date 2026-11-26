import type { ModuleAlarmContext, ModuleDiagnostic } from "../contract";
import { discordCatalog } from "./locale";
import {
  DiscordRequestBudgetExceeded,
  DiscordRequestError,
  discordApiRequest,
  getDiscordGuildMember,
  readDiscordGuildState,
  type DiscordEnvironment,
} from "./adapters/discord";
import {
  DISCORD_DISCONNECT_GIVE_UP_MS,
  DISCORD_IMMEDIATE_CLEANUP_GRACE_MS,
  DISCORD_MEMBER_PROBE_INTERVAL_MS,
  DISCORD_TOKEN_PROBE_INTERVAL_MS,
  clearDiscordChatHints,
  clearDiscordGuildState,
  clearDiscordMappingLock,
  clearDiscordMemberState,
  clearDiscordMemberRoleState,
  clearDiscordReconcileMutationBarrier,
  clearDiscordRetryAt,
  clearDiscordLifecycle,
  clearDiscordServerLock,
  countDiscordGrants,
  ensureDiscordDurableSchema,
  markDiscordGrantGranted,
  readDiscordGrants,
  readDiscordLifecycle,
  recordDiscordMemberRoleState,
  readDiscordMappingLocks,
  readDiscordReconcileRevision,
  readDiscordReconcileMutationBarrier,
  readDiscordRetryAt,
  readDiscordRoleNames,
  readDiscordServerLock,
  removeDiscordGrant,
  removeDiscordMemberGrants,
  resetDiscordGrantPending,
  setDiscordMemberRoleState,
  setDiscordMappingLock,
  setDiscordMemberNotInServer,
  setDiscordRetryAt,
  setDiscordServerLock,
  updateDiscordMappingProbe,
  updateDiscordServerProbe,
  type DiscordLifecycleState,
  type DiscordMappingLock,
} from "./durable";
import {
  desiredDiscordRoleGrants,
  discordRoleShouldBeRemoved,
  previewDiscordRoleChanges,
  type DiscordGrantRecord,
  type DiscordLinkRecord,
  type DiscordDesiredRoleGrant,
  type DiscordRankMembership,
} from "./reconcile-domain";
import { disconnectDiscordServerAfterDeferredCleanup, getDiscordRoleMappings, getDiscordServerConnection } from "./repository";

const loadTokenLock = () => import("../../worker/discord/token-lock");

const MAX_DISCORD_REQUESTS_PER_RUN = 20;
const FOLLOW_UP_DELAY_MS = 1_000;

interface DiscordReconcileWorkItem {
  discordUserId: string;
  roleId: string;
  desired: DiscordDesiredRoleGrant | null;
  remove: boolean;
}

interface DiscordReconcileRun {
  work: DiscordReconcileWorkItem[];
  cursor: number;
  generation: number;
  revision: number;
  startedAt: number;
  granted: number;
  removed: number;
  failed: number;
  skipped: number;
  examples: string[];
}

interface DiscordRunRow extends Record<string, string | number> {
  work_json: string;
  cursor: number;
  generation: number;
  revision: number;
  started_at: number;
  granted: number;
  removed: number;
  failed: number;
  skipped: number;
  examples_json: string;
}

interface DiscordMemberLink extends DiscordLinkRecord, Record<string, string> {}

const rankTypes = ["vip", "moderator"] as const;
const maxLinkQueryIds = 80;

const readSql = <Value>(context: ModuleAlarmContext, read: (sql: SqlStorage) => Value): Value => {
  const job = context.channelJob;
  if (job === undefined) throw new Error("Discord reconciliation requires its channel job context.");
  let result!: Value;
  if (!job.commit((sql) => { result = read(sql); })) job.assertCurrent();
  return result;
};

const writeSql = (context: ModuleAlarmContext, write: (sql: SqlStorage) => void): void => {
  const job = context.channelJob;
  if (job === undefined) throw new Error("Discord reconciliation requires its channel job context.");
  if (!job.commit(write)) job.assertCurrent();
};

const readRun = (context: ModuleAlarmContext): DiscordReconcileRun | null => readSql(context, (sql) => {
  ensureDiscordDurableSchema(sql);
  const row = sql.exec<DiscordRunRow>(
    `SELECT work_json, cursor, generation, revision, started_at, granted, removed, failed, skipped, examples_json
       FROM discord_reconcile_runs WHERE state_key = 'channel'`,
  ).toArray()[0];
  if (row === undefined) return null;
  try {
    const work: unknown = JSON.parse(row.work_json);
    const examples: unknown = JSON.parse(row.examples_json);
    if (!Array.isArray(work) || !Array.isArray(examples)) return null;
    return {
      work: work as DiscordReconcileWorkItem[],
      cursor: row.cursor,
      generation: row.generation,
      revision: row.revision,
      startedAt: row.started_at,
      granted: row.granted,
      removed: row.removed,
      failed: row.failed,
      skipped: row.skipped,
      examples: examples.filter((value): value is string => typeof value === "string").slice(0, 10),
    };
  } catch {
    return null;
  }
});

const saveRun = (context: ModuleAlarmContext, run: DiscordReconcileRun): void => { writeSql(context, (sql) => {
  ensureDiscordDurableSchema(sql);
  sql.exec(
    `INSERT INTO discord_reconcile_runs
       (state_key, work_json, cursor, generation, revision, started_at, granted, removed, failed, skipped, examples_json)
     VALUES ('channel', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (state_key) DO UPDATE SET work_json = excluded.work_json, cursor = excluded.cursor,
       generation = excluded.generation, revision = excluded.revision, started_at = excluded.started_at,
       granted = excluded.granted, removed = excluded.removed, failed = excluded.failed,
       skipped = excluded.skipped, examples_json = excluded.examples_json`,
    JSON.stringify(run.work),
    run.cursor,
    run.generation,
    run.revision,
    run.startedAt,
    run.granted,
    run.removed,
    run.failed,
    run.skipped,
    JSON.stringify(run.examples.slice(0, 10)),
  );
}); };

const clearRun = (context: ModuleAlarmContext): void => { writeSql(context, (sql) => {
  ensureDiscordDurableSchema(sql);
  sql.exec("DELETE FROM discord_reconcile_runs WHERE state_key = 'channel'");
}); };

const addExample = (run: DiscordReconcileRun, login: string | null, roleName: string): void => {
  if (run.examples.length >= 10) return;
  const example = `${login ?? "unlinked viewer"}: ${roleName}`;
  if (!run.examples.includes(example)) run.examples.push(example);
};

type JobSummaryKey = "jobChangeCompleting" | "jobChangeSaving" | "jobDisableContinues" | "jobDisabled" | "jobDisconnectRetry" | "jobRequestContinues";

const jobSummary = (key: JobSummaryKey): Readonly<Record<"de" | "en", string>> => ({
  de: discordCatalog.de[key],
  en: discordCatalog.en[key],
});

const summary = (run: Pick<DiscordReconcileRun, "granted" | "removed" | "failed" | "skipped">): Readonly<Record<"de" | "en", string>> => {
  const fill = (template: string): string => template
    .replace("{granted}", String(run.granted))
    .replace("{removed}", String(run.removed))
    .replace("{failed}", String(run.failed))
    .replace("{skipped}", String(run.skipped));
  return { de: fill(discordCatalog.de.jobCounts), en: fill(discordCatalog.en.jobCounts) };
};

const runDiagnostic = (run: DiscordReconcileRun): ModuleDiagnostic => ({
  code: "discord.reconcile.summary",
  detail: {
    granted: run.granted,
    removed: run.removed,
    failed: run.failed,
    skipped: run.skipped,
    examples: JSON.stringify(run.examples.slice(0, 10)),
  },
});

const writeDiagnostics = async (context: ModuleAlarmContext, triggerId: string, diagnostics: readonly ModuleDiagnostic[], now: number): Promise<void> => {
  try { await context.writeDiagnostics?.(triggerId, diagnostics, new Date(now).toISOString()); } catch {
    // A diagnostic failure cannot undo a Discord role operation already fenced in the channel object.
  }
};

const chunk = (values: readonly string[], size: number): string[][] => {
  const groups: string[][] = [];
  for (let index = 0; index < values.length; index += size) groups.push(values.slice(index, index + size));
  return groups;
};

const readLinksForIdentities = async (
  db: D1Database,
  twitchUserIds: readonly string[],
  discordUserIds: readonly string[],
): Promise<{ byDiscordId: Map<string, DiscordMemberLink>; byTwitchId: Map<string, DiscordMemberLink> }> => {
  const collect = async (column: "twitch_user_id" | "discord_user_id", values: readonly string[]): Promise<DiscordMemberLink[]> => {
    const rows = await Promise.all(chunk([...new Set(values)], maxLinkQueryIds).map(async (group) => {
      if (group.length === 0) return [];
      const placeholders = group.map(() => "?").join(", ");
      const statement = column === "twitch_user_id"
        ? `SELECT discord_user_id AS discordUserId, twitch_user_id AS twitchUserId, twitch_login AS twitchLogin
             FROM discord_links WHERE twitch_user_id IN (${placeholders})`
        : `SELECT discord_user_id AS discordUserId, twitch_user_id AS twitchUserId, twitch_login AS twitchLogin
             FROM discord_links WHERE discord_user_id IN (${placeholders})`;
      const response = await db.prepare(statement).bind(...group).all<DiscordMemberLink>();
      return response.results;
    }));
    return rows.flat();
  };
  const [byTwitch, byDiscord] = await Promise.all([
    collect("twitch_user_id", twitchUserIds),
    collect("discord_user_id", discordUserIds),
  ]);
  const all = new Map<string, DiscordMemberLink>();
  for (const link of [...byTwitch, ...byDiscord]) all.set(link.discordUserId, link);
  const links = [...all.values()];
  return {
    byDiscordId: new Map(links.map((link) => [link.discordUserId, link])),
    byTwitchId: new Map(links.map((link) => [link.twitchUserId, link])),
  };
};

const desiredRoleWork = async (
  context: ModuleAlarmContext,
  guildId: string,
  mode: DiscordLifecycleState["mode"] | null,
  generation: number,
  revision: number,
): Promise<DiscordReconcileRun> => {
  const mappings = await getDiscordRoleMappings(context.DB, context.channelId);
  const [vip, moderator, grants] = await Promise.all([
    context.twitchRanks?.getTwitchRanks("vip"),
    context.twitchRanks?.getTwitchRanks("moderator"),
    Promise.resolve(readSql(context, (sql) => readDiscordGrants(sql, guildId))),
  ]);
  const ranks = {
    vip: { complete: vip?.complete === true, userIds: vip?.userIds ?? new Set<string>() },
    moderator: { complete: moderator?.complete === true, userIds: moderator?.userIds ?? new Set<string>() },
  } satisfies Record<"vip" | "moderator", DiscordRankMembership>;
  const links = await readLinksForIdentities(
    context.DB,
    [...ranks.vip.userIds, ...ranks.moderator.userIds, ...grants.map(({ twitchUserId }) => twitchUserId)],
    grants.map(({ discordUserId }) => discordUserId),
  );
  const assignments = mode === null
    ? desiredDiscordRoleGrants(mappings, {
      vip: ranks.vip.complete ? ranks.vip.userIds : new Set<string>(),
      moderator: ranks.moderator.complete ? ranks.moderator.userIds : new Set<string>(),
    }, [...links.byTwitchId.values()])
    : [];
  const desiredByKey = new Map(assignments.map((assignment) => [`${assignment.discordUserId}:${assignment.roleId}`, assignment]));
  const grantByKey = new Map(grants.map((grant) => [`${grant.discordUserId}:${grant.roleId}`, grant]));
  const keys = new Set([...desiredByKey.keys(), ...grantByKey.keys()]);
  const work = [...keys].sort((left, right) => left.localeCompare(right)).map((key): DiscordReconcileWorkItem => {
    const [discordUserId = "", roleId = ""] = key.split(":");
    const desired = desiredByKey.get(key) ?? null;
    const grant = grantByKey.get(key);
    const currentLink = links.byDiscordId.get(discordUserId) ?? null;
    const remove = mode !== null || grant !== undefined && discordRoleShouldBeRemoved(grant, currentLink, mappings, ranks);
    return { discordUserId, roleId, desired, remove };
  });
  return {
    work,
    cursor: 0,
    generation,
    revision,
    startedAt: Date.now(),
    granted: 0,
    removed: 0,
    failed: 0,
    skipped: 0,
    examples: [],
  };
};

const rankRemovalStillApplies = async (
  context: ModuleAlarmContext,
  grant: DiscordGrantRecord,
): Promise<boolean> => {
  const [mappings, vip, moderator, links] = await Promise.all([
    getDiscordRoleMappings(context.DB, context.channelId),
    context.twitchRanks?.getTwitchRanks("vip"),
    context.twitchRanks?.getTwitchRanks("moderator"),
    readLinksForIdentities(context.DB, [grant.twitchUserId], [grant.discordUserId]),
  ]);
  const ranks = {
    vip: { complete: vip?.complete === true, userIds: vip?.userIds ?? new Set<string>() },
    moderator: { complete: moderator?.complete === true, userIds: moderator?.userIds ?? new Set<string>() },
  } satisfies Record<"vip" | "moderator", DiscordRankMembership>;
  return discordRoleShouldBeRemoved(
    grant,
    links.byDiscordId.get(grant.discordUserId) ?? null,
    mappings,
    ranks,
  );
};

const discordRequest = async <Result>(
  budget: { used: number },
  action: () => Promise<Result>,
): Promise<Result> => {
  if (budget.used >= MAX_DISCORD_REQUESTS_PER_RUN) throw new DiscordRequestBudgetExceeded();
  budget.used += 1;
  return await action();
};

const scheduleAt = (context: ModuleAlarmContext, at: number): void => {
  context.channelJob?.scheduleNextAt?.(at);
};

const setTokenLock = async (context: ModuleAlarmContext, now: number): Promise<void> => {
  const created = await (await loadTokenLock()).setDiscordBotTokenLock(context.DB, new Date(now).toISOString());
  if (created) await writeDiagnostics(context, `discord:token_lock:set:${String(now)}`, [{ code: "discord.token_lock_set" }], now);
};

const rateLimitDeadline = (error: DiscordRequestError, now: number): number =>
  now + Math.max(0, (error.retryAfterSeconds ?? 1) * 1_000);

const deferDiscordRequests = (context: ModuleAlarmContext, retryAt: number): void => {
  writeSql(context, (sql) => { setDiscordRetryAt(sql, retryAt); });
  scheduleAt(context, retryAt);
};

const lockGuild = async (
  context: ModuleAlarmContext,
  guildId: string,
  reason: string,
  now: number,
): Promise<void> => {
  const wasLocked = readSql(context, (sql) => readDiscordServerLock(sql, guildId) !== null);
  writeSql(context, (sql) => { setDiscordServerLock(sql, { guildId, lockedAt: now, lastProbeAt: now, reason }); });
  if (!wasLocked) await writeDiagnostics(context, `discord:server_lock:set:${guildId}:${String(now)}`, [{ code: "discord.server_lock_set" }], now);
};

const lockMapping = async (
  context: ModuleAlarmContext,
  guildId: string,
  roleId: string,
  now: number,
): Promise<void> => {
  const mappings = await getDiscordRoleMappings(context.DB, context.channelId);
  const mappedRanks = rankTypes.filter((rankType) => mappings[rankType] === roleId);
  for (const rankType of mappedRanks) {
    const wasLocked = readSql(context, (sql) => readDiscordMappingLocks(sql, guildId)
      .some((lock) => lock.rankType === rankType && lock.roleId === roleId));
    writeSql(context, (sql) => { setDiscordMappingLock(sql, { guildId, rankType, roleId, lockedAt: now, lastProbeAt: now }); });
    if (!wasLocked) await writeDiagnostics(context, `discord:mapping_lock:set:${rankType}:${roleId}:${String(now)}`, [{ code: "discord.mapping_lock_set" }], now);
  }
};

const currentGrant = (context: ModuleAlarmContext, guildId: string, discordUserId: string, roleId: string): DiscordGrantRecord | null => readSql(context, (sql) => {
  ensureDiscordDurableSchema(sql);
  return sql.exec<DiscordGrantRecord>(
    `SELECT guild_id AS guildId, discord_user_id AS discordUserId, twitch_user_id AS twitchUserId,
            role_id AS roleId, joined_at AS joinedAt, granted_at AS grantedAt, status
       FROM discord_role_grants WHERE guild_id = ? AND discord_user_id = ? AND role_id = ?`,
    guildId,
    discordUserId,
    roleId,
  ).toArray()[0] ?? null;
});

const markDiscordMemberMissing = (context: ModuleAlarmContext, guildId: string, discordUserId: string, checkedAt: number): void => {
  writeSql(context, (sql) => {
    removeDiscordMemberGrants(sql, guildId, discordUserId);
    clearDiscordMemberRoleState(sql, guildId, discordUserId);
    setDiscordMemberNotInServer(sql, guildId, discordUserId, checkedAt);
  });
};

const discordServerStateProbe = async (
  environment: DiscordEnvironment,
  guildId: string,
  mappings: { vip: string | null; moderator: string | null },
  budget: { used: number },
  context: ModuleAlarmContext,
  revision: number,
): Promise<Awaited<ReturnType<typeof readDiscordGuildState>>> => await readDiscordGuildState(
  environment,
  guildId,
  mappings,
  fetch,
  () => {
    if (!progressControlIsCurrent(context, revision)) throw new DiscordRequestBudgetExceeded();
    if (budget.used >= MAX_DISCORD_REQUESTS_PER_RUN) throw new DiscordRequestBudgetExceeded();
    budget.used += 1;
  },
);

const unlockServer = async (context: ModuleAlarmContext, guildId: string, now: number): Promise<void> => {
  writeSql(context, (sql) => { clearDiscordServerLock(sql, guildId); });
  await writeDiagnostics(context, `discord:server_lock:cleared:${guildId}:${String(now)}`, [{ code: "discord.server_lock_cleared" }], now);
};

const probeLockedGuild = async (
  context: ModuleAlarmContext,
  environment: DiscordEnvironment,
  guildId: string,
  mappings: { vip: string | null; moderator: string | null },
  budget: { used: number },
  now: number,
  revision: number,
): Promise<"clear" | "keep" | "rate_limited" | "token_invalid" | "budget"> => {
  const lock = readSql(context, (sql) => readDiscordServerLock(sql, guildId));
  if (lock === null) return "clear";
  if (now - lock.lastProbeAt < DISCORD_MEMBER_PROBE_INTERVAL_MS) {
    scheduleAt(context, lock.lastProbeAt + DISCORD_MEMBER_PROBE_INTERVAL_MS);
    return "keep";
  }
  try {
    const state = await discordServerStateProbe(environment, guildId, mappings, budget, context, revision);
    writeSql(context, (sql) => { updateDiscordServerProbe(sql, guildId, now); });
    if (state.state === "connected" || state.state === "role_too_low") {
      await unlockServer(context, guildId, now);
      return "clear";
    }
    scheduleAt(context, now + DISCORD_MEMBER_PROBE_INTERVAL_MS);
    return "keep";
  } catch (error) {
    if (error instanceof DiscordRequestBudgetExceeded) return "budget";
    if (error instanceof DiscordRequestError && error.status === 429) {
      const retryAt = rateLimitDeadline(error, Date.now());
      deferDiscordRequests(context, retryAt);
      return "rate_limited";
    }
    if (error instanceof DiscordRequestError && error.status === 401) {
      await setTokenLock(context, now);
      scheduleAt(context, now + DISCORD_TOKEN_PROBE_INTERVAL_MS);
      return "token_invalid";
    }
    writeSql(context, (sql) => { updateDiscordServerProbe(sql, guildId, now); });
    scheduleAt(context, now + DISCORD_MEMBER_PROBE_INTERVAL_MS);
    return "keep";
  }
};

const probeLockedMapping = async (
  context: ModuleAlarmContext,
  environment: DiscordEnvironment,
  guildId: string,
  lock: DiscordMappingLock,
  mappings: { vip: string | null; moderator: string | null },
  budget: { used: number },
  now: number,
  revision: number,
): Promise<"clear" | "keep" | "server_locked" | "rate_limited" | "token_invalid" | "budget"> => {
  if (now - lock.lastProbeAt < DISCORD_MEMBER_PROBE_INTERVAL_MS) {
    scheduleAt(context, lock.lastProbeAt + DISCORD_MEMBER_PROBE_INTERVAL_MS);
    return "keep";
  }
  try {
    const state = await discordServerStateProbe(environment, guildId, mappings, budget, context, revision);
    writeSql(context, (sql) => { updateDiscordMappingProbe(sql, lock, now); });
    if (state.state === "permissions_missing") {
      await lockGuild(context, guildId, "permissions_missing", now);
      scheduleAt(context, now + DISCORD_MEMBER_PROBE_INTERVAL_MS);
      return "server_locked";
    }
    if (state.state === "bot_removed") {
      await lockGuild(context, guildId, "bot_removed", now);
      scheduleAt(context, now + DISCORD_MEMBER_PROBE_INTERVAL_MS);
      return "server_locked";
    }
    if ((state.state === "connected" || state.state === "role_too_low") && !state.roles.some(({ id }) => id === lock.roleId)) {
      writeSql(context, (sql) => {
        sql.exec("DELETE FROM discord_role_grants WHERE guild_id = ? AND role_id = ?", guildId, lock.roleId);
        sql.exec("DELETE FROM discord_member_role_states WHERE guild_id = ? AND role_id = ?", guildId, lock.roleId);
      });
      scheduleAt(context, now + DISCORD_MEMBER_PROBE_INTERVAL_MS);
      return "keep";
    }
    if ((state.state === "connected" || state.state === "role_too_low") &&
        state.roles.some(({ id, position }) => id === lock.roleId && position < (state.botHighestRolePosition ?? -1))) {
      writeSql(context, (sql) => { clearDiscordMappingLock(sql, lock); });
      await writeDiagnostics(context, `discord:mapping_lock:cleared:${lock.rankType}:${lock.roleId}:${String(now)}`, [{ code: "discord.mapping_lock_cleared" }], now);
      return "clear";
    }
    scheduleAt(context, now + DISCORD_MEMBER_PROBE_INTERVAL_MS);
    return "keep";
  } catch (error) {
    if (error instanceof DiscordRequestBudgetExceeded) return "budget";
    if (error instanceof DiscordRequestError && error.status === 429) {
      const retryAt = rateLimitDeadline(error, Date.now());
      deferDiscordRequests(context, retryAt);
      return "rate_limited";
    }
    if (error instanceof DiscordRequestError && error.status === 401) {
      await setTokenLock(context, now);
      scheduleAt(context, now + DISCORD_TOKEN_PROBE_INTERVAL_MS);
      return "token_invalid";
    }
    writeSql(context, (sql) => { updateDiscordMappingProbe(sql, lock, now); });
    scheduleAt(context, now + DISCORD_MEMBER_PROBE_INTERVAL_MS);
    return "keep";
  }
};

const progressControlIsCurrent = (context: ModuleAlarmContext, revision: number): boolean =>
  readSql(context, (sql) => {
    const barrier = readDiscordReconcileMutationBarrier(sql);
    return readDiscordReconcileRevision(sql) === revision && (barrier === null || barrier.expiresAt <= Date.now());
  });

const rankGenerationIsCurrent = async (context: ModuleAlarmContext, generation: number): Promise<boolean> =>
  (await context.twitchRanks?.isDirty())?.generation === generation;

const runIsComplete = (run: DiscordReconcileRun): boolean => run.cursor >= run.work.length;

const applyDiscordRequestError = async (
  context: ModuleAlarmContext,
  environment: DiscordEnvironment,
  guildId: string,
  item: DiscordReconcileWorkItem,
  error: unknown,
  budget: { used: number },
  now: number,
  run: DiscordReconcileRun,
): Promise<"continue" | "rate_limited" | "token_invalid" | "server_locked" | "budget"> => {
  if (error instanceof DiscordRequestBudgetExceeded) {
    scheduleAt(context, now + FOLLOW_UP_DELAY_MS);
    return "budget";
  }
  if (!(error instanceof DiscordRequestError)) {
    run.failed += 1;
    run.cursor += 1;
    addExample(run, item.desired?.twitchLogin ?? null, item.roleId);
    saveRun(context, run);
    return "continue";
  }
  if (error.status === 429) {
    deferDiscordRequests(context, rateLimitDeadline(error, Date.now()));
    return "rate_limited";
  }
  if (error.status === 401) {
    await setTokenLock(context, now);
    scheduleAt(context, now + DISCORD_TOKEN_PROBE_INTERVAL_MS);
    return "token_invalid";
  }
  if (!progressControlIsCurrent(context, run.revision)) {
    clearRun(context);
    scheduleAt(context, Date.now() + FOLLOW_UP_DELAY_MS);
    return "budget";
  }
  if (error.discordCode === 10004 || error.discordCode === 50001) {
    await lockGuild(context, guildId, error.discordCode === 10004 ? "bot_removed" : "missing_access", now);
    const lifecycle = readSql(context, (sql) => readDiscordLifecycle(sql));
    if (lifecycle?.mode === "disconnecting" && now - lifecycle.startedAt >= DISCORD_DISCONNECT_GIVE_UP_MS) {
      const disconnected = await disconnectDiscordServerAfterDeferredCleanup(context.DB, context.channelId, guildId, lifecycle.connectedAt ?? "");
      const currentConnection = await getDiscordServerConnection(context.DB, context.channelId);
      if (!disconnected && currentConnection?.guildId === guildId && currentConnection.connectedAt === (lifecycle.connectedAt ?? "")) {
        scheduleAt(context, now + DISCORD_MEMBER_PROBE_INTERVAL_MS);
        return "server_locked";
      }
      writeSql(context, (sql) => { clearDiscordGuildState(sql, guildId); });
      await writeDiagnostics(context, `discord:disconnect:given_up:${String(now)}`, [{ code: "discord.disconnect_given_up" }], now);
      run.cursor = run.work.length;
      return "continue";
    }
    scheduleAt(context, now + DISCORD_MEMBER_PROBE_INTERVAL_MS);
    return "server_locked";
  }
  if (error.discordCode === 10011) {
    await lockMapping(context, guildId, item.roleId, now);
    writeSql(context, (sql) => {
      sql.exec("DELETE FROM discord_role_grants WHERE guild_id = ? AND role_id = ?", guildId, item.roleId);
    });
    run.skipped += 1;
    run.cursor += 1;
    saveRun(context, run);
    scheduleAt(context, now + DISCORD_MEMBER_PROBE_INTERVAL_MS);
    return readSql(context, (sql) => readDiscordServerLock(sql, guildId)) === null ? "continue" : "server_locked";
  }
  if (error.discordCode === 50013) {
    await lockMapping(context, guildId, item.roleId, now);
    const mappings = await getDiscordRoleMappings(context.DB, context.channelId);
    if (!progressControlIsCurrent(context, run.revision)) {
      clearRun(context);
      scheduleAt(context, Date.now() + FOLLOW_UP_DELAY_MS);
      return "budget";
    }
    try {
      const state = await discordServerStateProbe(environment, guildId, mappings, budget, context, run.revision);
      if (state.state === "permissions_missing") {
        await lockGuild(context, guildId, "permissions_missing", now);
        scheduleAt(context, now + DISCORD_MEMBER_PROBE_INTERVAL_MS);
        return "server_locked";
      }
      if (state.state === "bot_removed") {
        await lockGuild(context, guildId, "bot_removed", now);
        scheduleAt(context, now + DISCORD_MEMBER_PROBE_INTERVAL_MS);
        return "server_locked";
      }
    } catch (probeError) {
      if (probeError instanceof DiscordRequestError && probeError.status === 401) {
        await setTokenLock(context, now);
        scheduleAt(context, now + DISCORD_TOKEN_PROBE_INTERVAL_MS);
        return "token_invalid";
      }
      if (probeError instanceof DiscordRequestError && probeError.status === 429) {
        const retryAt = rateLimitDeadline(probeError, Date.now());
        deferDiscordRequests(context, retryAt);
        writeSql(context, (sql) => {
          for (const lock of readDiscordMappingLocks(sql, guildId).filter(({ roleId }) => roleId === item.roleId)) {
            updateDiscordMappingProbe(sql, lock, retryAt - DISCORD_MEMBER_PROBE_INTERVAL_MS);
          }
        });
        return "rate_limited";
      }
      if (probeError instanceof DiscordRequestBudgetExceeded) {
        writeSql(context, (sql) => {
          for (const lock of readDiscordMappingLocks(sql, guildId).filter(({ roleId }) => roleId === item.roleId)) {
            updateDiscordMappingProbe(sql, lock, Date.now() - DISCORD_MEMBER_PROBE_INTERVAL_MS);
          }
        });
        scheduleAt(context, now + FOLLOW_UP_DELAY_MS);
        return "budget";
      }
    }
    run.failed += 1;
    run.cursor += 1;
    addExample(run, item.desired?.twitchLogin ?? null, item.roleId);
    saveRun(context, run);
    scheduleAt(context, now + DISCORD_MEMBER_PROBE_INTERVAL_MS);
    return readSql(context, (sql) => readDiscordServerLock(sql, guildId)) === null ? "continue" : "server_locked";
  }
  run.failed += 1;
  run.cursor += 1;
  addExample(run, item.desired?.twitchLogin ?? null, item.roleId);
  saveRun(context, run);
  return "continue";
};

const globalTokenLockAllowsRun = async (
  context: ModuleAlarmContext,
  environment: DiscordEnvironment,
  budget: { used: number },
  now: number,
): Promise<"ok" | "locked" | "rate_limited" | "budget"> => {
  const tokenLock = await loadTokenLock();
  const lock = await tokenLock.readDiscordBotTokenLock(context.DB);
  if (lock === null) return "ok";
  const lastProbeAt = Date.parse(lock.lastProbeAt);
  if (!Number.isFinite(lastProbeAt) || now - lastProbeAt < DISCORD_TOKEN_PROBE_INTERVAL_MS) {
    scheduleAt(context, (Number.isFinite(lastProbeAt) ? lastProbeAt : now) + DISCORD_TOKEN_PROBE_INTERVAL_MS);
    return "locked";
  }
  const claimedAt = new Date(now).toISOString();
  const claimToken = crypto.randomUUID();
  const claimed = await tokenLock.claimDiscordBotTokenProbe(context.DB, lock.lastProbeAt, claimedAt, claimToken,
    new Date(now + 30_000).toISOString(), new Date(now).toISOString(), new Date(now - DISCORD_TOKEN_PROBE_INTERVAL_MS).toISOString());
  if (!claimed) {
    const latest = await tokenLock.readDiscordBotTokenLock(context.DB);
    const latestProbeAt = latest === null ? now : Date.parse(latest.lastProbeAt);
    scheduleAt(context, (Number.isFinite(latestProbeAt) ? latestProbeAt : now) + DISCORD_TOKEN_PROBE_INTERVAL_MS);
    return latest === null ? "ok" : "locked";
  }
  try {
    await discordRequest(budget, async () => await discordApiRequest(environment, "GET", "/users/@me"));
    if (await tokenLock.clearClaimedDiscordBotTokenLock(context.DB, claimedAt, claimToken)) {
      await writeDiagnostics(context, `discord:token_lock:cleared:${String(now)}`, [{ code: "discord.token_lock_cleared" }], now);
      return "ok";
    }
    const latest = await tokenLock.readDiscordBotTokenLock(context.DB);
    if (latest === null) return "ok";
    const latestProbeAt = Date.parse(latest.lastProbeAt);
    scheduleAt(context, (Number.isFinite(latestProbeAt) ? latestProbeAt : Date.now()) + DISCORD_TOKEN_PROBE_INTERVAL_MS);
    return "locked";
  } catch (error) {
    if (error instanceof DiscordRequestBudgetExceeded) {
      await tokenLock.releaseDiscordBotTokenProbe(context.DB, claimedAt, claimToken);
      scheduleAt(context, now + FOLLOW_UP_DELAY_MS);
      return "budget";
    }
    if (error instanceof DiscordRequestError && error.status === 429) {
      const retryAt = rateLimitDeadline(error, Date.now());
      await tokenLock.deferDiscordBotTokenProbe(context.DB, claimedAt, claimToken, new Date(retryAt).toISOString());
      scheduleAt(context, retryAt);
      return "rate_limited";
    }
    await tokenLock.releaseDiscordBotTokenProbe(context.DB, claimedAt, claimToken);
    scheduleAt(context, now + DISCORD_TOKEN_PROBE_INTERVAL_MS);
    return "locked";
  }
};

const completionResult = async (
  context: ModuleAlarmContext,
  environment: DiscordEnvironment,
  guildId: string,
  lifecycle: DiscordLifecycleState | null,
  run: DiscordReconcileRun,
  ranks: { dirty: boolean; generation: number },
  now: number,
): Promise<unknown> => {
  if (lifecycle?.deferred === false && Date.now() - lifecycle.startedAt < DISCORD_IMMEDIATE_CLEANUP_GRACE_MS) {
    scheduleAt(context, lifecycle.startedAt + DISCORD_IMMEDIATE_CLEANUP_GRACE_MS);
    return { summary: jobSummary("jobChangeCompleting") };
  }
  const grants = readSql(context, (sql) => countDiscordGrants(sql, guildId));
  if (lifecycle?.mode === "disconnecting" && grants === 0) {
    const disconnected = await disconnectDiscordServerAfterDeferredCleanup(context.DB, context.channelId, guildId, lifecycle.connectedAt ?? "");
    const currentConnection = await getDiscordServerConnection(context.DB, context.channelId);
    if (!disconnected && currentConnection?.guildId === guildId && currentConnection.connectedAt === lifecycle.connectedAt) {
      scheduleAt(context, now + DISCORD_MEMBER_PROBE_INTERVAL_MS);
      return { summary: summary(run) };
    }
    writeSql(context, (sql) => { clearDiscordGuildState(sql, guildId); });
    await writeDiagnostics(context, `discord:disconnect:finished:${String(now)}`, [{ code: "discord.disconnect_finished" }], now);
  } else if (lifecycle?.mode === "teardown" && grants === 0) {
    await writeDiagnostics(context, `discord:reconcile:${String(run.startedAt)}`, [runDiagnostic(run)], now);
    const completed = await context.completeDeferredModuleDisable?.() ?? false;
    if (!completed) {
      scheduleAt(context, now + FOLLOW_UP_DELAY_MS);
      return { summary: summary(run) };
    }
    return { summary: summary(run) };
  }
  if (context.twitchRanks !== undefined && !context.twitchRanks.markReconciled(ranks.generation)) {
    scheduleAt(context, now + FOLLOW_UP_DELAY_MS);
  }
  await writeDiagnostics(context, `discord:reconcile:${String(run.startedAt)}`, [runDiagnostic(run)], now);
  clearRun(context);
  void environment;
  return { summary: summary(run) };
};

export const discordReconcileAlarm = async (context: ModuleAlarmContext): Promise<unknown> => {
  const job = context.channelJob;
  const environment = context.environment as DiscordEnvironment | undefined;
  if (job === undefined || context.twitchRanks === undefined || environment === undefined || context.channelId.length === 0) {
    throw new Error("Discord role reconciliation is missing its channel job runtime.");
  }
  job.assertCurrent();
  const now = Date.now();
  const barrier = readSql(context, (sql) => readDiscordReconcileMutationBarrier(sql));
  if (barrier !== null && barrier.expiresAt > now) {
    scheduleAt(context, barrier.expiresAt);
    return { summary: jobSummary("jobChangeSaving") };
  }
  if (barrier !== null) writeSql(context, (sql) => clearDiscordReconcileMutationBarrier(sql, barrier.token));
  const initialLifecycle = readSql(context, (sql) => readDiscordLifecycle(sql));
  if (initialLifecycle?.mode === "teardown" && initialLifecycle.deferred === false &&
      now - initialLifecycle.startedAt < DISCORD_IMMEDIATE_CLEANUP_GRACE_MS) {
    scheduleAt(context, initialLifecycle.startedAt + DISCORD_IMMEDIATE_CLEANUP_GRACE_MS);
    return { summary: jobSummary("jobChangeCompleting") };
  }
  const tokenBudget = { used: 0 };
  const connection = await getDiscordServerConnection(context.DB, context.channelId);
  if (connection === null) {
    const staleLifecycle = readSql(context, (sql) => readDiscordLifecycle(sql));
    if (staleLifecycle !== null) {
      const staleGuildId = staleLifecycle.guildId;
      const staleGrantCount = staleGuildId === null ? 0 : readSql(context, (sql) => countDiscordGrants(sql, staleGuildId));
      if (staleGrantCount === 0) {
        if (staleLifecycle.mode === "teardown") {
          const pendingRun = readRun(context);
          if (pendingRun !== null) {
            await writeDiagnostics(context, `discord:reconcile:${String(pendingRun.startedAt)}`, [runDiagnostic(pendingRun)], now);
          }
          if (!await context.completeDeferredModuleDisable?.()) {
            scheduleAt(context, now + FOLLOW_UP_DELAY_MS);
            return { summary: jobSummary("jobDisableContinues") };
          }
          return { summary: jobSummary("jobDisabled") };
        }
        if (staleGuildId !== null) writeSql(context, (sql) => { clearDiscordGuildState(sql, staleGuildId); });
        else writeSql(context, (sql) => { clearDiscordLifecycle(sql); });
        await writeDiagnostics(context, `discord:disconnect:finished:${String(now)}`, [{ code: "discord.disconnect_finished" }], now);
      } else if (staleLifecycle.mode === "disconnecting" && now - staleLifecycle.startedAt >= DISCORD_DISCONNECT_GIVE_UP_MS) {
        if (staleGuildId !== null) writeSql(context, (sql) => { clearDiscordGuildState(sql, staleGuildId); });
        else writeSql(context, (sql) => { clearDiscordLifecycle(sql); });
        writeSql(context, (sql) => { clearDiscordChatHints(sql); });
        await writeDiagnostics(context, `discord:disconnect:given_up:${String(now)}`, [{ code: "discord.disconnect_given_up" }], now);
      } else {
        scheduleAt(context, now + DISCORD_MEMBER_PROBE_INTERVAL_MS);
        return { summary: jobSummary("jobDisconnectRetry") };
      }
    }
    const dirty = await context.twitchRanks.isDirty();
    if (dirty.dirty) context.twitchRanks.markReconciled(dirty.generation);
    return { summary: summary({ granted: 0, removed: 0, failed: 0, skipped: 0 }) };
  }
  const guildId = connection.guildId;
  let lifecycle = readSql(context, (sql) => readDiscordLifecycle(sql));
  if (lifecycle !== null && lifecycle.guildId !== null &&
      (lifecycle.guildId !== connection.guildId || lifecycle.connectedAt !== null && lifecycle.connectedAt !== connection.connectedAt)) {
    const oldGuildId = lifecycle.guildId;
    writeSql(context, (sql) => { clearDiscordGuildState(sql, oldGuildId); });
    if (lifecycle.mode === "disconnecting") {
      await writeDiagnostics(context, `discord:disconnect:finished:${String(now)}`, [{ code: "discord.disconnect_finished" }], now);
    }
    lifecycle = null;
  }
  const serverLock = readSql(context, (sql) => readDiscordServerLock(sql, guildId));
  if (lifecycle?.deferred === false && now - lifecycle.startedAt < DISCORD_IMMEDIATE_CLEANUP_GRACE_MS) {
    scheduleAt(context, lifecycle.startedAt + DISCORD_IMMEDIATE_CLEANUP_GRACE_MS);
    return { summary: jobSummary("jobChangeCompleting") };
  }
  if (lifecycle !== null && readSql(context, (sql) => countDiscordGrants(sql, guildId)) === 0) {
    if (lifecycle.mode === "disconnecting") {
      const expectedConnectedAt = lifecycle.connectedAt ?? connection.connectedAt;
      const disconnected = await disconnectDiscordServerAfterDeferredCleanup(context.DB, context.channelId, guildId, expectedConnectedAt);
      const latestConnection = await getDiscordServerConnection(context.DB, context.channelId);
      if (!disconnected && latestConnection?.guildId === guildId && latestConnection.connectedAt === expectedConnectedAt) {
        scheduleAt(context, now + DISCORD_MEMBER_PROBE_INTERVAL_MS);
        return { summary: jobSummary("jobDisconnectRetry") };
      }
      writeSql(context, (sql) => { clearDiscordGuildState(sql, guildId); });
      clearRun(context);
      await writeDiagnostics(context, `discord:disconnect:finished:${String(now)}`, [{ code: "discord.disconnect_finished" }], now);
      const ranks = await context.twitchRanks.isDirty();
      if (ranks.dirty) context.twitchRanks.markReconciled(ranks.generation);
      return { summary: { de: "Discord-Verbindung getrennt", en: "Discord server disconnected" } };
    }
    const pendingRun = readRun(context);
    if (pendingRun !== null) {
      await writeDiagnostics(context, `discord:reconcile:${String(pendingRun.startedAt)}`, [runDiagnostic(pendingRun)], now);
    }
    const completed = await context.completeDeferredModuleDisable?.() ?? false;
    if (!completed) {
      scheduleAt(context, now + FOLLOW_UP_DELAY_MS);
      return { summary: jobSummary("jobDisableContinues") };
    }
    return { summary: jobSummary("jobDisabled") };
  }
  if (lifecycle?.mode === "disconnecting" && serverLock !== null && now - lifecycle.startedAt >= DISCORD_DISCONNECT_GIVE_UP_MS) {
    const disconnected = await disconnectDiscordServerAfterDeferredCleanup(context.DB, context.channelId, guildId, lifecycle.connectedAt ?? connection.connectedAt);
    const currentConnection = await getDiscordServerConnection(context.DB, context.channelId);
    if (!disconnected && currentConnection?.guildId === guildId && currentConnection.connectedAt === connection.connectedAt) {
      scheduleAt(context, now + DISCORD_MEMBER_PROBE_INTERVAL_MS);
      return { summary: jobSummary("jobDisconnectRetry") };
    }
    writeSql(context, (sql) => { clearDiscordGuildState(sql, guildId); });
    await writeDiagnostics(context, `discord:disconnect:given_up:${String(now)}`, [{ code: "discord.disconnect_given_up" }], now);
    return { summary: { de: "Verbindung nach 30 Tagen getrennt", en: "Disconnected after 30 days" } };
  }
  const retryAt = readSql(context, (sql) => readDiscordRetryAt(sql));
  if (retryAt !== null && retryAt > Date.now()) {
    scheduleAt(context, retryAt);
    return { summary: jobSummary("jobRequestContinues") };
  }
  if (retryAt !== null) writeSql(context, (sql) => { clearDiscordRetryAt(sql); });
  const tokenState = await globalTokenLockAllowsRun(context, environment, tokenBudget, now);
  if (tokenState === "locked") return { ok: false, code: "discord_token_invalid" };
  if (tokenState === "rate_limited" || tokenState === "budget") return { summary: jobSummary("jobRequestContinues") };
  const rankDirty = await context.twitchRanks.isDirty();
  const control = readSql(context, (sql) => ({
    lifecycle: readDiscordLifecycle(sql),
    revision: readDiscordReconcileRevision(sql),
  }));
  const existingRun = readRun(context);
  lifecycle = control.lifecycle;
  const revision = control.revision;
  if (lifecycle?.deferred === false && Date.now() - lifecycle.startedAt < DISCORD_IMMEDIATE_CLEANUP_GRACE_MS) {
    scheduleAt(context, lifecycle.startedAt + DISCORD_IMMEDIATE_CLEANUP_GRACE_MS);
    return { summary: jobSummary("jobChangeCompleting") };
  }
  const run = existingRun !== null && existingRun.generation === rankDirty.generation && existingRun.revision === revision
    ? existingRun
    : await desiredRoleWork(context, guildId, lifecycle?.mode ?? null, rankDirty.generation, revision);
  if (run !== existingRun) saveRun(context, run);
  const mappings = await getDiscordRoleMappings(context.DB, context.channelId);
  if (!await rankGenerationIsCurrent(context, run.generation) || !progressControlIsCurrent(context, run.revision)) {
    clearRun(context);
    scheduleAt(context, Date.now() + FOLLOW_UP_DELAY_MS);
    return { summary: summary(run) };
  }
  const budget = { used: tokenBudget.used };
  const notInServerThisRun = new Set<string>();
  const serverProbe = await probeLockedGuild(context, environment, guildId, mappings, budget, now, run.revision);
  if (!await rankGenerationIsCurrent(context, run.generation) || !progressControlIsCurrent(context, run.revision)) {
    clearRun(context);
    scheduleAt(context, Date.now() + FOLLOW_UP_DELAY_MS);
    return { summary: summary(run) };
  }
  if (serverProbe === "rate_limited") return { summary: summary(run) };
  if (serverProbe === "token_invalid") return { ok: false, code: "discord_token_invalid" };
  if (serverProbe === "budget") {
    scheduleAt(context, now + FOLLOW_UP_DELAY_MS);
    return { summary: summary(run) };
  }
  if (serverProbe === "keep") {
    run.skipped += Math.max(0, run.work.length - run.cursor);
    run.cursor = run.work.length;
    saveRun(context, run);
    return await completionResult(context, environment, guildId, lifecycle, run, rankDirty, now);
  }
  for (const lock of readSql(context, (sql) => readDiscordMappingLocks(sql, guildId))) {
    if (!await rankGenerationIsCurrent(context, run.generation) || !progressControlIsCurrent(context, run.revision)) {
      clearRun(context);
      scheduleAt(context, Date.now() + FOLLOW_UP_DELAY_MS);
      return { summary: summary(run) };
    }
    const probed = await probeLockedMapping(context, environment, guildId, lock, mappings, budget, Date.now(), run.revision);
    if (probed === "rate_limited") return { summary: summary(run) };
    if (probed === "token_invalid") return { ok: false, code: "discord_token_invalid" };
    if (probed === "server_locked") return { summary: summary(run) };
    if (probed === "budget") {
      scheduleAt(context, Date.now() + FOLLOW_UP_DELAY_MS);
      return { summary: summary(run) };
    }
  }
  while (!runIsComplete(run)) {
    job.assertCurrent();
    if (!await rankGenerationIsCurrent(context, run.generation) || !progressControlIsCurrent(context, run.revision)) {
      clearRun(context);
      scheduleAt(context, now + FOLLOW_UP_DELAY_MS);
      return { summary: summary(run) };
    }
    const item = run.work[run.cursor];
    if (item === undefined) break;
    const mappingLocks = readSql(context, (sql) => readDiscordMappingLocks(sql, guildId))
      .filter((lock) => lock.roleId === item.roleId);
    let mappingBlocked = false;
    for (const lock of mappingLocks) {
      if (!await rankGenerationIsCurrent(context, run.generation) || !progressControlIsCurrent(context, run.revision)) {
        clearRun(context);
        scheduleAt(context, Date.now() + FOLLOW_UP_DELAY_MS);
        return { summary: summary(run) };
      }
      const probed = await probeLockedMapping(context, environment, guildId, lock, mappings, budget, Date.now(), run.revision);
      if (probed === "rate_limited") return { summary: summary(run) };
      if (probed === "token_invalid") return { ok: false, code: "discord_token_invalid" };
      if (probed === "server_locked") return { summary: summary(run) };
      if (probed === "budget") {
        scheduleAt(context, Date.now() + FOLLOW_UP_DELAY_MS);
        return { summary: summary(run) };
      }
      if (probed === "keep") mappingBlocked = true;
    }
    if (!await rankGenerationIsCurrent(context, run.generation) || !progressControlIsCurrent(context, run.revision)) {
      clearRun(context);
      scheduleAt(context, Date.now() + FOLLOW_UP_DELAY_MS);
      return { summary: summary(run) };
    }
    if (mappingBlocked) {
      run.skipped += 1;
      run.cursor += 1;
      saveRun(context, run);
      continue;
    }
    const memberGrant = currentGrant(context, guildId, item.discordUserId, item.roleId);
    if (memberGrant === null && !item.desired) {
      run.cursor += 1;
      saveRun(context, run);
      continue;
    }
    if (notInServerThisRun.has(item.discordUserId)) {
      run.skipped += 1;
      run.cursor += 1;
      saveRun(context, run);
      continue;
    }
    if (budget.used >= MAX_DISCORD_REQUESTS_PER_RUN) {
      scheduleAt(context, Date.now() + FOLLOW_UP_DELAY_MS);
      saveRun(context, run);
      return { summary: summary(run) };
    }
    let member;
    try {
      member = await discordRequest(budget, async () => await getDiscordGuildMember(environment, guildId, item.discordUserId));
    } catch (error) {
      if (error instanceof DiscordRequestError && error.discordCode === 10007) {
        markDiscordMemberMissing(context, guildId, item.discordUserId, Date.now());
        notInServerThisRun.add(item.discordUserId);
        run.skipped += 1;
        run.cursor += 1;
        saveRun(context, run);
        continue;
      }
      const disposition = await applyDiscordRequestError(context, environment, guildId, item, error, budget, Date.now(), run);
      if (disposition === "rate_limited") return { summary: summary(run) };
      if (disposition === "token_invalid") return { ok: false, code: "discord_token_invalid" };
      if (disposition === "server_locked") return { summary: summary(run) };
      if (disposition === "budget") return { summary: summary(run) };
      continue;
    }
    if (!await rankGenerationIsCurrent(context, run.generation) || !progressControlIsCurrent(context, run.revision)) {
      clearRun(context);
      scheduleAt(context, Date.now() + FOLLOW_UP_DELAY_MS);
      return { summary: summary(run) };
    }
    writeSql(context, (sql) => {
      clearDiscordMemberState(sql, guildId, item.discordUserId);
      recordDiscordMemberRoleState(sql, {
        guildId,
        discordUserId: item.discordUserId,
        roleIds: [mappings.vip, mappings.moderator].filter((roleId): roleId is string => roleId !== null),
        presentRoleIds: member.roles,
        joinedAt: member.joinedAt,
        checkedAt: Date.now(),
      });
    });
    let grant = memberGrant;
    if (grant !== null && grant.joinedAt !== member.joinedAt) {
      writeSql(context, (sql) => { removeDiscordGrant(sql, guildId, item.discordUserId, item.roleId); });
      grant = null;
      run.skipped += 1;
      if (!item.desired || item.remove) {
        run.cursor += 1;
        saveRun(context, run);
        continue;
      }
    }
    const rolePresent = member.roles.includes(item.roleId);
    if (grant?.status === "pending") {
      if (rolePresent) {
        const resolvedAt = Date.now();
        writeSql(context, (sql) => { markDiscordGrantGranted(sql, grant as DiscordGrantRecord, resolvedAt); });
        run.granted += 1;
        addExample(run, item.desired?.twitchLogin ?? null, readSql(context, (sql) => readDiscordRoleNames(sql).get(item.roleId) ?? item.roleId));
        grant = { ...grant, status: "granted", grantedAt: resolvedAt };
      } else {
        writeSql(context, (sql) => { removeDiscordGrant(sql, guildId, item.discordUserId, item.roleId); });
        grant = null;
      }
    }
    if (item.remove && grant !== null) {
      if (!rolePresent) {
        writeSql(context, (sql) => { removeDiscordGrant(sql, guildId, item.discordUserId, item.roleId); });
        run.cursor += 1;
        saveRun(context, run);
        continue;
      }
      if (budget.used >= MAX_DISCORD_REQUESTS_PER_RUN) {
        scheduleAt(context, Date.now() + FOLLOW_UP_DELAY_MS);
        saveRun(context, run);
        return { summary: summary(run) };
      }
      if (!await rankGenerationIsCurrent(context, run.generation) || !progressControlIsCurrent(context, run.revision)) {
        clearRun(context);
        scheduleAt(context, Date.now() + FOLLOW_UP_DELAY_MS);
        return { summary: summary(run) };
      }
      const currentLifecycle = readSql(context, (sql) => readDiscordLifecycle(sql));
      if (currentLifecycle?.mode !== "teardown" && currentLifecycle?.mode !== "disconnecting" &&
          !await rankRemovalStillApplies(context, grant)) {
        run.skipped += 1;
        run.cursor += 1;
        saveRun(context, run);
        continue;
      }
      if (!await rankGenerationIsCurrent(context, run.generation) || !progressControlIsCurrent(context, run.revision)) {
        clearRun(context);
        scheduleAt(context, Date.now() + FOLLOW_UP_DELAY_MS);
        return { summary: summary(run) };
      }
      try {
        await discordRequest(budget, async () => await discordApiRequest(
          environment,
          "DELETE",
          `/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(item.discordUserId)}/roles/${encodeURIComponent(item.roleId)}`,
          undefined,
          "BroBot: remove rank role",
        ));
        writeSql(context, (sql) => { removeDiscordGrant(sql, guildId, item.discordUserId, item.roleId); });
        writeSql(context, (sql) => {
          setDiscordMemberRoleState(sql, {
            guildId,
            discordUserId: item.discordUserId,
            roleId: item.roleId,
            present: false,
            joinedAt: member.joinedAt,
            checkedAt: Date.now(),
          });
        });
        run.removed += 1;
        addExample(run, item.desired?.twitchLogin ?? null, readSql(context, (sql) => readDiscordRoleNames(sql).get(item.roleId) ?? item.roleId));
        run.cursor += 1;
        saveRun(context, run);
      } catch (error) {
        if (error instanceof DiscordRequestError && error.discordCode === 10007) {
          markDiscordMemberMissing(context, guildId, item.discordUserId, Date.now());
          notInServerThisRun.add(item.discordUserId);
          run.skipped += 1;
          run.cursor += 1;
          saveRun(context, run);
          continue;
        }
        const disposition = await applyDiscordRequestError(context, environment, guildId, item, error, budget, Date.now(), run);
        if (disposition === "rate_limited") return { summary: summary(run) };
        if (disposition === "token_invalid") return { ok: false, code: "discord_token_invalid" };
        if (disposition === "server_locked") return { summary: summary(run) };
        if (disposition === "budget") return { summary: summary(run) };
      }
      continue;
    }
    if (!item.desired || item.remove) {
      run.cursor += 1;
      saveRun(context, run);
      continue;
    }
    if (rolePresent) {
      if (grant === null) run.skipped += 1;
      run.cursor += 1;
      saveRun(context, run);
      continue;
    }
    if (budget.used >= MAX_DISCORD_REQUESTS_PER_RUN) {
      scheduleAt(context, Date.now() + FOLLOW_UP_DELAY_MS);
      saveRun(context, run);
      return { summary: summary(run) };
    }
    if (!await rankGenerationIsCurrent(context, run.generation) || !progressControlIsCurrent(context, run.revision)) {
      clearRun(context);
      scheduleAt(context, Date.now() + FOLLOW_UP_DELAY_MS);
      return { summary: summary(run) };
    }
    const pendingGrant = {
      guildId,
      discordUserId: item.discordUserId,
      twitchUserId: item.desired.twitchUserId,
      roleId: item.roleId,
      joinedAt: member.joinedAt,
    };
    const pending = { written: false };
    const claimCurrent = job.commit((sql) => {
      ensureDiscordDurableSchema(sql);
      const barrier = readDiscordReconcileMutationBarrier(sql);
      if (readDiscordReconcileRevision(sql) !== run.revision || readDiscordLifecycle(sql) !== null ||
          barrier !== null && barrier.expiresAt > Date.now()) return;
      resetDiscordGrantPending(sql, pendingGrant);
      pending.written = true;
    });
    if (!claimCurrent) job.assertCurrent();
    if (!pending.written) {
      clearRun(context);
      scheduleAt(context, Date.now() + FOLLOW_UP_DELAY_MS);
      return { summary: summary(run) };
    }
    try {
      await discordRequest(budget, async () => await discordApiRequest(
        environment,
        "PUT",
        `/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(item.discordUserId)}/roles/${encodeURIComponent(item.roleId)}`,
        undefined,
        `BroBot: Twitch ${mappings.vip === item.roleId ? "VIP" : "moderator"}`,
      ));
      writeSql(context, (sql) => { markDiscordGrantGranted(sql, pendingGrant, Date.now()); });
      writeSql(context, (sql) => {
        setDiscordMemberRoleState(sql, {
          guildId,
          discordUserId: item.discordUserId,
          roleId: item.roleId,
          present: true,
          joinedAt: member.joinedAt,
          checkedAt: Date.now(),
        });
      });
      run.granted += 1;
      addExample(run, item.desired.twitchLogin, readSql(context, (sql) => readDiscordRoleNames(sql).get(item.roleId) ?? item.roleId));
      run.cursor += 1;
      saveRun(context, run);
    } catch (error) {
      if (error instanceof DiscordRequestError && error.discordCode === 10007) {
        markDiscordMemberMissing(context, guildId, item.discordUserId, Date.now());
        notInServerThisRun.add(item.discordUserId);
        run.skipped += 1;
        run.cursor += 1;
        saveRun(context, run);
        continue;
      }
      if (error instanceof DiscordRequestBudgetExceeded || error instanceof DiscordRequestError &&
          error.status >= 400 && error.status < 500 && error.status !== 408) {
        writeSql(context, (sql) => { removeDiscordGrant(sql, guildId, item.discordUserId, item.roleId); });
      }
      const disposition = await applyDiscordRequestError(context, environment, guildId, item, error, budget, Date.now(), run);
      if (disposition === "rate_limited") return { summary: summary(run) };
      if (disposition === "token_invalid") return { ok: false, code: "discord_token_invalid" };
      if (disposition === "server_locked") return { summary: summary(run) };
      if (disposition === "budget") return { summary: summary(run) };
    }
  }
  const latestLifecycle = readSql(context, (sql) => readDiscordLifecycle(sql));
  const latestRanks = await context.twitchRanks.isDirty();
  if (latestRanks.generation !== run.generation || !progressControlIsCurrent(context, run.revision)) {
    clearRun(context);
    scheduleAt(context, Date.now() + FOLLOW_UP_DELAY_MS);
    return { summary: summary(run) };
  }
  return await completionResult(context, environment, guildId, latestLifecycle, run, rankDirty, Date.now());
};

export const previewDiscordMappingsInDurableObject = async (
  context: Pick<ModuleAlarmContext, "DB" | "channelId" | "twitchRanks">,
  mappings: { vip: string | null; moderator: string | null },
  sql: SqlStorage,
): Promise<{ gain: { count: number; roleName: string }; lose: Array<{ count: number; roleName: string }> }> => {
  const [vip, moderator, ledger] = await Promise.all([
    context.twitchRanks?.getTwitchRanks("vip"),
    context.twitchRanks?.getTwitchRanks("moderator"),
    Promise.resolve(readDiscordGrants(sql, (await getDiscordServerConnection(context.DB, context.channelId))?.guildId ?? "")),
  ]);
  const rankUsers = {
    vip: vip?.complete === true ? vip.userIds : new Set<string>(),
    moderator: moderator?.complete === true ? moderator.userIds : new Set<string>(),
  };
  const twitchIds = [...rankUsers.vip, ...rankUsers.moderator];
  const links = await readLinksForIdentities(context.DB, twitchIds, []);
  return previewDiscordRoleChanges({
    mappings,
    rankUsers,
    links: [...links.byTwitchId.values()],
    ledger,
    roleNames: readDiscordRoleNames(sql),
  });
};
