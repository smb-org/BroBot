import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ModuleAlarmContext,
  ModuleAlarmDefinition,
  ModuleAlarmIdentity,
  ModuleExternalFetchBudget,
  ResolvedModuleEventTime,
} from "../../src/modules/contract";
import { MODULES } from "../../src/modules/registry";
import {
  emptyDurableTimerState,
  makeTimerPlan,
  TIMER_ALARM_PREFIX,
  TIMER_ACTIVITY_COUNTS_KEY,
  TIMER_DURABLE_STATE_KEY,
  type DurableTimerConfig,
  type DurableTimerState,
  type TimerScheduleInputs,
} from "../../src/modules/timers/durable";
import { timerOccurrenceKey } from "../../src/modules/timers/domain";
import { ChannelObject } from "../../src/worker/durable/ChannelObject";
import { claimModuleAlarmSend, type ClaimStorage } from "../../src/worker/durable/module-alarm-send-claims";
import type { sendChatMessage } from "../../src/worker/chat";

const channelObjectFor = (stream: DurableTimerState["stream"]): {
  object: ChannelObject;
  values: Map<string, unknown>;
  mirrors: Map<string, { nextRunAt: string | null; nextRunState: string | null; sequence: number }>;
  setNextAdAt: (value: string) => void;
  setDatabaseConfig: (config: DurableTimerConfig) => void;
  deleteDatabaseConfig: (timerId: string) => void;
  failNextMirrorWrite: () => void;
  failNextAuditWrite: () => void;
  setSkipAuthorizationAllowed: (allowed: boolean) => void;
  skipAccessCheckQueries: () => readonly string[];
  pauseNextTimerModuleCheck: () => { started: Promise<void>; release: () => void };
  revokeAfterNextTimerModuleCheck: () => void;
  setTimerModuleEnabled: (enabled: boolean) => void;
  auditOperationIds: Set<string>;
  setLegacyTimerActivityBaseline: (
    timerId: string,
    count: number,
    streamId: string | null,
    nextRunStreamId?: string | null,
  ) => void;
  setTimeZone: (timeZone: string) => void;
  setTimerScheduleInputs: (timeZone: string, eventTimes: readonly ResolvedModuleEventTime[]) => void;
  setCommittedStream: (stream: DurableTimerState["stream"]) => void;
  pauseNextTimeZoneRead: () => { started: Promise<void>; release: () => void };
  pauseTimerConfigRead: () => { started: Promise<void>; release: () => void };
  pauseDispatchStateRead: (skipReads?: number) => { started: Promise<void>; release: () => void };
} => {
  const values = new Map<string, unknown>();
  const mirrors = new Map<string, { nextRunAt: string | null; nextRunState: string | null; sequence: number }>();
  let transactionQueue = Promise.resolve();
  let alarmAt: number | null = null;
  let query = "";
  let bindings: unknown[] = [];
  let nextAdAt: string | null = null;
  let mirrorWriteFailures = 0;
  let auditWriteFailures = 0;
  let skipAuthorizationAllowed = true;
  let timerModuleEnabled = true;
  const skipAccessCheckQueries: string[] = [];
  let skipModuleCheckGate: { wait: Promise<void>; markStarted: () => void } | null = null;
  let revokeAfterModuleCheck = false;
  let transactionSyncHook: (() => void) | null = null;
  const auditOperationIds = new Set<string>();
  let timeZone = "Europe/Berlin";
  let committedStream: DurableTimerState["stream"] | null = null;
  let timerConfigReadGate: { wait: Promise<void>; markStarted: () => void } | null = null;
  let timeZoneReadGate: { wait: Promise<void>; markStarted: () => void } | null = null;
  let dispatchStateReadGate: { wait: Promise<void>; markStarted: () => void; skipReads: number } | null = null;
  const databaseConfigs = new Map<string, DurableTimerConfig>();
  const legacyActivityBaselines = new Map<string, {
    count: number;
    streamId: string | null;
    nextRunStreamId: string | null;
  }>();
  const configRow = (config: DurableTimerConfig) => ({
    timer_id: config.id,
    name: config.name,
    enabled: config.enabled ? 1 : 0,
    message_text: config.messageText,
    trigger_type: config.trigger.type,
    trigger_json: JSON.stringify(config.trigger),
    chat_target: config.chatTarget ?? "source_only",
    use_channel_default_target: config.chatTarget === null ? 1 : 0,
    revision: config.revision,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });
  const get = (key: string): Promise<unknown> => Promise.resolve(values.get(key));
  const set = (key: string, value: unknown): Promise<void> => {
    values.set(key, value);
    return Promise.resolve();
  };
  const remove = (key: string | string[]): Promise<boolean | number> => {
    if (typeof key === "string") return Promise.resolve(values.delete(key));
    let removed = 0;
    for (const item of key) if (values.delete(item)) removed += 1;
    return Promise.resolve(removed);
  };
  const list = (options?: { prefix?: string; startAfter?: string; limit?: number }): Promise<Map<string, unknown>> => {
    let entries = [...values]
      .filter(([key]) => options?.prefix === undefined || key.startsWith(options.prefix))
      .filter(([key]) => options?.startAfter === undefined || key > options.startAfter)
      .sort(([left], [right]) => left.localeCompare(right));
    if (options?.limit !== undefined) entries = entries.slice(0, options.limit);
    return Promise.resolve(new Map(entries));
  };
  const transaction = async <Result>(closure: (storage: {
    get: typeof get;
    put: typeof set;
    delete: typeof remove;
    list: typeof list;
    setAlarm: (deadline: number | Date) => Promise<void>;
    deleteAlarm: () => Promise<void>;
  }) => Promise<Result>): Promise<Result> => {
    const previous = transactionQueue;
    let release!: () => void;
    transactionQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await closure({
        get,
        put: set,
        delete: remove,
        list,
        setAlarm: (deadline) => {
          alarmAt = deadline instanceof Date ? deadline.getTime() : deadline;
          return Promise.resolve();
        },
        deleteAlarm: () => {
          alarmAt = null;
          return Promise.resolve();
        },
      });
    } finally {
      release();
    }
  };
  const storage = {
    get,
    put: set,
    delete: remove,
    list,
    transaction,
    transactionSync: <Result>(closure: () => Result): Result => {
      const hook = transactionSyncHook;
      transactionSyncHook = null;
      hook?.();
      return closure();
    },
    kv: {
      get: (key: string): unknown => values.get(key),
      put: (key: string, value: unknown): void => { values.set(key, value); },
      delete: (key: string): boolean => values.delete(key),
    },
    getAlarm: () => Promise.resolve(alarmAt),
    setAlarm: (deadline: number | Date) => {
      alarmAt = deadline instanceof Date ? deadline.getTime() : deadline;
      return Promise.resolve();
    },
    deleteAlarm: () => {
      alarmAt = null;
      return Promise.resolve();
    },
  };
  const state = {
    id: { name: "timer-interleaving-channel" },
    storage,
    blockConcurrencyWhile: async <Result>(closure: () => Promise<Result>) => await closure(),
    getWebSockets: () => [],
  } as unknown as DurableObjectState;
  const statement = {
    bind: (...values: unknown[]) => { bindings = values; return statement; },
    run: () => {
        if (/INSERT INTO audit_log/iu.test(query)) {
          if (auditWriteFailures > 0) {
            auditWriteFailures -= 1;
            return Promise.reject(new Error("D1 audit write interrupted."));
          }
          const operationId = bindings.at(-1);
          if (typeof operationId === "string") auditOperationIds.add(operationId);
          return Promise.resolve({ success: true, meta: { changes: 1 } });
        }
        if (mirrorWriteFailures > 0) {
          mirrorWriteFailures -= 1;
          return Promise.reject(new Error("D1 mirror write interrupted."));
        }
        const [nextRunAt, nextRunState, , sequence, , timerId] = bindings as [string | null, string | null, string | null, number, string, string];
        const current = mirrors.get(timerId);
        if (current === undefined || current.sequence < sequence) {
          mirrors.set(timerId, { nextRunAt, nextRunState, sequence });
        }
        return Promise.resolve({ success: true, meta: { changes: 1 } });
    },
    all: () => {
      if (/LEFT JOIN channel_modules/iu.test(query)) {
        const resultRows = [{
          module_id: "timers",
          enabled: 1,
          settings: "{}",
          muted: 0,
          muted_until: null,
          mute_until_stream_end: 0,
          mute_stream_started_at: null,
          mute_stream_id: null,
          paused: 0,
          paused_until: null,
          pause_until_stream_end: 0,
          pause_stream_started_at: null,
          pause_stream_id: null,
          stream_state: "online",
          stream_started_at: stateOf(values).stream.startedAt,
          stream_id: stateOf(values).stream.streamId,
        }];
        const gate = dispatchStateReadGate;
        if (gate === null) return Promise.resolve({ results: resultRows });
        if (gate.skipReads > 0) {
          gate.skipReads -= 1;
          return Promise.resolve({ results: resultRows });
        }
        dispatchStateReadGate = null;
        gate.markStarted();
        return gate.wait.then(() => ({ results: resultRows }));
      }
      const resultRows = [...databaseConfigs.values()].map((config) => ({
        ...configRow(config),
        last_chat_activity_count: legacyActivityBaselines.get(config.id)?.count ?? null,
        chat_baseline_stream_id: legacyActivityBaselines.get(config.id)?.streamId ?? null,
        next_run_stream_id: legacyActivityBaselines.get(config.id)?.nextRunStreamId ?? null,
      }));
      const gate = timerConfigReadGate;
      if (gate === null || !/FROM timers/iu.test(query)) return Promise.resolve({ results: resultRows });
      gate.markStarted();
      return gate.wait.then(() => ({ results: resultRows }));
    },
    first: () => {
      if (/SELECT 1 AS skip_authorized FROM channels/iu.test(query)) {
        skipAccessCheckQueries.push(query);
        return Promise.resolve(skipAuthorizationAllowed ? { skip_authorized: 1 } : null);
      }
      if (/channel_modules/iu.test(query) && /timers_module_enabled/iu.test(query)) {
        skipAccessCheckQueries.push(query);
        const readModuleState = () => {
          if (/FROM channels/iu.test(query) && !skipAuthorizationAllowed) return null;
          if (revokeAfterModuleCheck) {
            revokeAfterModuleCheck = false;
            transactionSyncHook = () => { skipAuthorizationAllowed = false; };
          }
          return { timers_module_enabled: timerModuleEnabled ? 1 : 0 };
        };
        const gate = skipModuleCheckGate;
        if (gate === null) return Promise.resolve(readModuleState());
        skipModuleCheckGate = null;
        gate.markStarted();
        return gate.wait.then(readModuleState);
      }
      if (/FROM channel_stream_state/iu.test(query)) {
        const stream = committedStream ?? stateOf(values).stream;
        return Promise.resolve({
          state: stream.state,
          stream_id: stream.streamId,
          started_at: stream.startedAt,
          transition_generation: stream.generation,
        });
      }
      if (/FROM channels/iu.test(query)) {
        const result = { time_zone: timeZone };
        const gate = timeZoneReadGate;
        if (gate === null) return Promise.resolve(result);
        timeZoneReadGate = null;
        gate.markStarted();
        return gate.wait.then(() => result);
      }
      if (/FROM ads_countdown_state/iu.test(query)) return Promise.resolve({
        next_ad_at: nextAdAt,
        duration: 60,
        snooze_count: 0,
        snooze_refresh_at: null,
      });
      const timerId = bindings[1];
      if (typeof timerId !== "string") return Promise.resolve(null);
      if (/SELECT 1 AS timer_is_current FROM timers/iu.test(query)) {
        const current = databaseConfigs.get(timerId);
        const revision = bindings[2];
        return Promise.resolve(current?.enabled === true && current.revision === revision ? { timer_is_current: 1 } : null);
      }
      const config = databaseConfigs.get(timerId) ?? stateOf(values).timers[timerId]?.config;
      if (config === undefined) return Promise.resolve(null);
      return Promise.resolve(configRow(config));
    },
  };
  const database = {
    prepare: (sql: string) => { query = sql; return statement; },
    batch: () => Promise.resolve([]),
  } as unknown as D1Database;
  const object = Object.create(ChannelObject.prototype) as ChannelObject;
  Reflect.set(object, "ctx", state);
  Reflect.set(object, "env", { DB: database });
  Reflect.set(object, "alarmScheduleQueue", Promise.resolve());
  Reflect.set(object, "timerScheduleReconciliationQueue", Promise.resolve());
  Reflect.set(object, "timerScheduleInputGeneration", 0);
  Reflect.set(object, "timerScheduleInitialization", null);
  Reflect.set(object, "timerOccurrenceQueues", new Map());
  let scheduleInputsOverride: Pick<TimerScheduleInputs, "timeZone" | "eventTimes"> | null = null;
  const originalTimerScheduleInputs = Reflect.get(object, "timerScheduleInputs") as (
    configs: readonly DurableTimerConfig[], at: number,
  ) => Promise<TimerScheduleInputs>;
  Reflect.set(object, "timerScheduleInputs", async (configs: readonly DurableTimerConfig[], at: number) =>
    scheduleInputsOverride === null
      ? await originalTimerScheduleInputs.call(object, configs, at)
      : { now: at, ...scheduleInputsOverride });
  const schedule = emptyDurableTimerState();
  schedule.initialized = true;
  schedule.stream = stream;
  values.set(TIMER_DURABLE_STATE_KEY, schedule);
  return {
    object,
    values,
    mirrors,
    setNextAdAt: (value: string) => { nextAdAt = value; },
    setDatabaseConfig: (config: DurableTimerConfig) => { databaseConfigs.set(config.id, config); },
    deleteDatabaseConfig: (timerId: string) => { databaseConfigs.delete(timerId); },
    failNextMirrorWrite: () => { mirrorWriteFailures += 1; },
    failNextAuditWrite: () => { auditWriteFailures += 1; },
    setSkipAuthorizationAllowed: (allowed) => { skipAuthorizationAllowed = allowed; },
    skipAccessCheckQueries: () => [...skipAccessCheckQueries],
    pauseNextTimerModuleCheck: () => {
      let releaseCheck!: () => void;
      let markStarted!: () => void;
      const wait = new Promise<void>((resolve) => { releaseCheck = resolve; });
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      skipModuleCheckGate = { wait, markStarted };
      return { started, release: releaseCheck };
    },
    revokeAfterNextTimerModuleCheck: () => { revokeAfterModuleCheck = true; },
    setTimerModuleEnabled: (enabled) => { timerModuleEnabled = enabled; },
    auditOperationIds,
    setLegacyTimerActivityBaseline: (timerId, count, streamId, nextRunStreamId = streamId) => {
      legacyActivityBaselines.set(timerId, { count, streamId, nextRunStreamId });
    },
    setTimeZone: (nextTimeZone) => { timeZone = nextTimeZone; },
    setTimerScheduleInputs: (nextTimeZone, eventTimes) => {
      scheduleInputsOverride = { timeZone: nextTimeZone, eventTimes };
    },
    setCommittedStream: (stream) => { committedStream = stream; },
    pauseNextTimeZoneRead: () => {
      let releaseRead!: () => void;
      let markStarted!: () => void;
      const wait = new Promise<void>((resolve) => { releaseRead = resolve; });
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      timeZoneReadGate = { wait, markStarted };
      return { started, release: releaseRead };
    },
    pauseTimerConfigRead: () => {
      let releaseRead!: () => void;
      let markStarted!: () => void;
      const wait = new Promise<void>((resolve) => { releaseRead = resolve; });
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      timerConfigReadGate = { wait, markStarted };
      return {
        started,
        release: () => {
          timerConfigReadGate = null;
          releaseRead();
        },
      };
    },
    pauseDispatchStateRead: (skipReads = 0) => {
      let releaseRead!: () => void;
      let markStarted!: () => void;
      const wait = new Promise<void>((resolve) => { releaseRead = resolve; });
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      dispatchStateReadGate = { wait, markStarted, skipReads };
      return { started, release: releaseRead };
    },
  };
};

