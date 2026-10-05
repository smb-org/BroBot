import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { format } from "node:util";

import type {
  ModuleAlarmContext,
  ModuleEvent,
  ModuleExecutionContext,
  ModuleExternalFetchBudget,
  ModuleSecretAccess,
} from "../../src/modules/contract";
import { belaboxModule } from "../../src/modules/belabox";
import {
  BELABOX_DEFAULT_SETTINGS,
  BELABOX_POLL_ALARM_KEY,
  BELABOX_STATS_URL_SECRET,
  type BelaboxSettings,
} from "../../src/modules/belabox/contracts";
import { getBelaboxStatus, prepareBelaboxSampleWrite } from "../../src/modules/belabox/adapters/d1";
import { currentBelaboxSample, ensureBelaboxPoll, handleBelaboxPollAlarm } from "../../src/modules/belabox/service";
import { writeModuleDiagnostics } from "../../src/worker/event-log";
import { insertChannel, jsonResponse } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "belabox-poll-channel";
const STREAM_ID = "stream-321";
const SECRET_SENTINEL = "BELABOX_ALARM_SENTINEL_321";
const STATS_URL = `http://relay.belabox.net:8080/${SECRET_SENTINEL}`;

const relayPayload = (connected: boolean, bitrateKbps = 3_200) => ({
  publishers: {
    [SECRET_SENTINEL]: {
      connected,
      bitrate: connected ? bitrateKbps : 0,
      rtt: connected ? 41 : 0,
      latency: connected ? 115 : 0,
      network: connected ? 2 : 0,
      dropped_pkts: connected ? 7 : 0,
    },
  },
});

const budget = (): ModuleExternalFetchBudget => ({ claim: vi.fn(() => true) });

const deferred = <Value>() => {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const normalizedSample = (at: string, bitrateKbps: number) => ({
  at,
  connected: true,
  bitrateKbps,
  rttMs: 41,
  latencyMs: 115,
  network: 2,
  droppedPackets: 7,
});

const secretAccess = (configured = true): ModuleSecretAccess => ({
  status: () => Promise.resolve({ configured, updatedAt: configured ? "2026-10-05T00:00:00.000Z" : null }),
  read: () => Promise.resolve(configured ? STATS_URL : null),
  readWithVersion: () => Promise.resolve(configured ? { value: STATS_URL, version: "ciphertext-version" } : null),
  prepareWrite: () => Promise.reject(new Error("not used")),
  prepareDelete: () => { throw new Error("not used"); },
});

const insertModule = async (
  database: TestD1Database,
  settings: unknown = BELABOX_DEFAULT_SETTINGS,
  enabled = true,
): Promise<void> => {
  await database.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'belabox', ?, ?)",
  ).bind(CHANNEL_ID, Number(enabled), JSON.stringify(settings)).run();
  await database.prepare(
    `INSERT INTO module_secrets
      (channel_id, module_id, name, ciphertext, key_id, revision, updated_at, updated_by)
     VALUES (?, 'belabox', ?, 'ciphertext-version', 'test', 1, ?, 'tester')`,
  ).bind(CHANNEL_ID, BELABOX_STATS_URL_SECRET, new Date().toISOString()).run();
};

const alarmContext = (
  database: TestD1Database,
  options: {
    streamState?: "online" | "offline" | "unknown";
    streamId?: string | null;
    secrets?: ModuleSecretAccess;
  } = {},
) => {
  const scheduled: Array<{ key: string; deadline: number }> = [];
  const cleared: string[] = [];
  const diagnostics: Array<{ code: string; detail?: Readonly<Record<string, unknown>> }> = [];
  let currentDeadline: number | null = null;
  const context = {
    DB: database as unknown as D1Database,
    channelId: CHANNEL_ID,
    secrets: options.secrets ?? secretAccess(),
    streamState: () => Promise.resolve(options.streamState ?? "online"),
    streamStartedAt: () => Promise.resolve({ streamId: options.streamId === undefined ? STREAM_ID : options.streamId, startedAt: null }),
    schedule: (key: string, deadline: number) => { scheduled.push({ key, deadline }); currentDeadline = deadline; return Promise.resolve(); },
    clear: (key: string) => { cleared.push(key); currentDeadline = null; return Promise.resolve(); },
    getAlarmDeadline: () => Promise.resolve(currentDeadline),
    writeDiagnostics: (triggerId: string, entries: readonly { code: string; detail?: Readonly<Record<string, unknown>> }[], now: string) => {
      diagnostics.push(...entries);
      return writeModuleDiagnostics(
        database as unknown as D1Database,
        CHANNEL_ID,
        "belabox",
        triggerId,
        null,
        entries,
        now,
      );
    },
  } as unknown as ModuleAlarmContext;
  return { context, scheduled, cleared, diagnostics };
};

