import { afterEach, describe, expect, it } from "vitest";

import {
  eventSubDefinitionForCondition,
  listDesiredEventSubTargets,
} from "../../src/worker/eventsub-subscriptions";
import { upsertLoginIdentity } from "../../src/worker/db/login-identity";
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

  it("keeps the ad-break subscription after a narrower login replaces current token scopes", async () => {
    database = new TestD1Database();
    await insertChannel(database, "kanal-a");
    await insertLoginIdentityAndSession(database, "kanal-a", ["channel:read:ads"]);
    await upsertLoginIdentity(database as unknown as D1Database, {
      userId: "kanal-a",
      login: "kanal-a",
      scopesJson: JSON.stringify(["channel:bot"]),
      tokenScopesJson: JSON.stringify(["channel:bot"]),
      accessTokenCiphertext: "access-narrow",
      refreshTokenCiphertext: "refresh-narrow",
      expiresAt: "2099-09-19T00:00:00.000Z",
      status: "connected",
      reason: null,
      createdAt: "2026-09-18T00:00:00.000Z",
      updatedAt: "2026-09-19T00:00:00.000Z",
    });
    await database.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES ('kanal-a', 'ads', 1, '{}')",
    ).run();

    const targets = await listDesiredEventSubTargets(database as unknown as D1Database, "kanal-a");
    const identity = await database.prepare(
      "SELECT scopes_json, token_scopes_json FROM twitch_login_identity WHERE user_id = 'kanal-a'",
    ).first();

    expect(identity).toEqual({
      scopes_json: '["channel:bot","channel:read:ads"]',
      token_scopes_json: '["channel:bot"]',
    });
    expect(targets).toContainEqual({
      channelId: "kanal-a", subscriptionType: "stream.online", variant: "", version: "1",
    });
    expect(targets).toContainEqual({
      channelId: "kanal-a", subscriptionType: "channel.ad_break.begin", variant: "", version: "1",
    });
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