const timerConfig = (id: string, trigger: DurableTimerConfig["trigger"]): DurableTimerConfig => ({
  id,
  name: id,
  enabled: true,
  messageText: "Scheduled reminder",
  chatTarget: "all_chats",
  trigger,
  revision: 1,
});

const resolvedEventTime = (id: string, at: number): ResolvedModuleEventTime => ({
  id,
  label: { de: "Event", en: "Event" },
  at: new Date(at).toISOString(),
});

const stateOf = (values: Map<string, unknown>): DurableTimerState => {
  const state = values.get(TIMER_DURABLE_STATE_KEY) as DurableTimerState;
  const activityCounts = values.get(TIMER_ACTIVITY_COUNTS_KEY) as DurableTimerState["activityCounts"] | undefined;
  if (activityCounts !== undefined) state.activityCounts = activityCounts;
  return state;
};
const dueOccurrence = (values: Map<string, unknown>, timerId: string) => {
  const occurrence = stateOf(values).timers[timerId]?.plannedOccurrence;
  if (occurrence === null || occurrence === undefined) throw new Error(`Timer ${timerId} has no planned occurrence.`);
  return occurrence;
};

const alarmTableKey = "channel:alarm_schedule";
const plannedCount = (values: Map<string, unknown>): number =>
  Object.values(stateOf(values).timers).filter((entry) => entry.plannedOccurrence !== null).length;

type TimerTestChatResult = Omit<Awaited<ReturnType<ModuleAlarmContext["sendChat"]>>, "delivery"> & {
  delivery?: Awaited<ReturnType<ModuleAlarmContext["sendChat"]>>["delivery"];
};

type TimerTestChatSender = (...args: Parameters<ModuleAlarmContext["sendChat"]>) => Promise<TimerTestChatResult>;

const timerAlarmContext = (
  sendChat: TimerTestChatSender,
  renderTemplate: ModuleAlarmContext["renderTemplate"] = (text) => Promise.resolve({ text: typeof text === "string" ? text : "" }),
): ModuleAlarmContext => ({
  renderTemplate,
  sendChat: async (...args: Parameters<ModuleAlarmContext["sendChat"]>) => {
    const result = await sendChat(...args);
    const delivery = result.delivery ?? (result.sent
      ? "delivered"
      : result.reason === "rate_limited" ? "rate_limited"
        : result.reason === "network_error" || result.reason === "timeout" || result.reason === "already_attempted"
          ? "ambiguous"
          : "failed");
    return { ...result, delivery };
  },
} as unknown as ModuleAlarmContext);

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
};

const onlineStream = (streamId: string, generation: number, startedAt: number) => ({
  state: "online" as const,
  streamId,
  startedAt: new Date(startedAt).toISOString(),
  generation,
});

