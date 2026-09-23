import { describe, expect, it } from "vitest";

import { MODULES } from "../../src/modules/registry";
import { listDesiredEventSubTargets } from "../../src/worker/eventsub-subscriptions";
import { insertChannel, insertLoginIdentityAndSession } from "./fixtures";
import { TestD1Database } from "./test-d1";

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
        subscriptionType: "channel.shoutout.create",
        variant: "",
        version: "1",
        deferredReason: "moderator_required",
      });
      expect(targets.some((target) => target.subscriptionType === "channel.chat.message")).toBe(false);
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
});
