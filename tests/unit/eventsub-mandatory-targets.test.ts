import { describe, expect, it } from "vitest";

import { MODULES } from "../../src/modules/registry";
import type { BotModule } from "../../src/modules/contract";
import { listDesiredEventSubTargets } from "../../src/worker/eventsub-subscriptions";
import { listTwitchRanksConsumers } from "../../src/worker/durable/twitch-ranks";
import { insertChannel, insertLoginIdentityAndSession } from "./fixtures";
import { TestD1Database } from "./test-d1";

const testRankConsumer = {
  id: "test_rank_consumer",
  navigationCategory: "twitch",
  consumes: ["twitch_ranks"],
  reconcileAlarmKeys: { twitch_ranks: "role_reconcile" },
  alarms: [{ key: "role_reconcile", job: { intervalMs: 60_000, label: { de: "Test", en: "Test" }, requiredScopes: [] } }],
} as unknown as BotModule;

describe("mandatory EventSub targets", () => {
  it("includes channel events for a released channel with no channel_modules rows", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);

      const targets = await listDesiredEventSubTargets(database as unknown as D1Database, "kanal-a");

      expect(MODULES.find((module) => module.id === "channel_events")?.mandatory).toBe(true);
      expect(targets).toContainEqual({
        channelId: "kanal-a",
        subscriptionType: "channel.chat.notification",
        variant: "",
        version: "1",
      });
      expect(targets).toContainEqual({
        channelId: "kanal-a",
        subscriptionType: "channel.update",
        variant: "",
        version: "2",
      });
      expect(targets).toContainEqual({
        channelId: "kanal-a",
        subscriptionType: "channel.shoutout.create",
        variant: "",
        version: "1",
        deferredReason: "moderator_required",
      });
      expect(targets).toContainEqual({
        channelId: "kanal-a",
        subscriptionType: "channel.chat.message",
        variant: "",
        version: "1",
      });
      await expect(database.prepare("SELECT COUNT(*) AS count FROM channel_modules WHERE channel_id = 'kanal-a'").first())
        .resolves.toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("subscribes stream types once even when ads and channel events both need stream.online", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
      await database.prepare(
        `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
         VALUES ('kanal-a', 'ads', 1, '{}')`,
      ).run();

      const targets = await listDesiredEventSubTargets(database as unknown as D1Database, "kanal-a");

      expect(targets.filter((target) => target.subscriptionType === "stream.online")).toHaveLength(1);
      expect(targets.filter((target) => target.subscriptionType === "stream.offline")).toHaveLength(1);
      expect(targets).toContainEqual({
        channelId: "kanal-a", subscriptionType: "stream.online", variant: "", version: "1",
      });
      expect(targets).toContainEqual({
        channelId: "kanal-a", subscriptionType: "stream.offline", variant: "", version: "1",
      });
    } finally {
      database.close();
    }
  });

  it("does not create rank targets or rank consumers without an enabled consumer module", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "rank-channel");
      await insertLoginIdentityAndSession(database, "rank-channel", ["channel:bot", "channel:read:vips", "moderation:read"]);

      const targets = await listDesiredEventSubTargets(database as unknown as D1Database, "rank-channel");
      const consumers = await listTwitchRanksConsumers({ DB: database as unknown as D1Database }, "rank-channel");

      expect(targets.filter(({ subscriptionType }) => subscriptionType.startsWith("channel.vip.") ||
        subscriptionType.startsWith("channel.moderator."))).toEqual([]);
      expect(consumers).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("creates rank EventSub targets and the consumer alarm registration for a test-only consumer", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "rank-channel");
      await insertLoginIdentityAndSession(database, "rank-channel", ["channel:bot", "channel:read:vips", "moderation:read"]);
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, ?, 1, '{}')",
      ).bind("rank-channel", testRankConsumer.id).run();

      const targets = await listDesiredEventSubTargets(database as unknown as D1Database, "rank-channel", [testRankConsumer]);
      const consumers = await listTwitchRanksConsumers(
        { DB: database as unknown as D1Database },
        "rank-channel",
        [testRankConsumer],
      );

      expect(targets.filter(({ subscriptionType }) => subscriptionType.startsWith("channel.vip.") ||
        subscriptionType.startsWith("channel.moderator.")).map(({ channelId, subscriptionType, variant, version }) =>
        ({ channelId, subscriptionType, variant, version })).sort((left, right) => left.subscriptionType.localeCompare(right.subscriptionType)))
        .toEqual([
        { channelId: "rank-channel", subscriptionType: "channel.moderator.add", variant: "", version: "1" },
        { channelId: "rank-channel", subscriptionType: "channel.moderator.remove", variant: "", version: "1" },
        { channelId: "rank-channel", subscriptionType: "channel.vip.add", variant: "", version: "1" },
        { channelId: "rank-channel", subscriptionType: "channel.vip.remove", variant: "", version: "1" },
      ]);
      expect(consumers).toEqual([{ moduleId: testRankConsumer.id, alarmKey: "role_reconcile" }]);
    } finally {
      database.close();
    }
  });

  it.each(["channel:read:vips", "channel:manage:vips"] as const)(
    "enables VIP tracking with %s alone",
    async (vipScope) => {
      const database = new TestD1Database();
      try {
        await insertChannel(database, "rank-channel");
        await insertLoginIdentityAndSession(database, "rank-channel", ["channel:bot", vipScope]);
        await database.prepare(
          "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, ?, 1, '{}')",
        ).bind("rank-channel", testRankConsumer.id).run();

        const targets = await listDesiredEventSubTargets(database as unknown as D1Database, "rank-channel", [testRankConsumer]);
        expect(targets.map(({ subscriptionType }) => subscriptionType).filter((type) => type.startsWith("channel.vip.")).sort((a, b) => a.localeCompare(b)))
          .toEqual(["channel.vip.add", "channel.vip.remove"]);
      } finally {
        database.close();
      }
    },
  );

  it("keeps temp_vips channel.vip.remove subscribed with only channel:manage:vips", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "vip-channel");
      await insertLoginIdentityAndSession(database, "vip-channel", ["channel:bot", "channel:manage:vips"]);
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('vip-channel', 'temp_vips', 1, '{}')",
      ).run();

      const targets = await listDesiredEventSubTargets(database as unknown as D1Database, "vip-channel");
      expect(targets).toContainEqual({
        channelId: "vip-channel", subscriptionType: "channel.vip.remove", variant: "", version: "1",
      });
    } finally {
      database.close();
    }
  });
});
