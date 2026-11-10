import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sendChatMessage: vi.fn() }));
vi.mock("../../src/worker/chat", () => ({ sendChatMessage: mocks.sendChatMessage }));

import { ChannelObject } from "../../src/worker/durable/ChannelObject";

const channelId = "channel_points_receipt";
const claimsKey = "module_alarm:send_claims";
const operationId = "redemption_interrupted";
const receiptKey = `channel-points-action:channel_points:${operationId}`;

const objectWithReceipt = (status: "sent" | "sending", gate: "pause" | "mute" | "credentials"): ChannelObject => {
  const claims = { [receiptKey]: { status, at: Date.now() } };
  const row = {
    language: "en", module_id: "channel_points", enabled: 1, settings: "{}", revision: 1,
    last_disabled_revision: null,
    muted: Number(gate === "mute"), muted_until: null, mute_until_stream_end: 0,
    mute_stream_started_at: null, mute_stream_id: null,
    paused: Number(gate === "pause"), paused_until: null, pause_until_stream_end: 0,
    pause_stream_started_at: null, pause_stream_id: null,
    stream_state: "offline", stream_started_at: null, stream_id: null,
  };
  const database = {
    prepare: vi.fn(() => ({
      bind: () => ({
        first: () => Promise.resolve(null),
        all: () => Promise.resolve({ results: [row] }),
      }),
    })),
  } as unknown as D1Database;
  const object = Object.create(ChannelObject.prototype) as ChannelObject;
  Object.assign(object as unknown as { ctx: unknown; env: unknown }, {
    ctx: {
      id: { name: channelId },
      storage: { get: vi.fn((key: string) => Promise.resolve(key === claimsKey ? claims : undefined)) },
    },
    env: { DB: database, TWITCH_CLIENT_ID: "client_fictional" },
  });
  return object;
};

describe("channel points action chat delivery receipts", () => {
  it.each(["pause", "mute", "credentials"] as const)(
    "replays a sent receipt before the %s output gate can block it",
    async (gate) => {
      mocks.sendChatMessage.mockReset().mockImplementation(async (...args: unknown[]) => {
        if (gate === "credentials") {
          return { sent: false, truncated: false, delivery: "not_attempted", reason: "app_token_unavailable", detail: {} };
        }
        const stillValid = args[5] as () => Promise<boolean>;
        await stillValid();
        return {
          sent: false, truncated: false, delivery: "not_attempted", reason: gate, detail: {},
        };
      });
      const object = objectWithReceipt("sent", gate);

      await expect(object.sendModuleChatMessage("channel_points", operationId, "Hello"))
        .resolves.toEqual({ sent: true, delivery: "sent", reason: null });
      expect(mocks.sendChatMessage).not.toHaveBeenCalled();
    },
  );

  it("keeps an interrupted sending receipt ambiguous without re-entering output gates", async () => {
    mocks.sendChatMessage.mockReset();
    const object = objectWithReceipt("sending", "pause");

    await expect(object.sendModuleChatMessage("channel_points", operationId, "Hello"))
      .resolves.toEqual({ sent: false, delivery: "ambiguous", reason: "already_attempted" });
    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
  });
});
