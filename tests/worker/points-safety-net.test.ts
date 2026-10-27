import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { duelModule } from "../../src/modules/duel";
import { duelSettingsForLanguage } from "../../src/modules/duel/contracts";
import { pointsDefaultSettingsForLanguage } from "../../src/modules/points/contracts";
import { pointsModule } from "../../src/modules/points";
import { pointsCatalog } from "../../src/modules/points/locale";
import { dispatchEventSubNotification } from "../../src/worker/dispatch";
import { ChannelObject } from "../../src/worker/durable/ChannelObject";
import {
  clearPointObjectAlarms,
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
  return { ...original, getBotIdentity: mocks.getBotIdentity, getCachedBotUserId: mocks.getCachedBotUserId };
});

const worker = env as unknown as Env;
const accountId = "viewer_safety";
const login = "frostfern";
const pointsSettings = (overrides: Record<string, unknown> = {}) => ({
  ...pointsDefaultSettingsForLanguage("en"),
  startBonus: 0,
  activityAmount: 0,
  safetyNetEnabled: true,
  safetyNetAmount: 50,
  safetyNetThreshold: 20,
  ...overrides,
});

const makeChatFetch = (messages: string[], onlineStreams = false): typeof fetch => vi.fn<typeof fetch>((input, init) => {
  const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
  if (url.includes("/helix/chat/messages")) {
    const requestBody = init?.body;
    const body: unknown = typeof requestBody === "string" ? JSON.parse(requestBody) : null;
    if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string") messages.push(body.message);
    return Promise.resolve(new Response(JSON.stringify({ data: [{ is_sent: true }] }), { status: 200 }));
  }
  if (onlineStreams && url.includes("/helix/streams")) {
    return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "safety-net-stream", started_at: "2026-10-27T10:00:00.000Z" }] }), { status: 200 }));
  }
  return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
});

const configureChatAuth = (): void => {
  mocks.getBotIdentity.mockReset().mockResolvedValue({
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
  mocks.getAppAccessToken.mockReset().mockResolvedValue("fictional-app-token");
  mocks.getCachedBotUserId.mockReset().mockResolvedValue(null);
};

const createChannel = async (
  channelId: string,
  settings = pointsSettings(),
  options: { online?: boolean; duel?: boolean } = {},
): Promise<void> => {
  await insertPointChannel(channelId);
  await worker.DB.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'points', 1, ?, 1)",
  ).bind(channelId, JSON.stringify(settings)).run();
  if (options.duel === true) {
    await worker.DB.prepare(
      "INSERT INTO channel_modules (channel_id, module_id, enabled, settings, revision) VALUES (?, 'duel', 1, ?, 1)",
    ).bind(channelId, JSON.stringify(duelSettingsForLanguage("en"))).run();
  }
  await worker.DB.prepare("UPDATE channels SET language = 'en' WHERE channel_id = ?").bind(channelId).run();
  if (options.online === true) {
    await worker.DB.prepare(
      "INSERT INTO channel_stream_state (channel_id, state, changed_at, source) VALUES (?, 'online', ?, 'eventsub')",
    ).bind(channelId, "2026-10-27T10:00:00.000Z").run();
  }
};

const seedAccount = async (object: PointsWorkerObject, balance: number): Promise<void> => {
  await object.touchPointAccount("points", accountId, login, balance);
  await object.storePendingPointWelcome("points", {
    accountId,
    operationId: `bonus:${accountId}`,
    messageId: "seed-message",
    text: pointsCatalog.en.chat.startBonus(balance, "Points"),
    kind: "start_bonus",
  });
  const claimId = "seed:welcome";
  if (await object.claimPointWelcome("points", accountId, `bonus:${accountId}`, claimId) === null) {
    throw new Error("seed_welcome_claim_failed");
  }
  await object.acknowledgePointWelcome("points", accountId, `bonus:${accountId}`, claimId);
}

const dispatchChat = async (
  channelId: string,
  messageId: string,
  text: string,
  fetcher: typeof fetch,
  registry: readonly [typeof pointsModule, ...typeof duelModule[]] | readonly [typeof pointsModule] = [pointsModule],
  timestamp = "2026-10-27T10:05:00.000Z",
): Promise<void> => {
  vi.setSystemTime(new Date(timestamp));
  return dispatchEventSubNotification(worker, {
    channelId,
    subscriptionType: "channel.chat.message",
    triggerId: messageId,
    payload: {
      broadcaster_user_id: channelId,
      broadcaster_user_login: channelId,
      chatter_user_id: accountId,
      chatter_user_login: login,
      message_id: messageId,
      message: { text, fragments: [{ type: "text", text }] },
      badges: [],
    },
    receivedAt: timestamp,
    eventSubTimestamp: timestamp,
  }, fetcher, registry);
};

