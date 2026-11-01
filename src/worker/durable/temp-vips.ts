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
const TEMP_VIP_LEASE_MS = TEMP_VIP_PENDING_LOCK_MS;

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
  lease_id: string | null;
  lease_deadline: number | null;
  eventsub_verification: number;
  status: "active" | "grant_pending" | "grant_unknown";
  grant_phase: "checking" | "adding";
  grant_operation_id: string;
  grant_event_index: number;
  grant_generation: number;
  grant_recovery_at: string | null;
  grant_recovery_attempts: number;
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

type TempVipOperationKind =
  | "grant_check" | "grant_add" | "import" | "remove_manual" | "remove_expiry"
  | "eventsub_verification" | "recovery_grant" | "recovery_import"
  | "recovery_removal" | "recovery_eventsub";

interface TempVipLease {
  operationId: string;
  requestId: string;
  kind: TempVipOperationKind;
  userId: string;
  generation: number;
  leaseId: string;
  leaseDeadline: number;
  startedAt: string;
  removalStartedAt?: string;
}

interface TempVipOperationSql extends Record<string, string | number | null> {
  operation_id: string;
  request_id: string;
  kind: TempVipOperationKind;
  user_id: string;
  generation: number;
  lease_id: string;
  lease_deadline: number;
  payload_json: string;
  result_json: string | null;
  created_at: string;
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
    lease_id TEXT,
    lease_deadline INTEGER,
    eventsub_verification INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('active', 'grant_pending', 'grant_unknown')),
    grant_phase TEXT NOT NULL DEFAULT 'checking' CHECK (grant_phase IN ('checking', 'adding')),
    grant_operation_id TEXT NOT NULL DEFAULT '',
    grant_event_index INTEGER NOT NULL DEFAULT 0,
    grant_generation INTEGER NOT NULL,
    grant_recovery_at TEXT,
    grant_recovery_attempts INTEGER NOT NULL DEFAULT 0,
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
  sql.exec(`CREATE TABLE IF NOT EXISTS temp_vip_requests (
    operation_id TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL,
    result_json TEXT,
    expires_at TEXT NOT NULL
  )`);
  const operationColumns = sql.exec<{ name: string }>("PRAGMA table_info(temp_vip_operations)").toArray();
  if (operationColumns.length > 0 && !operationColumns.some(({ name }) => name === "kind")) {
    sql.exec(
      `INSERT OR IGNORE INTO temp_vip_requests (operation_id, payload_json, result_json, expires_at)
       SELECT operation_id, payload_json, result_json, expires_at FROM temp_vip_operations`,
    );
    sql.exec("DROP TABLE temp_vip_operations");
  }
  sql.exec(`CREATE TABLE IF NOT EXISTS temp_vip_operations (
    operation_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    user_id TEXT NOT NULL,
    generation INTEGER NOT NULL,
    lease_id TEXT NOT NULL,
    lease_deadline INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    result_json TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  )`);
  sql.exec("CREATE INDEX IF NOT EXISTS temp_vip_pending_operations ON temp_vip_operations (user_id, generation, result_json, lease_deadline)");
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
  if (!tempVipColumns.some(({ name }) => name === "removal_retry_at")) {
    sql.exec("ALTER TABLE temp_vips ADD COLUMN removal_retry_at TEXT");
  }
  if (!tempVipColumns.some(({ name }) => name === "lease_id")) {
    sql.exec("ALTER TABLE temp_vips ADD COLUMN lease_id TEXT");
  }
  if (!tempVipColumns.some(({ name }) => name === "lease_deadline")) {
    sql.exec("ALTER TABLE temp_vips ADD COLUMN lease_deadline INTEGER");
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
  sql.exec("DELETE FROM temp_vip_requests WHERE expires_at <= ? AND result_json IS NOT NULL", now);
  const prior = sql.exec<CachedOperationRow>(
    "SELECT payload_json, result_json, expires_at FROM temp_vip_requests WHERE operation_id = ?",
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
    `INSERT INTO temp_vip_requests (operation_id, payload_json, result_json, expires_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(operation_id) DO UPDATE SET
       result_json = excluded.result_json, expires_at = excluded.expires_at
       WHERE temp_vip_requests.payload_json = excluded.payload_json
       AND temp_vip_requests.result_json IS NULL`,
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
    `INSERT INTO temp_vip_requests (operation_id, payload_json, result_json, expires_at)
     VALUES (?, ?, NULL, ?)
     ON CONFLICT(operation_id) DO NOTHING`,
    operationId,
    payloadJson,
    utc(parseTime(now) + TEMP_VIP_OPERATION_RETENTION_MS),
  );
};

const reserveTwitchOperationSync = (
  sql: SqlStorage,
  input: {
    operationId?: string;
    requestId: string;
    kind: TempVipOperationKind;
    userId: string;
    generation: number;
    now: string;
    payloadJson: string;
  },
): TempVipLease => {
  const operationId = input.operationId ?? crypto.randomUUID();
  const leaseId = crypto.randomUUID();
  const leaseDeadline = parseTime(input.now) + TEMP_VIP_LEASE_MS;
  sql.exec(
    `INSERT INTO temp_vip_operations
      (operation_id, request_id, kind, user_id, generation, lease_id, lease_deadline,
       payload_json, result_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(operation_id) DO NOTHING`,
    operationId,
    input.requestId,
    input.kind,
    input.userId,
    input.generation,
    leaseId,
    leaseDeadline,
    input.payloadJson,
    input.now,
    utc(parseTime(input.now) + TEMP_VIP_OPERATION_RETENTION_MS),
  );
  return {
    operationId,
    requestId: input.requestId,
    kind: input.kind,
    userId: input.userId,
    generation: input.generation,
    leaseId,
    leaseDeadline,
    startedAt: input.now,
  };
};

const claimRowForOperationSync = (sql: SqlStorage, lease: TempVipLease, pendingOp: "grant" | "remove", eventsubVerification = false): void => {
  sql.exec(
    `UPDATE temp_vips SET pending_op = ?, pending_since = ?, lease_id = ?, lease_deadline = ?,
       eventsub_verification = ?, revision = revision + 1
     WHERE user_id = ? AND grant_generation = ?`,
    pendingOp,
    lease.startedAt,
    lease.leaseId,
    lease.leaseDeadline,
    eventsubVerification ? 1 : 0,
    lease.userId,
    lease.generation,
  );
};

const updateRootOperationLeaseSync = (sql: SqlStorage, operationId: string, lease: TempVipLease): void => {
  sql.exec(
    `UPDATE temp_vip_operations SET lease_id = ?, lease_deadline = ?
     WHERE operation_id = ? AND result_json IS NULL`,
    lease.leaseId,
    lease.leaseDeadline,
    operationId,
  );
};

const currentLeaseRowSync = (sql: SqlStorage, lease: TempVipLease): TempVipRowSql | null => {
  const row = rowFor(sql, lease.userId);
  return row !== null && row.grant_generation === lease.generation && row.lease_id === lease.leaseId &&
      row.lease_deadline === lease.leaseDeadline
    ? row
    : null;
};

const currentOperationForRowSync = (sql: SqlStorage, row: TempVipRowSql): TempVipOperationSql | null => {
  if (row.lease_id === null) return null;
  return sql.exec<TempVipOperationSql>(
    `SELECT * FROM temp_vip_operations WHERE user_id = ? AND generation = ? AND lease_id = ?
     ORDER BY created_at DESC, operation_id DESC LIMIT 1`,
    row.user_id,
    row.grant_generation,
    row.lease_id,
  ).toArray()[0] ?? null;
};

