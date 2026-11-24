import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import type { BotModule } from "../../src/modules/contract";
import {
  ChannelJobError,
  ChannelJobStore,
  executeChannelJobClaim,
  requestChannelJobRun,
  hostChannelJobsForEnabledModules,
  HOST_CHANNEL_JOBS,
  type ChannelJobRegistration,
  type ChannelJobRunContext,
} from "../../src/worker/durable/channel-jobs";

const registration: ChannelJobRegistration = {
  id: "host:test_only",
  handlerKey: "host:test_only",
  intervalMs: 60_000,
  label: { de: "Test task", en: "Test job" },
  requiredScopes: [],
  retryDelaysMs: [1_000, 5_000],
};

const databases: DatabaseSync[] = [];

const storeFor = (clock: () => number): { store: ChannelJobStore; sql: SqlStorage } => {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const storage = {
    sql: {
      exec: <Row extends Record<string, unknown>>(query: string, ...values: SQLInputValue[]) => {
        const statement = database.prepare(query);
        const rows = /^\s*(SELECT|PRAGMA)/iu.test(query)
          ? statement.all(...values) as Row[]
          : (statement.run(...values), [] as Row[]);
        return { toArray: () => rows, one: () => rows[0] };
      },
    },
    transactionSync: <Result>(operation: () => Result): Result => {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = operation();
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return {
    store: new ChannelJobStore(storage as unknown as DurableObjectStorage, clock),
    sql: storage.sql as unknown as SqlStorage,
  };
};

const deferred = <Value = void>(): { promise: Promise<Value>; resolve: (value: Value) => void } => {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((done) => { resolve = done; });
  return { promise, resolve };
};

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("channel jobs", () => {
  it("registers the Twitch rank host job only for an enabled rank consumer", () => {
    const consumer = { id: "test_rank_consumer", consumes: ["twitch_ranks"] } as const;
    const rankJob = HOST_CHANNEL_JOBS.find(({ id }) => id === "host:twitch_ranks:reconcile");
    expect(rankJob).toMatchObject({
      intervalMs: 60 * 60_000,
      label: { de: "Twitch-Ränge abgleichen", en: "Sync Twitch ranks" },
    });
    expect(hostChannelJobsForEnabledModules(HOST_CHANNEL_JOBS, new Set(), [consumer as unknown as BotModule])).toEqual([]);
    expect(hostChannelJobsForEnabledModules(HOST_CHANNEL_JOBS, new Set([consumer.id]), [consumer as unknown as BotModule]))
      .toEqual(HOST_CHANNEL_JOBS);
  });

  it("returns already_running for Run now while the alarm claim is live", async () => {
    const now = 1_000;
    const { store } = storeFor(() => now);
    store.ensureJob(registration, now);
    const handlerDone = deferred<string>();
    let calls = 0;
    const running = executeChannelJobClaim({
      store,
      registration,
      claimToken: "claim-one",
      claimUntil: 10_000,
      now,
      handle: async () => {
        calls += 1;
        return await handlerDone.promise;
      },
    });
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    expect(calls).toBe(1);

    const scheduled: number[] = [];
    const result = await requestChannelJobRun({
      readClaim: () => Promise.resolve({ claimUntil: 10_000 }),
      scheduleNow: () => {
        scheduled.push(now);
        return Promise.resolve(true);
      },
    }, now);

    expect(result).toBe("already_running");
    expect(scheduled).toEqual([]);
    expect(calls).toBe(1);
    handlerDone.resolve("finished");
    await running;
  });

  it("takes over an expired claim with a new token and discards the old commit", async () => {
    let now = 0;
    const { store, sql } = storeFor(() => now);
    store.ensureJob(registration, now);
    sql.exec("CREATE TABLE test_job_writes (value INTEGER NOT NULL)");
    sql.exec("INSERT INTO test_job_writes (value) VALUES (0)");
    const oldHandlerDone = deferred<string>();
    let oldContext = null as ChannelJobRunContext | null;
    const oldRun = executeChannelJobClaim({
      store,
      registration,
      claimToken: "claim-old",
      claimUntil: 1_000,
      now,
      handle: async (context) => {
        oldContext = context;
        return await oldHandlerDone.promise;
      },
    });
    await new Promise((resolve) => { setTimeout(resolve, 0); });

    now = 1_001;
    const newHandlerDone = deferred<unknown>();
    const newRun = executeChannelJobClaim({
      store,
      registration,
      claimToken: "claim-new",
      claimUntil: 5_000,
      now,
      handle: async () => await newHandlerDone.promise,
    });
    expect(store.status(registration.id)).toMatchObject({
      state: "running",
      errorCode: "lease_expired",
      errorTextKey: "lease_expired",
      consecutiveFailures: 1,
    });

    expect(oldContext).not.toBeNull();
    const lateCommit = oldContext?.commit((sql) => {
      sql.exec("UPDATE test_job_writes SET value = value + 1");
    });
    expect(lateCommit).toBe(false);
    expect(sql.exec<{ value: number }>("SELECT value FROM test_job_writes").toArray()[0]?.value).toBe(0);

    newHandlerDone.resolve({ summary: { de: "aktuelles Ergebnis", en: "current result" } });
    await newRun;
    oldHandlerDone.resolve("late result");
    await expect(oldRun).resolves.toBe("superseded");
    expect(store.status(registration.id)).toMatchObject({
      state: "idle",
      resultSummary: { de: "aktuelles Ergebnis", en: "current result" },
      errorCode: null,
      consecutiveFailures: 0,
    });
  });

  it.each(["failure result", "success result", "thrown error"] as const)(
    "records lease expiry and retries when a %s returns after expiry without a takeover",
    async (outcome) => {
      let now = 1_000;
      const { store } = storeFor(() => now);
      store.ensureJob(registration, now);
      const claimUntil = 5_000;
      const handle = (): Promise<unknown> => {
        now = claimUntil;
        if (outcome === "failure result") return Promise.resolve({ ok: false, code: "unknown" });
        if (outcome === "thrown error") return Promise.reject(new Error("late handler error"));
        return Promise.resolve({ summary: { de: "late success", en: "late success" } });
      };

      const result = await executeChannelJobClaim({
        store,
        registration,
        claimToken: `expired-${outcome}`,
        claimUntil,
        now: 1_000,
        handle,
      });

      expect(result).toBe("retry");
      expect(store.status(registration.id)).toMatchObject({
        state: "failed",
        nextRunAt: now + (registration.retryDelaysMs?.[0] ?? 1_000),
        errorCode: "lease_expired",
        errorTextKey: "lease_expired",
        consecutiveFailures: 1,
      });
    },
  );

  it("skips paused jobs, records deferred event work, and resumes with a full run", async () => {
    let now = 2_000;
    const { store } = storeFor(() => now);
    store.ensureJob(registration, now);
    store.pause(registration.id, now);
    expect(store.markReconcileNeeded(registration.id)).toBe(false);

    let calls = 0;
    const paused = await executeChannelJobClaim({
      store,
      registration,
      claimToken: "paused-claim",
      claimUntil: 10_000,
      now,
      handle: () => {
        calls += 1;
        return Promise.resolve("should not run");
      },
    });
    expect(paused).toBe("skipped");
    expect(calls).toBe(0);
    expect(store.status(registration.id)).toMatchObject({ state: "paused", reconcileNeeded: true });

    now = 3_000;
    const resumed = store.resume(registration.id, now);
    expect(resumed?.nextRunAt).toBe(now);
    const result = await executeChannelJobClaim({
      store,
      registration,
      claimToken: "resumed-claim",
      claimUntil: 11_000,
      now,
      handle: () => {
        calls += 1;
        return Promise.resolve({ summary: { de: "abgeglichen", en: "reconciled" } });
      },
    });

    expect(result).toBe("completed");
    expect(calls).toBe(1);
    expect(store.status(registration.id)).toMatchObject({
      state: "idle",
      reconcileNeeded: false,
      resultSummary: { de: "abgeglichen", en: "reconciled" },
    });
  });

  it("stores success details and fixed errors without exposing exception text", async () => {
    let now = 4_000;
    const { store } = storeFor(() => now);
    store.ensureJob(registration, now);
    await executeChannelJobClaim({
      store,
      registration,
      claimToken: "seed-failure-token",
      claimUntil: 10_000,
      now,
      handle: () => Promise.reject(new ChannelJobError("unknown")),
    });
    const success = await executeChannelJobClaim({
      store,
      registration,
      claimToken: "success-token",
      claimUntil: 10_000,
      now,
      handle: () => Promise.resolve({
        summary: { de: "3 Rollen vergeben, 1 entfernt", en: "3 roles granted, 1 removed" },
      }),
    });
    expect(success).toBe("completed");
    expect(store.status(registration.id)).toMatchObject({
      state: "idle",
      lastSuccessAt: now,
      nextRunAt: now + registration.intervalMs,
      resultSummary: { de: "3 Rollen vergeben, 1 entfernt", en: "3 roles granted, 1 removed" },
      errorCode: null,
      consecutiveFailures: 0,
    });

    now += 1;
    await executeChannelJobClaim({
      store,
      registration,
      claimToken: "coded-failure-token",
      claimUntil: 10_001,
      now,
      handle: () => Promise.reject(new ChannelJobError("refresh_failed")),
    });
    expect(store.status(registration.id)).toMatchObject({
      state: "failed",
      errorCode: "refresh_failed",
      errorTextKey: "refresh_failed",
      consecutiveFailures: 1,
    });

    now += 1;
    await executeChannelJobClaim({
      store,
      registration,
      claimToken: "unknown-failure-token",
      claimUntil: 10_002,
      now,
      handle: () => Promise.reject(new Error("private upstream response")),
    });
    const status = store.status(registration.id);
    expect(status).toMatchObject({
      state: "failed",
      errorCode: "unknown",
      errorTextKey: "unknown",
      consecutiveFailures: 2,
    });
    expect(JSON.stringify(status)).not.toContain("private upstream response");
  });

  it("records missing scopes without calling the registered handler", async () => {
    const now = 8_000;
    const { store } = storeFor(() => now);
    const scopedRegistration = { ...registration, requiredScopes: ["channel:manage:vips"] };
    store.ensureJob(scopedRegistration, now);
    let calls = 0;
    const result = await executeChannelJobClaim({
      store,
      registration: scopedRegistration,
      claimToken: "scope-claim",
      claimUntil: 10_000,
      now,
      scopeFailure: () => Promise.resolve("missing_scope"),
      handle: () => {
        calls += 1;
        return Promise.resolve("should not run");
      },
    });

    expect(result).toBe("retry");
    expect(calls).toBe(0);
    expect(store.status(scopedRegistration.id)).toMatchObject({
      state: "failed",
      errorCode: "missing_scope",
      errorTextKey: "missing_scope",
      consecutiveFailures: 1,
    });
  });
});
