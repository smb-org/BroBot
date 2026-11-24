import type { ModuleLanguage } from "../../modules/contract";
import { ChannelJobError, type ChannelJobErrorCode, type ChannelJobSummary } from "../../contracts/channel-jobs";

export { ChannelJobError };
export type { ChannelJobErrorCode } from "../../contracts/channel-jobs";

type ChannelJobState = "idle" | "running" | "paused" | "failed";
interface ChannelJobOptions {
  intervalMs: number;
  label: Readonly<Record<ModuleLanguage, string>>;
  requiredScopes: readonly string[];
}

/** Runtime metadata shared by module alarms, host alarms, and test-only jobs. */
export interface ChannelJobRegistration extends ChannelJobOptions {
  id: string;
  handlerKey: string;
  retryDelaysMs?: readonly number[];
}

export interface HostChannelJobRegistration extends ChannelJobRegistration {
  run: (context: ChannelJobRunContext, alarmKey: string, deadline: number, now: number, nowIso: string) => Promise<unknown>;
}

/** Host jobs are added here with their existing `host:` alarm handler; there are no host jobs yet. */
export const HOST_CHANNEL_JOBS: readonly HostChannelJobRegistration[] = [];

export const channelJobAlarmKey = (jobId: string): string => `channel-job:${encodeURIComponent(jobId)}`;

export interface ChannelJobStatus {
  jobId: string;
  state: ChannelJobState;
  lastStartedAt: number | null;
  lastSuccessAt: number | null;
  nextRunAt: number | null;
  errorCode: ChannelJobErrorCode | null;
  errorTextKey: ChannelJobErrorCode | null;
  consecutiveFailures: number;
  resultSummary: ChannelJobSummary | null;
  pausedAt: number | null;
  reconcileNeeded: boolean;
}

export interface ChannelJobSnapshot extends Omit<ChannelJobStatus, "jobId"> {
  id: string;
  intervalMs: number;
  label: Readonly<Record<ModuleLanguage, string>>;
  requiredScopes: readonly string[];
}

export interface ChannelJobRunContext {
  jobId: string;
  claimToken: string;
  isCurrent(): boolean;
  assertCurrent(): void;
  /** Runs synchronous local SQLite mutations only while this claim still owns the job. */
  commit(write: (sql: SqlStorage) => void): boolean;
}

export interface ChannelJobAlarmClaim {
  claimUntil?: number;
}

class SupersededChannelJobRunError extends Error {
  public constructor() {
    super("The channel job claim is no longer current.");
    this.name = "SupersededChannelJobRunError";
  }
}

const CHANNEL_JOB_ERROR_CODES: readonly ChannelJobErrorCode[] = [
  "refresh_failed",
  "missing_scope",
  "lease_expired",
  "unknown",
];
const MAX_CHANNEL_JOB_SUMMARY_LENGTH = 180;
const ALARM_HANDLER_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const;

const isChannelJobErrorCode = (value: unknown): value is ChannelJobErrorCode =>
  typeof value === "string" && CHANNEL_JOB_ERROR_CODES.includes(value as ChannelJobErrorCode);

const isChannelJobState = (value: unknown): value is ChannelJobState =>
  value === "idle" || value === "running" || value === "paused" || value === "failed";

const boundedSummaryText = (value: unknown): string | null =>
  typeof value === "string" ? Array.from(value.trim()).slice(0, MAX_CHANNEL_JOB_SUMMARY_LENGTH).join("") || null : null;

/** Reads a localized summary; both languages are required, each bounded in length. */
const summaryFrom = (value: unknown): ChannelJobSummary | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const de = boundedSummaryText(Reflect.get(value, "de"));
  const en = boundedSummaryText(Reflect.get(value, "en"));
  return de === null || en === null ? null : { de, en };
};

const summaryFromResult = (value: unknown): ChannelJobSummary | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? summaryFrom(Reflect.get(value, "summary")) : null;