beforeAll(runMigrations);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-27T10:05:00.000Z"));
  configureChatAuth();
});
afterEach(async () => {
  await clearPointObjectAlarms();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("points safety net", () => {
  it("credits a broke account once per UTC day and delivers its note on the next points reply (protects=live broke viewers receive one zero-sum house credit and one pending note; fails_when=the credit repeats, misses the next points reply, or appears in a later reply; no_claim=the chat transport reports successful delivery)", async () => {
    const channelId = `points-safety-net-delivery-${crypto.randomUUID()}`;
    await createChannel(channelId, pointsSettings({ safetyNetAmount: 5 }), { online: true });
    const object = pointObject(channelId);
    await seedAccount(object, 0);
    const messages: string[] = [];
    const fetcher = makeChatFetch(messages, true);

    await dispatchChat(channelId, "safety-net-trigger", "hello", fetcher);
    await expect(object.pointBalance("points", accountId)).resolves.toBe(5);
    await dispatchChat(channelId, "safety-net-reply", "!punkte", fetcher);
    await dispatchChat(channelId, "safety-net-later", "!punkte", fetcher);

    const note = pointsCatalog.en.chat.safetyNet(5, "Points");
    expect(messages[0]).toContain(note);
    expect(messages.filter((message) => message.includes(note))).toHaveLength(1);
    await expect(object.pointBalance("points", accountId)).resolves.toBe(5);
    const history = await object.pointHistory("points", accountId);
    expect(history.rows.filter((row) => row.kind === "safety_net")).toMatchObject([
      { operationId: `safety-net:${accountId}:2026-10-27`, delta: 5 },
    ]);
    const balanceSum = await runPointObject(object, (_target, state) => state.storage.sql.exec<{ sum: number }>(
      "SELECT COALESCE(SUM(balance), 0) AS sum FROM point_accounts",
    ).one());
    expect(balanceSum.sum).toBe(0);
    await expect(object.pointSummary("points")).resolves.toMatchObject({ circulation: 5 });

    await dispatchChat(channelId, "safety-net-next-day", "hello", fetcher, [pointsModule], "2026-10-28T00:05:00.000Z");
    await expect(object.pointBalance("points", accountId)).resolves.toBe(10);
    await dispatchChat(channelId, "safety-net-next-day-reply", "!punkte", fetcher, [pointsModule], "2026-10-28T00:06:00.000Z");
    expect(messages.filter((message) => message.includes(note))).toHaveLength(2);
    const nextDayHistory = await object.pointHistory("points", accountId);
    expect(nextDayHistory.rows.filter((row) => row.kind === "safety_net").map((row) => row.operationId)).toEqual([
      `safety-net:${accountId}:2026-10-28`,
      `safety-net:${accountId}:2026-10-27`,
    ]);
    const operationSums = await runPointObject(object, (_target, state) => state.storage.sql.exec<{ operation_id: string; sum: number }>(
      `SELECT operation.operation_id, SUM(ledger.delta) AS sum
         FROM point_operations AS operation
         JOIN point_ledger AS ledger USING (operation_id)
        WHERE operation.kind = 'safety_net'
        GROUP BY operation.operation_id
        ORDER BY operation.operation_id`,
    ).toArray());
    expect(operationSums).toEqual([
      { operation_id: `safety-net:${accountId}:2026-10-27`, sum: 0 },
      { operation_id: `safety-net:${accountId}:2026-10-28`, sum: 0 },
    ]);
  });

  it.each([
    { name: "above threshold", balance: 21, settings: pointsSettings(), online: true },
    { name: "offline", balance: 0, settings: pointsSettings(), online: false },
    { name: "disabled", balance: 0, settings: pointsSettings({ safetyNetEnabled: false }), online: true },
    { name: "without an enabled game", balance: 0, settings: pointsSettings({ safetyNetThreshold: "min_stake" }), online: true },
  ])("does not credit when $name (protects=the safety net requires an online existing broke viewer and an enabled setting with a threshold; fails_when=an ineligible chat changes the balance; no_claim=no game reply is needed)", async ({ name, balance, settings, online }) => {
    const channelId = `points-safety-net-ineligible-${name.replaceAll(" ", "-")}-${crypto.randomUUID()}`;
    await createChannel(channelId, settings, { online });
    const object = pointObject(channelId);
    await seedAccount(object, balance);

    await dispatchChat(channelId, `safety-net-${name}`, "!punkte", makeChatFetch([]));

    await expect(object.pointBalance("points", accountId)).resolves.toBe(balance);
    const history = await object.pointHistory("points", accountId);
    expect(history.rows.some((row) => row.kind === "safety_net")).toBe(false);
  });

  it("uses the smallest stake among enabled games for the default threshold (protects=the default min-stake mode is resolved from enabled game settings; fails_when=the safety net ignores an enabled game's minimum stake; no_claim=the duel setting is a valid minimum-stake fixture)", async () => {
    const channelId = `points-safety-net-min-stake-${crypto.randomUUID()}`;
    await createChannel(channelId, pointsSettings({ safetyNetThreshold: "min_stake" }), { online: true, duel: true });
    const object = pointObject(channelId);
    await seedAccount(object, 9);

    await dispatchChat(channelId, "safety-net-min-stake", "!punkte", makeChatFetch([]), [pointsModule, duelModule]);

    const history = await object.pointHistory("points", accountId);
    expect(history.rows.filter((row) => row.kind === "safety_net")).toMatchObject([
      { operationId: `safety-net:${accountId}:2026-10-27`, delta: 50 },
    ]);
  });

  it("lets the pending start bonus win on a new account even when its balance is below the safety threshold (protects=a zero start bonus does not make a new account eligible for the safety net; fails_when=the first-contact message also books a safety-net operation; no_claim=the real first-contact preflight and points reply run together)", async () => {
    const channelId = `points-safety-net-start-wins-${crypto.randomUUID()}`;
    await createChannel(channelId, pointsSettings({ safetyNetThreshold: 1 }), { online: true });
    const object = pointObject(channelId);

    await dispatchChat(channelId, "safety-net-new-account", "!punkte", makeChatFetch([]));

    const history = await object.pointHistory("points", accountId);
    expect(history.rows.some((row) => row.kind === "safety_net")).toBe(false);
  });

  it("does not let a stale start-bonus preflight replace a later safety-net note (protects=a delivered start bonus cannot be recreated over the next operation's pending note; fails_when=the stale write repeats the welcome or hides the safety notification; no_claim=the real dispatch path delivers each note once)", async () => {
    const channelId = `points-safety-net-stale-${crypto.randomUUID()}`;
    await createChannel(channelId, pointsSettings({ safetyNetAmount: 5, safetyNetThreshold: 1 }), { online: true });
    const object = pointObject(channelId);
    const staleTouch = await object.touchPointAccount("points", accountId, login, 0);
    const staleSnapshot = await object.getPendingPointWelcome("points", accountId);
    expect(staleTouch.welcomePending).toBe(true);
    expect(staleSnapshot).toBeNull();

    const messages: string[] = [];
    const fetcher = makeChatFetch(messages, true);
    const startNote = pointsCatalog.en.chat.startBonus(0, "Points");
    const safetyNote = pointsCatalog.en.chat.safetyNet(5, "Points");
    await dispatchChat(channelId, "stale-start-reply", "!punkte", fetcher);
    await dispatchChat(channelId, "stale-safety-trigger", "hello", fetcher);

    await object.storePendingPointWelcome("points", {
      accountId,
      operationId: `bonus:${accountId}`,
      messageId: "stale-preflight-message",
      text: startNote,
      kind: "start_bonus",
    });
    await expect(object.getPendingPointWelcome("points", accountId)).resolves.toMatchObject({
      operationId: `safety-net:${accountId}:2026-10-27`,
      kind: "safety_net",
      text: safetyNote,
    });

    await dispatchChat(channelId, "stale-safety-reply", "!punkte", fetcher);
    expect(messages.filter((message) => message.includes(startNote))).toHaveLength(1);
    expect(messages.filter((message) => message.includes(safetyNote))).toHaveLength(1);
  });

  it("keeps yesterday's acknowledgement scoped to yesterday's safety-net operation (protects=an in-flight old delivery cannot clear today's queued note or claim; fails_when=acknowledging yesterday removes or claims today's note; no_claim=delivery is held and acknowledged through the real note API)", async () => {
    const channelId = `points-safety-net-midnight-${crypto.randomUUID()}`;
    await createChannel(channelId, pointsSettings({ safetyNetAmount: 5, safetyNetThreshold: 20 }), { online: true });
    const object = pointObject(channelId);
    await seedAccount(object, 0);
    const messages: string[] = [];
    const fetcher = makeChatFetch(messages, true);
    const yesterdayOperationId = `safety-net:${accountId}:2026-10-27`;
    const todayOperationId = `safety-net:${accountId}:2026-10-28`;

    await dispatchChat(channelId, "midnight-yesterday-credit", "hello", fetcher);
    const oldClaimId = "delivery:yesterday";
    await expect(object.claimPointWelcome("points", accountId, yesterdayOperationId, oldClaimId))
      .resolves.toMatchObject({ operationId: yesterdayOperationId, kind: "safety_net" });
    await dispatchChat(channelId, "midnight-today-credit", "hello", fetcher, [pointsModule], "2026-10-28T00:05:00.000Z");

    await object.acknowledgePointWelcome("points", accountId, yesterdayOperationId, oldClaimId);
    await expect(object.getPendingPointWelcome("points", accountId)).resolves.toMatchObject({
      operationId: todayOperationId,
      kind: "safety_net",
    });
    const todayNote = await runPointObject(object, (_target, state) => state.storage.sql.exec<{
      operation_id: string;
      claim_id: string | null;
    }>(
      "SELECT operation_id, claim_id FROM point_welcome_notes WHERE account_id = ? AND operation_id = ?",
      accountId,
      todayOperationId,
    ).toArray()[0]);
    expect(todayNote).toEqual({ operation_id: todayOperationId, claim_id: null });

    await dispatchChat(channelId, "midnight-today-reply", "!punkte", fetcher, [pointsModule], "2026-10-28T00:06:00.000Z");
    const safetyNote = pointsCatalog.en.chat.safetyNet(5, "Points");
    expect(messages.filter((message) => message.includes(safetyNote))).toHaveLength(1);
    await expect(object.pointBalance("points", accountId)).resolves.toBe(10);
  });

  it("keeps disabled safety-net chat bookkeeping to the existing account/activity DO call and avoids safety settings queries (protects=disabled messages do not add account, note, credit, or threshold calls; fails_when=dispatch performs a second DO RPC or a separate D1 threshold query; no_claim=prototype spies observe Worker RPC methods)", async () => {
    const channelId = `points-safety-net-disabled-cost-${crypto.randomUUID()}`;
    await createChannel(channelId, pointsSettings({ safetyNetEnabled: false }), { online: true });
    const object = pointObject(channelId);
    await seedAccount(object, 50);
    const preparePointChat = vi.spyOn(ChannelObject.prototype, "preparePointChat");
    const touchPointAccount = vi.spyOn(ChannelObject.prototype, "touchPointAccount");
    const getPendingPointWelcome = vi.spyOn(ChannelObject.prototype, "getPendingPointWelcome");
    const pointAccount = vi.spyOn(ChannelObject.prototype, "pointAccount");
    const creditPointActivity = vi.spyOn(ChannelObject.prototype, "creditPointActivity");
    const creditPointSafetyNet = vi.spyOn(ChannelObject.prototype, "creditPointSafetyNet");
    const recordChatActivity = vi.spyOn(ChannelObject.prototype, "recordChatActivity");
    const prepare = vi.spyOn(worker.DB, "prepare");

    await dispatchChat(channelId, "disabled-safety-chat", "hello", makeChatFetch([]));

    expect(preparePointChat).toHaveBeenCalledOnce();
    expect(recordChatActivity).toHaveBeenCalledOnce();
    expect(touchPointAccount).not.toHaveBeenCalled();
    expect(getPendingPointWelcome).not.toHaveBeenCalled();
    expect(pointAccount).not.toHaveBeenCalled();
    expect(creditPointActivity).not.toHaveBeenCalled();
    expect(creditPointSafetyNet).not.toHaveBeenCalled();
    const queries = prepare.mock.calls.map(([query]) => query);
    expect(queries.some((query) => query.includes("SELECT language FROM channels"))).toBe(false);
    expect(queries.some((query) => query.includes("SELECT module_id, settings FROM channel_modules"))).toBe(false);
    expect(queries.some((query) => /point/i.test(query))).toBe(false);
    expect(queries.filter((query) => query.includes("JOIN channel_modules"))).toHaveLength(1);
  });
});
