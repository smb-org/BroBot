import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  EVENTSUB_SUBSCRIPTION_DEFINITIONS,
  eventSubDefinitionForCondition,
  listDesiredEventSubTargets,
} from "../../src/worker/eventsub-subscriptions";
import { insertChannel, insertLoginIdentityAndSession } from "./fixtures";
import { TestD1Database } from "./test-d1";

describe("Kanalereignisse-EventSub-Ziele", () => {
  it("erzeugt für jeden Typ die vollständige Twitch-Bedingung", () => {
    const raid = EVENTSUB_SUBSCRIPTION_DEFINITIONS.filter((definition) => definition.subscriptionType === "channel.raid");
    expect(raid.map((definition) => definition.variant)).toEqual(["eingehend", "ausgehend"]);
    expect(raid.map((definition) => definition.buildCondition("kanal-a", "bot-1"))).toEqual([
      { to_broadcaster_user_id: "kanal-a" },
      { from_broadcaster_user_id: "kanal-a" },
    ]);
    expect(eventSubDefinitionForCondition("channel.raid", { to_broadcaster_user_id: "kanal-a" })?.variant).toBe("eingehend");
    expect(eventSubDefinitionForCondition("channel.raid", { from_broadcaster_user_id: "kanal-a" })?.variant).toBe("ausgehend");

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

  it("leitet die zustimmende Identität aus der jeweiligen Bedingung ab", () => {
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

  it("nimmt ausgeschaltete Kanalereignisse nicht in den Sollstand auf", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
      await database.prepare(
        `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
         VALUES ('kanal-a', 'kanalereignisse', 0, '{}')`,
      ).run();

      await expect(listDesiredEventSubTargets(database as unknown as D1Database, "kanal-a")).resolves.toEqual([]);
    } finally {
      database.close();
    }
  });

  it("nimmt bei aktiviertem Modul beide Raid-Ziele in den Sollstand auf", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
      await database.prepare(
        `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
         VALUES ('kanal-a', 'kanalereignisse', 1, '{}')`,
      ).run();

      const targets = await listDesiredEventSubTargets(database as unknown as D1Database, "kanal-a");
      expect(targets.filter((target) => target.subscriptionType === "channel.raid")).toEqual([
        { channelId: "kanal-a", subscriptionType: "channel.raid", variant: "eingehend", version: "1" },
        { channelId: "kanal-a", subscriptionType: "channel.raid", variant: "ausgehend", version: "1" },
      ]);
      expect(targets.filter((target) => target.subscriptionType !== "channel.raid")).toEqual([
        { channelId: "kanal-a", subscriptionType: "channel.shoutout.create", variant: "", version: "1" },
        { channelId: "kanal-a", subscriptionType: "channel.shoutout.receive", variant: "", version: "1" },
        { channelId: "kanal-a", subscriptionType: "channel.chat.notification", variant: "", version: "1" },
        { channelId: "kanal-a", subscriptionType: "channel.moderate", variant: "", version: "2" },
        { channelId: "kanal-a", subscriptionType: "automod.message.hold", variant: "", version: "1" },
        { channelId: "kanal-a", subscriptionType: "channel.suspicious_user.message", variant: "", version: "1" },
        { channelId: "kanal-a", subscriptionType: "channel.suspicious_user.update", variant: "", version: "1" },
      ]);
    } finally {
      database.close();
    }
  });

  it("erzeugt für ein ausgeschaltetes Modul keine neuen Moderationsziele", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "kanal-a");
      await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
      await database.prepare(
        `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
         VALUES ('kanal-a', 'kanalereignisse', 0, '{}')`,
      ).run();

      const targets = await listDesiredEventSubTargets(database as unknown as D1Database, "kanal-a");
      expect(targets.filter((target) => [
        "automod.message.hold",
        "channel.suspicious_user.message",
        "channel.suspicious_user.update",
      ].includes(target.subscriptionType))).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("übernimmt bestehende Abo-Zustände in die leere Standardvariante", async () => {
    const database = new TestD1Database(12);
    try {
      await insertChannel(database, "kanal-a");
      await database.prepare(
        `INSERT INTO eventsub_subscriptions
          (channel_id, subscription_type, subscription_id, secret_id, status, reason, updated_at)
         VALUES ('kanal-a', 'channel.chat.message', 'abo-1', 'secret-1', 'enabled', NULL, ?)`,
      ).bind("2026-09-20T00:00:00.000Z").run();
      database.sqlite.exec(readFileSync(resolve(import.meta.dirname, "../../migrations/0012_eventsub_abo_varianten.sql"), "utf8"));

      await expect(database.prepare(
        "SELECT channel_id, subscription_type, variant, subscription_id FROM eventsub_subscriptions",
      ).first()).resolves.toEqual({
        channel_id: "kanal-a",
        subscription_type: "channel.chat.message",
        variant: "",
        subscription_id: "abo-1",
      });
    } finally {
      database.close();
    }
  });

  it("übernimmt alte Abo-Zustände als v1 und hält v2 separat", async () => {
    const database = new TestD1Database(13);
    try {
      await insertChannel(database, "kanal-a");
      await database.prepare(
        `INSERT INTO eventsub_subscriptions
          (channel_id, subscription_type, variant, subscription_id, secret_id, status, reason, updated_at)
         VALUES ('kanal-a', 'channel.chat.message', '', 'abo-1', 'secret-1', 'enabled', NULL, ?)`,
      ).bind("2026-09-20T00:00:00.000Z").run();
      database.sqlite.exec(readFileSync(resolve(import.meta.dirname, "../../migrations/0013_eventsub_abo_versionen.sql"), "utf8"));
      await database.prepare(
        `INSERT INTO eventsub_subscriptions
          (channel_id, subscription_type, variant, version, subscription_id, secret_id, status, reason, updated_at)
         VALUES ('kanal-a', 'channel.moderate', '', '2', 'abo-2', 'secret-1', 'enabled', NULL, ?)`,
      ).bind("2026-09-20T00:00:00.000Z").run();

      await expect(database.prepare(
        "SELECT subscription_type, variant, version, subscription_id FROM eventsub_subscriptions ORDER BY subscription_type",
      ).all()).resolves.toMatchObject({
        results: [
          { subscription_type: "channel.chat.message", variant: "", version: "1", subscription_id: "abo-1" },
          { subscription_type: "channel.moderate", variant: "", version: "2", subscription_id: "abo-2" },
        ],
      });
    } finally {
      database.close();
    }
  });
});
