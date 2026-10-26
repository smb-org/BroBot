import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModuleAlarmContext, ModuleEvent, ModuleExecutionContext, PointActiveRound, PointRoundParticipants } from "../../src/modules/contract";
import { heistConfirmAlarm } from "../../src/modules/heist/alarm";
import { heistSettingsForLanguage } from "../../src/modules/heist/contracts";
import { processHeistMessage } from "../../src/modules/heist/service";

const now = Date.UTC(2100, 0, 1);
const roundId = "heist-fictional";
const alarmKey = `confirm:${roundId}`;

type SendChat = ModuleAlarmContext["sendChat"];

const roundData = (language: "en" | "de", overrides: Record<string, unknown> = {}) => {
  const settings = heistSettingsForLanguage(language);
  return {
    language,
    joinWindowSeconds: 60,
    startMessageId: "fictional-start-message",
    startText: settings.startText,
    startTextEnabled: true,
    confirmText: settings.confirmText,
    confirmTextEnabled: true,
    resultText: settings.resultText,
    resultTextEnabled: true,
    ...overrides,
  };
};

const harness = (options: {
  round?: Partial<PointActiveRound> | null;
  data?: unknown;
  joined?: PointRoundParticipants;
  send?: SendChat;
}) => {
  let round: PointActiveRound | null = options.round === null ? null : {
    roundId, state: "open", deadlineAt: now + 30_000, data: options.data ?? roundData("en"), ...options.round,
  };
  const sendChat = vi.fn<SendChat>(options.send ?? (() => Promise.resolve({ sent: true, reason: null, retryable: false, delivery: "delivered" })));
  const schedule = vi.fn(() => Promise.resolve());
  const participants = vi.fn(() => Promise.resolve(options.joined ?? { count: 3, totalStake: 225, logins: ["frostfern", "moonmoss", "starling"] }));
  const context = {
    points: { rounds: { active: () => Promise.resolve(round), participants } },
    renderTemplate: (text: string, values: Record<string, string | number> = {}) => Promise.resolve({
      text: text.replace(/\{([a-zA-Z0-9_.]+)\}/gu, (token, name: string) => values[name] === undefined ? token : String(values[name])),
    }),
    sendChat,
    schedule,
  } as unknown as ModuleAlarmContext;
  return {
    context, sendChat, schedule, participants,
    setRound: (next: PointActiveRound | null) => { round = next; },
    run: () => heistConfirmAlarm.handle(context, alarmKey, now),
  };
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
});

