import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import { eventSubRouter } from "../../src/worker/eventsub";
import { insertPointChannel, runMigrations } from "./points-test-helpers";

const worker = env as unknown as Env;
const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

// The EventSub secret binding is a key ring; Twitch signs with the active key's text as the HMAC secret.
const signedNotification = async (messageId: string, body: string): Promise<Request> => {
  const ring = JSON.parse(worker.TWITCH_EVENTSUB_SECRET) as { active: { key: string } };
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

const notificationBody = (type: string, channelId: string, event: Record<string, unknown>): string => JSON.stringify({
  subscription: { type, version: "1", condition: { broadcaster_user_id: channelId } },
  event,
});

const receiptCount = async (): Promise<number> => (await worker.DB.prepare(
  "SELECT COUNT(*) AS count FROM eventsub_messages",
).first<{ count: number }>())?.count ?? -1;

describe("EventSub message de-duplication", () => {
  beforeAll(async () => {
    await runMigrations();
  });

  it("processes a redelivered chat message once across a Durable Object restart and writes no D1 receipt", async () => {
    const channelId = "dedup-chat-channel";
    await insertPointChannel(channelId);
    const stub = worker.CHANNEL.get(worker.CHANNEL.idFromName(channelId));
    const body = notificationBody("channel.chat.message", channelId, {
      broadcaster_user_id: channelId,
      chatter_user_id: "viewer-1",
      message: { text: "hello", fragments: [{ type: "text", text: "hello" }] },
    });

    expect((await eventSubRouter.fetch(await signedNotification("chat-message-redelivered", body), worker)).status).toBe(204);
    expect(await stub.getChatActivityCount()).toBe(1);

    await evictDurableObject(stub);
    expect((await eventSubRouter.fetch(await signedNotification("chat-message-redelivered", body), worker)).status).toBe(204);
    expect(await stub.getChatActivityCount()).toBe(1);

    expect((await eventSubRouter.fetch(await signedNotification("chat-message-next", body), worker)).status).toBe(204);
    expect(await stub.getChatActivityCount()).toBe(2);
    expect(await receiptCount()).toBe(0);
  });

  it("keeps de-duplicating non-chat events through the D1 receipt table", async () => {
    const channelId = "dedup-offline-channel";
    await insertPointChannel(channelId);
    const body = notificationBody("stream.offline", channelId, { broadcaster_user_id: channelId });

    expect((await eventSubRouter.fetch(await signedNotification("offline-message-redelivered", body), worker)).status).toBe(204);
    expect((await eventSubRouter.fetch(await signedNotification("offline-message-redelivered", body), worker)).status).toBe(204);

    const rows = await worker.DB.prepare("SELECT message_id FROM eventsub_messages").all<{ message_id: string }>();
    expect(rows.results).toEqual([{ message_id: "offline-message-redelivered" }]);
  });
});
