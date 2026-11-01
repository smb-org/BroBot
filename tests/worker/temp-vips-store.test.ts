import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TempVipStore, type TempVipTwitch } from "../../src/worker/durable/temp-vips";

const namespace = (env as unknown as { CHANNEL: Env["CHANNEL"] }).CHANNEL;
let serial = 0;
const channelId = (): string => `temp-vips-${String(++serial)}`;

const person = { userId: "user-1", login: "viewer", displayName: "Viewer" };
const actor = { userId: "mod-1", login: "moderator" };

const createStore = (state: DurableObjectState, options: {
  now?: () => string;
  twitch?: Partial<TempVipTwitch>;
  scheduleAlarm?: (deadline: number | null) => Promise<void>;
} = {}): TempVipStore => new TempVipStore(state.storage, {
  channelId: "temp-vips-test",
  now: options.now ?? (() => "2026-11-01T12:00:00.000Z"),
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
  const stub = namespace.get(namespace.idFromName(channelId()));
  return runInDurableObject(stub, async (_instance, state) => action(createStore(state, options), state));
};

afterEach(() => vi.restoreAllMocks());

describe("temporary VIP store", () => {
  it("grants a new VIP and writes a stable outbox entry", async () => {
    await inStore(async (store, state) => {
      const result = await store.grant({
        operationId: "grant-1", person, grantedBy: actor, durationMs: 7 * 86_400_000,
        maximumRemainingMs: 90 * 86_400_000, source: "command",
      });

      expect(result.status).toBe("granted");
      expect(await store.list()).toMatchObject([{ userId: person.userId, expiresAt: "2026-11-08T12:00:00.000Z", source: "command", grantGeneration: 1 }]);
      const outbox = state.storage.sql.exec<{ event_id: string; code: string }>(
        "SELECT event_id, code FROM temp_vip_outbox ORDER BY event_id",
      ).toArray();
      expect(outbox).toHaveLength(1);
      expect(outbox[0]?.code).toBe("temp_vips.granted");
      expect(outbox[0]?.event_id).toContain("grant-1");
    });
  });

  it("keeps a regrant request unsettled until its new generation finishes", async () => {
    const input = {
      operationId: "regrant-after-failed-removal",
      person,
      grantedBy: actor,
      durationMs: 86_400_000,
      maximumRemainingMs: 90 * 86_400_000,
      source: "command" as const,
    };
    await inStore(async (store, state) => {
      await store.grant({ ...input, operationId: "regrant-seed" });
      state.storage.sql.exec("UPDATE temp_vips SET removal_failed_at = ? WHERE user_id = ?", "2026-11-01T11:59:00.000Z", person.userId);

      const granted = await store.grant(input);
      const replay = await store.grant(input);
      expect(granted.status).toBe("granted");
      expect(replay).toEqual(granted);
      expect(state.storage.sql.exec<{ kind: string; generation: number }>(
        "SELECT kind, generation FROM temp_vip_operations WHERE request_id = ? ORDER BY generation, kind",
        input.operationId,
      ).toArray()).toEqual([
        { kind: "grant_check", generation: 1 },
        { kind: "grant_add", generation: 2 },
      ]);
      expect(JSON.parse(state.storage.sql.exec<{ result_json: string }>(
        "SELECT result_json FROM temp_vip_requests WHERE operation_id = ?", input.operationId,
      ).one().result_json)).toMatchObject({ status: "granted" });
    }, {
      twitch: {
        get: vi.fn().mockResolvedValue({ ok: true, isVip: false }),
        add: vi.fn().mockResolvedValue({ ok: true }),
      },
    });
  });

  it("holds a per-person grant lock while a Twitch call is in flight", async () => {
    let finishLookup: ((value: { ok: true; isVip: boolean }) => void) | undefined;
    const lookup = new Promise<{ ok: true; isVip: boolean }>((resolve) => { finishLookup = resolve; });
    await inStore(async (store) => {
      const firstStore = store;
      const first = firstStore.grant({
        operationId: "grant-first", person, grantedBy: actor, durationMs: 86_400_000,
        maximumRemainingMs: 90 * 86_400_000, source: "command",
      });
      await Promise.resolve();
      const second = await firstStore.grant({
        operationId: "grant-second", person, grantedBy: actor, durationMs: 86_400_000,
        maximumRemainingMs: 90 * 86_400_000, source: "command",
      });
      expect(second.status).toBe("busy");
      finishLookup?.({ ok: true, isVip: false });
      await first;
    }, { twitch: { get: vi.fn(() => lookup) } });
  });

  it("keeps an unknown grant locked until Get VIPs recovery settles it", async () => {
    await inStore(async (store, state) => {
      const uncertain = await store.grant({
        operationId: "grant-unknown", person, grantedBy: actor, durationMs: 86_400_000,
        maximumRemainingMs: 90 * 86_400_000, source: "command",
      });
      expect(uncertain.status).toBe("grant_unknown");
      const row = await store.list();
      expect(row[0]?.status).toBe("grant_unknown");

      const retry = await store.grant({
        operationId: "grant-retry", person, grantedBy: actor, durationMs: 86_400_000,
        maximumRemainingMs: 90 * 86_400_000, source: "command",
      });
      expect(retry.status).toBe("busy");

      const recovered = await store.runExpiry("2026-11-01T12:01:00.000Z");
      expect(recovered.recoveredGrants).toBe(1);
      expect(await store.list()).toMatchObject([{ status: "active", expiresAt: "2026-11-02T12:00:00.000Z" }]);
      expect((await store.grant({
        operationId: "grant-unknown", person, grantedBy: actor, durationMs: 86_400_000,
        maximumRemainingMs: 90 * 86_400_000, source: "command",
      })).status).toBe("granted");
      expect(await store.list()).toMatchObject([{ expiresAt: "2026-11-02T12:00:00.000Z" }]);
      expect(state.storage.sql.exec<{ code: string; event_id: string }>(
        "SELECT code, event_id FROM temp_vip_outbox",
      ).toArray()).toEqual([{
        code: "temp_vips.granted",
        event_id: "temp_vips:temp-vips-test:grant-unknown:0",
      }]);
    }, {
      twitch: {
        get: vi.fn()
          .mockResolvedValueOnce({ ok: true, isVip: false })
          .mockResolvedValueOnce({ ok: true, isVip: true }),
        add: vi.fn().mockResolvedValue({ ok: false, reason: "network", ambiguous: true }),
      },
    });
  });

  it("settles the reserved grant operation after recovery and does not extend on replay", async () => {
    let now = "2026-11-01T12:00:00.000Z";
    let resolveAdd: ((value: { ok: true } | { ok: false; reason: string; ambiguous: boolean }) => void) | undefined;
    let markAddStarted: (() => void) | undefined;
    const addStarted = new Promise<void>((resolve) => { markAddStarted = resolve; });
    const add = vi.fn(() => new Promise<{ ok: true } | { ok: false; reason: string; ambiguous: boolean }>((resolve) => {
      resolveAdd = resolve;
      markAddStarted?.();
    }));
    const input = {
      operationId: "grant-crash-replay", person, grantedBy: actor, durationMs: 86_400_000,
      maximumRemainingMs: 90 * 86_400_000, source: "command" as const,
    };

    await inStore(async (store, state) => {
      const interrupted = store.grant(input);
      await addStarted;
      expect(state.storage.sql.exec<{ payload_json: string; result_json: string | null }>(
        "SELECT payload_json, result_json FROM temp_vip_requests WHERE operation_id = ?",
        input.operationId,
      ).one()).toMatchObject({ result_json: null });
      now = "2026-11-01T12:06:00.000Z";

      expect((await store.runExpiry(now)).recoveredGrants).toBe(1);
      const recoveredExpiry = (await store.list())[0]?.expiresAt;
      const replay = await store.grant(input);

      expect(replay.status).toBe("granted");
      expect((await store.list())[0]?.expiresAt).toBe(recoveredExpiry);
      resolveAdd?.({ ok: false, reason: "network", ambiguous: true });
      await interrupted;
      expect((await store.grant(input)).status).toBe("granted");
    }, {
      now: () => now,
      twitch: {
        get: vi.fn()
          .mockResolvedValueOnce({ ok: true, isVip: false })
          .mockResolvedValueOnce({ ok: true, isVip: true }),
        add,
      },
    });
  });

  it("schedules grant recovery before starting the Twitch POST", async () => {
    const order: string[] = [];
    let resolveAdd: ((value: { ok: true }) => void) | undefined;
    let markAddStarted: (() => void) | undefined;
    const addStarted = new Promise<void>((resolve) => { markAddStarted = resolve; });
    const add = vi.fn(() => new Promise<{ ok: true }>((resolve) => {
      order.push("post");
      resolveAdd = resolve;
      markAddStarted?.();
    }));
    await inStore(async (store) => {
      const pending = store.grant({
        operationId: "grant-alarm-before-post", person, grantedBy: actor, durationMs: 86_400_000,
        maximumRemainingMs: 90 * 86_400_000, source: "command",
      });
      await addStarted;

      expect(order[0]).toBe("alarm");
      expect(order.indexOf("alarm")).toBeLessThan(order.indexOf("post"));
      resolveAdd?.({ ok: true });
      await pending;
    }, {
      scheduleAlarm: vi.fn(() => { order.push("alarm"); return Promise.resolve(); }),
      twitch: { add },
    });
  });

  it("leases grant recovery and fences an older lookup from a newer generation", async () => {
    let now = "2026-11-01T12:00:00.000Z";
    let finishOldLookup: ((value: { ok: true; isVip: boolean }) => void) | undefined;
    let markOldLookupStarted: (() => void) | undefined;
    const oldLookup = new Promise<{ ok: true; isVip: boolean }>((resolve) => { finishOldLookup = resolve; });
    const oldLookupStarted = new Promise<void>((resolve) => { markOldLookupStarted = resolve; });
    const get = vi.fn()
      .mockResolvedValueOnce({ ok: true, isVip: false })
      .mockImplementationOnce(() => { markOldLookupStarted?.(); return oldLookup; })
      .mockResolvedValueOnce({ ok: true, isVip: true })
      .mockResolvedValueOnce({ ok: true, isVip: false });
    const add = vi.fn().mockResolvedValue({ ok: false, reason: "network", ambiguous: true });

    await inStore(async (store) => {
      await store.grant({
        operationId: "recovery-generation-one", person, grantedBy: actor, durationMs: 86_400_000,
        maximumRemainingMs: 90 * 86_400_000, source: "command",
      });
      now = "2026-11-01T12:01:00.000Z";
      const staleRecovery = store.runExpiry(now);
      await oldLookupStarted;
      expect(get).toHaveBeenCalledTimes(2);
      expect((await store.runExpiry(now)).recoveredGrants).toBe(0);
      expect(get).toHaveBeenCalledTimes(2);

      now = "2026-11-01T12:06:00.000Z";
      expect((await store.runExpiry(now)).recoveredGrants).toBe(1);
      expect((await store.list())[0]?.status).toBe("active");
      expect((await store.release({ operationId: "release-recovered-generation", userId: person.userId })).status).toBe("released");
      await store.grant({
        operationId: "recovery-generation-two", person, grantedBy: actor, durationMs: 86_400_000,
        maximumRemainingMs: 90 * 86_400_000, source: "command",
      });

      finishOldLookup?.({ ok: true, isVip: false });
      await staleRecovery;
      expect(await store.list()).toMatchObject([{ status: "grant_unknown", grantGeneration: 2 }]);
    }, { now: () => now, twitch: { get, add } });
  });

  it("recovers a grant lock left behind after the five-minute lease", async () => {
    const get = vi.fn().mockResolvedValue({ ok: true, isVip: false });
    await inStore(async (store, state) => {
      await store.list();
      state.storage.transactionSync(() => state.storage.sql.exec(
        `INSERT INTO temp_vips
          (user_id, user_login, user_display_name, expires_at, granted_at, pending_op, pending_since,
           status, grant_generation, source, revision)
         VALUES ('user-1', 'viewer', 'Viewer', '2026-11-01T13:00:00.000Z', '2026-11-01T12:00:00.000Z',
           'grant', '2026-11-01T12:00:00.000Z', 'grant_pending', 1, 'command', 1)`,
      ));

      const recovered = await store.runExpiry("2026-11-01T12:06:00.000Z");
      expect(recovered.recoveredGrants).toBe(1);
      expect(get).toHaveBeenCalledWith(person.userId);
      expect(await store.list()).toEqual([]);
    }, { twitch: { get } });
  });

  it("does not claim a pre-existing VIP after a crash during the precheck", async () => {
    await inStore(async (store, state) => {
      await store.list();
      state.storage.transactionSync(() => state.storage.sql.exec(
        `INSERT INTO temp_vips
          (user_id, user_login, user_display_name, expires_at, granted_at, pending_op, pending_since,
           status, grant_generation, source, revision)
         VALUES ('user-1', 'viewer', 'Viewer', '2026-11-02T12:00:00.000Z', '2026-11-01T12:00:00.000Z',
           'grant', '2026-11-01T12:00:00.000Z', 'grant_pending', 1, 'command', 1)`,
      ));

      await store.runExpiry("2026-11-01T12:06:00.000Z");
      expect(await store.list()).toEqual([]);
      expect(state.storage.sql.exec("SELECT * FROM temp_vip_outbox").toArray()).toEqual([]);
    }, { twitch: { get: vi.fn().mockResolvedValue({ ok: true, isVip: true }) } });
  });

  it("imports an existing VIP and releases ownership without removing it", async () => {
    const remove = vi.fn().mockResolvedValue({ ok: true });
    await inStore(async (store, state) => {
      const imported = await store.importExisting({
        operationId: "import-1", person, grantedBy: actor, durationMs: 7 * 86_400_000,
        maximumRemainingMs: 90 * 86_400_000, source: "import",
      });
      expect(imported.status).toBe("imported");
      expect(await store.list()).toMatchObject([{ source: "import", status: "active" }]);

      expect((await store.release({ operationId: "release-1", userId: person.userId })).status).toBe("released");
      expect(await store.list()).toEqual([]);
      expect(remove).not.toHaveBeenCalled();
      expect(state.storage.sql.exec<{ code: string }>(
        "SELECT code FROM temp_vip_outbox ORDER BY created_at, event_id",
      ).toArray().map(({ code }) => code)).toEqual(["temp_vips.imported", "temp_vips.released"]);
    }, { twitch: { get: vi.fn().mockResolvedValue({ ok: true, isVip: true }), remove } });
  });

  it("ignores an old own-removal echo after a newer grant generation", async () => {
    let now = "2026-11-01T12:00:00.000Z";
    await inStore(async (store, state) => {
      await store.grant({ operationId: "generation-1", person, grantedBy: actor, durationMs: 60_000, maximumRemainingMs: 90 * 86_400_000, source: "command" });
      await store.end({ operationId: "end-1", userId: person.userId });
      expect(state.storage.sql.exec<{ detail_json: string }>(
        "SELECT detail_json FROM temp_vip_outbox WHERE operation_id = 'end-1' AND code = 'temp_vips.ended'",
      ).one().detail_json).toContain("ended_early");
      now = "2026-11-01T12:00:02.000Z";
      await store.grant({ operationId: "generation-2", person, grantedBy: actor, durationMs: 86_400_000, maximumRemainingMs: 90 * 86_400_000, source: "command" });

      const echo = await store.handleRemoved({ triggerId: "remove-event-1", userId: person.userId, eventSubTimestamp: "2026-11-01T12:00:00.000Z" });
      expect(echo.status).toBe("ignored_stale_echo");
      expect(await store.list()).toMatchObject([{ grantGeneration: 2, status: "active" }]);
    }, { now: () => now });
  });

  it("removes a managed row only after Twitch confirms a manual VIP removal", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ ok: true, isVip: false })
      .mockResolvedValueOnce({ ok: true, isVip: false });
    await inStore(async (store, state) => {
      await store.grant({ operationId: "manual-remove-grant", person, grantedBy: actor, durationMs: 86_400_000, maximumRemainingMs: 90 * 86_400_000, source: "command" });
      const removed = await store.handleRemoved({
        triggerId: "manual-remove-event", userId: person.userId,
        eventSubTimestamp: "2026-11-01T12:00:01.000Z",
      });
      expect(removed.status).toBe("removed_on_twitch");
      expect(await store.list()).toEqual([]);
      expect(state.storage.sql.exec<{ detail_json: string }>(
        "SELECT detail_json FROM temp_vip_outbox WHERE code = 'temp_vips.ended' ORDER BY created_at DESC LIMIT 1",
      ).one().detail_json).toContain("removed_on_twitch");
    }, { twitch: { get } });
  });

  it("clears an already-removed VIP so later unmanaged VIPs are never retried", async () => {
    const remove = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "network", ambiguous: true })
      .mockResolvedValueOnce({ ok: true });
    await inStore(async (store) => {
      await store.grant({ operationId: "remove-timeout-grant", person, grantedBy: actor, durationMs: 86_400_000, maximumRemainingMs: 90 * 86_400_000, source: "command" });
      expect((await store.end({ operationId: "remove-timeout-end", userId: person.userId })).status).toBe("removal_failed");

      await store.runExpiry("2026-11-01T12:05:00.000Z");

      expect(remove).toHaveBeenCalledTimes(2);
      expect(await store.list()).toEqual([]);
      await store.runExpiry("2026-11-02T12:00:00.000Z");
      expect(remove).toHaveBeenCalledTimes(2);
    }, { twitch: { remove } });
  });

  it("returns busy for a duplicate EventSub delivery while verification is in flight", async () => {
    let finishVerification: ((value: { ok: true; isVip: boolean } | { ok: false; reason: string }) => void) | undefined;
    const verification = new Promise<{ ok: true; isVip: boolean } | { ok: false; reason: string }>((resolve) => { finishVerification = resolve; });
    const get = vi.fn()
      .mockResolvedValueOnce({ ok: true, isVip: false })
      .mockImplementationOnce(() => verification)
      .mockResolvedValueOnce({ ok: true, isVip: false });
    await inStore(async (store) => {
      await store.grant({ operationId: "eventsub-overlap-grant", person, grantedBy: actor, durationMs: 86_400_000, maximumRemainingMs: 90 * 86_400_000, source: "command" });
      const event = { triggerId: "eventsub-overlap-first", userId: person.userId, eventSubTimestamp: "2026-11-01T12:00:01.000Z" };
      const first = store.handleRemoved(event);
      const firstRejection = expect(first).rejects.toThrow("temp_vip_event_check_failed:network");

      expect((await store.handleRemoved({ ...event, triggerId: "eventsub-overlap-duplicate" })).status).toBe("busy");
      finishVerification?.({ ok: false, reason: "network" });
      await firstRejection;
      expect((await store.handleRemoved({ ...event, triggerId: "eventsub-overlap-retry" })).status).toBe("removed_on_twitch");
      expect(await store.list()).toEqual([]);
    }, { twitch: { get } });
  });

  it("backs removal failures off by five, fifteen, then sixty minutes", async () => {
    const remove = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "rate_limited" })
      .mockResolvedValueOnce({ ok: false, reason: "network" })
      .mockResolvedValueOnce({ ok: false, reason: "unknown_status" });
    await inStore(async (store) => {
      await store.grant({ operationId: "backoff-grant", person, grantedBy: actor, durationMs: 60_000, maximumRemainingMs: 90 * 86_400_000, source: "command" });

      await store.end({ operationId: "backoff-end", userId: person.userId });
      expect(await store.list()).toMatchObject([{ removalAttempts: 1, removalFailedAt: "2026-11-01T12:00:00.000Z", endReason: "ended_early" }]);
      await store.runExpiry("2026-11-01T12:05:00.000Z");
      expect(await store.list()).toMatchObject([{ removalAttempts: 2, removalFailedAt: "2026-11-01T12:05:00.000Z" }]);
      await store.runExpiry("2026-11-01T12:20:00.000Z");
      expect(await store.list()).toMatchObject([{ removalAttempts: 3, removalFailedAt: "2026-11-01T12:20:00.000Z" }]);
      expect(remove).toHaveBeenCalledTimes(3);
    }, { twitch: { remove } });
  });

  it("refuses a total remaining duration over the maximum and reports the allowed extension", async () => {
    await inStore(async (store) => {
      await store.grant({ operationId: "max-grant", person, grantedBy: actor, durationMs: 85 * 86_400_000, maximumRemainingMs: 90 * 86_400_000, source: "command" });
      const result = await store.extend({
        operationId: "max-extend", person, durationMs: 10 * 86_400_000,
        maximumRemainingMs: 90 * 86_400_000,
      });
      expect(result.status).toBe("maximum_exceeded");
      expect(result.allowedDurationMs).toBe(5 * 86_400_000);
    });
  });

  it("extends an overdue row from now instead of its past expiry", async () => {
    let now = "2026-11-01T12:00:00.000Z";
    await inStore(async (store) => {
      await store.grant({ operationId: "overdue-grant", person, grantedBy: actor, durationMs: 60_000, maximumRemainingMs: 90 * 86_400_000, source: "command" });
      now = "2026-11-04T12:00:00.000Z";
      await store.extend({ operationId: "overdue-extend", person, durationMs: 86_400_000, maximumRemainingMs: 90 * 86_400_000 });
      expect(await store.list()).toMatchObject([{ expiresAt: "2026-11-05T12:00:00.000Z" }]);
    }, { now: () => now });
  });

  it("replays an operation result without extending twice", async () => {
    await inStore(async (store) => {
      const input = { operationId: "same-operation", person, grantedBy: actor, durationMs: 86_400_000, maximumRemainingMs: 90 * 86_400_000, source: "command" as const };
      const first = await store.grant(input);
      const replay = await store.grant(input);
      expect(replay).toEqual(first);
      expect(await store.list()).toMatchObject([{ expiresAt: "2026-11-02T12:00:00.000Z", grantGeneration: 1 }]);
    });
  });

  it("limits one expiry run to ten removals and leaves the next row for the next alarm", async () => {
    const remove = vi.fn().mockResolvedValue({ ok: true });
    await inStore(async (store) => {
      for (let index = 0; index < 11; index += 1) {
        await store.grant({
          operationId: `batch-grant-${String(index)}`, person: { ...person, userId: `user-${String(index)}` },
          grantedBy: actor, durationMs: 1, maximumRemainingMs: 90 * 86_400_000, source: "command",
        });
      }

      const run = await store.runExpiry("2026-11-01T12:01:00.000Z");
      expect(run.removed).toBe(10);
      expect(remove).toHaveBeenCalledTimes(10);
      expect(await store.list()).toHaveLength(1);
    }, { twitch: { remove } });
  });

  it("counts expiry and manual removals against the current shared window", async () => {
    let now = "2026-11-01T12:00:00.000Z";
    let finishExpiryRemoval: ((value: { ok: true }) => void) | undefined;
    const expiryRemoval = new Promise<{ ok: true }>((resolve) => { finishExpiryRemoval = resolve; });
    const remove = vi.fn()
      .mockImplementationOnce(() => expiryRemoval)
      .mockResolvedValue({ ok: true });

    await inStore(async (store) => {
      for (let index = 0; index < 11; index += 1) {
        await store.grant({
          operationId: `shared-window-grant-${String(index)}`,
          person: { ...person, userId: `shared-window-user-${String(index)}` },
          grantedBy: actor, durationMs: 1, maximumRemainingMs: 90 * 86_400_000, source: "command",
        });
      }
      now = "2026-11-01T12:00:11.000Z";
      const expiry = store.runExpiry("2026-11-01T12:00:00.000Z");
      await vi.waitFor(() => { expect(remove).toHaveBeenCalledTimes(1); });

      const manualStatuses: string[] = [];
      for (let index = 1; index < 11; index += 1) {
        manualStatuses.push((await store.end({ operationId: `shared-window-end-${String(index)}`, userId: `shared-window-user-${String(index)}` })).status);
      }
      expect(manualStatuses.filter((status) => status === "ended")).toHaveLength(9);
      expect(manualStatuses[manualStatuses.length - 1]).toBe("queued");
      expect(remove).toHaveBeenCalledTimes(10);

      finishExpiryRemoval?.({ ok: true });
      await expiry;
    }, { now: () => now, twitch: { remove } });
  });

  it("lets a queued manual end override an existing retry backoff without resetting attempts", async () => {
    const now = "2026-11-01T12:00:00.000Z";
    const remove = vi.fn()
      .mockResolvedValueOnce({ ok: false, reason: "rate_limited" })
      .mockResolvedValue({ ok: true });
    await inStore(async (store) => {
      await store.grant({ operationId: "queued-retry-target", person, grantedBy: actor, durationMs: 86_400_000, maximumRemainingMs: 90 * 86_400_000, source: "command" });
      await store.end({ operationId: "queued-retry-failed", userId: person.userId });

      for (let index = 0; index < 9; index += 1) {
        const userId = `queued-retry-other-${String(index)}`;
        await store.grant({ operationId: `queued-retry-grant-${String(index)}`, person: { ...person, userId }, grantedBy: actor, durationMs: 86_400_000, maximumRemainingMs: 90 * 86_400_000, source: "command" });
        await store.end({ operationId: `queued-retry-end-${String(index)}`, userId });
      }

      const queued = await store.end({ operationId: "queued-retry-queued", userId: person.userId });
      expect(queued).toMatchObject({ status: "queued", retryAt: "2026-11-01T12:00:10.000Z" });
      expect(await store.list()).toMatchObject([{ removalAttempts: 1, removalFailedAt: "2026-11-01T12:00:00.000Z" }]);

      await store.runExpiry(queued.retryAt ?? "2026-11-01T12:00:10.000Z");
      expect(await store.list()).toEqual([]);
      expect(remove).toHaveBeenCalledTimes(11);
    }, { now: () => now, twitch: { remove } });
  });

  it("recovers an expired EventSub verification with GET and preserves a future VIP", async () => {
    let now = "2026-11-01T12:00:00.000Z";
    let finishVerification: ((value: { ok: true; isVip: boolean }) => void) | undefined;
    let markVerificationStarted: (() => void) | undefined;
    const verification = new Promise<{ ok: true; isVip: boolean }>((resolve) => { finishVerification = resolve; });
    const verificationStarted = new Promise<void>((resolve) => { markVerificationStarted = resolve; });
    const get = vi.fn()
      .mockResolvedValueOnce({ ok: true, isVip: false })
      .mockImplementationOnce(() => { markVerificationStarted?.(); return verification; })
      .mockResolvedValueOnce({ ok: true, isVip: true });
    const remove = vi.fn().mockResolvedValue({ ok: true });

    await inStore(async (store) => {
      await store.grant({ operationId: "verification-recovery-grant", person, grantedBy: actor, durationMs: 86_400_000, maximumRemainingMs: 90 * 86_400_000, source: "command" });
      const event = store.handleRemoved({ triggerId: "verification-recovery-event", userId: person.userId, eventSubTimestamp: now });
      await verificationStarted;

      now = "2026-11-01T12:06:00.000Z";
      await store.runExpiry(now);
      expect(get).toHaveBeenCalledTimes(3);
      expect(remove).not.toHaveBeenCalled();
      expect(await store.list()).toMatchObject([{ status: "active", expiresAt: "2026-11-02T12:00:00.000Z" }]);

      finishVerification?.({ ok: true, isVip: true });
      expect((await event).status).toBe("busy");
      expect(await store.list()).toMatchObject([{ status: "active" }]);
    }, { now: () => now, twitch: { get, remove } });
  });

  it("fences late grant POST and removal DELETE completions from replacement generations", async () => {
    let now = "2026-11-01T12:00:00.000Z";
    let finishOldAdd: ((value: { ok: true }) => void) | undefined;
    let finishNewAdd: ((value: { ok: true }) => void) | undefined;
    let finishOldRemove: ((value: { ok: true }) => void) | undefined;
    let markOldAddStarted: (() => void) | undefined;
    let markNewAddStarted: (() => void) | undefined;
    let markOldRemoveStarted: (() => void) | undefined;
    const oldAddStarted = new Promise<void>((resolve) => { markOldAddStarted = resolve; });
    const newAddStarted = new Promise<void>((resolve) => { markNewAddStarted = resolve; });
    const oldRemoveStarted = new Promise<void>((resolve) => { markOldRemoveStarted = resolve; });
    const get = vi.fn().mockResolvedValue({ ok: true, isVip: false });
    const add = vi.fn()
      .mockImplementationOnce(() => { markOldAddStarted?.(); return new Promise<{ ok: true }>((resolve) => { finishOldAdd = resolve; }); })
      .mockImplementationOnce(() => { markNewAddStarted?.(); return new Promise<{ ok: true }>((resolve) => { finishNewAdd = resolve; }); })
      .mockResolvedValue({ ok: true });
    const remove = vi.fn().mockImplementationOnce(() => {
      markOldRemoveStarted?.();
      return new Promise<{ ok: true }>((resolve) => { finishOldRemove = resolve; });
    });

    await inStore(async (store) => {
      const oldGrant = store.grant({ operationId: "late-post-generation-one", person, grantedBy: actor, durationMs: 86_400_000, maximumRemainingMs: 90 * 86_400_000, source: "command" });
      await oldAddStarted;
      now = "2026-11-01T12:06:00.000Z";
      await store.runExpiry(now);
      const newGrant = store.grant({ operationId: "late-post-generation-two", person, grantedBy: actor, durationMs: 86_400_000, maximumRemainingMs: 90 * 86_400_000, source: "command" });
      await newAddStarted;
      finishOldAdd?.({ ok: true });
      await oldGrant;
      expect(await store.list()).toMatchObject([{ status: "grant_pending", grantGeneration: 2, expiresAt: "2026-11-02T12:06:00.000Z" }]);
      finishNewAdd?.({ ok: true });
      await newGrant;
      expect(await store.list()).toMatchObject([{ status: "active", grantGeneration: 2 }]);

      const oldEnd = store.end({ operationId: "late-delete-generation-two", userId: person.userId });
      await oldRemoveStarted;
      now = "2026-11-01T12:12:00.000Z";
      await store.runExpiry(now);
      expect(await store.list()).toEqual([]);
      await store.grant({ operationId: "late-delete-generation-three", person, grantedBy: actor, durationMs: 86_400_000, maximumRemainingMs: 90 * 86_400_000, source: "command" });
      finishOldRemove?.({ ok: true });
      await oldEnd;
      expect(await store.list()).toMatchObject([{ status: "active", grantGeneration: 3, expiresAt: "2026-11-02T12:12:00.000Z" }]);
    }, { now: () => now, twitch: { get, add, remove } });
  });

  it("settles the original manual-end operation during recovery before a regrant replay", async () => {
    let now = "2026-11-01T12:00:00.000Z";
    let finishRemove: ((value: { ok: true }) => void) | undefined;
    let markRemoveStarted: (() => void) | undefined;
    const removeStarted = new Promise<void>((resolve) => { markRemoveStarted = resolve; });
    const remove = vi.fn().mockImplementationOnce(() => {
      markRemoveStarted?.();
      return new Promise<{ ok: true }>((resolve) => { finishRemove = resolve; });
    });
    const endRequest = { operationId: "manual-end-recovery-original", userId: person.userId };

    await inStore(async (store) => {
      await store.grant({ operationId: "manual-end-recovery-grant", person, grantedBy: actor, durationMs: 86_400_000, maximumRemainingMs: 90 * 86_400_000, source: "command" });
      const interrupted = store.end(endRequest);
      await removeStarted;
      now = "2026-11-01T12:06:00.000Z";
      await store.runExpiry(now);
      expect(await store.list()).toEqual([]);

      await store.grant({ operationId: "manual-end-recovery-regrant", person, grantedBy: actor, durationMs: 86_400_000, maximumRemainingMs: 90 * 86_400_000, source: "command" });
      expect((await store.end(endRequest)).status).toBe("ended");
      expect(await store.list()).toMatchObject([{ grantGeneration: 2, status: "active" }]);

      finishRemove?.({ ok: true });
      await interrupted;
      expect(await store.list()).toMatchObject([{ grantGeneration: 2, status: "active" }]);
    }, { now: () => now, twitch: { remove } });
  });

  it("settles reserved grant results when release or EventSub deletes the row", async () => {
    let now = "2026-11-01T12:00:00.000Z";
    let finishAdd: ((value: { ok: true }) => void) | undefined;
    let markAddStarted: (() => void) | undefined;
    let markEventAddStarted: (() => void) | undefined;
    const addStarted = new Promise<void>((resolve) => { markAddStarted = resolve; });
    const eventAddStarted = new Promise<void>((resolve) => { markEventAddStarted = resolve; });
    let addCalls = 0;
    const add = vi.fn().mockImplementation(() => new Promise<{ ok: true }>((resolve) => {
      addCalls += 1;
      finishAdd = resolve;
      if (addCalls === 1) markAddStarted?.();
      if (addCalls === 2) markEventAddStarted?.();
    }));
    const grantRequest = { operationId: "grant-settled-by-release", person, grantedBy: actor, durationMs: 86_400_000, maximumRemainingMs: 90 * 86_400_000, source: "command" as const };

    await inStore(async (store) => {
      const interrupted = store.grant(grantRequest);
      await addStarted;
      now = "2026-11-01T12:06:00.000Z";
      expect((await store.release({ operationId: "release-interrupted-grant", userId: person.userId })).status).toBe("released");
      const replay = await store.grant(grantRequest);
      expect(replay.status).not.toBe("busy");
      expect(await store.list()).toEqual([]);
      finishAdd?.({ ok: true });
      await interrupted;

      const eventPerson = { ...person, userId: "eventsub-grant-user" };
      const eventGrantRequest = { ...grantRequest, operationId: "grant-settled-by-eventsub", person: eventPerson };
      const eventGrant = store.grant(eventGrantRequest);
      await eventAddStarted;
      now = "2026-11-01T12:12:00.000Z";
      const removed = await store.handleRemoved({ triggerId: "grant-expiry-eventsub", userId: eventPerson.userId, eventSubTimestamp: now });
      expect(removed.status).toBe("removed_on_twitch");
      expect((await store.grant(eventGrantRequest)).status).not.toBe("busy");
      finishAdd?.({ ok: true });
      await eventGrant;
    }, { now: () => now, twitch: { add, get: vi.fn().mockResolvedValue({ ok: true, isVip: false }) } });
  });

  it("persists the slot deadline for an orphaned early end", async () => {
    let now = "2026-11-01T12:00:00.000Z";
    let finishFirstRemove: ((value: { ok: true }) => void) | undefined;
    let markFirstRemoveStarted: (() => void) | undefined;
    const firstRemoveStarted = new Promise<void>((resolve) => { markFirstRemoveStarted = resolve; });
    const remove = vi.fn()
      .mockImplementationOnce(() => new Promise<{ ok: true }>((resolve) => {
        finishFirstRemove = resolve;
        markFirstRemoveStarted?.();
      }))
      .mockResolvedValue({ ok: true });
    const get = vi.fn()
      .mockResolvedValueOnce({ ok: true, isVip: false })
      .mockResolvedValueOnce({ ok: true, isVip: true });

    await inStore(async (store, state) => {
      await store.grant({ operationId: "orphaned-early-end-grant", person, grantedBy: actor, durationMs: 86_400_000, maximumRemainingMs: 90 * 86_400_000, source: "command" });
      const interrupted = store.end({ operationId: "orphaned-early-end", userId: person.userId });
      await firstRemoveStarted;
      now = "2026-11-01T12:06:00.000Z";
      state.storage.transactionSync(() => {
        const nowMs = Date.parse(now);
        for (let index = 0; index < 10; index += 1) {
          state.storage.sql.exec("INSERT INTO temp_vip_removal_slots (reserved_at) VALUES (?)", nowMs);
        }
      });

      await store.runExpiry(now);
      expect(state.storage.sql.exec<{ end_reason: string; removal_retry_at: string }>(
        "SELECT end_reason, removal_retry_at FROM temp_vips WHERE user_id = ?", person.userId,
      ).one()).toEqual({ end_reason: "ended_early", removal_retry_at: "2026-11-01T12:06:10.000Z" });
      now = "2026-11-01T12:06:10.000Z";
      await store.runExpiry(now);
      expect(await store.list()).toEqual([]);
      finishFirstRemove?.({ ok: true });
      await interrupted;
    }, { now: () => now, twitch: { get, remove } });
  });

  it("persists the manual DELETE operation and lease alarm before Twitch I/O", async () => {
    const now = "2026-11-01T12:00:00.000Z";
    let storage: DurableObjectState["storage"] | undefined;
    let markRemoveStarted: (() => void) | undefined;
    let finishRemove: ((value: { ok: true }) => void) | undefined;
    const removeStarted = new Promise<void>((resolve) => { markRemoveStarted = resolve; });
    const scheduled: number[] = [];
    const remove = vi.fn(() => {
      const op = storage?.sql.exec<{
        kind: string;
        user_id: string;
        generation: number;
        lease_id: string;
        lease_deadline: number;
        payload_json: string;
        result_json: string | null;
      }>("SELECT kind, user_id, generation, lease_id, lease_deadline, payload_json, result_json FROM temp_vip_operations WHERE operation_id = 'manual-delete-alarm'").toArray()[0];
      expect(op).toMatchObject({ kind: "remove_manual", user_id: person.userId, generation: 1, result_json: null });
      expect(op?.lease_id).toBeTruthy();
      expect(op?.lease_deadline).toBe(Date.parse(now) + 5 * 60_000);
      expect(JSON.parse(op?.payload_json ?? "{}")).toMatchObject({ action: "end", userId: person.userId });
      markRemoveStarted?.();
      return new Promise<{ ok: true }>((resolve) => { finishRemove = resolve; });
    });

    await inStore(async (store, state) => {
      storage = state.storage;
      await store.grant({ operationId: "manual-delete-alarm-grant", person, grantedBy: actor, durationMs: 86_400_000, maximumRemainingMs: 90 * 86_400_000, source: "command" });
      await store.acknowledgeOutbox(store.pendingOutbox().map(({ eventId }) => eventId));
      const ending = store.end({ operationId: "manual-delete-alarm", userId: person.userId });
      await removeStarted;
      expect(scheduled).toContain(Date.parse(now) + 5 * 60_000);
      expect((await store.list())[0]?.status).toBe("active");
      finishRemove?.({ ok: true });
      await ending;
    }, { now: () => now, scheduleAlarm: (deadline) => {
      if (deadline !== null) scheduled.push(deadline);
      return Promise.resolve();
    }, twitch: { remove } });
  });
});
