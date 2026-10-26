import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { BotModule, ModuleAlarmContext } from "../../src/modules/contract";
import { duelSettingsForLanguage } from "../../src/modules/duel/contracts";
import { duelModule } from "../../src/modules/duel";
import { heistSettingsForLanguage } from "../../src/modules/heist/contracts";
import { heistModule } from "../../src/modules/heist";
import { heistConfirmAlarm, heistConfirmAlarmKey } from "../../src/modules/heist/alarm";
import { pointsDefaultSettingsForLanguage } from "../../src/modules/points/contracts";
import { pointsModule } from "../../src/modules/points";
import { pointsCatalog } from "../../src/modules/points/locale";
import { dispatchEventSubNotification } from "../../src/worker/dispatch";
import {
  clearPointObjectAlarms,
  forcePointAlarm,
  insertPointChannel,
  pointObject,
  runMigrations,
  runPointObject,
  type PointsWorkerObject,
} from "./points-test-helpers";

const mocks = vi.hoisted(() => ({
  getAppAccessToken: vi.fn(),
  getBotIdentity: vi.fn(),
  getCachedBotUserId: vi.fn(),
}));

vi.mock("../../src/worker/app-token", async (importOriginal) => {
  const original: Record<string, unknown> = await importOriginal();
  return { ...original, getAppAccessToken: mocks.getAppAccessToken };
});
vi.mock("../../src/worker/db/bot-identity", async (importOriginal) => {
  const original: Record<string, unknown> = await importOriginal();
  return {
    ...original,
    getBotIdentity: mocks.getBotIdentity,
    getCachedBotUserId: mocks.getCachedBotUserId,
  };
});

const worker = env as unknown as Env;
const viewerId = "viewer_newcomer";
const viewerLogin = "frostfern";
const startBonus = 100;

const gameFor = (moduleId: "duel" | "heist", settings?: unknown): { module: BotModule; settings: unknown; command: string } => moduleId === "duel"
  ? { module: duelModule, settings: settings ?? duelSettingsForLanguage("de"), command: "!duell 10" }
  : { module: heistModule, settings: settings ?? heistSettingsForLanguage("de"), command: "!heist 10" };

const activateGames = async (channelId: string, games: readonly { moduleId: "duel" | "heist"; settings: unknown }[]): Promise<void> => {
  await worker.DB.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'points', 1, ?, 1)",
  ).bind(channelId, JSON.stringify(pointsDefaultSettingsForLanguage("en"))).run();
  for (const { moduleId, settings } of games) {
    await worker.DB.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, ?, 1, ?, 1)",
    ).bind(channelId, moduleId, JSON.stringify(settings)).run();
  }
  await worker.DB.prepare("UPDATE channels SET language = 'en' WHERE channel_id = ?").bind(channelId).run();
};

const activateGame = async (channelId: string, moduleId: "duel" | "heist", settings: unknown): Promise<void> =>
  activateGames(channelId, [{ moduleId, settings }]);

const chatFetch = (messages: string[]): typeof fetch => vi.fn<typeof fetch>((input, init) => {
  const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
  if (url.includes("/helix/chat/messages")) {
    const requestBody = init?.body;
    const body: unknown = typeof requestBody === "string" ? JSON.parse(requestBody) : null;
    if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string") {
      messages.push(body.message);
    }
    return Promise.resolve(new Response(JSON.stringify({ data: [{ is_sent: true }] }), { status: 200 }));
  }
  return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
});

const dispatchGameMessage = async (
  channelId: string,
  moduleId: "duel" | "heist",
  messageId: string,
  command: string,
  accountId = viewerId,
  login = viewerLogin,
  fetcher: typeof fetch = vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }))),
  payloadMessageId = messageId,
): Promise<void> => {
  const { module } = gameFor(moduleId);
  await dispatchEventSubNotification(worker, {
    channelId,
    subscriptionType: "channel.chat.message",
    triggerId: messageId,
    payload: {
      broadcaster_user_id: channelId,
      broadcaster_user_login: channelId,
      chatter_user_id: accountId,
      chatter_user_login: login,
      message_id: payloadMessageId,
      message: { text: command, fragments: [{ type: "text", text: command }] },
      badges: [],
    },
    receivedAt: new Date().toISOString(),
    eventSubTimestamp: new Date().toISOString(),
  }, fetcher, [pointsModule, module]);
};

const dispatchGameCommand = async (channelId: string, moduleId: "duel" | "heist", messageId: string, settingsOverride?: unknown): Promise<PointsWorkerObject> => {
  const { settings, command } = gameFor(moduleId, settingsOverride);
  await insertPointChannel(channelId);
  await activateGame(channelId, moduleId, settings);
  const object = pointObject(channelId);
  await dispatchGameMessage(channelId, moduleId, messageId, command);
  return object;
};

