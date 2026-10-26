import { describe, expect, it, vi } from "vitest";
import type { ModuleAlarmContext, ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import { heistModule } from "../../src/modules/heist";
import { heistSettingsForLanguage } from "../../src/modules/heist/contracts";
import { HEIST_TEMPLATE_FIELDS } from "../../src/modules/heist/contracts/template-variables";
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
      "msg:fictional-join-message",
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

    const scheduleAlarm = vi.fn(() => Promise.resolve());
    const processed = await processHeistMessage(event, { points, scheduleAlarm, channelLanguage: () => Promise.resolve("en") } as unknown as ModuleExecutionContext);
    const [roundId, data, operationId, accountId, login, stake, cooldown] = openArgs;

    expect(processed.actions).toEqual([]);
    // The midway line is planned for half of the 60 s window; the alarm corrects it to the real deadline.
    expect(scheduleAlarm).toHaveBeenCalledWith("confirm", `confirm:${String(roundId)}`, expect.any(Number));
    const [, , plannedAt] = scheduleAlarm.mock.calls[0] as unknown as [string, string, number];
    expect(Math.abs(plannedAt - (Date.now() + 30_000))).toBeLessThan(5_000);
    expect(roundId).toMatch(/^heist-[a-f0-9]{40}$/u);
    expect(operationId).toBe("msg:fictional-start-message");
    // The pause is only checked here; it starts when the round settles.
    expect([accountId, login, stake, cooldown]).toEqual([
      "viewer_anna", "frostfern", 100, { key: "between-rounds", seconds: 0 },
    ]);
    expect(data).toMatchObject({
      durationS: 60,
      lockKeys: ["heist:active"],
      settlement: { kind: "heist", params: { baseChance: 50, maxChance: 65 } },
      startMessageId: "fictional-start-message",
      confirmText: settings.confirmText,
      confirmTextEnabled: true,
      cooldownAfter: { key: "between-rounds", seconds: 30 },
    });
  });
});

describe("heist template variables", () => {
  it("declares for each message exactly the values it is rendered with, and previews use the same samples", async () => {
    const settings = heistSettingsForLanguage("en");
    const data = {
      language: "en" as const,
      joinWindowSeconds: 60,
      startMessageId: "fictional-start-message",
      startText: settings.startText,
      startTextEnabled: true,
      confirmText: settings.confirmText,
      confirmTextEnabled: true,
      resultText: settings.resultText,
      resultTextEnabled: true,
    };
    const rendered: Record<string, string[]> = {};
    const capture = (field: string) => ({
      renderTemplate: (text: string, values: Record<string, string | number> = {}) => {
        rendered[field] = Object.keys(values).sort((left, right) => left.localeCompare(right));
        return Promise.resolve({ text });
      },
    }) as unknown as ModuleAlarmContext;

    await heistModule.formatPointRoundAnnouncement?.(capture("startText"), { roundId: "fictional_heist_round", data, text: settings.startText });
    await heistModule.formatPointRoundResult?.(capture("resultText"), {
      roundId: "fictional_heist_round",
      data,
      result: { chancePercent: 50, participantCount: 1, winners: [], losers: [{ accountId: "viewer_anna", login: "frostfern", stake: 50 }] },
      resolvedAt: "2100-01-01T00:00:00.000Z",
    });
    const alarmContext = {
      ...capture("confirmText"),
      points: { rounds: {
        active: () => Promise.resolve({ roundId: "fictional_heist_round", state: "open", deadlineAt: Date.now() + 30_000, data }),
        participants: () => Promise.resolve({ count: 2, totalStake: 100, logins: ["frostfern", "moonmoss"] }),
      } },
      sendChat: () => Promise.resolve({ sent: true, reason: null, retryable: false, delivery: "delivered" }),
      schedule: () => Promise.resolve(),
    } as unknown as ModuleAlarmContext;
    await heistModule.alarms?.[0]?.handle(alarmContext, "confirm:fictional_heist_round", Date.now());

    for (const [field, variables] of Object.entries(HEIST_TEMPLATE_FIELDS)) {
      expect(rendered[field], field).toEqual(variables.map(({ name }) => name).sort((left, right) => left.localeCompare(right)));
    }
  });
});
