import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ModuleTempVipExtendRequest,
  ModuleTempVipGrantRequest,
  ModuleTempVipImportRequest,
  ModuleTempVipPerson,
  ModuleTempVipResult,
} from "../../src/modules/contract";
import { TempVipStore, type TempVipStoreOptions, type TempVipTwitch } from "../../src/worker/durable/temp-vips";

const namespace = (env as unknown as { CHANNEL: Env["CHANNEL"] }).CHANNEL;
const BASE_NOW = "2026-11-01T12:00:00.000Z";
const BASE_MS = Date.parse(BASE_NOW);
const DAY = 86_400_000;
const MAXIMUM = 90 * DAY;
let serial = 0;
const channelId = (): string => `temp-vips-${String(++serial)}`;

const person: ModuleTempVipPerson = { userId: "user-1", login: "viewer", displayName: "Viewer" };
const actor = { userId: "mod-1", login: "moderator" };
const grantInput = (overrides: Partial<ModuleTempVipGrantRequest> = {}): ModuleTempVipGrantRequest => ({
  operationId: "grant-1",
  person,
  grantedBy: actor,
  durationMs: DAY,
  maximumRemainingMs: MAXIMUM,
  source: "command",
  ...overrides,
});

const createStore = (state: DurableObjectState, options: {
  channelId?: string;
  twitch?: Partial<TempVipTwitch>;
  scheduleAlarm?: (deadline: number | null) => Promise<void>;
  isModuleEnabled?: () => Promise<boolean>;
  commitModuleDisable?: TempVipStoreOptions["commitModuleDisable"];
} = {}): TempVipStore => new TempVipStore(state.storage, {
  channelId: options.channelId ?? "temp-vips-test",
  now: () => new Date().toISOString(),
  twitch: {
    get: options.twitch?.get ?? vi.fn().mockResolvedValue({ ok: true, isVip: false }),
    add: options.twitch?.add ?? vi.fn().mockResolvedValue({ ok: true }),
    remove: options.twitch?.remove ?? vi.fn().mockResolvedValue({ ok: true }),
  },
  scheduleAlarm: options.scheduleAlarm ?? vi.fn().mockResolvedValue(undefined),
  ...(options.isModuleEnabled === undefined ? {} : { isModuleEnabled: options.isModuleEnabled }),
  ...(options.commitModuleDisable === undefined ? {} : { commitModuleDisable: options.commitModuleDisable }),
});

const inStore = <T>(
  action: (store: TempVipStore, state: DurableObjectState) => Promise<T>,
  options: Parameters<typeof createStore>[1] = {},
): Promise<T> => {
  const id = channelId();
  const stub = namespace.get(namespace.idFromName(id));
  return runInDurableObject(stub, async (_instance, state) => action(createStore(state, { ...options, channelId: id }), state));
};

