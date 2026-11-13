import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import { channelPointsModule } from "../../src/modules/channel_points";
import { MODULES } from "../../src/modules/registry";
import { authorizeModuleManagementMutation, authorizeModuleMutation } from "../../src/worker/module-authorization";
import {
  CHANNEL_POINTS_LIFECYCLE_ALARM,
  CHANNEL_POINTS_LIFECYCLE_HANDLER,
  channelPointsLifecycleAlarm,
  processChannelPointsEvent,
  reconcileChannelPoints,
} from "../../src/modules/channel_points/service";
import { createChannelPointsRepository } from "../../src/modules/channel_points/repository";
import type { ChannelPointsRewardInput } from "../../src/modules/channel_points/contracts";
import { createWriteInterleavingDatabase, TestD1Database } from "./test-d1";

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  list: vi.fn(),
  listByIds: vi.fn(),
  manageable: vi.fn(),
  setEnabled: vi.fn(),
  createCustomReward: vi.fn(),
  updateCustomReward: vi.fn(),
  deleteCustomReward: vi.fn(),
}));
vi.mock("../../src/worker/twitch/channel-points", () => ({
  updateRedemptionStatus: mocks.update,
  listUnfulfilledRedemptions: mocks.list,
  listRedemptionsByIds: mocks.listByIds,
  getManageableRewards: mocks.manageable,
  setCustomRewardEnabled: mocks.setEnabled,
  createCustomReward: mocks.createCustomReward,
  updateCustomReward: mocks.updateCustomReward,
  deleteCustomReward: mocks.deleteCustomReward,
}));

const channelId = "channel_points";
const now = "2026-11-10T12:00:00.000Z";
const reward: ChannelPointsRewardInput = {
  title: "Fictional reward",
  prompt: null,
  cost: 10,
  backgroundColor: "#9147FF",
  isUserInputRequired: false,
  globalCooldownSeconds: null,
  maxPerStream: null,
  maxPerUserPerStream: null,
  actionModuleId: "channel_points",
  actionId: "chat-message",
  actionConfig: { message: "Hi {user}: {input} ({reward})" },
  mode: "auto",
  enabled: true,
};
const redemptionPayload = (id = "redemption_one") => ({
  id,
  broadcaster_user_id: channelId,
  broadcaster_user_login: "points_demo",
  broadcaster_user_name: "Points Demo",
  user_id: "viewer_one",
  user_login: "viewer_demo",
  user_name: "Viewer Demo",
  user_input: "hello",
  status: "unfulfilled",
  redeemed_at: now,
  reward: {
    id: "reward_twitch", title: "Fictional reward", prompt: "Say hello", cost: 10,
    is_user_input_required: false,
  },
});
const rewardEventPayload = (overrides: Record<string, unknown> = {}) => ({
  id: "reward_twitch", broadcaster_user_id: channelId, broadcaster_user_login: "points_demo",
  broadcaster_user_name: "Points Demo", title: "Fictional reward", prompt: "Say hello", cost: 10,
  is_enabled: true, background_color: "#9147FF", is_user_input_required: false,
  should_redemptions_skip_request_queue: false,
  max_per_stream: { is_enabled: false, value: 0 },
  max_per_user_per_stream: { is_enabled: false, value: 0 },
  global_cooldown: { is_enabled: false, seconds: 0 },
  ...overrides,
});
const rewardRemovalPayload = (id: string) => ({
  id, broadcaster_user_id: channelId, broadcaster_user_login: "points_demo", broadcaster_user_name: "Points Demo",
});
const helixRedemption = (
  id: string,
  status: "UNFULFILLED" | "FULFILLED" | "CANCELED",
  rewardId = "reward_twitch",
  rewardTitle = "Fictional reward",
) => ({
  id, broadcaster_id: channelId, broadcaster_login: "points_demo", broadcaster_name: "Points Demo",
  user_id: "viewer_one", user_login: "viewer_demo", user_name: "Viewer Demo", user_input: "hello",
  redeemed_at: now, status,
  reward: { id: rewardId, title: rewardTitle, prompt: "Say hello", cost: 10 },
});
const event = (subscriptionType: string, payload: Record<string, unknown>): ModuleEvent => ({
  channelId,
  subscriptionType,
  triggerId: "event_one",
  payload,
  settings: {},
  receivedAt: now,
  eventSubTimestamp: now,
  actor: null,
  chatStatus: null,
});
const manageableReward = {
  id: "reward_twitch", title: "Fictional reward", prompt: null, cost: 10, is_enabled: true,
  background_color: "#9147FF", is_user_input_required: false, global_cooldown_seconds: null,
  max_per_stream: null, max_per_user_per_stream: null, is_paused: null, is_in_stock: null,
  should_redemptions_skip_request_queue: false,
};

const activationContext = (database: TestD1Database, serialize = false) => {
  const environment = { DB: database } as unknown as Env;
  let tail = Promise.resolve();
  const run = (_handler: string, alarmKey: string, invocation?: unknown) => channelPointsLifecycleAlarm.handle(
    {
      DB: database as unknown as D1Database,
      environment,
      authorizeMutation: authorizeModuleMutation,
      authorizeManagementMutation: authorizeModuleManagementMutation,
      channelId,
    } as never,
    alarmKey,
    Date.now(),
    undefined,
    invocation,
  );
  return {
    DB: database as unknown as D1Database,
    environment,
    authorizeMutation: authorizeModuleMutation,
    authorizeManagementMutation: authorizeModuleManagementMutation,
    actor: { userId: "operator_one" },
    now,
    runModuleAlarm: (handler: string, alarmKey: string, invocation?: unknown) => {
      if (!serialize) return run(handler, alarmKey, invocation);
      const operation = tail.then(() => run(handler, alarmKey, invocation));
      tail = operation.then(() => undefined);
      return operation;
    },
  };
};