const originalOperationForRequestSync = (
  sql: SqlStorage,
  userId: string,
  generation: number,
  requestId: string,
): TempVipOperationSql | null => sql.exec<TempVipOperationSql>(
  `SELECT * FROM temp_vip_operations
    WHERE user_id = ? AND generation = ? AND request_id = ?
    ORDER BY CASE WHEN kind IN ('recovery_grant', 'recovery_import', 'recovery_removal', 'recovery_eventsub') THEN 1 ELSE 0 END,
             created_at, operation_id
    LIMIT 1`,
  userId,
  generation,
  requestId,
).toArray()[0] ?? null;

const settleTwitchOperationSync = (sql: SqlStorage, operationId: string, result: unknown, now: string): void => {
  sql.exec(
    `UPDATE temp_vip_operations SET result_json = ?, expires_at = ?
     WHERE operation_id = ? AND result_json IS NULL`,
    JSON.stringify(result),
    utc(parseTime(now) + TEMP_VIP_OPERATION_RETENTION_MS),
    operationId,
  );
};

const settleUnfinishedRowOperationsSync = (
  sql: SqlStorage,
  userId: string,
  generation: number,
  result: ModuleTempVipResult,
  now: string,
  keepRequestPending?: string,
): void => {
  const resultJson = JSON.stringify(result);
  const requests = sql.exec<{ request_id: string }>(
    `SELECT request_id FROM temp_vip_operations
      WHERE user_id = ? AND generation = ? AND result_json IS NULL`,
    userId,
    generation,
  ).toArray();
  const row = sql.exec<{ grant_operation_id: string }>(
    "SELECT grant_operation_id FROM temp_vips WHERE user_id = ? AND grant_generation = ?",
    userId,
    generation,
  ).toArray()[0];
  const requestIds = new Set(requests.map(({ request_id: requestId }) => requestId));
  if (row?.grant_operation_id) requestIds.add(row.grant_operation_id);
  sql.exec(
    `UPDATE temp_vip_operations SET result_json = ?, expires_at = ?
     WHERE user_id = ? AND generation = ? AND result_json IS NULL`,
    resultJson,
    utc(parseTime(now) + TEMP_VIP_OPERATION_RETENTION_MS),
    userId,
    generation,
  );
  for (const requestId of requestIds) {
    if (requestId === keepRequestPending) continue;
    const prior = sql.exec<{ payload_json: string; result_json: string | null }>(
      "SELECT payload_json, result_json FROM temp_vip_requests WHERE operation_id = ?",
      requestId,
    ).toArray()[0];
    const priorStatus = prior?.result_json === null || prior?.result_json === undefined
      ? null
      : (JSON.parse(prior.result_json) as ModuleTempVipResult).status;
    if (prior === undefined || (prior.result_json !== null && priorStatus !== "grant_unknown")) continue;
    sql.exec(
      `UPDATE temp_vip_requests SET result_json = ?, expires_at = ?
       WHERE operation_id = ? AND payload_json = ? AND (result_json IS NULL OR result_json = ?)`,
      resultJson,
      utc(parseTime(now) + TEMP_VIP_OPERATION_RETENTION_MS),
      requestId,
      prior.payload_json,
      prior.result_json,
    );
  }
};

