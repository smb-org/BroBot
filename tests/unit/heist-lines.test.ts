import { describe, expect, it, vi } from "vitest";
import type { ModuleAlarmContext, ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import { heistModule } from "../../src/modules/heist";
import { heistSettingsForLanguage } from "../../src/modules/heist/contracts";
import { processHeistMessage } from "../../src/modules/heist/service";

const renderContext = {
  renderTemplate: (text: string, values: Record<string, string | number> = {}) => Promise.resolve({
    text: text.replace(/\{([a-zA-Z0-9_.]+)\}/gu, (token, name: string) => values[name] === undefined ? token : String(values[name])),
  }),
} as unknown as ModuleAlarmContext;

describe("heist chat output", () => {
  it("uses a thread reply for the start and one compact final summary with truncated name lists", async () => {
    const settings = heistSettingsForLanguage("en");
    const data = {
      language: "en" as const,
      joinWindowSeconds: 60,
      startMessageId: "fictional-start-message",
      startText: settings.startText,
      startTextEnabled: true,
      resultText: settings.resultText,
      resultTextEnabled: true,
    };
    const announcement = await heistModule.formatPointRoundAnnouncement?.(renderContext, {
      roundId: "fictional_heist_round",
      data,
      text: settings.startText,
    });
    const result = await heistModule.formatPointRoundResult?.(renderContext, {
      roundId: "fictional_heist_round",
      data,
      result: {
        chancePercent: 54,
        participantCount: 12,
        winners: Array.from({ length: 7 }, (_, index) => ({ accountId: `viewer_${String(index)}`, login: `winner_${String(index)}`, stake: 50, payout: 100 })),
        losers: Array.from({ length: 5 }, (_, index) => ({ accountId: `loser_${String(index)}`, login: `loser_${String(index)}`, stake: 50 })),
      },
      resolvedAt: "2100-01-01T00:00:00.000Z",
    });

    expect(announcement).toMatchObject({ replyToMessageId: "fictional-start-message", automated: false });
    expect(announcement?.kind === "silent" ? "" : announcement?.text).toContain("60 s");
    expect(result?.replyToMessageId).toBe("fictional-start-message");
    expect(result?.text).toContain("+2 more");
    expect(result?.text).not.toContain("+0 more");
    expect(result?.text.length).toBeLessThanOrEqual(500);
    expect(result?.text).not.toMatch(/[\r\n]/u);
  });

  it("keeps the round to the start and result lines by sending no join confirmations", async () => {
    const settings = heistSettingsForLanguage("en");
    const participant = { roundId: "fictional_heist_round", state: "open" as const, deadlineAt: Date.now() + 60_000, data: {} };
    const points = {
      rounds: {
        active: () => Promise.resolve(participant),
        join: vi.fn(() => Promise.resolve({ status: "joined" as const, replayed: false })),
      },
    };
    const event: ModuleEvent<typeof settings> = {
      channelId: "fictional_channel",
      subscriptionType: "channel.chat.message",
      triggerId: "fictional-heist-message",
      payload: {
        message: { text: "!heist 75" },
        message_id: "fictional-join-message",
        chatter_user_id: "viewer_anna",
        chatter_user_login: "frostfern",
      },
      settings,
      receivedAt: "2100-01-01T00:00:00.000Z",
      eventSubTimestamp: "2100-01-01T00:00:00.000Z",
      actor: null,
      chatStatus: ["viewer"],
    };
    const context = { points } as unknown as ModuleExecutionContext;

    const processed = await processHeistMessage(event, context);

    expect(processed.actions).toEqual([]);
    expect(points.rounds.join).toHaveBeenCalledWith(
      "fictional_heist_round",
      "round:fictional_heist_round:participant:viewer_anna",
      "viewer_anna",
      "frostfern",
      75,
      {},
    );
  });

  it("suppresses disabled start and result messages without erasing their templates", async () => {
    const settings = heistSettingsForLanguage("en");
    const data = {
      language: "en" as const,
      joinWindowSeconds: 60,
      startMessageId: "fictional-start-message",
      startText: settings.startText,
      startTextEnabled: false,
      resultText: settings.resultText,
      resultTextEnabled: false,
    };
    const announcement = await heistModule.formatPointRoundAnnouncement?.(renderContext, {
      roundId: "fictional_heist_round", data, text: settings.startText,
    });
    const result = await heistModule.formatPointRoundResult?.(renderContext, {
      roundId: "fictional_heist_round",
      data,
      result: { chancePercent: 50, participantCount: 1, winners: [], losers: [{ accountId: "viewer_anna", login: "frostfern", stake: 50 }] },
      resolvedAt: "2100-01-01T00:00:00.000Z",
    });

    expect(announcement).toEqual({ kind: "silent" });
    expect(result).toBeNull();
    expect(data.startText).toBe(settings.startText);
    expect(data.resultText).toBe(settings.resultText);
  });

  it("opens the round with an account-derived stake operation, a global lock, and the configured timing", async () => {
    const settings = heistSettingsForLanguage("en");
    let openArgs: unknown[] = [];
    const openWithStake = vi.fn((...args: unknown[]) => {
      openArgs = args;
      return Promise.resolve({ roundId: "heist-round", replayed: false });
    });
    const points = {
      rounds: {
        active: () => Promise.resolve(null),
        openWithStake,
      },
    };
    const event: ModuleEvent<typeof settings> = {
      channelId: "fictional_channel",
      subscriptionType: "channel.chat.message",
      triggerId: "fictional-heist-start",
      payload: {
        message: { text: "!heist 100" },
        message_id: "fictional-start-message",
        chatter_user_id: "viewer_anna",
        chatter_user_login: "frostfern",
      },
      settings,
      receivedAt: "2100-01-01T00:00:00.000Z",
      eventSubTimestamp: "2100-01-01T00:00:00.000Z",
      actor: null,
      chatStatus: ["viewer"],
    };

    const processed = await processHeistMessage(event, { points, channelLanguage: () => Promise.resolve("en") } as unknown as ModuleExecutionContext);
    const [roundId, data, operationId, accountId, login, stake, cooldown] = openArgs;

    expect(processed.actions).toEqual([]);
    expect(roundId).toMatch(/^heist-[a-f0-9]{40}$/u);
    expect(operationId).toBe(`round:${String(roundId)}:participant:viewer_anna`);
    expect([accountId, login, stake, cooldown]).toEqual([
      "viewer_anna", "frostfern", 100, { key: "between-rounds", seconds: 90 },
    ]);
    expect(data).toMatchObject({
      durationS: 60,
      lockKeys: ["heist:active"],
      settlement: { kind: "heist", params: { baseChance: 50, maxChance: 65 } },
      startMessageId: "fictional-start-message",
    });
  });
});