describe("channel points redemption processing", () => {
  let database: TestD1Database;
  let context: ModuleExecutionContext;
  const sendChat = vi.fn();

  beforeEach(async () => {
    mocks.update.mockReset().mockResolvedValue({ ok: true, data: [] });
    mocks.list.mockReset().mockResolvedValue({ ok: true, data: [] });
    mocks.listByIds.mockReset().mockResolvedValue({ ok: true, data: [] });
    mocks.manageable.mockReset().mockResolvedValue({ ok: true, data: [manageableReward] });
    mocks.setEnabled.mockReset().mockResolvedValue({ ok: true, data: [] });
    mocks.createCustomReward.mockReset().mockResolvedValue({ ok: true, data: [{ ...manageableReward, id: "reward_twitch_new" }] });
    mocks.updateCustomReward.mockReset().mockResolvedValue({ ok: true, data: [manageableReward] });
    mocks.deleteCustomReward.mockReset().mockResolvedValue({ ok: true, data: [] });
    sendChat.mockReset().mockResolvedValue({ sent: true, delivery: "sent", reason: null });
    database = new TestD1Database();
    database.sqlite.prepare(
      "INSERT INTO channels (channel_id,login,display_name,created_at,updated_at) VALUES (?,?,?,?,?)",
    ).run(channelId, "points_demo", "Points Demo", now, now);
    database.sqlite.prepare(
      "INSERT INTO channel_members (channel_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?)",
    ).run(channelId, "operator_one", "manager", now, now);
    database.sqlite.prepare(
      "INSERT INTO channel_modules (channel_id,module_id,enabled,settings) VALUES (?, 'channel_points', 1, '{}')",
    ).run(channelId);
    await createChannelPointsRepository(database as unknown as D1Database)
      .insertReward(channelId, reward, "reward_local", "reward_twitch", now);
    context = {
      DB: database as unknown as D1Database,
      environment: { DB: database } as unknown as Env,
      channelId,
      sendChat,
    } as unknown as ModuleExecutionContext;
  });

  afterEach(() => {
    database.close();
    vi.useRealTimers();
  });

  it("registers channel points EventSub types, scopes, default state, and its built-in action", () => {
    expect(MODULES).toContain(channelPointsModule);
    expect(channelPointsModule.defaultEnabled).toBe(false);
    expect(channelPointsModule.broadcasterScopes).toEqual([
      "channel:read:redemptions", "channel:manage:redemptions",
    ]);
    expect(channelPointsModule.eventSubTypes).toEqual([
      "channel.channel_points_custom_reward_redemption.add",
      "channel.channel_points_custom_reward_redemption.update",
      "channel.channel_points_custom_reward.update",
      "channel.channel_points_custom_reward.remove",
    ]);
    expect(channelPointsModule.channelPointsActions?.map(({ id }) => id)).toEqual(["chat-message"]);
    expect(channelPointsModule.serializeLifecycleMutations).toBe(true);
  });

  it("uses the insert latch so duplicate EventSub deliveries have one effect", async () => {
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.add", redemptionPayload()), context);
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.add", redemptionPayload()), context);
    expect(sendChat).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    await expect(createChannelPointsRepository(database as unknown as D1Database).getRedemption(channelId, "redemption_one"))
      .resolves.toMatchObject({ status: "fulfilled", pendingTwitchStatus: null });
  });

  it("recovers a Twitch reward after management authorization expires during creation", async () => {
    const activation = activationContext(database);
    const createdReward = { ...manageableReward, id: "reward_twitch_created", title: "Recovered reward" };
    mocks.createCustomReward.mockImplementationOnce(() => {
      expect(database.sqlite.prepare("SELECT twitch_state FROM channel_points_rewards WHERE id=?")
        .get("reward_local_created")).toEqual({ twitch_state: "creating" });
      database.sqlite.prepare("DELETE FROM channel_members WHERE channel_id=? AND user_id=?")
        .run(channelId, "operator_one");
      return Promise.resolve({ ok: true, data: [createdReward] });
    });

    await expect(activation.runModuleAlarm(CHANNEL_POINTS_LIFECYCLE_HANDLER, CHANNEL_POINTS_LIFECYCLE_ALARM, {
      kind: "reward.create", actor: { userId: "operator_one" }, now, id: "reward_local_created",
      reward: { ...reward, title: "Recovered reward" },
    })).resolves.toMatchObject({ ok: false, reason: "precondition_failed" });

    const repository = createChannelPointsRepository(database as unknown as D1Database);
    await expect(repository.getReward(channelId, "reward_local_created"))
      .resolves.toMatchObject({ twitchRewardId: "creating:reward_local_created", twitchState: "creating" });
    mocks.manageable.mockResolvedValueOnce({ ok: true, data: [createdReward] });

    await reconcileChannelPoints(
      { DB: database as unknown as D1Database } as Env, channelId, now,
      { force: true, context, authorize: () => Promise.resolve(true) },
    );

    await expect(repository.getReward(channelId, "reward_local_created"))
      .resolves.toMatchObject({ twitchRewardId: "reward_twitch_created", twitchState: "active" });
  });

  it("keeps a deletion queued during creation when its event predates the Helix response", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T12:01:00.000Z"));
    const activation = activationContext(database, true);
    const createdReward = { ...manageableReward, id: "reward_twitch_created", title: "Created reward" };
    let finishCreation: (result: { ok: true; data: typeof manageableReward[] }) => void = () => {};
    let creationStarted!: () => void;
    const creationStartedPromise = new Promise<void>((resolve) => { creationStarted = resolve; });
    mocks.createCustomReward.mockImplementationOnce(() => new Promise((resolve) => {
      finishCreation = resolve;
      creationStarted();
    }));

    const create = activation.runModuleAlarm(CHANNEL_POINTS_LIFECYCLE_HANDLER, CHANNEL_POINTS_LIFECYCLE_ALARM, {
      kind: "reward.create", actor: { userId: "operator_one" }, now, id: "reward_local_created",
      reward: { ...reward, title: "Created reward" },
    });
    await creationStartedPromise;
    vi.setSystemTime(new Date("2026-11-10T12:01:30.000Z"));
    const removal = activation.runModuleAlarm(CHANNEL_POINTS_LIFECYCLE_HANDLER, CHANNEL_POINTS_LIFECYCLE_ALARM, {
      kind: "event",
      event: {
        ...event("channel.channel_points_custom_reward.remove", rewardRemovalPayload("reward_twitch_created")),
        eventSubTimestamp: "2026-11-10T12:01:30.000Z",
      },
    });
    vi.setSystemTime(new Date("2026-11-10T12:02:00.000Z"));
    finishCreation({ ok: true, data: [createdReward] });
    await Promise.all([create, removal]);

    await expect(createChannelPointsRepository(database as unknown as D1Database).getReward(channelId, "reward_local_created"))
      .resolves.toMatchObject({ twitchRewardId: "reward_twitch_created", twitchState: "deleted_on_twitch" });
  });

  it("recovers a Twitch reward when D1 fails after successful creation", async () => {
    const createdReward = { ...manageableReward, id: "reward_twitch_created", title: "Recovered reward" };
    mocks.createCustomReward.mockImplementationOnce(() => {
      expect(database.sqlite.prepare("SELECT twitch_state FROM channel_points_rewards WHERE id=?")
        .get("reward_local_created")).toEqual({ twitch_state: "creating" });
      return Promise.resolve({ ok: true, data: [createdReward] });
    });
    let failedFinalWrite = false;
    const failingDatabase = {
      prepare(sql: string) {
        const statement = database.prepare(sql);
        if (!sql.includes("SET twitch_reward_id=?,twitch_state='active'")) return statement;
        const wrapped = {
          bind(...values: Parameters<typeof statement.bind>) {
            statement.bind(...values);
            return wrapped;
          },
          first: <T,>() => statement.first<T>(),
          all: <T,>(...typeHint: readonly T[]) => statement.all<T>(...typeHint),
          run: () => {
            if (!failedFinalWrite) {
              failedFinalWrite = true;
              return Promise.reject(new Error("Injected D1 failure after Twitch creation."));
            }
            return statement.run();
          },
        };
        return wrapped;
      },
      batch: database.batch.bind(database),
    } as unknown as D1Database;

    await expect(channelPointsLifecycleAlarm.handle({
      DB: failingDatabase,
      environment: { DB: failingDatabase } as unknown as Env,
      authorizeMutation: authorizeModuleMutation,
      authorizeManagementMutation: authorizeModuleManagementMutation,
      channelId,
    } as never, CHANNEL_POINTS_LIFECYCLE_ALARM, Date.now(), undefined, {
      kind: "reward.create", actor: { userId: "operator_one" }, now, id: "reward_local_created",
      reward: { ...reward, title: "Recovered reward" },
    })).rejects.toThrow("Injected D1 failure after Twitch creation.");

    const repository = createChannelPointsRepository(database as unknown as D1Database);
    await expect(repository.getReward(channelId, "reward_local_created"))
      .resolves.toMatchObject({ twitchRewardId: "creating:reward_local_created", twitchState: "creating" });
    mocks.manageable.mockResolvedValueOnce({ ok: true, data: [createdReward] });

    await reconcileChannelPoints(
      { DB: database as unknown as D1Database } as Env, channelId, now,
      { force: true, context, authorize: () => Promise.resolve(true) },
    );

    await expect(repository.getReward(channelId, "reward_local_created"))
      .resolves.toMatchObject({ twitchRewardId: "reward_twitch_created", twitchState: "active" });
  });

  it("removes an expired creation intent when Twitch has no matching reward", async () => {
    const repository = createChannelPointsRepository(database as unknown as D1Database);
    await repository.insertCreatingReward(channelId, { ...reward, title: "Expired reward" }, "reward_local_expired",
      "2026-11-10T11:49:59.999Z", { sql: "", values: [] });
    mocks.manageable.mockResolvedValueOnce({ ok: true, data: [manageableReward] });

    await reconcileChannelPoints(
      { DB: database as unknown as D1Database } as Env, channelId, now,
      { force: true, context, authorize: () => Promise.resolve(true) },
    );

    await expect(repository.getReward(channelId, "reward_local_expired")).resolves.toBeNull();
  });

  it("expires a creation intent when its matching remote reward is already linked", async () => {
    const repository = createChannelPointsRepository(database as unknown as D1Database);
    await repository.insertCreatingReward(channelId, { ...reward, title: "Fictional reward" }, "reward_local_expired",
      "2026-11-10T11:49:59.999Z", { sql: "", values: [] });
    mocks.manageable.mockResolvedValueOnce({ ok: true, data: [manageableReward] });

    await reconcileChannelPoints(
      { DB: database as unknown as D1Database } as Env, channelId, now,
      { force: true, context, authorize: () => Promise.resolve(true) },
    );

    await expect(repository.getReward(channelId, "reward_local_expired")).resolves.toBeNull();
    await expect(repository.getReward(channelId, "reward_local")).resolves.toMatchObject({ twitchRewardId: "reward_twitch" });
  });

  it("latches a delayed redemption as orphaned after its reward was removed", async () => {
    await processChannelPointsEvent(event("channel.channel_points_custom_reward.remove", rewardRemovalPayload("reward_twitch")), context);
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.add", redemptionPayload()), context);

    expect(sendChat).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    const orphaned = await createChannelPointsRepository(database as unknown as D1Database).getRedemption(channelId, "redemption_one");
    expect(orphaned).toMatchObject({ status: "orphaned" });
    expect(orphaned?.outcomeReason?.en).toContain("deleted on Twitch");
  });

  it("keeps the later queued update when an earlier update webhook arrives late", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-10T12:01:00.000Z"));
    const activation = activationContext(database, true);
    let finishFirstUpdate: (result: { ok: true; data: typeof manageableReward[] }) => void = () => {};
    let firstUpdateStarted!: () => void;
    const firstUpdateStartedPromise = new Promise<void>((resolve) => { firstUpdateStarted = resolve; });
    mocks.updateCustomReward.mockImplementationOnce(() => new Promise((resolve) => {
      finishFirstUpdate = resolve;
      firstUpdateStarted();
    }));
    const firstUpdate = activation.runModuleAlarm(CHANNEL_POINTS_LIFECYCLE_HANDLER, CHANNEL_POINTS_LIFECYCLE_ALARM, {
      kind: "reward.update", actor: { userId: "operator_one" }, now: "2026-11-10T11:00:00.000Z",
      id: "reward_local", reward: { ...reward, title: "First update" },
    });
    await firstUpdateStartedPromise;
    vi.setSystemTime(new Date("2026-11-10T12:02:00.000Z"));
    const secondUpdate = activation.runModuleAlarm(CHANNEL_POINTS_LIFECYCLE_HANDLER, CHANNEL_POINTS_LIFECYCLE_ALARM, {
      kind: "reward.update", actor: { userId: "operator_one" }, now: "2026-11-10T11:00:00.000Z",
      id: "reward_local", reward: { ...reward, title: "Second update" },
    });
    finishFirstUpdate({ ok: true, data: [manageableReward] });
    await Promise.all([firstUpdate, secondUpdate]);

    await processChannelPointsEvent({
      ...event("channel.channel_points_custom_reward.update", rewardEventPayload({ title: "Delayed first update" })),
      eventSubTimestamp: "2026-11-10T12:01:30.000Z",
    }, context);

    const repository = createChannelPointsRepository(database as unknown as D1Database);
    await expect(repository.getReward(channelId, "reward_local"))
      .resolves.toMatchObject({ title: "Second update" });
    expect(database.sqlite.prepare("SELECT last_twitch_event_at FROM channel_points_rewards WHERE id=?")
      .get("reward_local")).toEqual({ last_twitch_event_at: "2026-11-10T12:02:00.000Z" });
    vi.useRealTimers();
  });

  it("keeps a fulfilled redemption when stale EventSub and action results arrive", async () => {
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.add", redemptionPayload()), context);
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.update", {
      ...redemptionPayload(), status: "unfulfilled",
    }), context);
    const repository = createChannelPointsRepository(database as unknown as D1Database);
    await expect(repository.updateRedemption(channelId, "redemption_one", {
      status: "failed_to_update", pendingTwitchStatus: "CANCELED",
    }, ["running"], now)).resolves.toBe(false);
    await expect(repository.getRedemption(channelId, "redemption_one"))
      .resolves.toMatchObject({ status: "fulfilled", pendingTwitchStatus: null });
  });

  it("accepts Twitch terminal status over a non-terminal state and records a mismatch", async () => {
    const repository = createChannelPointsRepository(database as unknown as D1Database);
    await repository.latchRedemption(channelId, {
      id: "redemption_one", rewardId: "reward_local", twitchRewardId: "reward_twitch", rewardTitle: "Fictional reward", userId: "viewer_one",
      userLogin: "viewer_demo", userName: "Viewer Demo", userInput: "hello", redeemedAt: now,
    }, now);
    await repository.updateRedemption(channelId, "redemption_one", {
      status: "failed_to_update", pendingTwitchStatus: "CANCELED",
    }, ["received"], now);
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.update", {
      ...redemptionPayload(), status: "fulfilled",
    }), context);
    const saved = await repository.getRedemption(channelId, "redemption_one");
    expect(saved).toMatchObject({ status: "fulfilled", pendingTwitchStatus: null });
    expect(saved?.outcomeReason?.en).toContain("Twitch reported fulfilled");
    expect(saved?.outcomeReason?.de).toContain("Twitch");
  });

  it("latches a cancellation that arrives before its redemption add event", async () => {
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.update", {
      ...redemptionPayload(), status: "canceled",
    }), context);
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.add", redemptionPayload()), context);

    expect(sendChat).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    await expect(createChannelPointsRepository(database as unknown as D1Database).getRedemption(channelId, "redemption_one"))
      .resolves.toMatchObject({ status: "refunded", pendingTwitchStatus: null });
  });

  it("abandons pending actions after EventSub or Helix cancellation without blocking a refund", async () => {
    const repository = createChannelPointsRepository(database as unknown as D1Database);
    await database.prepare(
      `INSERT INTO channel_modules (channel_id,module_id,enabled,settings)
       VALUES (?,'temp_vips',1,'{"defaultDurationDays":7,"maximumDurationDays":90,"announceExpiry":false}')`,
    ).bind(channelId).run();
    await repository.updateReward(channelId, "reward_local", {
      ...reward,
      actionModuleId: "temp_vips",
      actionId: "grant-vip",
      actionConfig: { durationDays: 7 },
    }, now);
    const abandon = vi.fn().mockRejectedValueOnce(new Error("abandon unavailable"));
    const tempVips = {
      mode: vi.fn().mockResolvedValue("managed"),
      replayGrant: vi.fn().mockResolvedValue(null),
      grant: vi.fn().mockResolvedValue({ status: "queued" }),
      abandon,
    } as unknown as ModuleExecutionContext["tempVips"];
    const moduleContext = { ...context, tempVips };
    const actionContext = {
      ...context,
      forModule: () => moduleContext,
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await processChannelPointsEvent(
        event("channel.channel_points_custom_reward_redemption.add", redemptionPayload("redemption_pending_event_cancel")),
        actionContext,
      );
      await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.update", {
        ...redemptionPayload("redemption_pending_event_cancel"), status: "canceled",
      }), actionContext);
      await expect(repository.getRedemption(channelId, "redemption_pending_event_cancel"))
        .resolves.toMatchObject({ status: "refunded" });
      expect(abandon).toHaveBeenCalledWith("redemption_pending_event_cancel");
      expect(warn).toHaveBeenCalledWith(
        "Channel-points action abandonment failed.", channelId, "redemption_pending_event_cancel", expect.any(Error),
      );

      await processChannelPointsEvent(
        event("channel.channel_points_custom_reward_redemption.add", redemptionPayload("redemption_pending_helix_cancel")),
        actionContext,
      );
      mocks.listByIds.mockResolvedValueOnce({
        ok: true,
        data: [helixRedemption("redemption_pending_helix_cancel", "CANCELED")],
      });
      await reconcileChannelPoints(
        { DB: database as unknown as D1Database } as Env,
        channelId,
        now,
        { force: true, context: actionContext, authorize: () => Promise.resolve(true) },
      );

      expect(abandon).toHaveBeenCalledTimes(2);
      expect(abandon).toHaveBeenLastCalledWith("redemption_pending_helix_cancel");
      await expect(repository.getRedemption(channelId, "redemption_pending_helix_cancel"))
        .resolves.toMatchObject({ status: "refunded" });
    } finally {
      warn.mockRestore();
    }
  });

  it("ignores an unknown EventSub redemption status", async () => {
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.update", {
      ...redemptionPayload(), status: "unknown",
    }), context);

    await expect(createChannelPointsRepository(database as unknown as D1Database).getRedemption(channelId, "redemption_one"))
      .resolves.toBeNull();
  });

  it("serializes a first cancellation ahead of an interleaved add without running the action", async () => {
    const cancellation = event("channel.channel_points_custom_reward_redemption.update", {
      ...redemptionPayload(), status: "canceled",
    }) as ModuleEvent<Record<string, never>>;
    let tail = Promise.resolve();
    const serializedContext = {
      ...context,
      runModuleAlarm: (_handler: string, _key: string, invocation?: unknown) => {
        const operation = tail.then(async () => {
          const eventInvocation = invocation as { event: ModuleEvent };
          await processChannelPointsEvent(eventInvocation.event, context);
        });
        tail = operation.then(() => undefined);
        return operation;
      },
    } as ModuleExecutionContext;
    const cancel = channelPointsModule.handleEvent?.(cancellation, serializedContext);
    const add = channelPointsModule.handleEvent?.(
      event("channel.channel_points_custom_reward_redemption.add", redemptionPayload()) as ModuleEvent<Record<string, never>>,
      serializedContext,
    );
    await Promise.all([cancel, add]);

    expect(sendChat).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    await expect(createChannelPointsRepository(database as unknown as D1Database).getRedemption(channelId, "redemption_one"))
      .resolves.toMatchObject({ status: "refunded", pendingTwitchStatus: null });
  });

  it("updates the row when a terminal latch loses to an interleaved add", async () => {
    const repository = createChannelPointsRepository(database as unknown as D1Database);
    let interleaved = false;
    const interleavedDatabase = createWriteInterleavingDatabase(
      database,
      (sql) => sql.includes("INSERT OR IGNORE INTO channel_points_redemptions"),
      async () => {
        interleaved = true;
        await repository.latchRedemption(channelId, {
          id: "redemption_one", rewardId: "reward_local", twitchRewardId: "reward_twitch", rewardTitle: reward.title, userId: "viewer_one",
          userLogin: "viewer_demo", userName: "Viewer Demo", userInput: "hello", redeemedAt: now,
        }, now);
      },
    );
    const cancellationContext = {
      ...context,
      DB: interleavedDatabase,
      environment: { DB: interleavedDatabase } as unknown as Env,
    } as ModuleExecutionContext;
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.update", {
      ...redemptionPayload(), status: "canceled",
    }), cancellationContext);
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.add", redemptionPayload()), context);

    expect(interleaved).toBe(true);
    expect(sendChat).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    await expect(createChannelPointsRepository(database as unknown as D1Database).getRedemption(channelId, "redemption_one"))
      .resolves.toMatchObject({ status: "refunded", pendingTwitchStatus: null });
  });

  it("keeps an interrupted queue redemption queued during recovery", async () => {
    const repository = createChannelPointsRepository(database as unknown as D1Database);
    await repository.updateReward(channelId, "reward_local", { ...reward, mode: "queue" }, now);
    await repository.latchRedemption(channelId, {
      id: "redemption_interrupted_queue", rewardId: "reward_local", twitchRewardId: "reward_twitch", rewardTitle: reward.title,
      userId: "viewer_one", userLogin: "viewer_demo", userName: "Viewer Demo", userInput: "hello", redeemedAt: now,
    }, now);
    mocks.list.mockResolvedValue({ ok: true, data: [helixRedemption("redemption_interrupted_queue", "UNFULFILLED")] });

    await reconcileChannelPoints(
      { DB: database as unknown as D1Database } as Env, channelId, now,
      { force: true, context, authorize: () => Promise.resolve(true) },
    );

    expect(sendChat).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
    await expect(repository.getRedemption(channelId, "redemption_interrupted_queue"))
      .resolves.toMatchObject({ status: "queued" });
  });

  it("refunds when the action provider module is disabled", async () => {
    database.sqlite.prepare("UPDATE channel_modules SET enabled = 0 WHERE channel_id = ? AND module_id = 'channel_points'")
      .run(channelId);
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.add", redemptionPayload()), context);
    expect(sendChat).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledWith(
      expect.anything(), channelId, "reward_twitch", ["redemption_one"], "CANCELED", expect.any(Function),
    );
    await expect(createChannelPointsRepository(database as unknown as D1Database).getRedemption(channelId, "redemption_one"))
      .resolves.toMatchObject({ status: "refunded", outcomeReason: { en: "The module providing this reward action is disabled." } });
  });

  it("leaves an ambiguous chat send pending and does not patch Twitch", async () => {
    sendChat.mockResolvedValue({ sent: false, delivery: "ambiguous", reason: "timeout" });
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.add", redemptionPayload()), context);
    expect(mocks.update).not.toHaveBeenCalled();
    await expect(createChannelPointsRepository(database as unknown as D1Database).getRedemption(channelId, "redemption_one"))
      .resolves.toMatchObject({ status: "pending", pendingTwitchStatus: null });
  });

  it("marks a failed status patch for retry and reconciles it without repeating the chat action", async () => {
    mocks.update.mockResolvedValueOnce({ ok: false, reason: "unknown_status" }).mockResolvedValueOnce({ ok: true, data: [] });
    mocks.list.mockResolvedValue({ ok: true, data: [helixRedemption("redemption_one", "UNFULFILLED")] });
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.add", redemptionPayload()), context);
    await expect(createChannelPointsRepository(database as unknown as D1Database).getRedemption(channelId, "redemption_one"))
      .resolves.toMatchObject({ status: "failed_to_update", pendingTwitchStatus: "FULFILLED" });
    database.sqlite.prepare(
      "UPDATE channel_points_redemptions SET claimed_at='2026-11-10T11:57:00.000Z' WHERE channel_id=? AND redemption_id=?",
    ).run(channelId, "redemption_one");
    await reconcileChannelPoints(
      { DB: database as unknown as D1Database } as Env, channelId, now,
      { force: true, context, authorize: () => Promise.resolve(true) },
    );
    expect(sendChat).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledTimes(2);
    await expect(createChannelPointsRepository(database as unknown as D1Database).getRedemption(channelId, "redemption_one"))
      .resolves.toMatchObject({ status: "fulfilled", pendingTwitchStatus: null });
  });

  it("adopts a known reward update and marks a known removal without touching foreign rewards", async () => {
    await processChannelPointsEvent(event("channel.channel_points_custom_reward.update", rewardEventPayload({
      title: "Renamed reward", cost: 25,
    })), context);
    expect(await createChannelPointsRepository(database as unknown as D1Database).getReward(channelId, "reward_local"))
      .toMatchObject({ title: "Renamed reward", cost: 25, prompt: "Say hello", maxPerStream: null });
    await processChannelPointsEvent(event("channel.channel_points_custom_reward.remove", rewardRemovalPayload("reward_twitch")), context);
    expect(await createChannelPointsRepository(database as unknown as D1Database).getReward(channelId, "reward_local"))
      .toMatchObject({ twitchState: "deleted_on_twitch" });
    await processChannelPointsEvent(event("channel.channel_points_custom_reward.remove", rewardRemovalPayload("foreign_reward")), context);
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM channel_points_rewards").get()).toMatchObject({ count: 1 });
  });

  it("marks queued redemptions orphaned when their reward is removed locally", async () => {
    const repository = createChannelPointsRepository(database as unknown as D1Database);
    await repository.updateReward(channelId, "reward_local", { ...reward, mode: "queue" }, now);
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.add", redemptionPayload()), context);

    const activation = activationContext(database);
    await activation.runModuleAlarm(CHANNEL_POINTS_LIFECYCLE_HANDLER, CHANNEL_POINTS_LIFECYCLE_ALARM, {
      kind: "reward.delete", actor: { userId: "operator_one" }, now, id: "reward_local",
    });

    const orphaned = await repository.getRedemption(channelId, "redemption_one");
    expect(orphaned).toMatchObject({ status: "orphaned", twitchRewardId: "reward_twitch" });
    expect(orphaned?.outcomeReason?.en).toContain("deleted on Twitch");
    await expect(repository.getReward(channelId, "reward_local")).resolves.toBeNull();
  });

  it("orphan open redemptions when Twitch omits their reward from manageable rewards", async () => {
    const repository = createChannelPointsRepository(database as unknown as D1Database);
    await repository.updateReward(channelId, "reward_local", { ...reward, mode: "queue" }, now);
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.add", redemptionPayload()), context);
    mocks.manageable.mockResolvedValue({ ok: true, data: [] });

    await reconcileChannelPoints(
      { DB: database as unknown as D1Database } as Env, channelId, now,
      { force: true, context, authorize: () => Promise.resolve(true) },
    );

    await expect(repository.getRedemption(channelId, "redemption_one"))
      .resolves.toMatchObject({ status: "orphaned", twitchRewardId: "reward_twitch" });
    expect(mocks.listByIds).not.toHaveBeenCalled();
  });

  it("preserves an old redemption reward ID after the local reward is recreated", async () => {
    const repository = createChannelPointsRepository(database as unknown as D1Database);
    await repository.updateReward(channelId, "reward_local", { ...reward, mode: "queue" }, now);
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.add", redemptionPayload()), context);
    await processChannelPointsEvent(event("channel.channel_points_custom_reward.remove", rewardRemovalPayload("reward_twitch")), context);

    const activation = activationContext(database);
    await activation.runModuleAlarm(CHANNEL_POINTS_LIFECYCLE_HANDLER, CHANNEL_POINTS_LIFECYCLE_ALARM, {
      kind: "reward.recreate", actor: { userId: "operator_one" }, now, id: "reward_local",
    });
    mocks.manageable.mockResolvedValue({ ok: true, data: [{ ...manageableReward, id: "reward_twitch_new" }] });

    await reconcileChannelPoints(
      { DB: database as unknown as D1Database } as Env, channelId, now,
      { force: true, context, authorize: () => Promise.resolve(true) },
    );

    await expect(repository.getReward(channelId, "reward_local"))
      .resolves.toMatchObject({ twitchRewardId: "reward_twitch_new", twitchState: "active" });
    await expect(repository.getRedemption(channelId, "redemption_one"))
      .resolves.toMatchObject({ twitchRewardId: "reward_twitch", status: "orphaned" });
    expect(mocks.listByIds).not.toHaveBeenCalled();
  });

  it("uses each redemption's original reward ID after the reward has been recreated", async () => {
    const repository = createChannelPointsRepository(database as unknown as D1Database);
    await repository.updateReward(channelId, "reward_local", { ...reward, mode: "queue" }, now);
    await processChannelPointsEvent(event("channel.channel_points_custom_reward_redemption.add", redemptionPayload()), context);
    await repository.markRewardDeleted(channelId, "reward_twitch", now);
    await repository.replaceTwitchId(channelId, "reward_local", "reward_twitch_new", now);
    mocks.manageable.mockResolvedValue({ ok: true, data: [{ ...manageableReward, id: "reward_twitch_new" }] });
    mocks.listByIds.mockResolvedValue({ ok: false, reason: "not_found" });

    await reconcileChannelPoints(
      { DB: database as unknown as D1Database } as Env, channelId, now,
      { force: true, context, authorize: () => Promise.resolve(true) },
    );

    expect(mocks.listByIds).toHaveBeenCalledWith(
      expect.anything(), channelId, "reward_twitch", ["redemption_one"], expect.any(Function),
    );
    await expect(repository.getReward(channelId, "reward_local"))
      .resolves.toMatchObject({ twitchRewardId: "reward_twitch_new", twitchState: "active" });
    await expect(repository.getRedemption(channelId, "redemption_one"))
      .resolves.toMatchObject({ status: "orphaned", twitchRewardId: "reward_twitch" });
  });

  it("rejects stale reward events after Helix reconciliation and reward updates", async () => {
    const reconciledAt = "2026-11-10T12:01:00.000Z";
    const repository = createChannelPointsRepository(database as unknown as D1Database);
    mocks.manageable.mockResolvedValue({ ok: true, data: [{
      ...manageableReward, title: "Reconciled reward", cost: 20, is_enabled: false,
    }] });
    await reconcileChannelPoints(
      { DB: database as unknown as D1Database } as Env, channelId, reconciledAt,
      { force: true, context, authorize: () => Promise.resolve(true) },
    );
    await processChannelPointsEvent({
      ...event("channel.channel_points_custom_reward.update", rewardEventPayload({ title: "Stale after reconcile", cost: 99 })),
      eventSubTimestamp: "2026-11-10T12:00:30.000Z",
    }, context);
    await expect(repository.getReward(channelId, "reward_local"))
      .resolves.toMatchObject({ title: "Reconciled reward", cost: 20, enabled: false });

    const updatedAt = "2026-11-10T12:02:00.000Z";
    await activationContext(database).runModuleAlarm(CHANNEL_POINTS_LIFECYCLE_HANDLER, CHANNEL_POINTS_LIFECYCLE_ALARM, {
      kind: "reward.update", actor: { userId: "operator_one" }, now: updatedAt, id: "reward_local",
      reward: { ...reward, title: "Updated reward", cost: 30, enabled: true },
    });
    await processChannelPointsEvent({
      ...event("channel.channel_points_custom_reward.update", rewardEventPayload({ title: "Stale after update", cost: 44 })),
      eventSubTimestamp: "2026-11-10T12:01:30.000Z",
    }, context);
    await expect(repository.getReward(channelId, "reward_local"))
      .resolves.toMatchObject({ title: "Updated reward", cost: 30, enabled: true });
  });

  it("keeps a reward deletion tombstone when an older update is delivered afterward", async () => {
    await processChannelPointsEvent({
      ...event("channel.channel_points_custom_reward.remove", rewardRemovalPayload("reward_twitch")),
      eventSubTimestamp: "2026-11-10T12:02:00.000Z",
    }, context);
    await processChannelPointsEvent({
      ...event("channel.channel_points_custom_reward.update", rewardEventPayload({
        title: "Stale reward", cost: 999,
      })),
      eventSubTimestamp: "2026-11-10T12:01:00.000Z",
    }, context);

    expect(await createChannelPointsRepository(database as unknown as D1Database).getReward(channelId, "reward_local"))
      .toMatchObject({ title: "Fictional reward", cost: 10, twitchState: "deleted_on_twitch" });
  });

  it("recovers a Twitch deletion that happened while disabled and continues with manageable rewards", async () => {
    const repository = createChannelPointsRepository(database as unknown as D1Database);
    await repository.insertReward(channelId, { ...reward, title: "Healthy reward" }, "reward_local_two", "reward_twitch_two", now);
    const lifecycle = channelPointsModule.onActivationChange;
    if (lifecycle === undefined) throw new Error("Channel-points activation callback is missing.");
    const activation = activationContext(database);
    database.sqlite.prepare("UPDATE channel_modules SET enabled = 0 WHERE channel_id = ? AND module_id = 'channel_points'")
      .run(channelId);
    await lifecycle(activation, channelId, false);
    expect(mocks.setEnabled).toHaveBeenCalledWith(activation.environment, channelId, "reward_twitch", false, expect.any(Function));
    expect(mocks.setEnabled).toHaveBeenCalledWith(activation.environment, channelId, "reward_twitch_two", false, expect.any(Function));

    // No EventSub subscription is active during this interval; Twitch removes the first reward remotely.
    mocks.manageable.mockResolvedValue({ ok: true, data: [{
      id: "reward_twitch_two", title: "Healthy reward", prompt: null, cost: 20, is_enabled: true,
      background_color: null, is_user_input_required: false, global_cooldown_seconds: null,
      max_per_stream: null, max_per_user_per_stream: null, is_paused: null, is_in_stock: null,
      should_redemptions_skip_request_queue: false,
    }] });
    database.sqlite.prepare("UPDATE channel_modules SET enabled = 1 WHERE channel_id = ? AND module_id = 'channel_points'")
      .run(channelId);
    mocks.setEnabled.mockImplementation((_environment, _channelId, rewardId, enabled) => Promise.resolve(
      rewardId === "reward_twitch" && enabled === true
        ? { ok: false, reason: "unknown_status" }
        : { ok: true, data: [] },
    ));
    await expect(lifecycle(activation, channelId, true)).resolves.toMatchObject({
      ok: false,
      error: "channel_points_activation_sync_failed",
      failedRewards: [{ rewardId: "reward_twitch", reason: "unknown_status" }],
    });

    const result = await reconcileChannelPoints(
      { DB: database as unknown as D1Database } as Env, channelId, now,
      { force: true, context, authorize: () => Promise.resolve(true) },
    );

    expect(result).toBe("success");
    expect(await repository.getReward(channelId, "reward_local"))
      .toMatchObject({ twitchState: "deleted_on_twitch" });
    expect(await repository.getReward(channelId, "reward_local_two"))
      .toMatchObject({ title: "Healthy reward", enabled: true, twitchState: "active" });
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.list).toHaveBeenCalledWith(expect.anything(), channelId, "reward_twitch_two", expect.any(Function));
  });

  it("collects per-reward reconcile failures and continues healthy rewards", async () => {
    const repository = createChannelPointsRepository(database as unknown as D1Database);
    await repository.insertReward(channelId, { ...reward, title: "Healthy reward" }, "reward_local_two", "reward_twitch_two", now);
    mocks.manageable.mockResolvedValue({ ok: true, data: [manageableReward, {
      ...manageableReward, id: "reward_twitch_two", title: "Healthy reward",
    }] });
    mocks.list.mockImplementation((_environment, _channel, rewardId) => Promise.resolve(
      rewardId === "reward_twitch"
        ? { ok: false, reason: "unknown_status" }
        : { ok: true, data: [helixRedemption("redemption_healthy", "UNFULFILLED", "reward_twitch_two", "Healthy reward")] },
    ));

    const result = await reconcileChannelPoints(
      { DB: database as unknown as D1Database } as Env, channelId, now,
      { force: true, context, authorize: () => Promise.resolve(true) },
    );

    expect(result).toEqual({ failedRewards: [{ rewardId: "reward_twitch", reason: "unknown_status" }] });
    expect(mocks.list).toHaveBeenCalledTimes(2);
    expect(sendChat).toHaveBeenCalledTimes(1);
    await expect(repository.getRedemption(channelId, "redemption_healthy"))
      .resolves.toMatchObject({ status: "fulfilled" });
  });

  it("applies a missed Twitch cancellation before retrying failed status patches", async () => {
    const repository = createChannelPointsRepository(database as unknown as D1Database);
    await repository.latchRedemption(channelId, {
      id: "redemption_missed_cancel", rewardId: "reward_local", twitchRewardId: "reward_twitch", rewardTitle: reward.title,
      userId: "viewer_one", userLogin: "viewer_demo", userName: "Viewer Demo", userInput: "hello", redeemedAt: now,
    }, now);
    await repository.updateRedemption(channelId, "redemption_missed_cancel", {
      status: "failed_to_update", pendingTwitchStatus: "CANCELED", claimedAt: "2026-11-10T11:57:00.000Z",
    }, ["received"], now);
    mocks.listByIds.mockResolvedValue({ ok: true, data: [helixRedemption("redemption_missed_cancel", "CANCELED")] });

    await reconcileChannelPoints(
      { DB: database as unknown as D1Database } as Env, channelId, now,
      { force: true, context, authorize: () => Promise.resolve(true) },
    );

    expect(mocks.listByIds).toHaveBeenCalledWith(
      expect.anything(), channelId, "reward_twitch", ["redemption_missed_cancel"], expect.any(Function),
    );
    expect(mocks.update).not.toHaveBeenCalled();
    expect(sendChat).not.toHaveBeenCalled();
    await expect(repository.getRedemption(channelId, "redemption_missed_cancel"))
      .resolves.toMatchObject({ status: "refunded", pendingTwitchStatus: null });
  });

  it("batches open redemption lookups in groups of at most 50 for one Twitch reward", async () => {
    const repository = createChannelPointsRepository(database as unknown as D1Database);
    for (let index = 0; index < 51; index += 1) {
      await repository.latchRedemption(channelId, {
        id: `redemption_batch_${String(index)}`, rewardId: "reward_local", twitchRewardId: "reward_twitch", rewardTitle: reward.title,
        userId: "viewer_one", userLogin: "viewer_demo", userName: "Viewer Demo", userInput: "hello", redeemedAt: now,
      }, now);
    }

    await reconcileChannelPoints(
      { DB: database as unknown as D1Database } as Env, channelId, now,
      { force: true, context, authorize: () => Promise.resolve(true) },
    );

    expect(mocks.listByIds).toHaveBeenCalledTimes(2);
    expect(mocks.listByIds.mock.calls.map((call) => (call[3] as string[]).length)).toEqual([50, 1]);
    expect(mocks.listByIds.mock.calls.map((call) => String(call[2]))).toEqual(["reward_twitch", "reward_twitch"]);
  });

  it("adopts enabled nested EventSub cooldown and per-stream limits", async () => {
    await processChannelPointsEvent(event("channel.channel_points_custom_reward.update", rewardEventPayload({
      title: "Limited reward", cost: 25,
      global_cooldown: { is_enabled: true, seconds: 90 },
      max_per_stream: { is_enabled: true, value: 8 },
      max_per_user_per_stream: { is_enabled: true, value: 2 },
    })), context);

    expect(await createChannelPointsRepository(database as unknown as D1Database).getReward(channelId, "reward_local"))
      .toMatchObject({
        title: "Limited reward", globalCooldownSeconds: 90, maxPerStream: 8, maxPerUserPerStream: 2,
      });
  });

  it("disables rewards with the module and restores their saved enabled state", async () => {
    const lifecycle = channelPointsModule.onActivationChange;
    expect(lifecycle).toBeDefined();
    const activation = activationContext(database);
    database.sqlite.prepare("UPDATE channel_modules SET enabled = 0 WHERE channel_id = ? AND module_id = 'channel_points'")
      .run(channelId);
    await lifecycle?.(activation, channelId, false);
    expect(mocks.setEnabled).toHaveBeenLastCalledWith(
      activation.environment, channelId, "reward_twitch", false, expect.any(Function),
    );
    expect(database.sqlite.prepare("SELECT enabled,restore_enabled FROM channel_points_rewards").get())
      .toMatchObject({ enabled: 0, restore_enabled: 1 });
    database.sqlite.prepare("UPDATE channel_modules SET enabled = 1 WHERE channel_id = ? AND module_id = 'channel_points'")
      .run(channelId);
    await lifecycle?.(activation, channelId, true);
    expect(mocks.setEnabled).toHaveBeenLastCalledWith(
      activation.environment, channelId, "reward_twitch", true, expect.any(Function),
    );
    expect(database.sqlite.prepare("SELECT enabled,restore_enabled FROM channel_points_rewards").get())
      .toMatchObject({ enabled: 1, restore_enabled: null });
  });

  it("skips deleted rewards, reports individual sync failures, and retries active rewards on the next toggle", async () => {
    const repository = createChannelPointsRepository(database as unknown as D1Database);
    await repository.insertReward(channelId, { ...reward, title: "Second reward" }, "reward_local_two", "reward_twitch_two", now);
    await database.prepare("UPDATE channel_points_rewards SET twitch_state='deleted_on_twitch' WHERE id=?")
      .bind("reward_local_two").run();
    await repository.insertReward(channelId, { ...reward, title: "Third reward" }, "reward_local_three", "reward_twitch_three", now);
    mocks.setEnabled.mockImplementation((_environment, _channelId, rewardId) => Promise.resolve(
      rewardId === "reward_twitch" ? { ok: false, reason: "unknown_status" } : { ok: true, data: [] },
    ));
    const lifecycle = channelPointsModule.onActivationChange;
    const activation = activationContext(database);

    const result = await lifecycle?.(activation, channelId, true);

    const firstAttempt = mocks.setEnabled.mock.calls.map((call) => String(call[2]));
    expect(firstAttempt).toHaveLength(2);
    expect(firstAttempt).toEqual(expect.arrayContaining(["reward_twitch", "reward_twitch_three"]));
    expect(result).toEqual({
      ok: false,
      error: "channel_points_activation_sync_failed",
      failedRewards: [{ rewardId: "reward_twitch", reason: "unknown_status" }],
    });
    expect(database.sqlite.prepare("SELECT enabled,restore_enabled FROM channel_points_rewards WHERE id=?")
      .get("reward_local_three")).toMatchObject({ enabled: 1, restore_enabled: null });

    mocks.setEnabled.mockReset().mockResolvedValue({ ok: true, data: [] });
    await lifecycle?.(activation, channelId, true);
    const retryAttempt = mocks.setEnabled.mock.calls.map((call) => String(call[2]));
    expect(retryAttempt).toHaveLength(2);
    expect(retryAttempt).toEqual(expect.arrayContaining(["reward_twitch", "reward_twitch_three"]));
  });

  it("serializes overlapping activation effects and matches Twitch to the final module state", async () => {
    const lifecycle = channelPointsModule.onActivationChange;
    if (lifecycle === undefined) throw new Error("Channel-points activation callback is missing.");
    const activation = activationContext(database, true);
    let finishDisable: (result: { ok: true; data: [] }) => void = () => {};
    let twitchEnabled = true;
    mocks.setEnabled.mockImplementationOnce(() => new Promise<{ ok: true; data: [] }>((resolve) => {
      finishDisable = (result) => { twitchEnabled = false; resolve(result); };
    })).mockImplementation((_environment, _channel, _rewardId, enabled) => {
      twitchEnabled = enabled as boolean;
      return Promise.resolve({ ok: true, data: [] });
    });
    database.sqlite.prepare("UPDATE channel_modules SET enabled = 0 WHERE channel_id = ? AND module_id = 'channel_points'")
      .run(channelId);
    const disable = lifecycle(activation, channelId, false);
    await vi.waitFor(() => { expect(mocks.setEnabled).toHaveBeenCalledTimes(1); });
    database.sqlite.prepare("UPDATE channel_modules SET enabled = 1 WHERE channel_id = ? AND module_id = 'channel_points'")
      .run(channelId);
    const enable = lifecycle(activation, channelId, true);
    await Promise.resolve();
    expect(mocks.setEnabled).toHaveBeenCalledTimes(1);
    finishDisable({ ok: true, data: [] });
    await disable;
    await enable;

    expect(mocks.setEnabled.mock.calls.map((call) => call[3] as boolean)).toEqual([false, true]);
    expect(twitchEnabled).toBe(true);
    expect(database.sqlite.prepare("SELECT enabled,restore_enabled FROM channel_points_rewards WHERE id='reward_local'").get())
      .toMatchObject({ enabled: 1, restore_enabled: null });
  });
});
