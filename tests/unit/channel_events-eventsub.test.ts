
import { describe, expect, it } from "vitest";

import {
  EVENTSUB_SUBSCRIPTION_DEFINITIONS,
  eventSubDefinitionForCondition,
  listDesiredEventSubTargets,
} from "../../src/worker/eventsub-subscriptions";
import { insertChannel, insertLoginIdentityAndSession } from "./fixtures";
import { TestD1Database } from "./test-d1";

describe("channel events EventSub targets", () => {
  it("generates the full Twitch condition for every type", () => {
    const raid = EVENTSUB_SUBSCRIPTION_DEFINITIONS.filter((definition) => definition.subscriptionType === "channel.raid");
    expect(raid.map((definition) => definition.variant)).toEqual(["incoming", "outgoing"]);
    expect(raid.map((definition) => definition.buildCondition("kanal-a", "bot-1"))).toEqual([
      { to_broadcaster_user_id: "kanal-a" },
      { from_broadcaster_user_id: "kanal-a" },
    ]);
    expect(eventSubDefinitionForCondition("channel.raid", { to_broadcaster_user_id: "kanal-a" })?.variant).toBe("incoming");
    expect(eventSubDefinitionForCondition("channel.raid", { from_broadcaster_user_id: "kanal-a" })?.variant).toBe("outgoing");

    expect(EVENTSUB_SUBSCRIPTION_DEFINITIONS
      .filter((definition) => definition.subscriptionType !== "channel.raid")
      .map((definition) => [definition.subscriptionType, definition.buildCondition("kanal-a", "bot-1")]))
      .toEqual([
        ["channel.chat.message", { broadcaster_user_id: "kanal-a", user_id: "bot-1" }],
        ["channel.shoutout.create", { broadcaster_user_id: "kanal-a", moderator_user_id: "bot-1" }],
        ["channel.shoutout.receive", { broadcaster_user_id: "kanal-a", moderator_user_id: "bot-1" }],
        ["channel.chat.notification", { broadcaster_user_id: "kanal-a", user_id: "bot-1" }],
        ["channel.moderate", { broadcaster_user_id: "kanal-a", moderator_user_id: "bot-1" }],
        ["automod.message.hold", { broadcaster_user_id: "kanal-a", moderator_user_id: "bot-1" }],
        ["channel.suspicious_user.message", { broadcaster_user_id: "kanal-a", moderator_user_id: "bot-1" }],
        ["channel.suspicious_user.update", { broadcaster_user_id: "kanal-a", moderator_user_id: "bot-1" }],
        ["stream.online", { broadcaster_user_id: "kanal-a" }],
        ["channel.ad_break.begin", { broadcaster_user_id: "kanal-a" }],
      ]);

    const moderation = EVENTSUB_SUBSCRIPTION_DEFINITIONS.find((definition) => definition.subscriptionType === "channel.moderate");
    expect(moderation?.version).toBe("2");
    expect(moderation?.variant).toBe("");
    for (const subscriptionType of ["automod.message.hold", "channel.suspicious_user.message", "channel.suspicious_user.update"]) {
      const definition = EVENTSUB_SUBSCRIPTION_DEFINITIONS.find((candidate) => candidate.subscriptionType === subscriptionType);
      expect(definition?.version).toBe("1");
      expect(definition?.variant).toBe("");
    }
  });

  it("derives the consenting identity from the respective condition", () => {
    const moderation = EVENTSUB_SUBSCRIPTION_DEFINITIONS.find((definition) => definition.subscriptionType === "channel.moderate");
    expect(moderation?.consentingIdentityFromCondition({
      broadcaster_user_id: "200",
      moderator_user_id: "777",
    })).toEqual({ kind: "bot", userId: "777" });

    const chat = EVENTSUB_SUBSCRIPTION_DEFINITIONS.find((definition) => definition.subscriptionType === "channel.chat.message");
    expect(chat?.consentingIdentityFromCondition({
      broadcaster_user_id: "200",
      user_id: "777",
    })).toEqual({ kind: "bot", userId: "777" });

    const broadcaster = EVENTSUB_SUBSCRIPTION_DEFINITIONS.find((definition) => definition.subscriptionType === "channel.ad_break.begin");
    expect(broadcaster?.consentingIdentityFromCondition({ broadcaster_user_id: "200" }))
      .toEqual({ kind: "login", userId: "200" });

    const streamOnline = EVENTSUB_SUBSCRIPTION_DEFINITIONS.find((definition) => definition.subscriptionType === "stream.online");
    expect(streamOnline?.consentingIdentityFromCondition({ broadcaster_user_id: "200" })).toBeNull();

    const raid = EVENTSUB_SUBSCRIPTION_DEFINITIONS.find((definition) => definition.subscriptionType === "channel.raid");
    expect(raid?.consentingIdentityFromCondition({ to_broadcaster_user_id: "200" })).toBeNull();
  });

  it("includes mandatory channel events even when the stored row is disabled", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
      await database.prepare(
        `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
         VALUES ('kanal-a', 'channel_events', 0, '{}')`,
      ).run();

      const targets = await listDesiredEventSubTargets(database as unknown as D1Database, "kanal-a");
      expect(targets.some((target) => target.subscriptionType === "channel.chat.notification")).toBe(true);
      expect(targets.filter((target) => target.subscriptionType === "channel.raid")).toHaveLength(2);
    } finally {
      database.close();
    }
  });

  it("includes both raid targets in the target state when the module is enabled", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
      await database.prepare(
        `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
         VALUES ('kanal-a', 'channel_events', 1, '{}')`,
      ).run();

      const targets = await listDesiredEventSubTargets(database as unknown as D1Database, "kanal-a");
      expect(targets.filter((target) => target.subscriptionType === "channel.raid")).toEqual([
        { channelId: "kanal-a", subscriptionType: "channel.raid", variant: "incoming", version: "1" },
        { channelId: "kanal-a", subscriptionType: "channel.raid", variant: "outgoing", version: "1" },
      ]);
      expect(targets.filter((target) => target.subscriptionType !== "channel.raid")).toEqual([
        { channelId: "kanal-a", subscriptionType: "channel.shoutout.create", variant: "", version: "1", deferredReason: "moderator_required" },
        { channelId: "kanal-a", subscriptionType: "channel.shoutout.receive", variant: "", version: "1", deferredReason: "moderator_required" },
        { channelId: "kanal-a", subscriptionType: "channel.chat.notification", variant: "", version: "1" },
        { channelId: "kanal-a", subscriptionType: "channel.moderate", variant: "", version: "2", deferredReason: "moderator_required" },
        { channelId: "kanal-a", subscriptionType: "automod.message.hold", variant: "", version: "1", deferredReason: "moderator_required" },
        { channelId: "kanal-a", subscriptionType: "channel.suspicious_user.message", variant: "", version: "1", deferredReason: "moderator_required" },
        { channelId: "kanal-a", subscriptionType: "channel.suspicious_user.update", variant: "", version: "1", deferredReason: "moderator_required" },
      ]);
    } finally {
      database.close();
    }
  });

  it("defers mandatory moderation targets until the bot is a moderator", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
      await database.prepare(
        `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
         VALUES ('kanal-a', 'channel_events', 0, '{}')`,
      ).run();

      const targets = await listDesiredEventSubTargets(database as unknown as D1Database, "kanal-a");
      expect(targets.filter((target) => [
        "automod.message.hold",
        "channel.suspicious_user.message",
        "channel.suspicious_user.update",
      ].includes(target.subscriptionType))).toEqual([
        { channelId: "kanal-a", subscriptionType: "automod.message.hold", variant: "", version: "1", deferredReason: "moderator_required" },
        { channelId: "kanal-a", subscriptionType: "channel.suspicious_user.message", variant: "", version: "1", deferredReason: "moderator_required" },
        { channelId: "kanal-a", subscriptionType: "channel.suspicious_user.update", variant: "", version: "1", deferredReason: "moderator_required" },
      ]);
    } finally {
      database.close();
    }
  });


});