const prepareDelivery = async (
  object: PointsWorkerObject,
  outcome: "delivered" | "failed",
): Promise<{
  sendChat: ReturnType<typeof vi.fn<ModuleAlarmContext["sendChat"]>>;
  acknowledge: MockInstance<PointsWorkerObject["acknowledgePointWelcome"]>;
}> => {
  const sendChat = vi.fn<ModuleAlarmContext["sendChat"]>(() => Promise.resolve({
    sent: outcome === "delivered",
    retryable: false,
    reason: outcome === "delivered" ? null : "transport_failed",
    delivery: outcome,
  }));
  let acknowledge: MockInstance<PointsWorkerObject["acknowledgePointWelcome"]> | undefined;
  await runPointObject(object, (target) => {
    const runtime = target as unknown as PointsWorkerObject & {
      moduleAlarmContext: (...args: unknown[]) => ModuleAlarmContext;
    };
    const prototype = Object.getPrototypeOf(runtime) as typeof runtime;
    const original = prototype.moduleAlarmContext;
    vi.spyOn(prototype, "moduleAlarmContext").mockImplementation(function (this: typeof runtime, ...args) {
      return { ...Reflect.apply(original, this, args), sendChat };
    });
    // Spy on the prototype: Workers RPC only dispatches prototype methods, and the spy calls through.
    acknowledge = vi.spyOn(prototype, "acknowledgePointWelcome");
  });
  if (acknowledge === undefined) throw new Error("acknowledge_spy_missing");
  return { sendChat, acknowledge };
};

const openedRoundId = async (object: PointsWorkerObject, moduleId: "duel" | "heist"): Promise<string> => {
  const rounds = await object.listOpenGameRounds(moduleId);
  const round = rounds[0];
  if (round === undefined) throw new Error("game_round_missing");
  return round.roundId;
};

