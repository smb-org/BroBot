import { afterEach, describe, expect, it, vi } from "vitest";
import type * as EventLogModule from "../../src/worker/event-log";
import type * as PanelResourcesModule from "../../src/worker/panel-resources";

const mocks = vi.hoisted(() => ({
  helixRequest: vi.fn(),
  readBotCredentials: vi.fn(),
  readChannelControls: vi.fn(),
  sendChatMessage: vi.fn(),
  writeModuleAudit: vi.fn(),
  writeModuleDiagnostics: vi.fn(),
}));

vi.mock("../../src/worker/twitch/helix", () => ({ helixRequest: mocks.helixRequest }));
vi.mock("../../src/worker/auth/bot-credentials", () => ({ readBotCredentials: mocks.readBotCredentials }));
vi.mock("../../src/worker/db/channel-controls", () => ({ readChannelControls: mocks.readChannelControls }));
vi.mock("../../src/worker/chat", () => ({ sendChatMessage: mocks.sendChatMessage }));
vi.mock("../../src/worker/module-audit", () => ({ writeModuleAudit: mocks.writeModuleAudit }));
vi.mock("../../src/worker/event-log", async (importOriginal) => ({
  ...await importOriginal<typeof EventLogModule>(),
  writeModuleDiagnostics: mocks.writeModuleDiagnostics,
}));
vi.mock("../../src/worker/panel-resources", async (importOriginal) => ({
  ...await importOriginal<typeof PanelResourcesModule>(),
  notifyCommittedResources: vi.fn().mockResolvedValue(undefined),
}));

import { ChannelObject } from "../../src/worker/durable/ChannelObject";

const CHAT_TEMPLATE = "Clip: {clip.title} {clip.url}";

type StorageDouble = {
  values: Map<string, unknown>;
  get: (key: string) => Promise<unknown>;
  put: (key: string, value: unknown) => Promise<void>;
  delete: (key: string | string[]) => Promise<boolean>;
  list: (options?: { prefix?: string; startAfter?: string; limit?: number }) => Promise<Map<string, unknown>>;
  transaction: <Result>(closure: (transaction: StorageDouble & {
    setAlarm: (deadline: number | Date) => Promise<void>;
    deleteAlarm: () => Promise<void>;
  }) => Promise<Result>) => Promise<Result>;
  transactionSync: <Result>(closure: () => Result) => Result;
  kv: { get: (key: string) => unknown; put: (key: string, value: unknown) => void; delete: (key: string) => boolean };
  sql: { exec: (query: string, ...bindings: unknown[]) => { one: () => { present: number }; toArray: () => unknown[] } };
  getAlarm: () => Promise<number | null>;
  setAlarm: (deadline: number | Date) => Promise<void>;
  deleteAlarm: () => Promise<void>;
};

type AsyncChatGate = () => Promise<boolean>;
type AsyncChatClaim = () => Promise<boolean | "rate_limited">;
type AfterChatPost = (delivery: "sent" | "rejected" | "ambiguous" | "not_attempted", reason: string | null) => Promise<void>;

const chatGateFrom = (args: unknown[]): AsyncChatGate | null => {
  const candidate = args[5];
  return typeof candidate === "function" ? candidate as AsyncChatGate : null;
};

const chatAllowed = async (args: unknown[]): Promise<boolean> => {
  const gate = chatGateFrom(args);
  return gate === null ? true : await gate();
};

const mockChatDelivery = async (
  args: unknown[],
  delivery: "sent" | "rejected" | "ambiguous" = "sent",
  reason: string | null = null,
  onPostAttempt?: () => void,
) => {
  if (!await chatAllowed(args)) {
    return { sent: false, reason: "stale_before_send", delivery: "not_attempted" as const, truncated: false, detail: {} };
  }
  const claimCandidate = args[6];
  const claim = typeof claimCandidate === "function" ? claimCandidate as AsyncChatClaim : null;
  if (claim !== null && await claim() !== true) {
    return { sent: false, reason: "already_attempted", delivery: "not_attempted" as const, truncated: false, detail: {} };
  }
  onPostAttempt?.();
  const afterCandidate = args[8];
  const afterPost = typeof afterCandidate === "function" ? afterCandidate as AfterChatPost : null;
  await afterPost?.(delivery, reason);
  return { sent: delivery === "sent", reason, delivery, truncated: false, detail: { status: 200 } };
};

