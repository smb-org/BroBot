import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getChannelModuleForChannel: vi.fn(),
  moduleBroadcasterScopeState: vi.fn(),
  getAdSchedule: vi.fn(),
  writeModuleDiagnostics: vi.fn(),
  getBotIdentity: vi.fn(),
  getAppAccessToken: vi.fn(),
}));

vi.mock("../../src/worker/db/channel-modules", () => ({ getChannelModuleForChannel: mocks.getChannelModuleForChannel }));
vi.mock("../../src/worker/module-scopes", () => ({ moduleBroadcasterScopeState: mocks.moduleBroadcasterScopeState }));
vi.mock("../../src/modules/ads/adapters/ad-schedule", () => ({ getAdSchedule: mocks.getAdSchedule }));
vi.mock("../../src/worker/event-log", () => ({ writeModuleDiagnostics: mocks.writeModuleDiagnostics }));
vi.mock("../../src/worker/db/bot-identity", () => ({ getBotIdentity: mocks.getBotIdentity }));
vi.mock("../../src/worker/app-token", () => ({ getAppAccessToken: mocks.getAppAccessToken }));

import type { AdSchedule } from "../../src/modules/ads/adapters/ad-schedule";
import { ChannelObject } from "../../src/worker/durable/ChannelObject";
import { AUTOMATED_CHAT_OUTPUT_LAST_ATTEMPT_STORAGE_KEY } from "../../src/worker/durable/automated-chat-output";

type StorageDouble = {
  values: Map<string, unknown>;
  get: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  setAlarm: ReturnType<typeof vi.fn>;
  deleteAlarm: ReturnType<typeof vi.fn>;
};

const storageOf = (object: ChannelObject): StorageDouble =>
  (object as unknown as { ctx: { storage: StorageDouble } }).ctx.storage;

/** Minimal ChannelObject double: only what scheduleAdPrewarning()/alarm() touch. */
const objectFor = (channelId: string): ChannelObject => {
  let transactionQueue = Promise.resolve();
  const values = new Map<string, unknown>();
  const storage: StorageDouble = {
    values,
    get: vi.fn((key: string) => Promise.resolve(values.get(key))),
    list: vi.fn(() => Promise.resolve(new Map())),
    setAlarm: vi.fn(),
    deleteAlarm: vi.fn(),
  };
  const state = {
    id: { name: channelId },
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets: vi.fn(() => []),
    storage: {
      ...storage,
      put: vi.fn((key: string, value: unknown) => { values.set(key, value); return Promise.resolve(); }),
      delete: vi.fn((key: string) => { values.delete(key); return Promise.resolve(true); }),
      transaction: vi.fn(async <T>(closure: (transaction: {
        get: <Value>(key: string) => Promise<Value | undefined>;
        put: (key: string, value: unknown) => Promise<void>;
        delete: (key: string) => Promise<boolean>;
      }) => Promise<T>) => {
        const predecessor = transactionQueue;
        let release!: () => void;
        transactionQueue = new Promise<void>((resolve) => { release = resolve; });
        await predecessor;
        try {
          return await closure({
            get: <Value>(key: string) => Promise.resolve(values.get(key) as Value | undefined),
            put: (key: string, value: unknown) => { values.set(key, value); return Promise.resolve(); },
            delete: (key: string) => Promise.resolve(values.delete(key)),
          });
        } finally {
          release();
        }
      }),
    },
  } as unknown as DurableObjectState;
  // A no-op D1 stub: this test never asserts on countdown-overlay caching,
  // but storeAdSchedule() unconditionally reaches for it, and a `db.prepare`
  // that's actually callable keeps that path quiet instead of logging its
  // own (caught, harmless) D1 errors on every alarm() run below.
  const prepared = {
    bind: () => prepared,
    all: () => Promise.resolve({ results: [] }),
    first: () => Promise.resolve(null),
    run: () => Promise.resolve({ success: true }),
  };
  const object = Object.create(ChannelObject.prototype) as ChannelObject;
  (object as unknown as { ctx: DurableObjectState }).ctx = state;
  (object as unknown as { env: Env }).env = { DB: { prepare: () => prepared } as unknown as D1Database } as Env;
  (object as unknown as { adScheduleRefresh: Promise<unknown> | null }).adScheduleRefresh = null;
  (object as unknown as { adScheduleRefreshStartedAt: number }).adScheduleRefreshStartedAt = 0;
  (object as unknown as { adScheduleRefreshGeneration: number }).adScheduleRefreshGeneration = 0;
  (object as unknown as { adScheduleOperationQueue: Promise<void> }).adScheduleOperationQueue = Promise.resolve();
  (object as unknown as { recentlyBoundOverlayTokenIds: Set<string> }).recentlyBoundOverlayTokenIds = new Set();
  return object;
};

