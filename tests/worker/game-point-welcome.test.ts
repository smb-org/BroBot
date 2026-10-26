import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { BotModule, ModuleAlarmContext } from "../../src/modules/contract";
import { duelSettingsForLanguage } from "../../src/modules/duel/contracts";
import { duelModule } from "../../src/modules/duel";
import { heistSettingsForLanguage } from "../../src/modules/heist/contracts";
import { heistModule } from "../../src/modules/heist";
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

const worker = env as unknown as Env;
const viewerId = "viewer_newcomer";
const viewerLogin = "frostfern";
const startBonus = 100;

const gameFor = (moduleId: "duel" | "heist"): { module: BotModule; settings: unknown; command: string } => moduleId === "duel"
  ? { module: duelModule, settings: duelSettingsForLanguage("de"), command: "!duell 10" }
  : { module: heistModule, settings: heistSettingsForLanguage("de"), command: "!heist 10" };

const activateGame = async (channelId: string, moduleId: "duel" | "heist", settings: unknown): Promise<void> => {
  await worker.DB.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'points', 1, ?, 1)",
  ).bind(channelId, JSON.stringify(pointsDefaultSettingsForLanguage("en"))).run();
  await worker.DB.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, ?, 1, ?, 1)",
  ).bind(channelId, moduleId, JSON.stringify(settings)).run();
  await worker.DB.prepare("UPDATE channels SET language = 'en' WHERE channel_id = ?").bind(channelId).run();
};

const dispatchGameMessage = async (
  channelId: string,
  moduleId: "duel" | "heist",
  messageId: string,
  command: string,
  accountId = viewerId,
  login = viewerLogin,
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
      message_id: messageId,
      message: { text: command, fragments: [{ type: "text", text: command }] },
      badges: [],
    },
    receivedAt: new Date().toISOString(),
    eventSubTimestamp: new Date().toISOString(),
  }, vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }))), [pointsModule, module]);
};

const dispatchGameCommand = async (channelId: string, moduleId: "duel" | "heist", messageId: string): Promise<PointsWorkerObject> => {
  const { settings, command } = gameFor(moduleId);
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
  acknowledge: ReturnType<typeof vi.fn<PointsWorkerObject["acknowledgePointWelcome"]>>;
}> => {
  const sendChat = vi.fn<ModuleAlarmContext["sendChat"]>(() => Promise.resolve({
    sent: outcome === "delivered",
    retryable: false,
    reason: outcome === "delivered" ? null : "transport_failed",
    delivery: outcome,
  }));
  const acknowledge = vi.fn<PointsWorkerObject["acknowledgePointWelcome"]>();
  await runPointObject(object, (target) => {
    const runtime = target as unknown as PointsWorkerObject & {
      moduleAlarmContext: (...args: unknown[]) => ModuleAlarmContext;
    };
    const original = runtime.moduleAlarmContext.bind(runtime);
    vi.spyOn(runtime, "moduleAlarmContext").mockImplementation((...args) => ({ ...original(...args), sendChat }));
    const originalAcknowledge = runtime.acknowledgePointWelcome.bind(runtime);
    acknowledge.mockImplementation((...args) => originalAcknowledge(...args));
    vi.spyOn(runtime, "acknowledgePointWelcome").mockImplementation(acknowledge);
  });
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
});