beforeAll(runMigrations);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2100, 0, 1));
});
afterEach(async () => {
  try {
    await clearPointObjectAlarms();
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

describe("delayed game welcome replies", () => {
  it.each(["duel", "heist"] as const)("appends and acknowledges the welcome on the real %s command announcement", async (moduleId) => {
    const channelId = `game-welcome-${moduleId}-${crypto.randomUUID()}`;
    const messageId = `welcome-${moduleId}-message`;
    const object = await dispatchGameCommand(channelId, moduleId, messageId);
    const { sendChat, acknowledge } = await prepareDelivery(object, "delivered");
    const roundId = await openedRoundId(object, moduleId);

    await forcePointAlarm(object, roundId);

    const welcome = pointsCatalog.en.chat.startBonus(startBonus, "Points");
    expect(sendChat).toHaveBeenCalledOnce();
    expect(sendChat.mock.calls[0]?.[0].split(welcome)).toHaveLength(2);
    expect(sendChat.mock.calls[0]?.[5]).toMatchObject({ replyToMessageId: messageId });
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(await object.touchPointAccount("points", viewerId, viewerLogin, startBonus)).toMatchObject({ welcomePending: false });
    if (moduleId === "heist") {
      await forcePointAlarm(object, roundId, (_target, state) => {
        state.storage.sql.exec("UPDATE game_rounds SET deadline_at = ? WHERE round_id = ?", Date.now() - 1, roundId);
      });
      expect(sendChat).toHaveBeenCalledTimes(2);
      expect(sendChat.mock.calls[1]?.[0]).not.toContain(welcome);
      expect(acknowledge).toHaveBeenCalledOnce();
    }
  });

  it("appends a newly welcomed duelist's note to the delayed accept result", async () => {
    const channelId = `game-welcome-duel-result-${crypto.randomUUID()}`;
    const object = await dispatchGameCommand(channelId, "duel", "duel-challenge-message");
    const { sendChat, acknowledge } = await prepareDelivery(object, "delivered");
    const roundId = await openedRoundId(object, "duel");
    await forcePointAlarm(object, roundId);
    sendChat.mockClear();
    acknowledge.mockClear();

    await dispatchGameMessage(channelId, "duel", "duel-accept-message", "!ja", "viewer_acceptor", "moonmoss");
    await forcePointAlarm(object, roundId);

    const welcome = pointsCatalog.en.chat.startBonus(startBonus, "Points");
    expect(sendChat).toHaveBeenCalledOnce();
    expect(sendChat.mock.calls[0]?.[0].split(welcome)).toHaveLength(2);
    expect(sendChat.mock.calls[0]?.[5]).toMatchObject({ replyToMessageId: "duel-accept-message" });
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(await object.touchPointAccount("points", "viewer_acceptor", "moonmoss", startBonus)).toMatchObject({ welcomePending: false });
  });

  it("leaves the welcome pending when a real duel announcement send fails", async () => {
    const channelId = `game-welcome-failed-${crypto.randomUUID()}`;
    const object = await dispatchGameCommand(channelId, "duel", "welcome-failed-message");
    const { sendChat, acknowledge } = await prepareDelivery(object, "failed");

    await forcePointAlarm(object, await openedRoundId(object, "duel"));

    expect(sendChat).toHaveBeenCalledOnce();
    expect(sendChat.mock.calls[0]?.[0]).toContain(pointsCatalog.en.chat.startBonus(startBonus, "Points"));
    expect(acknowledge).not.toHaveBeenCalled();
    expect(await object.touchPointAccount("points", viewerId, viewerLogin, startBonus)).toMatchObject({ welcomePending: true });
  });

  it("takes over an abandoned welcome claim on the next game reply", async () => {
    const channelId = `game-welcome-expired-claim-${crypto.randomUUID()}`;
    const object = await dispatchGameCommand(channelId, "duel", "welcome-expired-claim-message");
    const roundId = await openedRoundId(object, "duel");
    expect(await object.claimPointWelcome("points", viewerId, "dispatch:abandoned:points:0")).toBe(true);
    await runPointObject(object, (_target, state) => {
      state.storage.sql.exec(
        "UPDATE point_welcome_notes SET claimed_at = ? WHERE account_id = ?",
        Date.now() - 120_001,
        viewerId,
      );
    });
    const { sendChat, acknowledge } = await prepareDelivery(object, "delivered");

    await forcePointAlarm(object, roundId);

    const welcome = pointsCatalog.en.chat.startBonus(startBonus, "Points");
    expect(sendChat.mock.calls[0]?.[0]).toContain(welcome);
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(await object.touchPointAccount("points", viewerId, viewerLogin, startBonus)).toMatchObject({ welcomePending: false });
  });

  it("keeps the welcome pending when recovery confirms a game send that omitted it", async () => {
    const channelId = `game-welcome-recovery-without-note-${crypto.randomUUID()}`;
    const object = await dispatchGameCommand(channelId, "duel", "welcome-recovery-message");
    const roundId = await openedRoundId(object, "duel");
    mocks.getBotIdentity.mockResolvedValue({
      id: 1,
      userId: "fictional_brobot",
      login: "brobot",
      scopesJson: "[]",
      accessTokenCiphertext: "unused",
      refreshTokenCiphertext: "unused",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    mocks.getAppAccessToken.mockResolvedValue("fictional-app-token");
    mocks.getCachedBotUserId.mockResolvedValue(null);
    let releaseChatRequest!: (response: Response) => void;
    let markChatRequestStarted!: () => void;
    const chatRequestStarted = new Promise<void>((resolve) => { markChatRequestStarted = resolve; });
    const fetcher = vi.fn<typeof fetch>((input) => {
      const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
      if (url.includes("/helix/chat/messages")) {
        markChatRequestStarted();
        return new Promise<Response>((resolve) => { releaseChatRequest = resolve; });
      }
      return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
    });
    const dispatch = dispatchGameMessage(
      channelId,
      "duel",
      "dispatch-held-message",
      "!punkte",
      viewerId,
      viewerLogin,
      fetcher,
      "welcome-recovery-message",
    );
    await chatRequestStarted;
    const { sendChat, acknowledge } = await prepareDelivery(object, "delivered");
    let persistSendReceipt = (): void => undefined;
    sendChat.mockImplementation(() => {
      persistSendReceipt();
      return Promise.resolve({
        sent: true,
        retryable: false,
        reason: null,
        delivery: "delivered",
      });
    });
    await runPointObject(object, (target) => {
      const prototype = Object.getPrototypeOf(target) as unknown as {
        recordPointRoundAnnouncement: (...args: unknown[]) => Promise<void>;
      };
      vi.spyOn(prototype, "recordPointRoundAnnouncement").mockRejectedValueOnce(new Error("simulated_crash_after_send"));
    });

    await expect(forcePointAlarm(object, roundId, (_target, state) => {
      persistSendReceipt = () => {
        state.storage.kv.put("module_alarm:send_claims", {
          [`round:${roundId}:announce`]: { status: "sent", at: Date.now() },
        });
      };
    })).resolves.toBe(true);
    await forcePointAlarm(object, roundId);

    expect(sendChat).toHaveBeenCalledOnce();
    expect(sendChat.mock.calls[0]?.[0]).not.toContain(pointsCatalog.en.chat.startBonus(startBonus, "Points"));
    expect(acknowledge).not.toHaveBeenCalled();
    expect(await object.touchPointAccount("points", viewerId, viewerLogin, startBonus)).toMatchObject({ welcomePending: true });
    releaseChatRequest(new Response(JSON.stringify({ data: [{ is_sent: false }] }), { status: 500 }));
    await dispatch;
    expect(await object.touchPointAccount("points", viewerId, viewerLogin, startBonus)).toMatchObject({ welcomePending: true });
  });

  it("does not repeat a welcome in a delayed heist result after !punkte delivered it", async () => {
    const channelId = `game-welcome-heist-after-points-${crypto.randomUUID()}`;
    const settings = { ...heistSettingsForLanguage("de"), startTextEnabled: false, confirmTextEnabled: false };
    const dispatchMessages: string[] = [];
    const fetcher = chatFetch(dispatchMessages);
    mocks.getBotIdentity.mockResolvedValue({
      id: 1,
      userId: "fictional_brobot",
      login: "brobot",
      scopesJson: "[]",
      accessTokenCiphertext: "unused",
      refreshTokenCiphertext: "unused",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    mocks.getAppAccessToken.mockResolvedValue("fictional-app-token");
    mocks.getCachedBotUserId.mockResolvedValue(null);
    const object = await dispatchGameCommand(channelId, "heist", "heist-start-message", settings);
    const { sendChat, acknowledge } = await prepareDelivery(object, "delivered");
    const roundId = await openedRoundId(object, "heist");

    await forcePointAlarm(object, roundId);
    await dispatchGameMessage(channelId, "heist", "points-message", "!punkte", viewerId, viewerLogin, fetcher);
    await forcePointAlarm(object, roundId, (_target, state) => {
      state.storage.sql.exec("UPDATE game_rounds SET deadline_at = ? WHERE round_id = ?", Date.now() - 1, roundId);
    });

    const welcome = pointsCatalog.en.chat.startBonus(startBonus, "Points");
    expect(dispatchMessages.filter((message) => message.includes(welcome))).toHaveLength(1);
    expect(sendChat).toHaveBeenCalledOnce();
    expect(sendChat.mock.calls[0]?.[0]).not.toContain(welcome);
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(await object.touchPointAccount("points", viewerId, viewerLogin, startBonus)).toMatchObject({ welcomePending: false });
  });

  it("delivers a welcome only once across overlapping duel and heist announcements", async () => {
    const channelId = `game-welcome-overlap-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    await activateGames(channelId, [
      { moduleId: "duel", settings: duelSettingsForLanguage("de") },
      { moduleId: "heist", settings: heistSettingsForLanguage("de") },
    ]);
    const object = pointObject(channelId);
    await dispatchGameMessage(channelId, "duel", "overlap-duel-message", "!duell 10");
    await dispatchGameMessage(channelId, "heist", "overlap-heist-message", "!heist 10");
    const { sendChat, acknowledge } = await prepareDelivery(object, "delivered");

    await forcePointAlarm(object, await openedRoundId(object, "duel"));
    await forcePointAlarm(object, await openedRoundId(object, "heist"));

    const welcome = pointsCatalog.en.chat.startBonus(startBonus, "Points");
    expect(sendChat.mock.calls.filter((call) => call[0].includes(welcome))).toHaveLength(1);
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(await object.touchPointAccount("points", viewerId, viewerLogin, startBonus)).toMatchObject({ welcomePending: false });
  });

  it("delivers and acknowledges a welcome on a heist confirmation when it is the only enabled message", async () => {
    const channelId = `game-welcome-heist-confirm-${crypto.randomUUID()}`;
    const settings = { ...heistSettingsForLanguage("de"), startTextEnabled: false, resultTextEnabled: false };
    const object = await dispatchGameCommand(channelId, "heist", "confirm-start-message", settings);
    const { sendChat, acknowledge } = await prepareDelivery(object, "delivered");
    const roundId = await openedRoundId(object, "heist");
    await forcePointAlarm(object, roundId);
    await dispatchGameMessage(channelId, "heist", "confirm-join-message", "!heist 10", "viewer_joiner", "moonmoss");
    await runPointObject(object, async (target, state) => {
      state.storage.sql.exec("UPDATE game_rounds SET deadline_at = ? WHERE round_id = ?", Date.now() + 20_000, roundId);
      const runtime = target as unknown as PointsWorkerObject & {
        moduleAlarmContext: (...args: unknown[]) => ModuleAlarmContext;
      };
      const context = runtime.moduleAlarmContext("heist", heistConfirmAlarm, {});
      await heistConfirmAlarm.handle(context, heistConfirmAlarmKey(roundId), Date.now());
    });

    const welcome = pointsCatalog.en.chat.startBonus(startBonus, "Points");
    expect(sendChat).toHaveBeenCalledOnce();
    expect(sendChat.mock.calls[0]?.[0].split(welcome)).toHaveLength(2);
    expect(sendChat.mock.calls[0]?.[5]).toMatchObject({ replyToMessageId: "confirm-start-message" });
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(await object.touchPointAccount("points", viewerId, viewerLogin, startBonus)).toMatchObject({ welcomePending: false });
  });
});