const lockBusyOrClearSync = (sql: SqlStorage, row: TempVipRowSql, now: string): boolean => {
  if (row.pending_op === null || row.pending_since === null) return false;
  const leaseExpired = row.lease_deadline !== null
    ? Date.parse(now) >= row.lease_deadline
    : parseTime(now) - parseTime(row.pending_since) >= TEMP_VIP_PENDING_LOCK_MS;
  if (!leaseExpired) return true;
  if (row.status === "grant_unknown") {
    sql.exec(
      `UPDATE temp_vips SET pending_op = NULL, pending_since = NULL, lease_id = NULL, lease_deadline = NULL,
       revision = revision + 1 WHERE user_id = ? AND grant_generation = ?`,
      row.user_id,
      row.grant_generation,
    );
    return false;
  }
  sql.exec(
    `UPDATE temp_vips SET pending_op = NULL, pending_since = NULL,
       lease_id = NULL, lease_deadline = NULL, eventsub_verification = 0,
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
    const initial = this.transaction(() => {
      const cached = cachedOperationSync(this.sql, request.operationId, payloadJson, now);
      if (cached !== null) return { kind: "done" as const, result: cached };
      let row = rowFor(this.sql, request.person.userId);
      const orphanedRemove = row?.pending_op === "remove" && row.lease_deadline !== null && Date.parse(now) >= row.lease_deadline;
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
        reserveOperationSync(this.sql, request.operationId, payloadJson, now);
        const lease = reserveTwitchOperationSync(this.sql, {
          requestId: request.operationId,
          kind: "grant_check",
          userId: row.user_id,
          generation: row.grant_generation,
          now,
          payloadJson,
        });
        claimRowForOperationSync(this.sql, lease, "grant");
        return { kind: "check_existing" as const, lease };
      }
      if (request.durationMs > request.maximumRemainingMs) {
        const result = { status: "maximum_exceeded", allowedDurationMs: request.maximumRemainingMs };
        saveOperationSync(this.sql, request.operationId, payloadJson, result, now);
        return { kind: "done" as const, result };
      }
      const generation = insertGrantPendingSync(
        this.sql, request.operationId, 0, request.person, request.grantedBy, request.source, now,
        utc(parseTime(now) + request.durationMs),
      );
      reserveOperationSync(this.sql, request.operationId, payloadJson, now);
      const lease = reserveTwitchOperationSync(this.sql, {
        operationId: request.operationId,
        requestId: request.operationId,
        kind: "grant_check",
        userId: request.person.userId,
        generation,
        now,
        payloadJson,
      });
      claimRowForOperationSync(this.sql, lease, "grant");
      return { kind: "create" as const, lease };
    });
    if (initial.kind === "done") {
      await this.rearm(now);
      return initial.result;
    }

    await this.rearm(initial.lease.startedAt);
    const lookup = await this.safeGet(request.person.userId);
    const lookupAt = this.now();
    const afterLookup = this.transaction(() => {
      const current = currentLeaseRowSync(this.sql, initial.lease);
      settleTwitchOperationSync(this.sql, initial.lease.operationId, lookup, lookupAt);
      if (current === null) {
        settleTwitchOperationSync(this.sql, initial.lease.operationId, lookup, lookupAt);
        return { result: { status: "busy" }, addLease: null as TempVipLease | null };
      }
      const row = rowFor(this.sql, request.person.userId);
      if (row === null) return { result: { status: "not_managed" }, addLease: null };
      if (!lookup.ok) {
        const unavailable: ModuleTempVipResult = { status: "twitch_unavailable", reason: lookup.reason };
        if (initial.kind === "create") {
          settleUnfinishedRowOperationsSync(this.sql, row.user_id, row.grant_generation, unavailable, lookupAt);
          this.sql.exec("DELETE FROM temp_vips WHERE user_id = ? AND grant_generation = ?", row.user_id, row.grant_generation);
        } else {
          this.sql.exec("UPDATE temp_vips SET pending_op = NULL, pending_since = NULL, lease_id = NULL, lease_deadline = NULL, revision = revision + 1 WHERE user_id = ? AND grant_generation = ? AND lease_id = ?", row.user_id, row.grant_generation, initial.lease.leaseId);
          saveOperationSync(this.sql, request.operationId, payloadJson, unavailable, lookupAt);
        }
        if (initial.kind === "create") saveOperationSync(this.sql, request.operationId, payloadJson, unavailable, lookupAt);
        return { result: unavailable, addLease: null };
      }
      if (lookup.isVip) {
        if (initial.kind === "check_existing") {
          const extended = this.extendRowSync(row, request.durationMs, request.maximumRemainingMs, lookupAt, request.operationId, payloadJson, {
            person: request.person,
            actorUserId: request.grantedBy?.userId ?? null,
          }, true);
          return { result: extended, addLease: null };
        }
        const alreadyVip: ModuleTempVipResult = { status: "already_vip" };
        settleUnfinishedRowOperationsSync(this.sql, row.user_id, row.grant_generation, alreadyVip, lookupAt);
        this.sql.exec("DELETE FROM temp_vips WHERE user_id = ? AND grant_generation = ?", row.user_id, row.grant_generation);
        saveOperationSync(this.sql, request.operationId, payloadJson, alreadyVip, lookupAt);
        return { result: alreadyVip, addLease: null };
      }
      if (request.durationMs > request.maximumRemainingMs) {
        const maximum: ModuleTempVipResult = { status: "maximum_exceeded", allowedDurationMs: request.maximumRemainingMs };
        if (initial.kind === "create") {
          settleUnfinishedRowOperationsSync(this.sql, row.user_id, row.grant_generation, maximum, lookupAt);
          this.sql.exec("DELETE FROM temp_vips WHERE user_id = ? AND grant_generation = ?", row.user_id, row.grant_generation);
        } else {
          this.sql.exec("UPDATE temp_vips SET pending_op = NULL, pending_since = NULL, lease_id = NULL, lease_deadline = NULL, revision = revision + 1 WHERE user_id = ? AND grant_generation = ? AND lease_id = ?", row.user_id, row.grant_generation, initial.lease.leaseId);
        }
        saveOperationSync(this.sql, request.operationId, payloadJson, maximum, lookupAt);
        return { result: maximum, addLease: null };
      }
      let generation = row.grant_generation;
      let eventIndex = 0;
      if (initial.kind === "check_existing") {
        const oldReason: TempVipEndReason = row.end_reason ?? "expired";
        settleUnfinishedRowOperationsSync(this.sql, row.user_id, row.grant_generation, { status: "removed" }, lookupAt, request.operationId);
        this.sql.exec("DELETE FROM temp_vips WHERE user_id = ? AND grant_generation = ?", row.user_id, row.grant_generation);
        enqueueEventSync(this.sql, this.options.channelId, request.operationId, 0, lookupAt, row.granted_by_user_id,
          "temp_vips.ended", { userId: row.user_id, login: row.user_login, reason: oldReason });
        generation = insertGrantPendingSync(
          this.sql, request.operationId, 1, request.person, request.grantedBy, request.source, lookupAt,
          utc(parseTime(lookupAt) + request.durationMs),
        );
        this.sql.exec("UPDATE temp_vips SET grant_phase = 'adding' WHERE user_id = ? AND grant_generation = ?", request.person.userId, generation);
        eventIndex = 1;
      } else {
        this.sql.exec("UPDATE temp_vips SET grant_phase = 'adding', revision = revision + 1 WHERE user_id = ? AND grant_generation = ?", row.user_id, generation);
      }
      const addLease = reserveTwitchOperationSync(this.sql, {
        requestId: request.operationId,
        kind: "grant_add",
        userId: request.person.userId,
        generation,
        now: lookupAt,
        payloadJson,
      });
      claimRowForOperationSync(this.sql, addLease, "grant");
      if (addLease.operationId !== request.operationId) updateRootOperationLeaseSync(this.sql, request.operationId, addLease);
      return { result: null as unknown as ModuleTempVipResult, addLease, eventIndex };
    });
    if (afterLookup.addLease === null) {
      await this.rearm(this.now());
      return afterLookup.result;
    }
    const addLease = afterLookup.addLease;

    await this.rearm(addLease.startedAt);
    const add = await this.safeAdd(request.person.userId);
    const completedAt = this.now();
    const result = this.transaction(() => {
      const current = currentLeaseRowSync(this.sql, addLease);
      settleTwitchOperationSync(this.sql, addLease.operationId, add, completedAt);
      if (current === null) return { status: "busy" };
      const row = rowFor(this.sql, request.person.userId);
      if (row === null) return { status: "not_managed" };
      if (add.ok) {
        this.sql.exec(
          `UPDATE temp_vips SET status = 'active', pending_op = NULL, pending_since = NULL, lease_id = NULL, lease_deadline = NULL,
             grant_recovery_at = NULL, grant_recovery_attempts = 0,
             user_login = ?, user_display_name = ?, revision = revision + 1
           WHERE user_id = ? AND grant_generation = ? AND lease_id = ?`,
          request.person.login,
          request.person.displayName,
          request.person.userId,
          row.grant_generation,
          addLease.leaseId,
        );
        const updated = rowFor(this.sql, request.person.userId);
        const granted: ModuleTempVipResult = { status: "granted", ...(updated === null ? {} : { row: publicRow(updated) }) };
        enqueueEventSync(this.sql, this.options.channelId, request.operationId, "eventIndex" in afterLookup ? afterLookup.eventIndex : 0,
          completedAt, request.grantedBy?.userId ?? null, "temp_vips.granted", {
            userId: request.person.userId, login: request.person.login, expiresAt: updated?.expires_at ?? null, source: request.source,
          });
        settleTwitchOperationSync(this.sql, request.operationId, granted, completedAt);
        saveOperationSync(this.sql, request.operationId, payloadJson, granted, completedAt);
        return granted;
      }
      if (add.ambiguous === true) {
        this.sql.exec(
            `UPDATE temp_vips SET status = 'grant_unknown', pending_op = NULL, pending_since = NULL, lease_id = NULL, lease_deadline = NULL,
             grant_recovery_at = ?, grant_recovery_attempts = 0, revision = revision + 1
           WHERE user_id = ? AND grant_generation = ? AND lease_id = ?`,
          utc(parseTime(completedAt) + GRANT_RECOVERY_DELAYS_MS[0]),
          request.person.userId,
          row.grant_generation,
          addLease.leaseId,
        );
        return { status: "grant_unknown", reason: add.reason };
      }
      const rejected: ModuleTempVipResult = { status: "rejected", reason: add.reason };
      settleUnfinishedRowOperationsSync(this.sql, row.user_id, row.grant_generation, rejected, completedAt);
      this.sql.exec("DELETE FROM temp_vips WHERE user_id = ? AND grant_generation = ? AND lease_id = ?", row.user_id, row.grant_generation, addLease.leaseId);
      settleTwitchOperationSync(this.sql, request.operationId, rejected, completedAt);
      saveOperationSync(this.sql, request.operationId, payloadJson, rejected, completedAt);
      return rejected;
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
      if (cached !== null) return { result: cached, lease: null as TempVipLease | null };
      let row = rowFor(this.sql, request.person.userId);
      if (row === null) return { result: { status: "not_managed" }, lease: null };
      const orphanedRemove = row.pending_op === "remove" && row.lease_deadline !== null && Date.parse(now) >= row.lease_deadline;
      if (lockBusyOrClearSync(this.sql, row, now)) return { result: { status: "busy" }, lease: null };
      row = rowFor(this.sql, request.person.userId);
      if (row === null) return { result: { status: "not_managed" }, lease: null };
      if (row.status !== "active") return { result: { status: "busy" }, lease: null };
      if (row.removal_failed_at === null && !orphanedRemove) {
        return { result: this.extendRowSync(row, request.durationMs, request.maximumRemainingMs, now, request.operationId, payloadJson, { person: request.person, actorUserId: request.grantedBy?.userId ?? null }), lease: null };
      }
      reserveOperationSync(this.sql, request.operationId, payloadJson, now);
      const lease = reserveTwitchOperationSync(this.sql, {
        requestId: request.operationId,
        kind: "grant_check",
        userId: row.user_id,
        generation: row.grant_generation,
        now,
        payloadJson,
      });
      claimRowForOperationSync(this.sql, lease, "grant");
      return { result: null, lease };
    });
    if (initial.lease === null) {
      if (initial.result !== null && initial.result.status !== "busy" && cachedOperationSync(this.sql, request.operationId, payloadJson, now) === null) {
        this.transaction(() => { saveOperationSync(this.sql, request.operationId, payloadJson, initial.result, now); });
      }
      await this.rearm(now);
      return initial.result ?? { status: "busy" };
    }
    await this.rearm(initial.lease.startedAt);
    const lookup = await this.safeGet(request.person.userId);
    const completedAt = this.now();
    const check = this.transaction(() => {
      const current = currentLeaseRowSync(this.sql, initial.lease as TempVipLease);
      settleTwitchOperationSync(this.sql, (initial.lease as TempVipLease).operationId, lookup, completedAt);
      if (current === null) return { result: { status: "busy" } as ModuleTempVipResult, addLease: null as TempVipLease | null };
      const row = rowFor(this.sql, request.person.userId);
      if (row === null) return { result: { status: "not_managed" } as ModuleTempVipResult, addLease: null };
      if (!lookup.ok) {
        this.sql.exec("UPDATE temp_vips SET pending_op = NULL, pending_since = NULL, lease_id = NULL, lease_deadline = NULL, revision = revision + 1 WHERE user_id = ? AND grant_generation = ? AND lease_id = ?", row.user_id, row.grant_generation, (initial.lease as TempVipLease).leaseId);
        const unavailable = { status: "twitch_unavailable", reason: lookup.reason };
        saveOperationSync(this.sql, request.operationId, payloadJson, unavailable, completedAt);
        return { result: unavailable, addLease: null };
      }
      if (lookup.isVip) {
        const extended = this.extendRowSync(row, request.durationMs, request.maximumRemainingMs, completedAt, request.operationId, payloadJson, { person: request.person, actorUserId: request.grantedBy?.userId ?? null }, true);
        return { result: extended, addLease: null };
      }
      if (request.durationMs > request.maximumRemainingMs) {
        this.sql.exec("UPDATE temp_vips SET pending_op = NULL, pending_since = NULL, lease_id = NULL, lease_deadline = NULL, revision = revision + 1 WHERE user_id = ? AND grant_generation = ? AND lease_id = ?", row.user_id, row.grant_generation, (initial.lease as TempVipLease).leaseId);
        const maximumExceeded = { status: "maximum_exceeded", allowedDurationMs: request.maximumRemainingMs };
        saveOperationSync(this.sql, request.operationId, payloadJson, maximumExceeded, completedAt);
        return { result: maximumExceeded, addLease: null };
      }
      const reason: TempVipEndReason = row.end_reason ?? "expired";
      settleUnfinishedRowOperationsSync(this.sql, row.user_id, row.grant_generation, { status: "removed" }, completedAt, request.operationId);
      this.sql.exec("DELETE FROM temp_vips WHERE user_id = ? AND grant_generation = ?", row.user_id, row.grant_generation);
      enqueueEventSync(this.sql, this.options.channelId, request.operationId, 0, completedAt, null,
        "temp_vips.ended", { userId: row.user_id, login: row.user_login, reason });
      const generation = insertGrantPendingSync(
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
      const addLease = reserveTwitchOperationSync(this.sql, {
        requestId: request.operationId,
        kind: "grant_add",
        userId: request.person.userId,
        generation,
        now: completedAt,
        payloadJson,
      });
      claimRowForOperationSync(this.sql, addLease, "grant");
      updateRootOperationLeaseSync(this.sql, request.operationId, addLease);
      return { result: { status: "regrant_pending" }, addLease };
    });
    if (check.addLease !== null) {
      const addLease = check.addLease;
      await this.rearm(addLease.startedAt);
      const add = await this.safeAdd(request.person.userId);
      const settledAt = this.now();
      const settled = this.transaction(() => {
        const current = currentLeaseRowSync(this.sql, addLease);
        settleTwitchOperationSync(this.sql, addLease.operationId, add, settledAt);
        if (current === null) return { status: "busy" };
        const row = rowFor(this.sql, request.person.userId);
        if (row === null) return { status: "not_managed" };
        if (add.ok) {
          this.sql.exec(
            `UPDATE temp_vips SET status = 'active', pending_op = NULL, pending_since = NULL, lease_id = NULL, lease_deadline = NULL,
               grant_recovery_at = NULL, grant_recovery_attempts = 0, user_login = ?, user_display_name = ?, revision = revision + 1
             WHERE user_id = ? AND grant_generation = ? AND lease_id = ?`,
            request.person.login, request.person.displayName, request.person.userId, row.grant_generation, addLease.leaseId,
          );
          const active = rowFor(this.sql, request.person.userId);
          const granted: ModuleTempVipResult = { status: "granted", ...(active === null ? {} : { row: publicRow(active) }) };
          enqueueEventSync(this.sql, this.options.channelId, request.operationId, 1, settledAt, request.grantedBy?.userId ?? null,
            "temp_vips.granted", { userId: request.person.userId, login: request.person.login, expiresAt: active?.expires_at ?? null, source: request.source ?? "dashboard" });
          settleTwitchOperationSync(this.sql, request.operationId, granted, settledAt);
          saveOperationSync(this.sql, request.operationId, payloadJson, granted, settledAt);
          return granted;
        }
        if (add.ambiguous === true) {
          this.sql.exec(
            `UPDATE temp_vips SET status = 'grant_unknown', pending_op = NULL, pending_since = NULL, lease_id = NULL, lease_deadline = NULL,
               grant_recovery_at = ?, grant_recovery_attempts = 0, revision = revision + 1 WHERE user_id = ? AND grant_generation = ? AND lease_id = ?`,
            utc(parseTime(settledAt) + GRANT_RECOVERY_DELAYS_MS[0]), request.person.userId, row.grant_generation, addLease.leaseId,
          );
          return { status: "grant_unknown", reason: add.reason };
        }
        const rejected = { status: "rejected", reason: add.reason };
        settleUnfinishedRowOperationsSync(this.sql, row.user_id, row.grant_generation, rejected, settledAt);
        this.sql.exec("DELETE FROM temp_vips WHERE user_id = ? AND grant_generation = ? AND lease_id = ?", row.user_id, row.grant_generation, addLease.leaseId);
        settleTwitchOperationSync(this.sql, request.operationId, rejected, settledAt);
        saveOperationSync(this.sql, request.operationId, payloadJson, rejected, settledAt);
        return rejected;
      });
      await this.rearm(settledAt);
      return settled;
    }
    await this.rearm(completedAt);
    return check.result;
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
      if (cached !== null) return { done: cached, lease: null as TempVipLease | null };
      const row = rowFor(this.sql, request.person.userId);
      if (row !== null) {
        if (lockBusyOrClearSync(this.sql, row, now)) return { done: { status: "busy" }, lease: null };
        return { done: { status: "already_managed" }, lease: null };
      }
      if (request.durationMs > request.maximumRemainingMs) {
        const result = { status: "maximum_exceeded", allowedDurationMs: request.maximumRemainingMs };
        saveOperationSync(this.sql, request.operationId, payloadJson, result, now);
        return { done: result, lease: null };
      }
      const generation = insertGrantPendingSync(this.sql, request.operationId, 0, request.person, request.grantedBy, "import", now, utc(parseTime(now) + request.durationMs));
      reserveOperationSync(this.sql, request.operationId, payloadJson, now);
      const lease = reserveTwitchOperationSync(this.sql, {
        operationId: request.operationId,
        requestId: request.operationId,
        kind: "import",
        userId: request.person.userId,
        generation,
        now,
        payloadJson,
      });
      claimRowForOperationSync(this.sql, lease, "grant");
      return { done: null, lease };
    });
    if (initial.done !== null) {
      if (initial.done.status !== "busy") this.transaction(() => { saveOperationSync(this.sql, request.operationId, payloadJson, initial.done, now); });
      await this.rearm(now);
      return initial.done;
    }
    const lease = initial.lease;
    await this.rearm(lease.startedAt);
    const lookup = await this.safeGet(request.person.userId);
    const completedAt = this.now();
    const result = this.transaction(() => {
      const current = currentLeaseRowSync(this.sql, lease);
      if (current === null) {
        settleTwitchOperationSync(this.sql, lease.operationId, lookup, completedAt);
        return { status: "busy" };
      }
      const rowAtStart = rowFor(this.sql, request.person.userId);
      if (rowAtStart === null) return { status: "not_managed" };
      if (!lookup.ok) {
        const unavailable = { status: "twitch_unavailable", reason: lookup.reason };
        settleUnfinishedRowOperationsSync(this.sql, request.person.userId, lease.generation, unavailable, completedAt);
        this.sql.exec("DELETE FROM temp_vips WHERE user_id = ? AND grant_generation = ? AND lease_id = ?", request.person.userId, lease.generation, lease.leaseId);
        settleTwitchOperationSync(this.sql, lease.operationId, unavailable, completedAt);
        saveOperationSync(this.sql, request.operationId, payloadJson, unavailable, completedAt);
        return unavailable;
      }
      if (!lookup.isVip) {
        const noLongerVip = { status: "not_vip" };
        settleUnfinishedRowOperationsSync(this.sql, request.person.userId, lease.generation, noLongerVip, completedAt);
        this.sql.exec("DELETE FROM temp_vips WHERE user_id = ? AND grant_generation = ? AND lease_id = ?", request.person.userId, lease.generation, lease.leaseId);
        settleTwitchOperationSync(this.sql, lease.operationId, noLongerVip, completedAt);
        saveOperationSync(this.sql, request.operationId, payloadJson, noLongerVip, completedAt);
        return noLongerVip;
      }
      this.sql.exec(
        `UPDATE temp_vips SET status = 'active', pending_op = NULL, pending_since = NULL, lease_id = NULL, lease_deadline = NULL,
           user_login = ?, user_display_name = ?, revision = revision + 1
         WHERE user_id = ? AND grant_generation = ? AND lease_id = ?`,
        request.person.login,
        request.person.displayName,
        request.person.userId,
        lease.generation,
        lease.leaseId,
      );
      const row = rowFor(this.sql, request.person.userId);
      const imported: ModuleTempVipResult = { status: "imported", ...(row === null ? {} : { row: publicRow(row) }) };
      settleTwitchOperationSync(this.sql, lease.operationId, imported, completedAt);
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
      if (cached !== null) return { result: cached, lease: null as TempVipLease | null };
      let row = rowFor(this.sql, request.userId);
      if (row === null) {
        const result = { status: "not_managed" };
        saveOperationSync(this.sql, request.operationId, payloadJson, result, now);
        return { result, lease: null };
      }
      if (lockBusyOrClearSync(this.sql, row, now)) return { result: { status: "busy" }, lease: null };
      row = rowFor(this.sql, request.userId);
      if (row === null || row.status !== "active") return { result: { status: "busy" }, lease: null };
      const reservedAt = this.now();
      const retryAt = reserveRemovalSlotSync(this.sql, reservedAt);
      if (retryAt !== null) {
        this.sql.exec(
          `UPDATE temp_vips SET end_reason = 'ended_early', expires_at = ?, removal_retry_at = ?, pending_op = NULL,
             pending_since = NULL, lease_id = NULL, lease_deadline = NULL, revision = revision + 1 WHERE user_id = ? AND grant_generation = ?`,
          reservedAt,
          utc(retryAt),
          row.user_id,
          row.grant_generation,
        );
        const result = { status: "queued", retryAt: utc(retryAt) };
        saveOperationSync(this.sql, request.operationId, payloadJson, result, reservedAt);
        return { result, lease: null };
      }
      this.sql.exec(
        `UPDATE temp_vips SET end_reason = 'ended_early', removal_retry_at = NULL, revision = revision + 1
         WHERE user_id = ? AND grant_generation = ?`,
        row.user_id,
        row.grant_generation,
      );
      reserveOperationSync(this.sql, request.operationId, payloadJson, reservedAt);
      const lease = reserveTwitchOperationSync(this.sql, {
        operationId: request.operationId,
        requestId: request.operationId,
        kind: "remove_manual",
        userId: request.userId,
        generation: row.grant_generation,
        now: reservedAt,
        payloadJson,
      });
      claimRowForOperationSync(this.sql, lease, "remove");
      return { result: null, lease };
    });
    if (start.lease === null) {
      await this.rearm(this.now());
      return start.result;
    }
    await this.rearm(start.lease.startedAt);
    const removed = await this.safeRemove(request.userId);
    const completedAt = this.now();
    const result = this.transaction(() => {
      const current = currentLeaseRowSync(this.sql, start.lease as TempVipLease);
      if (current === null) {
        settleTwitchOperationSync(this.sql, (start.lease as TempVipLease).operationId, removed, completedAt);
        return { status: "busy" };
      }
      return this.finishRemovalSync(start.lease as TempVipLease, removed, completedAt, null, payloadJson);
    });
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
      const released = { status: "released" };
      settleUnfinishedRowOperationsSync(this.sql, row.user_id, row.grant_generation, released, now);
      this.sql.exec("DELETE FROM temp_vips WHERE user_id = ?", request.userId);
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
      this.sql.exec("DELETE FROM temp_vip_requests WHERE expires_at <= ? AND result_json IS NOT NULL", now);
      const row = rowFor(this.sql, event.userId);
      const stale = tombstoneMatchSync(this.sql, event.userId, eventAt, now, row?.grant_generation ?? null);
      if (stale || (row !== null && eventAt < parseTime(row.granted_at))) return { result: { status: "ignored_stale_echo" }, lease: null as TempVipLease | null };
      if (row === null) return { result: { status: "ignored_unmanaged" }, lease: null };
      if (row.pending_op === "remove" && row.lease_deadline !== null && Date.parse(now) < row.lease_deadline) {
        return { result: { status: row.eventsub_verification === 1 ? "busy" : "ignored_own_echo" }, lease: null };
      }
      if (lockBusyOrClearSync(this.sql, row, now)) return { result: { status: "busy" }, lease: null };
      const payloadJson = JSON.stringify({ action: "eventsub_verification", userId: event.userId, eventSubTimestamp: event.eventSubTimestamp });
      const lease = reserveTwitchOperationSync(this.sql, {
        operationId: crypto.randomUUID(),
        requestId: event.triggerId,
        kind: "eventsub_verification",
        userId: row.user_id,
        generation: row.grant_generation,
        now,
        payloadJson,
      });
      claimRowForOperationSync(this.sql, lease, "remove", true);
      return { result: null, lease };
    });
    if (initial.result !== null) {
      await this.rearm(now);
      return initial.result;
    }
    const lease = initial.lease;
    await this.rearm(lease.startedAt);
    const lookup = await this.safeGet(event.userId);
    const completedAt = this.now();
    const result = this.transaction(() => {
      const row = currentLeaseRowSync(this.sql, lease);
      if (row === null) {
        settleTwitchOperationSync(this.sql, lease.operationId, lookup, completedAt);
        return { status: "busy" };
      }
      if (!lookup.ok) {
        this.sql.exec(
          `UPDATE temp_vips SET pending_op = NULL, pending_since = NULL, lease_id = NULL, lease_deadline = NULL,
             eventsub_verification = 0, revision = revision + 1
           WHERE user_id = ? AND grant_generation = ? AND lease_id = ?`,
          event.userId,
          lease.generation,
          lease.leaseId,
        );
        settleTwitchOperationSync(this.sql, lease.operationId, lookup, completedAt);
        return { status: `lookup_failed:${lookup.reason}` };
      }
      if (lookup.isVip) {
        this.sql.exec("UPDATE temp_vips SET pending_op = NULL, pending_since = NULL, lease_id = NULL, lease_deadline = NULL, eventsub_verification = 0, revision = revision + 1 WHERE user_id = ? AND grant_generation = ? AND lease_id = ?", event.userId, lease.generation, lease.leaseId);
        settleTwitchOperationSync(this.sql, lease.operationId, { status: "ignored_stale_event" }, completedAt);
        return { status: "ignored_stale_event" };
      }
      const reason: TempVipEndReason = "removed_on_twitch";
      const removed = { status: "removed_on_twitch" };
      settleUnfinishedRowOperationsSync(this.sql, row.user_id, row.grant_generation, removed, completedAt);
      this.sql.exec("DELETE FROM temp_vips WHERE user_id = ? AND grant_generation = ? AND lease_id = ?", event.userId, lease.generation, lease.leaseId);
      enqueueEventSync(this.sql, this.options.channelId, event.triggerId, 0, completedAt, null, "temp_vips.ended", { userId: event.userId, login: row.user_login, reason });
      return removed;
    });
    await this.rearm(completedAt);
    if (result.status.startsWith("lookup_failed:")) throw new Error(`temp_vip_event_check_failed:${result.status.slice("lookup_failed:".length)}`);
    return result;
  }

  public async runExpiry(now = this.now()): Promise<{ removed: number; recoveredGrants: number }> {
    parseTime(now);
    const currentTime = (): string => utc(Math.max(parseTime(now), parseTime(this.now())));
    const startedAt = currentTime();
    this.transaction(() => {
      this.sql.exec("DELETE FROM temp_vip_requests WHERE expires_at <= ? AND result_json IS NOT NULL", startedAt);
      this.sql.exec("DELETE FROM temp_vip_operations WHERE expires_at <= ? AND result_json IS NOT NULL", startedAt);
      this.sql.exec("DELETE FROM temp_vip_tombstones WHERE retain_until <= ?", startedAt);
    });
    let recoveredGrants = 0;
    let removed = 0;
    const recoveryCandidates = this.sql.exec<TempVipRowSql>(
      `SELECT * FROM temp_vips
       WHERE status = 'grant_pending' OR status = 'grant_unknown'
       ORDER BY COALESCE(grant_recovery_at, pending_since, expires_at), user_id`,
    ).toArray();
    for (const snapshot of recoveryCandidates) {
      const claimedAt = currentTime();
      const claim = this.transaction(() => {
        const row = rowFor(this.sql, snapshot.user_id);
        if (row === null || row.grant_generation !== snapshot.grant_generation) return null;
        const hasLease = row.pending_op !== null;
        const expiredLease = hasLease
          ? row.lease_deadline === null
            ? row.pending_since === null || parseTime(claimedAt) - parseTime(row.pending_since) >= TEMP_VIP_LEASE_MS
            : Date.parse(claimedAt) >= row.lease_deadline
          : row.status === "grant_pending" && row.pending_since === null;
        if (hasLease && !expiredLease) return null;
        if (row.status === "grant_pending" && !expiredLease) return null;
        if (row.status === "grant_unknown" && !hasLease && row.grant_recovery_at !== null && row.grant_recovery_at > claimedAt) return null;
        if (row.status === "grant_pending") {
          this.sql.exec("UPDATE temp_vips SET status = 'grant_unknown', grant_recovery_at = ?, revision = revision + 1 WHERE user_id = ? AND grant_generation = ?",
            claimedAt, row.user_id, row.grant_generation);
        }
        const current = rowFor(this.sql, row.user_id);
        if (current === null) return null;
        const requestId = current.grant_operation_id || currentOperationForRowSync(this.sql, current)?.request_id || `recovery:${current.user_id}:${String(current.grant_generation)}`;
        const kind: TempVipOperationKind = current.source === "import" ? "recovery_import" : "recovery_grant";
        const payloadJson = JSON.stringify({ action: kind, userId: current.user_id, generation: current.grant_generation, requestId });
        const lease = reserveTwitchOperationSync(this.sql, {
          requestId,
          kind,
          userId: current.user_id,
          generation: current.grant_generation,
          now: claimedAt,
          payloadJson,
        });
        claimRowForOperationSync(this.sql, lease, "grant");
        updateRootOperationLeaseSync(this.sql, requestId, lease);
        return { lease, requestId };
      });
      if (claim === null) continue;
      await this.rearm(claim.lease.startedAt);
      const lookup = await this.safeGet(snapshot.user_id);
      const completedAt = currentTime();
      const applied = this.transaction(() => {
        const row = currentLeaseRowSync(this.sql, claim.lease);
        settleTwitchOperationSync(this.sql, claim.lease.operationId, lookup, completedAt);
        if (row === null) return false;
        if (!lookup.ok) {
          const attempts = row.grant_recovery_attempts + 1;
          this.sql.exec(
            `UPDATE temp_vips SET pending_op = NULL, pending_since = NULL, lease_id = NULL, lease_deadline = NULL,
               grant_recovery_attempts = ?, grant_recovery_at = ?, revision = revision + 1
             WHERE user_id = ? AND grant_generation = ? AND lease_id = ?`,
            attempts,
            utc(parseTime(completedAt) + grantRecoveryDelay(attempts)),
            row.user_id,
            row.grant_generation,
            claim.lease.leaseId,
          );
          return true;
        }
        if (lookup.isVip && (row.source === "import" || row.grant_phase === "adding")) {
          this.sql.exec(
            `UPDATE temp_vips SET status = 'active', pending_op = NULL, pending_since = NULL, lease_id = NULL, lease_deadline = NULL,
               grant_recovery_at = NULL, grant_recovery_attempts = 0, revision = revision + 1
             WHERE user_id = ? AND grant_generation = ? AND lease_id = ?`,
            row.user_id,
            row.grant_generation,
            claim.lease.leaseId,
          );
          const recovered = rowFor(this.sql, row.user_id);
          const result: ModuleTempVipResult = {
            status: row.source === "import" ? "imported" : "granted",
            ...(recovered === null ? {} : { row: publicRow(recovered) }),
          };
          const originalPayload = this.sql.exec<{ payload_json: string }>(
            "SELECT payload_json FROM temp_vip_requests WHERE operation_id = ?", claim.requestId,
          ).toArray()[0]?.payload_json;
          if (originalPayload !== undefined) saveOperationSync(this.sql, claim.requestId, originalPayload, result, completedAt);
          settleUnfinishedRowOperationsSync(this.sql, row.user_id, row.grant_generation, result, completedAt);
          enqueueEventSync(this.sql, this.options.channelId, claim.requestId, row.grant_event_index, completedAt, row.granted_by_user_id,
            row.source === "import" ? "temp_vips.imported" : "temp_vips.granted",
            { userId: row.user_id, login: row.user_login, expiresAt: row.expires_at, source: row.source });
          return true;
        }
        let result: ModuleTempVipResult;
        if (row.source === "import") result = { status: "not_vip" };
        else if (row.grant_phase === "checking" && lookup.isVip) result = { status: "already_vip" };
        else if (row.grant_phase === "checking") result = { status: "twitch_unavailable", reason: "network" };
        else result = { status: "rejected", reason: "network" };
        settleUnfinishedRowOperationsSync(this.sql, row.user_id, row.grant_generation, result, completedAt);
        this.sql.exec("DELETE FROM temp_vips WHERE user_id = ? AND grant_generation = ? AND lease_id = ?", row.user_id, row.grant_generation, claim.lease.leaseId);
        const originalPayload = this.sql.exec<{ payload_json: string }>(
          "SELECT payload_json FROM temp_vip_requests WHERE operation_id = ?", claim.requestId,
        ).toArray()[0]?.payload_json;
        if (originalPayload !== undefined) saveOperationSync(this.sql, claim.requestId, originalPayload, result, completedAt);
        return true;
      });
      if (lookup.ok && applied) recoveredGrants += 1;
    }

    const removalCandidates = this.sql.exec<TempVipRowSql>(
      `SELECT * FROM temp_vips WHERE pending_op = 'remove' ORDER BY pending_since, user_id`,
    ).toArray();
    for (const snapshot of removalCandidates) {
      const claimedAt = currentTime();
      const claim = this.transaction(() => {
        const row = rowFor(this.sql, snapshot.user_id);
        if (row === null || row.grant_generation !== snapshot.grant_generation || row.pending_op !== "remove") return null;
        const expiredLease = row.lease_deadline === null
          ? row.pending_since === null || parseTime(claimedAt) - parseTime(row.pending_since) >= TEMP_VIP_LEASE_MS
          : Date.parse(claimedAt) >= row.lease_deadline;
        if (!expiredLease) return null;
        const currentOperation = currentOperationForRowSync(this.sql, row);
        const requestId = currentOperation?.request_id ?? currentOperation?.operation_id ?? `recovery:${row.user_id}:${String(row.grant_generation)}`;
        const original = originalOperationForRequestSync(this.sql, row.user_id, row.grant_generation, requestId) ?? currentOperation;
        const isEventsubVerification = row.eventsub_verification === 1 || original?.kind === "eventsub_verification" || original?.kind === "recovery_eventsub";
        const kind: TempVipOperationKind = isEventsubVerification ? "recovery_eventsub" : "recovery_removal";
        const payloadJson = JSON.stringify({ action: kind, userId: row.user_id, generation: row.grant_generation, requestId });
        const lease = reserveTwitchOperationSync(this.sql, {
          requestId,
          kind,
          userId: row.user_id,
          generation: row.grant_generation,
          now: claimedAt,
          payloadJson,
        });
        claimRowForOperationSync(this.sql, lease, "remove", isEventsubVerification);
        if (original !== null) updateRootOperationLeaseSync(this.sql, original.operation_id, lease);
        return {
          lease: { ...lease, ...(original === null ? {} : { removalStartedAt: original.created_at }) },
          requestId,
          originalOperationId: original?.operation_id ?? null,
          originalKind: original?.kind ?? "remove_expiry",
        };
      });
      if (claim === null) continue;
      await this.rearm(claim.lease.startedAt);
      const lookup = await this.safeGet(snapshot.user_id);
      const completedAt = currentTime();
      const nextDelete = this.transaction(() => {
        const row = currentLeaseRowSync(this.sql, claim.lease);
        settleTwitchOperationSync(this.sql, claim.lease.operationId, lookup, completedAt);
        if (row === null) return null;
        if (claim.lease.kind === "recovery_eventsub") {
          if (!lookup.ok) {
            this.sql.exec("UPDATE temp_vips SET pending_op = NULL, pending_since = NULL, lease_id = NULL, lease_deadline = NULL, eventsub_verification = 0, revision = revision + 1 WHERE user_id = ? AND grant_generation = ? AND lease_id = ?", row.user_id, row.grant_generation, claim.lease.leaseId);
            if (claim.originalOperationId !== null) settleTwitchOperationSync(this.sql, claim.originalOperationId, { status: "verification_failed", reason: lookup.reason }, completedAt);
            return null;
          }
          if (lookup.isVip) {
            this.sql.exec("UPDATE temp_vips SET pending_op = NULL, pending_since = NULL, lease_id = NULL, lease_deadline = NULL, eventsub_verification = 0, revision = revision + 1 WHERE user_id = ? AND grant_generation = ? AND lease_id = ?", row.user_id, row.grant_generation, claim.lease.leaseId);
            if (claim.originalOperationId !== null) settleTwitchOperationSync(this.sql, claim.originalOperationId, { status: "ignored_stale_event" }, completedAt);
            return null;
          }
          const removed = { status: "removed_on_twitch" };
          settleUnfinishedRowOperationsSync(this.sql, row.user_id, row.grant_generation, removed, completedAt);
          this.sql.exec("DELETE FROM temp_vips WHERE user_id = ? AND grant_generation = ? AND lease_id = ?", row.user_id, row.grant_generation, claim.lease.leaseId);
          enqueueEventSync(this.sql, this.options.channelId, claim.requestId, 0, completedAt, null, "temp_vips.ended", {
            userId: row.user_id, login: row.user_login, reason: "removed_on_twitch",
          });
          return null;
        }
        if (!lookup.ok) return { lease: claim.lease, failure: { ok: false as const, reason: lookup.reason } };
        if (!lookup.isVip) return { lease: claim.lease, failure: { ok: true as const } };
        const retryAt = reserveRemovalSlotSync(this.sql, completedAt);
        if (retryAt !== null) {
          const queued: ModuleTempVipResult = { status: "queued", retryAt: utc(retryAt) };
          settleUnfinishedRowOperationsSync(this.sql, row.user_id, row.grant_generation, queued, completedAt);
          this.sql.exec(
            `UPDATE temp_vips SET expires_at = CASE WHEN end_reason = 'ended_early' THEN ? ELSE expires_at END,
               removal_retry_at = ?, pending_op = NULL, pending_since = NULL, lease_id = NULL, lease_deadline = NULL,
               eventsub_verification = 0, revision = revision + 1
             WHERE user_id = ? AND grant_generation = ? AND lease_id = ?`,
            completedAt, utc(retryAt), row.user_id, row.grant_generation, claim.lease.leaseId,
          );
          const payload = this.sql.exec<{ payload_json: string }>("SELECT payload_json FROM temp_vip_requests WHERE operation_id = ?", claim.requestId).toArray()[0]?.payload_json;
          if (payload !== undefined) saveOperationSync(this.sql, claim.requestId, payload, queued, completedAt);
          if (claim.originalOperationId !== null) settleTwitchOperationSync(this.sql, claim.originalOperationId, queued, completedAt);
          return null;
        }
        const deleteKind: TempVipOperationKind = claim.originalKind === "remove_manual" ? "remove_manual" : "remove_expiry";
        const payloadJson = JSON.stringify({ action: deleteKind, userId: row.user_id, generation: row.grant_generation, requestId: claim.requestId });
        const lease = reserveTwitchOperationSync(this.sql, {
          requestId: claim.requestId,
          kind: deleteKind,
          userId: row.user_id,
          generation: row.grant_generation,
          now: completedAt,
          payloadJson,
        });
        claimRowForOperationSync(this.sql, lease, "remove");
        if (claim.originalOperationId !== null) updateRootOperationLeaseSync(this.sql, claim.originalOperationId, lease);
        return { lease, failure: null };
      });
      if (nextDelete === null) continue;
      if (nextDelete.failure !== null) {
        this.transaction(() => {
          const current = currentLeaseRowSync(this.sql, nextDelete.lease);
          if (current === null) return;
          const result = this.finishRemovalSync(nextDelete.lease, nextDelete.failure, completedAt, null,
            this.sql.exec<{ payload_json: string }>("SELECT payload_json FROM temp_vip_requests WHERE operation_id = ?", nextDelete.lease.requestId).toArray()[0]?.payload_json ?? "");
          if (result.status === "ended") removed += 1;
        });
        continue;
      }
      await this.rearm(nextDelete.lease.startedAt);
      const removal = await this.safeRemove(nextDelete.lease.userId);
      const removedAt = currentTime();
      const result = this.transaction(() => {
        const current = currentLeaseRowSync(this.sql, nextDelete.lease);
        settleTwitchOperationSync(this.sql, nextDelete.lease.operationId, removal, removedAt);
        if (current === null) return { status: "busy" };
        return this.finishRemovalSync(nextDelete.lease, removal, removedAt, null,
          this.sql.exec<{ payload_json: string }>("SELECT payload_json FROM temp_vip_requests WHERE operation_id = ?", nextDelete.lease.requestId).toArray()[0]?.payload_json ?? "");
      });
      if (result.status === "ended") removed += 1;
    }

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
        if (row === null || row.status !== "active" || row.pending_op !== null) return { lease: null, retryAt: null };
        if (!this.isDue(row, claimedAt)) return { lease: null, retryAt: null };
        const retryAt = reserveRemovalSlotSync(this.sql, claimedAt);
        if (retryAt !== null) {
          this.sql.exec(
            `UPDATE temp_vips SET expires_at = CASE WHEN end_reason = 'ended_early' THEN ? ELSE expires_at END,
               removal_retry_at = ?, pending_op = NULL, pending_since = NULL, lease_id = NULL, lease_deadline = NULL,
               eventsub_verification = 0, revision = revision + 1 WHERE user_id = ? AND grant_generation = ?`,
            claimedAt, utc(retryAt), row.user_id, row.grant_generation,
          );
          return { lease: null, retryAt };
        }
        const operationId = `expiry:${row.user_id}:${String(row.grant_generation)}:${crypto.randomUUID()}`;
        const payloadJson = JSON.stringify({ action: "expiry", userId: row.user_id, generation: row.grant_generation });
        const lease = reserveTwitchOperationSync(this.sql, {
          operationId,
          requestId: operationId,
          kind: "remove_expiry",
          userId: row.user_id,
          generation: row.grant_generation,
          now: claimedAt,
          payloadJson,
        });
        claimRowForOperationSync(this.sql, lease, "remove");
        this.sql.exec("UPDATE temp_vips SET removal_retry_at = NULL WHERE user_id = ? AND grant_generation = ?", row.user_id, row.grant_generation);
        return { lease, retryAt: null };
      });
      if (claim.retryAt !== null) break;
      const lease = claim.lease;
      if (lease === null) break;
      await this.rearm(lease.startedAt);
      const removal = await this.safeRemove(lease.userId);
      const completedAt = currentTime();
      const result = this.transaction(() => {
        const current = currentLeaseRowSync(this.sql, lease);
        if (current === null) {
          settleTwitchOperationSync(this.sql, lease.operationId, removal, completedAt);
          return { status: "busy" };
        }
        return this.finishRemovalSync(lease, removal, completedAt, null,
          JSON.stringify({ action: "expiry", userId: lease.userId, generation: lease.generation }));
      });
      if (result.status === "ended") removed += 1;
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
      if (clearFailedRemoval) this.sql.exec("UPDATE temp_vips SET pending_op = NULL, pending_since = NULL, lease_id = NULL, lease_deadline = NULL, revision = revision + 1 WHERE user_id = ? AND grant_generation = ?", row.user_id, row.grant_generation);
      return result;
    }
    this.sql.exec(
      `UPDATE temp_vips SET expires_at = ?,
         user_login = COALESCE(?, user_login), user_display_name = COALESCE(?, user_display_name),
         pending_op = NULL, pending_since = NULL, lease_id = NULL, lease_deadline = NULL, status = 'active',
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
    lease: TempVipLease,
    result: { ok: true } | TempVipTwitchFailure,
    now: string,
    actorUserId: string | null,
    payloadJson: string,
  ): ModuleTempVipResult {
    const row = currentLeaseRowSync(this.sql, lease);
    if (row === null) return { status: "busy" };
    if (result.ok) {
      const reason: TempVipEndReason = row.end_reason ?? "expired";
      const ended: ModuleTempVipResult = { status: "ended", reason };
      settleUnfinishedRowOperationsSync(this.sql, lease.userId, lease.generation, ended, now);
      this.sql.exec("DELETE FROM temp_vips WHERE user_id = ? AND grant_generation = ? AND lease_id = ?", lease.userId, lease.generation, lease.leaseId);
      this.sql.exec(
        `INSERT OR REPLACE INTO temp_vip_tombstones
          (user_id, generation, remove_started_at, removed_at, retain_until)
         VALUES (?, ?, ?, ?, ?)`,
        lease.userId,
        lease.generation,
        lease.removalStartedAt ?? lease.startedAt,
        now,
        utc(parseTime(now) + TEMP_VIP_ECHO_TOMBSTONE_MS),
      );
      settleTwitchOperationSync(this.sql, lease.operationId, ended, now);
      settleTwitchOperationSync(this.sql, lease.requestId, ended, now);
      enqueueEventSync(this.sql, this.options.channelId, lease.requestId, 0, now, actorUserId ?? row.granted_by_user_id,
        "temp_vips.ended", { userId: lease.userId, login: row.user_login, reason });
      if (payloadJson.length > 0) saveOperationSync(this.sql, lease.requestId, payloadJson, ended, now);
      return ended;
    }
    const attempts = row.removal_attempts + 1;
    this.sql.exec(
      `UPDATE temp_vips SET pending_op = NULL, pending_since = NULL, lease_id = NULL, lease_deadline = NULL,
         eventsub_verification = 0, removal_failed_at = ?, removal_retry_at = NULL,
         removal_attempts = ?, removal_error = ?, expires_at = CASE WHEN end_reason = 'ended_early' THEN ? ELSE expires_at END,
         revision = revision + 1 WHERE user_id = ? AND grant_generation = ? AND lease_id = ?`,
      now,
      attempts,
      result.reason.slice(0, 200),
      now,
      lease.userId,
      lease.generation,
      lease.leaseId,
    );
    const retryAt = utc(parseTime(now) + backoffDelay(attempts));
    enqueueEventSync(this.sql, this.options.channelId, lease.requestId, 0, now, actorUserId, "temp_vips.removal_failed", {
      userId: lease.userId,
      login: row.user_login,
      reason: result.reason,
      attempts,
      retryAt,
    });
    const failed: ModuleTempVipResult = { status: "removal_failed", reason: result.reason, retryAt };
    settleTwitchOperationSync(this.sql, lease.operationId, failed, now);
    settleTwitchOperationSync(this.sql, lease.requestId, failed, now);
    if (payloadJson.length > 0) saveOperationSync(this.sql, lease.requestId, payloadJson, failed, now);
    return failed;
  }

  private isDue(row: TempVipRowSql, now: string): boolean {
    if (row.status !== "active" || row.pending_op !== null) return false;
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
        if (row.lease_deadline !== null && row.pending_op !== null) {
          return [row.lease_deadline];
        }
        return row.grant_recovery_at === null ? [] : [parseTime(row.grant_recovery_at)];
      }
      if (row.status === "grant_pending") return row.lease_deadline === null
        ? row.pending_since === null ? [] : [parseTime(row.pending_since) + TEMP_VIP_LEASE_MS]
        : [row.lease_deadline];
      if (row.pending_op !== null) return row.lease_deadline !== null
        ? [row.lease_deadline]
        : row.pending_since === null ? [] : [parseTime(row.pending_since) + TEMP_VIP_LEASE_MS];
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
      "SELECT MIN(expires_at) AS expires_at FROM temp_vip_requests WHERE result_json IS NOT NULL",
    ).one().expires_at;
    if (nextOperationExpiry !== null) deadlines.push(parseTime(nextOperationExpiry));
    const nextAsyncOperationExpiry = this.sql.exec<{ expires_at: string | null }>(
      "SELECT MIN(expires_at) AS expires_at FROM temp_vip_operations WHERE result_json IS NOT NULL",
    ).one().expires_at;
    if (nextAsyncOperationExpiry !== null) deadlines.push(parseTime(nextAsyncOperationExpiry));
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
