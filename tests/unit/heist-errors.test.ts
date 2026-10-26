import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleAlarmContext, ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import { heistSettingsForLanguage } from "../../src/modules/heist/contracts";
import { processHeistMessage, startHeistCooldown } from "../../src/modules/heist/service";

const now = Date.UTC(2100, 0, 1);
const settings = heistSettingsForLanguage("en");

const event = (messageId: string, text = "!heist 75"): ModuleEvent<typeof settings> => ({
  channelId: "fictional_channel",
  subscriptionType: "channel.chat.message",
  triggerId: messageId,
  payload: { message: { text }, message_id: messageId, chatter_user_id: "viewer_anna", chatter_user_login: "frostfern" },
  settings,
  receivedAt: "2100-01-01T00:00:00.000Z",
  eventSubTimestamp: "2100-01-01T00:00:00.000Z",
  actor: null,
  chatStatus: ["viewer"],
});

const openRound = { roundId: "heist-fictional", state: "open" as const, deadlineAt: now + 30_000, data: {} };

const contextWith = (rounds: Record<string, unknown>): ModuleExecutionContext => ({
  points: { claimCooldown: () => Promise.resolve(true), rounds },
  scheduleAlarm: () => Promise.resolve(),
  channelLanguage: () => Promise.resolve("en"),
}) as unknown as ModuleExecutionContext;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});

describe("heist join and start errors", () => {
  it("keys the join stake on the chat message so a redelivery cannot debit twice", async () => {
    const join = vi.fn(() => Promise.resolve({ status: "joined" as const, replayed: false }));

    await processHeistMessage(event("fictional-message-1"), contextWith({ active: () => Promise.resolve(openRound), join }));

    expect(join).toHaveBeenCalledWith("heist-fictional", "msg:fictional-message-1", "viewer_anna", "frostfern", 75, {});
  });

  it("answers a viewer without enough points when joining and when starting", async () => {
    const poor = () => Promise.reject(new Error("insufficient_points"));
    const joined = await processHeistMessage(event("fictional-message-2"), contextWith({ active: () => Promise.resolve(openRound), join: poor }));
    const started = await processHeistMessage(event("fictional-message-3"), contextWith({ active: () => Promise.resolve(null), openWithStake: poor }));

    for (const result of [joined, started]) {
      expect(result.actions).toEqual([expect.objectContaining({ kind: "chat", text: "You do not have enough points for that stake." })]);
    }
  });

  it("ignores a replayed stake from an earlier round and surfaces anything unexpected", async () => {
    const conflict = () => Promise.reject(new Error("operation_conflict"));
    const broken = () => Promise.reject(new Error("storage_failed"));

    const ignored = await processHeistMessage(event("fictional-message-4"), contextWith({ active: () => Promise.resolve(openRound), join: conflict }));

    expect(ignored.actions).toEqual([]);
    await expect(processHeistMessage(event("fictional-message-5"), contextWith({ active: () => Promise.resolve(openRound), join: broken })))
      .rejects.toThrow("storage_failed");
    await expect(processHeistMessage(event("fictional-message-6"), contextWith({ active: () => Promise.resolve(null), openWithStake: broken })))
      .rejects.toThrow("storage_failed");
  });
});

describe("heist pause between rounds", () => {
  const resolved = (cooldownSeconds: number | undefined, resolvedAgoMs: number) => ({
    roundId: "heist-fictional",
    data: {
      language: "en", joinWindowSeconds: 60, startMessageId: "m", startText: "s", resultText: "r",
      ...(cooldownSeconds === undefined ? {} : { cooldownSeconds }),
    },
    result: {},
    resolvedAt: new Date(now - resolvedAgoMs).toISOString(),
  });
  const alarmContext = () => {
    const claimCooldown = vi.fn(() => Promise.resolve(true));
    return { claimCooldown, context: { points: { claimCooldown } } as unknown as ModuleAlarmContext };
  };

  it("starts counting at settlement, not at the start message", async () => {
    const { claimCooldown, context } = alarmContext();

    await startHeistCooldown(context, resolved(30, 0));

    expect(claimCooldown).toHaveBeenCalledWith("between-rounds", 30);
  });

  it("only claims what is left when the notification is replayed late", async () => {
    const late = alarmContext();
    const over = alarmContext();
    const none = alarmContext();

    await startHeistCooldown(late.context, resolved(30, 12_000));
    await startHeistCooldown(over.context, resolved(30, 45_000));
    await startHeistCooldown(none.context, resolved(undefined, 0));

    expect(late.claimCooldown).toHaveBeenCalledWith("between-rounds", 18);
    expect(over.claimCooldown).not.toHaveBeenCalled();
    expect(none.claimCooldown).not.toHaveBeenCalled();
  });
});