describe("heist batched join line", () => {
  it("lists everyone who is in and the pot as one thread reply at the middle of the window", async () => {
    const { sendChat, run, participants } = harness({});

    await run();

    expect(participants).toHaveBeenCalledWith(roundId, 5);
    expect(sendChat).toHaveBeenCalledOnce();
    expect(sendChat).toHaveBeenCalledWith(
      "3 in: frostfern, moonmoss, starling · pot 225",
      `round:${roundId}:confirm`,
      undefined,
      expect.any(Function),
      undefined,
      { replyToMessageId: "fictional-start-message", automated: false },
    );
  });

  it("uses the German wording from the round language", async () => {
    const { sendChat, run } = harness({ data: roundData("de") });

    await run();

    expect(sendChat.mock.calls[0]?.[0]).toBe("3 dabei: frostfern, moonmoss, starling · Pott 225");
  });

  it("truncates a long list after five names and counts the rest", async () => {
    const { sendChat, run } = harness({
      joined: { count: 8, totalStake: 640, logins: ["ann", "ben", "cara", "dev", "eli"] },
    });

    await run();

    expect(sendChat.mock.calls[0]?.[0]).toBe("8 in: ann, ben, cara, dev, eli, +3 more · pot 640");
  });

  it("is skipped while nobody but the starter has joined", async () => {
    const { sendChat, run } = harness({ joined: { count: 1, totalStake: 100, logins: ["frostfern"] } });

    await run();

    expect(sendChat).not.toHaveBeenCalled();
  });

  it("sends nothing when its message switch is off or the round predates the line", async () => {
    const off = harness({ data: roundData("en", { confirmTextEnabled: false }) });
    const legacyData: Record<string, unknown> = roundData("en");
    delete legacyData.confirmText;
    delete legacyData.confirmTextEnabled;
    const legacy = harness({ data: legacyData });

    await off.run();
    await legacy.run();

    expect(off.sendChat).not.toHaveBeenCalled();
    expect(legacy.sendChat).not.toHaveBeenCalled();
  });

  it("sends nothing for a round that has ended or belongs to someone else", async () => {
    const ended = harness({ round: null });
    const other = harness({ round: { roundId: "heist-other" } });
    const late = harness({ round: { deadlineAt: now - 1 } });

    await ended.run();
    await other.run();
    await late.run();

    expect(ended.sendChat).not.toHaveBeenCalled();
    expect(other.sendChat).not.toHaveBeenCalled();
    expect(late.sendChat).not.toHaveBeenCalled();
  });

  it("re-plans itself to the real middle of the window instead of sending early", async () => {
    const early = harness({ round: { deadlineAt: now + 50_000 } });
    const announcing = harness({ round: { state: "announcing", deadlineAt: null } });

    await early.run();
    await announcing.run();

    expect(early.sendChat).not.toHaveBeenCalled();
    expect(early.schedule).toHaveBeenCalledWith(alarmKey, now + 20_000);
    expect(announcing.sendChat).not.toHaveBeenCalled();
    expect(announcing.schedule).toHaveBeenCalledWith(alarmKey, now + 5_000);
  });

  it("claims one send per round and lets the host retry a retryable failure", async () => {
    const { run, sendChat } = harness({
      send: () => Promise.resolve({ sent: false, reason: "rate_limited", retryable: true, delivery: "rate_limited" }),
    });

    await expect(run()).rejects.toThrow("heist_confirm_retry");
    await expect(run()).rejects.toThrow("heist_confirm_retry");

    expect(sendChat.mock.calls.map((call) => call[1])).toEqual([`round:${roundId}:confirm`, `round:${roundId}:confirm`]);
  });

  it("does not retry an attempt that was already claimed", async () => {
    const { run } = harness({
      send: () => Promise.resolve({ sent: false, reason: "already_attempted", retryable: false, delivery: "ambiguous" }),
    });

    await expect(run()).resolves.toBeUndefined();
  });

  it("withdraws the line if the round ends before the send goes out", async () => {
    const { run, sendChat, setRound } = harness({});

    await run();
    const stillValid = sendChat.mock.calls[0]?.[3];
    const whileOpen = await stillValid?.();
    setRound(null);
    const afterEnd = await stillValid?.();

    expect([whileOpen, afterEnd]).toEqual([true, false]);
  });
});

describe("heist start without the midway line", () => {
  it("does not schedule an alarm when the join list message is switched off", async () => {
    const settings = { ...heistSettingsForLanguage("en"), confirmTextEnabled: false };
    const scheduleAlarm = vi.fn(() => Promise.resolve());
    const openWithStake = vi.fn<ModuleExecutionContext["points"]["rounds"]["openWithStake"]>(() => Promise.resolve({ roundId, replayed: false }));
    const event: ModuleEvent<typeof settings> = {
      channelId: "fictional_channel",
      subscriptionType: "channel.chat.message",
      triggerId: "fictional-heist-start",
      payload: { message: { text: "!heist 100" }, message_id: "fictional-start-message", chatter_user_id: "viewer_anna", chatter_user_login: "frostfern" },
      settings,
      receivedAt: "2100-01-01T00:00:00.000Z",
      eventSubTimestamp: "2100-01-01T00:00:00.000Z",
      actor: null,
      chatStatus: ["viewer"],
    };

    await processHeistMessage(event, {
      points: { rounds: { active: () => Promise.resolve(null), openWithStake } },
      scheduleAlarm,
      channelLanguage: () => Promise.resolve("en"),
    } as unknown as ModuleExecutionContext);

    expect(openWithStake).toHaveBeenCalledOnce();
    expect(openWithStake.mock.calls[0]?.[1]).toMatchObject({ confirmTextEnabled: false });
    expect(scheduleAlarm).not.toHaveBeenCalled();
  });
});
