import type {
  ModuleTempVipExtendRequest,
  ModuleTempVipGrantRequest,
  ModuleTempVipImportRequest,
  ModuleTempVipIntentRequest,
  ModuleTempVipObservedAddRequest,
  ModuleTempVipClassifyRequest,
  ModuleTempVipModerationEvent,
  ModuleTempVipPerson,
  ModuleTempVipRemovedEvent,
  ModuleTempVipResult,
  ModuleTempVipRow,
  ModuleTempVipMode,
  ModuleTempVipOperationRequest,
  TempVipEndReason,
  TempVipSource,
} from "../../modules/contract";
import { TEMP_VIP_MINIMUM_DURATION_MS } from "../../modules/temp_vips/domain";

const TEMP_VIP_MUTATIONS_PER_WINDOW = 10;
const TEMP_VIP_MUTATION_WINDOW_MS = 10_000;
const TEMP_VIP_OPERATION_RETENTION_MS = 24 * 60 * 60_000;
/** Channel points grants stay journaled longer so a late redemption reconciliation replays instead of re-granting. */
const TEMP_VIP_CHANNEL_POINTS_RETENTION_MS = 30 * 24 * 60 * 60_000;
const TEMP_VIP_LIFECYCLE_RETENTION_MS = 7 * 24 * 60 * 60_000;
const TEMP_VIP_CALLER_WAIT_MS = 10_000;
const TEMP_VIP_RECOVERY_MS = 60_000;
const TEMP_VIP_QUEUED_RECOVERY_MS = 30_000;
const TEMP_VIP_MAX_REMOVALS_PER_DRAIN = 10;
const TEMP_VIP_RETRY_MS = 60_000;
const TEMP_VIP_OBSERVE_DEFER_MS = 5 * 60_000;
const TEMP_VIP_OUTBOX_RETRY_MS = 60_000;
const REMOVAL_RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

type TempVipTwitchFailure = { ok: false; reason: string; ambiguous?: boolean };
export type TempVipTwitch = {
  get: (userId: string) => Promise<{ ok: true; isVip: boolean } | TempVipTwitchFailure>;
  add: (userId: string, beforeAttempt: () => Promise<boolean>) => Promise<{ ok: true } | TempVipTwitchFailure>;
  remove: (userId: string, beforeAttempt: () => Promise<boolean>) => Promise<{ ok: true } | TempVipTwitchFailure>;
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
  isModuleEnabled?: () => Promise<boolean>;
  isManaged?: () => Promise<boolean>;
  isChannelPointsRedemptionOpen?: (redemptionId: string) => Promise<boolean | null>;
  commitModuleDisable?: (request: {
    actor: { userId: string; sessionId: string };
    expectedRevision: number;
    changedAt: string;
  }) => Promise<{ revision: number; lastDisabledRevision: number | null } | null>;
}

export interface TempVipModuleDisableRequest {
  operationId: string;
  actor: { userId: string; sessionId: string };
  expectedRevision: number;
}

export interface TempVipModuleDisableResult {
  status: string;
  revision?: number;
  lastDisabledRevision?: number | null;
}

type TempVipStorage = Pick<DurableObjectStorage, "sql" | "transactionSync">;
type TempVipOperationKind = "grant" | "extend" | "import" | "end" | "release" | "expire" | "verify_removed" | "disable_module"
  | "record_intent" | "add_observed" | "classify" | "moderation";
type QueueStatus = "queued" | "running" | "done";

interface TempVipRowSql extends Record<string, string | number | null> {
  user_id: string;
  user_login: string;
  user_display_name: string;
  expires_at: string | null;
  granted_at: string;
  twitch_state_at: string;
  local_edit_at: string;
  granted_by_user_id: string | null;
  granted_by_login: string | null;
  source: TempVipSource;
  removal_failed_at: string | null;
  removal_attempts: number;
  removal_error: string | null;
  end_reason: "ended_early" | null;
  classification: ModuleTempVipRow["classification"];
  confirmation: ModuleTempVipRow["confirmation"];
  expiry_reminder_at: string | null;
}

interface TempVipOperationSql extends Record<string, string | number | null> {
  operation_id: string;
  kind: TempVipOperationKind;
  user_id: string;
  user_login: string;
  payload_json: string;
  status: QueueStatus;
  attempts: number;
  next_attempt_at: string;
  result_json: string | null;
  created_at: string;
  finished_at: string | null;
  enqueue_sequence: number;
  needs_reconcile: number;
}

interface OperationPayload {
  request: Record<string, unknown>;
  stage?: string;
  intentAt?: string | null;
  precondition?: "not_vip";
  retryNow?: boolean;
  mutationAttempted?: boolean;
  mutationAmbiguous?: boolean;
}

type TempVipStoredResult = ModuleTempVipResult & {
  revision?: number;
  lastDisabledRevision?: number | null;
};

interface ClaimedOperation {
  operation: TempVipOperationSql;
  payload: OperationPayload;
  needsReconcile: boolean;
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
  removalFailedAt: row.removal_failed_at,
  removalAttempts: row.removal_attempts,
  removalError: row.removal_error,
  endReason: row.end_reason,
  classification: row.classification,
  confirmation: row.confirmation,
  expiryReminderAt: row.expiry_reminder_at,
});

const decodePayload = (payloadJson: string): OperationPayload => {
  const value: unknown = JSON.parse(payloadJson);
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
      typeof (value as { request?: unknown }).request !== "object" ||
      (value as { request?: unknown }).request === null || Array.isArray((value as { request?: unknown }).request)) {
    throw new Error("invalid_temp_vip_operation_payload");
  }
  return value as OperationPayload;
};

const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
};

const requestJson = (payload: OperationPayload): string => canonicalJson(payload.request);

const ensureTempVipsSchema = (sql: SqlStorage, now: string): void => {
  const createRows = (tableName: string): void => {
    sql.exec(`CREATE TABLE ${tableName} (
      user_id TEXT PRIMARY KEY,
      user_login TEXT NOT NULL,
      user_display_name TEXT NOT NULL,
      expires_at TEXT,
      granted_at TEXT NOT NULL,
      twitch_state_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
      local_edit_at TEXT NOT NULL DEFAULT '1970-01-01T00:00:00.000Z',
      granted_by_user_id TEXT,
      granted_by_login TEXT,
      source TEXT NOT NULL CHECK (source IN ('command', 'dashboard', 'import', 'channel_points', 'observed')),
      removal_failed_at TEXT,
      removal_attempts INTEGER NOT NULL DEFAULT 0,
      removal_error TEXT,
      end_reason TEXT CHECK (end_reason IN ('ended_early')),
      classification TEXT NOT NULL DEFAULT 'temporary' CHECK (classification IN ('unclassified', 'permanent', 'temporary')),
      confirmation TEXT NOT NULL DEFAULT 'confirmed' CHECK (confirmation IN ('confirmed', 'awaiting_vip')),
      expiry_reminder_at TEXT
    )`);
  };
  const existingRowsSql = sql.exec<{ sql: string | null }>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'temp_vips'",
  ).toArray()[0]?.sql;
  if (existingRowsSql === undefined || existingRowsSql === null) {
    createRows("temp_vips");
  } else {
    const columns = new Set(sql.exec<{ name: string }>("PRAGMA table_info(temp_vips)").toArray().map(({ name }) => name));
    const expiryColumn = sql.exec<{ name: string; notnull: number }>("PRAGMA table_info(temp_vips)").toArray()
      .find(({ name }) => name === "expires_at");
    const rebuildRows = !columns.has("classification") || !columns.has("confirmation") ||
      !columns.has("expiry_reminder_at") || !columns.has("twitch_state_at") || !columns.has("local_edit_at") ||
      !existingRowsSql.includes("observed") || expiryColumn?.notnull === 1;
    if (rebuildRows) {
      sql.exec("DROP INDEX IF EXISTS temp_vips_expiry");
      sql.exec("ALTER TABLE temp_vips RENAME TO temp_vips_legacy");
      createRows("temp_vips");
      const values = [
        "user_id", "user_login", "user_display_name", "expires_at", "granted_at", "twitch_state_at", "local_edit_at", "granted_by_user_id",
        "granted_by_login", "source", "removal_failed_at", "removal_attempts", "removal_error", "end_reason",
        "classification", "confirmation", "expiry_reminder_at",
      ];
      const select = [
        "user_id", "user_login", "user_display_name", "expires_at", "granted_at",
        columns.has("twitch_state_at") ? "twitch_state_at" : "granted_at",
        columns.has("local_edit_at") ? "local_edit_at" : columns.has("latest_state_at") ? "latest_state_at" : "granted_at",
        "granted_by_user_id",
        "granted_by_login", "source", "removal_failed_at", "removal_attempts", "removal_error", "end_reason",
        columns.has("classification") ? "classification" : "'temporary'",
        columns.has("confirmation") ? "confirmation" : "'confirmed'",
        columns.has("expiry_reminder_at") ? "expiry_reminder_at" : "NULL",
      ];
      sql.exec(`INSERT INTO temp_vips (${values.join(", ")}) SELECT ${select.join(", ")} FROM temp_vips_legacy`);
      sql.exec("DROP TABLE temp_vips_legacy");
    }
  }
  sql.exec("CREATE INDEX IF NOT EXISTS temp_vips_expiry ON temp_vips (expires_at, user_id)");
  sql.exec(`CREATE TABLE IF NOT EXISTS temp_vip_lifecycle_watermarks (
    user_id TEXT PRIMARY KEY,
    twitch_state_at TEXT NOT NULL,
    retain_until TEXT NOT NULL
  )`);
  const watermarkRetainUntil = utc(parseTime(now) + TEMP_VIP_LIFECYCLE_RETENTION_MS);
  sql.exec(
    `INSERT INTO temp_vip_lifecycle_watermarks (user_id, twitch_state_at, retain_until)
     SELECT user_id, twitch_state_at, ? FROM temp_vips WHERE twitch_state_at > '1970-01-01T00:00:00.000Z'
     ON CONFLICT(user_id) DO UPDATE SET
       twitch_state_at = CASE WHEN excluded.twitch_state_at > temp_vip_lifecycle_watermarks.twitch_state_at
         THEN excluded.twitch_state_at ELSE temp_vip_lifecycle_watermarks.twitch_state_at END,
       retain_until = CASE WHEN excluded.twitch_state_at >= temp_vip_lifecycle_watermarks.twitch_state_at
         THEN excluded.retain_until ELSE temp_vip_lifecycle_watermarks.retain_until END`,
    watermarkRetainUntil,
  );

  const existingOperationsSql = sql.exec<{ sql: string | null }>(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'temp_vip_ops'",
  ).toArray()[0]?.sql;
  const operationKinds = "'moderation'";
  if (existingOperationsSql === undefined || existingOperationsSql === null) {
    sql.exec(`CREATE TABLE temp_vip_ops (
      operation_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('grant', 'extend', 'import', 'end', 'release', 'expire', 'verify_removed', 'disable_module', 'record_intent', 'add_observed', 'classify', 'moderation')),
      user_id TEXT NOT NULL,
      user_login TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      enqueue_sequence INTEGER NOT NULL DEFAULT 0,
      needs_reconcile INTEGER NOT NULL DEFAULT 0
    )`);
  } else if (!existingOperationsSql.includes(operationKinds)) {
    sql.exec("DROP INDEX IF EXISTS temp_vip_ops_due");
    sql.exec("DROP INDEX IF EXISTS temp_vip_ops_user_order");
    sql.exec("DROP INDEX IF EXISTS temp_vip_ops_sequence_unique");
    sql.exec("ALTER TABLE temp_vip_ops RENAME TO temp_vip_ops_legacy");
    sql.exec(`CREATE TABLE temp_vip_ops (
      operation_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('grant', 'extend', 'import', 'end', 'release', 'expire', 'verify_removed', 'disable_module', 'record_intent', 'add_observed', 'classify', 'moderation')),
      user_id TEXT NOT NULL,
      user_login TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done')),
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT,
      enqueue_sequence INTEGER NOT NULL DEFAULT 0,
      needs_reconcile INTEGER NOT NULL DEFAULT 0
    )`);
    sql.exec(`INSERT INTO temp_vip_ops
      (operation_id, kind, user_id, user_login, payload_json, status, attempts, next_attempt_at,
       result_json, created_at, finished_at, enqueue_sequence, needs_reconcile)
      SELECT operation_id, kind, user_id, user_login, payload_json, status, attempts, next_attempt_at,
       result_json, created_at, finished_at, enqueue_sequence, needs_reconcile FROM temp_vip_ops_legacy`);
    sql.exec("DROP TABLE temp_vip_ops_legacy");
  }
  sql.exec("CREATE INDEX IF NOT EXISTS temp_vip_ops_due ON temp_vip_ops (status, next_attempt_at, enqueue_sequence)");
  sql.exec("CREATE INDEX IF NOT EXISTS temp_vip_ops_user_order ON temp_vip_ops (user_id, enqueue_sequence, status)");
  sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS temp_vip_ops_sequence_unique ON temp_vip_ops (enqueue_sequence)");
  sql.exec(`CREATE TABLE IF NOT EXISTS temp_vip_sequence (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    last_sequence INTEGER NOT NULL
  )`);
  sql.exec(`INSERT OR IGNORE INTO temp_vip_sequence (singleton, last_sequence)
    SELECT 1, COALESCE(MAX(enqueue_sequence), 0) FROM temp_vip_ops`);
  sql.exec(`CREATE TABLE IF NOT EXISTS temp_vip_mutation_attempts (
    attempt_id INTEGER PRIMARY KEY AUTOINCREMENT,
    attempted_at INTEGER NOT NULL
  )`);
  sql.exec(`CREATE TABLE IF NOT EXISTS temp_vip_outbox (
    event_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    actor_user_id TEXT,
    code TEXT NOT NULL,
    detail_json TEXT NOT NULL
  )`);
  // Any row change flags the transaction; transaction() turns the flag into one panel refresh marker.
  sql.exec("CREATE TABLE IF NOT EXISTS temp_vip_panel_dirty (id INTEGER PRIMARY KEY CHECK (id = 1), dirty INTEGER NOT NULL)");
  sql.exec("INSERT OR IGNORE INTO temp_vip_panel_dirty (id, dirty) VALUES (1, 0)");
  for (const event of ["INSERT", "UPDATE", "DELETE"]) {
    sql.exec(`CREATE TRIGGER IF NOT EXISTS temp_vips_panel_dirty_${event.toLowerCase()} AFTER ${event} ON temp_vips
      BEGIN UPDATE temp_vip_panel_dirty SET dirty = 1; END`);
  }
};

