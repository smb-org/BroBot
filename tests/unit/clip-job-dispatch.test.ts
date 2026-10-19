import { describe, expect, it, vi } from "vitest";

import { clipsSettingsSchema } from "../../src/modules/clips/contracts";
import { clipsModule } from "../../src/modules/clips";
import { dispatchEventSubNotification } from "../../src/worker/dispatch";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

describe("clip chat command dispatch", () => {
  it("enqueues a durable job and returns without calling Twitch", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "clip-dispatch-channel");
      const settings = clipsSettingsSchema.parse({ chatLinkTemplate: "Clip: {clip.url}" });
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'clips', 1, ?)",
      ).bind("clip-dispatch-channel", JSON.stringify(settings)).run();

      const enqueueClipJob = vi.fn().mockResolvedValue("enqueued");
      const channelObject = {
        publish: vi.fn().mockResolvedValue(undefined),
        recordChatActivity: vi.fn().mockResolvedValue(1),
        claimPointCooldown: vi.fn().mockResolvedValue(true),
        enqueueClipJob,
      };
      const environment = {
        DB: database as unknown as D1Database,
        CHANNEL: {
          idFromName: (channelId: string) => channelId,
          get: () => channelObject,
        },
      } as unknown as Env;
      const fetcher = vi.fn<typeof fetch>();

      await dispatchEventSubNotification(environment, {
        channelId: "clip-dispatch-channel",
        subscriptionType: "channel.chat.message",
        triggerId: "eventsub-message-1",
        receivedAt: "2026-10-19T10:00:00.000Z",
        payload: {
          message: { text: "!clip" },
          message_id: "chat-message-1",
          chatter_user_id: "viewer-1",
          chatter_user_login: "viewer",
          broadcaster_user_id: "clip-dispatch-channel",
          badges: [],
        },
      }, fetcher, [clipsModule]);

      expect(enqueueClipJob).toHaveBeenCalledWith(
        "eventsub-message-1",
        "viewer-1",
        expect.objectContaining({ postClipLinkInChat: true, chatLinkTemplate: "Clip: {clip.url}" }),
        settings.commandCooldownSeconds,
      );
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      database.close();
    }
  });

  it("retries an uncertain enqueue response with the same idempotency key", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "clip-dispatch-retry-channel");
      const settings = clipsSettingsSchema.parse({});
      await database.prepare(
        "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'clips', 1, ?)",
      ).bind("clip-dispatch-retry-channel", JSON.stringify(settings)).run();

      let stubIndex = 0;
      let enqueueAttempt = 0;
      const enqueueCalls: Array<{ stubIndex: number; args: unknown[] }> = [];
      const channelNamespace = {
        idFromName: (channelId: string) => channelId,
        get: vi.fn(() => {
          const currentStub = stubIndex;
          stubIndex += 1;
          return {
            publish: vi.fn().mockResolvedValue(undefined),
            recordChatActivity: vi.fn().mockResolvedValue(1),
            claimPointCooldown: vi.fn().mockResolvedValue(true),
            enqueueClipJob: vi.fn((...args: unknown[]) => {
              enqueueCalls.push({ stubIndex: currentStub, args });
              const attempt = enqueueAttempt;
              enqueueAttempt += 1;
              return attempt === 0 ? Promise.reject(new Error("Broken Durable Object stub")) : Promise.resolve("enqueued");
            }),
          };
        }),
      };
      const environment = {
        DB: database as unknown as D1Database,
        CHANNEL: channelNamespace,
      } as unknown as Env;

      await dispatchEventSubNotification(environment, {
        channelId: "clip-dispatch-retry-channel",
        subscriptionType: "channel.chat.message",
        triggerId: "eventsub-message-retry",
        receivedAt: "2026-10-19T10:00:00.000Z",
        payload: {
          message: { text: "!clip" },
          message_id: "chat-message-retry",
          chatter_user_id: "viewer-1",
          chatter_user_login: "viewer",
          broadcaster_user_id: "clip-dispatch-retry-channel",
          badges: [],
        },
      }, vi.fn<typeof fetch>(), [clipsModule]);

      expect(enqueueCalls).toHaveLength(2);
      expect(enqueueCalls[0]?.stubIndex).not.toBe(enqueueCalls[1]?.stubIndex);
      expect(enqueueCalls[0]?.args).toEqual(enqueueCalls[1]?.args);
    } finally {
      database.close();
    }
  });
});