describe("BELABOX polling", () => {
  let database: TestD1Database;

  beforeEach(async () => {
    database = new TestD1Database();
    await insertChannel(database, CHANNEL_ID);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-05T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    database.close();
  });

  it("keeps newer online polling when a stale offline event arrives", async () => {
    await insertModule(database);
    const handleEvent = belaboxModule.handleEvent;
    if (handleEvent === undefined) throw new Error("BELABOX event handler missing.");
    const scheduled: Array<{ handler: string; key: string; deadline: number }> = [];
    const cleared: string[] = [];
    let currentDeadline: number | null = null;
    let resolveStaleOffline!: (state: "online" | "offline" | "unknown") => void;
    const staleOfflineState = new Promise<"online" | "offline" | "unknown">((resolve) => {
      resolveStaleOffline = resolve;
    });
    const streamState = vi.fn(() => Promise.resolve<"online" | "offline" | "unknown">("online"));
    const context = {
      DB: database as unknown as D1Database,
      streamStateTransitionAccepted: true,
      streamState,
      getAlarmDeadline: () => Promise.resolve(currentDeadline),
      scheduleAlarm: (handler: string, key: string, deadline: number) => {
        scheduled.push({ handler, key, deadline });
        currentDeadline = deadline;
        return Promise.resolve();
      },
      clearAlarm: (key: string) => { cleared.push(key); currentDeadline = null; return Promise.resolve(); },
    } as unknown as ModuleExecutionContext;
    const event = (subscriptionType: "stream.online" | "stream.offline", payload: Readonly<Record<string, unknown>>): ModuleEvent<BelaboxSettings> => ({
      channelId: CHANNEL_ID,
      subscriptionType,
      triggerId: subscriptionType,
      payload,
      settings: BELABOX_DEFAULT_SETTINGS,
      receivedAt: new Date().toISOString(),
      actor: null,
      chatStatus: null,
    });

    await handleEvent(event("stream.online", { id: STREAM_ID }), context);
    expect(scheduled).toEqual([{ handler: "poll", key: "poll", deadline: Date.now() }]);
    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, polling, stream_id, belabox_stream_id, fetch_phase_json, recent_json, revision)
       VALUES (?, 1, 'newer-stream', 'newer-stream', '{}', '[["2026-10-05T12:00:00.000Z",3200,41,true]]', 1)`,
    ).bind(CHANNEL_ID).run();
    context.streamState = () => staleOfflineState;
    const staleOffline = handleEvent(event("stream.offline", {}), context);
    resolveStaleOffline("offline");
    await staleOffline;
    expect(cleared).toEqual([]);
    expect(scheduled).toEqual([
      { handler: "poll", key: "poll", deadline: Date.now() },
      { handler: "poll", key: "poll", deadline: Date.now() },
    ]);
    expect(streamState).not.toHaveBeenCalled();
    expect(await getBelaboxStatus(database as unknown as D1Database, CHANNEL_ID)).toMatchObject({
      polling: true,
      streamId: "newer-stream",
      belaboxStreamId: "newer-stream",
      recent: [{ at: "2026-10-05T12:00:00.000Z", bitrateKbps: 3_200 }],
    });
  });

  it("ensures after every lifecycle signal and leaves mode decisions to the poll alarm", async () => {
    await insertModule(database, { mode: "on_demand", intervalSeconds: 15 });
    const handleEvent = belaboxModule.handleEvent;
    const onInputsChanged = belaboxModule.alarms?.find(({ onScheduleInputsChanged }) => onScheduleInputsChanged !== undefined)
      ?.onScheduleInputsChanged;
    if (handleEvent === undefined || onInputsChanged === undefined) throw new Error("BELABOX lifecycle hooks missing.");
    let currentDeadline: number | null = null;
    const scheduleAlarm = vi.fn((_handler: string, _key: string, deadline: number) => {
      currentDeadline = deadline;
      return Promise.resolve();
    });
    await handleEvent({
      channelId: CHANNEL_ID,
      subscriptionType: "stream.online",
      triggerId: "on-demand-online",
      payload: { id: STREAM_ID },
      settings: { mode: "on_demand", intervalSeconds: 15 },
      receivedAt: new Date().toISOString(),
      actor: null,
      chatStatus: null,
    }, {
      DB: database as unknown as D1Database,
      streamStateTransitionAccepted: true,
      streamState: () => Promise.resolve("online"),
      getAlarmDeadline: () => Promise.resolve(currentDeadline),
      scheduleAlarm,
      clearAlarm: vi.fn(() => Promise.resolve()),
    } as unknown as ModuleExecutionContext);
    expect(scheduleAlarm).toHaveBeenCalledOnce();
    expect(scheduleAlarm).toHaveBeenCalledWith("poll", "poll", Date.now());

    await database.prepare(
      "UPDATE channel_modules SET settings = ? WHERE channel_id = ? AND module_id = 'belabox'",
    ).bind(JSON.stringify(BELABOX_DEFAULT_SETTINGS), CHANNEL_ID).run();
    const { context, scheduled } = alarmContext(database);
    await onInputsChanged(context, "activation");
    expect(scheduled).toEqual([{ key: "poll", deadline: Date.now() }]);
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toBeNull();
  });

  it("keeps desk streams in 60-second probe mode and switches an IRL stream after the first connected probe", async () => {
    await insertModule(database, { mode: "interval", intervalSeconds: 15 });
    const { context, scheduled } = alarmContext(database);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(relayPayload(false)))
      .mockResolvedValueOnce(jsonResponse(relayPayload(true)))
      .mockResolvedValueOnce(jsonResponse(relayPayload(true)));
    const firstDeadline = Date.now() - 5_000;

    await handleBelaboxPollAlarm(context, BELABOX_POLL_ALARM_KEY, firstDeadline, undefined, fetcher);
    expect(scheduled.at(-1)?.deadline).toBe(Date.now() + 60_000);
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      polling: true,
      streamId: STREAM_ID,
      belaboxStreamId: null,
      recent: [],
      sample: { connected: false },
    });

    vi.setSystemTime(Date.now() + 60_000);
    await handleBelaboxPollAlarm(context, BELABOX_POLL_ALARM_KEY, Date.now(), undefined, fetcher);
    expect(scheduled.at(-1)?.deadline).toBe(Date.now() + 15_000);
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      belaboxStreamId: STREAM_ID,
      recent: [],
      sample: { connected: true },
    });

    vi.setSystemTime(Date.now() + 15_000);
    await handleBelaboxPollAlarm(context, BELABOX_POLL_ALARM_KEY, Date.now(), undefined, fetcher);
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      belaboxStreamId: STREAM_ID,
      recent: [{ bitrateKbps: 3_200, connected: true }],
    });
  });

  it("uses max(now, deadline) plus the active interval for the next deadline", async () => {
    await insertModule(database, { mode: "interval", intervalSeconds: 30 });
    const { context, scheduled } = alarmContext(database);
    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, polling, stream_id, belabox_stream_id, fetch_phase_json, recent_json, revision)
       VALUES (?, 1, ?, ?, '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, STREAM_ID, STREAM_ID).run();
    const now = Date.now();
    await handleBelaboxPollAlarm(
      context,
      BELABOX_POLL_ALARM_KEY,
      now - 20_000,
      undefined,
      () => Promise.resolve(jsonResponse(relayPayload(true))),
    );
    expect(scheduled).toEqual([{ key: "poll", deadline: now + 30_000 }]);
  });

  it("lets an offline reset win while a poll fetch is in flight", async () => {
    await insertModule(database);
    let streamState: "online" | "offline" = "online";
    const { context, scheduled } = alarmContext(database);
    context.streamState = () => Promise.resolve(streamState);
    await ensureBelaboxPoll(context);
    const started = deferred<undefined>();
    const response = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>(() => {
      started.resolve(undefined);
      return response.promise;
    });

    const running = handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, fetcher);
    await started.promise;
    streamState = "offline";
    const handleEvent = belaboxModule.handleEvent;
    if (handleEvent === undefined) throw new Error("BELABOX event handler missing.");
    await handleEvent({
      channelId: CHANNEL_ID,
      subscriptionType: "stream.offline",
      triggerId: "offline-during-fetch",
      payload: {},
      settings: BELABOX_DEFAULT_SETTINGS,
      receivedAt: new Date().toISOString(),
      actor: null,
      chatStatus: null,
    }, {
      DB: database as unknown as D1Database,
      streamStateTransitionAccepted: true,
      streamState: () => Promise.resolve(streamState),
      getAlarmDeadline: context.getAlarmDeadline,
      scheduleAlarm: (_handler: string, key: string, deadline: number) => context.schedule(key, deadline),
      clearAlarm: (key: string) => context.clear(key),
    } as unknown as ModuleExecutionContext);
    response.resolve(jsonResponse(relayPayload(true)));
    await running;

    expect(scheduled).toEqual([
      { key: "poll", deadline: Date.now() },
      { key: "poll", deadline: Date.now() },
    ]);
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      polling: false,
      streamId: null,
      belaboxStreamId: null,
      sample: null,
      recent: [],
    });
  });

  it("does not let a delayed on-demand reconciliation clear interval polling", async () => {
    await insertModule(database);
    const { context, scheduled, cleared } = alarmContext(database);
    await database.prepare(
      "UPDATE channel_modules SET settings = ? WHERE channel_id = ? AND module_id = 'belabox'",
    ).bind(JSON.stringify({ mode: "on_demand", intervalSeconds: 15 }), CHANNEL_ID).run();
    let currentDeadline = Date.now() + 60_000;
    context.getAlarmDeadline = () => Promise.resolve(currentDeadline);
    context.schedule = (key: string, deadline: number) => {
      scheduled.push({ key, deadline });
      currentDeadline = deadline;
      return Promise.resolve();
    };
    await database.prepare(
      "UPDATE channel_modules SET settings = ? WHERE channel_id = ? AND module_id = 'belabox'",
    ).bind(JSON.stringify(BELABOX_DEFAULT_SETTINGS), CHANNEL_ID).run();

    const ensure = belaboxModule.alarms?.find(({ key }) => key === "ensure");
    expect(ensure).toBeDefined();
    await ensure?.handle(context, "poll", Date.now());

    expect(scheduled).toEqual([{ key: "poll", deadline: Date.now() }]);
    expect(cleared).toEqual([]);
  });

  it("throws a fixed error when rescheduling fails so the claimed poll can be retried", async () => {
    await insertModule(database);
    const { context } = alarmContext(database);
    context.schedule = () => Promise.reject(new Error(`failed ${STATS_URL}`));
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(relayPayload(true))));

    await expect(handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, fetcher))
      .rejects.toThrow("BELABOX_POLL_RESCHEDULE_FAILED");
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({ polling: true });

    context.schedule = () => Promise.resolve();
    await expect(handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, fetcher)).resolves.toBeUndefined();
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({ polling: true });
  });

  it("discards a delayed S1 fetch after the current stream changes to S2", async () => {
    await insertModule(database);
    const { context, scheduled } = alarmContext(database);
    let streamId: string | null = "stream-s1";
    context.streamStartedAt = () => Promise.resolve({ streamId, startedAt: null });
    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, polling, stream_id, belabox_stream_id, fetch_phase_json, recent_json, revision)
       VALUES (?, 1, 'stream-s1', NULL, '{}', '[]', 1)`,
    ).bind(CHANNEL_ID).run();
    const started = deferred<undefined>();
    const response = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>(() => {
      started.resolve(undefined);
      return response.promise;
    });

    const running = handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, fetcher);
    await started.promise;
    streamId = "stream-s2";
    response.resolve(jsonResponse(relayPayload(true)));
    await running;

    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      polling: true,
      streamId: "stream-s1",
      belaboxStreamId: null,
      sample: null,
    });
    expect(scheduled).toHaveLength(1);
    expect(scheduled.at(-1)?.deadline).toBe(Date.now());
  });

  it("preserves the poll flag when an on-demand sample writes status", async () => {
    await insertModule(database, { mode: "on_demand", intervalSeconds: 15 });
    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, polling, stream_id, fetch_phase_json, recent_json, revision)
       VALUES (?, 1, ?, '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, STREAM_ID).run();

    await currentBelaboxSample({
      DB: database as unknown as D1Database,
      channelId: CHANNEL_ID,
      secrets: secretAccess(),
      externalFetchBudget: budget(),
    }, Date.now(), () => Promise.resolve(jsonResponse(relayPayload(true))));

    expect(await getBelaboxStatus(database as unknown as D1Database, CHANNEL_ID)).toMatchObject({ polling: true });
  });

  it("keeps polling when a stored-URL test writes a sample during the fetch", async () => {
    await insertModule(database);
    const { context, scheduled, cleared } = alarmContext(database);
    const started = deferred<undefined>();
    const response = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>(() => {
      started.resolve(undefined);
      return response.promise;
    });

    const running = handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, fetcher);
    await started.promise;
    const testedAt = new Date(Date.now() + 60_000).toISOString();
    await prepareBelaboxSampleWrite(
      context.DB,
      CHANNEL_ID,
      normalizedSample(testedAt, 7_777),
      "ciphertext-version",
      { sql: "", values: [] },
    ).run();
    response.resolve(jsonResponse(relayPayload(true, 3_200)));
    await running;

    expect(scheduled).toHaveLength(1);
    expect(cleared).toEqual([]);
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      polling: true,
      sample: { at: testedAt, bitrateKbps: 7_777 },
    });
  });

  it("keeps the scheduled poll when a stored-URL test writes before reconciliation", async () => {
    await insertModule(database);
    const { context, scheduled, cleared } = alarmContext(database);
    const testedAt = new Date(Date.now() + 60_000).toISOString();
    context.schedule = async (key: string, deadline: number) => {
      scheduled.push({ key, deadline });
      await prepareBelaboxSampleWrite(
        context.DB,
        CHANNEL_ID,
        normalizedSample(testedAt, 7_777),
        "ciphertext-version",
        { sql: "", values: [] },
      ).run();
    };

    await handleBelaboxPollAlarm(
      context,
      "poll",
      Date.now(),
      undefined,
      () => Promise.resolve(jsonResponse(relayPayload(true, 3_200))),
    );

    expect(scheduled).toHaveLength(1);
    expect(cleared).toEqual([]);
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      polling: true,
      sample: { at: testedAt, bitrateKbps: 7_777 },
    });
  });

  it("lets overlapping polls share the single alarm and uses current settings", async () => {
    await insertModule(database, { mode: "interval", intervalSeconds: 15 });
    const { context, scheduled, cleared } = alarmContext(database);
    const starts = [deferred<undefined>(), deferred<undefined>()];
    const responses = [deferred<Response>(), deferred<Response>()];
    let fetchIndex = 0;
    const fetcher = vi.fn<typeof fetch>(() => {
      const index = fetchIndex++;
      starts[index]?.resolve(undefined);
      return responses[index]?.promise ?? Promise.reject(new Error("unexpected fetch"));
    });

    const oldIntervalRun = handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, fetcher);
    await starts[0]?.promise;
    await database.prepare(
      `UPDATE channel_modules
          SET settings = ?, revision = revision + 1
        WHERE channel_id = ? AND module_id = 'belabox'`,
    ).bind(JSON.stringify({ mode: "interval", intervalSeconds: 60 }), CHANNEL_ID).run();
    const newIntervalRun = handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, fetcher);
    await starts[1]?.promise;

    responses[0]?.resolve(jsonResponse(relayPayload(true)));
    await oldIntervalRun;
    responses[1]?.resolve(jsonResponse(relayPayload(true)));
    await newIntervalRun;

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(scheduled).toEqual([
      { key: "poll", deadline: Date.now() + 60_000 },
      { key: "poll", deadline: Date.now() + 60_000 },
    ]);
    expect(cleared).toEqual([]);
  });

  it("stops interval polling only when the poll alarm sees on-demand settings", async () => {
    await insertModule(database);
    const { context, scheduled, cleared } = alarmContext(database);
    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, polling, stream_id, fetch_phase_json, recent_json, revision)
       VALUES (?, 1, ?, '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, STREAM_ID).run();
    await database.prepare(
      "UPDATE channel_modules SET settings = ? WHERE channel_id = ? AND module_id = 'belabox'",
    ).bind(JSON.stringify({ mode: "on_demand", intervalSeconds: 15 }), CHANNEL_ID).run();

    await handleBelaboxPollAlarm(
      context,
      "poll",
      Date.now(),
      undefined,
      () => Promise.resolve(jsonResponse(relayPayload(true))),
    );

    expect(scheduled).toEqual([]);
    expect(cleared).toEqual([]);
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({ polling: false });
  });

  it("keeps only the newest 120 classified points from the last ten minutes", async () => {
    await insertModule(database, { mode: "interval", intervalSeconds: 5 });
    const { context } = alarmContext(database);
    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, polling, stream_id, belabox_stream_id, fetch_phase_json, recent_json, revision)
       VALUES (?, 1, ?, ?, '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, STREAM_ID, STREAM_ID).run();
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(relayPayload(true))));

    for (let point = 0; point < 125; point += 1) {
      await handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, fetcher);
      vi.setSystemTime(Date.now() + 5_000);
    }

    const status = await getBelaboxStatus(context.DB, CHANNEL_ID);
    expect(status?.recent).toHaveLength(120);
    expect(Date.parse(status?.recent[0]?.at ?? "") - Date.parse("2026-10-05T12:00:00.000Z")).toBe(25_000);
  });

  it.each([
    ["disabled", { enabled: false, settings: BELABOX_DEFAULT_SETTINGS, state: "online", configured: true }],
    ["on demand", { enabled: true, settings: { mode: "on_demand", intervalSeconds: 15 }, state: "online", configured: true }],
    ["missing key", { enabled: true, settings: BELABOX_DEFAULT_SETTINGS, state: "online", configured: false }],
    ["offline", { enabled: true, settings: BELABOX_DEFAULT_SETTINGS, state: "offline", configured: true }],
  ] as const)("does not reschedule when %s", async (_name, scenario) => {
    await insertModule(database, scenario.settings, scenario.enabled);
    const { context, scheduled, cleared } = alarmContext(database, {
      streamState: scenario.state,
      secrets: secretAccess(scenario.configured),
    });
    const fetcher = vi.fn<typeof fetch>();

    await expect(handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, fetcher)).resolves.toBeUndefined();
    expect(cleared).toEqual([]);
    expect(scheduled).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps the polling alarm after a transient D1 read failure", async () => {
    await insertModule(database);
    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, polling, stream_id, fetch_phase_json, recent_json, revision)
       VALUES (?, 1, ?, '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, STREAM_ID).run();
    const { context, scheduled, cleared } = alarmContext(database);
    const originalPrepare = context.DB.prepare.bind(context.DB);
    let failed = false;
    vi.spyOn(context.DB, "prepare").mockImplementation((sql) => {
        const statement = originalPrepare(sql);
        if (!sql.includes("SELECT enabled, settings FROM channel_modules")) return statement;
        return {
          bind: (...values: unknown[]) => {
            const bound = statement.bind(...values);
            return {
              first: async <T>() => {
                if (!failed) {
                  failed = true;
                  throw new Error(SECRET_SENTINEL);
                }
                return bound.first<T>();
              },
            };
          },
        } as unknown as D1PreparedStatement;
      });
    const fetcher = vi.fn<typeof fetch>();

    await expect(handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, fetcher)).resolves.toBeUndefined();

    expect(scheduled).toEqual([{ key: "poll", deadline: Date.now() + 60_000 }]);
    expect(cleared).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await getBelaboxStatus(database as unknown as D1Database, CHANNEL_ID)).toMatchObject({ polling: true });
  });

  it("stops with a fixed status code after an unreadable secret", async () => {
    await insertModule(database);
    const { context, scheduled, cleared } = alarmContext(database, {
      secrets: {
        ...secretAccess(),
        readWithVersion: () => Promise.reject(new Error(SECRET_SENTINEL)),
      },
    });
    const fetcher = vi.fn<typeof fetch>();

    await expect(handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, fetcher)).resolves.toBeUndefined();

    expect(scheduled).toEqual([]);
    expect(cleared).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      polling: false,
      errorCode: "not_configured",
    });
  });

  it("checks disabled offline stop conditions before reading the secret", async () => {
    await insertModule(database, BELABOX_DEFAULT_SETTINGS, false);
    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, polling, stream_id, belabox_stream_id, fetch_phase_json, recent_json, revision)
       VALUES (?, 1, ?, ?, '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, STREAM_ID, STREAM_ID).run();
    const readWithVersion = vi.fn(() => Promise.reject(new Error(SECRET_SENTINEL)));
    const { context, scheduled } = alarmContext(database, {
      streamState: "offline",
      secrets: { ...secretAccess(), readWithVersion },
    });

    await expect(handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, vi.fn())).resolves.toBeUndefined();

    expect(readWithVersion).not.toHaveBeenCalled();
    expect(scheduled).toEqual([]);
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      polling: false,
      streamId: null,
      belaboxStreamId: null,
    });
  });

  it("prunes old live points when provider polling fails", async () => {
    await insertModule(database);
    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, polling, stream_id, belabox_stream_id, fetch_phase_json, recent_json, revision)
       VALUES (?, 1, ?, ?, '{}', ?, 1)`,
    ).bind(
      CHANNEL_ID,
      STREAM_ID,
      STREAM_ID,
      JSON.stringify([
        ["2026-10-05T11:40:00.000Z", 1_000, 40, true],
        ["2026-10-05T11:55:00.000Z", 2_000, 50, true],
      ]),
    ).run();
    const { context, scheduled } = alarmContext(database);

    await handleBelaboxPollAlarm(
      context,
      "poll",
      Date.now(),
      undefined,
      () => Promise.reject(new TypeError("relay unavailable")),
    );

    expect(scheduled).toHaveLength(1);
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      errorCode: "network",
      recent: [{ at: "2026-10-05T11:55:00.000Z", bitrateKbps: 2_000 }],
    });
  });

  it("does not continue a poll while stream state is unknown", async () => {
    await insertModule(database);
    const first = alarmContext(database, { streamState: "unknown" });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(relayPayload(false)));
    await handleBelaboxPollAlarm(first.context, "poll", Date.now(), undefined, fetcher);
    expect(first.cleared).toEqual([]);
    expect(first.scheduled).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();

    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, polling, stream_id, fetch_phase_json, recent_json, revision)
       VALUES (?, 1, ?, '{}', '[]', 1)
       ON CONFLICT (channel_id) DO UPDATE SET polling = 1, stream_id = excluded.stream_id`,
    ).bind(CHANNEL_ID, STREAM_ID).run();
    const running = alarmContext(database, { streamState: "unknown", streamId: null });
    await handleBelaboxPollAlarm(running.context, "poll", Date.now(), undefined, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect(running.scheduled).toEqual([]);
  });

  it("writes failure and recovery diagnostics only at phase changes", async () => {
    await insertModule(database);
    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, polling, stream_id, belabox_stream_id, fetch_phase_json, recent_json, revision)
       VALUES (?, 1, ?, ?, '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, STREAM_ID, STREAM_ID).run();
    const { context, diagnostics } = alarmContext(database);
    const failing = vi.fn<typeof fetch>(() => Promise.reject(new TypeError(`failed ${STATS_URL}`)));

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, failing);
      vi.setSystemTime(Date.now() + 15_000);
    }
    expect(diagnostics).toEqual([{ code: "belabox.fetch_failing", detail: { reason: "network" } }]);
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({ errorCode: "network" });

    await handleBelaboxPollAlarm(
      context,
      "poll",
      Date.now(),
      undefined,
      () => Promise.resolve(jsonResponse(relayPayload(true))),
    );
    expect(diagnostics).toEqual([
      { code: "belabox.fetch_failing", detail: { reason: "network" } },
      { code: "belabox.fetch_recovered", detail: { reason: "fetch_succeeded" } },
    ]);
    const logged = await database.prepare(
      "SELECT code, detail_json FROM event_log WHERE channel_id = ? ORDER BY created_at, rowid",
    ).bind(CHANNEL_ID).all<{ code: string; detail_json: string }>();
    expect(logged.results).toEqual([
      { code: "belabox.fetch_failing", detail_json: JSON.stringify({ reason: "network" }) },
      { code: "belabox.fetch_recovered", detail_json: JSON.stringify({ reason: "fetch_succeeded" }) },
    ]);
  });

  it("never throws or leaks the secret through the alarm path", async () => {
    await insertModule(database);
    const { context } = alarmContext(database);
    const consoleRecord = console as unknown as Record<string, (...args: unknown[]) => void>;
    const consoleSpies = Object.getOwnPropertyNames(consoleRecord)
      .filter((name) => typeof consoleRecord[name] === "function")
      .map((name) => vi.spyOn(consoleRecord, name));
    const fetcher = vi.fn<typeof fetch>(() => Promise.reject(new Error(`secret=${STATS_URL}`)));

    let returned: unknown = "not_resolved";
    let rejected = "";
    try {
      await handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, fetcher);
      returned = undefined;
    } catch (error: unknown) {
      rejected = format(error);
    }
    expect(String(returned)).toBe("undefined");
    expect(String(returned)).not.toContain(SECRET_SENTINEL);
    expect(rejected).toBe("");
    expect(rejected).not.toContain(SECRET_SENTINEL);

    const renderedConsole = consoleSpies.flatMap((spy) => spy.mock.calls)
      .map((args) => format(...args)).join("\n");
    expect(renderedConsole).not.toContain(SECRET_SENTINEL);
    expect(consoleSpies.flatMap((spy) => spy.mock.calls)).toEqual([]);

    const tableNames = (await database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all<{ name: string }>()).results.map(({ name }) => name);
    for (const table of tableNames) {
      const rows = await database.prepare(`SELECT * FROM ${table}`).all<Record<string, unknown>>();
      expect(JSON.stringify(rows.results), table).not.toContain(SECRET_SENTINEL);
    }
    const stored = await database.prepare(
      "SELECT error_code, sample_json, fetch_phase_json, recent_json FROM belabox_status WHERE channel_id = ?",
    ).bind(CHANNEL_ID).first<Record<string, unknown>>();
    expect(stored).toEqual({
      error_code: "network",
      sample_json: null,
      fetch_phase_json: JSON.stringify({ consecutiveFailures: 1, fetchFailing: false }),
      recent_json: "[]",
    });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM event_log WHERE channel_id = ?")
      .bind(CHANNEL_ID).first()).resolves.toEqual({ count: 0 });
  });

  it("caches on-demand samples for ten seconds without arming polling", async () => {
    await insertModule(database, { mode: "on_demand", intervalSeconds: 15 });
    const externalFetchBudget = budget();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(relayPayload(true)));
    const options = {
      DB: database as unknown as D1Database,
      channelId: CHANNEL_ID,
      secrets: secretAccess(),
      externalFetchBudget,
    };

    const first = await currentBelaboxSample(options, Date.now(), fetcher);
    vi.setSystemTime(Date.now() + 9_999);
    const cached = await currentBelaboxSample(options, Date.now(), fetcher);
    expect(cached).toEqual(first);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(externalFetchBudget.claim).toHaveBeenCalledOnce();
    expect(await getBelaboxStatus(options.DB, CHANNEL_ID)).toMatchObject({ polling: false, recent: [] });

    vi.setSystemTime(Date.now() + 2);
    await currentBelaboxSample(options, Date.now(), fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("writes on-demand failure and recovery diagnostics only at phase changes", async () => {
    await insertModule(database, { mode: "on_demand", intervalSeconds: 15 });
    const options = {
      DB: database as unknown as D1Database,
      channelId: CHANNEL_ID,
      secrets: secretAccess(),
      externalFetchBudget: budget(),
      writeDiagnostics: (triggerId: string, entries: Parameters<typeof writeModuleDiagnostics>[5], now: string) =>
        writeModuleDiagnostics(database as unknown as D1Database, CHANNEL_ID, "belabox", triggerId, null, entries, now),
    };
    const failing = vi.fn<typeof fetch>(() => Promise.reject(new TypeError(`failed ${STATS_URL}`)));

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await currentBelaboxSample(options, Date.now(), failing);
      vi.setSystemTime(Date.now() + 1_000);
    }
    await currentBelaboxSample(
      options,
      Date.now(),
      () => Promise.resolve(jsonResponse(relayPayload(true))),
    );

    const logged = await database.prepare(
      "SELECT code, detail_json FROM event_log WHERE channel_id = ? ORDER BY created_at, rowid",
    ).bind(CHANNEL_ID).all<{ code: string; detail_json: string }>();
    expect(logged.results).toEqual([
      { code: "belabox.fetch_failing", detail_json: JSON.stringify({ reason: "network" }) },
      { code: "belabox.fetch_recovered", detail_json: JSON.stringify({ reason: "fetch_succeeded" }) },
    ]);
  });

  it("counts concurrent on-demand failures once each and emits one phase diagnostic", async () => {
    await insertModule(database, { mode: "on_demand", intervalSeconds: 15 });
    const diagnostics = vi.fn((
      triggerId: string,
      entries: Parameters<typeof writeModuleDiagnostics>[5],
      now: string,
    ) => writeModuleDiagnostics(database as unknown as D1Database, CHANNEL_ID, "belabox", triggerId, null, entries, now));
    const options = {
      DB: database as unknown as D1Database,
      channelId: CHANNEL_ID,
      secrets: secretAccess(),
      externalFetchBudget: budget(),
      writeDiagnostics: diagnostics,
    };
    const gates = [deferred<Response>(), deferred<Response>(), deferred<Response>()];
    let fetchIndex = 0;
    const fetcher = vi.fn<typeof fetch>(() => gates[fetchIndex++]?.promise ?? Promise.reject(new Error("unexpected fetch")));

    const requests = gates.map(() => currentBelaboxSample(options, Date.now(), fetcher));
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(3); });
    for (const gate of gates) gate.reject(new TypeError(`failed ${STATS_URL}`));
    await expect(Promise.all(requests)).resolves.toEqual([
      { ok: false, reason: "network" },
      { ok: false, reason: "network" },
      { ok: false, reason: "network" },
    ]);

    expect(await getBelaboxStatus(options.DB, CHANNEL_ID)).toMatchObject({
      fetchPhase: { consecutiveFailures: 3, failing: true },
    });
    expect(diagnostics).toHaveBeenCalledOnce();
    expect(diagnostics).toHaveBeenCalledWith(
      "belabox:on_demand",
      [{ code: "belabox.fetch_failing", detail: { reason: "network" } }],
      expect.any(String),
    );
    await expect(database.prepare(
      "SELECT code, detail_json FROM event_log WHERE channel_id = ?",
    ).bind(CHANNEL_ID).all()).resolves.toMatchObject({ results: [
      { code: "belabox.fetch_failing", detail_json: JSON.stringify({ reason: "network" }) },
    ] });
  });

  it("does not let a delayed on-demand success replace a newer stored sample", async () => {
    await insertModule(database, { mode: "on_demand", intervalSeconds: 15 });
    const options = {
      DB: database as unknown as D1Database,
      channelId: CHANNEL_ID,
      secrets: secretAccess(),
      externalFetchBudget: budget(),
    };
    const gates = [deferred<Response>(), deferred<Response>()];
    let fetchIndex = 0;
    const fetcher = vi.fn<typeof fetch>(() => gates[fetchIndex++]?.promise ?? Promise.reject(new Error("unexpected fetch")));

    const delayed = currentBelaboxSample(options, Date.now(), fetcher);
    const newer = currentBelaboxSample(options, Date.now(), fetcher);
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(2); });
    const newerAt = new Date(Date.now() + 5_000).toISOString();
    vi.setSystemTime(newerAt);
    gates[1]?.resolve(jsonResponse(relayPayload(true, 4_000)));
    await newer;
    vi.setSystemTime(new Date(Date.parse(newerAt) - 4_000));
    gates[0]?.resolve(jsonResponse(relayPayload(true, 1_000)));
    await delayed;

    expect(await getBelaboxStatus(options.DB, CHANNEL_ID)).toMatchObject({
      sample: { at: newerAt, bitrateKbps: 4_000 },
    });
  });
});
