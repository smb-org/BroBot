import type {
  ModuleTempVipExtendRequest,
  ModuleTempVipGrantRequest,
  ModuleTempVipImportRequest,
  ModuleTempVipPerson,
  ModuleTempVipRemovedEvent,
  ModuleTempVipResult,
  ModuleTempVipRow,
  ModuleTempVipOperationRequest,
  TempVipEndReason,
  TempVipSource,
} from "../../modules/contract";

const TEMP_VIP_PENDING_LOCK_MS = 5 * 60_000;
const TEMP_VIP_ECHO_TOMBSTONE_MS = 15 * 60_000;
const TEMP_VIP_REMOVALS_PER_WINDOW = 10;
const TEMP_VIP_REMOVAL_WINDOW_MS = 10_000;
const TEMP_VIP_OPERATION_RETENTION_MS = 24 * 60 * 60_000;
const TEMP_VIP_OUTBOX_RETRY_MS = 60_000;

const REMOVAL_RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000] as const;
const GRANT_RECOVERY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

export type TempVipTwitchFailure = { ok: false; reason: string; ambiguous?: boolean };
export type TempVipTwitch = {
  get: (userId: string) => Promise<{ ok: true; isVip: boolean } | TempVipTwitchFailure>;
  add: (userId: string) => Promise<{ ok: true } | TempVipTwitchFailure>;
  remove: (userId: string) => Promise<{ ok: true } | TempVipTwitchFailure>;
};

export interface TempVipOutboxEvent {
  eventId: string;
  operationId: string;
  createdAt: string;
  actorUserId: string | null;
  code: string;
  detail: Readonly<Record<string, unknown>>;
}

export interface TempVipStoreOptions {
  channelId: string;
  now?: () => string;
  twitch: TempVipTwitch;
  scheduleAlarm: (deadline: number | null) => Promise<void>;
}

type TempVipStorage = Pick<DurableObjectStorage, "sql" | "transactionSync">;

interface TempVipRowSql extends Record<string, string | number | null> {
  user_id: string;
  user_login: string;
  user_display_name: string;
  expires_at: string;
  granted_at: string;
  granted_by_user_id: string | null;
  granted_by_login: string | null;
  pending_op: "grant" | "remove" | null;
  pending_since: string | null;
  eventsub_verification: number;
  status: "active" | "grant_pending" | "grant_unknown";
  grant_phase: "checking" | "adding";
  grant_operation_id: string;
  grant_event_index: number;
  grant_generation: number;
  grant_recovery_at: string | null;
  grant_recovery_attempts: number;
  recovery_claim: string | null;
  removal_failed_at: string | null;
  removal_retry_at: string | null;
  removal_attempts: number;
  removal_error: string | null;
  end_reason: "ended_early" | null;
  source: TempVipSource;
  revision: number;
}

interface CachedOperationRow extends Record<string, string | number | null> {
  payload_json: string;
  result_json: string | null;
  expires_at: string;
}

const utc = (milliseconds: number): string => new Date(milliseconds).toISOString();
const parseTime = (value: string): number => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("invalid_temp_vip_timestamp");
  return parsed;
};
const operationKey = (operationId: string): string => {
  if (operationId.length === 0 || operationId.length > 200) throw new Error("invalid_operation_id");
  return operationId;
};
const rowFor = (sql: SqlStorage, userId: string): TempVipRowSql | null =>
  sql.exec<TempVipRowSql>("SELECT * FROM temp_vips WHERE user_id = ?", userId).toArray()[0] ?? null;

const publicRow = (row: TempVipRowSql): ModuleTempVipRow => ({
  userId: row.user_id,
  login: row.user_login,
  displayName: row.user_display_name,
  expiresAt: row.expires_at,
  grantedAt: row.granted_at,
  grantedByUserId: row.granted_by_user_id,
  grantedByLogin: row.granted_by_login,
  source: row.source,
  status: row.status,
  grantGeneration: row.grant_generation,
  removalFailedAt: row.removal_failed_at,
  removalAttempts: row.removal_attempts,
  removalError: row.removal_error,
  endReason: row.end_reason,
  revision: row.revision,
});

const ensureTempVipsSchema = (sql: SqlStorage): void => {
  sql.exec(`CREATE TABLE IF NOT EXISTS temp_vips (
    user_id TEXT PRIMARY KEY,
    user_login TEXT NOT NULL,
    user_display_name TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    granted_at TEXT NOT NULL,
    granted_by_user_id TEXT,
    granted_by_login TEXT,
    pending_op TEXT CHECK (pending_op IN ('grant', 'remove')),
    pending_since TEXT,
    eventsub_verification INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('active', 'grant_pending', 'grant_unknown')),
    grant_phase TEXT NOT NULL DEFAULT 'checking' CHECK (grant_phase IN ('checking', 'adding')),
    grant_operation_id TEXT NOT NULL DEFAULT '',
    grant_event_index INTEGER NOT NULL DEFAULT 0,
    grant_generation INTEGER NOT NULL,
    grant_recovery_at TEXT,
    grant_recovery_attempts INTEGER NOT NULL DEFAULT 0,
    recovery_claim TEXT,
    removal_failed_at TEXT,
    removal_retry_at TEXT,
    removal_attempts INTEGER NOT NULL DEFAULT 0,
    removal_error TEXT,
    end_reason TEXT CHECK (end_reason IN ('ended_early')),
    source TEXT NOT NULL CHECK (source IN ('command', 'dashboard', 'import', 'channel_points')),
    revision INTEGER NOT NULL DEFAULT 1
  )`);
  sql.exec(`CREATE INDEX IF NOT EXISTS temp_vips_expiry ON temp_vips (expires_at, user_id)`);
  sql.exec(`CREATE TABLE IF NOT EXISTS temp_vip_generations (
    user_id TEXT PRIMARY KEY,
    generation INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS temp_vip_tombstones (
    user_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    remove_started_at TEXT NOT NULL,
    removed_at TEXT NOT NULL,
    retain_until TEXT NOT NULL,
    PRIMARY KEY (user_id, generation)
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS temp_vip_removal_slots (
    slot_id INTEGER PRIMARY KEY AUTOINCREMENT,
    reserved_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS temp_vip_operations (
    operation_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    result_json TEXT,
    expires_at TEXT NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS temp_vip_outbox (
    event_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    actor_user_id TEXT,
    code TEXT NOT NULL,
    detail_json TEXT NOT NULL
  )`);
  const tempVipColumns = sql.exec<{ name: string }>("PRAGMA table_info(temp_vips)").toArray();
  if (!tempVipColumns.some(({ name }) => name === "eventsub_verification")) {
    sql.exec("ALTER TABLE temp_vips ADD COLUMN eventsub_verification INTEGER NOT NULL DEFAULT 0");
  }
  if (!tempVipColumns.some(({ name }) => name === "recovery_claim")) {
    sql.exec("ALTER TABLE temp_vips ADD COLUMN recovery_claim TEXT");
  }
  if (!tempVipColumns.some(({ name }) => name === "removal_retry_at")) {
    sql.exec("ALTER TABLE temp_vips ADD COLUMN removal_retry_at TEXT");
  }
};

const nextGenerationSync = (sql: SqlStorage, userId: string): number => {
  sql.exec(
    `INSERT INTO temp_vip_generations (user_id, generation) VALUES (?, 1)
     ON CONFLICT(user_id) DO UPDATE SET generation = generation + 1`,
    userId,
  );
  return sql.exec<{ generation: number }>("SELECT generation FROM temp_vip_generations WHERE user_id = ?", userId).one().generation;
};

