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

const TEMP_VIP_MUTATIONS_PER_WINDOW = 10;
const TEMP_VIP_MUTATION_WINDOW_MS = 10_000;
const TEMP_VIP_OPERATION_RETENTION_MS = 24 * 60 * 60_000;
const TEMP_VIP_CALLER_WAIT_MS = 10_000;
const TEMP_VIP_RECOVERY_MS = 60_000;
const TEMP_VIP_RETRY_MS = 60_000;
const TEMP_VIP_OUTBOX_RETRY_MS = 60_000;
const REMOVAL_RETRY_DELAYS_MS = [5 * 60_000, 15 * 60_000, 60 * 60_000] as const;

type TempVipTwitchFailure = { ok: false; reason: string; ambiguous?: boolean };
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
type TempVipOperationKind = "grant" | "extend" | "import" | "end" | "release" | "expire" | "verify_removed";
type QueueStatus = "queued" | "running" | "done";

interface TempVipRowSql extends Record<string, string | number | null> {
  user_id: string;
  user_login: string;
  user_display_name: string;
  expires_at: string;
  granted_at: string;
  granted_by_user_id: string | null;
  granted_by_login: string | null;
  source: TempVipSource;
  removal_failed_at: string | null;
  removal_attempts: number;
  removal_error: string | null;
  end_reason: "ended_early" | null;
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
}

interface OperationPayload {
  request: Record<string, unknown>;
  stage?: string;
  intentAt?: string | null;
}

interface ClaimedOperation {
  operation: TempVipOperationSql;
  payload: OperationPayload;
  interrupted: boolean;
}