const summaryFromStored = (value: string | null): ChannelJobSummary | null => {
  if (value === null) return null;
  try {
    return summaryFrom(JSON.parse(value));
  } catch {
    return null;
  }
};

const failureCodeFrom = (value: unknown): ChannelJobErrorCode => {
  if (value instanceof ChannelJobError) return value.code;
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const code: unknown = Reflect.get(value, "code");
    if (isChannelJobErrorCode(code)) return code;
  }
  return "unknown";
};

const failureResultCode = (value: unknown): ChannelJobErrorCode | null => {
  if (value === "retry" || value === "retain") return "unknown";
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (Reflect.get(value, "ok") !== false) return null;
  const code: unknown = Reflect.get(value, "code");
  return isChannelJobErrorCode(code) ? code : "unknown";
};

interface ChannelJobStatusRow extends Record<string, string | number | null> {
  job_id: string;
  state: string;
  last_started_at: number | null;
  last_success_at: number | null;
  next_run_at: number | null;
  error_code: string | null;
  error_text_key: string | null;
  consecutive_failures: number;
  result_summary: string | null;
  paused_at: number | null;
  reconcile_needed: number;
  claim_token: string | null;
  claim_until: number | null;
}

const statusSelect = `SELECT job_id, state, last_started_at, last_success_at, next_run_at,
  error_code, error_text_key, consecutive_failures, result_summary, paused_at, reconcile_needed,
  claim_token, claim_until
FROM channel_jobs_status`;

const statusFromRow = (row: ChannelJobStatusRow | undefined): ChannelJobStatus | null => {
  if (row === undefined || !isChannelJobState(row.state)) return null;
  return {
    jobId: row.job_id,
    state: row.state,
    lastStartedAt: row.last_started_at,
    lastSuccessAt: row.last_success_at,
    nextRunAt: row.next_run_at,
    errorCode: isChannelJobErrorCode(row.error_code) ? row.error_code : null,
    errorTextKey: isChannelJobErrorCode(row.error_text_key) ? row.error_text_key : null,
    consecutiveFailures: Number.isSafeInteger(row.consecutive_failures) ? row.consecutive_failures : 0,
    resultSummary: summaryFromStored(row.result_summary),
    pausedAt: row.paused_at,
    reconcileNeeded: row.reconcile_needed === 1,
  };
};

const validateRegistration = (registration: ChannelJobRegistration): void => {
  if (registration.id.length > 256 || !/^(?:module|host):[A-Za-z0-9_:-]{1,252}$/u.test(registration.id) ||
      registration.handlerKey.length === 0 || registration.handlerKey.length > 256) {
    throw new RangeError("A channel job identifier is invalid.");
  }
  if (!Number.isSafeInteger(registration.intervalMs) || registration.intervalMs < 1) {
    throw new RangeError("A channel job interval must be a positive safe integer.");
  }
  if (Object.values(registration.label).some((label) => label.trim().length === 0 || label.length > 120)) {
    throw new RangeError("A channel job label is invalid.");
  }
  if (registration.requiredScopes.some((scope) => scope.length === 0 || scope.length > 128)) {
    throw new RangeError("A channel job scope is invalid.");
  }
}

/** SQLite status and claim fencing for the existing keyed alarm scheduler. */
export class ChannelJobStore {
  private readonly storage: Pick<DurableObjectStorage, "sql" | "transactionSync">;
  private readonly now: () => number;

