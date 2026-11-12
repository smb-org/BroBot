import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { ModuleExecutionContext, ModuleTempVipResult } from "../../src/modules/contract";
import { DEFAULT_TEMP_VIPS_SETTINGS } from "../../src/modules/temp_vips/contracts";
import { tempVipsChannelPointsActionTexts as localeTexts } from "../../src/modules/temp_vips/locale";
import { grantVipAction } from "../../src/modules/temp_vips/actions/grant-vip";
import { TempVipStore, type TempVipStoreOptions, type TempVipTwitch } from "../../src/worker/durable/temp-vips";
import { runMigrations } from "./points-test-helpers";

type RefundKey = keyof typeof localeTexts.en.refundReasons;
// Refund outcomes carry both languages; expose them under the name the assertions below read.
const tempVipsChannelPointsActionTexts = {
  en: {
    refundReasons: Object.fromEntries(
      (Object.keys(localeTexts.en.refundReasons) as RefundKey[]).map((key) => [
        key,
        { de: localeTexts.de.refundReasons[key], en: localeTexts.en.refundReasons[key] },
      ]),
    ) as Record<RefundKey, { de: string; en: string }>,
  },
};

const database = (env as unknown as { DB: D1Database }).DB;
const namespace = (env as unknown as { CHANNEL: Env["CHANNEL"] }).CHANNEL;
const baseNow = "2026-11-10T12:00:00.000Z";
let serial = 0;

interface TestOptions {
  enabled?: boolean;
  settings?: typeof DEFAULT_TEMP_VIPS_SETTINGS;
  managed?: boolean;
  reportedMode?: "managed" | "observe" | "inactive";
  twitch?: Partial<TempVipTwitch>;
}

const createChannel = async (options: TestOptions = {}): Promise<string> => {
  const channelId = `channel_points_vip_${String(++serial)}`;
  await database.prepare(
    "INSERT INTO channels (channel_id, login, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).bind(channelId, channelId, channelId, baseNow, baseNow).run();
  await database.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'temp_vips', ?, ?)",
  ).bind(channelId, Number(options.enabled ?? true), JSON.stringify(options.settings ?? DEFAULT_TEMP_VIPS_SETTINGS)).run();
  return channelId;
};

const redemption = (userId = "vip_viewer") => ({
  id: "redemption_vip",
  rewardId: "reward_vip",
  rewardTitle: "Temporary VIP",
  userId,
  userLogin: "vip_viewer",
  userName: "VIP Viewer",
  userInput: "",
  redeemedAt: baseNow,
});

const runAction = async (
  channelId: string,
  options: TestOptions = {},
  operationId = "redemption_vip",
  config: unknown = { durationDays: 7 },
  userId = "vip_viewer",
): Promise<{
  outcome: Awaited<ReturnType<typeof grantVipAction.execute>>;
  results: ModuleTempVipResult[];
  operationPayloads: Record<string, unknown>[];
  vipCount: number;
}> => {
  const stub = namespace.get(namespace.idFromName(channelId));
  return runInDurableObject(stub, async (_instance, state) => {
    const isEnabled = async (): Promise<boolean> => {
      const module = await database.prepare(
        "SELECT enabled FROM channel_modules WHERE channel_id = ? AND module_id = 'temp_vips'",
      ).bind(channelId).first<{ enabled: number }>();
      return module?.enabled === 1;
    };
    const twitch: TempVipTwitch = {
      get: options.twitch?.get ?? vi.fn().mockResolvedValue({ ok: true, isVip: false }),
      add: options.twitch?.add ?? vi.fn().mockResolvedValue({ ok: true }),
      remove: options.twitch?.remove ?? vi.fn().mockResolvedValue({ ok: true }),
    };
    const store = new TempVipStore(state.storage, {
      channelId,
      now: () => baseNow,
      scheduleAlarm: vi.fn().mockResolvedValue(undefined),
      isModuleEnabled: isEnabled,
      isManaged: () => Promise.resolve(options.managed ?? true),
      twitch,
    } satisfies TempVipStoreOptions);
    const tempVips = {
      mode: () => Promise.resolve(options.reportedMode ?? (options.managed === false ? "observe" : "managed")),
      replayGrant: (id: string, targetId: string) => store.replayGrant(id, targetId),
      grant: (request: Parameters<TempVipStore["grant"]>[0]) => store.grant(request),
    };
    const context = { DB: database, channelId, tempVips } as unknown as ModuleExecutionContext;
    const outcome = await grantVipAction.execute(context, {
      redemption: redemption(userId),
      config: config as Parameters<typeof grantVipAction.execute>[1]["config"],
      operationId,
    });
    const operations = state.storage.sql.exec<{ result_json: string | null; payload_json: string }>(
      "SELECT result_json, payload_json FROM temp_vip_ops WHERE operation_id = ?",
      operationId,
    ).toArray();
    const results = operations.flatMap(({ result_json }) => result_json === null
      ? []
      : [JSON.parse(result_json) as ModuleTempVipResult]);
    const operationPayloads = operations.map(({ payload_json }) => JSON.parse(payload_json) as Record<string, unknown>);
    return { outcome, results, operationPayloads, vipCount: (await store.list()).length };
  });
};

