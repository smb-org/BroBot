import { describe, expect, it, vi } from "vitest";

import type { ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import { duelSettingsForLanguage, type DuelSettings } from "../../src/modules/duel/contracts";
import { processDuelMessage } from "../../src/modules/duel/service";

const eventFor = (settings: DuelSettings): ModuleEvent<DuelSettings> => ({
  channelId: "duel-channel",
  subscriptionType: "channel.chat.message",
  triggerId: "duel-message-switch",
  payload: {
    message: { text: "!duel 0" },
    message_id: "duel-message-id",
    chatter_user_id: "duel-user-id",
    chatter_user_login: "dueluser",
  },
  settings,
  receivedAt: "2026-10-24T10:00:00.000Z",
  eventSubTimestamp: "2026-10-24T10:00:00.000Z",
  actor: null,
  chatStatus: ["viewer"],
});

const contextFor = (claimCooldown = vi.fn(() => Promise.resolve(true))): ModuleExecutionContext => ({
  points: { claimCooldown },
  channelLanguage: vi.fn(() => Promise.resolve("en" as const)),
} as unknown as ModuleExecutionContext);

describe("duel message switches", () => {
  it("suppresses a disabled error reply while preserving its saved text", async () => {
    const settings = duelSettingsForLanguage("en");
    const disabled = {
      ...settings,
      texts: { ...settings.texts, errors: { ...settings.texts.errors, invalidStakeEnabled: false } },
    };
    const context = contextFor();

    const result = await processDuelMessage(eventFor(disabled), context);

    expect(result.actions).toEqual([]);
    expect(context.points.claimCooldown).not.toHaveBeenCalled();
    expect(disabled.texts.errors.invalidStake).toBe(settings.texts.errors.invalidStake);
  });

  it("keeps legacy non-empty error replies enabled when the switch is missing", async () => {
    const settings = duelSettingsForLanguage("en");
    const context = contextFor();

    const result = await processDuelMessage(eventFor(settings), context);

    expect(result.actions).toEqual([{
      kind: "chat",
      text: "Enter a positive whole number for the stake.",
      replyToMessageId: "duel-message-id",
      automated: false,
    }]);
    expect(context.points.claimCooldown).toHaveBeenCalledOnce();
  });
});
