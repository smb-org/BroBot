import { describe, expect, it, vi } from "vitest";

import type { ModuleExecutionContext } from "../../src/modules/contract";
import { chatMessageAction } from "../../src/modules/channel_points/actions/chat-message";

describe("channel points chat message action", () => {
  const redemption = {
    id: "redemption_fictional",
    rewardId: "reward_fictional",
    rewardTitle: "Fictional reward",
    userId: "viewer_fictional",
    userLogin: "viewer_demo",
    userName: "Viewer Demo",
    userInput: "hello",
    redeemedAt: "2026-11-10T12:00:00.000Z",
  };

  it("renders the supported placeholders and returns fulfilled after an accepted send", async () => {
    const sendChat = vi.fn().mockResolvedValue({ sent: true, delivery: "sent", reason: null });
    const result = await chatMessageAction.execute({
      sendChat,
    } as unknown as ModuleExecutionContext, {
      redemption,
      config: { message: "{user}: {input} for {reward}" },
      operationId: "operation_fictional",
    });
    expect(sendChat).toHaveBeenCalledWith("Viewer Demo: hello for Fictional reward", "operation_fictional");
    expect(result).toBe("fulfilled");
  });

  it("returns a refund for a definite send rejection and pending for an ambiguous send", async () => {
    const rejected = await chatMessageAction.execute({
      sendChat: vi.fn().mockResolvedValue({ sent: false, delivery: "rejected", reason: "automod" }),
    } as unknown as ModuleExecutionContext, {
      redemption, config: { message: "Hello" }, operationId: "operation_rejected",
    });
    const ambiguous = await chatMessageAction.execute({
      sendChat: vi.fn().mockResolvedValue({ sent: false, delivery: "ambiguous", reason: "timeout" }),
    } as unknown as ModuleExecutionContext, {
      redemption, config: { message: "Hello" }, operationId: "operation_ambiguous",
    });
    if (typeof rejected !== "object" || !("refund" in rejected)) {
      throw new Error("A definite chat rejection must request a refund.");
    }
    expect(rejected.refund.de.length).toBeGreaterThan(0);
    expect(rejected.refund.en.length).toBeGreaterThan(0);
    expect(ambiguous).toBe("pending");
  });
});