const objectFor = (channelId: string): { object: ChannelObject; storage: StorageDouble } => {
  const values = new Map<string, unknown>();
  let alarmAt: number | null = null;
  let cooldownUntil: string | null = null;
  const storage: StorageDouble = {
    values,
    get: (key) => Promise.resolve(values.get(key)),
    put: (key, value) => { values.set(key, value); return Promise.resolve(); },
    delete: (key) => {
      if (Array.isArray(key)) {
        if (key.length > 128) throw new Error("Durable Object storage.delete accepts at most 128 keys.");
        let changed = false;
        for (const item of key) changed = values.delete(item) || changed;
        return Promise.resolve(changed);
      }
      return Promise.resolve(values.delete(key));
    },
    list: (options) => {
      let rows = [...values]
        .filter(([key]) => options?.prefix === undefined || key.startsWith(options.prefix))
        .filter(([key]) => options?.startAfter === undefined || key > options.startAfter)
        .sort(([left], [right]) => left.localeCompare(right));
      if (options?.limit !== undefined) rows = rows.slice(0, options.limit);
      return Promise.resolve(new Map(rows));
    },
    transaction: async (closure) => {
      const originalValues = new Map(values);
      const originalCooldownUntil = cooldownUntil;
      const originalAlarmAt = alarmAt;
      try {
        return await closure({
          ...storage,
          setAlarm: (deadline) => {
            alarmAt = deadline instanceof Date ? deadline.getTime() : deadline;
            return Promise.resolve();
          },
          deleteAlarm: () => { alarmAt = null; return Promise.resolve(); },
        });
      } catch (error: unknown) {
        values.clear();
        for (const [key, value] of originalValues) values.set(key, value);
        cooldownUntil = originalCooldownUntil;
        alarmAt = originalAlarmAt;
        throw error;
      }
    },
    transactionSync: (closure) => closure(),
    kv: {
      get: (key) => values.get(key),
      put: (key, value) => { values.set(key, value); },
      delete: (key) => values.delete(key),
    },
    sql: {
      exec: (query, ...bindings) => {
        if (query.startsWith("SELECT until_at FROM game_cooldowns")) {
          return {
            one: () => ({ present: 1 }),
            toArray: () => cooldownUntil === null ? [] : [{ until_at: cooldownUntil }],
          };
        }
        if (query.startsWith("INSERT INTO game_cooldowns")) cooldownUntil = String(bindings[1]);
        if (query.startsWith("DELETE FROM game_cooldowns") && cooldownUntil === bindings[1]) cooldownUntil = null;
        return { one: () => ({ present: 1 }), toArray: () => [] };
      },
    },
    getAlarm: () => Promise.resolve(alarmAt),
    setAlarm: (deadline) => { alarmAt = deadline instanceof Date ? deadline.getTime() : deadline; return Promise.resolve(); },
    deleteAlarm: () => { alarmAt = null; return Promise.resolve(); },
  };
  const state = {
    id: { name: channelId },
    storage,
    getWebSockets: () => [],
    setWebSocketAutoResponse: vi.fn(),
  } as unknown as DurableObjectState;
  const dbStatement = {
    bind: () => dbStatement,
    run: () => Promise.resolve({ success: true, meta: { changes: 0 } }),
    all: () => Promise.resolve({ results: [] }),
    first: () => Promise.resolve(null),
  };
  const object = Object.create(ChannelObject.prototype) as ChannelObject;
  const internals = object as unknown as {
    ctx: DurableObjectState;
    env: Env;
    alarmScheduleQueue: Promise<void>;
    pointRoundRecoveryInitialized: boolean;
    activeChatterSchemaReady: boolean;
    recentlyBoundOverlayTokenIds: Set<string>;
    adScheduleRefresh: null;
    adScheduleRefreshStartedAt: number;
    adScheduleRefreshGeneration: number;
    adScheduleOperationQueue: Promise<void>;
    pointsSchemaReady: boolean;
    pointsInitialized: boolean;
    pointsInitialization: Promise<void> | null;
  };
  internals.ctx = state;
  internals.env = {
    DB: { prepare: () => dbStatement, batch: () => Promise.resolve([]) } as unknown as D1Database,
    TWITCH_CLIENT_ID: "test-client",
    TWITCH_CLIENT_SECRET: "test-secret",
  } as Env;
  internals.alarmScheduleQueue = Promise.resolve();
  internals.pointRoundRecoveryInitialized = true;
  internals.activeChatterSchemaReady = true;
  internals.recentlyBoundOverlayTokenIds = new Set();
  internals.adScheduleRefresh = null;
  internals.adScheduleRefreshStartedAt = 0;
  internals.adScheduleRefreshGeneration = 0;
  internals.adScheduleOperationQueue = Promise.resolve();
  internals.pointsSchemaReady = false;
  internals.pointsInitialized = false;
  internals.pointsInitialization = null;
  return { object, storage };
};

