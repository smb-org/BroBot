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
});