interface MutationSlot {
  allowed: boolean;
  retryAt: number | null;
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

const ensureTempVipsSchema = (sql: SqlStorage): void => {
  const existingColumns = sql.exec<{ name: string }>("PRAGMA table_info(temp_vips)").toArray();
  const legacyTable = existingColumns.some(({ name }) => name === "pending_op" || name === "grant_generation");
  if (legacyTable) {
    sql.exec("DROP INDEX IF EXISTS temp_vips_expiry");
    sql.exec("ALTER TABLE temp_vips RENAME TO temp_vips_legacy");
  }

  sql.exec(`CREATE TABLE IF NOT EXISTS temp_vips (
    user_id TEXT PRIMARY KEY,
    user_login TEXT NOT NULL,
    user_display_name TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    granted_at TEXT NOT NULL,
    granted_by_user_id TEXT,
    granted_by_login TEXT,
    source TEXT NOT NULL CHECK (source IN ('command', 'dashboard', 'import', 'channel_points')),
    removal_failed_at TEXT,
    removal_attempts INTEGER NOT NULL DEFAULT 0,
    removal_error TEXT,
    end_reason TEXT CHECK (end_reason IN ('ended_early'))
  )`);

  if (legacyTable) {
    sql.exec(`INSERT OR REPLACE INTO temp_vips
      (user_id, user_login, user_display_name, expires_at, granted_at, granted_by_user_id,
       granted_by_login, source, removal_failed_at, removal_attempts, removal_error, end_reason)
      SELECT user_id, user_login, user_display_name, expires_at, granted_at, granted_by_user_id,
       granted_by_login, source, removal_failed_at, removal_attempts, removal_error, end_reason
      FROM temp_vips_legacy`);
    sql.exec("DROP TABLE temp_vips_legacy");
  }

  sql.exec("CREATE INDEX IF NOT EXISTS temp_vips_expiry ON temp_vips (expires_at, user_id)");
  sql.exec(`CREATE TABLE IF NOT EXISTS temp_vip_ops (
    operation_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('grant', 'extend', 'import', 'end', 'release', 'expire', 'verify_removed')),
    user_id TEXT NOT NULL,
    user_login TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    result_json TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  )`);
  sql.exec("CREATE INDEX IF NOT EXISTS temp_vip_ops_due ON temp_vip_ops (status, next_attempt_at, created_at, operation_id)");
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

  sql.exec("DROP TABLE IF EXISTS temp_vip_generations");
  sql.exec("DROP TABLE IF EXISTS temp_vip_tombstones");
  sql.exec("DROP TABLE IF EXISTS temp_vip_removal_slots");
  sql.exec("DROP TABLE IF EXISTS temp_vip_requests");
  sql.exec("DROP TABLE IF EXISTS temp_vip_operations");
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
  JSON.stringify({ request, stage, intentAt } satisfies OperationPayload);

const runnerByStorage = new WeakMap<object, Promise<void>>();

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
      ensureTempVipsSchema(this.sql);
    });
  }

  private transaction<Result>(run: () => Result): Result {
    return this.storage.transactionSync(run);
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
      this.sql.exec(
        `INSERT OR IGNORE INTO temp_vip_ops
          (operation_id, kind, user_id, user_login, payload_json, status, attempts, next_attempt_at,
           result_json, created_at, finished_at)
         VALUES (?, ?, ?, ?, ?, 'queued', 0, ?, NULL, ?, NULL)`,
        operationId,
        kind,
        userId,
        userLogin,
        payloadJson,
        now,
        now,
      );
      const prior = this.sql.exec<TempVipOperationSql>(
        "SELECT * FROM temp_vip_ops WHERE operation_id = ?",
        operationId,
      ).one();
      const priorPayload = decodePayload(prior.payload_json);
      if (prior.kind !== kind || prior.user_id !== userId || requestJson(priorPayload) !== canonicalJson(request)) {
        throw new Error("operation_conflict");
      }
      return prior;
    });
  }

  private pruneOperationsSync(now: string): void {
    const cutoff = utc(parseTime(now) - TEMP_VIP_OPERATION_RETENTION_MS);
    this.sql.exec("DELETE FROM temp_vip_ops WHERE status = 'done' AND finished_at <= ?", cutoff);
  }

  private updatePayloadSync(operation: TempVipOperationSql, payload: OperationPayload): void {
    this.sql.exec(
      "UPDATE temp_vip_ops SET payload_json = ? WHERE operation_id = ? AND status = 'running'",
      JSON.stringify(payload),
      operation.operation_id,
    );
  }

  private finishSync(operationId: string, result: ModuleTempVipResult, now: string, attempts?: number): void {
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
      })
      .finally(() => {
        if (runnerByStorage.get(this.storage) !== runner) return;
        runnerByStorage.delete(this.storage);
        if (this.hasDueQueueWork()) void this.startRunner();
      });
    runnerByStorage.set(this.storage, runner);
    return runner;
  }

  private hasDueQueueWork(): boolean {
    const now = this.now();
    return this.sql.exec<{ present: number }>(
      `SELECT EXISTS(
        SELECT 1 FROM temp_vip_ops
         WHERE status = 'running' OR (status = 'queued' AND next_attempt_at <= ?)
      ) AS present`,
      now,
    ).one().present === 1;
  }

  private claimNext(): ClaimedOperation | null {
    const now = this.now();
    return this.transaction(() => {
      this.pruneOperationsSync(now);
      const operation = this.sql.exec<TempVipOperationSql>(
        `SELECT * FROM temp_vip_ops
          WHERE status = 'running' OR (status = 'queued' AND next_attempt_at <= ?)
          ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END, created_at, operation_id
          LIMIT 1`,
        now,
      ).toArray()[0];
      if (operation === undefined) return null;

      const interrupted = operation.status === "running";
      const attempts = interrupted ? Math.max(1, operation.attempts + 1) : operation.attempts;
      const payload = decodePayload(operation.payload_json);
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

      this.sql.exec(
        `UPDATE temp_vip_ops SET status = 'running', attempts = ?, next_attempt_at = ?,
           payload_json = ?, result_json = NULL, finished_at = NULL WHERE operation_id = ?`,
        attempts,
        utc(parseTime(now) + TEMP_VIP_RECOVERY_MS),
        JSON.stringify(payload),
        operation.operation_id,
      );
      return {
        operation: { ...operation, status: "running", attempts, next_attempt_at: utc(parseTime(now) + TEMP_VIP_RECOVERY_MS), payload_json: JSON.stringify(payload) },
        payload,
        interrupted,
      };
    });
  }

  private async drainQueue(): Promise<void> {
    for (;;) {
      const claimed = this.claimNext();
      if (claimed === null) break;
      await this.rearm();
      try {
        await this.process(claimed);
      } catch (error: unknown) {
        const now = this.now();
        this.transaction(() => {
          const current = this.sql.exec<TempVipOperationSql>(
            "SELECT * FROM temp_vip_ops WHERE operation_id = ?",
            claimed.operation.operation_id,
          ).toArray()[0];
          if (current?.status === "running") {
            this.requeueSync(current, decodePayload(current.payload_json), now, TEMP_VIP_RETRY_MS, current.attempts + 1);
          }
        });
        console.warn("Temporary VIP operation will retry after an unexpected failure.", claimed.operation.operation_id, error);
      }
      await this.rearm();
    }
    await this.rearm();
  }

  private async process(claimed: ClaimedOperation): Promise<void> {
    const operation = claimed.operation;
    const payload = claimed.payload;
    const now = this.now();
    const row = rowFor(this.sql, operation.user_id);

    if (operation.kind === "grant") {
      await this.processGrant(operation, payload, row, claimed.interrupted);
      return;
    }
    if (operation.kind === "extend") {
      await this.processExtend(operation, payload, row, claimed.interrupted);
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
    if (current === null) {
      this.transaction(() => {
        this.finishSync(operation.operation_id, { status: "not_managed" }, now, operation.attempts);
      });
      return;
    }
    if (operation.kind === "expire" && !this.isDue(current, now)) {
      this.transaction(() => {
        this.finishSync(operation.operation_id, { status: "ignored" }, now, operation.attempts);
      });
      return;
    }

    const slot = this.reserveMutation(operation, payload);
    if (!slot.allowed) return;
    const removed = await this.safeRemove(operation.user_id);
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

  private async processGrant(
    operation: TempVipOperationSql,
    payload: OperationPayload,
    row: TempVipRowSql | null,
    interrupted: boolean,
  ): Promise<void> {
    const request = payload.request as unknown as Omit<ModuleTempVipGrantRequest, "operationId">;
    const now = this.now();
    if (row !== null && row.removal_failed_at === null) {
      this.transaction(() => {
        const result = this.extendRowSync(row, request.person, request.grantedBy, request.durationMs,
          request.maximumRemainingMs, request.source, operation.operation_id, now);
        this.finishSync(operation.operation_id, result, now, operation.attempts);
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

    const needsCheck = interrupted || payload.stage === "check_existing" ||
      (operation.attempts > 0 && payload.stage === "post");
    if (needsCheck) {
      const lookup = await this.safeGet(request.person.userId);
      const checkedAt = this.now();
      if (!lookup.ok) {
        this.requeueOperation(operation, payload, checkedAt, TEMP_VIP_RETRY_MS, operation.attempts + 1);
        return;
      }
      if (lookup.isVip) {
        this.transaction(() => {
          const current = rowFor(this.sql, operation.user_id);
          const result = current === null
            ? this.createGrantSync(operation, request, payload.intentAt ?? checkedAt, checkedAt)
            : this.extendRowSync(current, request.person, request.grantedBy, request.durationMs,
              request.maximumRemainingMs, request.source, operation.operation_id, checkedAt, true);
          this.finishSync(operation.operation_id, result, checkedAt, operation.attempts + 1);
        });
        return;
      }
      const next: OperationPayload = { ...payload, stage: "post_checked", intentAt: checkedAt };
      this.transaction(() => {
        if (row !== null) this.sql.exec("DELETE FROM temp_vips WHERE user_id = ?", row.user_id);
        this.requeueSync(operation, next, checkedAt, 0, operation.attempts + 1);
      });
      return;
    }

    const nextPayload: OperationPayload = {
      ...payload,
      stage: "post",
      intentAt: payload.intentAt ?? now,
    };
    if (JSON.stringify(nextPayload) !== operation.payload_json) {
      this.transaction(() => {
        this.updatePayloadSync(operation, nextPayload);
      });
    }
    const slot = this.reserveMutation(operation, nextPayload);
    if (!slot.allowed) return;
    const added = await this.safeAdd(request.person.userId);
    const completedAt = this.now();
    if (added.ok) {
      this.transaction(() => {
        const result = this.createGrantSync(operation, request, nextPayload.intentAt ?? completedAt, completedAt);
        this.finishSync(operation.operation_id, result, completedAt, operation.attempts + 1);
      });
      return;
    }
    if (added.ambiguous === true || added.reason === "network" || added.reason === "rate_limited" || added.reason === "unknown_status") {
      this.requeueOperation(operation, nextPayload, completedAt, TEMP_VIP_RETRY_MS, operation.attempts + 1);
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
    interrupted: boolean,
  ): Promise<void> {
    const request = payload.request as unknown as Omit<ModuleTempVipExtendRequest, "operationId">;
    const now = this.now();
    if (request.durationMs > request.maximumRemainingMs) {
      this.transaction(() => {
        this.finishSync(operation.operation_id, {
          status: "maximum_exceeded", allowedDurationMs: request.maximumRemainingMs,
        }, now, operation.attempts);
      });
      return;
    }
    if (row === null && payload.stage !== "post_checked") {
      this.transaction(() => {
        this.finishSync(operation.operation_id, { status: "not_managed" }, now, operation.attempts);
      });
      return;
    }
    if (row !== null && row.removal_failed_at === null) {
      this.transaction(() => {
        const result = this.extendRowSync(row, request.person, request.grantedBy ?? null, request.durationMs,
          request.maximumRemainingMs, request.source ?? "dashboard", operation.operation_id, now);
        this.finishSync(operation.operation_id, result, now, operation.attempts);
      });
      return;
    }

    const needsCheck = interrupted || payload.stage === "check_existing" ||
      (operation.attempts > 0 && payload.stage === "post");
    if (needsCheck || payload.stage === "check_existing") {
      const lookup = await this.safeGet(request.person.userId);
      const checkedAt = this.now();
      if (!lookup.ok) {
        this.requeueOperation(operation, payload, checkedAt, TEMP_VIP_RETRY_MS, operation.attempts + 1);
        return;
      }
      if (lookup.isVip) {
        this.transaction(() => {
          const current = rowFor(this.sql, operation.user_id);
          const result = current === null
            ? this.createGrantSync(operation, {
              person: request.person,
              grantedBy: request.grantedBy ?? null,
              durationMs: request.durationMs,
              maximumRemainingMs: request.maximumRemainingMs,
              source: request.source ?? "dashboard",
            }, payload.intentAt ?? checkedAt, checkedAt)
            : this.extendRowSync(current, request.person, request.grantedBy ?? null, request.durationMs,
              request.maximumRemainingMs, request.source ?? "dashboard", operation.operation_id, checkedAt, true);
          this.finishSync(operation.operation_id, result, checkedAt, operation.attempts + 1);
        });
        return;
      }
      const next: OperationPayload = { ...payload, stage: "post_checked", intentAt: checkedAt };
      this.transaction(() => {
        this.requeueSync(operation, next, checkedAt, 0, operation.attempts + 1);
      });
      return;
    }

    const slot = this.reserveMutation(operation, payload);
    if (!slot.allowed) return;
    const added = await this.safeAdd(request.person.userId);
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
        this.finishSync(operation.operation_id, result, completedAt, operation.attempts + 1);
      });
      return;
    }
    if (added.ambiguous === true || added.reason === "network" || added.reason === "rate_limited" || added.reason === "unknown_status") {
      this.requeueOperation(operation, { ...payload, stage: "post" }, completedAt, TEMP_VIP_RETRY_MS, operation.attempts + 1);
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
    if (request.durationMs > request.maximumRemainingMs) {
      this.transaction(() => {
        this.finishSync(operation.operation_id, {
          status: "maximum_exceeded", allowedDurationMs: request.maximumRemainingMs,
        }, now, operation.attempts);
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
    if (row === null) {
      this.transaction(() => {
        this.finishSync(operation.operation_id, { status: "ignored" }, now, operation.attempts);
      });
      return;
    }
    if (parseTime(request.eventSubTimestamp) < parseTime(row.granted_at)) {
      this.transaction(() => {
        this.finishSync(operation.operation_id, { status: "ignored_stale_echo" }, now, operation.attempts);
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
        this.finishSync(operation.operation_id, { status: "ignored" }, completedAt, operation.attempts + 1);
        return;
      }
      if (lookup.isVip) {
        this.finishSync(operation.operation_id, { status: "ignored_stale_event" }, completedAt, operation.attempts + 1);
        return;
      }
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
    this.insertRowSync(request.person, request.grantedBy, request.source, intendedAt, expiresAt);
    const row = rowFor(this.sql, request.person.userId);
    const result: ModuleTempVipResult = { status: "granted", ...(row === null ? {} : { row: publicRow(row) }) };
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
    const expiresAt = utc(parseTime(now) + request.durationMs);
    this.insertRowSync(request.person, request.grantedBy, "import", now, expiresAt);
    const row = rowFor(this.sql, request.person.userId);
    const result: ModuleTempVipResult = { status: "imported", ...(row === null ? {} : { row: publicRow(row) }) };
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
  ): void {
    this.sql.exec(
      `INSERT INTO temp_vips
        (user_id, user_login, user_display_name, expires_at, granted_at, granted_by_user_id,
         granted_by_login, source, removal_failed_at, removal_attempts, removal_error, end_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, NULL)
       ON CONFLICT(user_id) DO UPDATE SET
         user_login = excluded.user_login, user_display_name = excluded.user_display_name,
         expires_at = excluded.expires_at, granted_at = excluded.granted_at,
         granted_by_user_id = excluded.granted_by_user_id, granted_by_login = excluded.granted_by_login,
         source = excluded.source, removal_failed_at = NULL, removal_attempts = 0,
         removal_error = NULL, end_reason = NULL`,
      person.userId,
      person.login,
      person.displayName,
      expiresAt,
      grantedAt,
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
    const existingExpiry = parseTime(row.expires_at);
    const expiresAtMs = Math.max(nowMs, existingExpiry) + durationMs;
    const remaining = Math.max(0, expiresAtMs - nowMs);
    if (remaining > maximumRemainingMs) {
      const currentRemaining = Math.max(0, existingExpiry - nowMs);
      return {
        status: "maximum_exceeded",
        allowedDurationMs: Math.max(0, maximumRemainingMs - currentRemaining),
      };
    }
    this.sql.exec(
      `UPDATE temp_vips SET expires_at = ?, user_login = ?, user_display_name = ?,
         source = ?, removal_failed_at = NULL, removal_attempts = 0, removal_error = NULL,
         end_reason = NULL WHERE user_id = ?`,
      utc(expiresAtMs),
      person.login,
      person.displayName,
      source,
      row.user_id,
    );
    const updated = rowFor(this.sql, row.user_id);
    const result: ModuleTempVipResult = { status: "extended", ...(updated === null ? {} : { row: publicRow(updated) }) };
    enqueueEventSync(this.sql, this.options.channelId, operationId, 0, now, grantedBy?.userId ?? null,
      "temp_vips.extended", {
        userId: row.user_id,
        login: person.login,
        expiresAt: utc(expiresAtMs),
        ...(clearFailedRemoval ? { removalFailureCleared: true } : {}),
      });
    return result;
  }

  private reserveMutation(operation: TempVipOperationSql, payload: OperationPayload): MutationSlot {
    const now = this.now();
    const slot = this.transaction(() => {
      const nowMs = parseTime(now);
      this.sql.exec("DELETE FROM temp_vip_mutation_attempts WHERE attempted_at <= ?", nowMs - TEMP_VIP_MUTATION_WINDOW_MS);
      const attempts = this.sql.exec<{ count: number; earliest: number | null }>(
        "SELECT COUNT(*) AS count, MIN(attempted_at) AS earliest FROM temp_vip_mutation_attempts",
      ).one();
      if (attempts.count >= TEMP_VIP_MUTATIONS_PER_WINDOW) {
        const retryAt = (attempts.earliest ?? nowMs) + TEMP_VIP_MUTATION_WINDOW_MS;
        this.requeueSync(operation, payload, now, retryAt - nowMs, operation.attempts);
        return { allowed: false, retryAt };
      }
      this.sql.exec("INSERT INTO temp_vip_mutation_attempts (attempted_at) VALUES (?)", nowMs);
      return { allowed: true, retryAt: null };
    });
    return slot;
  }

  private requeueOperation(
    operation: TempVipOperationSql,
    payload: OperationPayload,
    now: string,
    delayMs: number,
    attempts: number,
  ): void {
    this.transaction(() => {
      this.requeueSync(operation, payload, now, delayMs, attempts);
    });
  }

  private isDue(row: TempVipRowSql, now: string): boolean {
    const dueAt = row.removal_failed_at === null
      ? parseTime(row.expires_at)
      : parseTime(row.removal_failed_at) + backoffDelay(row.removal_attempts);
    return dueAt <= parseTime(now);
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
    catch { return { ok: false, reason: "network", ambiguous: true }; }
  }

  private async rearm(): Promise<void> {
    const now = this.now();
    const deadlines: number[] = [];
    const operations = this.sql.exec<TempVipOperationSql>(
      "SELECT status, next_attempt_at, finished_at FROM temp_vip_ops WHERE status != 'done' OR finished_at IS NOT NULL",
    ).toArray();
    const runnerActive = runnerByStorage.has(this.storage);
    for (const operation of operations) {
      if (operation.status === "running") deadlines.push(parseTime(operation.next_attempt_at));
      else if (operation.status === "queued" &&
          (!runnerActive || parseTime(operation.next_attempt_at) > parseTime(now))) {
        deadlines.push(parseTime(operation.next_attempt_at));
      }
      else if (operation.finished_at !== null) deadlines.push(parseTime(operation.finished_at) + TEMP_VIP_OPERATION_RETENTION_MS);
    }
    const rows = this.sql.exec<TempVipRowSql>("SELECT * FROM temp_vips").toArray();
    for (const row of rows) {
      const dueAt = row.removal_failed_at === null
        ? parseTime(row.expires_at)
        : parseTime(row.removal_failed_at) + backoffDelay(row.removal_attempts);
      deadlines.push(dueAt);
    }
    if (this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM temp_vip_outbox").one().count > 0) {
      deadlines.push(parseTime(now) + TEMP_VIP_OUTBOX_RETRY_MS);
    }
    const earliest = deadlines.length === 0
      ? null
      : Math.max(Date.now() + 1, Math.min(...deadlines));
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
    if (!Number.isSafeInteger(durationMs) || durationMs <= 0 ||
        !Number.isSafeInteger(maximumRemainingMs) || maximumRemainingMs <= 0) {
      throw new Error("invalid_temp_vip_duration");
    }
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
    this.validateDuration(request.durationMs, request.maximumRemainingMs);
    const operationId = operationKey(request.operationId);
    const payload = {
      person: request.person,
      grantedBy: request.grantedBy,
      durationMs: request.durationMs,
      maximumRemainingMs: request.maximumRemainingMs,
      source: "import" as const,
    };
    return this.enqueueAndWait(operationId, "import", request.person.userId, request.person.login, payload);
  }

  public async end(request: ModuleTempVipOperationRequest): Promise<ModuleTempVipResult> {
    const operationId = operationKey(request.operationId);
    return this.enqueueAndWait(operationId, "end", request.userId, request.userId, { userId: request.userId });
  }

  public async release(request: ModuleTempVipOperationRequest): Promise<ModuleTempVipResult> {
    const operationId = operationKey(request.operationId);
    return this.enqueueAndWait(operationId, "release", request.userId, request.userId, { userId: request.userId });
  }

  public list(): Promise<ModuleTempVipRow[]> {
    return Promise.resolve(this.sql.exec<TempVipRowSql>("SELECT * FROM temp_vips ORDER BY expires_at, user_id").toArray().map(publicRow));
  }

  public hasRows(): boolean {
    return this.sql.exec<{ present: number }>("SELECT EXISTS(SELECT 1 FROM temp_vips) AS present").one().present === 1;
  }

  public async runExpiry(now = this.now()): Promise<{ removed: number; queued: number }> {
    const before = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM temp_vips").one().count;
    const dueRows = this.sql.exec<TempVipRowSql>("SELECT * FROM temp_vips ORDER BY expires_at, user_id").toArray()
      .filter((row) => this.isDue(row, now));
    this.transaction(() => {
      for (const row of dueRows) {
        const pending = this.sql.exec<{ count: number }>(
          `SELECT COUNT(*) AS count FROM temp_vip_ops
            WHERE user_id = ? AND status != 'done' AND kind IN ('end', 'expire')`,
          row.user_id,
        ).one().count;
        if (pending > 0) continue;
        const operationId = `expire:${encodeURIComponent(row.user_id)}:${encodeURIComponent(row.expires_at)}`;
        const request = { expectedExpiry: row.expires_at };
        const payloadJson = makePayload(request);
        this.sql.exec(
          `INSERT OR IGNORE INTO temp_vip_ops
            (operation_id, kind, user_id, user_login, payload_json, status, attempts, next_attempt_at,
             result_json, created_at, finished_at)
           VALUES (?, 'expire', ?, ?, ?, 'queued', 0, ?, NULL, ?, NULL)`,
          operationId,
          row.user_id,
          row.user_login,
          payloadJson,
          now,
          now,
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