const pendingJobs = (storage: StorageDouble): unknown[] => [...storage.values.entries()]
  .filter(([key]) => key.startsWith("clip:job:"))
  .map(([, value]) => value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const enqueue = (object: ChannelObject, triggerId = "eventsub-trigger", actorUserId: string | null = "viewer-1") =>
  object.enqueueClipJob(triggerId, actorUserId, {
    postClipLinkInChat: true,
    chatLinkTemplate: CHAT_TEMPLATE,
  }, 60);

const successfulCreate = { ok: true, status: 202, data: { data: [{ id: "clip-1", edit_url: "https://clips.twitch.tv/clip-1/edit" }] } };
const successfulConfirmation = {
  ok: true,
  status: 200,
  data: { data: [{ id: "clip-1", title: "A moment", url: "https://clips.twitch.tv/clip-1" }] },
};

const setChatAllowed = (allowed: boolean): void => {
  mocks.readChannelControls.mockResolvedValue({
    pause: { active: false },
    mute: { active: !allowed },
  });
  mocks.sendChatMessage.mockImplementation(async (...args: unknown[]) => await mockChatDelivery(args));
};

describe("durable clip jobs", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("completes create, confirmation, and post from the channel alarm", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T10:00:00.000Z"));
    const { object } = objectFor("channel-a");
    const order: string[] = [];
    mocks.readBotCredentials.mockResolvedValue({ accessToken: "bot-token" });
    mocks.helixRequest
      .mockImplementationOnce(() => { order.push("create"); return Promise.resolve(successfulCreate); })
      .mockImplementationOnce(() => { order.push("confirm"); return Promise.resolve(successfulConfirmation); });
    setChatAllowed(true);
    mocks.sendChatMessage.mockImplementation(async (...args: unknown[]) => {
      return await mockChatDelivery(args, "sent", null, () => order.push("post"));
    });

    await enqueue(object);
    await object.alarm();

    expect(order).toEqual(["create", "confirm", "post"]);
    expect(pendingJobs(storageOf(object))).toContainEqual(expect.objectContaining({ status: "complete", clipId: "clip-1" }));
    expect(mocks.writeModuleAudit.mock.calls).toHaveLength(1);
    const auditCall = mocks.writeModuleAudit.mock.calls[0] as unknown[];
    expect(auditCall[3]).toMatchObject({ moduleId: null, action: "clip.created", after: { clipId: "clip-1" } });
    expect(auditCall[5]).toEqual({ operationId: "clip-created:channel-a:eventsub-trigger", actorUserId: "viewer-1" });
  });

  it("resumes confirmation with a stored clip ID without creating another clip", async () => {
    vi.useFakeTimers();
    const { object, storage } = objectFor("channel-a");
    mocks.readBotCredentials.mockResolvedValue({ accessToken: "bot-token" });
    setChatAllowed(true);
    let clipIdWasStoredBeforePolling = false;
    mocks.helixRequest.mockImplementationOnce(() => Promise.resolve(successfulCreate))
      .mockImplementationOnce(() => {
        clipIdWasStoredBeforePolling = pendingJobs(storage).some((job) =>
          typeof job === "object" && job !== null && Reflect.get(job, "clipId") === "clip-1");
        return Promise.reject(new Error("Alarm interrupted while confirming."));
      })
      .mockImplementationOnce(() => Promise.resolve(successfulConfirmation));

    await enqueue(object);
    await object.alarm();
    const retryAt = await storage.getAlarm();
    expect(retryAt).not.toBeNull();
    vi.setSystemTime(retryAt ?? Date.now());
    await object.alarm();

    expect(clipIdWasStoredBeforePolling).toBe(true);
    expect(mocks.helixRequest.mock.calls.filter(([request]) => Reflect.get(request as object, "method") === "POST")).toHaveLength(1);
    expect(pendingJobs(storage)).toContainEqual(expect.objectContaining({ status: "complete", clipId: "clip-1" }));
  });

  it("retries a create when bot credentials fail before the POST is attempted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T10:00:00.000Z"));
    const { object, storage } = objectFor("channel-a");
    mocks.readBotCredentials.mockRejectedValueOnce(new Error("credential store unavailable"))
      .mockResolvedValue({ accessToken: "bot-token" });
    mocks.helixRequest.mockResolvedValueOnce(successfulCreate).mockResolvedValueOnce(successfulConfirmation);
    setChatAllowed(true);

    await enqueue(object, "credential-retry-trigger");
    await object.alarm();

    expect(mocks.helixRequest).not.toHaveBeenCalled();
    expect(pendingJobs(storage)).toContainEqual(expect.objectContaining({ status: "pending", attempts: 1, clipId: null }));
    vi.setSystemTime(await storage.getAlarm() ?? Date.now());
    await object.alarm();

    expect(mocks.helixRequest.mock.calls.filter(([request]) => Reflect.get(request as object, "method") === "POST")).toHaveLength(1);
    expect(pendingJobs(storage)).toContainEqual(expect.objectContaining({ status: "complete", clipId: "clip-1" }));
  });

  it("retries a definite transient 429 rejection without treating it as ambiguous", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T10:00:00.000Z"));
    const { object, storage } = objectFor("channel-a");
    mocks.readBotCredentials.mockResolvedValue({ accessToken: "bot-token" });
    mocks.helixRequest.mockResolvedValueOnce({ ok: false, status: 429, reason: "rate_limited", message: "Slow down", body: {} })
      .mockResolvedValueOnce(successfulCreate)
      .mockResolvedValueOnce(successfulConfirmation);
    setChatAllowed(true);

    await enqueue(object, "rate-limit-retry-trigger");
    await object.alarm();

    expect(mocks.helixRequest.mock.calls.filter(([request]) => Reflect.get(request as object, "method") === "POST")).toHaveLength(1);
    expect(pendingJobs(storage)).toContainEqual(expect.objectContaining({ status: "pending", attempts: 1, clipId: null }));
    vi.setSystemTime(await storage.getAlarm() ?? Date.now());
    await object.alarm();

    expect(mocks.helixRequest.mock.calls.filter(([request]) => Reflect.get(request as object, "method") === "POST")).toHaveLength(2);
    expect(pendingJobs(storage)).toContainEqual(expect.objectContaining({ status: "complete", clipId: "clip-1" }));
  });

  it("does not retry a definite permanent 401 rejection", async () => {
    vi.useFakeTimers();
    const { object, storage } = objectFor("channel-a");
    mocks.readBotCredentials.mockResolvedValue({ accessToken: "bot-token" });
    mocks.helixRequest.mockResolvedValue({ ok: false, status: 401, reason: "http_401", message: "missing scope", body: {} });

    await enqueue(object, "permanent-rejection-trigger");
    await object.alarm();

    expect(mocks.helixRequest.mock.calls.filter(([request]) => Reflect.get(request as object, "method") === "POST")).toHaveLength(1);
    const failedJob = pendingJobs(storage).find((job) => {
      if (!isRecord(job) || job.status !== "failed" || !isRecord(job.failure)) return false;
      return job.failure.reason === "clip_creation_rejected:scope_missing";
    });
    expect(failedJob).toBeDefined();
  });

  it("stops retrying definite 429 rejections at the creation attempt limit", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T10:00:00.000Z"));
    const { object, storage } = objectFor("channel-a");
    mocks.readBotCredentials.mockResolvedValue({ accessToken: "bot-token" });
    mocks.helixRequest.mockResolvedValue({ ok: false, status: 429, reason: "rate_limited", message: "Slow down", body: {} });

    await enqueue(object, "bounded-rejection-trigger");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await object.alarm();
      if (attempt < 2) vi.setSystemTime(await storage.getAlarm() ?? Date.now());
    }

    expect(mocks.helixRequest.mock.calls.filter(([request]) => Reflect.get(request as object, "method") === "POST")).toHaveLength(3);
    const failedJob = pendingJobs(storage).find((job) => {
      if (typeof job !== "object" || job === null || Reflect.get(job, "status") !== "failed") return false;
      return Reflect.get(job, "attempts") === 3;
    });
    expect(failedJob).toBeDefined();
  });

  it("records a terminal diagnostic after an uncertain create without posting again", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T10:00:00.000Z"));
    const { object, storage } = objectFor("channel-a");
    mocks.readBotCredentials.mockResolvedValue({ accessToken: "bot-token" });
    let checkpointWasPersisted = false;
    mocks.helixRequest.mockImplementation((request: unknown) => {
      if (Reflect.get(request as object, "method") === "POST") {
        checkpointWasPersisted = pendingJobs(storage).some((job) =>
          typeof job === "object" && job !== null && typeof Reflect.get(job, "createAttemptedAt") === "number");
        return Promise.resolve({ ok: false, reason: "network_error", status: null, message: "offline" });
      }
      return Promise.resolve(successfulConfirmation);
    });

    await enqueue(object, "failure-trigger");
    await object.alarm();
    await object.alarm();

    expect(checkpointWasPersisted).toBe(true);
    expect(mocks.helixRequest.mock.calls.filter(([request]) => Reflect.get(request as object, "method") === "POST")).toHaveLength(1);
    expect(pendingJobs(storageOf(object))).toContainEqual(expect.objectContaining({ status: "failed", attempts: 1 }));
    expect(mocks.writeModuleDiagnostics).toHaveBeenCalledWith(
      expect.anything(),
      "channel-a",
      "clips",
      "failure-trigger",
      "viewer-1",
      [expect.objectContaining({ code: "host.clip.failed" })],
      expect.any(String),
    );
  });

  it("fails safely when recovering a create checkpoint with no saved clip ID", async () => {
    vi.useFakeTimers();
    const { object, storage } = objectFor("channel-a");
    await enqueue(object, "crash-after-create-trigger");
    const job = pendingJobs(storage)[0];
    expect(job).toBeDefined();
    await storage.put("clip:job:crash-after-create-trigger", {
      ...(job as Record<string, unknown>),
      createAttemptedAt: Date.now(),
    });

    await object.alarm();

    expect(mocks.helixRequest).not.toHaveBeenCalled();
    expect(pendingJobs(storage)).toContainEqual(expect.objectContaining({ status: "failed", clipId: null }));
    expect(mocks.writeModuleDiagnostics).toHaveBeenCalledWith(
      expect.anything(),
      "channel-a",
      "clips",
      "crash-after-create-trigger",
      "viewer-1",
      [expect.objectContaining({ code: "host.clip.failed" })],
      expect.any(String),
    );
  });

  it.each(["mute", "pause"] as const)("skips the configured post when the channel is %s at post time", async (control) => {
    vi.useFakeTimers();
    const { object } = objectFor("channel-a");
    mocks.readBotCredentials.mockResolvedValue({ accessToken: "bot-token" });
    mocks.helixRequest.mockResolvedValueOnce(successfulCreate).mockResolvedValueOnce(successfulConfirmation);
    const posted: string[] = [];
    mocks.readChannelControls.mockResolvedValue({
      pause: { active: control === "pause" },
      mute: { active: control === "mute" },
    });
    mocks.sendChatMessage.mockImplementation(async (...args: unknown[]) => {
      return await mockChatDelivery(args, "sent", null, () => posted.push(String(args[2])));
    });

    await enqueue(object);
    await object.alarm();

    expect(posted).toEqual([]);
    expect(pendingJobs(storageOf(object))).toContainEqual(expect.objectContaining({ status: "complete", clipId: "clip-1" }));
  });

  it("does not repeat an ambiguous chat post when a later alarm resumes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T10:00:00.000Z"));
    const { object, storage } = objectFor("channel-a");
    mocks.readBotCredentials.mockResolvedValue({ accessToken: "bot-token" });
    mocks.helixRequest.mockResolvedValueOnce(successfulCreate).mockResolvedValueOnce(successfulConfirmation);
    setChatAllowed(true);
    let postAttempts = 0;
    mocks.sendChatMessage.mockImplementation(async (...args: unknown[]) =>
      await mockChatDelivery(args, "ambiguous", "network_error", () => { postAttempts += 1; }));

    await enqueue(object, "ambiguous-trigger");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await object.alarm();
      const nextAlarm = await storage.getAlarm();
      if (nextAlarm !== null) vi.setSystemTime(nextAlarm);
    }

    expect(postAttempts).toBe(1);
    expect(mocks.helixRequest.mock.calls.filter(([request]) => Reflect.get(request as object, "method") === "POST")).toHaveLength(1);
    expect(pendingJobs(storage)).toContainEqual(expect.objectContaining({ status: "failed", attempts: 3, clipId: "clip-1" }));
  });

  it("retries a terminal failure diagnostic without repeating Twitch work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T10:00:00.000Z"));
    const { object, storage } = objectFor("channel-a");
    mocks.readBotCredentials.mockResolvedValue({ accessToken: "bot-token" });
    mocks.helixRequest.mockResolvedValue({ ok: false, reason: "network_error", status: null, message: "offline" });
    mocks.writeModuleDiagnostics.mockRejectedValueOnce(new Error("D1 is unavailable"));

    await enqueue(object, "diagnostic-retry-trigger");
    await object.alarm();
    expect(pendingJobs(storage)).toContainEqual(expect.objectContaining({ status: "reporting_failure", attempts: 1 }));
    expect(mocks.helixRequest.mock.calls.filter(([request]) => Reflect.get(request as object, "method") === "POST")).toHaveLength(1);

    const retryAt = await storage.getAlarm();
    expect(retryAt).not.toBeNull();
    vi.setSystemTime(retryAt ?? Date.now());
    await object.alarm();

    expect(mocks.helixRequest.mock.calls.filter(([request]) => Reflect.get(request as object, "method") === "POST")).toHaveLength(1);
    expect(pendingJobs(storage)).toContainEqual(expect.objectContaining({ status: "failed", attempts: 1 }));
    expect(mocks.writeModuleDiagnostics).toHaveBeenCalledTimes(2);
  });

  it("completes a job when its persisted chat claim confirms delivery", async () => {
    vi.useFakeTimers();
    const { object, storage } = objectFor("channel-a");
    await enqueue(object, "already-sent-trigger");
    const job = pendingJobs(storage)[0];
    expect(job).toBeDefined();
    await storage.put("clip:job:already-sent-trigger", {
      ...(job as Record<string, unknown>),
      clipId: "clip-1",
      confirmedClip: { created: true, reason: null, detail: {}, clipId: "clip-1", editUrl: null, title: "A moment", url: "https://clips.twitch.tv/clip-1" },
    });
    await storage.put("module_alarm:send_claims", {
      "clip:already-sent-trigger:chat": { status: "sent", at: Date.now() },
    });

    await object.alarm();

    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
    expect(mocks.helixRequest).not.toHaveBeenCalled();
    expect(pendingJobs(storage)).toContainEqual(expect.objectContaining({ status: "complete", clipId: "clip-1" }));
    expect(mocks.writeModuleDiagnostics).not.toHaveBeenCalledWith(
      expect.anything(), "channel-a", "clips", "already-sent-trigger", expect.anything(),
      [expect.objectContaining({ code: "host.clip.failed" })], expect.anything(),
    );
  });

  it("makes enqueue idempotent for a trigger and isolates records by channel", async () => {
    vi.useFakeTimers();
    const first = objectFor("channel-a");
    const second = objectFor("channel-b");
    mocks.readBotCredentials.mockResolvedValue({ accessToken: "bot-token" });
    const requestedChannels: string[] = [];
    mocks.helixRequest.mockImplementation((request: unknown) => {
      const method: unknown = Reflect.get(request as object, "method") as unknown;
      const query: unknown = Reflect.get(request as object, "query") as unknown;
      if (method === "POST") {
        requestedChannels.push(Reflect.get(query as object, "broadcaster_id") as string);
        return Promise.resolve(successfulCreate);
      }
      return Promise.resolve(successfulConfirmation);
    });
    setChatAllowed(true);

    await expect(enqueue(first.object, "same-trigger")).resolves.toBe("enqueued");
    await expect(enqueue(first.object, "same-trigger")).resolves.toBe("duplicate");
    await expect(enqueue(first.object, "different-trigger")).resolves.toBe("cooldown");
    await expect(enqueue(second.object, "same-trigger")).resolves.toBe("enqueued");

    expect(pendingJobs(first.storage)).toHaveLength(1);
    expect(pendingJobs(first.storage)).toContainEqual(expect.objectContaining({ channelId: "channel-a", triggerId: "same-trigger" }));
    expect(pendingJobs(second.storage)).toHaveLength(1);
    expect(pendingJobs(second.storage)).toContainEqual(expect.objectContaining({ channelId: "channel-b", triggerId: "same-trigger" }));

    await first.object.alarm();
    await second.object.alarm();
    expect(requestedChannels).toEqual(["channel-a", "channel-b"]);
  });

  it("rolls back cooldown when writing the job and alarm transaction fails", async () => {
    vi.useFakeTimers();
    const { object, storage } = objectFor("channel-a");
    const originalPut = storage.put.bind(storage);
    const originalTransactionSync = storage.transactionSync.bind(storage);
    let interruptedAfterAlarmWrite = false;
    storage.put = async (key, value) => {
      if (key === "channel:alarm_schedule") {
        interruptedAfterAlarmWrite = true;
        throw new Error("simulated alarm-table write failure");
      }
      await originalPut(key, value);
    };
    storage.transactionSync = (closure) => {
      if (interruptedAfterAlarmWrite) throw new Error("simulated reset before separate cooldown release");
      return originalTransactionSync(closure);
    };

    await expect(enqueue(object, "atomic-failure-trigger")).rejects.toThrow();

    interruptedAfterAlarmWrite = false;
    storage.put = originalPut;
    storage.transactionSync = originalTransactionSync;
    expect(pendingJobs(storage)).toHaveLength(0);
    await expect(object.getPointCooldownRemaining("clips", "clip", Date.now())).resolves.toBe(0);
  });

  it("prunes expired clip jobs in storage delete batches of at most 128", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T10:00:00.000Z"));
    const { object, storage } = objectFor("channel-a");
    const expiredAt = Date.now() - 7 * 24 * 60 * 60_000 - 1;
    for (let index = 0; index < 129; index += 1) {
      const triggerId = `expired-${String(index)}`;
      await storage.put(`clip:job:${triggerId}`, {
        version: 1,
        channelId: "channel-a",
        triggerId,
        actorUserId: null,
        settings: { postClipLinkInChat: true, chatLinkTemplate: CHAT_TEMPLATE },
        createdAt: new Date(expiredAt).toISOString(),
        attempts: 0,
        nextAttemptAt: expiredAt,
        status: "complete",
        clipId: "clip-1",
        editUrl: null,
        creationDetail: null,
        confirmedClip: null,
        failure: null,
        completedAt: expiredAt,
      });
    }
    await storage.put("clip:jobs_pruned_at", Date.now() - 60 * 60_000);

    await expect(enqueue(object, "backlog-trigger")).resolves.toBe("enqueued");

    expect(pendingJobs(storage)).toHaveLength(1);
    expect(pendingJobs(storage)).toContainEqual(expect.objectContaining({ triggerId: "backlog-trigger", status: "pending" }));
    expect([...storage.values.keys()].filter((key) => key.startsWith("clip:job:expired-"))).toHaveLength(0);
  });

  it("schedules an alarm at the next completed-job expiry and prunes from it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T10:00:00.000Z"));
    const { object, storage } = objectFor("channel-a");
    mocks.readBotCredentials.mockResolvedValue({ accessToken: "bot-token" });
    mocks.helixRequest.mockResolvedValueOnce(successfulCreate).mockResolvedValueOnce(successfulConfirmation);
    setChatAllowed(true);

    await enqueue(object, "retained-job-trigger");
    await object.alarm();

    const completedJob = pendingJobs(storage)[0] as Record<string, unknown>;
    const completedAt = completedJob.completedAt as number;
    const cleanupAlarmAt = await storage.getAlarm();
    expect(cleanupAlarmAt).toBe(completedAt + 7 * 24 * 60 * 60_000);

    vi.setSystemTime(cleanupAlarmAt ?? Date.now());
    await object.alarm();

    expect(pendingJobs(storage)).toHaveLength(0);
    expect(await storage.getAlarm()).toBeNull();
  });
});

const storageOf = (object: ChannelObject): StorageDouble =>
  (object as unknown as { ctx: { storage: StorageDouble } }).ctx.storage;
