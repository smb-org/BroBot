import { afterEach, describe, expect, it } from "vitest";

import {
  eventSubDefinitionForCondition,
  listDesiredEventSubTargets,
} from "../../src/worker/eventsub-subscriptions";
import { insertChannel, insertLoginIdentityAndSession } from "./fixtures";
import { TestD1Database } from "./test-d1";

describe("Werbung-EventSub", () => {
  let database: TestD1Database;

  afterEach(() => { database.close(); });

  it("abonniert stream.online und channel.ad_break.begin als v1 nur mit broadcaster_user_id", async () => {
    database = new TestD1Database();
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:read:ads"]);
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('kanal-a', 'ads', 1, '{}')",
    ).run();

    await expect(listDesiredEventSubTargets(database as unknown as D1Database)).resolves.toEqual([
      { channelId: "kanal-a", subscriptionType: "stream.online", variant: "", version: "1" },
      { channelId: "kanal-a", subscriptionType: "channel.ad_break.begin", variant: "", version: "1" },
    ]);

    const definition = eventSubDefinitionForCondition("channel.ad_break.begin", { broadcaster_user_id: "kanal-a" });
    expect(definition?.version).toBe("1");
    expect(definition?.buildCondition("kanal-a", "bot-user")).toEqual({ broadcaster_user_id: "kanal-a" });
  });

  it("legt ohne channel:read:ads kein Werbepausen-Abo an", async () => {
    database = new TestD1Database();
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:bot"]);
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('kanal-a', 'ads', 1, '{}')",
    ).run();

    const targets = await listDesiredEventSubTargets(database as unknown as D1Database);
    expect(targets.filter((target) => target.subscriptionType === "stream.online")).toEqual([
      { channelId: "kanal-a", subscriptionType: "stream.online", variant: "", version: "1" },
    ]);
    expect(targets.some((target) => target.subscriptionType === "channel.ad_break.begin")).toBe(false);
    expect(targets.some((target) => target.subscriptionType === "channel.chat.notification")).toBe(true);
  });
});
