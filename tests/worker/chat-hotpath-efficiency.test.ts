import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { MODULES } from "../../src/modules/registry";
import { ChannelObject } from "../../src/worker/durable/ChannelObject";
import { dispatchEventSubNotification } from "../../src/worker/dispatch";
import { eventSubRouter } from "../../src/worker/eventsub";
import { clearPointObjectAlarms, insertPointChannel, pointObject, runMigrations, runPointObject } from "./points-test-helpers";

const worker = env as unknown as Env;
const pointGameIds = new Set(["emote_slots", "blitz_round", "duel", "boss_fight", "heist"]);
const registry = MODULES.filter(({ id }) => id === "points" || pointGameIds.has(id) || id === "faq" || id === "api_source");
const encoder = new TextEncoder();
const eventSubSecret = JSON.stringify({ active: { id: "test-key", key: "A".repeat(43) }, retired: [] });

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const chatEvent = (channelId: string, messageId: string, text: string, timestamp: string) => ({
  channelId,
  subscriptionType: "channel.chat.message",
  triggerId: messageId,
  payload: {
    broadcaster_user_id: channelId,
    broadcaster_user_login: channelId,
    chatter_user_id: "hotpath-viewer",
    chatter_user_login: "frostfern",
    message_id: messageId,
    message: { text, fragments: [{ type: "text", text }] },
    badges: [],
  },
  receivedAt: timestamp,
  eventSubTimestamp: timestamp,
});

const signedChatNotification = async (channelId: string, messageId: string): Promise<Request> => {
  const event = chatEvent(channelId, messageId, "an ordinary message", new Date().toISOString());
  const body = JSON.stringify({
    subscription: { type: "channel.chat.message", version: "1", condition: { broadcaster_user_id: channelId } },
    event: event.payload,
  });
  const ring = JSON.parse(eventSubSecret) as { active: { key: string } };
  const timestamp = new Date().toISOString();
  const key = await crypto.subtle.importKey("raw", encoder.encode(ring.active.key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = hex(await crypto.subtle.sign("HMAC", key, encoder.encode(`${messageId}${timestamp}${body}`)));
  return new Request("https://brobot.example/api/twitch/eventsub", {
    method: "POST",
    body,
    headers: {
      "Twitch-Eventsub-Message-Id": messageId,
      "Twitch-Eventsub-Message-Timestamp": timestamp,
      "Twitch-Eventsub-Message-Signature": `sha256=${signature}`,
      "Twitch-Eventsub-Message-Type": "notification",
    },
  });
};

beforeAll(runMigrations);
afterEach(async () => {
  await clearPointObjectAlarms();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ordinary chat dispatch efficiency", () => {
  it("avoids unchanged game gates, FAQ echo RPCs, API catalogs, panel drains, and account rewrites", async () => {
    const channelId = `chat-hotpath-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await worker.DB.prepare(
      "INSERT INTO channel_stream_state (channel_id, state, changed_at, source) VALUES (?, 'offline', ?, 'eventsub')",
    ).bind(channelId, new Date().toISOString()).run();
    for (const module of registry) {
      const settings = module.id === "points"
        ? Object.assign({}, module.defaultSettings as object, { startBonus: 0, activityAmount: 0, safetyNetEnabled: false })
        : module.defaultSettings;
      await worker.DB.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, ?, 1, ?, 1)",
      ).bind(channelId, module.id, JSON.stringify(settings)).run();
    }

    const gameGate = vi.spyOn(ChannelObject.prototype, "setGameModuleGate");
    const recordChatActivity = vi.spyOn(ChannelObject.prototype, "recordChatActivity");
    const preparePointChat = vi.spyOn(ChannelObject.prototype, "preparePointChat");
    const isRecentBotChatMessage = vi.spyOn(ChannelObject.prototype, "isRecentBotChatMessage");
    const claimEventSubMessage = vi.spyOn(ChannelObject.prototype, "claimEventSubMessage");
    const databasePrepare = vi.spyOn(worker.DB, "prepare");
    const warmupAt = "2026-10-28T10:00:00.000Z";

    await dispatchEventSubNotification(worker, chatEvent(channelId, "warmup-message", "ordinary text", warmupAt), vi.fn<typeof fetch>(), registry);
    expect(gameGate).toHaveBeenCalledTimes(pointGameIds.size);
    const accountUpdatedAt = await runPointObject(pointObject(channelId), (_target, state) =>
      state.storage.sql.exec<{ updated_at: string }>(
        "SELECT updated_at FROM point_accounts WHERE account_id = ?",
        "hotpath-viewer",
      ).one().updated_at);
    await worker.DB.prepare("DELETE FROM panel_resource_pending").run();

    gameGate.mockClear();
    recordChatActivity.mockClear();
    preparePointChat.mockClear();
    isRecentBotChatMessage.mockClear();
    claimEventSubMessage.mockClear();
    databasePrepare.mockClear();

    const response = await eventSubRouter.fetch(await signedChatNotification(channelId, "measured-message"), {
      DB: worker.DB,
      CHANNEL: worker.CHANNEL,
      TWITCH_CLIENT_ID: "test-client",
      TWITCH_CLIENT_SECRET: "test-client-secret",
      TWITCH_EVENTSUB_SECRET: eventSubSecret,
    });
    expect(response.status).toBe(204);

    const statementSql = databasePrepare.mock.calls.map(([sql]) => sql.toLowerCase().replaceAll(/\s+/g, " ").trim());
    expect(statementSql).toHaveLength(7);
    expect(statementSql.some((sql) => sql.includes("from api_sources"))).toBe(false);
    expect(statementSql.filter((sql) => sql.includes("panel_resource_pending"))).toEqual([
      "select channel_id from panel_resource_pending order by channel_id limit 1",
    ]);
    expect(gameGate).not.toHaveBeenCalled();
    expect(isRecentBotChatMessage).not.toHaveBeenCalled();
    expect(recordChatActivity).toHaveBeenCalledTimes(1);
    expect(preparePointChat).toHaveBeenCalledTimes(1);
    expect(claimEventSubMessage).toHaveBeenCalledTimes(1);
    await expect(runPointObject(pointObject(channelId), (_target, state) =>
      state.storage.sql.exec<{ updated_at: string }>(
        "SELECT updated_at FROM point_accounts WHERE account_id = ?",
        "hotpath-viewer",
      ).one().updated_at)).resolves.toBe(accountUpdatedAt);
  });
});