  public constructor(
    storage: Pick<DurableObjectStorage, "sql" | "transactionSync">,
    now: () => number = Date.now,
  ) {
    this.storage = storage;
    this.now = now;
    this.storage.transactionSync(() => {
      this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS channel_jobs_status (
        job_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('idle', 'running', 'paused', 'failed')),
        last_started_at INTEGER,
        last_success_at INTEGER,
        next_run_at INTEGER,
        error_code TEXT CHECK (error_code IS NULL OR error_code IN ('refresh_failed', 'missing_scope', 'lease_expired', 'unknown')),
        error_text_key TEXT CHECK (error_text_key IS NULL OR error_text_key IN ('refresh_failed', 'missing_scope', 'lease_expired', 'unknown')),
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        result_summary TEXT,
        paused_at INTEGER,
        reconcile_needed INTEGER NOT NULL DEFAULT 0 CHECK (reconcile_needed IN (0, 1)),
        claim_token TEXT,
        claim_until INTEGER
      )`);
    });
  }

  private row(jobId: string): ChannelJobStatusRow | undefined {
    return this.storage.sql.exec<ChannelJobStatusRow>(`${statusSelect} WHERE job_id = ?`, jobId).toArray()[0];
  }

  private current(jobId: string, claimToken: string, now: number): boolean {
    const row = this.row(jobId);
    return row?.state === "running" && row.claim_token === claimToken &&
      typeof row.claim_until === "number" && row.claim_until > now;
  }

  public currentTime(): number {
    return this.now();
  }

  public ensureJob(registration: ChannelJobRegistration, now = this.now()): ChannelJobStatus {
    validateRegistration(registration);
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `INSERT OR IGNORE INTO channel_jobs_status (job_id, state, next_run_at)
         VALUES (?, 'idle', ?)`,
        registration.id,
        now + registration.intervalMs,
      );
    });
    const status = this.status(registration.id);
    if (status === null) throw new Error("The channel job status row could not be read.");
    return status;
  }

  public status(jobId: string): ChannelJobStatus | null {
    return statusFromRow(this.row(jobId));
  }

  public isPaused(jobId: string): boolean {
    return this.row(jobId)?.state === "paused";
  }

  public claimUntil(jobId: string): number | null {
    const claimUntil = this.row(jobId)?.claim_until;
    return typeof claimUntil === "number" ? claimUntil : null;
  }

  public setNextRunAt(jobId: string, nextRunAt: number): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        "UPDATE channel_jobs_status SET next_run_at = ? WHERE job_id = ? AND state != 'paused' AND state != 'running'",
        nextRunAt,
        jobId,
      );
    });
  }

  /** Called only after the matching existing alarm entry has been claimed. */
  public startClaim(jobId: string, claimToken: string, claimUntil: number, now = this.now()): "started" | "already_running" | "paused" {
    const outcome = this.storage.transactionSync((): "started" | "already_running" | "paused" => {
      const row = this.row(jobId);
      if (row === undefined) throw new Error("The channel job must be registered before it can run.");
      if (row.state === "paused") return "paused";
      if (row.state === "running" && row.claim_until !== null && row.claim_until > now) return "already_running";
      if (row.state === "running") {
        this.storage.sql.exec(
          `UPDATE channel_jobs_status
              SET state = 'failed', error_code = 'lease_expired', error_text_key = 'lease_expired',
                  consecutive_failures = consecutive_failures + 1, claim_token = NULL, claim_until = NULL
            WHERE job_id = ?`,
          jobId,
        );
      }
      this.storage.sql.exec(
        `UPDATE channel_jobs_status
            SET state = 'running', last_started_at = ?, next_run_at = NULL, claim_token = ?, claim_until = ?
          WHERE job_id = ?`,
        now,
        claimToken,
        claimUntil,
        jobId,
      );
      return "started";
    });
    return outcome;
  }

  public isCurrent(jobId: string, claimToken: string, now = this.now()): boolean {
    return this.current(jobId, claimToken, now);
  }

  /** A stale claim cannot commit any of its local SQLite writes. */
  public commit(jobId: string, claimToken: string, write: (sql: SqlStorage) => void, now = this.now()): boolean {
    return this.storage.transactionSync(() => {
      if (!this.current(jobId, claimToken, now)) return false;
      write(this.storage.sql);
      return true;
    });
  }

  public succeed(
    jobId: string,
    claimToken: string,
    now: number,
    nextRunAt: number,
    resultSummary: ChannelJobSummary | null,
  ): boolean {
    return this.storage.transactionSync(() => {
      if (!this.current(jobId, claimToken, now)) return false;
      this.storage.sql.exec(
        `UPDATE channel_jobs_status
            SET state = 'idle', last_success_at = ?, next_run_at = ?, error_code = NULL,
                error_text_key = NULL, consecutive_failures = 0, result_summary = ?,
                reconcile_needed = 0, claim_token = NULL, claim_until = NULL
          WHERE job_id = ? AND claim_token = ?`,
        now,
        nextRunAt,
        resultSummary === null ? null : JSON.stringify(resultSummary),
        jobId,
        claimToken,
      );
      return true;
    });
  }

  public fail(
    jobId: string,
    claimToken: string,
    now: number,
    code: ChannelJobErrorCode,
    nextRunAt: number,
  ): boolean {
    return this.storage.transactionSync(() => {
      if (!this.current(jobId, claimToken, now)) return false;
      this.storage.sql.exec(
        `UPDATE channel_jobs_status
            SET state = 'failed', next_run_at = ?, error_code = ?, error_text_key = ?,
                consecutive_failures = consecutive_failures + 1, claim_token = NULL, claim_until = NULL
          WHERE job_id = ? AND claim_token = ?`,
        nextRunAt,
        code,
        code,
        jobId,
        claimToken,
      );
      return true;
    });
  }

  public failExpiredClaim(jobId: string, claimToken: string, now: number, nextRunAt: number): boolean {
    return this.storage.transactionSync(() => {
      const row = this.row(jobId);
      if (row?.state !== "running" || row.claim_token !== claimToken ||
          typeof row.claim_until !== "number" || row.claim_until > now) return false;
      this.storage.sql.exec(
        `UPDATE channel_jobs_status
            SET state = 'failed', next_run_at = ?, error_code = 'lease_expired', error_text_key = 'lease_expired',
                consecutive_failures = consecutive_failures + 1, claim_token = NULL, claim_until = NULL
          WHERE job_id = ? AND claim_token = ?`,
        nextRunAt,
        jobId,
        claimToken,
      );
      return true;
    });
  }

  public pause(jobId: string, now = this.now()): ChannelJobStatus | null {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `UPDATE channel_jobs_status
            SET state = 'paused', paused_at = COALESCE(paused_at, ?), next_run_at = NULL,
                claim_token = NULL, claim_until = NULL
          WHERE job_id = ?`,
        now,
        jobId,
      );
    });
    return this.status(jobId);
  }

  /** Clears pause and returns a full run scheduled for the current instant. */
  public resume(jobId: string, now = this.now()): ChannelJobStatus | null {
    this.storage.transactionSync(() => {
      this.storage.sql.exec(
        `UPDATE channel_jobs_status
            SET state = 'idle', paused_at = NULL, next_run_at = ?, claim_token = NULL, claim_until = NULL
          WHERE job_id = ? AND state = 'paused'`,
        now,
        jobId,
      );
    });
    return this.status(jobId);
  }

  /** Returns false while paused and records that the next full run must reconcile. */
  public markReconcileNeeded(jobId: string): boolean {
    return this.storage.transactionSync(() => {
      const row = this.row(jobId);
      if (row?.state !== "paused") return true;
      this.storage.sql.exec(
        "UPDATE channel_jobs_status SET reconcile_needed = 1 WHERE job_id = ? AND state = 'paused'",
        jobId,
      );
      return false;
    });
  }

  public remove(jobId: string): void {
    this.storage.transactionSync(() => {
      this.storage.sql.exec("DELETE FROM channel_jobs_status WHERE job_id = ?", jobId);
    });
  }
}

export const requestChannelJobRun = async (
  alarm: {
    readClaim: () => Promise<ChannelJobAlarmClaim | null>;
    scheduleNow: () => Promise<boolean>;
  },
  now = Date.now(),
): Promise<"already_running" | "scheduled"> => {
  const claim = await alarm.readClaim();
  if (claim?.claimUntil !== undefined && claim.claimUntil > now) return "already_running";
  return await alarm.scheduleNow() ? "scheduled" : "already_running";
};

export const alarmRetryDelay = (
  retryDelaysMs: readonly number[] | undefined,
  consecutiveFailures: number,
): number => {
  const configured = retryDelaysMs?.filter((delay) => Number.isFinite(delay) && delay >= 1);
  const delays = configured !== undefined && configured.length > 0 ? configured : ALARM_HANDLER_RETRY_DELAYS_MS;
  return delays[Math.min(consecutiveFailures, delays.length - 1)] ?? ALARM_HANDLER_RETRY_DELAYS_MS[0];
};

export const executeChannelJobClaim = async (options: {
  store: ChannelJobStore;
  registration: ChannelJobRegistration;
  claimToken: string;
  claimUntil: number;
  now: number;
  scopeFailure?: () => Promise<ChannelJobErrorCode | null>;
  handle: (context: ChannelJobRunContext) => Promise<unknown>;
  scheduleNext?: (deadline: number) => Promise<void>;
  onStatusChanged?: () => Promise<void>;
}): Promise<"completed" | "retry" | "skipped" | "already_running" | "superseded"> => {
  const { store, registration, claimToken, claimUntil } = options;
  store.ensureJob(registration, options.now);
  const started = store.startClaim(registration.id, claimToken, claimUntil, options.now);
  if (started === "paused") return "skipped";
  if (started === "already_running") return "already_running";
  const notifyStatus = async (): Promise<void> => {
    try {
      await options.onStatusChanged?.();
    } catch {
      // A panel refresh failure cannot change the outcome of the claimed job.
    }
  };
  await notifyStatus();

  const clock = (): number => store.currentTime();
  const runContext: ChannelJobRunContext = {
    jobId: registration.id,
    claimToken,
    isCurrent: () => store.isCurrent(registration.id, claimToken, clock()),
    assertCurrent: () => {
      if (!store.isCurrent(registration.id, claimToken, clock())) throw new SupersededChannelJobRunError();
    },
    commit: (write) => store.commit(registration.id, claimToken, write, clock()),
  };
  const finishFailure = async (code: ChannelJobErrorCode): Promise<"retry" | "superseded"> => {
    const status = store.status(registration.id);
    if (status === null) return "superseded";
    const nextRunAt = clock() + alarmRetryDelay(registration.retryDelaysMs, status.consecutiveFailures);
    if (!store.fail(registration.id, claimToken, clock(), code, nextRunAt)) return "superseded";
    await notifyStatus();
    return "retry";
  };

  try {
    const scopeFailure = await options.scopeFailure?.();
    if (scopeFailure !== undefined && scopeFailure !== null) return await finishFailure(scopeFailure);
    runContext.assertCurrent();
    const result = await options.handle(runContext);
    const codedFailure = failureResultCode(result);
    if (codedFailure !== null) return await finishFailure(codedFailure);
    runContext.assertCurrent();
    const completedAt = clock();
    const nextRunAt = completedAt + registration.intervalMs;
    if (!store.succeed(registration.id, claimToken, completedAt, nextRunAt, summaryFromResult(result))) return "superseded";
    await options.scheduleNext?.(nextRunAt);
    await notifyStatus();
    return "completed";
  } catch (error: unknown) {
    if (!store.isCurrent(registration.id, claimToken, clock())) {
      const status = store.status(registration.id);
      const nextRunAt = clock() + alarmRetryDelay(registration.retryDelaysMs, status?.consecutiveFailures ?? 0);
      if (store.failExpiredClaim(registration.id, claimToken, clock(), nextRunAt)) {
        await notifyStatus();
        return "retry";
      }
      return "superseded";
    }
    if (error instanceof SupersededChannelJobRunError) return "superseded";
    return await finishFailure(failureCodeFrom(error));
  }
};