const insertRow = (
  storage: DurableObjectState["storage"],
  overrides: Partial<{
    userId: string;
    login: string;
    displayName: string;
    expiresAt: string;
    grantedAt: string;
    grantedByUserId: string | null;
    grantedByLogin: string | null;
    source: "command" | "dashboard" | "import" | "channel_points";
    removalFailedAt: string | null;
    removalAttempts: number;
    removalError: string | null;
    endReason: "ended_early" | null;
  }> = {},
): void => {
  const row = {
    userId: person.userId,
    login: person.login,
    displayName: person.displayName,
    expiresAt: new Date(BASE_MS + DAY).toISOString(),
    grantedAt: BASE_NOW,
    grantedByUserId: actor.userId,
    grantedByLogin: actor.login,
    source: "command" as const,
    removalFailedAt: null,
    removalAttempts: 0,
    removalError: null,
    endReason: null,
    ...overrides,
  };
  storage.transactionSync(() => {
    storage.sql.exec(
      `INSERT INTO temp_vips
        (user_id, user_login, user_display_name, expires_at, granted_at, granted_by_user_id, granted_by_login,
         source, removal_failed_at, removal_attempts, removal_error, end_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.userId,
      row.login,
      row.displayName,
      row.expiresAt,
      row.grantedAt,
      row.grantedByUserId,
      row.grantedByLogin,
      row.source,
      row.removalFailedAt,
      row.removalAttempts,
      row.removalError,
      row.endReason,
    );
  });
};

const insertInterruptedGrant = (
  storage: DurableObjectState["storage"],
  input: ModuleTempVipGrantRequest,
  options: { status?: "running" | "queued"; attempts?: number; at?: string; precondition?: "not_vip" } = {},
): void => {
  const at = options.at ?? BASE_NOW;
  const payload = JSON.stringify({
    request: {
      person: input.person,
      grantedBy: input.grantedBy,
      durationMs: input.durationMs,
      maximumRemainingMs: input.maximumRemainingMs,
      source: input.source,
    },
    stage: "post",
    intentAt: at,
    ...(options.precondition === undefined ? {} : { precondition: options.precondition }),
  });
  storage.transactionSync(() => {
    storage.sql.exec(
      `INSERT INTO temp_vip_ops
        (operation_id, kind, user_id, user_login, payload_json, status, attempts, next_attempt_at,
         result_json, created_at, finished_at)
       VALUES (?, 'grant', ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      input.operationId,
      input.person.userId,
      input.person.login,
      payload,
      options.status ?? "running",
      options.attempts ?? 0,
      at,
      at,
    );
  });
};

const insertQueuedOperation = (
  storage: DurableObjectState["storage"],
  operation: {
    operationId: string;
    kind: "grant" | "end" | "expire";
    userId: string;
    userLogin: string;
    request: Record<string, unknown>;
    sequence: number;
    status?: "queued" | "running";
  },
): void => {
  const columns = new Set(storage.sql.exec<{ name: string }>("PRAGMA table_info(temp_vip_ops)").toArray().map(({ name }) => name));
  const sequenceColumn = columns.has("enqueue_sequence") ? ", enqueue_sequence" : "";
  const sequenceValue = columns.has("enqueue_sequence") ? ", ?" : "";
  const values: Array<string | number> = [
    operation.operationId,
    operation.kind,
    operation.userId,
    operation.userLogin,
    JSON.stringify({ request: operation.request, stage: "initial", intentAt: null }),
    operation.status ?? "queued",
    BASE_NOW,
    BASE_NOW,
  ];
  if (columns.has("enqueue_sequence")) values.push(operation.sequence);
  storage.transactionSync(() => {
    storage.sql.exec(
      `INSERT INTO temp_vip_ops
        (operation_id, kind, user_id, user_login, payload_json, status, attempts, next_attempt_at,
         result_json, created_at, finished_at${sequenceColumn})
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, NULL, ?, NULL${sequenceValue})`,
      ...values,
    );
  });
};

const pendingEvents = (store: TempVipStore): Array<{ eventId: string; code: string; detail: Readonly<Record<string, unknown>> }> =>
  store.pendingOutbox().map(({ eventId, code, detail }) => ({ eventId, code, detail }));

const operationResult = (storage: DurableObjectState["storage"], operationId: string): ModuleTempVipResult => {
  const resultJson = storage.sql.exec<{ result_json: string | null }>(
    "SELECT result_json FROM temp_vip_ops WHERE operation_id = ?",
    operationId,
  ).toArray()[0]?.result_json;
  if (resultJson === null || resultJson === undefined) throw new Error(`Operation ${operationId} has no result.`);
  return JSON.parse(resultJson) as ModuleTempVipResult;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(BASE_NOW));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("temporary VIP operation queue", () => {
  it("serializes concurrent grants for the same user and extends from the first result", async () => {
    let finishAdd: ((result: { ok: true }) => void) | undefined;
    let markAddStarted: (() => void) | undefined;
    const addStarted = new Promise<void>((resolve) => { markAddStarted = resolve; });
    const add = vi.fn(() => {
      markAddStarted?.();
      return new Promise<{ ok: true }>((resolve) => { finishAdd = resolve; });
    });

    await inStore(async (store) => {
      const first = store.grant(grantInput({ operationId: "same-user-first" }));
      await addStarted;
      const second = store.grant(grantInput({ operationId: "same-user-second" }));
      await Promise.resolve();
      expect(add).toHaveBeenCalledTimes(1);

      finishAdd?.({ ok: true });
      expect((await first).status).toBe("granted");
      expect((await second).status).toBe("extended");
      expect(await store.list()).toMatchObject([
        { userId: person.userId, expiresAt: "2026-11-03T12:00:00.000Z" },
      ]);
      expect(add).toHaveBeenCalledTimes(1);
    }, { twitch: { add } });
  });

  it("serializes concurrent grants for different users through the same runner", async () => {
    let finishFirstAdd: ((result: { ok: true }) => void) | undefined;
    let markFirstAddStarted: (() => void) | undefined;
    let markSecondAddStarted: (() => void) | undefined;
    const firstAddStarted = new Promise<void>((resolve) => { markFirstAddStarted = resolve; });
    const secondAddStarted = new Promise<void>((resolve) => { markSecondAddStarted = resolve; });
    const add = vi.fn((userId: string) => {
      if (userId === "user-1") {
        markFirstAddStarted?.();
        return new Promise<{ ok: true }>((resolve) => { finishFirstAdd = resolve; });
      }
      markSecondAddStarted?.();
      return Promise.resolve({ ok: true as const });
    });

    await inStore(async (store) => {
      const first = store.grant(grantInput({ operationId: "different-user-first" }));
      await firstAddStarted;
      const second = store.grant(grantInput({
        operationId: "different-user-second",
        person: { userId: "user-2", login: "viewer-two", displayName: "Viewer Two" },
      }));
      await Promise.resolve();
      expect(add).toHaveBeenCalledTimes(1);

      finishFirstAdd?.({ ok: true });
      expect((await first).status).toBe("granted");
      await secondAddStarted;
      expect((await second).status).toBe("granted");
      expect(add.mock.calls.map(([userId]) => userId)).toEqual(["user-1", "user-2"]);
    }, { twitch: { add } });
  });

  it("recovers a running grant interrupted before POST with GET then one POST", async () => {
    const input = grantInput({ operationId: "crash-before-post" });
    const get = vi.fn().mockResolvedValue({ ok: true, isVip: false });
    const add = vi.fn().mockResolvedValue({ ok: true });

    await inStore(async (store, state) => {
      insertInterruptedGrant(state.storage, input);
      await store.runExpiry();

      expect(get).toHaveBeenCalledTimes(1);
      expect(add).toHaveBeenCalledTimes(1);
      expect((await store.grant(input)).status).toBe("granted");
      expect(await store.list()).toMatchObject([{ expiresAt: "2026-11-02T12:00:00.000Z" }]);
      expect(state.storage.sql.exec<{ status: string; attempts: number }>(
        "SELECT status, attempts FROM temp_vip_ops WHERE operation_id = ?", input.operationId,
      ).one()).toMatchObject({ status: "done", attempts: 2 });
    }, { twitch: { get, add } });
  });

  it("does not adopt a permanent VIP when an interrupted grant has no confirmed precondition", async () => {
    const input = grantInput({ operationId: "crash-before-post-permanent-vip" });
    const get = vi.fn().mockResolvedValue({ ok: true, isVip: true });
    const add = vi.fn().mockResolvedValue({ ok: true });

    await inStore(async (store, state) => {
      insertInterruptedGrant(state.storage, input);
      await store.runExpiry();

      expect(operationResult(state.storage, input.operationId)).toMatchObject({ status: "already_vip" });
      expect(await store.list()).toEqual([]);
      expect(get).toHaveBeenCalledTimes(1);
      expect(add).not.toHaveBeenCalled();
    }, { twitch: { get, add } });
  });

  it("recovers after a successful POST by checking VIPs and does not grant twice on replay", async () => {
    const input = grantInput({ operationId: "crash-after-post" });
    const get = vi.fn().mockResolvedValue({ ok: true, isVip: true });
    const add = vi.fn().mockResolvedValue({ ok: true });

    await inStore(async (store, state) => {
      insertInterruptedGrant(state.storage, input, { precondition: "not_vip" });
      await store.runExpiry();

      const recovered = await store.grant(input);
      expect(recovered.status).toBe("granted");
      expect(await store.grant(input)).toEqual(recovered);
      expect(get).toHaveBeenCalledTimes(1);
      expect(add).not.toHaveBeenCalled();
      expect(await store.list()).toMatchObject([{ expiresAt: "2026-11-02T12:00:00.000Z" }]);
      expect(state.storage.sql.exec<{ status: string; result_json: string }>(
        "SELECT status, result_json FROM temp_vip_ops WHERE operation_id = ?", input.operationId,
      ).one()).toMatchObject({ status: "done" });
    }, { twitch: { get, add } });
  });

  it("recovers an interrupted extension after its regrant POST without extending twice", async () => {
    const input: ModuleTempVipExtendRequest = {
      operationId: "crash-after-extend-post",
      person,
      grantedBy: actor,
      durationMs: DAY,
      maximumRemainingMs: MAXIMUM,
      source: "dashboard",
    };
    const get = vi.fn().mockResolvedValue({ ok: true, isVip: true });
    const add = vi.fn().mockResolvedValue({ ok: true });

    await inStore(async (store, state) => {
      insertRow(state.storage, { removalFailedAt: BASE_NOW, removalAttempts: 1 });
      const payload = JSON.stringify({
        request: {
          person: input.person,
          grantedBy: input.grantedBy,
          durationMs: input.durationMs,
          maximumRemainingMs: input.maximumRemainingMs,
          source: input.source,
        },
        stage: "post",
        intentAt: BASE_NOW,
        precondition: "not_vip",
      });
      state.storage.transactionSync(() => {
        state.storage.sql.exec(
          `INSERT INTO temp_vip_ops
            (operation_id, kind, user_id, user_login, payload_json, status, attempts, next_attempt_at,
             result_json, created_at, finished_at)
           VALUES (?, 'extend', ?, ?, ?, 'running', 0, ?, NULL, ?, NULL)`,
          input.operationId,
          input.person.userId,
          input.person.login,
          payload,
          BASE_NOW,
          BASE_NOW,
        );
      });

      await store.runExpiry();

      const recovered = await store.extend(input);
      expect(recovered.status).toBe("extended");
      expect(await store.extend(input)).toEqual(recovered);
      expect(get).toHaveBeenCalledTimes(1);
      expect(add).not.toHaveBeenCalled();
      expect(await store.list()).toMatchObject([{ expiresAt: "2026-11-03T12:00:00.000Z", removalFailedAt: null }]);
    }, { twitch: { get, add } });
  });

  it("treats a not-VIP DELETE response as successful removal", async () => {
    const remove = vi.fn().mockResolvedValue({ ok: false, reason: "not_vip" });
    await inStore(async (store) => {
      await store.grant(grantInput({ operationId: "delete-422-seed" }));
      const result = await store.end({ operationId: "delete-422-not-vip", userId: person.userId });
      expect(result).toMatchObject({ status: "ended", reason: "ended_early" });
      expect(await store.list()).toEqual([]);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(pendingEvents(store).some((event) => event.code === "temp_vips.ended" && event.detail.reason === "ended_early")).toBe(true);
    }, { twitch: { remove } });
  });

  it("supersedes a failed removal when an extension is enqueued", async () => {
    const remove = vi.fn().mockResolvedValueOnce({ ok: false, reason: "network" }).mockResolvedValue({ ok: true });
    const get = vi.fn().mockResolvedValueOnce({ ok: true, isVip: false }).mockResolvedValue({ ok: true, isVip: true });

    await inStore(async (store, state) => {
      await store.grant(grantInput({ operationId: "supersede-seed" }));
      const ending = store.end({ operationId: "superseded-end", userId: person.userId });
      expect((await ending).status).toBe("queued");

      const extended = await store.extend({
        operationId: "superseding-extension",
        person,
        durationMs: DAY,
        maximumRemainingMs: MAXIMUM,
      });
      expect(extended.status).toBe("extended");
      expect(operationResult(state.storage, "superseded-end")).toEqual({ status: "superseded" });

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await store.runExpiry();
      expect(remove).toHaveBeenCalledTimes(1);
      expect(await store.list()).toMatchObject([{ removalFailedAt: null, expiresAt: "2026-11-03T12:00:00.000Z" }]);
    }, { twitch: { get, remove } });
  });

  it("settles stale removal verification during backoff before an extension", async () => {
    const remove = vi.fn(async (_userId: string, beforeAttempt: () => Promise<boolean>) =>
      await beforeAttempt()
        ? { ok: false as const, reason: "network" }
        : { ok: false as const, reason: "precondition_failed" });
    const get = vi.fn().mockResolvedValueOnce({ ok: true, isVip: false }).mockResolvedValue({ ok: true, isVip: true });

    await inStore(async (store, state) => {
      await store.grant(grantInput({ operationId: "verify-backoff-seed" }));
      expect((await store.end({ operationId: "verify-backoff-end", userId: person.userId })).status).toBe("queued");
      expect((await store.handleRemoved({
        triggerId: "verify-backoff-stale",
        userId: person.userId,
        eventSubTimestamp: "2026-11-01T11:59:00.000Z",
      })).status).toBe("queued");

      const extended = await store.extend({
        operationId: "verify-backoff-extend",
        person,
        durationMs: DAY,
        maximumRemainingMs: MAXIMUM,
      });

      expect(extended.status).toBe("extended");
      expect(operationResult(state.storage, "verify_removed:verify-backoff-stale").status).toBe("ignored_stale_echo");
      expect(operationResult(state.storage, "verify-backoff-end").status).toBe("superseded");
      expect(await store.list()).toMatchObject([{ removalFailedAt: null, expiresAt: "2026-11-03T12:00:00.000Z" }]);
      expect(remove).toHaveBeenCalledTimes(1);
      expect(get).toHaveBeenCalledTimes(2); // grant precondition + the extension's own lookup
    }, { twitch: { get, remove } });
  });

  it("keeps rejected extensions from superseding backoff removals and gives expiry attempts fresh ids", async () => {
    const deadlines: Array<number | null> = [];
    const get = vi.fn()
      .mockResolvedValueOnce({ ok: true, isVip: false })
      .mockResolvedValue({ ok: true, isVip: true });
    let removeCount = 0;
    const remove = vi.fn(async (_userId: string, beforeAttempt: () => Promise<boolean>) => {
      if (!await beforeAttempt()) return { ok: false as const, reason: "precondition_failed" };
      removeCount += 1;
      return removeCount === 1
        ? { ok: false as const, reason: "network" }
        : { ok: true as const };
    });

    await inStore(async (store, state) => {
      await store.grant(grantInput({ operationId: "rejected-extension-seed" }));
      const removal = { operationId: "rejected-extension-end", userId: person.userId };
      expect((await store.end(removal)).status).toBe("queued");

      const rejected = await store.extend({
        operationId: "rejected-extension",
        person,
        durationMs: MAXIMUM,
        maximumRemainingMs: MAXIMUM,
      });
      expect(rejected).toMatchObject({ status: "maximum_exceeded", allowedDurationMs: MAXIMUM - DAY });
      expect(state.storage.sql.exec<{ status: string; next_attempt_at: string }>(
        "SELECT status, next_attempt_at FROM temp_vip_ops WHERE operation_id = ?",
        removal.operationId,
      ).one()).toMatchObject({ status: "queued", next_attempt_at: "2026-11-01T12:05:00.000Z" });
      // No 1 ms spin: the next wake is the outbox retry, never an immediate alarm.
      expect(deadlines.at(-1)).toBeGreaterThanOrEqual(BASE_MS + 60_000);

      const expiredUser = "expired-user";
      const expiredAt = "2026-11-01T11:59:00.000Z";
      const oldExpiryId = `expire:${encodeURIComponent(expiredUser)}:${encodeURIComponent(expiredAt)}`;
      insertRow(state.storage, {
        userId: expiredUser,
        login: expiredUser,
        displayName: "Expired Viewer",
        expiresAt: expiredAt,
      });
      insertQueuedOperation(state.storage, {
        operationId: oldExpiryId,
        kind: "expire",
        userId: expiredUser,
        userLogin: expiredUser,
        request: { expectedExpiry: expiredAt },
        sequence: 100,
      });
      state.storage.transactionSync(() => state.storage.sql.exec(
        "UPDATE temp_vip_ops SET status = 'done', result_json = '{\"status\":\"ignored\"}', finished_at = ? WHERE operation_id = ?",
        BASE_NOW,
        oldExpiryId,
      ));

      await store.runExpiry();
      const expiryOperations = state.storage.sql.exec<{ operation_id: string; status: string }>(
        "SELECT operation_id, status FROM temp_vip_ops WHERE user_id = ? AND kind = 'expire' ORDER BY enqueue_sequence",
        expiredUser,
      ).toArray();
      expect(expiryOperations).toHaveLength(2);
      expect(expiryOperations[1]?.operation_id).not.toBe(oldExpiryId);
      expect(expiryOperations[1]?.status).toBe("done");
      expect(removeCount).toBe(2);

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await store.runExpiry();
      expect(operationResult(state.storage, removal.operationId)).toMatchObject({ status: "ended", reason: "ended_early" });
      expect(await store.list()).toEqual([]);
      expect(removeCount).toBe(3);
    }, {
      twitch: {
        get,
        add: vi.fn().mockResolvedValue({ ok: true }),
        remove,
      },
      scheduleAlarm: (deadline) => {
        deadlines.push(deadline);
        return Promise.resolve();
      },
    });
  });

  it("keeps later same-user commands behind an ambiguous grant while other users proceed", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ ok: true, isVip: false })
      .mockResolvedValueOnce({ ok: true, isVip: false })
      .mockResolvedValueOnce({ ok: true, isVip: true });
    const add = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "network", ambiguous: true })
      .mockResolvedValue({ ok: true });
    const remove = vi.fn().mockResolvedValue({ ok: true });

    await inStore(async (store) => {
      expect((await store.grant(grantInput({ operationId: "unresolved-grant" }))).status).toBe("queued");
      expect((await store.end({ operationId: "waits-for-grant", userId: person.userId })).status).toBe("queued");
      expect((await store.grant(grantInput({
        operationId: "other-user-proceeds",
        person: { userId: "user-2", login: "viewer-two", displayName: "Viewer Two" },
      }))).status).toBe("granted");
      expect(remove).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(60_000);
      await store.runExpiry();
      expect(await store.grant(grantInput({ operationId: "unresolved-grant" }))).toMatchObject({ status: "granted" });
      expect(await store.end({ operationId: "waits-for-grant", userId: person.userId })).toMatchObject({
        status: "ended", reason: "ended_early",
      });
      expect(remove).toHaveBeenCalledTimes(1);
    }, { twitch: { get, add, remove } });
  });

  it("uses enqueue sequence to preserve order when operation timestamps tie", async () => {
    const remove = vi.fn().mockResolvedValue({ ok: true });

    await inStore(async (store, state) => {
      const input = grantInput({ operationId: "z-first-grant" });
      const grantPayload = {
        person: input.person,
        grantedBy: input.grantedBy,
        durationMs: input.durationMs,
        maximumRemainingMs: input.maximumRemainingMs,
        source: input.source,
      };
      insertQueuedOperation(state.storage, {
        operationId: "z-first-grant",
        kind: "grant",
        userId: person.userId,
        userLogin: person.login,
        request: grantPayload,
        sequence: 1,
      });
      insertQueuedOperation(state.storage, {
        operationId: "a-second-end",
        kind: "end",
        userId: person.userId,
        userLogin: person.login,
        request: { userId: person.userId },
        sequence: 2,
      });

      await store.runExpiry();

      expect(operationResult(state.storage, "z-first-grant").status).toBe("granted");
      expect(operationResult(state.storage, "a-second-end")).toMatchObject({ status: "ended", reason: "ended_early" });
      expect(remove).toHaveBeenCalledTimes(1);
      expect(await store.list()).toEqual([]);
    }, { twitch: { remove } });
  });

  it("reconciles interrupted removals before issuing another DELETE", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ ok: true, isVip: false })
      .mockResolvedValueOnce({ ok: false, reason: "network" })
      .mockResolvedValueOnce({ ok: true, isVip: false });
    const remove = vi.fn().mockResolvedValue({ ok: true });

    await inStore(async (store, state) => {
      insertRow(state.storage);
      insertQueuedOperation(state.storage, {
        operationId: "interrupted-removal",
        kind: "end",
        userId: person.userId,
        userLogin: person.login,
        request: { userId: person.userId },
        sequence: 1,
        status: "running",
      });

      await store.runExpiry();

      expect(get).toHaveBeenCalledTimes(1);
      expect(remove).not.toHaveBeenCalled();
      expect(operationResult(state.storage, "interrupted-removal")).toMatchObject({ status: "ended", reason: "ended_early" });
      expect(await store.list()).toEqual([]);

      insertRow(state.storage, { userId: "user-2", login: "viewer-two", displayName: "Viewer Two" });
      insertQueuedOperation(state.storage, {
        operationId: "interrupted-removal-check-fails",
        kind: "end",
        userId: "user-2",
        userLogin: "viewer-two",
        request: { userId: "user-2" },
        sequence: 2,
        status: "running",
      });
      await store.runExpiry();

      expect(remove).not.toHaveBeenCalled();
      expect(state.storage.sql.exec<{ status: string; next_attempt_at: string; needs_reconcile: number }>(
        "SELECT status, next_attempt_at, needs_reconcile FROM temp_vip_ops WHERE operation_id = 'interrupted-removal-check-fails'",
      ).one()).toMatchObject({ status: "queued", next_attempt_at: "2026-11-01T12:01:00.000Z", needs_reconcile: 1 });
      expect(await store.list()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(60_000);
      await store.runExpiry();
      expect(get).toHaveBeenCalledTimes(3);
      expect(remove).not.toHaveBeenCalled();
      expect(operationResult(state.storage, "interrupted-removal-check-fails")).toMatchObject({
        status: "ended",
        reason: "ended_early",
      });
      expect(await store.list()).toEqual([]);
    }, { twitch: { get, remove } });
  });

  it("backs failed removals off by five, fifteen, then sixty minutes", async () => {
    const remove = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "rate_limited" })
      .mockResolvedValueOnce({ ok: false, reason: "network" })
      .mockResolvedValueOnce({ ok: false, reason: "unknown_status" })
      .mockResolvedValue({ ok: true });

    await inStore(async (store, state) => {
      await store.grant(grantInput({ operationId: "backoff-seed" }));
      const request = { operationId: "backoff-end", userId: person.userId };

      expect((await store.end(request)).status).toBe("queued");
      expect(await store.list()).toMatchObject([{ removalAttempts: 1, removalFailedAt: BASE_NOW, endReason: "ended_early" }]);
      expect(state.storage.sql.exec<{ next_attempt_at: string }>(
        "SELECT next_attempt_at FROM temp_vip_ops WHERE operation_id = ?", request.operationId,
      ).one().next_attempt_at).toBe("2026-11-01T12:05:00.000Z");

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await store.runExpiry();
      expect(await store.list()).toMatchObject([{ removalAttempts: 2, removalFailedAt: "2026-11-01T12:05:00.000Z" }]);
      expect(state.storage.sql.exec<{ next_attempt_at: string }>(
        "SELECT next_attempt_at FROM temp_vip_ops WHERE operation_id = ?", request.operationId,
      ).one().next_attempt_at).toBe("2026-11-01T12:20:00.000Z");

      await vi.advanceTimersByTimeAsync(15 * 60_000);
      await store.runExpiry();
      expect(await store.list()).toMatchObject([{ removalAttempts: 3, removalFailedAt: "2026-11-01T12:20:00.000Z" }]);
      expect(state.storage.sql.exec<{ next_attempt_at: string }>(
        "SELECT next_attempt_at FROM temp_vip_ops WHERE operation_id = ?", request.operationId,
      ).one().next_attempt_at).toBe("2026-11-01T13:20:00.000Z");

      await vi.advanceTimersByTimeAsync(60 * 60_000);
      await store.runExpiry();
      expect(await store.end(request)).toMatchObject({ status: "ended", reason: "ended_early" });
      expect(await store.list()).toEqual([]);
      expect(remove).toHaveBeenCalledTimes(4);
    }, { twitch: { remove } });
  });

  it("caps slow failed expiries at ten removals per queue drain", async () => {
    const starts: number[] = [];
    const remove = vi.fn(async (_userId: string, beforeAttempt: () => Promise<boolean>) => {
      if (!await beforeAttempt()) return { ok: false as const, reason: "precondition_failed" };
      starts.push(Date.now());
      await new Promise<void>((resolve) => setTimeout(resolve, 1_200));
      return { ok: false as const, reason: "network" };
    });

    await inStore(async (store, state) => {
      for (let index = 0; index < 12; index += 1) {
        insertRow(state.storage, {
          userId: `expiry-${String(index)}`,
          login: `expiry-${String(index)}`,
          displayName: `Expiry ${String(index)}`,
          expiresAt: "2026-11-01T11:59:00.000Z",
        });
      }
      const run = store.runExpiry();
      await vi.advanceTimersByTimeAsync(30_000);
      await run;

      expect(remove).toHaveBeenCalledTimes(10);
      for (let start = 0; start < starts.length; start += 1) {
        const windowStart = starts[start];
        if (windowStart === undefined) continue;
        const inWindow = starts.filter((at) => at > windowStart - 10_000 && at <= windowStart);
        expect(inWindow.length).toBeLessThanOrEqual(10);
      }
      const recorded = state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM temp_vip_mutation_attempts",
      ).one().count;
      expect(recorded).toBeLessThanOrEqual(10);
    }, { twitch: { remove } });
  });

  it("stops the first slow expiry invocation after ten of twenty removals", async () => {
    const remove = vi.fn(async (_userId: string, beforeAttempt: () => Promise<boolean>) => {
      if (!await beforeAttempt()) return { ok: false as const, reason: "precondition_failed" };
      await new Promise<void>((resolve) => setTimeout(resolve, 1_200));
      return { ok: false as const, reason: "network" };
    });

    await inStore(async (store, state) => {
      for (let index = 0; index < 20; index += 1) {
        insertRow(state.storage, {
          userId: `slow-expiry-${String(index)}`,
          login: `slow-expiry-${String(index)}`,
          displayName: `Slow Expiry ${String(index)}`,
          expiresAt: "2026-11-01T11:59:00.000Z",
        });
      }

      const run = store.runExpiry();
      await vi.advanceTimersByTimeAsync(30_000);
      await run;

      expect(remove).toHaveBeenCalledTimes(10);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM temp_vip_ops WHERE kind = 'expire' AND status = 'queued'",
      ).one().count).toBe(20);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM temp_vip_ops WHERE kind = 'expire' AND status = 'queued' AND next_attempt_at > ?",
        BASE_NOW,
      ).one().count).toBe(10);
    }, { twitch: { remove } });
  });

  it("counts token-refresh retry DELETEs against the ten-removal drain cap", async () => {
    let deletes = 0;
    const remove = vi.fn(async (userId: string, beforeAttempt: () => Promise<boolean>) => {
      // Simulates withBroadcasterToken: a 401 triggers a refresh and a second DELETE.
      const attempts = Number(userId.slice("refresh-".length)) < 4 ? 2 : 1;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (!await beforeAttempt()) return { ok: false as const, reason: "precondition_failed" };
        deletes += 1;
        await new Promise<void>((resolve) => setTimeout(resolve, 1_200));
      }
      return { ok: false as const, reason: "network" };
    });

    await inStore(async (store, state) => {
      for (let index = 0; index < 10; index += 1) {
        insertRow(state.storage, {
          userId: `refresh-${String(index)}`,
          login: `refresh-${String(index)}`,
          displayName: `Refresh ${String(index)}`,
          expiresAt: "2026-11-01T11:59:00.000Z",
        });
      }

      const run = store.runExpiry();
      await vi.advanceTimersByTimeAsync(60_000);
      await run;

      expect(deletes).toBeLessThanOrEqual(10);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM temp_vip_ops WHERE kind = 'expire' AND status = 'queued'",
      ).one().count).toBeGreaterThan(0);
    }, { twitch: { remove } });
  });

  it("does not admit an eleventh immediate failed expiry before the ten-second window clears", async () => {
    const remove = vi.fn(async (_userId: string, beforeAttempt: () => Promise<boolean>) =>
      await beforeAttempt()
        ? { ok: false as const, reason: "network" }
        : { ok: false as const, reason: "precondition_failed" });
    await inStore(async (store, state) => {
      for (let index = 0; index < 11; index += 1) {
        insertRow(state.storage, {
          userId: `paced-${String(index)}`,
          login: `paced-${String(index)}`,
          displayName: `Paced ${String(index)}`,
          expiresAt: "2026-11-01T11:59:00.000Z",
        });
      }

      await store.runExpiry();
      expect(remove).toHaveBeenCalledTimes(10);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM temp_vip_ops WHERE kind = 'expire' AND status = 'queued' AND next_attempt_at = ?",
        BASE_NOW,
      ).one().count).toBe(1);

      await store.runExpiry();
      expect(remove).toHaveBeenCalledTimes(11);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM temp_vip_ops WHERE kind = 'expire' AND status = 'queued' AND next_attempt_at = '2026-11-01T12:00:10.000Z'",
      ).one().count).toBe(1);

      await vi.advanceTimersByTimeAsync(10_000);
      await store.runExpiry();
      expect(remove).toHaveBeenCalledTimes(12);
    }, { twitch: { remove } });
  });

  it("keeps a durable alarm deadline for due queued work while the runner is active", async () => {
    let finishAdd: ((result: { ok: true }) => void) | undefined;
    let markAddStarted: (() => void) | undefined;
    const addStarted = new Promise<void>((resolve) => { markAddStarted = resolve; });
    const deadlines: Array<number | null> = [];
    const add = vi.fn((userId: string) => {
      if (userId === person.userId) {
        markAddStarted?.();
        return new Promise<{ ok: true }>((resolve) => { finishAdd = resolve; });
      }
      return Promise.resolve({ ok: true as const });
    });

    await inStore(async (store) => {
      const first = store.grant(grantInput({ operationId: "alarm-runner-first" }));
      await addStarted;
      const queued = store.grant(grantInput({
        operationId: "alarm-runner-queued",
        person: { userId: "user-2", login: "viewer-two", displayName: "Viewer Two" },
      }));
      await vi.advanceTimersByTimeAsync(10_001);
      expect((await queued).status).toBe("queued");
      expect(deadlines.at(-1)).not.toBeNull();
      expect(deadlines.at(-1) as number).toBeLessThanOrEqual(BASE_MS + 30_000);

      finishAdd?.({ ok: true });
      // The caller wait (10s) elapsed while the Helix call was still pending.
      expect((await first).status).toBe("queued");
      expect((await store.grant(grantInput({
        operationId: "alarm-runner-queued",
        person: { userId: "user-2", login: "viewer-two", displayName: "Viewer Two" },
      }))).status).toBe("granted");
    }, {
      twitch: { add },
      scheduleAlarm: (deadline) => {
        deadlines.push(deadline);
        return Promise.resolve();
      },
    });
  });

  it("rearms remaining expiry work after the ten-removal batch limit", async () => {
    const deadlines: Array<number | null> = [];
    const remove = vi.fn(async (_userId: string, beforeAttempt: () => Promise<boolean>) =>
      await beforeAttempt()
        ? { ok: false as const, reason: "network" }
        : { ok: false as const, reason: "precondition_failed" });

    await inStore(async (store, state) => {
      for (let index = 0; index < 11; index += 1) {
        insertRow(state.storage, {
          userId: `alarm-paced-${String(index)}`,
          login: `alarm-paced-${String(index)}`,
          displayName: `Alarm Paced ${String(index)}`,
          expiresAt: "2026-11-01T11:59:00.000Z",
        });
      }

      await store.runExpiry();

      expect(remove).toHaveBeenCalledTimes(10);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM temp_vip_mutation_attempts",
      ).one().count).toBe(10);
      expect(deadlines.at(-1)).toBe(BASE_MS + 1);
    }, {
      twitch: { remove },
      scheduleAlarm: (deadline) => {
        deadlines.push(deadline);
        return Promise.resolve();
      },
    });
  });

  it("reserves pacing for each issued Helix mutation attempt, including a 401 retry", async () => {
    let actualAttemptsForRetryingGrant = 0;
    const add = vi.fn(async (userId: string, beforeAttempt: () => Promise<boolean>) => {
      if (userId !== "retrying-user") {
        expect(await beforeAttempt()).toBe(true);
        return { ok: true as const };
      }
      if (!await beforeAttempt()) return { ok: false as const, reason: "precondition_failed" };
      actualAttemptsForRetryingGrant += 1;
      // The first issued request gets a 401. Token refresh happens before this second reservation.
      if (!await beforeAttempt()) return { ok: false as const, reason: "precondition_failed" };
      actualAttemptsForRetryingGrant += 1;
      return { ok: true as const };
    });
    const get = vi.fn().mockResolvedValue({ ok: true, isVip: false });

    await inStore(async (store, state) => {
      for (let index = 0; index < 9; index += 1) {
        const input = grantInput({
          operationId: `paced-grant-${String(index)}`,
          person: { userId: `paced-user-${String(index)}`, login: `paced-${String(index)}`, displayName: `Paced ${String(index)}` },
        });
        expect((await store.grant(input)).status).toBe("granted");
      }

      expect((await store.grant(grantInput({
        operationId: "401-retry-pacing",
        person: { userId: "retrying-user", login: "retrying", displayName: "Retrying" },
      }))).status).toBe("queued");
      expect(actualAttemptsForRetryingGrant).toBe(1);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM temp_vip_mutation_attempts",
      ).one().count).toBe(10);
      expect(state.storage.sql.exec<{ next_attempt_at: string }>(
        "SELECT next_attempt_at FROM temp_vip_ops WHERE operation_id = '401-retry-pacing'",
      ).one().next_attempt_at).toBe("2026-11-01T12:00:10.000Z");
    }, { twitch: { get, add } });
  });

  it("ignores stale EventSub echoes, removes manual departures, and keeps VIPs still present", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ ok: true, isVip: false })
      .mockResolvedValueOnce({ ok: true, isVip: false })
      .mockResolvedValueOnce({ ok: true, isVip: false })
      .mockResolvedValueOnce({ ok: true, isVip: false })
      .mockResolvedValueOnce({ ok: true, isVip: true });

    await inStore(async (store, state) => {
      await store.grant(grantInput({ operationId: "eventsub-first-grant" }));
      await store.release({ operationId: "eventsub-release", userId: person.userId });
      await vi.advanceTimersByTimeAsync(1_000);
      await store.grant(grantInput({ operationId: "eventsub-second-grant" }));

      const stale = await store.handleRemoved({
        triggerId: "stale-removal-echo",
        userId: person.userId,
        eventSubTimestamp: BASE_NOW,
      });
      expect(stale.status).toBe("queued");
      expect(state.storage.sql.exec<{ kind: string; status: string }>(
        "SELECT kind, status FROM temp_vip_ops WHERE operation_id = 'verify_removed:stale-removal-echo'",
      ).one()).toMatchObject({ kind: "verify_removed" });
      await store.runExpiry();
      expect(operationResult(state.storage, "verify_removed:stale-removal-echo").status).toBe("ignored_stale_echo");
      expect(get).toHaveBeenCalledTimes(2);
      expect(await store.list()).toHaveLength(1);

      const manual = await store.handleRemoved({
        triggerId: "real-manual-removal",
        userId: person.userId,
        eventSubTimestamp: new Date().toISOString(),
      });
      expect(manual.status).toBe("queued");
      await store.runExpiry();
      expect(operationResult(state.storage, "verify_removed:real-manual-removal").status).toBe("removed_on_twitch");
      expect(await store.list()).toEqual([]);
      expect(pendingEvents(store).some((event) => event.code === "temp_vips.ended" && event.detail.reason === "removed_on_twitch")).toBe(true);

      await store.grant(grantInput({ operationId: "eventsub-third-grant" }));
      const stillVip = await store.handleRemoved({
        triggerId: "manual-removal-still-vip",
        userId: person.userId,
        eventSubTimestamp: new Date().toISOString(),
      });
      expect(stillVip.status).toBe("queued");
      await store.runExpiry();
      expect(operationResult(state.storage, "verify_removed:manual-removal-still-vip").status).toBe("ignored_stale_event");
      expect(await store.list()).toHaveLength(1);
      expect(get).toHaveBeenCalledTimes(5);
    }, { twitch: { get } });
  });

  it("extends an overdue row from now and refuses a total above the maximum", async () => {
    await inStore(async (store) => {
      await store.grant(grantInput({ operationId: "overdue-seed", durationMs: 60_000 }));
      await vi.advanceTimersByTimeAsync(3 * DAY);
      const extended = await store.extend({
        operationId: "overdue-extend",
        person,
        durationMs: DAY,
        maximumRemainingMs: MAXIMUM,
      });
      expect(extended.status).toBe("extended");
      expect(await store.list()).toMatchObject([{ expiresAt: "2026-11-05T12:00:00.000Z" }]);

      const refused = await store.extend({
        operationId: "max-exceeded",
        person,
        durationMs: 90 * DAY,
        maximumRemainingMs: 90 * DAY,
      });
      expect(refused).toMatchObject({ status: "maximum_exceeded", allowedDurationMs: 89 * DAY });
      expect(await store.list()).toMatchObject([{ expiresAt: "2026-11-05T12:00:00.000Z" }]);
    });
  });

  it("checks Twitch when importing and supports both present and absent VIPs", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ ok: true, isVip: true })
      .mockResolvedValueOnce({ ok: true, isVip: false });

    await inStore(async (store) => {
      const imported: ModuleTempVipImportRequest = {
        ...grantInput({ operationId: "import-existing", source: "import", durationMs: 2 * DAY }),
        source: "import",
      };
      expect((await store.importExisting(imported)).status).toBe("imported");
      expect((await store.importExisting({ ...imported, operationId: "import-no-longer-vip", person: {
        userId: "user-2", login: "viewer-two", displayName: "Viewer Two",
      } })).status).toBe("not_vip");
      expect(await store.list()).toMatchObject([{ source: "import", expiresAt: "2026-11-03T12:00:00.000Z" }]);
      expect(get).toHaveBeenCalledTimes(2);
      expect(pendingEvents(store)).toContainEqual(expect.objectContaining({ code: "temp_vips.imported" }));
    }, { twitch: { get } });
  });

  it("releases management without removing the Twitch VIP", async () => {
    const remove = vi.fn().mockResolvedValue({ ok: true });
    await inStore(async (store) => {
      await store.grant(grantInput({ operationId: "release-seed" }));
      const result = await store.release({ operationId: "release-management", userId: person.userId });
      expect(result.status).toBe("released");
      expect(await store.list()).toEqual([]);
      expect(remove).not.toHaveBeenCalled();
      expect(pendingEvents(store)).toContainEqual(expect.objectContaining({ code: "temp_vips.released" }));
    }, { twitch: { remove } });
  });

  it("cancels a queued removal retry when releasing management", async () => {
    let removeCount = 0;
    const remove = vi.fn(async (_userId: string, beforeAttempt: () => Promise<boolean>) => {
      if (!await beforeAttempt()) return { ok: false as const, reason: "precondition_failed" };
      removeCount += 1;
      return { ok: false as const, reason: "network" };
    });

    await inStore(async (store, state) => {
      await store.grant(grantInput({ operationId: "release-retry-seed" }));
      expect((await store.end({ operationId: "release-retry-end", userId: person.userId })).status).toBe("queued");
      expect(removeCount).toBe(1);

      expect(await store.release({ operationId: "release-retry", userId: person.userId })).toMatchObject({ status: "released" });
      expect(operationResult(state.storage, "release-retry-end")).toEqual({ status: "superseded" });
      expect(await store.list()).toEqual([]);

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await store.runExpiry();
      expect(remove).toHaveBeenCalledTimes(1);
      expect(removeCount).toBe(1);
    }, { twitch: { remove } });
  });

  it("writes stable outbox ids and retains completed operation results for 24 hours", async () => {
    await inStore(async (store, state) => {
      const input = grantInput({ operationId: "retained-result" });
      const first = await store.grant(input);
      const replay = await store.grant(input);
      expect(replay).toEqual(first);

      const initialEvents = pendingEvents(store);
      expect(initialEvents).toHaveLength(1);
      expect(initialEvents[0]?.eventId).toContain(":retained-result:0");
      expect(initialEvents[0]?.code).toBe("temp_vips.granted");
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM temp_vip_ops WHERE operation_id = 'retained-result' AND status = 'done'",
      ).one().count).toBe(1);

      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 + 1);
      const afterRetention = await store.grant(input);
      expect(afterRetention.status).toBe("extended");
      expect(await store.list()).toMatchObject([{ expiresAt: "2026-11-03T12:00:00.001Z" }]);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM temp_vip_ops WHERE operation_id = 'retained-result'",
      ).one().count).toBe(1);
    });
  });

  it("serializes a disable after an in-flight grant and reports the active row", async () => {
    let finishAdd: ((result: { ok: true } | { ok: false; reason: string; ambiguous?: boolean }) => void) | undefined;
    let markAddStarted: (() => void) | undefined;
    const addStarted = new Promise<void>((resolve) => { markAddStarted = resolve; });
    let addCount = 0;
    const add = vi.fn(() => {
      addCount += 1;
      if (addCount > 1) return Promise.resolve({ ok: true as const });
      markAddStarted?.();
      return new Promise<{ ok: true } | { ok: false; reason: string; ambiguous?: boolean }>((resolve) => { finishAdd = resolve; });
    });
    let moduleEnabled = true;
    const commitModuleDisable = vi.fn(({ expectedRevision }: { expectedRevision: number }) => {
      moduleEnabled = false;
      return Promise.resolve({ revision: expectedRevision + 1, lastDisabledRevision: expectedRevision + 1 });
    });

    await inStore(async (store, state) => {
      const pendingGrant = store.grant(grantInput({ operationId: "disable-pending-post" }));
      await addStarted;
      expect(state.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM temp_vips").one().count).toBe(0);
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM temp_vip_ops WHERE kind = 'grant' AND status != 'done'",
      ).one().count).toBe(1);
      expect(JSON.parse(state.storage.sql.exec<{ payload_json: string }>(
        "SELECT payload_json FROM temp_vip_ops WHERE operation_id = 'disable-pending-post'",
      ).one().payload_json)).toMatchObject({ precondition: "not_vip" });

      const disabling = store.disableModule({
        operationId: "disable-after-in-flight-grant",
        actor: { userId: actor.userId, sessionId: "session-1" },
        expectedRevision: 1,
      });
      finishAdd?.({ ok: false, reason: "network", ambiguous: true });
      expect((await pendingGrant).status).toBe("queued");
      expect((await disabling).status).toBe("temp_vips_active");
      expect(moduleEnabled).toBe(true);
      expect(await store.list()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(60_000);
      await store.runExpiry();
      expect(operationResult(state.storage, "disable-pending-post").status).toBe("granted");

      const blocked = await store.disableModule({
        operationId: "disable-with-active-row",
        actor: { userId: actor.userId, sessionId: "session-1" },
        expectedRevision: 1,
      });
      expect(blocked.status).toBe("temp_vips_active");
      expect(moduleEnabled).toBe(true);
      expect(await store.list()).toHaveLength(1);
      expect(commitModuleDisable).not.toHaveBeenCalled();
    }, { twitch: { add }, isModuleEnabled: () => Promise.resolve(moduleEnabled), commitModuleDisable });
  });

  it("commits disable before a racing grant and makes that grant re-read module state", async () => {
    let finishDisable: (() => void) | undefined;
    let markDisableStarted: (() => void) | undefined;
    const disableStarted = new Promise<void>((resolve) => { markDisableStarted = resolve; });
    let moduleEnabled = true;
    const commitModuleDisable = vi.fn(async ({ expectedRevision }: { expectedRevision: number }) => {
      markDisableStarted?.();
      await new Promise<void>((resolve) => { finishDisable = resolve; });
      moduleEnabled = false;
      return { revision: expectedRevision + 1, lastDisabledRevision: expectedRevision + 1 };
    });
    const add = vi.fn().mockResolvedValue({ ok: true });

    await inStore(async (store, state) => {
      const disabling = store.disableModule({
        operationId: "disable-before-racing-grant",
        actor: { userId: actor.userId, sessionId: "session-1" },
        expectedRevision: 1,
      });
      await disableStarted;
      const grant = store.grant(grantInput({ operationId: "grant-after-disable-enqueue" }));
      await Promise.resolve();
      finishDisable?.();

      expect(await disabling).toMatchObject({ status: "disabled", revision: 2, lastDisabledRevision: 2 });
      expect((await grant).status).toBe("module_disabled");
      expect(moduleEnabled).toBe(false);
      expect(await store.list()).toEqual([]);
      expect(add).not.toHaveBeenCalled();
      expect(state.storage.sql.exec<{ count: number }>(
        "SELECT COUNT(*) AS count FROM temp_vip_ops WHERE kind = 'disable_module' AND status = 'done'",
      ).one().count).toBe(1);
    }, {
      twitch: { add },
      isModuleEnabled: () => Promise.resolve(moduleEnabled),
      commitModuleDisable,
    });
  });

  it("returns a bounded queued result while a Twitch request is still running", async () => {
    let finishAdd: ((result: { ok: true }) => void) | undefined;
    let markAddStarted: (() => void) | undefined;
    const addStarted = new Promise<void>((resolve) => { markAddStarted = resolve; });
    const add = vi.fn(() => {
      markAddStarted?.();
      return new Promise<{ ok: true }>((resolve) => { finishAdd = resolve; });
    });

    await inStore(async (store, state) => {
      const pending = store.grant(grantInput({ operationId: "bounded-wait" }));
      await addStarted;
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await pending).toMatchObject({ status: "queued" });
      expect(state.storage.sql.exec<{ status: string }>(
        "SELECT status FROM temp_vip_ops WHERE operation_id = 'bounded-wait'",
      ).one().status).toBe("running");

      finishAdd?.({ ok: true });
      expect((await store.grant(grantInput({ operationId: "bounded-wait" }))).status).toBe("granted");
    }, { twitch: { add } });
  });

  it("rearms a consumed ChannelObject temp-VIP alarm to the next future expiry", async () => {
    const id = channelId();
    const stub = namespace.get(namespace.idFromName(id));

    await runInDurableObject(stub, async (instance, state) => {
      createStore(state, { channelId: id });
      const nextExpiry = "2026-11-02T12:00:00.000Z";
      insertRow(state.storage, { expiresAt: nextExpiry });
      await state.storage.put("channel:alarm_schedule", {
        "temp-vips:expiry": {
          deadline: BASE_MS - 1,
          handler: "channel.temp_vip_expiry",
          revision: 1,
        },
      });

      const channelObject = instance as unknown as {
        runTempVipExpiry: (now: string) => Promise<unknown>;
      };
      await channelObject.runTempVipExpiry(BASE_NOW);

      const table = await state.storage.get<Record<string, { deadline: number }>>("channel:alarm_schedule");
      expect(table?.["temp-vips:expiry"]?.deadline).toBe(Date.parse(nextExpiry));
    });
  });
});
