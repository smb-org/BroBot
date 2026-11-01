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
import { TempVipStore, type TempVipTwitch } from "../../src/worker/durable/temp-vips";

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
} = {}): TempVipStore => new TempVipStore(state.storage, {
  channelId: options.channelId ?? "temp-vips-test",
  now: () => new Date().toISOString(),
  twitch: {
    get: options.twitch?.get ?? vi.fn().mockResolvedValue({ ok: true, isVip: false }),
    add: options.twitch?.add ?? vi.fn().mockResolvedValue({ ok: true }),
    remove: options.twitch?.remove ?? vi.fn().mockResolvedValue({ ok: true }),
  },
  scheduleAlarm: options.scheduleAlarm ?? vi.fn().mockResolvedValue(undefined),
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
  options: { status?: "running" | "queued"; attempts?: number; at?: string } = {},
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
      ).one()).toMatchObject({ status: "done", attempts: 3 });
    }, { twitch: { get, add } });
  });

  it("recovers after a successful POST by checking VIPs and does not grant twice on replay", async () => {
    const input = grantInput({ operationId: "crash-after-post" });
    const get = vi.fn().mockResolvedValue({ ok: true, isVip: true });
    const add = vi.fn().mockResolvedValue({ ok: true });

    await inStore(async (store, state) => {
      insertInterruptedGrant(state.storage, input);
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

  it("keeps slow failed expiries within the rolling mutation limit", async () => {
    const starts: number[] = [];
    const remove = vi.fn(async () => {
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

      expect(remove).toHaveBeenCalledTimes(12);
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

  it("does not admit an eleventh immediate failed expiry before the ten-second window clears", async () => {
    const remove = vi.fn().mockResolvedValue({ ok: false, reason: "network" });
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
        "SELECT COUNT(*) AS count FROM temp_vip_ops WHERE kind = 'expire' AND status = 'queued' AND next_attempt_at = '2026-11-01T12:00:10.000Z'",
      ).one().count).toBe(1);

      await vi.advanceTimersByTimeAsync(10_000);
      await store.runExpiry();
      expect(remove).toHaveBeenCalledTimes(11);
    }, { twitch: { remove } });
  });

  it("ignores stale EventSub echoes, removes manual departures, and keeps VIPs still present", async () => {
    const get = vi.fn()
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
      expect(get).not.toHaveBeenCalled();
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
      expect(get).toHaveBeenCalledTimes(2);
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