describe("temporary VIP channel-points action on local D1", () => {
  beforeAll(async () => { await runMigrations(); });

  it("grants the VIP once when the same operation is replayed", async () => {
    const channelId = await createChannel();
    const add = vi.fn().mockResolvedValue({ ok: true as const });
    const options = { twitch: { add } };

    await expect(runAction(channelId, options)).resolves.toMatchObject({
      outcome: "fulfilled",
      vipCount: 1,
      operationPayloads: [{ request: { grantedBy: null, source: "channel_points" } }],
    });
    await database.prepare("UPDATE channel_modules SET settings = ? WHERE channel_id = ? AND module_id = 'temp_vips'")
      .bind(JSON.stringify({ ...DEFAULT_TEMP_VIPS_SETTINGS, defaultDurationDays: 14, maximumDurationDays: 45 }), channelId).run();
    await expect(runAction(channelId, options)).resolves.toMatchObject({ outcome: "fulfilled", vipCount: 1 });

    expect(add).toHaveBeenCalledTimes(1);
  });

  it("keeps channel-points grant journal entries beyond the general operation retention", async () => {
    const channelId = await createChannel();
    const originalAdd = vi.fn().mockResolvedValue({ ok: true as const });

    await runAction(channelId, { twitch: { add: originalAdd } });
    await runInDurableObject(namespace.get(namespace.idFromName(channelId)), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE temp_vip_ops SET finished_at = ? WHERE operation_id = ?",
        "2026-11-09T10:00:00.000Z",
        "redemption_vip",
      );
    });
    await runAction(channelId, { twitch: { add: vi.fn().mockResolvedValue({ ok: true as const }) } }, "redemption_other", { durationDays: 7 }, "vip_other");

    await expect(runAction(channelId, { twitch: { add: originalAdd } })).resolves.toMatchObject({
      outcome: "fulfilled",
      results: [{ status: "granted" }],
    });
    expect(originalAdd).toHaveBeenCalledTimes(1);
  });

  it("refunds when the temporary VIP module is disabled", async () => {
    const channelId = await createChannel({ enabled: false });

    await expect(runAction(channelId, { enabled: false })).resolves.toMatchObject({
      outcome: { refund: tempVipsChannelPointsActionTexts.en.refundReasons.moduleDisabled },
      results: [],
    });
  });

  it.each([
    ["VIP slots are full", "no_slots", "noSlots"],
    ["the target is a moderator", "moderator", "moderator"],
    ["Twitch community requirements are unmet", "community_gate", "communityGate"],
  ] as const)("refunds when %s", async (_caseName, reason, copyKey) => {
    const channelId = await createChannel();
    const add = vi.fn().mockResolvedValue({ ok: false as const, reason });

    await expect(runAction(channelId, { twitch: { add } })).resolves.toMatchObject({
      outcome: { refund: tempVipsChannelPointsActionTexts.en.refundReasons[copyKey] },
      results: [{ status: "rejected", reason }],
    });
  });

  it("refunds when the action would exceed the module's maximum duration", async () => {
    const channelId = await createChannel({ settings: { ...DEFAULT_TEMP_VIPS_SETTINGS, maximumDurationDays: 5 } });

    await expect(runAction(channelId, { settings: { ...DEFAULT_TEMP_VIPS_SETTINGS, maximumDurationDays: 5 } }, "redemption_vip", { durationDays: 6 }))
      .resolves.toMatchObject({
        outcome: { refund: tempVipsChannelPointsActionTexts.en.refundReasons.maximumExceeded },
        results: [],
      });
  });

  it("refunds when Twitch reports that the target is already a VIP", async () => {
    const channelId = await createChannel();
    const get = vi.fn().mockResolvedValue({ ok: true as const, isVip: true });
    const add = vi.fn();

    await expect(runAction(channelId, { twitch: { get, add } })).resolves.toMatchObject({
      outcome: { refund: tempVipsChannelPointsActionTexts.en.refundReasons.alreadyVip },
      results: [{ status: "already_vip" }],
    });
    expect(add).not.toHaveBeenCalled();
  });

  it("refunds when the managed VIP entry is classified as permanent", async () => {
    const channelId = await createChannel();
    await runInDurableObject(namespace.get(namespace.idFromName(channelId)), (_instance, state) => {
      new TempVipStore(state.storage, {
        channelId,
        now: () => baseNow,
        scheduleAlarm: vi.fn().mockResolvedValue(undefined),
        twitch: {
          get: vi.fn().mockResolvedValue({ ok: true, isVip: true }),
          add: vi.fn().mockResolvedValue({ ok: true }),
          remove: vi.fn().mockResolvedValue({ ok: true }),
        },
      });
      state.storage.sql.exec(
        `INSERT INTO temp_vips (user_id, user_login, user_display_name, expires_at, granted_at, source, classification)
         VALUES ('vip_viewer', 'vip_viewer', 'VIP Viewer', NULL, ?, 'dashboard', 'permanent')`,
        baseNow,
      );
    });

    await expect(runAction(channelId)).resolves.toMatchObject({
      outcome: { refund: tempVipsChannelPointsActionTexts.en.refundReasons.alreadyVip },
      results: [{ status: "permanent_vip" }],
    });
  });

  it("refunds when the redemption target is the broadcaster", async () => {
    const channelId = await createChannel();
    const add = vi.fn();

    await expect(runAction(channelId, { twitch: { add } }, "redemption_broadcaster", { durationDays: 7 }, channelId))
      .resolves.toMatchObject({ outcome: { refund: tempVipsChannelPointsActionTexts.en.refundReasons.broadcaster } });
    expect(add).not.toHaveBeenCalled();
  });

  it("refunds when the broadcaster VIP scope is missing", async () => {
    const channelId = await createChannel();
    const add = vi.fn();

    await expect(runAction(channelId, { managed: false, twitch: { add } })).resolves.toMatchObject({
      outcome: { refund: tempVipsChannelPointsActionTexts.en.refundReasons.scopeMissing },
      results: [],
    });
    expect(add).not.toHaveBeenCalled();
  });

  it("records a missing-scope race as a definite refusal instead of queuing a later grant", async () => {
    const channelId = await createChannel();
    const add = vi.fn();

    await expect(runAction(channelId, { managed: false, reportedMode: "managed", twitch: { add } })).resolves.toMatchObject({
      outcome: { refund: tempVipsChannelPointsActionTexts.en.refundReasons.scopeMissing },
      results: [{ status: "rejected", reason: "scope_missing" }],
    });
    expect(add).not.toHaveBeenCalled();
  });

  it.each([
    ["rate limited", "rate_limited"],
    ["a server error", "unknown_status"],
    ["a network failure", "network"],
  ] as const)("keeps %s grants pending and replays the journaled result", async (_caseName, reason) => {
    const channelId = await createChannel();
    const add = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, reason, ambiguous: reason === "unknown_status" })
      .mockResolvedValue({ ok: true as const });
    const options = { twitch: { add } };

    await expect(runAction(channelId, options)).resolves.toMatchObject({ outcome: "pending" });
    await runInDurableObject(namespace.get(namespace.idFromName(channelId)), (_instance, state) => {
      state.storage.sql.exec("UPDATE temp_vip_ops SET next_attempt_at = ? WHERE operation_id = ?", baseNow, "redemption_vip");
    });

    await expect(runAction(channelId, options)).resolves.toMatchObject({ outcome: "fulfilled", vipCount: 1 });
    await expect(runAction(channelId, options)).resolves.toMatchObject({ outcome: "fulfilled", vipCount: 1 });
    expect(add).toHaveBeenCalledTimes(2);
  });

  it("keeps channel points grants journaled past 24 hours and prunes them after 30 days", async () => {
    const channelId = await createChannel();
    await runAction(channelId);
    const journaled = (state: DurableObjectState): number => state.storage.sql.exec<{ n: number }>(
      "SELECT COUNT(*) AS n FROM temp_vip_ops WHERE operation_id = 'redemption_vip'",
    ).one().n;
    await runInDurableObject(namespace.get(namespace.idFromName(channelId)), async (_instance, state) => {
      const touchAt = async (offsetMs: number, operationId: string): Promise<void> => {
        const store = new TempVipStore(state.storage, {
          channelId,
          now: () => new Date(Date.parse(baseNow) + offsetMs).toISOString(),
          scheduleAlarm: vi.fn().mockResolvedValue(undefined),
          isModuleEnabled: () => Promise.resolve(true),
          isManaged: () => Promise.resolve(true),
          twitch: {
            get: vi.fn().mockResolvedValue({ ok: true, isVip: false }),
            add: vi.fn().mockResolvedValue({ ok: true }),
            remove: vi.fn().mockResolvedValue({ ok: true }),
          },
        } satisfies TempVipStoreOptions);
        await store.grant({
          operationId,
          person: { userId: `other_${operationId}`, login: `other_${operationId}`, displayName: "Other" },
          grantedBy: null,
          durationMs: 24 * 60 * 60_000,
          maximumRemainingMs: 90 * 24 * 60 * 60_000,
          source: "command",
        });
      };
      await touchAt(25 * 60 * 60_000, "touch_25h");
      expect(journaled(state)).toBe(1);
      await touchAt(31 * 24 * 60 * 60_000, "touch_31d");
      expect(journaled(state)).toBe(0);
    });
  });

  it("uses the module duration default and bounds in the action config schema", () => {
    expect(grantVipAction.configSchema.parse({})).toEqual({ durationDays: 7 });
    expect(grantVipAction.configSchema.safeParse({ durationDays: 0 }).success).toBe(false);
    expect(grantVipAction.configSchema.safeParse({ durationDays: 91 }).success).toBe(false);
  });
});