describe("ad prewarning retry through ChannelObject.alarm()", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries a pre-POST failure at a short delay so the warning still lands before the ad, without a duplicate send once the first POST happened", async () => {
    vi.useFakeTimers();
    const dueAt = Date.parse("2026-09-24T12:03:00.000Z");
    vi.setSystemTime(dueAt);
    const schedule: AdSchedule = {
      nextAdAt: "2026-09-24T12:04:00.000Z", // dueAt + 60s lead
      duration: 60,
      lastAdAt: null,
      prerollFreeTime: 120,
      snoozeCount: 0,
      snoozeRefreshAt: null,
    };
    mocks.getChannelModuleForChannel.mockResolvedValue({
      channelId: "kanal-a",
      moduleId: "ads",
      enabled: true,
      revision: 1,
      settings: JSON.stringify({
        automatic: "Automatic ad message",
        manual: "Manual ad message",
        prewarning: true,
        leadSeconds: 60,
        prewarningText: "Ad in {ads.seconds}",
      }),
    });
    mocks.moduleBroadcasterScopeState.mockResolvedValue({ required: ["channel:read:ads"], missing: [] });
    mocks.getAdSchedule.mockResolvedValue({ fetched: true, reason: null, detail: {}, schedule });
    mocks.writeModuleDiagnostics.mockResolvedValue([]);
    mocks.getBotIdentity.mockRejectedValueOnce(new Error("D1 temporarily unavailable"))
      .mockResolvedValue({ userId: "bot-1" });
    mocks.getAppAccessToken.mockResolvedValue("app-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ is_sent: true, message_id: "message-1" }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const object = objectFor("kanal-a");
    const storage = storageOf(object);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await object.scheduleAdPrewarning(dueAt);

      // T: identity lookup fails before the POST. The claim stays free and no
      // request goes out; the occurrence is rescheduled at a short delay
      // instead of the generic 60s+ backoff.
      await object.alarm();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.getBotIdentity).toHaveBeenCalledTimes(1);
      expect(storage.values.get("channel:alarm_schedule")).toMatchObject({
        ad_prewarning: { deadline: dueAt, nextAttemptAt: dueAt + 5_000, failures: 1 },
      });
      expect(errorLog).toHaveBeenCalled();

      // T + 5s: still well inside the 60s lead (decideAdPrewarning's too_late
      // cutoff is 5s before the ad), so the retry sends the warning.
      vi.setSystemTime(dueAt + 5_000);
      await object.alarm();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(mocks.getBotIdentity).toHaveBeenCalledTimes(2);
      expect(storage.values.get("channel:alarm_schedule")).toBeUndefined();
      expect(mocks.writeModuleDiagnostics.mock.calls.at(-1)?.[5]).toMatchObject([
        { code: "ads.prewarning.announced" },
        { code: "host.chat.sent" },
      ]);

      // A stray re-trigger of the same occurrence after the first POST
      // already went out must not send a second message: the persisted send
      // claim rejects it.
      await object.scheduleAdPrewarning(dueAt);
      await object.alarm();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(mocks.writeModuleDiagnostics.mock.calls.at(-1)?.[5]).toMatchObject([
        { code: "ads.prewarning.announced" },
        { code: "host.chat.skipped", detail: { reason: "already_attempted" } },
      ]);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("retries an app-token failure during the schedule fetch at a short delay and still sends before the ad", async () => {
    vi.useFakeTimers();
    const dueAt = Date.parse("2026-09-24T12:03:00.000Z");
    vi.setSystemTime(dueAt);
    const schedule: AdSchedule = {
      nextAdAt: "2026-09-24T12:04:00.000Z", // dueAt + 60s lead
      duration: 60,
      lastAdAt: null,
      prerollFreeTime: 120,
      snoozeCount: 0,
      snoozeRefreshAt: null,
    };
    mocks.getChannelModuleForChannel.mockResolvedValue({
      channelId: "kanal-a",
      moduleId: "ads",
      enabled: true,
      revision: 1,
      settings: JSON.stringify({
        automatic: "Automatic ad message",
        manual: "Manual ad message",
        prewarning: true,
        leadSeconds: 60,
        prewarningText: "Ad in {ads.seconds}",
      }),
    });
    mocks.moduleBroadcasterScopeState.mockResolvedValue({ required: ["channel:read:ads"], missing: [] });
    // T: the app token itself is unavailable, so the schedule fetch never
    // happens; T + 5s: the token is available again and the fetch succeeds.
    mocks.getAdSchedule
      .mockResolvedValueOnce({ fetched: false, reason: "app_token_unavailable", detail: { status: null }, schedule: null })
      .mockResolvedValue({ fetched: true, reason: null, detail: {}, schedule });
    mocks.writeModuleDiagnostics.mockResolvedValue([]);
    mocks.getBotIdentity.mockResolvedValue({ userId: "bot-1" });
    mocks.getAppAccessToken.mockResolvedValue("app-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ is_sent: true, message_id: "message-1" }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const object = objectFor("kanal-a");
    const storage = storageOf(object);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await object.scheduleAdPrewarning(dueAt);

      // T: the schedule fetch fails on the app token, before any POST. The
      // occurrence is retried at a short delay instead of completing (and
      // giving up on the warning) or falling back to the generic 60s+ backoff.
      await object.alarm();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mocks.getAdSchedule).toHaveBeenCalledTimes(1);
      expect(storage.values.get("channel:alarm_schedule")).toMatchObject({
        ad_prewarning: { deadline: dueAt, nextAttemptAt: dueAt + 5_000, failures: 1 },
      });
      expect(mocks.writeModuleDiagnostics.mock.calls.at(-1)?.[5]).toMatchObject([
        { code: "ads.prewarning.schedule_error", detail: { reason: "app_token_unavailable" } },
      ]);
      expect(errorLog).toHaveBeenCalled();

      // T + 5s: still well inside the 60s lead, so the retry fetches the
      // schedule again and sends the warning.
      vi.setSystemTime(dueAt + 5_000);
      await object.alarm();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(storage.values.get("channel:alarm_schedule")).toMatchObject({
        "host:schedule_inputs_changed:event_times": { handler: "channel.module_schedule_inputs_changed" },
      });
      expect(storage.values.get("channel:alarm_schedule")).not.toHaveProperty("ad_prewarning");
      expect(mocks.writeModuleDiagnostics.mock.calls.at(-1)?.[5]).toMatchObject([
        { code: "ads.prewarning.announced" },
        { code: "host.chat.sent" },
      ]);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("retries an app-token failure that never clears at +5s/+10s, then stops retrying once the ad has started", async () => {
    vi.useFakeTimers();
    const leadSeconds = 30; // settings schema minimum
    const dueAt = Date.parse("2026-09-24T12:03:00.000Z");
    const adStartsAtMs = dueAt + leadSeconds * 1_000;
    vi.setSystemTime(dueAt);
    mocks.getChannelModuleForChannel.mockResolvedValue({
      channelId: "kanal-a",
      moduleId: "ads",
      enabled: true,
      revision: 1,
      settings: JSON.stringify({
        automatic: "Automatic ad message",
        manual: "Manual ad message",
        prewarning: true,
        leadSeconds,
        prewarningText: "Ad in {ads.seconds}",
      }),
    });
    mocks.moduleBroadcasterScopeState.mockResolvedValue({ required: ["channel:read:ads"], missing: [] });
    // The app token never becomes available again -- every fetch fails the same way.
    mocks.getAdSchedule.mockResolvedValue({
      fetched: false,
      reason: "app_token_unavailable",
      detail: { status: null },
      schedule: null,
    });
    mocks.writeModuleDiagnostics.mockResolvedValue([]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const object = objectFor("kanal-a");
    const storage = storageOf(object);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      await object.scheduleAdPrewarning(dueAt);

      // T: well before the planned ad start, so the retryable failure throws
      // and gets the short retry instead of completing the occurrence.
      await object.alarm();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(storage.values.get("channel:alarm_schedule")).toMatchObject({
        ad_prewarning: { deadline: dueAt, nextAttemptAt: dueAt + 5_000, failures: 1 },
      });
      expect(errorLog).toHaveBeenCalled();

      // T + 5s: still before the ad start -- second retry, delay grows to 10s.
      vi.setSystemTime(dueAt + 5_000);
      await object.alarm();
      expect(storage.values.get("channel:alarm_schedule")).toMatchObject({
        ad_prewarning: { deadline: dueAt, nextAttemptAt: dueAt + 15_000, failures: 2 },
      });

      // Jump past the planned ad start (T + 30s): the next due alarm entry
      // (nextAttemptAt = T + 15s) is still picked up, but now
      // `Date.parse(now) < adStartsAtMs` is false, so processAdPrewarning
      // returns instead of throwing, and the occurrence completes with no
      // further retry entry.
      expect(dueAt + 40_000).toBeGreaterThan(adStartsAtMs);
      vi.setSystemTime(dueAt + 40_000);
      await object.alarm();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(storage.values.get("channel:alarm_schedule")).toBeUndefined();
      expect(mocks.writeModuleDiagnostics.mock.calls.at(-1)?.[5]).toMatchObject([
        { code: "ads.prewarning.schedule_error", detail: { reason: "app_token_unavailable" } },
      ]);
    } finally {
      errorLog.mockRestore();
    }
  });

  it("still sends when a timer/FAQ send just claimed the shared automated-output slot", async () => {
    vi.useFakeTimers();
    const timerSendAt = Date.parse("2026-09-24T12:03:00.000Z");
    const dueAt = timerSendAt + 1_000; // within the 5s shared automated-output window
    vi.setSystemTime(dueAt);
    const schedule: AdSchedule = {
      nextAdAt: "2026-09-24T12:04:00.000Z",
      duration: 60,
      lastAdAt: null,
      prerollFreeTime: 120,
      snoozeCount: 0,
      snoozeRefreshAt: null,
    };
    mocks.getChannelModuleForChannel.mockResolvedValue({
      channelId: "kanal-a",
      moduleId: "ads",
      enabled: true,
      revision: 1,
      settings: JSON.stringify({
        automatic: "Automatic ad message",
        manual: "Manual ad message",
        prewarning: true,
        leadSeconds: 60,
        prewarningText: "Ad in {ads.seconds}",
      }),
    });
    mocks.moduleBroadcasterScopeState.mockResolvedValue({ required: ["channel:read:ads"], missing: [] });
    mocks.getAdSchedule.mockResolvedValue({ fetched: true, reason: null, detail: {}, schedule });
    mocks.writeModuleDiagnostics.mockResolvedValue([]);
    mocks.getBotIdentity.mockResolvedValue({ userId: "bot-1" });
    mocks.getAppAccessToken.mockResolvedValue("app-token");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      data: [{ is_sent: true, message_id: "message-1" }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const object = objectFor("kanal-a");
    const storage = storageOf(object);
    // A timer (or FAQ) send claimed the shared automated-output slot 1s ago.
    storage.values.set(AUTOMATED_CHAT_OUTPUT_LAST_ATTEMPT_STORAGE_KEY, timerSendAt);

    await object.scheduleAdPrewarning(dueAt);
    await object.alarm();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.writeModuleDiagnostics.mock.calls.at(-1)?.[5]).toMatchObject([
      { code: "ads.prewarning.announced" },
      { code: "host.chat.sent" },
    ]);
  });

  it("keeps a sent occurrence's send claim across clear+re-arm, but still sends a genuinely new occurrence", async () => {
    vi.useFakeTimers();
    const leadSeconds = 60;
    const dueAt = Date.parse("2026-09-24T12:03:00.000Z");
    const nextAdAt = dueAt + leadSeconds * 1_000;
    vi.setSystemTime(dueAt);
    mocks.getChannelModuleForChannel.mockResolvedValue({
      channelId: "kanal-a",
      moduleId: "ads",
      enabled: true,
      revision: 1,
      settings: JSON.stringify({
        automatic: "Automatic ad message",
        manual: "Manual ad message",
        prewarning: true,
        leadSeconds,
        prewarningText: "Ad in {ads.seconds}",
      }),
    });
    mocks.moduleBroadcasterScopeState.mockResolvedValue({ required: ["channel:read:ads"], missing: [] });
    mocks.writeModuleDiagnostics.mockResolvedValue([]);
    mocks.getBotIdentity.mockResolvedValue({ userId: "bot-1" });
    mocks.getAppAccessToken.mockResolvedValue("app-token");
    // A fresh Response per call: a mocked Response's body can only be read
    // once, and this test's second occurrence sends a second real POST.
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      data: [{ is_sent: true, message_id: "message-1" }],
    }), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);

    const object = objectFor("kanal-a");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      mocks.getAdSchedule.mockResolvedValue({
        fetched: true,
        reason: null,
        detail: {},
        schedule: {
          nextAdAt: new Date(nextAdAt).toISOString(),
          duration: 60,
          lastAdAt: null,
          prerollFreeTime: 120,
          snoozeCount: 0,
          snoozeRefreshAt: null,
        } satisfies AdSchedule,
      });

      // The warning for this occurrence goes out normally.
      await object.scheduleAdPrewarning(dueAt);
      await object.alarm();
      expect(fetchMock).toHaveBeenCalledOnce();

      // Something unrelated (e.g. a schedule refresh) clears the alarm and
      // re-arms it for the exact same occurrence. Without the claim staying
      // in place, this would look like a brand new occurrence and send again.
      await object.clearAdPrewarning();
      await object.scheduleAdPrewarning(dueAt);
      await object.alarm();
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(mocks.writeModuleDiagnostics.mock.calls.at(-1)?.[5]).toMatchObject([
        { code: "ads.prewarning.announced" },
        { code: "host.chat.skipped", detail: { reason: "already_attempted" } },
      ]);

      // A genuinely later occurrence -- a different due-at ms with a matching
      // later ad -- must still be able to send.
      const laterDueAt = dueAt + 10 * 60_000;
      const laterNextAdAt = laterDueAt + leadSeconds * 1_000;
      mocks.getAdSchedule.mockResolvedValue({
        fetched: true,
        reason: null,
        detail: {},
        schedule: {
          nextAdAt: new Date(laterNextAdAt).toISOString(),
          duration: 60,
          lastAdAt: new Date(nextAdAt).toISOString(),
          prerollFreeTime: 120,
          snoozeCount: 0,
          snoozeRefreshAt: null,
        } satisfies AdSchedule,
      });
      vi.setSystemTime(laterDueAt);
      await object.scheduleAdPrewarning(laterDueAt);
      await object.alarm();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(mocks.writeModuleDiagnostics.mock.calls.at(-1)?.[5]).toMatchObject([
        { code: "ads.prewarning.announced" },
        { code: "host.chat.sent" },
      ]);
    } finally {
      errorLog.mockRestore();
    }
  });
});