describe("timer scheduling interleavings through the channel Durable Object", () => {
  afterEach(() => vi.useRealTimers());

  it("imports a legacy production alarm and baselines old chat activity on first bootstrap", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(start);
    const stream = onlineStream("stream-1", 4, start - 60_000);
    const harness = channelObjectFor(stream);
    const config = timerConfig("legacy-pending", { type: "interval", live: { minutes: 10 } });
    const planned = makeTimerPlan(config, stream, null, { now: start, timeZone: "Europe/Berlin", eventTimes: [] });
    if (planned.identity === null) throw new Error("Expected a planned interval occurrence.");
    harness.setDatabaseConfig(config);
    harness.setLegacyTimerActivityBaseline(config.id, 40, stream.streamId);
    const schedule = stateOf(harness.values);
    schedule.initialized = false;
    harness.values.set(TIMER_DURABLE_STATE_KEY, schedule);
    harness.values.set("channel:chat_activity_count", 42);
    harness.values.set(alarmTableKey, {
      [`${TIMER_ALARM_PREFIX}timer:${config.id}`]: {
        deadline: planned.identity.deadline,
        handler: "module:timers:run",
        ownerRevision: config.revision,
        revision: 1,
      },
    });

    vi.setSystemTime(start + 5 * 60_000);
    await harness.object.reconcileTimerSchedules("activation");

    expect(dueOccurrence(harness.values, config.id)).toEqual({
      identity: planned.identity,
      sequence: 0,
    });
    expect(stateOf(harness.values).timers[config.id]?.activityBaselines).toEqual({ live: 40, offline: 42 });
  });

  it("does not adopt a legacy interval alarm bound to a previous stream", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(start);
    const currentStream = onlineStream("stream-2", 3, start - 60_000);
    const previousStream = onlineStream("stream-1", 1, start - 5 * 60_000);
    const harness = channelObjectFor(currentStream);
    const config = timerConfig("legacy-old-stream", { type: "interval", live: { minutes: 10 } });
    const previousPlan = makeTimerPlan(config, previousStream, null, {
      now: start,
      timeZone: "Europe/Berlin",
      eventTimes: [],
    });
    if (previousPlan.identity === null) throw new Error("Expected the previous stream plan.");
    harness.setDatabaseConfig(config);
    harness.setLegacyTimerActivityBaseline(config.id, 0, "stream-1", "stream-1");
    const schedule = stateOf(harness.values);
    schedule.initialized = false;
    harness.values.set(TIMER_DURABLE_STATE_KEY, schedule);
    harness.values.set(alarmTableKey, {
      [`${TIMER_ALARM_PREFIX}timer:${config.id}`]: {
        deadline: previousPlan.identity.deadline,
        handler: "module:timers:run",
        ownerRevision: config.revision,
        revision: 1,
      },
    });

    await harness.object.reconcileTimerSchedules("activation");

    const imported = dueOccurrence(harness.values, config.id);
    expect(imported.identity.streamId).toBe("stream-2");
    expect(imported.identity.deadline).toBe(start + 10 * 60_000);
  });

  it("keeps the old stream-qualified send key when importing an already-claimed legacy alarm", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(start);
    const stream = onlineStream("stream-1", 4, start - 60_000);
    const harness = channelObjectFor(stream);
    const config = timerConfig("legacy-claimed", { type: "interval", live: { minutes: 10 } });
    const legacyPlan = makeTimerPlan(config, stream, null, { now: start, timeZone: "Europe/Berlin", eventTimes: [] });
    if (legacyPlan.identity === null) throw new Error("Expected a legacy interval occurrence.");
    harness.setDatabaseConfig(config);
    harness.setLegacyTimerActivityBaseline(config.id, 0, stream.streamId, stream.streamId);
    const state = stateOf(harness.values);
    state.initialized = false;
    harness.values.set(TIMER_DURABLE_STATE_KEY, state);
    const occurrenceKey = timerOccurrenceKey(config.id, legacyPlan.identity.deadline);
    harness.values.set("module_alarm:send_claims", {
      [occurrenceKey]: { status: "sent", at: start },
    });
    harness.values.set(alarmTableKey, {
      [`${TIMER_ALARM_PREFIX}timer:${config.id}`]: {
        deadline: legacyPlan.identity.deadline,
        handler: "module:timers:run",
        ownerRevision: config.revision,
        revision: 1,
      },
    });
    await harness.object.reconcileTimerSchedules("activation");
    const occurrence = dueOccurrence(harness.values, config.id);
    vi.setSystemTime(occurrence.identity.deadline);
    const storage = (harness.object as unknown as { ctx: { storage: ClaimStorage } }).ctx.storage;
    const posts: string[] = [];
    const context = timerAlarmContext(async (_text, key) => {
      const claimed = await claimModuleAlarmSend(storage, key, Date.now());
      if (claimed === true) posts.push(key);
      return { sent: claimed === true, reason: claimed === true ? null : "already_attempted", retryable: false };
    });

    await harness.object.runTimerOccurrence(context, `timer:${config.id}`, occurrence.identity.deadline,
      config.revision, occurrence.identity, occurrence.sequence);

    expect(posts).toEqual([]);
  });

  describe("legacy stream_start claims are honoured after rollout", () => {
    // legacyOffsetMs: the legacy worker saw a start time this many ms later than Helix reports now.
    const run = async (withLegacyAlarm: boolean, legacyOffsetMs = 0, suffixed = false) => {
      vi.useFakeTimers();
      const start = Date.parse("2026-10-12T12:00:00.000Z");
      vi.setSystemTime(start + 2 * 60_000);
      const stream = onlineStream("stream-1", 4, start);
      const harness = channelObjectFor(stream);
      const config = timerConfig("legacy-stream-start", { type: "stream_start", minutes: 1 });
      const deadline = start + legacyOffsetMs + 60_000;
      harness.setDatabaseConfig(config);
      const state = stateOf(harness.values);
      state.initialized = false;
      harness.values.set(TIMER_DURABLE_STATE_KEY, state);
      harness.values.set("module_alarm:send_claims", {
        [timerOccurrenceKey(config.id, deadline, suffixed ? "stream-1" : undefined)]:
          { status: "sent", at: start + 61_000 },
      });
      if (withLegacyAlarm) {
        harness.values.set(alarmTableKey, {
          [`${TIMER_ALARM_PREFIX}timer:${config.id}`]: {
            deadline, handler: "module:timers:run", ownerRevision: config.revision, revision: 1,
          },
        });
      }
      await harness.object.reconcileTimerSchedules("activation");
      const storage = (harness.object as unknown as { ctx: { storage: ClaimStorage } }).ctx.storage;
      const posts: string[] = [];
      const context = timerAlarmContext(async (_text, key) => {
        const claimed = await claimModuleAlarmSend(storage, key, Date.now());
        if (claimed === true) posts.push(key);
        return { sent: claimed === true, reason: claimed === true ? null : "already_attempted", retryable: false };
      });
      // A completed legacy send plans nothing; a pending legacy alarm plans one that must dedupe.
      const due = stateOf(harness.values).timers[config.id]?.plannedOccurrence;
      if (due !== null && due !== undefined) {
        await harness.object.runTimerOccurrence(context, `timer:${config.id}`, due.identity.deadline,
          config.revision, due.identity, due.sequence);
      }
      return posts;
    };

    it("does not post again while the legacy alarm is still pending", async () => {
      expect(await run(true)).toEqual([]);
    });

    it("does not post again after the legacy send completed", async () => {
      expect(await run(false)).toEqual([]);
    });

    // An interval claim of the same stream must never suppress a stream_start announcement.
    for (const duringRollout of [true, false]) {
      it(`ignores an interval claim of the same stream (rollout=${String(duringRollout)})`, async () => {
        vi.useFakeTimers();
        const start = Date.parse("2026-10-12T12:00:00.000Z");
        vi.setSystemTime(start + 5 * 60_000);
        const harness = channelObjectFor(onlineStream("stream-1", 4, start));
        const config = timerConfig("interval-then-start", { type: "stream_start", minutes: 5 });
        harness.setDatabaseConfig(config);
        const state = stateOf(harness.values);
        state.initialized = !duringRollout;
        harness.values.set(TIMER_DURABLE_STATE_KEY, state);
        harness.values.set("module_alarm:send_claims", {
          [timerOccurrenceKey(config.id, start + 60_000, "stream-1")]: { status: "sent", at: start + 61_000 },
        });
        await harness.object.reconcileTimerSchedules("activation");
        const storage = (harness.object as unknown as { ctx: { storage: ClaimStorage } }).ctx.storage;
        const posts: string[] = [];
        const context = timerAlarmContext(async (_text, key) => {
          const claimed = await claimModuleAlarmSend(storage, key, Date.now());
          if (claimed === true) posts.push(key);
          return { sent: claimed === true, reason: null, retryable: false };
        });
        const current = duringRollout ? config : { ...config, revision: 2 };
        if (!duringRollout) {
          harness.setDatabaseConfig(current);
          await harness.object.upsertTimerConfig(current);
        }
        const due = dueOccurrence(harness.values, config.id);
        expect(due.identity.deadline).toBe(start + 5 * 60_000);
        await harness.object.runTimerOccurrence(context, `timer:${config.id}`, due.identity.deadline,
          current.revision, due.identity, due.sequence);
        expect(posts).toHaveLength(1);
      });
    }

    for (const suffixed of [false, true]) {
      for (const withAlarm of [false, true]) {
        it(`matches a legacy claim across timestamp precision (suffixed=${String(suffixed)}, alarm=${String(withAlarm)})`, async () => {
          expect(await run(withAlarm, 400, suffixed)).toEqual([]);
        });
      }
    }
  });

  it("dispatches the single-prefixed timer alarm through the channel alarm multiplexer", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(start);
    const stream = onlineStream("stream-1", 4, start - 60_000);
    const harness = channelObjectFor(stream);
    const config = timerConfig("alarm-dispatch", { type: "interval", live: { minutes: 10, minimumMessages: 1 } });
    harness.setDatabaseConfig(config);
    await harness.object.upsertTimerConfig(config);
    const before = dueOccurrence(harness.values, config.id);
    const alarmTable = harness.values.get(alarmTableKey) as Record<string, { deadline: number }>;
    expect(alarmTable[`${TIMER_ALARM_PREFIX}timer:${config.id}`]?.deadline).toBe(before.identity.deadline);

    vi.setSystemTime(before.identity.deadline);
    await harness.object.alarm();

    const after = dueOccurrence(harness.values, config.id);
    expect(after.identity.deadline).toBe(before.identity.deadline + 10 * 60_000);
    expect(after.sequence).toBeGreaterThan(before.sequence);
  });

  it("does not sweep a timer created while activation reconciliation is waiting on D1", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(now);
    const { object, values, setDatabaseConfig, pauseTimerConfigRead } = channelObjectFor(onlineStream("stream-1", 1, now));
    const config = timerConfig("created-during-sweep", { type: "interval", live: { minutes: 15 } });
    const read = pauseTimerConfigRead();
    const reconciliation = object.reconcileTimerSchedules("activation");
    await read.started;
    setDatabaseConfig(config);
    await object.upsertTimerConfig(config);
    read.release();
    await reconciliation;

    expect(dueOccurrence(values, config.id).identity.timerId).toBe(config.id);
    expect(plannedCount(values)).toBe(1);
  });

  it("serializes overlapping calendar reconciliations so the newest timezone plan wins", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-10-13T10:00:00.000Z");
    vi.setSystemTime(now);
    const harness = channelObjectFor({ state: "offline", streamId: null, startedAt: null, generation: 1 });
    const config = timerConfig("timezone-race", {
      type: "time_of_day",
      time: "14:00",
      weekdays: [],
      alsoOffline: true,
    });
    harness.setDatabaseConfig(config);
    const oldTimeZoneRead = harness.pauseNextTimeZoneRead();
    const oldReconciliation = harness.object.reconcileTimerSchedules("channel_time_zone");

    await oldTimeZoneRead.started;
    harness.setTimeZone("UTC");
    const latestReconciliation = harness.object.reconcileTimerSchedules("channel_time_zone");
    oldTimeZoneRead.release();
    await Promise.all([oldReconciliation, latestReconciliation]);

    expect(dueOccurrence(harness.values, config.id).identity.deadline)
      .toBe(Date.parse("2026-10-13T14:00:00.000Z"));
  });

  it("expires old delete tombstones while retaining recent fences", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(now);
    const { object, values } = channelObjectFor({ state: "offline", streamId: null, startedAt: null, generation: 1 });
    const state = stateOf(values);
    for (let index = 0; index < 300; index += 1) {
      state.tombstones[`deleted-${String(index)}`] = { revision: 1, deletedAt: now - 25 * 60 * 60_000 };
    }
    state.tombstones["deleted-recent"] = { revision: 3, deletedAt: now };

    await object.deleteTimerConfig("deleted-latest", 1);

    const tombstones = stateOf(values).tombstones;
    expect(Object.keys(tombstones)).toEqual(["deleted-recent", "deleted-latest"]);
    expect(tombstones["deleted-latest"]).toEqual({ revision: 2, deletedAt: now });
  });

  it("keeps a delete fence while a stale upsert is suspended across many deletes", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(now);
    const { object, values } = channelObjectFor({ state: "offline", streamId: null, startedAt: null, generation: 1 });
    const config = timerConfig("stale-upsert", { type: "interval", offline: { minutes: 10 } });
    const originalInputs = Reflect.get(object, "timerScheduleInputs") as (
      configs: readonly DurableTimerConfig[],
      at: number,
    ) => Promise<{ now: number; timeZone: string; eventTimes: readonly [] }>;
    const started = deferred();
    const resume = deferred();
    Reflect.set(object, "timerScheduleInputs", async (configs: readonly DurableTimerConfig[], at: number) => {
      started.resolve();
      await resume.promise;
      return await originalInputs.call(object, configs, at);
    });
    const staleUpsert = object.upsertTimerConfig(config);
    await started.promise;

    await object.deleteTimerConfig(config.id, config.revision);
    for (let index = 0; index < 300; index += 1) {
      await object.deleteTimerConfig(`deleted-${String(index)}`, 1);
    }
    expect(stateOf(values).tombstones[config.id]?.revision).toBe(config.revision + 1);

    resume.resolve();
    await staleUpsert;

    expect(stateOf(values).timers[config.id]).toBeUndefined();
    expect(stateOf(values).tombstones[config.id]?.revision).toBe(config.revision + 1);
  });

  it("posts a stream_start occurrence whose online transition arrives after its deadline, within grace", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(now);
    const { object, values } = channelObjectFor({ state: "offline", streamId: null, startedAt: null, generation: 0 });
    const config = timerConfig("late-stream-start", { type: "stream_start", minutes: 1 });
    await object.upsertTimerConfig(config);
    await object.transitionTimerStream(onlineStream("stream-1", 1, now - 90_000));
    const first = dueOccurrence(values, config.id);
    expect(first.identity.deadline).toBe(now);
    const posts: string[] = [];
    const context = timerAlarmContext((_text, key) => {
      posts.push(key);
      return Promise.resolve({ sent: true, reason: null, retryable: false });
    });
    await object.runTimerOccurrence(context, `timer:${config.id}`, first.identity.deadline,
      config.revision, first.identity, first.sequence);
    expect(posts).toHaveLength(1);
    expect(plannedCount(values)).toBe(0);
  });

  describe("stream_start identity is (timer, stream)", () => {
    const setup = async () => {
      vi.useFakeTimers();
      const now = Date.parse("2026-10-12T12:00:00.000Z");
      vi.setSystemTime(now);
      const harness = channelObjectFor({ state: "offline", streamId: null, startedAt: null, generation: 0 });
      const config = timerConfig("once-per-stream", { type: "stream_start", minutes: 1 });
      await harness.object.upsertTimerConfig(config);
      const posts: string[] = [];
      const context = timerAlarmContext((_text, key) => {
        posts.push(key);
        return Promise.resolve({ sent: true, reason: null, retryable: false });
      });
      const post = async () => {
        const due = dueOccurrence(harness.values, config.id);
        await harness.object.runTimerOccurrence(context, `timer:${config.id}`, due.identity.deadline,
          config.revision, due.identity, due.sequence);
      };
      const startedAt = now - 90_000;
      return { ...harness, config, posts, post, now, startedAt };
    };

    it("posts once when the same stream is re-notified with different startedAt precision", async () => {
      const { object, values, config, posts, post, startedAt } = await setup();
      await object.transitionTimerStream(onlineStream("stream-1", 1, startedAt));
      await post();
      expect(posts).toHaveLength(1);
      // EventSub-style notification: same second, different sub-second digits and a newer generation.
      await object.transitionTimerStream({
        state: "online", streamId: "stream-1", generation: 2,
        startedAt: new Date(startedAt + 400).toISOString(),
      });
      expect(plannedCount(values)).toBe(0);
      expect(stateOf(values).timers[config.id]?.completedStreamId).toBe("stream-1");
      expect(posts).toHaveLength(1);
    });

    it("does not plan a second post after a metadata-only rename", async () => {
      const { object, values, config, posts, post, startedAt } = await setup();
      await object.transitionTimerStream(onlineStream("stream-1", 1, startedAt));
      await post();
      await object.upsertTimerConfig({ ...config, name: "renamed", revision: config.revision + 1 });
      expect(plannedCount(values)).toBe(0);
      expect(posts).toHaveLength(1);
    });

    it("posts again for a new stream id", async () => {
      const { object, values, posts, post, now } = await setup();
      await object.transitionTimerStream(onlineStream("stream-1", 1, now - 90_000));
      await post();
      await object.transitionTimerStream({ state: "offline", streamId: null, startedAt: null, generation: 2 });
      await object.transitionTimerStream(onlineStream("stream-2", 3, now - 90_000));
      expect(plannedCount(values)).toBe(1);
      await post();
      expect(posts).toHaveLength(2);
      expect(posts[0]).not.toBe(posts[1]);
    });
  });

  it("skips a stream_start occurrence whose online transition arrives beyond the grace window", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(now);
    const { object, values } = channelObjectFor({ state: "offline", streamId: null, startedAt: null, generation: 0 });
    const config = timerConfig("too-late-stream-start", { type: "stream_start", minutes: 1 });
    await object.upsertTimerConfig(config);
    await object.transitionTimerStream(onlineStream("stream-1", 1, now - 12 * 60_000));
    expect(plannedCount(values)).toBe(0);
  });

  it("stale stream_start handler cannot clear a newer plan after its awaited send check", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(now);
    const { object, values, mirrors } = channelObjectFor(onlineStream("stream-1", 1, now - 59_999));
    const config = timerConfig("stale-stream-start", { type: "stream_start", minutes: 1 });
    await object.upsertTimerConfig(config);
    const first = dueOccurrence(values, config.id);
    vi.setSystemTime(first.identity.deadline);
    const sendEntered = deferred();
    const releaseSend = deferred();
    const acceptedPosts: string[] = [];
    const context = timerAlarmContext(async (_text, key, _attributions, stillValid) => {
      sendEntered.resolve();
      await releaseSend.promise;
      const valid = await (stillValid?.() ?? Promise.resolve(true));
      if (valid) acceptedPosts.push(key);
      return { sent: valid, reason: valid ? null : "stale_before_send", retryable: false };
    });
    const firing = object.runTimerOccurrence(context, `timer:${config.id}`, first.identity.deadline,
      config.revision, first.identity, first.sequence);

    await sendEntered.promise;
    await object.transitionTimerStream({ state: "offline", streamId: null, startedAt: null, generation: 2 });
    await object.transitionTimerStream(onlineStream("stream-2", 3, Date.now()));
    const current = dueOccurrence(values, config.id);
    releaseSend.resolve();
    await firing;

    expect(acceptedPosts).toEqual([]);
    expect(dueOccurrence(values, config.id)).toEqual(current);
    expect(plannedCount(values)).toBe(1);
    expect(mirrors.get(config.id)).toEqual({
      nextRunAt: new Date(current.identity.deadline).toISOString(),
      nextRunState: null,
      sequence: stateOf(values).timers[config.id]?.mirrorSequence,
    });
  });

  it.each(["disabled", "deleted"] as const)(
    "revalidates D1 before sending after a committed timer %s during rendering",
    async (change) => {
      vi.useFakeTimers();
      const now = Date.parse("2026-10-12T12:00:00.000Z");
      vi.setSystemTime(now);
      const harness = channelObjectFor(onlineStream("stream-1", 1, now - 60_000));
      const { object, values } = harness;
      const config = timerConfig(`d1-${change}-race`, { type: "interval", live: { minutes: 1 } });
      harness.setDatabaseConfig(config);
      await object.upsertTimerConfig(config);
      const occurrence = dueOccurrence(values, config.id);
      vi.setSystemTime(occurrence.identity.deadline);
      const rendering = deferred();
      const resumeRender = deferred();
      const posts: string[] = [];
      const context = timerAlarmContext(async (_text, key, _attributions, stillValid) => {
        const valid = await (stillValid?.() ?? Promise.resolve(true));
        if (valid) posts.push(key);
        return { sent: valid, reason: valid ? null : "stale_before_send", retryable: false };
      }, async (text) => {
        rendering.resolve();
        await resumeRender.promise;
        return { text };
      });
      const firing = object.runTimerOccurrence(context, `timer:${config.id}`, occurrence.identity.deadline,
        config.revision, occurrence.identity, occurrence.sequence);

      await rendering.promise;
      if (change === "disabled") harness.setDatabaseConfig({ ...config, enabled: false, revision: config.revision + 1 });
      else harness.deleteDatabaseConfig(config.id);
      resumeRender.resolve();
      await firing;

      expect(posts).toEqual([]);
    },
  );

  it("preserves interval activity baselines across a content-only revision", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(now);
    const harness = channelObjectFor(onlineStream("stream-1", 1, now - 60_000));
    const { object, values } = harness;
    const config = timerConfig("content-revision-baseline", {
      type: "interval", live: { minutes: 10, minimumMessages: 3 },
    });
    harness.setDatabaseConfig(config);
    await object.upsertTimerConfig(config);
    await object.recordChatActivity();

    const edited = { ...config, revision: config.revision + 1, name: "Renamed", messageText: "New text" };
    harness.setDatabaseConfig(edited);
    await object.upsertTimerConfig(edited);

    expect(stateOf(values).timers[config.id]?.activityBaselines.live).toBe(0);
  });

  it("repairs a stale D1 timer mirror during activation reconciliation", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(now);
    const harness = channelObjectFor(onlineStream("stream-1", 1, now - 60_000));
    const { object, values, mirrors } = harness;
    const config = timerConfig("activation-mirror-repair", { type: "interval", live: { minutes: 10 } });
    harness.setDatabaseConfig(config);
    harness.failNextMirrorWrite();
    await object.upsertTimerConfig(config);

    expect(mirrors.has(config.id)).toBe(false);
    await object.reconcileTimerSchedules("activation");

    const occurrence = dueOccurrence(values, config.id);
    expect(mirrors.get(config.id)).toEqual({
      nextRunAt: new Date(occurrence.identity.deadline).toISOString(),
      nextRunState: "live",
      sequence: stateOf(values).timers[config.id]?.mirrorSequence,
    });
  });

  it("rechecks the timer claim after the real dispatch-state read before claiming a chat send", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(now);
    const harness = channelObjectFor(onlineStream("stream-1", 1, now - 59_999));
    const { object, values, pauseDispatchStateRead } = harness;
    const config = timerConfig("dispatch-read-race", { type: "stream_start", minutes: 1 });
    harness.setDatabaseConfig(config);
    await object.upsertTimerConfig(config);
    const occurrence = dueOccurrence(values, config.id);
    vi.setSystemTime(occurrence.identity.deadline);
    const dispatchRead = pauseDispatchStateRead(1);
    const posts: string[] = [];
    const sendMessage: typeof sendChatMessage = async (
      _environment,
      _channelId,
      _text,
      _replyToMessageId,
      _fetcher,
      validateOutput,
      claimBeforePost,
      _attributions,
      afterPost,
    ) => {
      if (validateOutput !== undefined && !await validateOutput()) {
        return { sent: false, truncated: false, delivery: "not_attempted", reason: "stale_before_send", detail: {} };
      }
      const claim = claimBeforePost === undefined ? true : await claimBeforePost();
      if (claim !== true) {
        return {
          sent: false,
          truncated: false,
          delivery: "not_attempted",
          reason: claim === "rate_limited" ? "rate_limited" : "already_attempted",
          detail: {},
        };
      }
      posts.push("posted");
      await afterPost?.("sent", null);
      return { sent: true, truncated: false, delivery: "sent", reason: null, detail: {} };
    };
    const timerModule = MODULES.find((module) => module.id === "timers");
    const alarm = timerModule?.alarms?.[0];
    if (alarm === undefined) throw new Error("The timer alarm definition is missing.");
    const moduleAlarmContext = (object as unknown as {
      moduleAlarmContext: (
        moduleId: string,
        registration: ModuleAlarmDefinition,
        externalFetchBudget: ModuleExternalFetchBudget,
        streamGeneration?: number,
        alarmIdentity?: ModuleAlarmIdentity,
        alarmPlanSequence?: number,
        sendChatImpl?: typeof sendChatMessage,
      ) => ModuleAlarmContext;
    }).moduleAlarmContext.call(object, "timers", alarm, { claim: () => true }, undefined, undefined, undefined, sendMessage);
    const context = timerAlarmContext(moduleAlarmContext.sendChat);
    const firing = object.runTimerOccurrence(context, `timer:${config.id}`, occurrence.identity.deadline,
      config.revision, occurrence.identity, occurrence.sequence);

    await dispatchRead.started;
    await object.transitionTimerStream({ state: "offline", streamId: null, startedAt: null, generation: 2 });
    await object.transitionTimerStream(onlineStream("stream-2", 3, Date.now()));
    dispatchRead.release();
    await firing;

    expect(posts).toEqual([]);
    expect(dueOccurrence(values, config.id).identity.streamId).toBe("stream-2");
  });

  it("claimed interval alarm does not restart cadence when a stale send handler resumes after generation mismatch", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(now);
    const { object, values, mirrors } = channelObjectFor(onlineStream("stream-1", 1, now - 60_000));
    const config = timerConfig("stale-interval", { type: "interval", live: { minutes: 10 } });
    await object.upsertTimerConfig(config);
    const first = dueOccurrence(values, config.id);
    vi.setSystemTime(first.identity.deadline);
    const sendEntered = deferred();
    const releaseSend = deferred();
    const acceptedPosts: string[] = [];
    const context = timerAlarmContext(async (_text, key, _attributions, stillValid) => {
      sendEntered.resolve();
      await releaseSend.promise;
      const valid = await (stillValid?.() ?? Promise.resolve(true));
      if (valid) acceptedPosts.push(key);
      return { sent: valid, reason: valid ? null : "stale_before_send", retryable: false };
    });
    const firing = object.runTimerOccurrence(context, `timer:${config.id}`, first.identity.deadline,
      config.revision, first.identity, first.sequence);

    await sendEntered.promise;
    await object.transitionTimerStream({ state: "offline", streamId: null, startedAt: null, generation: 2 });
    await object.transitionTimerStream(onlineStream("stream-2", 3, Date.now()));
    const current = dueOccurrence(values, config.id);
    releaseSend.resolve();
    await firing;

    expect(acceptedPosts).toEqual([]);
    expect(dueOccurrence(values, config.id)).toEqual(current);
    expect(current.identity.deadline).toBe(Date.now() + 10 * 60_000);
    expect(plannedCount(values)).toBe(1);
    expect(mirrors.get(config.id)).toEqual({
      nextRunAt: new Date(current.identity.deadline).toISOString(),
      nextRunState: "live",
      sequence: stateOf(values).timers[config.id]?.mirrorSequence,
    });
  });

  it.each([
    ["live interval", { type: "interval", live: { minutes: 10 } } satisfies DurableTimerConfig["trigger"], onlineStream("stream-1", 1, 0),
      { state: "offline", streamId: null, startedAt: null, generation: 2 } as const],
    ["stream_start", { type: "stream_start", minutes: 1 } satisfies DurableTimerConfig["trigger"], onlineStream("stream-1", 1, 0),
      onlineStream("stream-2", 2, 1)],
    ["live-only daily", { type: "time_of_day", time: "14:00", weekdays: [], alsoOffline: false } satisfies DurableTimerConfig["trigger"],
      onlineStream("stream-1", 1, 0), { state: "offline", streamId: null, startedAt: null, generation: 2 } as const],
  ])("refuses a %s send when D1 already committed a different stream state", async (_name, trigger, stream, committed) => {
    vi.useFakeTimers();
    const now = Date.parse("2026-10-12T11:59:00.000Z");
    vi.setSystemTime(now);
    const { object, values, setCommittedStream, setDatabaseConfig } = channelObjectFor({ ...stream, startedAt: new Date(now).toISOString() });
    const config = timerConfig("fenced", trigger);
    setDatabaseConfig(config);
    await object.upsertTimerConfig(config);
    const occurrence = dueOccurrence(values, config.id);
    vi.setSystemTime(occurrence.identity.deadline);
    const posts: string[] = [];
    let reached = false;
    await object.runTimerOccurrence(
      timerAlarmContext(async (_text, key, _attributions, stillValid) => {
        setCommittedStream(committed);
        reached = true;
        const valid = await (stillValid?.() ?? Promise.resolve(true));
        if (valid) posts.push(key);
        return { sent: valid, reason: valid ? null : "stale_before_send", retryable: false };
      }),
      `timer:${config.id}`,
      occurrence.identity.deadline,
      config.revision,
      occurrence.identity,
      occurrence.sequence,
    );
    expect(reached).toBe(true);
    expect(posts).toEqual([]);
    expect(dueOccurrence(values, config.id).identity.deadline).toBe(occurrence.identity.deadline);
  });

  it.each([
    { edit: "shorter interval", minutes: 5, expectedMinutesAfterStart: 15 },
    { edit: "longer interval", minutes: 20, expectedMinutesAfterStart: 30 },
  ])("recomputes and publishes the effective occurrence after a skip and $edit", async ({ edit, minutes, expectedMinutesAfterStart }) => {
    vi.useFakeTimers();
    const start = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(start);
    const harness = channelObjectFor({ state: "online", streamId: "stream-1", startedAt: new Date(start).toISOString(), generation: 1 });
    const config = timerConfig(`skip-cadence-${edit.replaceAll(" ", "-")}`, { type: "interval", live: { minutes: 10 } });
    await harness.object.upsertTimerConfig(config);
    const actor = { userId: "operator-user", sessionId: "operator-session" };
    const scheduler = harness.object as unknown as {
      skipNextTimerOccurrence(timerId: string, revision: number, actor: { userId: string; sessionId: string }): Promise<{ result: string }>;
    };
    await scheduler.skipNextTimerOccurrence(config.id, config.revision, actor);
    vi.setSystemTime(start + 5 * 60_000);
    const publishTimerResources = vi.fn().mockResolvedValue(undefined);
    Reflect.set(harness.object, "notifyCommittedPanelResources", publishTimerResources);

    await harness.object.upsertTimerConfig({
      ...config,
      revision: config.revision + 1,
      trigger: { type: "interval", live: { minutes } },
    });

    const entry = stateOf(harness.values).timers[config.id];
    expect(entry?.skippedOccurrence).toBeDefined();
    expect(entry?.effectiveNextOccurrence?.identity.deadline).toBe(start + expectedMinutesAfterStart * 60_000);
    expect(harness.mirrors.get(config.id)?.nextRunAt).toBe(new Date(start + expectedMinutesAfterStart * 60_000).toISOString());
    expect(publishTimerResources).toHaveBeenCalledOnce();
  });

  it("recomputes the effective occurrence when a skipped daily timer changes to a weekday schedule", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-10-12T10:00:00.000Z");
    vi.setSystemTime(start);
    const harness = channelObjectFor({ state: "online", streamId: "stream-1", startedAt: new Date(start).toISOString(), generation: 1 });
    const config = timerConfig("skip-daily-to-weekly", {
      type: "time_of_day", time: "12:10", weekdays: [], alsoOffline: false,
    });
    await harness.object.upsertTimerConfig(config);
    const actor = { userId: "operator-user", sessionId: "operator-session" };
    const scheduler = harness.object as unknown as {
      skipNextTimerOccurrence(timerId: string, revision: number, actor: { userId: string; sessionId: string }): Promise<{ result: string }>;
    };
    await scheduler.skipNextTimerOccurrence(config.id, config.revision, actor);
    vi.setSystemTime(start + 5 * 60_000);
    Reflect.set(harness.object, "notifyCommittedPanelResources", vi.fn().mockResolvedValue(undefined));

    await harness.object.upsertTimerConfig({
      ...config,
      revision: config.revision + 1,
      trigger: { type: "time_of_day", time: "12:10", weekdays: [5], alsoOffline: false },
    });

    const expectedNext = Date.parse("2026-10-16T10:10:00.000Z");
    const entry = stateOf(harness.values).timers[config.id];
    expect(entry?.skippedOccurrence).toBeDefined();
    expect(entry?.effectiveNextOccurrence?.identity.deadline).toBe(expectedNext);
    expect(harness.mirrors.get(config.id)?.nextRunAt).toBe(new Date(expectedNext).toISOString());
  });

  it("recomputes and publishes the effective occurrence when event times change around a skipped occurrence", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(start);
    const harness = channelObjectFor({ state: "offline", streamId: null, startedAt: null, generation: 1 });
    const config = timerConfig("skip-event-time-change", {
      type: "before_event", sourceId: "schedule.release", minutes: 1,
    });
    const firstEvent = resolvedEventTime("schedule.release", start + 10 * 60_000);
    const initialEvents = [firstEvent, resolvedEventTime("schedule.release", start + 20 * 60_000)];
    harness.setDatabaseConfig(config);
    harness.setTimerScheduleInputs("Europe/Berlin", initialEvents);
    await harness.object.upsertTimerConfig(config);
    const initialOccurrence = dueOccurrence(harness.values, config.id);
    expect(initialOccurrence.identity.deadline).toBe(start + 9 * 60_000);
    const actor = { userId: "operator-user", sessionId: "operator-session" };
    const scheduler = harness.object as unknown as {
      skipNextTimerOccurrence(timerId: string, revision: number, actor: { userId: string; sessionId: string }): Promise<{ result: string }>;
    };
    await scheduler.skipNextTimerOccurrence(config.id, config.revision, actor);
    const publishTimerResources = vi.fn().mockResolvedValue(undefined);
    Reflect.set(harness.object, "notifyCommittedPanelResources", publishTimerResources);

    harness.setTimerScheduleInputs("Europe/Berlin", [firstEvent,
      resolvedEventTime("schedule.release", start + 30 * 60_000)]);
    await harness.object.reconcileTimerSchedules("event_times");

    const entry = stateOf(harness.values).timers[config.id];
    expect(entry?.skippedOccurrence?.identity.deadline).toBe(initialOccurrence.identity.deadline);
    expect(entry?.effectiveNextOccurrence?.identity.deadline).toBe(start + 29 * 60_000);
    expect(harness.mirrors.get(config.id)?.nextRunAt).toBe(new Date(start + 29 * 60_000).toISOString());
    expect(publishTimerResources).toHaveBeenCalledOnce();
  });

  it("recomputes and publishes the effective occurrence when timezone-resolved events change", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(start);
    const harness = channelObjectFor({ state: "offline", streamId: null, startedAt: null, generation: 1 });
    const config = timerConfig("skip-timezone-event-change", {
      type: "before_event", sourceId: "sun.sunset", minutes: 1,
    });
    const firstEvent = resolvedEventTime("sun.sunset", start + 10 * 60_000);
    const initialEvents = [firstEvent, resolvedEventTime("sun.sunset", start + 20 * 60_000)];
    harness.setDatabaseConfig(config);
    harness.setTimerScheduleInputs("Europe/Berlin", initialEvents);
    await harness.object.upsertTimerConfig(config);
    const initialOccurrence = dueOccurrence(harness.values, config.id);
    const actor = { userId: "operator-user", sessionId: "operator-session" };
    const scheduler = harness.object as unknown as {
      skipNextTimerOccurrence(timerId: string, revision: number, actor: { userId: string; sessionId: string }): Promise<{ result: string }>;
    };
    await scheduler.skipNextTimerOccurrence(config.id, config.revision, actor);
    const publishTimerResources = vi.fn().mockResolvedValue(undefined);
    Reflect.set(harness.object, "notifyCommittedPanelResources", publishTimerResources);

    harness.setTimerScheduleInputs("UTC", [firstEvent,
      resolvedEventTime("sun.sunset", start + 35 * 60_000)]);
    await harness.object.reconcileTimerSchedules("channel_time_zone");

    const entry = stateOf(harness.values).timers[config.id];
    expect(entry?.skippedOccurrence?.identity.deadline).toBe(initialOccurrence.identity.deadline);
    expect(entry?.effectiveNextOccurrence?.identity.deadline).toBe(start + 34 * 60_000);
    expect(harness.mirrors.get(config.id)?.nextRunAt).toBe(new Date(start + 34 * 60_000).toISOString());
    expect(publishTimerResources).toHaveBeenCalledOnce();
  });

  it("does not lose time_of_day or before_event plans when stream state changes", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(now);
    const { object, values } = channelObjectFor(onlineStream("stream-1", 1, now - 60_000));
    const dailyConfig = timerConfig("daily-plan", {
      type: "time_of_day", time: "14:00", weekdays: [], alsoOffline: true,
    });
    await object.upsertTimerConfig(dailyConfig);
    const daily = dueOccurrence(values, dailyConfig.id);
    const eventConfig = timerConfig("event-plan", {
      type: "before_event", sourceId: "schedule.release", minutes: 10,
    });
    const eventOccurrence = {
      identity: {
        timerId: eventConfig.id,
        revision: eventConfig.revision,
        triggerType: "before_event",
        state: null,
        streamId: null,
        generation: null,
        deadline: now + 60 * 60_000,
      },
      sequence: 1,
    };
    const state = stateOf(values);
    state.timers[eventConfig.id] = {
      config: eventConfig,
      plannedOccurrence: eventOccurrence,
      inFlightClaim: null,
      planSequence: 1,
      mirrorSequence: 1,
      activityBaselines: { ...state.activityCounts },
      lastRunAt: null,
      refreshAt: null,
    };

    await object.transitionTimerStream({ state: "offline", streamId: null, startedAt: null, generation: 2 });

    expect(dueOccurrence(values, dailyConfig.id)).toEqual(daily);
    expect(dueOccurrence(values, eventConfig.id)).toEqual(eventOccurrence);
    expect(plannedCount(values)).toBe(2);
  });

  it("does not post an interval until activity reaches its matching stream-state threshold", async () => {
    vi.useFakeTimers();
    const now = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(now);
    const { object, values } = channelObjectFor({ state: "offline", streamId: null, startedAt: null, generation: 1 });
    await object.recordChatActivity();
    const config = timerConfig("live-threshold", {
      type: "interval", live: { minutes: 1, minimumMessages: 1 },
    });
    await object.upsertTimerConfig(config);
    await object.transitionTimerStream(onlineStream("stream-1", 2, now));
    const occurrence = dueOccurrence(values, config.id);
    vi.setSystemTime(occurrence.identity.deadline);
    const sends: string[] = [];
    const context = timerAlarmContext((_text, key) => {
      sends.push(key);
      return Promise.resolve({ sent: true, reason: null, retryable: false });
    });

    await object.runTimerOccurrence(context, `timer:${config.id}`, occurrence.identity.deadline,
      config.revision, occurrence.identity, occurrence.sequence);

    expect(sends).toEqual([]);
    expect(stateOf(values).timers[config.id]?.lastRunAt).toBeNull();
    expect(stateOf(values).timers[config.id]?.plannedOccurrence).not.toBeNull();
  });

  it("fires due daily and before-event plans and advances the daily schedule", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-10-12T11:59:59.999Z");
    vi.setSystemTime(start);
    const dailyHarness = channelObjectFor({ state: "offline", streamId: null, startedAt: null, generation: 1 });
    const dailyConfig = timerConfig("daily-due", {
      type: "time_of_day", time: "14:00", weekdays: [], alsoOffline: true,
    });
    await dailyHarness.object.upsertTimerConfig(dailyConfig);
    const dailyOccurrence = dueOccurrence(dailyHarness.values, dailyConfig.id);
    vi.setSystemTime(dailyOccurrence.identity.deadline);
    const dailyPosts: string[] = [];
    await dailyHarness.object.runTimerOccurrence(
      timerAlarmContext((_text, key) => {
        dailyPosts.push(key);
        return Promise.resolve({ sent: true, reason: null, retryable: false });
      }),
      `timer:${dailyConfig.id}`,
      dailyOccurrence.identity.deadline,
      dailyConfig.revision,
      dailyOccurrence.identity,
      dailyOccurrence.sequence,
    );
    expect(dailyPosts).toHaveLength(1);
    expect(dueOccurrence(dailyHarness.values, dailyConfig.id).identity.deadline)
      .toBeGreaterThan(dailyOccurrence.identity.deadline);
    expect(plannedCount(dailyHarness.values)).toBe(1);

    const eventStart = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(eventStart);
    const eventHarness = channelObjectFor({ state: "unknown", streamId: null, startedAt: null, generation: 0 });
    const eventConfig = timerConfig("event-due", {
      type: "before_event", sourceId: "ads.next_ad_break", minutes: 10,
    });
    const eventAt = new Date(eventStart + 10 * 60_000 + 1).toISOString();
    eventHarness.setNextAdAt(eventAt);
    await eventHarness.object.upsertTimerConfig(eventConfig);
    const eventOccurrence = dueOccurrence(eventHarness.values, eventConfig.id);
    vi.setSystemTime(eventOccurrence.identity.deadline);
    const eventPosts: string[] = [];
    await eventHarness.object.runTimerOccurrence(
      timerAlarmContext((_text, key) => {
        eventPosts.push(key);
        return Promise.resolve({ sent: true, reason: null, retryable: false });
      }),
      `timer:${eventConfig.id}`,
      eventOccurrence.identity.deadline,
      eventConfig.revision,
      eventOccurrence.identity,
      eventOccurrence.sequence,
    );
    expect(eventPosts).toEqual([`${eventConfig.id}:${String(eventOccurrence.identity.deadline)}`]);
    expect(stateOf(eventHarness.values).timers[eventConfig.id]?.inFlightClaim).toBeNull();
    expect(plannedCount(eventHarness.values)).toBe(0);
  });

  it("marks one planned interval occurrence skipped, reports the following cadence, and never sends it", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(start);
    const harness = channelObjectFor({ state: "online", streamId: "stream-1", startedAt: new Date(start).toISOString(), generation: 1 });
    const config = timerConfig("skip-interval", { type: "interval", live: { minutes: 10 } });
    await harness.object.upsertTimerConfig(config);
    const occurrence = dueOccurrence(harness.values, config.id);
    const scheduler = harness.object as unknown as {
      skipNextTimerOccurrence(timerId: string, revision: number, actor: { userId: string; sessionId: string }): Promise<{ result: string; nextOccurrenceAt?: string | null }>;
    };
    const actor = { userId: "operator-user", sessionId: "operator-session" };

    await expect(scheduler.skipNextTimerOccurrence(config.id, config.revision, actor)).resolves.toEqual({
      result: "skipped",
      skippedOccurrenceAt: new Date(occurrence.identity.deadline).toISOString(),
      nextOccurrenceAt: new Date(start + 20 * 60_000).toISOString(),
    });
    await expect(scheduler.skipNextTimerOccurrence(config.id, config.revision, actor)).resolves.toEqual({ result: "already_skipped" });
    expect(dueOccurrence(harness.values, config.id)).toEqual(occurrence);

    vi.setSystemTime(occurrence.identity.deadline);
    const sends: string[] = [];
    await harness.object.runTimerOccurrence(
      timerAlarmContext((_text, key) => {
        sends.push(key);
        return Promise.resolve({ sent: true, reason: null, retryable: false });
      }),
      `timer:${config.id}`,
      occurrence.identity.deadline,
      config.revision,
      occurrence.identity,
      occurrence.sequence,
    );

    expect(sends).toEqual([]);
    expect(dueOccurrence(harness.values, config.id).identity.deadline).toBe(start + 20 * 60_000);
    expect(stateOf(harness.values).timers[config.id]?.skippedOccurrence ?? null).toBeNull();
  });

  it.each([
    { mode: "interval", edit: "rename" },
    { mode: "interval", edit: "message text" },
    { mode: "stream-start", edit: "rename" },
    { mode: "stream-start", edit: "message text" },
  ] as const)("keeps a skipped $mode occurrence suppressed after a $edit edit", async ({ mode, edit }) => {
    vi.useFakeTimers();
    const start = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(start);
    const harness = channelObjectFor({
      state: "online", streamId: "stream-1", startedAt: new Date(start - 30_000).toISOString(), generation: 1,
    });
    const config = timerConfig(`skip-edit-${mode}-${edit}`, mode === "interval"
      ? { type: "interval", live: { minutes: 10 } }
      : { type: "stream_start", minutes: 1 });
    await harness.object.upsertTimerConfig(config);
    const actor: { userId: string; sessionId: string } = { userId: "operator-user", sessionId: "operator-session" };
    const scheduler = harness.object as unknown as {
      skipNextTimerOccurrence(timerId: string, revision: number, actor: { userId: string; sessionId: string }): Promise<{ result: string }>;
    };
    await expect(scheduler.skipNextTimerOccurrence(config.id, config.revision, actor)).resolves.toMatchObject({ result: "skipped" });

    const edited = {
      ...config,
      ...(edit === "rename" ? { name: "Renamed reminder" } : { messageText: "Edited message" }),
      revision: config.revision + 1,
    };
    await harness.object.upsertTimerConfig(edited);
    const occurrence = dueOccurrence(harness.values, config.id);
    expect(occurrence.identity.deadline).toBe(mode === "interval" ? start + 10 * 60_000 : start + 30_000);
    expect(stateOf(harness.values).timers[config.id]?.skippedOccurrence).toBeDefined();

    vi.setSystemTime(occurrence.identity.deadline);
    const sends: string[] = [];
    await harness.object.runTimerOccurrence(
      timerAlarmContext((_text, key) => {
        sends.push(key);
        return Promise.resolve({ sent: true, reason: null, retryable: false });
      }),
      `timer:${config.id}`,
      occurrence.identity.deadline,
      edited.revision,
      occurrence.identity,
      occurrence.sequence,
    );

    expect(sends).toEqual([]);
    // A stream_start timer has no further occurrence in the same stream.
    if (mode === "interval") {
      expect(dueOccurrence(harness.values, config.id).identity.deadline).toBe(start + 20 * 60_000);
    } else {
      expect(stateOf(harness.values).timers[config.id]?.plannedOccurrence ?? null).toBeNull();
    }
  });

  it("mirrors the next effective occurrence and publishes the timer resource after a skip", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(start);
    const harness = channelObjectFor({ state: "online", streamId: "stream-1", startedAt: new Date(start).toISOString(), generation: 1 });
    const config = timerConfig("skip-mirrors-next", { type: "interval", live: { minutes: 10 } });
    await harness.object.upsertTimerConfig(config);
    const previousMirror = harness.mirrors.get(config.id);
    expect(previousMirror?.nextRunAt).toBe(new Date(start + 10 * 60_000).toISOString());
    const publishTimerResources = vi.fn().mockResolvedValue(undefined);
    Reflect.set(harness.object, "notifyCommittedPanelResources", publishTimerResources);
    const actor: { userId: string; sessionId: string } = { userId: "operator-user", sessionId: "operator-session" };
    const scheduler = harness.object as unknown as {
      skipNextTimerOccurrence(timerId: string, revision: number, actor: { userId: string; sessionId: string }): Promise<{ result: string }>;
    };

    await scheduler.skipNextTimerOccurrence(config.id, config.revision, actor);

    expect(harness.mirrors.get(config.id)).toEqual({
      nextRunAt: new Date(start + 20 * 60_000).toISOString(),
      nextRunState: "live",
      sequence: (previousMirror?.sequence ?? 0) + 1,
    });
    expect(publishTimerResources).toHaveBeenCalledOnce();
  });

  it("clears next up immediately when a skipped stream-start has no following occurrence", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(start);
    const harness = channelObjectFor({
      state: "online", streamId: "stream-1", startedAt: new Date(start - 30_000).toISOString(), generation: 1,
    });
    const config = timerConfig("skip-stream-start-mirror", { type: "stream_start", minutes: 1 });
    await harness.object.upsertTimerConfig(config);
    const publishTimerResources = vi.fn().mockResolvedValue(undefined);
    Reflect.set(harness.object, "notifyCommittedPanelResources", publishTimerResources);
    const actor = { userId: "operator-user", sessionId: "operator-session" };
    const scheduler = harness.object as unknown as {
      skipNextTimerOccurrence(timerId: string, revision: number, actor: { userId: string; sessionId: string }): Promise<{ result: string }>;
    };

    await scheduler.skipNextTimerOccurrence(config.id, config.revision, actor);

    expect(harness.mirrors.get(config.id)).toEqual({ nextRunAt: null, nextRunState: null, sequence: 2 });
    expect(publishTimerResources).toHaveBeenCalledOnce();
  });

  it("keeps a skip audit pending and retries its idempotent delivery after a D1 failure", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(start);
    const harness = channelObjectFor({ state: "online", streamId: "stream-1", startedAt: new Date(start).toISOString(), generation: 1 });
    const config = timerConfig("skip-audit-retry", { type: "interval", live: { minutes: 10 } });
    await harness.object.upsertTimerConfig(config);
    harness.failNextAuditWrite();
    harness.failNextAuditWrite();
    const actor: { userId: string; sessionId: string } = { userId: "operator-user", sessionId: "operator-session" };
    const scheduler = harness.object as unknown as {
      skipNextTimerOccurrence(timerId: string, revision: number, actor: { userId: string; sessionId: string }): Promise<{ result: string }>;
    };

    await expect(scheduler.skipNextTimerOccurrence(config.id, config.revision, actor)).resolves.toMatchObject({ result: "skipped" });
    const pending = Object.values(stateOf(harness.values).pendingSkipAudits ?? {});
    expect(pending).toHaveLength(1);
    const intent = pending[0];
    if (intent === undefined) throw new Error("The committed skip audit intent is missing.");
    expect(intent.actorUserId).toBe(actor.userId);
    expect(intent.operationId).toBeTruthy();
    expect(harness.auditOperationIds.size).toBe(0);

    await expect(scheduler.skipNextTimerOccurrence(config.id, config.revision, actor))
      .resolves.toEqual({ result: "already_skipped" });
    const retryIntent = Object.values(stateOf(harness.values).pendingSkipAudits ?? {})[0];
    expect(retryIntent?.operationId).toBe(intent.operationId);
    expect(harness.auditOperationIds.size).toBe(0);
    if (retryIntent === undefined) throw new Error("The audit retry intent disappeared.");

    const retryKey = `audit:${intent.operationId}:${String(retryIntent.retryAttempt)}`;
    const retryAt = await harness.object.getModuleAlarmDeadline("timers", retryKey);
    expect(retryAt).not.toBeNull();
    await harness.object.runTimerOccurrence(timerAlarmContext(() => Promise.resolve({ sent: true, reason: null, retryable: false })),
      retryKey, retryAt ?? start);

    expect(harness.auditOperationIds).toEqual(new Set([intent.operationId]));
    expect(Object.values(stateOf(harness.values).pendingSkipAudits ?? {})).toHaveLength(0);
  });

  it("completes a skipped stream-start occurrence once and plans the next stream normally", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(start);
    const harness = channelObjectFor({
      state: "online", streamId: "stream-1", startedAt: new Date(start - 30_000).toISOString(), generation: 1,
    });
    const config = timerConfig("skip-stream-start", { type: "stream_start", minutes: 1 });
    await harness.object.upsertTimerConfig(config);
    const occurrence = dueOccurrence(harness.values, config.id);
    const scheduler = harness.object as unknown as {
      skipNextTimerOccurrence(timerId: string, revision: number, actor: { userId: string; sessionId: string }): Promise<{ result: string; nextOccurrenceAt?: string | null }>;
    };
    const actor = { userId: "operator-user", sessionId: "operator-session" };

    await expect(scheduler.skipNextTimerOccurrence(config.id, config.revision, actor)).resolves.toEqual({
      result: "skipped",
      skippedOccurrenceAt: new Date(occurrence.identity.deadline).toISOString(),
      nextOccurrenceAt: null,
    });
    vi.setSystemTime(occurrence.identity.deadline);
    const sends: string[] = [];
    await harness.object.runTimerOccurrence(
      timerAlarmContext((_text, key) => {
        sends.push(key);
        return Promise.resolve({ sent: true, reason: null, retryable: false });
      }),
      `timer:${config.id}`,
      occurrence.identity.deadline,
      config.revision,
      occurrence.identity,
      occurrence.sequence,
    );

    expect(sends).toEqual([]);
    expect(stateOf(harness.values).timers[config.id]?.completedStreamId).toBe("stream-1");
    expect(stateOf(harness.values).timers[config.id]?.plannedOccurrence).toBeNull();

    await harness.object.transitionTimerStream({
      state: "online", streamId: "stream-2", startedAt: new Date(start + 2 * 60_000).toISOString(), generation: 2,
    });
    expect(dueOccurrence(harness.values, config.id).identity.streamId).toBe("stream-2");
  });

  it("serializes a skip behind an alarm already sending, then skips only the following occurrence", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(start);
    const harness = channelObjectFor({ state: "online", streamId: "stream-1", startedAt: new Date(start).toISOString(), generation: 1 });
    const config = timerConfig("skip-during-send", { type: "interval", live: { minutes: 10 } });
    await harness.object.upsertTimerConfig(config);
    const first = dueOccurrence(harness.values, config.id);
    vi.setSystemTime(first.identity.deadline);
    const sendEntered = deferred();
    const releaseSend = deferred();
    const sends: string[] = [];
    const firing = harness.object.runTimerOccurrence(
      timerAlarmContext(async (_text, key) => {
        sends.push(key);
        sendEntered.resolve();
        await releaseSend.promise;
        return { sent: true, reason: null, retryable: false };
      }),
      `timer:${config.id}`,
      first.identity.deadline,
      config.revision,
      first.identity,
      first.sequence,
    );
    await sendEntered.promise;

    const scheduler = harness.object as unknown as {
      skipNextTimerOccurrence(timerId: string, revision: number, actor: { userId: string; sessionId: string }): Promise<{ result: string; skippedOccurrenceAt?: string; nextOccurrenceAt?: string | null }>;
    };
    const actor = { userId: "operator-user", sessionId: "operator-session" };
    let skipSettled = false;
    const skipping = scheduler.skipNextTimerOccurrence(config.id, config.revision, actor).then((result) => {
      skipSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(skipSettled).toBe(false);

    releaseSend.resolve();
    await firing;
    await expect(skipping).resolves.toEqual({
      result: "skipped",
      skippedOccurrenceAt: new Date(start + 20 * 60_000).toISOString(),
      nextOccurrenceAt: new Date(start + 30 * 60_000).toISOString(),
    });
    const firstSendKey = timerOccurrenceKey(config.id, first.identity.deadline, "stream-1");
    expect(sends).toEqual([firstSendKey]);

    const second =dueOccurrence(harness.values, config.id);
    vi.setSystemTime(second.identity.deadline);
    await harness.object.runTimerOccurrence(
      timerAlarmContext((_text, key) => {
        sends.push(key);
        return Promise.resolve({ sent: true, reason: null, retryable: false });
      }),
      `timer:${config.id}`,
      second.identity.deadline,
      config.revision,
      second.identity,
      second.sequence,
    );

    expect(sends).toEqual([firstSendKey]);
    expect(dueOccurrence(harness.values, config.id).identity.deadline).toBe(start + 30 * 60_000);
  });

  it("rechecks the actor after a queued send and leaves the occurrence untouched when access was revoked", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(start);
    const harness = channelObjectFor({ state: "online", streamId: "stream-1", startedAt: new Date(start).toISOString(), generation: 1 });
    const config = timerConfig("skip-revoked-actor", { type: "interval", live: { minutes: 10 } });
    await harness.object.upsertTimerConfig(config);
    const occurrence = dueOccurrence(harness.values, config.id);
    vi.setSystemTime(occurrence.identity.deadline);
    const sendEntered = deferred();
    const releaseSend = deferred();
    const firing = harness.object.runTimerOccurrence(
      timerAlarmContext(async () => {
        sendEntered.resolve();
        await releaseSend.promise;
        return { sent: true, reason: null, retryable: false };
      }),
      `timer:${config.id}`,
      occurrence.identity.deadline,
      config.revision,
      occurrence.identity,
      occurrence.sequence,
    );
    await sendEntered.promise;

    const actor: { userId: string; sessionId: string } = { userId: "operator-user", sessionId: "operator-session" };
    const scheduler = harness.object as unknown as {
      skipNextTimerOccurrence(timerId: string, revision: number, actor: { userId: string; sessionId: string }): Promise<{ result: string }>;
    };
    let skipSettled = false;
    const skipping = scheduler.skipNextTimerOccurrence(config.id, config.revision, actor).then((result) => {
      skipSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(skipSettled).toBe(false);

    harness.setSkipAuthorizationAllowed(false);
    releaseSend.resolve();
    await firing;

    await expect(skipping).resolves.toEqual({ result: "denied" });
    expect(stateOf(harness.values).timers[config.id]?.skippedOccurrence ?? null).toBeNull();
    expect(Object.values(stateOf(harness.values).pendingSkipAudits ?? {})).toHaveLength(0);
  });

  it("does not commit a queued skip after the timers module is disabled", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(start);
    const harness = channelObjectFor({ state: "online", streamId: "stream-1", startedAt: new Date(start).toISOString(), generation: 1 });
    const config = timerConfig("skip-disabled-module", { type: "interval", live: { minutes: 10 } });
    await harness.object.upsertTimerConfig(config);
    const occurrence = dueOccurrence(harness.values, config.id);
    vi.setSystemTime(occurrence.identity.deadline);
    const sendEntered = deferred();
    const releaseSend = deferred();
    const firing = harness.object.runTimerOccurrence(
      timerAlarmContext(async () => {
        sendEntered.resolve();
        await releaseSend.promise;
        return { sent: true, reason: null, retryable: false };
      }),
      `timer:${config.id}`,
      occurrence.identity.deadline,
      config.revision,
      occurrence.identity,
      occurrence.sequence,
    );
    await sendEntered.promise;

    const actor = { userId: "operator-user", sessionId: "operator-session" };
    const scheduler = harness.object as unknown as {
      skipNextTimerOccurrence(timerId: string, revision: number, actor: { userId: string; sessionId: string }): Promise<{ result: string }>;
    };
    let skipSettled = false;
    const skipping = scheduler.skipNextTimerOccurrence(config.id, config.revision, actor).then((result) => {
      skipSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(skipSettled).toBe(false);
    harness.setTimerModuleEnabled(false);
    releaseSend.resolve();
    await firing;

    await expect(skipping).resolves.toEqual({ result: "nothing_planned" });
    expect(stateOf(harness.values).timers[config.id]?.skippedOccurrence ?? null).toBeNull();
    expect(Object.values(stateOf(harness.values).pendingSkipAudits ?? {})).toHaveLength(0);
  });

  it("rejects a skip when access is revoked while the final authorization check is in flight", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(start);
    const harness = channelObjectFor({ state: "online", streamId: "stream-1", startedAt: new Date(start).toISOString(), generation: 1 });
    const config = timerConfig("skip-revoked-during-final-check", { type: "interval", live: { minutes: 10 } });
    await harness.object.upsertTimerConfig(config);
    const check = harness.pauseNextTimerModuleCheck();
    const scheduler = harness.object as unknown as {
      skipNextTimerOccurrence(timerId: string, revision: number, actor: { userId: string; sessionId: string }): Promise<{ result: string }>;
    };
    const skipping = scheduler.skipNextTimerOccurrence(config.id, config.revision, {
      userId: "operator-user", sessionId: "operator-session",
    });
    await check.started;

    harness.setSkipAuthorizationAllowed(false);
    check.release();

    await expect(skipping).resolves.toEqual({ result: "denied" });
    expect(stateOf(harness.values).timers[config.id]?.skippedOccurrence ?? null).toBeNull();
    expect(Object.values(stateOf(harness.values).pendingSkipAudits ?? {})).toHaveLength(0);
  });

  it("uses one final check as the skip boundary when access is revoked afterward", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-10-12T12:00:00.000Z");
    vi.setSystemTime(start);
    const harness = channelObjectFor({ state: "online", streamId: "stream-1", startedAt: new Date(start).toISOString(), generation: 1 });
    const config = timerConfig("skip-revoked-after-final-check", { type: "interval", live: { minutes: 10 } });
    await harness.object.upsertTimerConfig(config);
    harness.revokeAfterNextTimerModuleCheck();
    const scheduler = harness.object as unknown as {
      skipNextTimerOccurrence(timerId: string, revision: number, actor: { userId: string; sessionId: string }): Promise<{ result: string }>;
    };

    await expect(scheduler.skipNextTimerOccurrence(config.id, config.revision, {
      userId: "operator-user", sessionId: "operator-session",
    })).resolves.toMatchObject({ result: "skipped" });

    const [finalCheck] = harness.skipAccessCheckQueries();
    expect(harness.skipAccessCheckQueries()).toHaveLength(1);
    expect(finalCheck).toContain("actor_session.revoked_at IS NULL");
    expect(finalCheck).toContain("actor.channel_id = ?");
    expect(finalCheck).toContain("timer_module.enabled AS timers_module_enabled");
    expect(stateOf(harness.values).timers[config.id]?.skippedOccurrence).toBeDefined();
  });

  it.each([
    {
      name: "daily",
      trigger: { type: "time_of_day", time: "14:10", weekdays: [], alsoOffline: true } satisfies DurableTimerConfig["trigger"],
      stream: { state: "offline", streamId: null, startedAt: null, generation: 1 } as const,
      now: Date.parse("2026-10-13T10:00:00.000Z"),
      expectedDeadline: Date.parse("2026-10-13T12:10:00.000Z"),
    },
    {
      name: "stream-start",
      trigger: { type: "stream_start", minutes: 10 } satisfies DurableTimerConfig["trigger"],
      stream: onlineStream("stream-1", 1, Date.parse("2026-10-13T10:00:00.000Z")),
      now: Date.parse("2026-10-13T10:00:00.000Z"),
      expectedDeadline: Date.parse("2026-10-13T10:10:00.000Z"),
    },
  ])("keeps a skipped $name occurrence suppressed after disable and re-enable", async ({
    name,
    trigger,
    stream,
    now,
    expectedDeadline,
  }) => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const harness = channelObjectFor(stream);
    const config = timerConfig(`skip-disable-enable-${name}`, trigger);
    harness.setDatabaseConfig(config);
    await harness.object.upsertTimerConfig(config);
    const scheduler = harness.object as unknown as {
      skipNextTimerOccurrence(timerId: string, revision: number, actor: { userId: string; sessionId: string }): Promise<{ result: string }>;
    };
    const actor = { userId: "operator-user", sessionId: "operator-session" };

    await expect(scheduler.skipNextTimerOccurrence(config.id, config.revision, actor))
      .resolves.toMatchObject({ result: "skipped" });
    const disabled = { ...config, enabled: false, revision: config.revision + 1 };
    harness.setDatabaseConfig(disabled);
    await harness.object.upsertTimerConfig(disabled);
    const reenabled = { ...config, revision: config.revision + 2 };
    harness.setDatabaseConfig(reenabled);
    await harness.object.upsertTimerConfig(reenabled);

    const occurrence = dueOccurrence(harness.values, config.id);
    expect(occurrence.identity.deadline).toBe(expectedDeadline);
    vi.setSystemTime(expectedDeadline);
    const sends: string[] = [];
    await harness.object.runTimerOccurrence(
      timerAlarmContext((_text, key) => {
        sends.push(key);
        return Promise.resolve({ sent: true, reason: null, retryable: false });
      }),
      `timer:${config.id}`,
      occurrence.identity.deadline,
      reenabled.revision,
      occurrence.identity,
      occurrence.sequence,
    );

    expect(sends).toEqual([]);
    expect(stateOf(harness.values).timers[config.id]?.skipReceipts).toEqual([]);
    if (trigger.type === "stream_start") {
      expect(stateOf(harness.values).timers[config.id]?.completedStreamId).toBe("stream-1");
    } else {
      expect(dueOccurrence(harness.values, config.id).identity.deadline).toBeGreaterThan(expectedDeadline);
    }
  });

  it("retries a skip with refreshed timezone inputs when reconciliation finishes during authorization", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-10-13T10:00:00.000Z");
    vi.setSystemTime(start);
    const harness = channelObjectFor({ state: "offline", streamId: null, startedAt: null, generation: 1 });
    const config = timerConfig("skip-timezone-reconciliation-race", {
      type: "time_of_day", time: "14:10", weekdays: [], alsoOffline: true,
    });
    harness.setDatabaseConfig(config);
    await harness.object.upsertTimerConfig(config);
    const authorization = harness.pauseNextTimerModuleCheck();
    const scheduler = harness.object as unknown as {
      skipNextTimerOccurrence(timerId: string, revision: number, actor: { userId: string; sessionId: string }): Promise<{
        result: string;
        skippedOccurrenceAt?: string;
        nextOccurrenceAt?: string | null;
      }>;
    };
    const skipping = scheduler.skipNextTimerOccurrence(config.id, config.revision, {
      userId: "operator-user", sessionId: "operator-session",
    });
    await authorization.started;

    harness.setTimeZone("UTC");
    await harness.object.reconcileTimerSchedules("channel_time_zone");
    const reconciledOccurrence = dueOccurrence(harness.values, config.id);
    expect(reconciledOccurrence.identity.deadline).toBe(Date.parse("2026-10-13T14:10:00.000Z"));
    authorization.release();

    await expect(skipping).resolves.toEqual({
      result: "skipped",
      skippedOccurrenceAt: "2026-10-13T14:10:00.000Z",
      nextOccurrenceAt: "2026-10-14T14:10:00.000Z",
    });
    expect(harness.skipAccessCheckQueries()).toHaveLength(2);
    expect(stateOf(harness.values).timers[config.id]?.effectiveNextOccurrence?.identity.deadline)
      .toBe(Date.parse("2026-10-14T14:10:00.000Z"));
    expect(harness.mirrors.get(config.id)?.nextRunAt).toBe("2026-10-14T14:10:00.000Z");
  });
});