const enqueueEventSync = (
  sql: SqlStorage,
  channelId: string,
  operationId: string,
  eventIndex: number,
  createdAt: string,
  actorUserId: string | null,
  code: string,
  detail: Readonly<Record<string, unknown>>,
): void => {
  const eventId = `temp_vips:${encodeURIComponent(channelId)}:${encodeURIComponent(operationId)}:${String(eventIndex)}`;
  sql.exec(
    `INSERT OR IGNORE INTO temp_vip_outbox
      (event_id, operation_id, created_at, actor_user_id, code, detail_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    eventId,
    operationId,
    createdAt,
    actorUserId,
    code,
    JSON.stringify(detail),
  );
};

const cachedOperationSync = (
  sql: SqlStorage,
  operationId: string,
  payloadJson: string,
  now: string,
): ModuleTempVipResult | null => {
  sql.exec("DELETE FROM temp_vip_operations WHERE expires_at <= ?", now);
  const prior = sql.exec<CachedOperationRow>(
    "SELECT payload_json, result_json, expires_at FROM temp_vip_operations WHERE operation_id = ?",
    operationId,
  ).toArray()[0];
  if (prior === undefined) return null;
  if (prior.payload_json !== payloadJson) throw new Error("operation_conflict");
  return prior.result_json === null ? { status: "busy" } : JSON.parse(prior.result_json) as ModuleTempVipResult;
};

const saveOperationSync = (
  sql: SqlStorage,
  operationId: string,
  payloadJson: string,
  result: ModuleTempVipResult,
  now: string,
): void => {
  sql.exec(
    `INSERT INTO temp_vip_operations (operation_id, payload_json, result_json, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(operation_id) DO UPDATE SET
       result_json = excluded.result_json, expires_at = excluded.expires_at
     WHERE temp_vip_operations.payload_json = excluded.payload_json
       AND temp_vip_operations.result_json IS NULL`,
    operationId,
    payloadJson,
    JSON.stringify(result),
    utc(parseTime(now) + TEMP_VIP_OPERATION_RETENTION_MS),
  );
};

const reserveOperationSync = (
  sql: SqlStorage,
  operationId: string,
  payloadJson: string,
  now: string,
): void => {
  sql.exec(
    `INSERT INTO temp_vip_operations (operation_id, payload_json, result_json, expires_at)
     VALUES (?, ?, NULL, ?)
     ON CONFLICT(operation_id) DO NOTHING`,
    operationId,
    payloadJson,
    utc(parseTime(now) + TEMP_VIP_OPERATION_RETENTION_MS),
  );
};

const settleReservedOperationSync = (
  sql: SqlStorage,
  operationId: string,
  result: ModuleTempVipResult,
  now: string,
): void => {
  const prior = sql.exec<{ result_json: string | null }>(
    "SELECT result_json FROM temp_vip_operations WHERE operation_id = ?",
    operationId,
  ).toArray()[0];
  if (prior === undefined) return;
  if (prior.result_json !== null &&
      (JSON.parse(prior.result_json) as ModuleTempVipResult).status !== "grant_unknown") return;
  sql.exec(
    `UPDATE temp_vip_operations SET result_json = ?, expires_at = ?
     WHERE operation_id = ? AND result_json IS ?`,
    JSON.stringify(result),
    utc(parseTime(now) + TEMP_VIP_OPERATION_RETENTION_MS),
    operationId,
    prior.result_json,
  );
};

const lockBusyOrClearSync = (sql: SqlStorage, row: TempVipRowSql, now: string): boolean => {
  if (row.pending_op === null || row.pending_since === null) return false;
  if (row.status === "grant_unknown") return true;
  if (parseTime(now) - parseTime(row.pending_since) < TEMP_VIP_PENDING_LOCK_MS) return true;
  sql.exec(
    `UPDATE temp_vips SET pending_op = NULL, pending_since = NULL,
       eventsub_verification = 0, recovery_claim = NULL,
       status = CASE WHEN status = 'grant_pending' THEN 'grant_unknown' ELSE status END,
       grant_recovery_at = CASE WHEN status = 'grant_pending' THEN ? ELSE grant_recovery_at END,
       revision = revision + 1
     WHERE user_id = ?`,
    utc(parseTime(now) + GRANT_RECOVERY_DELAYS_MS[0]),
    row.user_id,
  );
  return false;
};

const backoffDelay = (attempts: number): number => REMOVAL_RETRY_DELAYS_MS[Math.min(Math.max(0, attempts - 1), REMOVAL_RETRY_DELAYS_MS.length - 1)] ?? 60 * 60_000;
const grantRecoveryDelay = (attempts: number): number => GRANT_RECOVERY_DELAYS_MS[Math.min(Math.max(0, attempts), GRANT_RECOVERY_DELAYS_MS.length - 1)] ?? 60 * 60_000;

const insertGrantPendingSync = (
  sql: SqlStorage,
  operationId: string,
  eventIndex: number,
  person: ModuleTempVipPerson,
  grantedBy: { userId: string; login: string } | null,
  source: TempVipSource,
  now: string,
  expiresAt: string,
): number => {
  const generation = nextGenerationSync(sql, person.userId);
  sql.exec(
    `INSERT INTO temp_vips
      (user_id, user_login, user_display_name, expires_at, granted_at, granted_by_user_id, granted_by_login,
       pending_op, pending_since, status, grant_phase, grant_operation_id, grant_event_index,
       grant_generation, source, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'grant', ?, 'grant_pending', 'checking', ?, ?, ?, ?, 1)`,
    person.userId,
    person.login,
    person.displayName,
    expiresAt,
    now,
    grantedBy?.userId ?? null,
    grantedBy?.login ?? null,
    now,
    operationId,
    eventIndex,
    generation,
    source,
  );
  return generation;
};

const reserveRemovalSlotSync = (sql: SqlStorage, now: string): number | null => {
  const nowMs = parseTime(now);
  sql.exec("DELETE FROM temp_vip_removal_slots WHERE reserved_at <= ?", nowMs - TEMP_VIP_REMOVAL_WINDOW_MS);
  const reserved = sql.exec<{ count: number; earliest: number | null }>(
    "SELECT COUNT(*) AS count, MIN(reserved_at) AS earliest FROM temp_vip_removal_slots",
  ).one();
  if (reserved.count >= TEMP_VIP_REMOVALS_PER_WINDOW) {
    return (reserved.earliest ?? nowMs) + TEMP_VIP_REMOVAL_WINDOW_MS;
  }
  sql.exec("INSERT INTO temp_vip_removal_slots (reserved_at) VALUES (?)", nowMs);
  return null;
};

const tombstoneMatchSync = (
  sql: SqlStorage,
  userId: string,
  eventAt: number,
  now: string,
  currentGeneration: number | null,
): boolean => {
  sql.exec("DELETE FROM temp_vip_tombstones WHERE retain_until <= ?", now);
  const tombstones = sql.exec<{
    generation: number;
    remove_started_at: string;
    removed_at: string;
  }>(
    `SELECT generation, remove_started_at, removed_at FROM temp_vip_tombstones
      WHERE user_id = ? AND retain_until > ?`,
    userId,
    now,
  ).toArray();
  return tombstones.some((tombstone) => {
    if (currentGeneration !== null && currentGeneration <= tombstone.generation) return false;
    const startedAt = parseTime(tombstone.remove_started_at);
    const removedAt = parseTime(tombstone.removed_at);
    return eventAt >= startedAt - 5 * 60_000 && eventAt <= Math.min(removedAt, startedAt + 30_000);
  });
};

export class TempVipStore {
  private readonly sql: SqlStorage;
  private readonly storage: TempVipStorage;
  private readonly now: () => string;
  private readonly options: TempVipStoreOptions;

  public constructor(storage: TempVipStorage, options: TempVipStoreOptions) {
    this.storage = storage;
    this.sql = storage.sql;
    this.now = options.now ?? (() => new Date().toISOString());
    this.options = options;
    ensureTempVipsSchema(this.sql);
  }

  private transaction<T>(run: () => T): T {
    return this.storage.transactionSync(run);
  }

  public async grant(request: ModuleTempVipGrantRequest): Promise<ModuleTempVipResult> {
    operationKey(request.operationId);
    this.validateDuration(request.durationMs, request.maximumRemainingMs);
    const now = this.now();
    const payloadJson = JSON.stringify({
      action: "grant", person: request.person, grantedBy: request.grantedBy,
      durationMs: request.durationMs, maximumRemainingMs: request.maximumRemainingMs, source: request.source,
    });
    let replacingFailedRow = false;
    const initial = this.transaction(() => {
      const cached = cachedOperationSync(this.sql, request.operationId, payloadJson, now);
      if (cached !== null) return { kind: "done" as const, result: cached };
      let row = rowFor(this.sql, request.person.userId);
      const orphanedRemove = row?.pending_op === "remove" && row.pending_since !== null &&
        parseTime(now) - parseTime(row.pending_since) >= TEMP_VIP_PENDING_LOCK_MS;
      if (row !== null && lockBusyOrClearSync(this.sql, row, now)) return { kind: "done" as const, result: { status: "busy" } };
      row = rowFor(this.sql, request.person.userId);
      if (row?.status === "grant_unknown" || row?.status === "grant_pending") {
        return { kind: "done" as const, result: { status: "busy" } };
      }
      if (row !== null && row.removal_failed_at === null && !orphanedRemove) {
        const result = this.extendRowSync(row, request.durationMs, request.maximumRemainingMs, now, request.operationId, payloadJson, {
          person: request.person,
          actorUserId: request.grantedBy?.userId ?? null,
        });
        return { kind: "done" as const, result };
      }
      if (row !== null) {
        this.sql.exec("UPDATE temp_vips SET pending_op = 'grant', pending_since = ?, revision = revision + 1 WHERE user_id = ?", now, row.user_id);
        return { kind: "check_existing" as const };
      }
      if (request.durationMs > request.maximumRemainingMs) {
        const result = { status: "maximum_exceeded", allowedDurationMs: request.maximumRemainingMs };
        saveOperationSync(this.sql, request.operationId, payloadJson, result, now);
        return { kind: "done" as const, result };
      }
      insertGrantPendingSync(
        this.sql, request.operationId, 0, request.person, request.grantedBy, request.source, now,
        utc(parseTime(now) + request.durationMs),
      );
      reserveOperationSync(this.sql, request.operationId, payloadJson, now);
      return { kind: "create" as const };
    });
    if (initial.kind === "done") {
      await this.rearm(now);
      return initial.result;
    }

    if (initial.kind === "check_existing") {
      await this.rearm(this.now());
      const lookup = await this.safeGet(request.person.userId);
      if (!lookup.ok) {
        const result = this.transaction(() => {
          this.sql.exec("UPDATE temp_vips SET pending_op = NULL, pending_since = NULL, revision = revision + 1 WHERE user_id = ?", request.person.userId);
          const unavailable = { status: "twitch_unavailable", reason: lookup.reason };
          saveOperationSync(this.sql, request.operationId, payloadJson, unavailable, this.now());
          return unavailable;
        });
        await this.rearm(this.now());
        return result;
      }
      if (lookup.isVip) {
        const result = this.transaction(() => {
          const row = rowFor(this.sql, request.person.userId);
          if (row === null) {
            const missing = { status: "not_managed" };
            saveOperationSync(this.sql, request.operationId, payloadJson, missing, this.now());
            return missing;
          }
          const extended = this.extendRowSync(row, request.durationMs, request.maximumRemainingMs, this.now(), request.operationId, payloadJson, {
            person: request.person,
            actorUserId: request.grantedBy?.userId ?? null,
          }, true);
          return extended;
        });
        await this.rearm(this.now());
        return result;
      }
      if (request.durationMs > request.maximumRemainingMs) {
        const result = this.transaction(() => {
          this.sql.exec("UPDATE temp_vips SET pending_op = NULL, pending_since = NULL, revision = revision + 1 WHERE user_id = ?", request.person.userId);
          const rejected = { status: "maximum_exceeded", allowedDurationMs: request.maximumRemainingMs };
          saveOperationSync(this.sql, request.operationId, payloadJson, rejected, this.now());
          return rejected;
        });
        await this.rearm(this.now());
        return result;
      }
      this.transaction(() => {
        const old = rowFor(this.sql, request.person.userId);
        if (old !== null) {
          replacingFailedRow = true;
          const reason: TempVipEndReason = old.end_reason ?? "expired";
          this.sql.exec("DELETE FROM temp_vips WHERE user_id = ?", old.user_id);
          enqueueEventSync(this.sql, this.options.channelId, request.operationId, 0, this.now(), old.granted_by_user_id,
            "temp_vips.ended", { userId: old.user_id, login: old.user_login, reason });
        }
        insertGrantPendingSync(
          this.sql, request.operationId, replacingFailedRow ? 1 : 0, request.person, request.grantedBy, request.source, this.now(),
          utc(parseTime(this.now()) + request.durationMs),
        );
        reserveOperationSync(this.sql, request.operationId, payloadJson, this.now());
      });
    }

    await this.rearm(this.now());
    const lookup = await this.safeGet(request.person.userId);
    if (!lookup.ok) {
      const result = this.transaction(() => {
        this.sql.exec("DELETE FROM temp_vips WHERE user_id = ? AND status = 'grant_pending'", request.person.userId);
        const unavailable = { status: "twitch_unavailable", reason: lookup.reason };
        saveOperationSync(this.sql, request.operationId, payloadJson, unavailable, this.now());
        return unavailable;
      });
      await this.rearm(this.now());
      return result;
    }
    if (lookup.isVip) {
      const result = this.transaction(() => {
        this.sql.exec("DELETE FROM temp_vips WHERE user_id = ? AND status = 'grant_pending'", request.person.userId);
        const alreadyVip = { status: "already_vip" };
        saveOperationSync(this.sql, request.operationId, payloadJson, alreadyVip, this.now());
        return alreadyVip;
      });
      await this.rearm(this.now());
      return result;
    }

    this.transaction(() => {
      this.sql.exec("UPDATE temp_vips SET grant_phase = 'adding', revision = revision + 1 WHERE user_id = ? AND status = 'grant_pending'", request.person.userId);
    });
    const add = await this.safeAdd(request.person.userId);
    const completedAt = this.now();
    const result = this.transaction(() => {
      if (add.ok) {
        this.sql.exec(
          `UPDATE temp_vips SET status = 'active', pending_op = NULL, pending_since = NULL,
             grant_recovery_at = NULL, grant_recovery_attempts = 0,
             user_login = ?, user_display_name = ?, revision = revision + 1
           WHERE user_id = ? AND status = 'grant_pending'`,
          request.person.login,
          request.person.displayName,
          request.person.userId,
        );
        const row = rowFor(this.sql, request.person.userId);
        const granted: ModuleTempVipResult = { status: "granted", ...(row === null ? {} : { row: publicRow(row) }) };
        enqueueEventSync(this.sql, this.options.channelId, request.operationId, replacingFailedRow ? 1 : 0, completedAt, request.grantedBy?.userId ?? null,
          "temp_vips.granted", { userId: request.person.userId, login: request.person.login, expiresAt: row?.expires_at ?? null, source: request.source });
        saveOperationSync(this.sql, request.operationId, payloadJson, granted, completedAt);
        return granted;
      }
      if (add.ambiguous === true) {
        this.sql.exec(
          `UPDATE temp_vips SET status = 'grant_unknown', pending_op = 'grant', pending_since = ?,
             grant_recovery_at = ?, grant_recovery_attempts = 0, revision = revision + 1
           WHERE user_id = ? AND status = 'grant_pending'`,
          completedAt,
          utc(parseTime(completedAt) + GRANT_RECOVERY_DELAYS_MS[0]),
          request.person.userId,
        );
        const unknown: ModuleTempVipResult = { status: "grant_unknown", reason: add.reason };
        saveOperationSync(this.sql, request.operationId, payloadJson, unknown, completedAt);
        return unknown;
      }
      this.sql.exec("DELETE FROM temp_vips WHERE user_id = ? AND status = 'grant_pending'", request.person.userId);
      const failure: ModuleTempVipResult = { status: "rejected", reason: add.reason };
      saveOperationSync(this.sql, request.operationId, payloadJson, failure, completedAt);
      return failure;
    });
    await this.rearm(completedAt);
    return result;
  }

  public async extend(request: ModuleTempVipExtendRequest): Promise<ModuleTempVipResult> {
    operationKey(request.operationId);
    this.validateDuration(request.durationMs, request.maximumRemainingMs);
    const now = this.now();
    const payloadJson = JSON.stringify({
      action: "extend", person: request.person, grantedBy: request.grantedBy ?? null,
      durationMs: request.durationMs, maximumRemainingMs: request.maximumRemainingMs,
      source: request.source ?? "dashboard",
    });
    const initial = this.transaction(() => {
      const cached = cachedOperationSync(this.sql, request.operationId, payloadJson, now);
      if (cached !== null) return cached;
      let row = rowFor(this.sql, request.person.userId);
      if (row === null) return { status: "not_managed" };
      const orphanedRemove = row.pending_op === "remove" && row.pending_since !== null &&
        parseTime(now) - parseTime(row.pending_since) >= TEMP_VIP_PENDING_LOCK_MS;
      if (lockBusyOrClearSync(this.sql, row, now)) return { status: "busy" };
      row = rowFor(this.sql, request.person.userId);
      if (row === null) return { status: "not_managed" };
      if (row.status !== "active") return { status: "busy" };
      if (row.removal_failed_at === null && !orphanedRemove) {
        return this.extendRowSync(row, request.durationMs, request.maximumRemainingMs, now, request.operationId, payloadJson, { person: request.person, actorUserId: null });
      }
      this.sql.exec("UPDATE temp_vips SET pending_op = 'grant', pending_since = ?, revision = revision + 1 WHERE user_id = ?", now, row.user_id);
      return null;
    });
    if (initial !== null) {
      if (initial.status !== "busy") this.transaction(() => { saveOperationSync(this.sql, request.operationId, payloadJson, initial, now); });
      await this.rearm(now);
      return initial;
    }
    await this.rearm(this.now());
    const lookup = await this.safeGet(request.person.userId);
    const completedAt = this.now();
    const result = this.transaction(() => {
      const row = rowFor(this.sql, request.person.userId);
      if (row === null) return { status: "not_managed" };
      if (!lookup.ok) {
        this.sql.exec("UPDATE temp_vips SET pending_op = NULL, pending_since = NULL, revision = revision + 1 WHERE user_id = ?", row.user_id);
        const unavailable = { status: "twitch_unavailable", reason: lookup.reason };
        saveOperationSync(this.sql, request.operationId, payloadJson, unavailable, completedAt);
        return unavailable;
      }
      if (lookup.isVip) {
        const extended = this.extendRowSync(row, request.durationMs, request.maximumRemainingMs, completedAt, request.operationId, payloadJson, { person: request.person, actorUserId: request.grantedBy?.userId ?? null }, true);
        return extended;
      }
      if (request.durationMs > request.maximumRemainingMs) {
        this.sql.exec("UPDATE temp_vips SET pending_op = NULL, pending_since = NULL, revision = revision + 1 WHERE user_id = ?", row.user_id);
        const maximumExceeded = { status: "maximum_exceeded", allowedDurationMs: request.maximumRemainingMs };
        saveOperationSync(this.sql, request.operationId, payloadJson, maximumExceeded, completedAt);
        return maximumExceeded;
      }
      const reason: TempVipEndReason = row.end_reason ?? "expired";
      this.sql.exec("DELETE FROM temp_vips WHERE user_id = ?", row.user_id);
      enqueueEventSync(this.sql, this.options.channelId, request.operationId, 0, completedAt, null,
        "temp_vips.ended", { userId: row.user_id, login: row.user_login, reason });
      insertGrantPendingSync(
        this.sql,
        request.operationId,
        1,
        request.person,
        request.grantedBy ?? (row.granted_by_user_id === null || row.granted_by_login === null
          ? null
          : { userId: row.granted_by_user_id, login: row.granted_by_login }),
        request.source ?? "dashboard",
        completedAt,
        utc(parseTime(completedAt) + request.durationMs),
      );
      reserveOperationSync(this.sql, request.operationId, payloadJson, completedAt);
      return { status: "regrant_pending" };
    });
    if (result.status === "regrant_pending") {
      this.transaction(() => {
        this.sql.exec("UPDATE temp_vips SET grant_phase = 'adding', revision = revision + 1 WHERE user_id = ? AND status = 'grant_pending'", request.person.userId);
      });
      await this.rearm(this.now());
      const add = await this.safeAdd(request.person.userId);
      const settledAt = this.now();
      const settled = this.transaction(() => {
        if (add.ok) {
          this.sql.exec(
            `UPDATE temp_vips SET status = 'active', pending_op = NULL, pending_since = NULL,
               user_login = ?, user_display_name = ?, revision = revision + 1 WHERE user_id = ? AND status = 'grant_pending'`,
            request.person.login,
            request.person.displayName,
            request.person.userId,
          );
          const row = rowFor(this.sql, request.person.userId);
          const granted: ModuleTempVipResult = { status: "granted", ...(row === null ? {} : { row: publicRow(row) }) };
          enqueueEventSync(this.sql, this.options.channelId, request.operationId, 1, settledAt, request.grantedBy?.userId ?? null,
            "temp_vips.granted", { userId: request.person.userId, login: request.person.login, expiresAt: row?.expires_at ?? null, source: request.source ?? "dashboard" });
          saveOperationSync(this.sql, request.operationId, payloadJson, granted, settledAt);
          return granted;
        }
        if (add.ambiguous === true) {
          this.sql.exec(
            `UPDATE temp_vips SET status = 'grant_unknown', pending_op = 'grant', pending_since = ?,
               grant_recovery_at = ?, grant_recovery_attempts = 0, revision = revision + 1 WHERE user_id = ?`,
            settledAt,
            utc(parseTime(settledAt) + GRANT_RECOVERY_DELAYS_MS[0]),
            request.person.userId,
          );
          const unknown = { status: "grant_unknown", reason: add.reason };
          saveOperationSync(this.sql, request.operationId, payloadJson, unknown, settledAt);
          return unknown;
        }
        this.sql.exec("DELETE FROM temp_vips WHERE user_id = ? AND status = 'grant_pending'", request.person.userId);
        const rejected = { status: "rejected", reason: add.reason };
        saveOperationSync(this.sql, request.operationId, payloadJson, rejected, settledAt);
        return rejected;
      });
      await this.rearm(settledAt);
      return settled;
    }
    await this.rearm(completedAt);
    return result;
  }

  public async importExisting(request: ModuleTempVipImportRequest): Promise<ModuleTempVipResult> {
    operationKey(request.operationId);
    this.validateDuration(request.durationMs, request.maximumRemainingMs);
    const now = this.now();
    const payloadJson = JSON.stringify({
      action: "import", person: request.person, grantedBy: request.grantedBy,
      durationMs: request.durationMs, maximumRemainingMs: request.maximumRemainingMs,
    });
    const initial = this.transaction(() => {
      const cached = cachedOperationSync(this.sql, request.operationId, payloadJson, now);
      if (cached !== null) return { done: cached };
      const row = rowFor(this.sql, request.person.userId);
      if (row !== null) {
        if (lockBusyOrClearSync(this.sql, row, now)) return { done: { status: "busy" } };
        return { done: { status: "already_managed" } };
      }
      if (request.durationMs > request.maximumRemainingMs) {
        const result = { status: "maximum_exceeded", allowedDurationMs: request.maximumRemainingMs };
        saveOperationSync(this.sql, request.operationId, payloadJson, result, now);
        return { done: result };
      }
      insertGrantPendingSync(this.sql, request.operationId, 0, request.person, request.grantedBy, "import", now, utc(parseTime(now) + request.durationMs));
      reserveOperationSync(this.sql, request.operationId, payloadJson, now);
      return { done: null };
    });
    if (initial.done !== null) {
      if (initial.done.status !== "busy") this.transaction(() => { saveOperationSync(this.sql, request.operationId, payloadJson, initial.done, now); });
      await this.rearm(now);
      return initial.done;
    }
    await this.rearm(this.now());
    const lookup = await this.safeGet(request.person.userId);
    const completedAt = this.now();
    const result = this.transaction(() => {
      if (!lookup.ok) {
        this.sql.exec("DELETE FROM temp_vips WHERE user_id = ? AND status = 'grant_pending'", request.person.userId);
        const unavailable = { status: "twitch_unavailable", reason: lookup.reason };
        saveOperationSync(this.sql, request.operationId, payloadJson, unavailable, completedAt);
        return unavailable;
      }
      if (!lookup.isVip) {
        this.sql.exec("DELETE FROM temp_vips WHERE user_id = ? AND status = 'grant_pending'", request.person.userId);
        const noLongerVip = { status: "not_vip" };
        saveOperationSync(this.sql, request.operationId, payloadJson, noLongerVip, completedAt);
        return noLongerVip;
      }
      this.sql.exec(
        `UPDATE temp_vips SET status = 'active', pending_op = NULL, pending_since = NULL,
           user_login = ?, user_display_name = ?, revision = revision + 1
         WHERE user_id = ? AND status = 'grant_pending'`,
        request.person.login,
        request.person.displayName,
        request.person.userId,
      );
      const row = rowFor(this.sql, request.person.userId);
      const imported: ModuleTempVipResult = { status: "imported", ...(row === null ? {} : { row: publicRow(row) }) };
      enqueueEventSync(this.sql, this.options.channelId, request.operationId, 0, completedAt, request.grantedBy?.userId ?? null,
        "temp_vips.imported", { userId: request.person.userId, login: request.person.login, expiresAt: row?.expires_at ?? null });
      saveOperationSync(this.sql, request.operationId, payloadJson, imported, completedAt);
      return imported;
    });
    await this.rearm(completedAt);
    return result;
  }

  public async end(request: ModuleTempVipOperationRequest): Promise<ModuleTempVipResult> {
    operationKey(request.operationId);
    const now = this.now();
    const payloadJson = JSON.stringify({ action: "end", userId: request.userId });
    const start = this.transaction(() => {
      const cached = cachedOperationSync(this.sql, request.operationId, payloadJson, now);
      if (cached !== null) return { result: cached, row: null as TempVipRowSql | null, retryAt: null as number | null };
      let row = rowFor(this.sql, request.userId);
      if (row === null) {
        const result = { status: "not_managed" };
        saveOperationSync(this.sql, request.operationId, payloadJson, result, now);
        return { result, row: null, retryAt: null };
      }
      if (lockBusyOrClearSync(this.sql, row, now)) return { result: { status: "busy" }, row: null, retryAt: null };
      row = rowFor(this.sql, request.userId);
      if (row === null || row.status !== "active") return { result: { status: "busy" }, row: null, retryAt: null };
      const reservedAt = this.now();
      const retryAt = reserveRemovalSlotSync(this.sql, reservedAt);
      if (retryAt !== null) {
        this.sql.exec(
          `UPDATE temp_vips SET end_reason = 'ended_early', expires_at = ?, removal_retry_at = ?, pending_op = NULL,
             pending_since = NULL, revision = revision + 1 WHERE user_id = ?`,
          reservedAt,
          utc(retryAt),
          row.user_id,
        );
        const result = { status: "queued", retryAt: utc(retryAt) };
        saveOperationSync(this.sql, request.operationId, payloadJson, result, reservedAt);
        return { result, row: null, retryAt };
      }
      this.sql.exec(
        `UPDATE temp_vips SET end_reason = 'ended_early', pending_op = 'remove', pending_since = ?,
           eventsub_verification = 0, removal_retry_at = NULL,
           revision = revision + 1 WHERE user_id = ?`,
        reservedAt,
        row.user_id,
      );
      return { result: null, row: { ...row, end_reason: "ended_early", pending_op: "remove", pending_since: reservedAt }, retryAt: null };
    });
    if (start.result !== null) {
      await this.rearm(this.now());
      return start.result;
    }
    const removed = await this.safeRemove(request.userId);
    const completedAt = this.now();
    const started = start.row;
    const result = this.transaction(() => this.finishRemovalSync(
      request.userId,
      started.grant_generation,
      started.pending_since,
      request.operationId,
      removed,
      completedAt,
      null,
      payloadJson,
    ));
    await this.rearm(completedAt);
    return result;
  }

  public async release(request: ModuleTempVipOperationRequest): Promise<ModuleTempVipResult> {
    operationKey(request.operationId);
    const now = this.now();
    const payloadJson = JSON.stringify({ action: "release", userId: request.userId });
    const result = this.transaction(() => {
      const cached = cachedOperationSync(this.sql, request.operationId, payloadJson, now);
      if (cached !== null) return cached;
      let row = rowFor(this.sql, request.userId);
      if (row === null) {
        const missing = { status: "not_managed" };
        saveOperationSync(this.sql, request.operationId, payloadJson, missing, now);
        return missing;
      }
      if (lockBusyOrClearSync(this.sql, row, now)) return { status: "busy" };
      row = rowFor(this.sql, request.userId);
      if (row === null) return { status: "not_managed" };
      this.sql.exec("DELETE FROM temp_vips WHERE user_id = ?", request.userId);
      const released = { status: "released" };
      enqueueEventSync(this.sql, this.options.channelId, request.operationId, 0, now, null, "temp_vips.released", { userId: request.userId, login: row.user_login });
      saveOperationSync(this.sql, request.operationId, payloadJson, released, now);
      return released;
    });
    await this.rearm(now);
    return result;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- RPC surface stays async
  public async list(): Promise<ModuleTempVipRow[]> {
    return this.sql.exec<TempVipRowSql>("SELECT * FROM temp_vips ORDER BY expires_at, user_id").toArray().map(publicRow);
  }

  public async handleRemoved(event: ModuleTempVipRemovedEvent): Promise<ModuleTempVipResult> {
    const eventAt = parseTime(event.eventSubTimestamp);
    const now = this.now();
    const initial = this.transaction(() => {
      this.sql.exec("DELETE FROM temp_vip_operations WHERE expires_at <= ?", now);
      const row = rowFor(this.sql, event.userId);
      const stale = tombstoneMatchSync(this.sql, event.userId, eventAt, now, row?.grant_generation ?? null);
      if (stale || (row !== null && eventAt < parseTime(row.granted_at))) return { result: { status: "ignored_stale_echo" } };
      if (row === null) return { result: { status: "ignored_unmanaged" } };
      if (row.pending_op === "remove" && row.pending_since !== null && parseTime(now) - parseTime(row.pending_since) < TEMP_VIP_PENDING_LOCK_MS) {
        return { result: { status: row.eventsub_verification === 1 ? "busy" : "ignored_own_echo" } };
      }
      if (lockBusyOrClearSync(this.sql, row, now)) return { result: { status: "busy" } };
      this.sql.exec("UPDATE temp_vips SET pending_op = 'remove', pending_since = ?, eventsub_verification = 1, revision = revision + 1 WHERE user_id = ?", now, row.user_id);
      return { result: null, generation: row.grant_generation, claimedAt: now };
    });
    if (initial.result !== null) {
      await this.rearm(now);
      return initial.result;
    }
    const lookup = await this.safeGet(event.userId);
    const completedAt = this.now();
    if (!lookup.ok) {
      this.transaction(() => this.sql.exec(
        `UPDATE temp_vips SET pending_op = NULL, pending_since = NULL, eventsub_verification = 0, revision = revision + 1
         WHERE user_id = ? AND grant_generation = ? AND pending_since = ? AND eventsub_verification = 1`,
        event.userId,
        initial.generation,
        initial.claimedAt,
      ));
      await this.rearm(completedAt);
      throw new Error(`temp_vip_event_check_failed:${lookup.reason}`);
    }
    const result = this.transaction(() => {
      const row = rowFor(this.sql, event.userId);
      if (row === null || row.grant_generation !== initial.generation || row.pending_op !== "remove" ||
          row.pending_since !== initial.claimedAt || row.eventsub_verification !== 1) return { status: "busy" };
      if (lookup.isVip) {
        this.sql.exec("UPDATE temp_vips SET pending_op = NULL, pending_since = NULL, eventsub_verification = 0, revision = revision + 1 WHERE user_id = ?", event.userId);
        return { status: "ignored_stale_event" };
      }
      const reason: TempVipEndReason = "removed_on_twitch";
      this.sql.exec("DELETE FROM temp_vips WHERE user_id = ?", event.userId);
      enqueueEventSync(this.sql, this.options.channelId, event.triggerId, 0, completedAt, null, "temp_vips.ended", { userId: event.userId, login: row.user_login, reason });
      return { status: "removed_on_twitch" };
    });
    await this.rearm(completedAt);
    return result;
  }

  public async runExpiry(now = this.now()): Promise<{ removed: number; recoveredGrants: number }> {
    parseTime(now);
    const currentTime = (): string => utc(Math.max(parseTime(now), parseTime(this.now())));
    const startedAt = currentTime();
    this.transaction(() => {
      this.sql.exec("DELETE FROM temp_vip_operations WHERE expires_at <= ?", startedAt);
      this.sql.exec("DELETE FROM temp_vip_tombstones WHERE retain_until <= ?", startedAt);
    });
    let recoveredGrants = 0;
    const recoverable = this.sql.exec<TempVipRowSql>(
      `SELECT * FROM temp_vips WHERE status = 'grant_unknown'
        OR (status = 'grant_pending' AND pending_since <= ?)
      ORDER BY COALESCE(grant_recovery_at, pending_since), user_id`,
      utc(parseTime(startedAt) - TEMP_VIP_PENDING_LOCK_MS),
    ).toArray().filter((row) => row.status === "grant_pending" || row.grant_recovery_at === null || row.grant_recovery_at <= startedAt);
    for (const snapshot of recoverable) {
      const claimId = crypto.randomUUID();
      const claimedAt = currentTime();
      const claimed = this.transaction(() => {
        const row = rowFor(this.sql, snapshot.user_id);
        if (row === null || row.grant_generation !== snapshot.grant_generation) return null;
        if (row.status === "grant_pending" &&
            (row.pending_since === null || parseTime(claimedAt) - parseTime(row.pending_since) < TEMP_VIP_PENDING_LOCK_MS)) return null;
        if (row.status === "grant_pending") {
          this.sql.exec("UPDATE temp_vips SET status = 'grant_unknown', grant_recovery_at = ?, revision = revision + 1 WHERE user_id = ?",
            claimedAt, row.user_id);
        }
        const current = rowFor(this.sql, snapshot.user_id);
        if (current === null || current.status !== "grant_unknown") return null;
        if (current.grant_recovery_at !== null && current.grant_recovery_at > claimedAt) return null;
        if (current.recovery_claim !== null && current.pending_since !== null &&
            parseTime(claimedAt) - parseTime(current.pending_since) < TEMP_VIP_PENDING_LOCK_MS) return null;
        this.sql.exec(
          `UPDATE temp_vips SET pending_op = 'grant', pending_since = ?, recovery_claim = ?, revision = revision + 1
           WHERE user_id = ? AND grant_generation = ? AND status = 'grant_unknown'`,
          claimedAt,
          claimId,
          current.user_id,
          current.grant_generation,
        );
        return { generation: current.grant_generation, claimId, claimedAt };
      });
      if (claimed === null) continue;
      await this.rearm(claimed.claimedAt);
      const lookup = await this.safeGet(snapshot.user_id);
      const completedAt = currentTime();
      const applied = this.transaction(() => {
        const row = rowFor(this.sql, snapshot.user_id);
        if (row === null || row.status !== "grant_unknown" || row.grant_generation !== claimed.generation ||
            row.recovery_claim !== claimed.claimId || row.pending_since !== claimed.claimedAt) return false;
        if (!lookup.ok) {
          const attempts = row.grant_recovery_attempts + 1;
          this.sql.exec(
            `UPDATE temp_vips SET pending_op = 'grant', pending_since = ?, grant_recovery_attempts = ?,
               grant_recovery_at = ?, recovery_claim = NULL, revision = revision + 1
             WHERE user_id = ? AND grant_generation = ? AND recovery_claim = ?`,
            completedAt,
            attempts,
            utc(parseTime(completedAt) + grantRecoveryDelay(attempts)),
            row.user_id,
            claimed.generation,
            claimed.claimId,
          );
          return true;
        }
        if (lookup.isVip && (row.source === "import" || row.grant_phase === "adding")) {
          this.sql.exec(
            `UPDATE temp_vips SET status = 'active', pending_op = NULL, pending_since = NULL,
               grant_recovery_at = NULL, grant_recovery_attempts = 0, recovery_claim = NULL,
               revision = revision + 1 WHERE user_id = ? AND grant_generation = ? AND recovery_claim = ?`,
            row.user_id,
            claimed.generation,
            claimed.claimId,
          );
          const recovered = rowFor(this.sql, row.user_id);
          enqueueEventSync(
            this.sql,
            this.options.channelId,
            row.grant_operation_id,
            row.grant_event_index,
            completedAt,
            row.granted_by_user_id,
            row.source === "import" ? "temp_vips.imported" : "temp_vips.granted",
            { userId: row.user_id, login: row.user_login, expiresAt: row.expires_at, source: row.source },
          );
          settleReservedOperationSync(this.sql, row.grant_operation_id, {
            status: row.source === "import" ? "imported" : "granted",
            ...(recovered === null ? {} : { row: publicRow(recovered) }),
          }, completedAt);
          return true;
        }
        this.sql.exec(
          "DELETE FROM temp_vips WHERE user_id = ? AND grant_generation = ? AND recovery_claim = ?",
          row.user_id,
          claimed.generation,
          claimed.claimId,
        );
        let result: ModuleTempVipResult;
        if (row.source === "import") result = { status: "not_vip" };
        else if (row.grant_phase === "checking" && lookup.isVip) result = { status: "already_vip" };
        else if (row.grant_phase === "checking") result = { status: "twitch_unavailable", reason: "network" };
        else result = { status: "rejected", reason: "network" };
        settleReservedOperationSync(this.sql, row.grant_operation_id, result, completedAt);
        return true;
      });
      if (lookup.ok && applied) recoveredGrants += 1;
    }

    let removed = 0;
    for (;;) {
      if (removed >= TEMP_VIP_REMOVALS_PER_WINDOW) break;
      const scanAt = currentTime();
      const due = this.sql.exec<TempVipRowSql>(
        `SELECT * FROM temp_vips WHERE status = 'active'
          ORDER BY CASE WHEN removal_retry_at IS NOT NULL THEN removal_retry_at
                        WHEN removal_failed_at IS NOT NULL THEN removal_failed_at ELSE expires_at END, user_id`,
      ).toArray().find((row) => this.isDue(row, scanAt));
      if (due === undefined) break;
      const claimedAt = currentTime();
      const claim = this.transaction(() => {
        const row = rowFor(this.sql, due.user_id);
        if (row === null || row.status !== "active") return { row: null, retryAt: null };
        const orphanedRemoval = row.pending_op === "remove" && row.pending_since !== null &&
          parseTime(claimedAt) - parseTime(row.pending_since) >= TEMP_VIP_PENDING_LOCK_MS;
        if (lockBusyOrClearSync(this.sql, row, claimedAt)) return { row: null, retryAt: null };
        const current = rowFor(this.sql, due.user_id);
        if (current === null || (!orphanedRemoval && !this.isDue(current, claimedAt))) return { row: null, retryAt: null };
        const retryAt = reserveRemovalSlotSync(this.sql, claimedAt);
        if (retryAt !== null) return { row: null, retryAt };
        this.sql.exec(
          `UPDATE temp_vips SET pending_op = 'remove', pending_since = ?, eventsub_verification = 0,
             removal_retry_at = NULL, revision = revision + 1 WHERE user_id = ?`,
          claimedAt,
          row.user_id,
        );
        return { row: { ...current, pending_op: "remove", pending_since: claimedAt }, retryAt: null };
      });
      if (claim.retryAt !== null) break;
      const claimed = claim.row;
      if (claimed === null) break;
      const removal = await this.safeRemove(claimed.user_id);
      const completedAt = currentTime();
      const operationId = `expiry:${claimed.user_id}:${String(claimed.grant_generation)}:${claimed.pending_since}`;
      this.transaction(() => this.finishRemovalSync(
        claimed.user_id,
        claimed.grant_generation,
        claimed.pending_since,
        operationId,
        removal,
        completedAt,
        null,
        JSON.stringify({ action: "expiry", userId: due.user_id, generation: due.grant_generation }),
      ));
      removed += 1;
    }
    await this.rearm(currentTime());
    return { removed, recoveredGrants };
  }

  public pendingOutbox(): TempVipOutboxEvent[] {
    return this.sql.exec<{
      event_id: string;
      operation_id: string;
      created_at: string;
      actor_user_id: string | null;
      code: string;
      detail_json: string;
    }>("SELECT * FROM temp_vip_outbox ORDER BY created_at, event_id LIMIT 100").toArray().map((row) => ({
      eventId: row.event_id,
      operationId: row.operation_id,
      createdAt: row.created_at,
      actorUserId: row.actor_user_id,
      code: row.code,
      detail: JSON.parse(row.detail_json) as Readonly<Record<string, unknown>>,
    }));
  }

  public async acknowledgeOutbox(eventIds: readonly string[]): Promise<void> {
    if (eventIds.length === 0) return;
    this.transaction(() => {
      for (const eventId of eventIds) this.sql.exec("DELETE FROM temp_vip_outbox WHERE event_id = ?", eventId);
    });
    await this.rearm(this.now());
  }

  private extendRowSync(
    row: TempVipRowSql,
    durationMs: number,
    maximumRemainingMs: number,
    now: string,
    operationId: string,
    payloadJson: string,
    options: { person?: ModuleTempVipPerson; actorUserId: string | null },
    clearFailedRemoval = false,
  ): ModuleTempVipResult {
    const expiresAtMs = parseTime(row.expires_at);
    const newExpiry = Math.max(parseTime(now), expiresAtMs) + durationMs;
    const totalRemaining = Math.max(0, newExpiry - parseTime(now));
    if (totalRemaining > maximumRemainingMs) {
      const currentRemaining = Math.max(0, expiresAtMs - parseTime(now));
      const result = { status: "maximum_exceeded", allowedDurationMs: Math.max(0, maximumRemainingMs - currentRemaining) };
      saveOperationSync(this.sql, operationId, payloadJson, result, now);
      if (clearFailedRemoval) this.sql.exec("UPDATE temp_vips SET pending_op = NULL, pending_since = NULL, revision = revision + 1 WHERE user_id = ?", row.user_id);
      return result;
    }
    this.sql.exec(
      `UPDATE temp_vips SET expires_at = ?,
         user_login = COALESCE(?, user_login), user_display_name = COALESCE(?, user_display_name),
         pending_op = NULL, pending_since = NULL, status = 'active',
         grant_recovery_at = NULL, grant_recovery_attempts = 0,
         removal_failed_at = NULL, removal_retry_at = NULL, removal_attempts = 0, removal_error = NULL, end_reason = NULL,
         revision = revision + 1 WHERE user_id = ?`,
      utc(newExpiry),
      options.person?.login ?? null,
      options.person?.displayName ?? null,
      row.user_id,
    );
    const updated = rowFor(this.sql, row.user_id);
    const result: ModuleTempVipResult = { status: "extended", ...(updated === null ? {} : { row: publicRow(updated) }) };
    enqueueEventSync(this.sql, this.options.channelId, operationId, 0, now, options.actorUserId, "temp_vips.extended", {
      userId: row.user_id,
      login: updated?.user_login ?? row.user_login,
      expiresAt: updated?.expires_at ?? utc(newExpiry),
    });
    saveOperationSync(this.sql, operationId, payloadJson, result, now);
    return result;
  }

  private finishRemovalSync(
    userId: string,
    generation: number,
    removeStartedAt: string,
    operationId: string,
    result: { ok: true } | TempVipTwitchFailure,
    now: string,
    actorUserId: string | null,
    payloadJson: string,
  ): ModuleTempVipResult {
    const row = rowFor(this.sql, userId);
    if (row === null) return { status: "not_managed" };
    if (result.ok) {
      this.sql.exec("DELETE FROM temp_vips WHERE user_id = ?", userId);
      this.sql.exec(
        `INSERT OR REPLACE INTO temp_vip_tombstones
          (user_id, generation, remove_started_at, removed_at, retain_until)
         VALUES (?, ?, ?, ?, ?)`,
        userId,
        generation,
        removeStartedAt,
        now,
        utc(parseTime(now) + TEMP_VIP_ECHO_TOMBSTONE_MS),
      );
      const reason: TempVipEndReason = row.end_reason ?? "expired";
      enqueueEventSync(this.sql, this.options.channelId, operationId, 0, now, actorUserId ?? row.granted_by_user_id,
        "temp_vips.ended", { userId, login: row.user_login, reason });
      const ended = { status: "ended", reason };
      if (payloadJson.length > 0) saveOperationSync(this.sql, operationId, payloadJson, ended, now);
      return ended;
    }
    const attempts = row.removal_attempts + 1;
    this.sql.exec(
      `UPDATE temp_vips SET pending_op = NULL, pending_since = NULL, removal_failed_at = ?, removal_retry_at = NULL,
         removal_attempts = ?, removal_error = ?, expires_at = CASE WHEN end_reason = 'ended_early' THEN ? ELSE expires_at END,
         revision = revision + 1 WHERE user_id = ?`,
      now,
      attempts,
      result.reason.slice(0, 200),
      now,
      userId,
    );
    const retryAt = utc(parseTime(now) + backoffDelay(attempts));
    enqueueEventSync(this.sql, this.options.channelId, operationId, 0, now, actorUserId, "temp_vips.removal_failed", {
      userId,
      login: row.user_login,
      reason: result.reason,
      attempts,
      retryAt,
    });
    const failed: ModuleTempVipResult = { status: "removal_failed", reason: result.reason, retryAt };
    if (payloadJson.length > 0) saveOperationSync(this.sql, operationId, payloadJson, failed, now);
    return failed;
  }

  private isDue(row: TempVipRowSql, now: string): boolean {
    if (row.status !== "active") return false;
    if (row.pending_op !== null && row.pending_since !== null) {
      const pendingAge = parseTime(now) - parseTime(row.pending_since);
      if (pendingAge < TEMP_VIP_PENDING_LOCK_MS) return false;
      if (row.pending_op === "remove") return true;
    }
    const dueAt = row.removal_retry_at !== null
      ? parseTime(row.removal_retry_at)
      : row.removal_failed_at === null
        ? parseTime(row.expires_at)
        : parseTime(row.removal_failed_at) + backoffDelay(row.removal_attempts);
    return dueAt <= parseTime(now);
  }

  private async rearm(now: string): Promise<void> {
    const rows = this.sql.exec<TempVipRowSql>("SELECT * FROM temp_vips").toArray();
    const nowMs = parseTime(now);
    const pacing = this.sql.exec<{ count: number; earliest: number | null }>(
      "SELECT COUNT(*) AS count, MIN(reserved_at) AS earliest FROM temp_vip_removal_slots",
    ).one();
    const nextRemovalSlot = pacing.count >= TEMP_VIP_REMOVALS_PER_WINDOW
      ? (pacing.earliest ?? nowMs) + TEMP_VIP_REMOVAL_WINDOW_MS
      : null;
    const deadlines = rows.flatMap((row) => {
      if (row.status === "grant_unknown") {
        if (row.recovery_claim !== null && row.pending_since !== null) {
          return [parseTime(row.pending_since) + TEMP_VIP_PENDING_LOCK_MS];
        }
        return row.grant_recovery_at === null ? [] : [parseTime(row.grant_recovery_at)];
      }
      if (row.status === "grant_pending") return row.pending_since === null ? [] : [parseTime(row.pending_since) + TEMP_VIP_PENDING_LOCK_MS];
      if (row.pending_op !== null && row.pending_since !== null && nowMs - parseTime(row.pending_since) < TEMP_VIP_PENDING_LOCK_MS) {
        return [parseTime(row.pending_since) + TEMP_VIP_PENDING_LOCK_MS];
      }
      if (row.pending_op === "remove" && row.pending_since !== null) {
        return [parseTime(row.pending_since) + TEMP_VIP_PENDING_LOCK_MS];
      }
      const dueAt = row.removal_retry_at !== null
        ? parseTime(row.removal_retry_at)
        : row.removal_failed_at === null
          ? parseTime(row.expires_at)
          : parseTime(row.removal_failed_at) + backoffDelay(row.removal_attempts);
      return [nextRemovalSlot !== null && dueAt <= nowMs ? nextRemovalSlot : dueAt];
    });
    const hasOutbox = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM temp_vip_outbox").one().count > 0;
    if (hasOutbox) deadlines.push(parseTime(now) + TEMP_VIP_OUTBOX_RETRY_MS);
    const nextTombstone = this.sql.exec<{ retain_until: string | null }>(
      "SELECT MIN(retain_until) AS retain_until FROM temp_vip_tombstones",
    ).one().retain_until;
    if (nextTombstone !== null) deadlines.push(parseTime(nextTombstone));
    const nextOperationExpiry = this.sql.exec<{ expires_at: string | null }>(
      "SELECT MIN(expires_at) AS expires_at FROM temp_vip_operations",
    ).one().expires_at;
    if (nextOperationExpiry !== null) deadlines.push(parseTime(nextOperationExpiry));
    const earliest = deadlines.length === 0 ? null : Math.max(Date.now() + 1, Math.min(...deadlines));
    await this.options.scheduleAlarm(earliest);
  }

  private validateDuration(durationMs: number, maximumRemainingMs: number): void {
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || !Number.isSafeInteger(maximumRemainingMs) || maximumRemainingMs <= 0) {
      throw new Error("invalid_temp_vip_duration");
    }
  }

  private async safeGet(userId: string): Promise<Awaited<ReturnType<TempVipTwitch["get"]>>> {
    try { return await this.options.twitch.get(userId); }
    catch { return { ok: false, reason: "network", ambiguous: true }; }
  }

  private async safeAdd(userId: string): Promise<Awaited<ReturnType<TempVipTwitch["add"]>>> {
    try { return await this.options.twitch.add(userId); }
    catch { return { ok: false, reason: "network", ambiguous: true }; }
  }

  private async safeRemove(userId: string): Promise<Awaited<ReturnType<TempVipTwitch["remove"]>>> {
    try { return await this.options.twitch.remove(userId); }
    catch { return { ok: false, reason: "network", ambiguous: false }; }
  }
}
