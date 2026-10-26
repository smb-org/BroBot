import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { duelModule } from "../../src/modules/duel";
import { duelSettingsForLanguage } from "../../src/modules/duel/contracts";
import { pointsDefaultSettingsForLanguage } from "../../src/modules/points/contracts";
import { pointsModule } from "../../src/modules/points";
import { pointsCatalog } from "../../src/modules/points/locale";
import { dispatchEventSubNotification } from "../../src/worker/dispatch";
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

const makeChatFetch = (messages: string[]): typeof fetch => vi.fn<typeof fetch>((input, init) => {
  const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.href;
  if (url.includes("/helix/chat/messages")) {
    const requestBody = init?.body;
    const body: unknown = typeof requestBody === "string" ? JSON.parse(requestBody) : null;
    if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string") messages.push(body.message);
    return Promise.resolve(new Response(JSON.stringify({ data: [{ is_sent: true }] }), { status: 200 }));
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
    messageId: "seed-message",
    text: pointsCatalog.en.chat.startBonus(balance, "Points"),
    kind: "start_bonus",
  });
  const claimId = "seed:welcome";
  if (!await object.claimPointWelcome("points", accountId, claimId)) throw new Error("seed_welcome_claim_failed");
  await object.acknowledgePointWelcome("points", accountId, claimId);
}

const dispatchChat = async (
  channelId: string,
  messageId: string,
  text: string,
  fetcher: typeof fetch,
  registry: readonly [typeof pointsModule, ...typeof duelModule[]] | readonly [typeof pointsModule] = [pointsModule],
  timestamp = "2026-10-27T10:05:00.000Z",
): Promise<void> => dispatchEventSubNotification(worker, {
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

beforeAll(runMigrations);
beforeEach(configureChatAuth);
afterEach(clearPointObjectAlarms);

describe("points safety net", () => {
  it("credits a broke account once per UTC day and delivers its note on the next points reply (protects=live broke viewers receive one zero-sum house credit and one pending note; fails_when=the credit repeats, misses the next points reply, or appears in a later reply; no_claim=the chat transport reports successful delivery)", async () => {
    const channelId = `points-safety-net-delivery-${crypto.randomUUID()}`;
    await createChannel(channelId, pointsSettings({ safetyNetAmount: 5 }), { online: true });
    const object = pointObject(channelId);
    await seedAccount(object, 0);
    const messages: string[] = [];
    const fetcher = makeChatFetch(messages);

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
});