const enqueueEventSync = (
  sql: SqlStorage,
  channelId: string,
  operationId: string,
  eventIndex: string | number,
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

const backoffDelay = (attempts: number): number =>
  REMOVAL_RETRY_DELAYS_MS[Math.min(Math.max(0, attempts - 1), REMOVAL_RETRY_DELAYS_MS.length - 1)] ?? 60 * 60_000;

const makePayload = (request: Record<string, unknown>, stage = "initial", intentAt: string | null = null): string =>
  JSON.stringify({ request, stage, intentAt, mutationAttempted: false, mutationAmbiguous: false } satisfies OperationPayload);

const isCreationOperation = (kind: TempVipOperationKind): boolean =>
  kind === "grant" || kind === "extend" || kind === "import" || kind === "record_intent" ||
  kind === "add_observed" || kind === "classify" || kind === "moderation";

const rowActionRefusal = (row: TempVipRowSql): "permanent_vip" | "unclassified_vip" | null =>
  row.classification === "permanent" ? "permanent_vip"
    : row.classification === "unclassified" ? "unclassified_vip" : null;

const runnerByStorage = new WeakMap<object, Promise<void>>();
const userOrderAvailable = `NOT EXISTS (
  SELECT 1 FROM temp_vip_ops AS earlier
   WHERE earlier.user_id = candidate.user_id AND earlier.status != 'done'
     AND earlier.enqueue_sequence < candidate.enqueue_sequence
     AND NOT (
       candidate.kind IN ('grant', 'extend', 'verify_removed')
       AND earlier.kind IN ('end', 'expire')
       AND earlier.status = 'queued'
       AND earlier.next_attempt_at > ?
       AND EXISTS (
         SELECT 1 FROM temp_vips AS removal_row
          WHERE removal_row.user_id = candidate.user_id AND removal_row.removal_failed_at IS NOT NULL
       )
     )
)`;

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
    this.transaction(() => {
      ensureTempVipsSchema(this.sql, this.now());
    });
  }

  private transaction<Result>(run: () => Result): Result {
    return this.storage.transactionSync(run);
  }

  /**
   * Panel refresh state, set by SQLite triggers on row changes:
   * 0 = published, 1 = changed (revision not bumped yet), 2 = bumped but publication still pending.
   */
  public panelRefreshState(): 0 | 1 | 2 {
    return this.sql.exec<{ dirty: 0 | 1 | 2 }>("SELECT dirty FROM temp_vip_panel_dirty").one().dirty;
  }

  public markPanelBumped(): void {
    this.sql.exec("UPDATE temp_vip_panel_dirty SET dirty = 2 WHERE dirty = 1");
  }

  /** Call only after the panel publication succeeded. A change made meanwhile (state 1) stays dirty. */
  public async clearPanelDirty(): Promise<void> {
    this.sql.exec("UPDATE temp_vip_panel_dirty SET dirty = 0 WHERE dirty = 2");
    await this.rearm();
  }

  private async isManaged(): Promise<boolean> {
    return this.options.isManaged === undefined ? true : await this.options.isManaged();
  }

  private latestTwitchStateAtSync(userId: string): string {
    const rowStateAt = rowFor(this.sql, userId)?.twitch_state_at ?? "1970-01-01T00:00:00.000Z";
    const historyStateAt = this.sql.exec<{ twitch_state_at: string }>(
      "SELECT twitch_state_at FROM temp_vip_lifecycle_watermarks WHERE user_id = ?",
      userId,
    ).toArray()[0]?.twitch_state_at ?? "1970-01-01T00:00:00.000Z";
    return parseTime(rowStateAt) >= parseTime(historyStateAt) ? rowStateAt : historyStateAt;
  }

  private advanceTwitchStateSync(userId: string, timestamp: string, observedAt = this.now()): string {
    const candidate = utc(parseTime(timestamp));
    const previous = this.latestTwitchStateAtSync(userId);
    const latest = parseTime(candidate) >= parseTime(previous) ? candidate : previous;
    const retainUntil = utc(parseTime(observedAt) + TEMP_VIP_LIFECYCLE_RETENTION_MS);
    this.sql.exec(
      `INSERT INTO temp_vip_lifecycle_watermarks (user_id, twitch_state_at, retain_until)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         twitch_state_at = CASE WHEN excluded.twitch_state_at >= temp_vip_lifecycle_watermarks.twitch_state_at
           THEN excluded.twitch_state_at ELSE temp_vip_lifecycle_watermarks.twitch_state_at END,
         retain_until = CASE WHEN excluded.twitch_state_at >= temp_vip_lifecycle_watermarks.twitch_state_at
           THEN excluded.retain_until ELSE temp_vip_lifecycle_watermarks.retain_until END`,
      userId,
      latest,
      retainUntil,
    );
    this.sql.exec(
      `UPDATE temp_vips SET twitch_state_at = ? WHERE user_id = ? AND twitch_state_at < ?`,
      latest,
      userId,
      latest,
    );
    return latest;
  }

  public async mode(): Promise<ModuleTempVipMode> {
    if (this.options.isModuleEnabled !== undefined && !await this.options.isModuleEnabled()) return "inactive";
    return await this.isManaged() ? "managed" : "observe";
  }

  private nextSequenceSync(): number {
    const last = this.sql.exec<{ last_sequence: number }>(
      `SELECT MAX(last_sequence, COALESCE((SELECT MAX(enqueue_sequence) FROM temp_vip_ops), 0)) AS last_sequence
         FROM temp_vip_sequence WHERE singleton = 1`,
    ).one().last_sequence;
    const next = last + 1;
    this.sql.exec("UPDATE temp_vip_sequence SET last_sequence = ? WHERE singleton = 1", next);
    return next;
  }

  private enqueue(
    operationId: string,
    kind: TempVipOperationKind,
    userId: string,
    userLogin: string,
    request: Record<string, unknown>,
  ): TempVipOperationSql {
    operationKey(operationId);
    const now = this.now();
    return this.transaction(() => {
      this.pruneOperationsSync(now);
      const payloadJson = makePayload(request);
      const existing = this.sql.exec<TempVipOperationSql>(
        "SELECT * FROM temp_vip_ops WHERE operation_id = ?",
        operationId,
      ).toArray()[0];
      if (existing !== undefined) {
        const priorPayload = decodePayload(existing.payload_json);
        if (existing.kind !== kind || existing.user_id !== userId || requestJson(priorPayload) !== canonicalJson(request)) {
          throw new Error("operation_conflict");
        }
        return existing;
      }

      const sequence = this.nextSequenceSync();
      this.sql.exec(
        `INSERT INTO temp_vip_ops
          (operation_id, kind, user_id, user_login, payload_json, status, attempts, next_attempt_at,
           result_json, created_at, finished_at, enqueue_sequence)
         VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, NULL, ?, NULL, ?)`,
        operationId, kind, userId, userLogin, payloadJson, now, now, sequence,
      );
      if (kind === "release") {
        const queuedRemovals = this.sql.exec<TempVipOperationSql>(
          `SELECT * FROM temp_vip_ops WHERE user_id = ? AND status = 'queued'
             AND (kind IN ('end', 'expire')
               OR (kind IN ('grant', 'extend', 'import') AND needs_reconcile = 1))
             AND enqueue_sequence < ? ORDER BY enqueue_sequence`,
          userId,
          sequence,
        ).toArray();
        for (const removal of queuedRemovals) {
          this.finishSync(removal.operation_id, { status: "superseded" }, now);
        }
      }

      const prior = this.sql.exec<TempVipOperationSql>(
        "SELECT * FROM temp_vip_ops WHERE operation_id = ?",
        operationId,
      ).one();
      return prior;
    });
  }

  private pruneOperationsSync(now: string): void {
    const cutoff = utc(parseTime(now) - TEMP_VIP_OPERATION_RETENTION_MS);
    const pointsCutoff = utc(parseTime(now) - TEMP_VIP_CHANNEL_POINTS_RETENTION_MS);
    this.sql.exec(
      `DELETE FROM temp_vip_ops
        WHERE status = 'done' AND finished_at <= ?
          AND (finished_at <= ? OR NOT (kind = 'grant' AND json_extract(payload_json, '$.request.source') = 'channel_points'))`,
      cutoff, pointsCutoff,
    );
    this.sql.exec(
      `DELETE FROM temp_vip_lifecycle_watermarks
        WHERE retain_until <= ?
          AND NOT EXISTS (SELECT 1 FROM temp_vips WHERE temp_vips.user_id = temp_vip_lifecycle_watermarks.user_id)`,
      now,
    );
  }

  private updatePayloadSync(operation: TempVipOperationSql, payload: OperationPayload): void {
    this.sql.exec(
      "UPDATE temp_vip_ops SET payload_json = ? WHERE operation_id = ? AND status = 'running'",
      JSON.stringify(payload),
      operation.operation_id,
    );
  }

  private finishSync(operationId: string, result: TempVipStoredResult, now: string, attempts?: number): void {
    this.sql.exec(
      `UPDATE temp_vip_ops SET status = 'done', attempts = COALESCE(?, attempts), next_attempt_at = ?,
         result_json = ?, finished_at = ? WHERE operation_id = ?`,
      attempts ?? null,
      now,
      JSON.stringify(result),
      now,
      operationId,
    );
  }

  private finishCreationSync(
    operation: TempVipOperationSql,
    result: ModuleTempVipResult,
    now: string,
    attempts?: number,
  ): void {
    if (result.status === "granted" || result.status === "extended") {
      const removals = this.sql.exec<TempVipOperationSql>(
        `SELECT * FROM temp_vip_ops WHERE user_id = ? AND status = 'queued'
           AND kind IN ('end', 'expire') AND enqueue_sequence < ? ORDER BY enqueue_sequence`,
        operation.user_id,
        operation.enqueue_sequence,
      ).toArray();
      for (const removal of removals) this.finishSync(removal.operation_id, { status: "superseded" }, now);
    }
    this.finishSync(operation.operation_id, result, now, attempts);
  }

  private setNeedsReconcileSync(operationId: string, needsReconcile: boolean): void {
    this.sql.exec(
      "UPDATE temp_vip_ops SET needs_reconcile = ? WHERE operation_id = ? AND status = 'running'",
      needsReconcile ? 1 : 0,
      operationId,
    );
  }

  private hasLaterReleaseSync(operation: TempVipOperationSql): boolean {
    return this.sql.exec<{ present: number }>(
      `SELECT EXISTS(SELECT 1 FROM temp_vip_ops
        WHERE user_id = ? AND status = 'queued' AND kind = 'release'
          AND enqueue_sequence > ?) AS present`,
      operation.user_id,
      operation.enqueue_sequence,
    ).one().present === 1;
  }

  private shouldSupersedeForLaterReleaseSync(operation: TempVipOperationSql): boolean {
    const current = this.sql.exec<{ status: string; needs_reconcile: number }>(
      "SELECT status, needs_reconcile FROM temp_vip_ops WHERE operation_id = ?",
      operation.operation_id,
    ).toArray()[0];
    const needsReconcile = current?.status === "running"
      ? current.needs_reconcile === 1
      : operation.needs_reconcile === 1;
    const removal = operation.kind === "end" || operation.kind === "expire";
    const reconciliation = needsReconcile &&
      (operation.kind === "grant" || operation.kind === "extend" || operation.kind === "import");
    return (removal || reconciliation) && this.hasLaterReleaseSync(operation);
  }

  private requeueSync(
    operation: TempVipOperationSql,
    payload: OperationPayload,
    now: string,
    delayMs: number,
    attempts = operation.attempts,
  ): void {
    this.sql.exec(
      `UPDATE temp_vip_ops SET status = 'queued', attempts = ?, next_attempt_at = ?,
         payload_json = ?, result_json = NULL, finished_at = NULL WHERE operation_id = ?`,
      attempts,
      utc(parseTime(now) + delayMs),
      JSON.stringify(payload),
      operation.operation_id,
    );
  }

  private pendingResult(operationId: string): ModuleTempVipResult {
    const operation = this.sql.exec<TempVipOperationSql>(
      "SELECT status, next_attempt_at FROM temp_vip_ops WHERE operation_id = ?",
      operationId,
    ).toArray()[0];
    if (operation?.status === "done") {
      const full = this.sql.exec<TempVipOperationSql>(
        "SELECT result_json FROM temp_vip_ops WHERE operation_id = ?",
        operationId,
      ).one();
      if (full.result_json !== null) return JSON.parse(full.result_json) as ModuleTempVipResult;
    }
    return { status: "queued", ...(operation === undefined ? {} : { retryAt: operation.next_attempt_at }) };
  }

  private async waitForOperation(operationId: string): Promise<ModuleTempVipResult> {
    const runner = this.startRunner();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol("temp_vip_wait_timeout");
    const finished = await Promise.race([
      runner.then(() => "finished" as const),
      new Promise<typeof timedOut>((resolve) => {
        timeoutId = setTimeout(() => {
          resolve(timedOut);
        }, TEMP_VIP_CALLER_WAIT_MS);
      }),
    ]);
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (finished === timedOut) return this.pendingResult(operationId);
    return this.pendingResult(operationId);
  }

  private startRunner(): Promise<void> {
    const current = runnerByStorage.get(this.storage);
    if (current !== undefined) return current;
    const runner = Promise.resolve()
      .then(() => this.drainQueue())
      .catch((error: unknown) => {
        console.error("Temporary VIP queue runner stopped; its durable alarm will retry it.", error);
        return false;
      })
      .then(async (removalLimitReached) => {
        if (runnerByStorage.get(this.storage) !== runner) return;
        runnerByStorage.delete(this.storage);
        if (removalLimitReached) {
          await this.rearm();
          return;
        }
        if (this.hasDueQueueWork()) void this.startRunner();
      });
    runnerByStorage.set(this.storage, runner);
    return runner;
  }

  private hasDueQueueWork(): boolean {
    const now = this.now();
    return this.sql.exec<{ present: number }>(
      `SELECT EXISTS(
        SELECT 1 FROM temp_vip_ops AS candidate
         WHERE (candidate.status = 'running' OR (candidate.status = 'queued' AND candidate.next_attempt_at <= ?))
           AND ${userOrderAvailable}
      ) AS present`,
      now,
      now,
    ).one().present === 1;
  }

  private claimNext(): ClaimedOperation | null {
    const now = this.now();
    return this.transaction(() => {
      this.pruneOperationsSync(now);
      const operation = this.sql.exec<TempVipOperationSql>(
        `SELECT candidate.* FROM temp_vip_ops AS candidate
          WHERE (candidate.status = 'running' OR (candidate.status = 'queued' AND candidate.next_attempt_at <= ?))
            AND ${userOrderAvailable}
          ORDER BY CASE candidate.status WHEN 'running' THEN 0 ELSE 1 END, candidate.enqueue_sequence
          LIMIT 1`,
        now,
        now,
      ).toArray()[0];
      if (operation === undefined) return null;

      const interrupted = operation.status === "running";
      const needsReconcile = operation.needs_reconcile === 1 || interrupted;
      const attempts = interrupted ? Math.max(1, operation.attempts + 1) : operation.attempts;
      const payload = decodePayload(operation.payload_json);
      if (interrupted && operation.kind === "grant" && payload.mutationAttempted === true) {
        payload.mutationAmbiguous = true;
      }
      const row = rowFor(this.sql, operation.user_id);

      if (operation.kind === "grant" && payload.stage === "initial") {
        if (row !== null && row.removal_failed_at !== null) {
          payload.stage = "check_existing";
        } else if (row === null) {
          payload.stage = "post";
          payload.intentAt = now;
        }
      } else if (operation.kind === "extend" && payload.stage === "initial" && row?.removal_failed_at !== null) {
        payload.stage = "check_existing";
      }

      const storedPayload = payload.retryNow === true ? { ...payload, retryNow: false } : payload;
      this.sql.exec(
        `UPDATE temp_vip_ops SET status = 'running', attempts = ?, next_attempt_at = ?,
           payload_json = ?, result_json = NULL, finished_at = NULL,
           needs_reconcile = CASE WHEN status = 'running' THEN 1 ELSE needs_reconcile END
         WHERE operation_id = ?`,
        attempts,
        utc(parseTime(now) + TEMP_VIP_RECOVERY_MS),
        JSON.stringify(storedPayload),
        operation.operation_id,
      );
      return {
        operation: { ...operation, status: "running", attempts, next_attempt_at: utc(parseTime(now) + TEMP_VIP_RECOVERY_MS), payload_json: JSON.stringify(payload) },
        payload,
        needsReconcile,
      };
    });
  }

  private async drainQueue(): Promise<boolean> {
    let removalAttempts = 0;
    for (;;) {
      const claimed = this.claimNext();
      if (claimed === null) break;
      await this.rearm();
      try {
        await this.process(claimed, () => removalAttempts < TEMP_VIP_MAX_REMOVALS_PER_DRAIN, () => { removalAttempts += 1; });
      } catch (error: unknown) {
        const now = this.now();
        this.transaction(() => {
          const current = this.sql.exec<TempVipOperationSql>(
            "SELECT * FROM temp_vip_ops WHERE operation_id = ?",
            claimed.operation.operation_id,
          ).toArray()[0];
          if (current?.status === "running") {
            const payload = decodePayload(current.payload_json);
            if (current.kind === "grant" || current.kind === "extend" || current.kind === "import" ||
                current.kind === "end" || current.kind === "expire") {
              this.setNeedsReconcileSync(current.operation_id, true);
            }
            if (this.shouldSupersedeForLaterReleaseSync(current)) {
              this.finishSync(current.operation_id, { status: "superseded" }, now, current.attempts + 1);
            } else {
              if (current.kind === "grant" && payload.mutationAttempted === true) payload.mutationAmbiguous = true;
              this.requeueSync(current, payload, now, TEMP_VIP_RETRY_MS, current.attempts + 1);
            }
          }
        });
        console.warn("Temporary VIP operation will retry after an unexpected failure.", claimed.operation.operation_id, error);
      }
      await this.rearm();
      if (removalAttempts >= TEMP_VIP_MAX_REMOVALS_PER_DRAIN) {
        await this.rearm();
        return true;
      }
    }
    await this.rearm();
    return false;
  }

  private async process(
    claimed: ClaimedOperation,
    hasRemovalBudget: () => boolean,
    spendRemoval: () => void,
  ): Promise<void> {
    const operation = claimed.operation;
    const payload = claimed.payload;
    const now = this.now();
    let row = rowFor(this.sql, operation.user_id);

    if (operation.kind === "disable_module") {
      await this.processDisableModule(operation, payload);
      return;
    }

    const request = payload.request as { source?: string };
    if (operation.kind === "grant" && request.source === "channel_points" &&
        await this.processClosedChannelPointsGrant(operation, payload, row, claimed.needsReconcile)) return;

    if (isCreationOperation(operation.kind) && this.options.isModuleEnabled !== undefined &&
        !await this.options.isModuleEnabled()) {
      this.transaction(() => {
        this.finishSync(operation.operation_id, { status: "module_disabled" }, this.now(), operation.attempts);
      });
      return;
    }

    if (!await this.isManaged() &&
        (operation.kind === "grant" || operation.kind === "extend" || operation.kind === "import" ||
          operation.kind === "end" || operation.kind === "expire")) {
      const deferredAt = this.now();
      this.transaction(() => {
        const request = payload.request as { source?: string };
        if (operation.kind === "grant" && request.source === "channel_points") {
          const mutationAttempted = payload.mutationAttempted === true ||
            (payload.mutationAttempted === undefined &&
              (claimed.needsReconcile || operation.attempts > 0 && payload.stage === "post"));
          if (!mutationAttempted) {
            this.finishSync(operation.operation_id, { status: "rejected", reason: "scope_missing" }, deferredAt, operation.attempts);
          } else {
            this.setNeedsReconcileSync(operation.operation_id, true);
            this.requeueSync(operation, payload, deferredAt, TEMP_VIP_OBSERVE_DEFER_MS, operation.attempts);
          }
        } else if (this.hasLaterReleaseSync(operation)) {
          this.finishSync(operation.operation_id, { status: "superseded" }, deferredAt, operation.attempts);
        } else {
          this.setNeedsReconcileSync(operation.operation_id, true);
          this.requeueSync(operation, payload, deferredAt, TEMP_VIP_OBSERVE_DEFER_MS, operation.attempts);
        }
      });
      return;
    }

    let operationPayload = payload;
    let operationNeedsReconcile = claimed.needsReconcile;
    if ((operation.kind === "grant" || operation.kind === "extend") && row?.confirmation === "awaiting_vip") {
      const lookup = await this.safeGet(operation.user_id);
      const checkedAt = this.now();
      if (!lookup.ok) {
        this.requeueOperation(operation, payload, checkedAt, TEMP_VIP_RETRY_MS, operation.attempts + 1);
        return;
      }
      this.transaction(() => {
        this.advanceTwitchStateSync(operation.user_id, checkedAt, checkedAt);
        if (lookup.isVip) {
          this.sql.exec("UPDATE temp_vips SET confirmation = 'confirmed' WHERE user_id = ?", operation.user_id);
        } else {
          operationPayload = {
            ...payload,
            stage: "post",
            intentAt: payload.intentAt ?? checkedAt,
            precondition: "not_vip",
          };
          this.sql.exec("DELETE FROM temp_vips WHERE user_id = ?", operation.user_id);
          this.updatePayloadSync(operation, operationPayload);
          this.setNeedsReconcileSync(operation.operation_id, false);
        }
      });
      row = rowFor(this.sql, operation.user_id);
      operationNeedsReconcile = false;
    }

    if (operation.kind === "grant") {
      await this.processGrant(operation, operationPayload, row, operationNeedsReconcile);
      return;
    }
    if (operation.kind === "extend") {
      await this.processExtend(operation, operationPayload, row, operationNeedsReconcile);
      return;
    }
    if (operation.kind === "import") {
      await this.processImport(operation, payload, row);
      return;
    }
    if (operation.kind === "verify_removed") {
      await this.processVerification(operation, payload, row);
      return;
    }
    if (operation.kind === "record_intent" || operation.kind === "add_observed" ||
        operation.kind === "classify" || operation.kind === "moderation") {
      if (operation.kind === "moderation") {
        const moderation = payload.request as unknown as ModuleTempVipModerationEvent;
        if (moderation.action === "unvip") {
          await this.processVerification(operation, {
            ...payload,
            request: {
              triggerId: `moderation:${moderation.triggerId}`,
              userId: moderation.person.userId,
              eventSubTimestamp: moderation.eventSubTimestamp,
            },
          }, row);
          return;
        }
      }
      this.processObserverOperation(operation, payload);
      return;
    }
    if (operation.kind === "release") {
      this.transaction(() => {
        const current = rowFor(this.sql, operation.user_id);
        if (current === null) {
          this.finishSync(operation.operation_id, { status: "not_managed" }, now, operation.attempts);
          return;
        }
        this.sql.exec("DELETE FROM temp_vips WHERE user_id = ?", operation.user_id);
        const result: ModuleTempVipResult = { status: "released" };
        enqueueEventSync(this.sql, this.options.channelId, operation.operation_id, 0, now, null,
          "temp_vips.released", { userId: current.user_id, login: current.user_login });
        this.finishSync(operation.operation_id, result, now, operation.attempts);
      });
      return;
    }

    const isManualEnd = operation.kind === "end";
    const current = row;
    if (current !== null) {
      const refusal = rowActionRefusal(current);
      if (refusal !== null) {
        this.transaction(() => {
          this.finishSync(operation.operation_id, { status: refusal }, now, operation.attempts);
        });
        return;
      }
    }
    if (current === null) {
      if (claimed.needsReconcile) {
        const lookup = await this.safeGet(operation.user_id);
        const checkedAt = this.now();
        if (!lookup.ok) {
          this.requeueOperation(operation, payload, checkedAt, TEMP_VIP_RETRY_MS, operation.attempts + 1);
          return;
        }
        this.transaction(() => {
          if (!lookup.isVip) this.advanceTwitchStateSync(operation.user_id, checkedAt, checkedAt);
          this.finishSync(operation.operation_id,
            lookup.isVip ? { status: "not_managed" } : { status: "ended", reason: isManualEnd ? "ended_early" : "expired" },
            checkedAt,
            operation.attempts + 1);
        });
        return;
      }
      this.transaction(() => {
        this.finishSync(operation.operation_id, { status: "not_managed" }, now, operation.attempts);
      });
      return;
    }
    if (claimed.needsReconcile) {
      const lookup = await this.safeGet(operation.user_id);
      const checkedAt = this.now();
      if (!lookup.ok) {
        this.requeueOperation(operation, payload, checkedAt, TEMP_VIP_RETRY_MS, operation.attempts + 1);
        return;
      }
      if (!lookup.isVip) {
        this.advanceTwitchStateSync(operation.user_id, checkedAt, checkedAt);
        this.finishRemovalAsAbsent(operation, current, isManualEnd, checkedAt);
        return;
      }
      this.transaction(() => {
        this.advanceTwitchStateSync(operation.user_id, checkedAt, checkedAt);
        this.setNeedsReconcileSync(operation.operation_id, false);
      });
    }
    const retryingFailedRemoval = payload.retryNow === true && current.removal_failed_at !== null;
    if (operation.kind === "expire" && !retryingFailedRemoval && !this.isDue(current, this.now())) {
      const checkedAt = this.now();
      this.transaction(() => {
        this.finishSync(operation.operation_id, { status: "ignored" }, checkedAt, operation.attempts);
      });
      return;
    }
    const removed = await this.safeRemove(operation.user_id, operation, payload, hasRemovalBudget, spendRemoval);
    if (!removed.ok && removed.reason === "precondition_failed") return;
    const completedAt = this.now();
    this.transaction(() => {
      const latest = rowFor(this.sql, operation.user_id);
      if (latest === null) {
        this.finishSync(operation.operation_id, { status: "ended", reason: isManualEnd ? "ended_early" : "expired" }, completedAt,
          operation.attempts + 1);
        return;
      }
      if (removed.ok || removed.reason === "not_vip") {
        const reason: TempVipEndReason = isManualEnd ? "ended_early" : latest.end_reason ?? "expired";
        this.advanceTwitchStateSync(operation.user_id, completedAt, completedAt);
        this.sql.exec("DELETE FROM temp_vips WHERE user_id = ?", operation.user_id);
        const result: ModuleTempVipResult = { status: "ended", reason };
        enqueueEventSync(this.sql, this.options.channelId, operation.operation_id, 0, completedAt,
          latest.granted_by_user_id, "temp_vips.ended", {
            userId: latest.user_id,
            login: latest.user_login,
            reason,
          });
        this.finishSync(operation.operation_id, result, completedAt, operation.attempts + 1);
        return;
      }

      if (this.hasLaterReleaseSync(operation)) {
        this.finishSync(operation.operation_id, { status: "superseded" }, completedAt, operation.attempts + 1);
        return;
      }

      const removalAttempts = latest.removal_attempts + 1;
      const retryAt = utc(parseTime(completedAt) + backoffDelay(removalAttempts));
      this.sql.exec(
        `UPDATE temp_vips SET removal_failed_at = ?, removal_attempts = ?, removal_error = ?,
           end_reason = CASE WHEN ? = 1 THEN 'ended_early' ELSE end_reason END
         WHERE user_id = ?`,
        completedAt,
        removalAttempts,
        removed.reason.slice(0, 200),
        isManualEnd ? 1 : 0,
        operation.user_id,
      );
      enqueueEventSync(this.sql, this.options.channelId, operation.operation_id, `removal_failed:${String(removalAttempts)}`,
        completedAt, latest.granted_by_user_id, "temp_vips.removal_failed", {
          userId: latest.user_id,
          login: latest.user_login,
          reason: removed.reason,
          attempts: removalAttempts,
          retryAt,
        });
      const latestOperation = this.sql.exec<TempVipOperationSql>(
        "SELECT * FROM temp_vip_ops WHERE operation_id = ?", operation.operation_id,
      ).one();
      this.requeueSync(latestOperation, decodePayload(latestOperation.payload_json), completedAt,
        parseTime(retryAt) - parseTime(completedAt), operation.attempts + 1);
    });
  }

  private processObserverOperation(operation: TempVipOperationSql, payload: OperationPayload): void {
    const now = this.now();
    this.transaction(() => {
      if (operation.kind === "record_intent") {
        const request = payload.request as unknown as ModuleTempVipIntentRequest;
        const existing = rowFor(this.sql, request.person.userId);
        const intentAt = request.intentAt ?? now;
        const durationMs = request.durationMs ?? parseTime(request.expiresAt) - parseTime(intentAt);
        if (existing !== null) {
          const refusal = rowActionRefusal(existing);
          if (refusal !== null) {
            this.finishSync(operation.operation_id, { status: refusal, row: publicRow(existing) }, now, operation.attempts);
            return;
          }
        }
        const expiresAt = existing === null
          ? request.expiresAt
          : utc(Math.max(parseTime(now), existing.expires_at === null ? parseTime(now) : parseTime(existing.expires_at)) + durationMs);
        const maximumRemainingMs = request.maximumRemainingMs;
        const remainingMs = parseTime(expiresAt) - parseTime(now);
        if (maximumRemainingMs !== undefined && remainingMs > maximumRemainingMs) {
          const currentRemainingMs = existing?.expires_at === null || existing?.expires_at === undefined
            ? 0 : Math.max(0, parseTime(existing.expires_at) - parseTime(now));
          this.finishSync(operation.operation_id, {
            status: "maximum_exceeded",
            allowedDurationMs: Math.max(0, maximumRemainingMs - currentRemainingMs),
          }, now, operation.attempts);
          return;
        }
        if (existing === null) {
          this.sql.exec(
            `INSERT INTO temp_vips
              (user_id, user_login, user_display_name, expires_at, granted_at, twitch_state_at, local_edit_at,
               granted_by_user_id, granted_by_login, source, removal_failed_at, removal_attempts,
               removal_error, end_reason, classification, confirmation, expiry_reminder_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'command', NULL, 0, NULL, NULL, 'temporary', 'awaiting_vip', NULL)`,
            request.person.userId, request.person.login, request.person.displayName, expiresAt, intentAt,
            this.latestTwitchStateAtSync(request.person.userId), now,
            request.grantedBy?.userId ?? null, request.grantedBy?.login ?? null,
          );
        } else {
          this.sql.exec(
            `UPDATE temp_vips SET user_login = ?, user_display_name = ?, expires_at = ?, local_edit_at = ?,
               granted_by_user_id = ?, granted_by_login = ?, source = 'command', removal_failed_at = NULL,
               removal_attempts = 0, removal_error = NULL, end_reason = NULL, expiry_reminder_at = NULL
             WHERE user_id = ?`,
            request.person.login, request.person.displayName, expiresAt, now,
            request.grantedBy?.userId ?? existing.granted_by_user_id,
            request.grantedBy?.login ?? existing.granted_by_login,
            request.person.userId,
          );
          if (existing.confirmation === "confirmed") enqueueEventSync(this.sql, this.options.channelId,
            operation.operation_id, 0, now, request.grantedBy?.userId ?? null, "temp_vips.extended", {
              userId: existing.user_id, login: request.person.login, expiresAt,
            });
        }
        const row = rowFor(this.sql, request.person.userId);
        const status = existing?.confirmation === "confirmed" ? "extended" : "intent_recorded";
        this.finishSync(operation.operation_id, { status, ...(row === null ? {} : { row: publicRow(row) }), expiresAt }, now, operation.attempts);
        return;
      }

      if (operation.kind === "add_observed") {
        const request = payload.request as unknown as ModuleTempVipObservedAddRequest;
        const existing = rowFor(this.sql, request.person.userId);
        if (existing !== null) {
          this.finishSync(operation.operation_id, { status: "already_tracked", row: publicRow(existing) }, now, operation.attempts);
          return;
        }
        this.insertObservedPersonSync(request.person, now, request.actor.userId, now);
        const row = rowFor(this.sql, request.person.userId);
        this.finishSync(operation.operation_id, { status: "observed_added", ...(row === null ? {} : { row: publicRow(row) }) }, now, operation.attempts);
        return;
      }

      if (operation.kind === "classify") {
        const request = payload.request as unknown as ModuleTempVipClassifyRequest;
        const existing = rowFor(this.sql, request.userId);
        if (existing === null) {
          this.finishSync(operation.operation_id, { status: "not_tracked" }, now, operation.attempts);
          return;
        }
        this.sql.exec(
          `UPDATE temp_vips SET classification = ?, confirmation = 'confirmed', expires_at = ?,
             local_edit_at = ?, source = 'dashboard', removal_failed_at = NULL, removal_attempts = 0, removal_error = NULL,
             end_reason = NULL, expiry_reminder_at = NULL WHERE user_id = ?`,
          request.classification,
          request.classification === "permanent" ? null : request.expiresAt === null && request.durationMs !== undefined
            ? utc(parseTime(operation.created_at) + request.durationMs) : request.expiresAt,
          now,
          request.userId,
        );
        const row = rowFor(this.sql, request.userId);
        if (row !== null) enqueueEventSync(this.sql, this.options.channelId, operation.operation_id, 0, now,
          request.actor.userId, "temp_vips.classified", {
            userId: row.user_id,
            login: row.user_login,
            classification: request.classification,
            expiresAt: request.classification === "temporary" ? row.expires_at : null,
          });
        this.finishSync(operation.operation_id, { status: "classified", ...(row === null ? {} : { row: publicRow(row) }) }, now, operation.attempts);
        return;
      }

      const request = payload.request as unknown as ModuleTempVipModerationEvent;
      if (request.action === "vip") {
        const existing = rowFor(this.sql, request.person.userId);
        if (parseTime(request.eventSubTimestamp) < parseTime(this.latestTwitchStateAtSync(request.person.userId))) {
          this.finishSync(operation.operation_id, {
            status: "ignored_stale_event", ...(existing === null ? {} : { row: publicRow(existing) }),
          }, now, operation.attempts);
          return;
        }
        const twitchStateAt = this.advanceTwitchStateSync(request.person.userId, request.eventSubTimestamp, now);
        const confirmsIntent = existing?.confirmation === "awaiting_vip" &&
          parseTime(request.eventSubTimestamp) >= parseTime(existing.granted_at);
        if (existing === null) this.insertObservedPersonSync(request.person, request.eventSubTimestamp, null);
        else this.sql.exec(
          `UPDATE temp_vips SET user_login = ?, user_display_name = ?, twitch_state_at = ?,
             confirmation = CASE WHEN confirmation = 'awaiting_vip' AND ? = 1 THEN 'confirmed' ELSE confirmation END,
             expiry_reminder_at = NULL WHERE user_id = ?`,
          request.person.login, request.person.displayName, twitchStateAt, confirmsIntent ? 1 : 0, request.person.userId,
        );
        const row = rowFor(this.sql, request.person.userId);
        this.finishSync(operation.operation_id, {
          status: confirmsIntent ? "intent_confirmed" : existing === null ? "observed" : "already_tracked",
          ...(row === null ? {} : { row: publicRow(row) }),
        }, now, operation.attempts);
        return;
      }

      this.finishSync(operation.operation_id, { status: "ignored_legacy_moderation" }, now, operation.attempts);
    });
  }

  private insertObservedPersonSync(
    person: ModuleTempVipPerson,
    createdAt: string,
    actorUserId: string | null,
    localEditAt = "1970-01-01T00:00:00.000Z",
  ): void {
    this.sql.exec(
      `INSERT INTO temp_vips
        (user_id, user_login, user_display_name, expires_at, granted_at, twitch_state_at, local_edit_at, granted_by_user_id,
         granted_by_login, source, removal_failed_at, removal_attempts, removal_error, end_reason,
         classification, confirmation, expiry_reminder_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, NULL, 'observed', NULL, 0, NULL, NULL, 'unclassified', 'confirmed', NULL)`,
      person.userId, person.login, person.displayName, createdAt,
      this.latestTwitchStateAtSync(person.userId), localEditAt, actorUserId,
    );
  }

  private attachObserveVipToPendingIntentSync(
    moderationOperation: TempVipOperationSql,
    event: ModuleTempVipModerationEvent,
  ): void {
    const pending = this.sql.exec<TempVipOperationSql>(
      `SELECT * FROM temp_vip_ops
        WHERE user_id = ? AND status != 'done' AND kind IN ('grant', 'extend')
          AND enqueue_sequence < ?
        ORDER BY enqueue_sequence LIMIT 1`,
      event.person.userId,
      moderationOperation.enqueue_sequence,
    ).toArray()[0];
    if (pending === undefined) return;
    const payload = decodePayload(pending.payload_json);
    const intentAt = payload.intentAt;
    if (payload.stage !== "post" || intentAt === undefined || intentAt === null ||
        pending.attempts === 0 && pending.needs_reconcile !== 1 ||
        parseTime(event.eventSubTimestamp) < parseTime(intentAt)) return;

    const existing = rowFor(this.sql, event.person.userId);
    if (existing !== null &&
        (rowActionRefusal(existing) !== null || existing.classification !== "temporary" || existing.confirmation !== "awaiting_vip")) return;
    if (parseTime(event.eventSubTimestamp) < parseTime(this.latestTwitchStateAtSync(event.person.userId))) return;

    const now = this.now();
    const result = this.transaction(() => {
      const request = payload.request as unknown as ModuleTempVipGrantRequest | ModuleTempVipExtendRequest;
      const grantRequest: Omit<ModuleTempVipGrantRequest, "operationId"> = {
        person: request.person,
        grantedBy: request.grantedBy ?? null,
        durationMs: request.durationMs,
        maximumRemainingMs: request.maximumRemainingMs,
        source: request.source ?? "dashboard",
      };
      const current = rowFor(this.sql, event.person.userId);
      const created = current === null
        ? this.createGrantSync(pending, grantRequest, intentAt, now)
        : this.extendRowSync(current, request.person, request.grantedBy ?? null, request.durationMs,
          request.maximumRemainingMs, request.source ?? "dashboard", pending.operation_id, now);
      this.advanceTwitchStateSync(event.person.userId, event.eventSubTimestamp, now);
      this.finishCreationSync(pending, created, now, pending.attempts + 1);
      return created;
    });
    if (result.status !== "granted" && result.status !== "extended") return;
  }

  private async processDisableModule(
    operation: TempVipOperationSql,
    payload: OperationPayload,
  ): Promise<void> {
    const now = this.now();
    const occupied = this.sql.exec<{ present: number }>(
      `SELECT EXISTS(SELECT 1 FROM temp_vips)
         OR EXISTS(SELECT 1 FROM temp_vip_ops
           WHERE status != 'done' AND kind IN ('grant', 'extend', 'import')
             AND operation_id != ?) AS present`,
      operation.operation_id,
    ).one().present === 1;
    if (occupied) {
      this.transaction(() => {
        this.finishSync(operation.operation_id, { status: "temp_vips_active" }, now, operation.attempts);
      });
      return;
    }

    const commitModuleDisable = this.options.commitModuleDisable;
    if (commitModuleDisable === undefined) {
      this.transaction(() => {
        this.finishSync(operation.operation_id, { status: "module_changed_concurrently" }, now, operation.attempts);
      });
      return;
    }

    const request = payload.request as unknown as Omit<TempVipModuleDisableRequest, "operationId">;
    const committed = await commitModuleDisable({ ...request, changedAt: this.now() });
    const completedAt = this.now();
    this.transaction(() => {
      const current = this.sql.exec<TempVipOperationSql>(
        "SELECT status FROM temp_vip_ops WHERE operation_id = ?",
        operation.operation_id,
      ).toArray()[0];
      if (current?.status !== "running") return;
      this.finishSync(operation.operation_id, committed === null
        ? { status: "module_changed_concurrently" }
        : {
          status: "disabled",
          revision: committed.revision,
          lastDisabledRevision: committed.lastDisabledRevision,
        }, completedAt, operation.attempts);
    });
  }

  private finishRemovalAsAbsent(
    operation: TempVipOperationSql,
    row: TempVipRowSql,
    isManualEnd: boolean,
    now: string,
  ): void {
    this.transaction(() => {
      this.advanceTwitchStateSync(operation.user_id, now, now);
      const latest = rowFor(this.sql, operation.user_id);
      if (latest === null) {
        this.finishSync(operation.operation_id, {
          status: "ended", reason: isManualEnd ? "ended_early" : row.end_reason ?? "expired",
        }, now, operation.attempts + 1);
        return;
      }
      const reason: TempVipEndReason = isManualEnd ? "ended_early" : latest.end_reason ?? "expired";
      this.sql.exec("DELETE FROM temp_vips WHERE user_id = ?", operation.user_id);
      enqueueEventSync(this.sql, this.options.channelId, operation.operation_id, 0, now,
        latest.granted_by_user_id, "temp_vips.ended", {
          userId: latest.user_id,
          login: latest.user_login,
          reason,
        });
      this.finishSync(operation.operation_id, { status: "ended", reason }, now, operation.attempts + 1);
    });
  }

  private async processGrant(
    operation: TempVipOperationSql,
    payload: OperationPayload,
    row: TempVipRowSql | null,
    needsReconcile: boolean,
  ): Promise<void> {
    const request = payload.request as unknown as Omit<ModuleTempVipGrantRequest, "operationId">;
    const now = this.now();
    if (row !== null) {
      const refusal = rowActionRefusal(row);
      if (refusal !== null) {
        this.transaction(() => {
          this.finishSync(operation.operation_id, { status: refusal }, now, operation.attempts);
        });
        return;
      }
    }
    if (row !== null && row.removal_failed_at === null) {
      this.transaction(() => {
        const result = this.extendRowSync(row, request.person, request.grantedBy, request.durationMs,
          request.maximumRemainingMs, request.source, operation.operation_id, now);
        this.finishCreationSync(operation, result, now, operation.attempts);
      });
      return;
    }
    if (request.durationMs > request.maximumRemainingMs) {
      this.transaction(() => {
        this.finishSync(operation.operation_id, {
          status: "maximum_exceeded",
          allowedDurationMs: request.maximumRemainingMs,
        }, now, operation.attempts);
      });
      return;
    }

    let nextPayload = payload;
    const retryAfterPost = needsReconcile || (operation.attempts > 0 && payload.stage === "post");
    const checkingFailedRemoval = row !== null && row.removal_failed_at !== null &&
      (needsReconcile || payload.stage === "check_existing");
    if (checkingFailedRemoval) {
      const lookup = await this.safeGet(request.person.userId);
      const checkedAt = this.now();
      if (!lookup.ok) {
        this.requeueOperation(operation, payload, checkedAt, TEMP_VIP_RETRY_MS, operation.attempts + 1);
        return;
      }
      if (lookup.isVip) {
        this.transaction(() => {
          this.advanceTwitchStateSync(operation.user_id, checkedAt, checkedAt);
          const current = rowFor(this.sql, operation.user_id);
          const result = current === null
            ? { status: "already_vip" }
            : this.extendRowSync(current, request.person, request.grantedBy, request.durationMs,
              request.maximumRemainingMs, request.source, operation.operation_id, checkedAt, true);
          this.finishCreationSync(operation, result, checkedAt, operation.attempts + 1);
        });
        return;
      }
      nextPayload = {
        ...payload,
        stage: "post",
        intentAt: payload.intentAt ?? checkedAt,
        precondition: "not_vip",
      };
      this.transaction(() => {
        this.advanceTwitchStateSync(operation.user_id, checkedAt, checkedAt);
        this.sql.exec("DELETE FROM temp_vips WHERE user_id = ?", row.user_id);
        this.updatePayloadSync(operation, nextPayload);
        this.setNeedsReconcileSync(operation.operation_id, false);
      });
    } else if (row === null && retryAfterPost && payload.precondition === "not_vip") {
      const lookup = await this.safeGet(request.person.userId);
      const checkedAt = this.now();
      if (!lookup.ok) {
        this.requeueOperation(operation, payload, checkedAt, TEMP_VIP_RETRY_MS, operation.attempts + 1);
        return;
      }
      if (lookup.isVip) {
        this.transaction(() => {
          const result = this.createGrantSync(operation, request, payload.intentAt ?? checkedAt, checkedAt);
          this.finishCreationSync(operation, result, checkedAt, operation.attempts + 1);
        });
        return;
      }
      nextPayload = { ...payload };
      this.transaction(() => {
        this.updatePayloadSync(operation, nextPayload);
        this.setNeedsReconcileSync(operation.operation_id, false);
      });
    } else if (row === null && payload.precondition !== "not_vip") {
      const lookup = await this.safeGet(request.person.userId);
      const checkedAt = this.now();
      if (!lookup.ok) {
        this.requeueOperation(operation, payload, checkedAt, TEMP_VIP_RETRY_MS, operation.attempts + 1);
        return;
      }
      if (lookup.isVip) {
        this.transaction(() => {
          this.finishSync(operation.operation_id, { status: "already_vip" }, checkedAt, operation.attempts + 1);
        });
        return;
      }
      nextPayload = {
        ...payload,
        stage: "post",
        intentAt: payload.intentAt ?? checkedAt,
        precondition: "not_vip",
      };
      this.transaction(() => {
        this.updatePayloadSync(operation, nextPayload);
        this.setNeedsReconcileSync(operation.operation_id, false);
      });
    }

    const added = await this.safeAdd(request.person.userId, operation, nextPayload);
    const completedAt = this.now();
    if (added.ok) {
      this.transaction(() => {
        const result = this.createGrantSync(operation, request, nextPayload.intentAt ?? completedAt, completedAt);
        this.finishCreationSync(operation, result, completedAt, operation.attempts + 1);
      });
      return;
    }
    if (added.reason === "precondition_failed") return;
    const mutationAmbiguous = added.ambiguous === true || added.reason === "network" || added.reason === "unknown_status";
    if (mutationAmbiguous || added.reason === "rate_limited") {
      nextPayload = { ...nextPayload, mutationAmbiguous };
      this.requeueOperation(operation, nextPayload, completedAt, TEMP_VIP_RETRY_MS,
        operation.attempts + 1, mutationAmbiguous);
      return;
    }
    const result: ModuleTempVipResult = added.reason === "already_vip"
      ? { status: "already_vip" }
      : { status: "rejected", reason: added.reason };
    this.transaction(() => {
      this.finishSync(operation.operation_id, result, completedAt, operation.attempts + 1);
    });
  }

  private async processExtend(
    operation: TempVipOperationSql,
    payload: OperationPayload,
    row: TempVipRowSql | null,
    needsReconcile: boolean,
  ): Promise<void> {
    const request = payload.request as unknown as Omit<ModuleTempVipExtendRequest, "operationId">;
    const now = this.now();
    if (row !== null) {
      const refusal = rowActionRefusal(row);
      if (refusal !== null) {
        this.transaction(() => {
          this.finishSync(operation.operation_id, { status: refusal }, now, operation.attempts);
        });
        return;
      }
    }
    if (request.durationMs > request.maximumRemainingMs) {
      this.transaction(() => {
        this.finishSync(operation.operation_id, {
          status: "maximum_exceeded", allowedDurationMs: request.maximumRemainingMs,
        }, now, operation.attempts);
      });
      return;
    }
    const mayRegrant = payload.stage === "post_checked" || payload.stage === "post";
    if (row === null && !mayRegrant) {
      this.transaction(() => {
        this.finishSync(operation.operation_id, { status: "not_managed" }, now, operation.attempts);
      });
      return;
    }
    if (row !== null && row.removal_failed_at === null) {
      this.transaction(() => {
        const result = this.extendRowSync(row, request.person, request.grantedBy ?? null, request.durationMs,
          request.maximumRemainingMs, request.source ?? "dashboard", operation.operation_id, now);
        this.finishCreationSync(operation, result, now, operation.attempts);
      });
      return;
    }

    let nextPayload = payload;
    const retryAfterPost = needsReconcile || (operation.attempts > 0 && payload.stage === "post");
    const checkingFailedRemoval = row !== null && row.removal_failed_at !== null &&
      (needsReconcile || payload.stage === "check_existing");
    if (checkingFailedRemoval) {
      const lookup = await this.safeGet(request.person.userId);
      const checkedAt = this.now();
      if (!lookup.ok) {
        this.requeueOperation(operation, payload, checkedAt, TEMP_VIP_RETRY_MS, operation.attempts + 1);
        return;
      }
      if (lookup.isVip) {
        this.transaction(() => {
          this.advanceTwitchStateSync(operation.user_id, checkedAt, checkedAt);
          const current = rowFor(this.sql, operation.user_id);
          const result = current === null
            ? { status: "already_vip" }
            : this.extendRowSync(current, request.person, request.grantedBy ?? null, request.durationMs,
              request.maximumRemainingMs, request.source ?? "dashboard", operation.operation_id, checkedAt, true);
          this.finishCreationSync(operation, result, checkedAt, operation.attempts + 1);
        });
        return;
      }
      nextPayload = {
        ...payload,
        stage: "post",
        intentAt: payload.intentAt ?? checkedAt,
        precondition: "not_vip",
      };
      this.transaction(() => {
        this.advanceTwitchStateSync(operation.user_id, checkedAt, checkedAt);
        this.sql.exec("DELETE FROM temp_vips WHERE user_id = ?", row.user_id);
        this.updatePayloadSync(operation, nextPayload);
        this.setNeedsReconcileSync(operation.operation_id, false);
      });
    } else if (row === null && retryAfterPost && payload.precondition === "not_vip") {
      const lookup = await this.safeGet(request.person.userId);
      const checkedAt = this.now();
      if (!lookup.ok) {
        this.requeueOperation(operation, payload, checkedAt, TEMP_VIP_RETRY_MS, operation.attempts + 1);
        return;
      }
      if (lookup.isVip) {
        const grantRequest = {
          person: request.person,
          grantedBy: request.grantedBy ?? null,
          durationMs: request.durationMs,
          maximumRemainingMs: request.maximumRemainingMs,
          source: request.source ?? "dashboard",
        };
        this.transaction(() => {
          const result = this.createGrantSync(operation, grantRequest, payload.intentAt ?? checkedAt, checkedAt);
          this.finishCreationSync(operation, result, checkedAt, operation.attempts + 1);
        });
        return;
      }
      this.transaction(() => {
        this.setNeedsReconcileSync(operation.operation_id, false);
      });
    } else if (row === null && payload.precondition !== "not_vip") {
      const lookup = await this.safeGet(request.person.userId);
      const checkedAt = this.now();
      if (!lookup.ok) {
        this.requeueOperation(operation, payload, checkedAt, TEMP_VIP_RETRY_MS, operation.attempts + 1);
        return;
      }
      if (lookup.isVip) {
        this.transaction(() => {
          this.finishSync(operation.operation_id, { status: "already_vip" }, checkedAt, operation.attempts + 1);
        });
        return;
      }
      nextPayload = {
        ...payload,
        stage: "post",
        intentAt: payload.intentAt ?? checkedAt,
        precondition: "not_vip",
      };
      this.transaction(() => {
        this.updatePayloadSync(operation, nextPayload);
        this.setNeedsReconcileSync(operation.operation_id, false);
      });
    }

    const added = await this.safeAdd(request.person.userId, operation, nextPayload);
    const completedAt = this.now();
    if (added.ok) {
      const grantRequest = {
        person: request.person,
        grantedBy: request.grantedBy ?? null,
        durationMs: request.durationMs,
        maximumRemainingMs: request.maximumRemainingMs,
        source: request.source ?? "dashboard",
      };
      this.transaction(() => {
        const current = rowFor(this.sql, operation.user_id);
        const result = current === null
          ? this.createGrantSync(operation, grantRequest, payload.intentAt ?? completedAt, completedAt)
          : this.extendRowSync(current, request.person, request.grantedBy ?? null, request.durationMs,
            request.maximumRemainingMs, request.source ?? "dashboard", operation.operation_id, completedAt, true);
        this.finishCreationSync(operation, result, completedAt, operation.attempts + 1);
      });
      return;
    }
    if (added.reason === "precondition_failed") return;
    if (added.ambiguous === true || added.reason === "network" || added.reason === "rate_limited" || added.reason === "unknown_status") {
      this.requeueOperation(operation, { ...nextPayload, stage: "post" }, completedAt, TEMP_VIP_RETRY_MS,
        operation.attempts + 1, true);
      return;
    }
    this.transaction(() => {
      this.finishSync(operation.operation_id, {
        status: added.reason === "already_vip" ? "already_vip" : "rejected",
        ...(added.reason === "already_vip" ? {} : { reason: added.reason }),
      }, completedAt, operation.attempts + 1);
    });
  }

  private async processImport(
    operation: TempVipOperationSql,
    payload: OperationPayload,
    row: TempVipRowSql | null,
  ): Promise<void> {
    const request = payload.request as unknown as Omit<ModuleTempVipImportRequest, "operationId">;
    const now = this.now();
    if (request.expiresAt === undefined && request.durationMs > request.maximumRemainingMs) {
      this.transaction(() => {
        this.finishSync(operation.operation_id, {
          status: "maximum_exceeded", allowedDurationMs: request.maximumRemainingMs,
        }, now, operation.attempts);
      });
      return;
    }
    if (request.expiresAt !== undefined && parseTime(request.expiresAt) <= parseTime(now)) {
      this.transaction(() => {
        this.finishSync(operation.operation_id, { status: "rejected", reason: "expiry_elapsed" }, now, operation.attempts);
      });
      return;
    }
    if (row !== null) {
      this.transaction(() => {
        this.finishSync(operation.operation_id, { status: "already_managed", row: publicRow(row) }, now, operation.attempts);
      });
      return;
    }
    const lookup = await this.safeGet(request.person.userId);
    const completedAt = this.now();
    if (!lookup.ok) {
      this.transaction(() => {
        this.finishSync(operation.operation_id, {
          status: "twitch_unavailable", reason: lookup.reason,
        }, completedAt, operation.attempts + 1);
      });
      return;
    }
    if (!lookup.isVip) {
      this.transaction(() => {
        this.finishSync(operation.operation_id, { status: "not_vip" }, completedAt, operation.attempts + 1);
      });
      return;
    }
    this.transaction(() => {
      const result = this.createImportedSync(operation, request, completedAt);
      this.finishSync(operation.operation_id, result, completedAt, operation.attempts + 1);
    });
  }

  private async processVerification(
    operation: TempVipOperationSql,
    payload: OperationPayload,
    row: TempVipRowSql | null,
  ): Promise<void> {
    const request = payload.request as unknown as ModuleTempVipRemovedEvent;
    const now = this.now();
    if (parseTime(request.eventSubTimestamp) < parseTime(this.latestTwitchStateAtSync(request.userId))) {
      this.transaction(() => {
        const current = rowFor(this.sql, operation.user_id);
        this.finishSync(operation.operation_id, {
          status: "ignored_stale_echo", ...(current === null ? {} : { row: publicRow(current) }),
        }, now, operation.attempts);
      });
      return;
    }
    if (row === null) {
      this.transaction(() => {
        this.advanceTwitchStateSync(request.userId, request.eventSubTimestamp, now);
        this.finishSync(operation.operation_id, { status: "ignored" }, now, operation.attempts);
      });
      return;
    }
    if (!await this.isManaged()) {
      const removedAt = this.now();
      this.transaction(() => {
        this.advanceTwitchStateSync(request.userId, request.eventSubTimestamp, removedAt);
        const current = rowFor(this.sql, operation.user_id);
        if (current !== null) {
          this.sql.exec("DELETE FROM temp_vips WHERE user_id = ?", operation.user_id);
          enqueueEventSync(this.sql, this.options.channelId, operation.operation_id, 0, removedAt, null,
            "temp_vips.ended", { userId: current.user_id, login: current.user_login, reason: "removed_on_twitch" });
        }
        this.finishSync(operation.operation_id, { status: current === null ? "ignored" : "removed_on_twitch" }, removedAt, operation.attempts);
      });
      return;
    }
    const lookup = await this.safeGet(request.userId);
    const completedAt = this.now();
    if (!lookup.ok) {
      this.requeueOperation(operation, payload, completedAt, TEMP_VIP_RETRY_MS, operation.attempts + 1);
      return;
    }
    this.transaction(() => {
      const current = rowFor(this.sql, operation.user_id);
      if (current === null) {
        this.advanceTwitchStateSync(request.userId, request.eventSubTimestamp, completedAt);
        this.finishSync(operation.operation_id, { status: "ignored" }, completedAt, operation.attempts + 1);
        return;
      }
      if (lookup.isVip) {
        this.advanceTwitchStateSync(request.userId, request.eventSubTimestamp, completedAt);
        this.finishSync(operation.operation_id, { status: "ignored_stale_event" }, completedAt, operation.attempts + 1);
        return;
      }
      this.advanceTwitchStateSync(request.userId, request.eventSubTimestamp, completedAt);
      this.sql.exec("DELETE FROM temp_vips WHERE user_id = ?", current.user_id);
      enqueueEventSync(this.sql, this.options.channelId, operation.operation_id, 0, completedAt, null,
        "temp_vips.ended", { userId: current.user_id, login: current.user_login, reason: "removed_on_twitch" });
      this.finishSync(operation.operation_id, { status: "removed_on_twitch" }, completedAt, operation.attempts + 1);
    });
  }

  private createGrantSync(
    operation: TempVipOperationSql,
    request: Omit<ModuleTempVipGrantRequest, "operationId">,
    intendedAt: string,
    completedAt: string,
  ): ModuleTempVipResult {
    const expiresAt = utc(parseTime(intendedAt) + request.durationMs);
    this.insertRowSync(request.person, request.grantedBy, request.source, intendedAt, expiresAt, completedAt, completedAt);
    const row = rowFor(this.sql, request.person.userId);
    const result: ModuleTempVipResult = { status: "granted", expiresAt, ...(row === null ? {} : { row: publicRow(row) }) };
    enqueueEventSync(this.sql, this.options.channelId, operation.operation_id, 0, completedAt,
      request.grantedBy?.userId ?? null, "temp_vips.granted", {
        userId: request.person.userId,
        login: request.person.login,
        expiresAt,
        source: request.source,
      });
    return result;
  }

  private createImportedSync(
    operation: TempVipOperationSql,
    request: Omit<ModuleTempVipImportRequest, "operationId">,
    now: string,
  ): ModuleTempVipResult {
    const expiresAt = request.expiresAt ?? utc(parseTime(now) + request.durationMs);
    this.insertRowSync(request.person, request.grantedBy, "import", now, expiresAt, now, now);
    const row = rowFor(this.sql, request.person.userId);
    const result: ModuleTempVipResult = { status: "imported", expiresAt, ...(row === null ? {} : { row: publicRow(row) }) };
    enqueueEventSync(this.sql, this.options.channelId, operation.operation_id, 0, now,
      request.grantedBy?.userId ?? null, "temp_vips.imported", {
        userId: request.person.userId,
        login: request.person.login,
        expiresAt,
      });
    return result;
  }

  private insertRowSync(
    person: ModuleTempVipPerson,
    grantedBy: { userId: string; login: string } | null,
    source: TempVipSource,
    grantedAt: string,
    expiresAt: string,
    localEditAt: string,
    twitchStateAt: string,
  ): void {
    const latestTwitchStateAt = this.advanceTwitchStateSync(person.userId, twitchStateAt, localEditAt);
    this.sql.exec(
      `INSERT INTO temp_vips
        (user_id, user_login, user_display_name, expires_at, granted_at, twitch_state_at, local_edit_at, granted_by_user_id,
         granted_by_login, source, removal_failed_at, removal_attempts, removal_error, end_reason,
         classification, confirmation, expiry_reminder_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL, 'temporary', 'confirmed', NULL)
       ON CONFLICT(user_id) DO UPDATE SET
         user_login = excluded.user_login, user_display_name = excluded.user_display_name,
         expires_at = excluded.expires_at, granted_at = excluded.granted_at,
         twitch_state_at = excluded.twitch_state_at, local_edit_at = excluded.local_edit_at,
         granted_by_user_id = excluded.granted_by_user_id, granted_by_login = excluded.granted_by_login,
         source = excluded.source, removal_failed_at = NULL, removal_attempts = 0,
         removal_error = NULL, end_reason = NULL, classification = 'temporary',
         confirmation = 'confirmed', expiry_reminder_at = NULL`,
      person.userId,
      person.login,
      person.displayName,
      expiresAt,
      grantedAt,
      latestTwitchStateAt,
      localEditAt,
      grantedBy?.userId ?? null,
      grantedBy?.login ?? null,
      source,
    );
  }

  private extendRowSync(
    row: TempVipRowSql,
    person: ModuleTempVipPerson,
    grantedBy: { userId: string; login: string } | null,
    durationMs: number,
    maximumRemainingMs: number,
    source: TempVipSource,
    operationId: string,
    now: string,
    clearFailedRemoval = false,
  ): ModuleTempVipResult {
    const nowMs = parseTime(now);
    const existingExpiry = row.expires_at === null ? nowMs : parseTime(row.expires_at);
    const wasTemporary = row.classification === "temporary" && row.expires_at !== null;
    const expiresAtMs = (wasTemporary ? Math.max(nowMs, existingExpiry) : nowMs) + durationMs;
    const remaining = Math.max(0, expiresAtMs - nowMs);
    if (remaining > maximumRemainingMs) {
      const currentRemaining = Math.max(0, existingExpiry - nowMs);
      return {
        status: "maximum_exceeded",
        allowedDurationMs: Math.max(0, maximumRemainingMs - currentRemaining),
      };
    }
    this.sql.exec(
      `UPDATE temp_vips SET expires_at = ?, user_login = ?, user_display_name = ?, local_edit_at = ?,
         source = ?, removal_failed_at = NULL, removal_attempts = 0, removal_error = NULL,
         end_reason = NULL, classification = 'temporary', confirmation = 'confirmed',
         expiry_reminder_at = NULL WHERE user_id = ?`,
      utc(expiresAtMs),
      person.login,
      person.displayName,
      now,
      source,
      row.user_id,
    );
    const updated = rowFor(this.sql, row.user_id);
    const status = wasTemporary ? "extended" : "granted";
    const result: ModuleTempVipResult = { status, expiresAt: utc(expiresAtMs), ...(updated === null ? {} : { row: publicRow(updated) }) };
    enqueueEventSync(this.sql, this.options.channelId, operationId, 0, now, grantedBy?.userId ?? null,
      wasTemporary ? "temp_vips.extended" : "temp_vips.granted", {
        userId: row.user_id,
        login: person.login,
        expiresAt: utc(expiresAtMs),
        ...(clearFailedRemoval ? { removalFailureCleared: true } : {}),
      });
    return result;
  }

  private async channelPointsRedemptionOpen(redemptionId: string): Promise<boolean | null> {
    try {
      return await this.options.isChannelPointsRedemptionOpen?.(redemptionId) ?? null;
    } catch {
      return null;
    }
  }

  private requeueChannelPointsGrant(
    operation: TempVipOperationSql,
    payload: OperationPayload,
    now: string,
    attempts: number,
    needsReconcile: boolean,
  ): void {
    this.transaction(() => {
      if (needsReconcile) this.setNeedsReconcileSync(operation.operation_id, true);
      this.requeueSync(operation, payload, now, TEMP_VIP_RETRY_MS, attempts);
    });
  }

  private async processClosedChannelPointsGrant(
    operation: TempVipOperationSql,
    payload: OperationPayload,
    row: TempVipRowSql | null,
    needsReconcile: boolean,
  ): Promise<boolean> {
    const request = payload.request as unknown as Omit<ModuleTempVipGrantRequest, "operationId">;
    const redemptionOpen = await this.channelPointsRedemptionOpen(operation.operation_id);
    if (redemptionOpen === true) return false;

    const legacyAttempted = payload.mutationAttempted === undefined &&
      (needsReconcile || operation.attempts > 0 && payload.stage === "post");
    const mutationAttempted = payload.mutationAttempted === true || legacyAttempted;
    if (redemptionOpen === null) {
      this.requeueChannelPointsGrant(operation, payload, this.now(), operation.attempts + 1,
        mutationAttempted || needsReconcile);
      return true;
    }
    if (!mutationAttempted) {
      this.transaction(() => {
        this.finishSync(operation.operation_id, { status: "superseded" }, this.now(), operation.attempts);
      });
      return true;
    }

    const lookup = await this.safeGet(request.person.userId);
    const checkedAt = this.now();
    if (!lookup.ok) {
      this.requeueChannelPointsGrant(operation, payload, checkedAt, operation.attempts + 1, true);
      return true;
    }
    if (lookup.isVip && row === null) {
      this.transaction(() => {
        this.advanceTwitchStateSync(operation.user_id, checkedAt, checkedAt);
        const result = this.createGrantSync(operation, request, payload.intentAt ?? checkedAt, checkedAt);
        this.finishCreationSync(operation, result, checkedAt, operation.attempts + 1);
      });
      return true;
    }
    const mutationAmbiguous = payload.mutationAmbiguous === true ||
      (payload.mutationAmbiguous === undefined && (needsReconcile || legacyAttempted));
    if (!lookup.isVip && mutationAmbiguous) {
      this.requeueChannelPointsGrant(operation, payload, checkedAt, operation.attempts + 1, true);
      return true;
    }
    this.transaction(() => {
      this.finishSync(operation.operation_id, { status: "superseded" }, checkedAt, operation.attempts + 1);
    });
    return true;
  }

  private async beforeAddAttempt(operation: TempVipOperationSql, payload: OperationPayload): Promise<boolean> {
    const request = payload.request as { source?: string };
    if (operation.kind === "grant" && request.source === "channel_points") {
      const redemptionOpen = await this.channelPointsRedemptionOpen(operation.operation_id);
      if (redemptionOpen !== true) {
        const mutationAttempted = payload.mutationAttempted === true ||
          (payload.mutationAttempted === undefined &&
            (operation.needs_reconcile === 1 || operation.attempts > 0 && payload.stage === "post"));
        const now = this.now();
        this.transaction(() => {
          if (redemptionOpen === false && !mutationAttempted) {
            this.finishSync(operation.operation_id, { status: "superseded" }, now, operation.attempts);
          } else {
            if (mutationAttempted) this.setNeedsReconcileSync(operation.operation_id, true);
            this.requeueSync(operation, payload, now, TEMP_VIP_RETRY_MS, operation.attempts + 1);
          }
        });
        return false;
      }
    }
    return await this.beforeMutationAttempt(operation, payload);
  }

  private beforeMutationAttempt(operation: TempVipOperationSql, payload: OperationPayload): Promise<boolean> {
    const now = this.now();
    const slot = this.transaction(() => {
      const nowMs = parseTime(now);
      this.sql.exec("DELETE FROM temp_vip_mutation_attempts WHERE attempted_at <= ?", nowMs - TEMP_VIP_MUTATION_WINDOW_MS);
      const attempts = this.sql.exec<{ count: number; earliest: number | null }>(
        "SELECT COUNT(*) AS count, MIN(attempted_at) AS earliest FROM temp_vip_mutation_attempts",
      ).one();
      if (attempts.count >= TEMP_VIP_MUTATIONS_PER_WINDOW) {
        const retryAt = (attempts.earliest ?? nowMs) + TEMP_VIP_MUTATION_WINDOW_MS;
        if (this.shouldSupersedeForLaterReleaseSync(operation)) {
          this.finishSync(operation.operation_id, { status: "superseded" }, now, operation.attempts);
        } else {
          this.requeueSync(operation, payload, now, retryAt - nowMs, operation.attempts);
        }
        return { allowed: false, retryAt };
      }
      this.sql.exec("INSERT INTO temp_vip_mutation_attempts (attempted_at) VALUES (?)", nowMs);
      payload.mutationAmbiguous = false;
      payload.mutationAttempted = true;
      this.updatePayloadSync(operation, payload);
      return { allowed: true, retryAt: null };
    });
    return Promise.resolve(slot.allowed);
  }

  private requeueOperation(
    operation: TempVipOperationSql,
    payload: OperationPayload,
    now: string,
    delayMs: number,
    attempts: number,
    needsReconcile = false,
  ): void {
    this.transaction(() => {
      if (needsReconcile) this.setNeedsReconcileSync(operation.operation_id, true);
      if (this.shouldSupersedeForLaterReleaseSync(operation)) {
        this.finishSync(operation.operation_id, { status: "superseded" }, now, attempts);
      } else {
        this.requeueSync(operation, payload, now, delayMs, attempts);
      }
    });
  }

  private isDue(row: TempVipRowSql, now: string): boolean {
    if (row.classification !== "temporary" || row.expires_at === null) return false;
    const dueAt = row.removal_failed_at === null
      ? parseTime(row.expires_at)
      : parseTime(row.removal_failed_at) + backoffDelay(row.removal_attempts);
    return dueAt <= parseTime(now);
  }

  private recordExpiryRemindersSync(now: string): void {
    const dueRows = this.sql.exec<TempVipRowSql>(
      `SELECT * FROM temp_vips
        WHERE classification = 'temporary' AND expires_at IS NOT NULL
          AND expires_at <= ? AND expiry_reminder_at IS NULL`,
      now,
    ).toArray();
    for (const row of dueRows) {
      const operationId = `expire-reminder:${encodeURIComponent(row.user_id)}:${encodeURIComponent(row.expires_at ?? "")}`;
      this.sql.exec("UPDATE temp_vips SET expiry_reminder_at = ? WHERE user_id = ? AND expiry_reminder_at IS NULL", now, row.user_id);
      enqueueEventSync(this.sql, this.options.channelId, operationId, 0, now, null,
        "temp_vips.expire_reminder", { userId: row.user_id, login: row.user_login, expiresAt: row.expires_at });
    }
  }

  private async safeGet(userId: string): Promise<Awaited<ReturnType<TempVipTwitch["get"]>>> {
    try { return await this.options.twitch.get(userId); }
    catch { return { ok: false, reason: "network", ambiguous: true }; }
  }

  private async safeAdd(
    userId: string,
    operation: TempVipOperationSql,
    payload: OperationPayload,
  ): Promise<Awaited<ReturnType<TempVipTwitch["add"]>>> {
    try { return await this.options.twitch.add(userId, () => this.beforeAddAttempt(operation, payload)); }
    catch { return { ok: false, reason: "network", ambiguous: true }; }
  }

  private async safeRemove(
    userId: string,
    operation: TempVipOperationSql,
    payload: OperationPayload,
    hasRemovalBudget: () => boolean,
    spendRemoval: () => void,
  ): Promise<Awaited<ReturnType<TempVipTwitch["remove"]>>> {
    try {
      return await this.options.twitch.remove(userId, async () => {
        // Every actual DELETE (including a retry after a token refresh) spends the per-drain budget.
        if (!hasRemovalBudget()) {
          this.requeueOperation(operation, payload, this.now(), 0, operation.attempts);
          return false;
        }
        const allowed = await this.beforeMutationAttempt(operation, payload);
        if (allowed) spendRemoval();
        return allowed;
      });
    }
    catch { return { ok: false, reason: "network", ambiguous: true }; }
  }

  private async rearm(): Promise<void> {
    const now = this.now();
    const nowMs = parseTime(now);
    const managed = await this.mode() === "managed";
    const deadlines: number[] = [];
    const operations = this.sql.exec<Pick<TempVipOperationSql, "status" | "next_attempt_at" | "finished_at"> & { long_retention: number }>(
      `SELECT candidate.status, candidate.next_attempt_at, candidate.finished_at,
          (candidate.kind = 'grant' AND json_extract(candidate.payload_json, '$.request.source') = 'channel_points') AS long_retention
        FROM temp_vip_ops AS candidate
        WHERE (candidate.status != 'done' AND ${userOrderAvailable})
           OR (candidate.status = 'done' AND candidate.finished_at IS NOT NULL)`,
      now,
    ).toArray();
    const runnerActive = runnerByStorage.has(this.storage);
    for (const operation of operations) {
      if (operation.status === "running") deadlines.push(parseTime(operation.next_attempt_at));
      else if (operation.status === "queued") deadlines.push(
        parseTime(operation.next_attempt_at) > nowMs
          ? parseTime(operation.next_attempt_at)
          : nowMs + (runnerActive ? TEMP_VIP_QUEUED_RECOVERY_MS : 1),
      );
      else if (operation.finished_at !== null) {
        deadlines.push(parseTime(operation.finished_at) +
          (operation.long_retention === 1 ? TEMP_VIP_CHANNEL_POINTS_RETENTION_MS : TEMP_VIP_OPERATION_RETENTION_MS));
      }
    }
    const rows = managed ? this.sql.exec<TempVipRowSql>(
      "SELECT * FROM temp_vips WHERE classification = 'temporary' AND expires_at IS NOT NULL",
    ).toArray() : [];
    for (const row of rows) {
      const expiresAt = row.expires_at;
      if (expiresAt === null) continue;
      const removalPending = this.sql.exec<{ present: number }>(
        `SELECT EXISTS(SELECT 1 FROM temp_vip_ops
          WHERE user_id = ? AND status != 'done' AND kind IN ('end', 'expire')) AS present`,
        row.user_id,
      ).one().present === 1;
      if (removalPending) continue;
      const dueAt = row.removal_failed_at === null
        ? parseTime(expiresAt)
        : parseTime(row.removal_failed_at) + backoffDelay(row.removal_attempts);
      deadlines.push(dueAt);
    }
    if (this.panelRefreshState() !== 0 || this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM temp_vip_outbox").one().count > 0) {
      deadlines.push(parseTime(now) + TEMP_VIP_OUTBOX_RETRY_MS);
    }
    const earliest = deadlines.length === 0
      ? null
      : Math.max(nowMs + 1, Math.min(...deadlines));
    await this.options.scheduleAlarm(earliest);
  }

  private async enqueueAndWait(
    operationId: string,
    kind: TempVipOperationKind,
    userId: string,
    userLogin: string,
    request: Record<string, unknown>,
  ): Promise<ModuleTempVipResult> {
    this.enqueue(operationId, kind, userId, userLogin, request);
    await this.rearm();
    return this.waitForOperation(operationId);
  }

  private validateDuration(durationMs: number, maximumRemainingMs: number): void {
    if (!Number.isSafeInteger(durationMs) || durationMs < TEMP_VIP_MINIMUM_DURATION_MS ||
        !Number.isSafeInteger(maximumRemainingMs) || maximumRemainingMs <= 0) {
      throw new Error("invalid_temp_vip_duration");
    }
  }

  public async recordIntent(request: ModuleTempVipIntentRequest): Promise<ModuleTempVipResult> {
    if (parseTime(request.expiresAt) <= parseTime(this.now())) throw new Error("invalid_temp_vip_expiry");
    if (request.durationMs !== undefined && (!Number.isSafeInteger(request.durationMs) || request.durationMs < TEMP_VIP_MINIMUM_DURATION_MS)) {
      throw new Error("invalid_temp_vip_duration");
    }
    if (request.intentAt !== undefined) parseTime(request.intentAt);
    return this.enqueueAndWait(request.operationId, "record_intent", request.person.userId, request.person.login, { ...request });
  }

  public async addObserved(request: ModuleTempVipObservedAddRequest): Promise<ModuleTempVipResult> {
    return this.enqueueAndWait(request.operationId, "add_observed", request.person.userId, request.person.login, { ...request });
  }

  public async classify(request: ModuleTempVipClassifyRequest): Promise<ModuleTempVipResult> {
    if (request.classification === "temporary" &&
        (request.expiresAt === null && request.durationMs === undefined ||
          request.expiresAt !== null && request.durationMs !== undefined) ||
        request.classification === "permanent" && (request.expiresAt !== null || request.durationMs !== undefined)) {
      throw new Error("invalid_temp_vip_classification");
    }
    if (request.expiresAt !== null) parseTime(request.expiresAt);
    if (request.durationMs !== undefined &&
        (!Number.isSafeInteger(request.durationMs) || request.durationMs < TEMP_VIP_MINIMUM_DURATION_MS)) {
      throw new Error("invalid_temp_vip_duration");
    }
    return this.enqueueAndWait(request.operationId, "classify", request.userId, request.userId, { ...request });
  }

  public async handleModeration(event: ModuleTempVipModerationEvent): Promise<ModuleTempVipResult> {
    parseTime(event.eventSubTimestamp);
    if (event.action === "unvip") return await this.handleRemoved({
      triggerId: `moderation:${event.triggerId}`,
      userId: event.person.userId,
      eventSubTimestamp: event.eventSubTimestamp,
    });
    const operationId = `moderation:${event.triggerId}`;
    const operation = this.enqueue(operationId, "moderation", event.person.userId, event.person.login, { ...event });
    if (await this.mode() === "observe") {
      this.attachObserveVipToPendingIntentSync(operation, event);
    }
    await this.rearm();
    return this.waitForOperation(operationId);
  }

  public async grant(request: ModuleTempVipGrantRequest): Promise<ModuleTempVipResult> {
    this.validateDuration(request.durationMs, request.maximumRemainingMs);
    const operationId = operationKey(request.operationId);
    const payload = {
      person: request.person,
      grantedBy: request.grantedBy,
      durationMs: request.durationMs,
      maximumRemainingMs: request.maximumRemainingMs,
      source: request.source,
    };
    return this.enqueueAndWait(operationId, "grant", request.person.userId, request.person.login, payload);
  }

  public async replayGrant(operationIdValue: string, userId: string): Promise<ModuleTempVipResult | null> {
    const operationId = operationKey(operationIdValue);
    const existing = this.sql.exec<TempVipOperationSql>(
      "SELECT * FROM temp_vip_ops WHERE operation_id = ?",
      operationId,
    ).toArray()[0];
    if (existing === undefined) return null;
    if (existing.kind !== "grant" || existing.user_id !== userId) throw new Error("operation_conflict");
    if (existing.status === "done") return this.pendingResult(operationId);
    await this.rearm();
    return existing.status === "running" ? this.pendingResult(operationId) : this.waitForOperation(operationId);
  }

  public async extend(request: ModuleTempVipExtendRequest): Promise<ModuleTempVipResult> {
    this.validateDuration(request.durationMs, request.maximumRemainingMs);
    const operationId = operationKey(request.operationId);
    const payload = {
      person: request.person,
      grantedBy: request.grantedBy ?? null,
      durationMs: request.durationMs,
      maximumRemainingMs: request.maximumRemainingMs,
      source: request.source ?? "dashboard",
    };
    return this.enqueueAndWait(operationId, "extend", request.person.userId, request.person.login, payload);
  }

  public async importExisting(request: ModuleTempVipImportRequest): Promise<ModuleTempVipResult> {
    const operationId = operationKey(request.operationId);
    const payload = {
      person: request.person,
      grantedBy: request.grantedBy,
      ...(request.expiresAt === undefined ? { durationMs: request.durationMs } : { expiresAt: request.expiresAt }),
      maximumRemainingMs: request.maximumRemainingMs,
      source: "import" as const,
    };
    const existing = this.sql.exec<TempVipOperationSql>(
      "SELECT * FROM temp_vip_ops WHERE operation_id = ?",
      operationId,
    ).toArray()[0];
    if (existing !== undefined) {
      const priorPayload = decodePayload(existing.payload_json);
      if (existing.kind !== "import" || existing.user_id !== request.person.userId || requestJson(priorPayload) !== canonicalJson(payload)) {
        throw new Error("operation_conflict");
      }
      return this.waitForOperation(operationId);
    }
    this.validateDuration(request.durationMs, request.maximumRemainingMs);
    if (request.expiresAt !== undefined) {
      const acceptedAt = request.expiresAtValidatedAt ?? this.now();
      const remaining = parseTime(request.expiresAt) - parseTime(acceptedAt);
      if (remaining < TEMP_VIP_MINIMUM_DURATION_MS) throw new Error("invalid_temp_vip_duration");
      if (remaining > request.maximumRemainingMs) {
        return { status: "maximum_exceeded", allowedDurationMs: request.maximumRemainingMs };
      }
      if (parseTime(request.expiresAt) <= parseTime(this.now())) {
        return { status: "rejected", reason: "expiry_elapsed" };
      }
    }
    return this.enqueueAndWait(operationId, "import", request.person.userId, request.person.login, payload);
  }

  public async replayImport(operationIdValue: string, userId: string, expiresAt: string): Promise<ModuleTempVipResult | null> {
    const operationId = operationKey(operationIdValue);
    const existing = this.sql.exec<TempVipOperationSql>(
      "SELECT * FROM temp_vip_ops WHERE operation_id = ?",
      operationId,
    ).toArray()[0];
    if (existing === undefined) return null;
    const payload = decodePayload(existing.payload_json);
    if (existing.kind !== "import" || existing.user_id !== userId || payload.request.expiresAt !== expiresAt) {
      throw new Error("operation_conflict");
    }
    if (existing.status === "done") return this.pendingResult(operationId);
    await this.rearm();
    return existing.status === "running" ? this.pendingResult(operationId) : this.waitForOperation(operationId);
  }

  public async end(request: ModuleTempVipOperationRequest): Promise<ModuleTempVipResult> {
    const operationId = operationKey(request.operationId);
    return this.enqueueAndWait(operationId, "end", request.userId, request.userId, { userId: request.userId });
  }

  public async retryRemovalNow(userId: string): Promise<ModuleTempVipResult> {
    const now = this.now();
    const operation = this.transaction(() => {
      const pending = this.sql.exec<TempVipOperationSql>(
        `SELECT * FROM temp_vip_ops WHERE user_id = ? AND status != 'done'
           AND kind IN ('end', 'expire') ORDER BY enqueue_sequence LIMIT 1`,
        userId,
      ).toArray()[0];
      if (pending === undefined) return null;
      if (pending.status === "queued") {
        const payload = decodePayload(pending.payload_json);
        this.sql.exec(
          "UPDATE temp_vip_ops SET next_attempt_at = ?, payload_json = ? WHERE operation_id = ? AND status = 'queued'",
          now,
          JSON.stringify({ ...payload, retryNow: true }),
          pending.operation_id,
        );
      }
      return pending;
    });
    if (operation === null) return { status: "not_managed" };
    await this.rearm();
    if (operation.status === "running") return this.pendingResult(operation.operation_id);
    return this.waitForOperation(operation.operation_id);
  }

  public async release(request: ModuleTempVipOperationRequest): Promise<ModuleTempVipResult> {
    const operationId = operationKey(request.operationId);
    return this.enqueueAndWait(operationId, "release", request.userId, request.userId, { userId: request.userId });
  }

  public async disableModule(request: TempVipModuleDisableRequest): Promise<TempVipModuleDisableResult> {
    const operationId = operationKey(request.operationId);
    const result = await this.enqueueAndWait(operationId, "disable_module", "__channel__", "__channel__", {
      actor: request.actor,
      expectedRevision: request.expectedRevision,
    });
    return result;
  }

  public list(): Promise<ModuleTempVipRow[]> {
    return this.listRows();
  }

  private async listRows(): Promise<ModuleTempVipRow[]> {
    const now = this.now();
    if (await this.mode() === "observe") this.transaction(() => { this.recordExpiryRemindersSync(now); });
    await this.rearm();
    const rows = this.sql.exec<TempVipRowSql>("SELECT * FROM temp_vips").toArray().map(publicRow);
    const rank = (row: ModuleTempVipRow): number => {
      if (row.classification === "temporary" && row.expiresAt !== null && Date.parse(row.expiresAt) <= parseTime(now)) return 0;
      if (row.classification === "unclassified" || row.confirmation === "awaiting_vip") return 1;
      if (row.classification === "temporary") return 2;
      return 3;
    };
    return rows.sort((left, right) => rank(left) - rank(right) ||
      (left.expiresAt === null ? Number.POSITIVE_INFINITY : Date.parse(left.expiresAt)) -
      (right.expiresAt === null ? Number.POSITIVE_INFINITY : Date.parse(right.expiresAt)) ||
      left.login.localeCompare(right.login));
  }

  public async runExpiry(now = this.now()): Promise<{ removed: number; queued: number }> {
    const mode = await this.mode();
    if (mode === "observe") {
      this.transaction(() => { this.recordExpiryRemindersSync(now); });
      await this.startRunner();
      await this.rearm();
      const queued = this.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM temp_vip_ops WHERE status IN ('queued', 'running')",
      ).one().count;
      return { removed: 0, queued };
    }
    if (mode === "inactive") {
      await this.rearm();
      return { removed: 0, queued: 0 };
    }
    const before = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM temp_vips").one().count;
    const dueRows = this.sql.exec<TempVipRowSql>(
      "SELECT * FROM temp_vips WHERE classification = 'temporary' AND expires_at IS NOT NULL ORDER BY expires_at, user_id",
    ).toArray()
      .filter((row) => this.isDue(row, now));
    this.transaction(() => {
      for (const row of dueRows) {
        const pending = this.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM temp_vip_ops
            WHERE user_id = ? AND status != 'done' AND kind IN ('end', 'expire')`,
          row.user_id,
        ).one().count;
        if (pending > 0) continue;
        const expiresAt = row.expires_at;
        if (expiresAt === null) continue;
        const sequence = this.nextSequenceSync();
        const operationId = `expire:${encodeURIComponent(row.user_id)}:${encodeURIComponent(expiresAt)}:${String(sequence)}`;
        const request = { expectedExpiry: expiresAt };
        const payloadJson = makePayload(request);
        this.sql.exec(
          `INSERT OR IGNORE INTO temp_vip_ops
            (operation_id, kind, user_id, user_login, payload_json, status, attempts, next_attempt_at,
             result_json, created_at, finished_at, enqueue_sequence)
           VALUES (?, 'expire', ?, ?, ?, 'queued', 0, ?, NULL, ?, NULL, ?)`,
          operationId,
          row.user_id,
          row.user_login,
          payloadJson,
          now,
          now,
          sequence,
        );
      }
      this.pruneOperationsSync(now);
    });
    await this.rearm();
    await this.startRunner();
    await this.rearm();
    const after = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM temp_vips").one().count;
    const queued = this.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM temp_vip_ops WHERE status IN ('queued', 'running')",
    ).one().count;
    return { removed: Math.max(0, before - after), queued };
  }

  public async handleRemoved(event: ModuleTempVipRemovedEvent): Promise<ModuleTempVipResult> {
    const operationId = operationKey(`verify_removed:${event.triggerId}`);
    this.enqueue(operationId, "verify_removed", event.userId, event.userId, {
      triggerId: event.triggerId,
      userId: event.userId,
      eventSubTimestamp: event.eventSubTimestamp,
    });
    await this.rearm();
    void this.startRunner();
    return { status: "queued" };
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
    await this.rearm();
  }
}
