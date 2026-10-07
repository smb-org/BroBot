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
import { getBelaboxStatus, listBelaboxStreams, prepareBelaboxSampleClear } from "../../src/modules/belabox/adapters/d1";
import { ensureBelaboxPoll, handleBelaboxPollAlarm, type BelaboxPollRoutineResult } from "../../src/modules/belabox/service";
import { writeModuleDiagnostics } from "../../src/worker/event-log";
import { insertChannel, jsonResponse } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "belabox-poll-channel";
const STREAM_ID = "stream-321";
const SECRET_SENTINEL = "BELABOX_ALARM_SENTINEL_321";
const STATS_URL = `http://relay.belabox.net:8080/${SECRET_SENTINEL}`;

const relayPayload = (connected: boolean, bitrateKbps = 3_200, droppedPackets = 7) => ({
  publishers: {
    [SECRET_SENTINEL]: {
      connected,
      bitrate: connected ? bitrateKbps : 0,
      rtt: connected ? 41 : 0,
      latency: connected ? 115 : 0,
      network: connected ? 2 : 0,
      dropped_pkts: connected ? droppedPackets : 0,
    },
  },
});

const disconnectedRelayPayload = (droppedPackets: number) => ({
  publishers: {
    [SECRET_SENTINEL]: {
      connected: false,
      bitrate: 0,
      rtt: 0,
      latency: 0,
      network: 0,
      dropped_pkts: droppedPackets,
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

const normalizedSample = (at: string, bitrateKbps: number, droppedPackets = 7) => ({
  at,
  connected: true,
  bitrateKbps,
  rttMs: 41,
  latencyMs: 115,
  network: 2,
  droppedPackets,
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
  await database.prepare(
    `INSERT INTO channel_stream_state (channel_id, state, changed_at, source, stream_id)
     VALUES (?, 'online', ?, 'eventsub', ?)
     ON CONFLICT (channel_id) DO UPDATE SET state = 'online', changed_at = excluded.changed_at,
       source = 'eventsub', stream_id = excluded.stream_id`,
  ).bind(CHANNEL_ID, "2026-10-05T12:00:00.000Z", STREAM_ID).run();
};

const setStoredStreamState = async (
  database: TestD1Database,
  state: "online" | "offline",
  streamId: string | null,
): Promise<void> => {
  await database.prepare(
    "UPDATE channel_stream_state SET state = ?, stream_id = ?, changed_at = ? WHERE channel_id = ?",
  ).bind(state, streamId, new Date(Date.now()).toISOString(), CHANNEL_ID).run();
};

const setStoredStreamId = async (database: TestD1Database, streamId: string | null): Promise<void> =>
  setStoredStreamState(database, "online", streamId);

const alarmContext = (
  database: TestD1Database,
  options: {
    streamState?: "online" | "offline" | "unknown";
    streamId?: string | null;
    secrets?: ModuleSecretAccess;
    databaseBinding?: D1Database;
    externalFetchBudget?: ModuleExternalFetchBudget;
    writeDiagnostics?: ModuleAlarmContext["writeDiagnostics"];
  } = {},
) => {
  const scheduled: Array<{ key: string; deadline: number }> = [];
  const cleared: string[] = [];
  const diagnostics: Array<{ code: string; detail?: Readonly<Record<string, unknown>> }> = [];
  const overlayMessages: Array<{ type: string; elementKind: string; payload: Readonly<Record<string, unknown>> }> = [];
  let currentDeadline: number | null = null;
  const sendChat = vi.fn<ModuleAlarmContext["sendChat"]>(async (_text, _idempotencyKey, _attributions, stillValid) => {
    if (stillValid !== undefined && !await stillValid()) return { sent: false, reason: "stale_before_send", retryable: false };
    return { sent: true, reason: null, retryable: false };
  });
  const context = {
    DB: options.databaseBinding ?? database as unknown as D1Database,
    channelId: CHANNEL_ID,
    secrets: options.secrets ?? secretAccess(),
    externalFetchBudget: options.externalFetchBudget ?? budget(),
    streamState: () => Promise.resolve(options.streamState ?? "online"),
    streamStartedAt: () => Promise.resolve({ streamId: options.streamId === undefined ? STREAM_ID : options.streamId, startedAt: null }),
    schedule: (key: string, deadline: number) => { scheduled.push({ key, deadline }); currentDeadline = deadline; return Promise.resolve(); },
    clear: (key: string) => { cleared.push(key); currentDeadline = null; return Promise.resolve(); },
    getAlarmDeadline: () => Promise.resolve(currentDeadline),
    renderTemplate: (text: string) => Promise.resolve({ text }),
    sendChat,
    writeDiagnostics: options.writeDiagnostics ?? ((triggerId: string, entries: readonly { code: string; detail?: Readonly<Record<string, unknown>> }[], now: string) => {
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
    }),
    publishModuleOverlayMessage: (type: string, elementKind: string, payload: Readonly<Record<string, unknown>>) => {
      overlayMessages.push({ type, elementKind, payload });
      return Promise.resolve();
    },
  } as unknown as ModuleAlarmContext;
  return { context, scheduled, cleared, diagnostics, overlayMessages, sendChat };
};

const pollOnDemand = async (context: ModuleAlarmContext, fetcher: typeof fetch = fetch): Promise<BelaboxPollRoutineResult> => {
  const result = await handleBelaboxPollAlarm(
    context,
    BELABOX_POLL_ALARM_KEY,
    Date.now(),
    undefined,
    fetcher,
    { reason: "on_demand" },
  );
  if (result === undefined) throw new Error("The on-demand routine must return its sample outcome.");
  return result;
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
      streamSession: { streamId: "ending-stream", startedAt: "2026-10-05T10:00:00.000Z" },
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
      `INSERT INTO belabox_streams (channel_id, stream_id, started_at, samples, bitrate_avg)
       VALUES (?, 'ending-stream', '2026-10-05T10:00:00.000Z', 1, 3000),
              (?, 'newer-stream', '2026-10-05T11:00:00.000Z', 1, 3300)`,
    ).bind(CHANNEL_ID, CHANNEL_ID).run();
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
    const finalizedStreams = await database.prepare(
      `SELECT stream_id, ended_at FROM belabox_streams WHERE channel_id = ? ORDER BY stream_id`,
    ).bind(CHANNEL_ID).all<{ stream_id: string; ended_at: string | null }>();
    expect(finalizedStreams.results[0]).toEqual({ stream_id: "ending-stream", ended_at: null });
    expect(finalizedStreams.results[1]).toEqual({ stream_id: "newer-stream", ended_at: null });
  });

  it("leaves offline finalization to the poll alarm after URL classification is cleared", async () => {
    const startedAt = "2026-10-05T10:00:00.000Z";
    await database.prepare(
      `INSERT INTO belabox_streams (channel_id, stream_id, started_at, samples, bitrate_avg)
       VALUES (?, 'ended-stream', ?, 1, 3200)`,
    ).bind(CHANNEL_ID, startedAt).run();
    await database.prepare(
      `INSERT INTO belabox_minutes
        (channel_id, minute_at, stream_id, samples, connected_samples, bitrate_min, bitrate_max,
         bitrate_sum, rtt_max, rtt_sum, dropped_delta)
       VALUES (?, '2026-10-05T10:01:00.000Z', 'ended-stream', 1, 1, 3200, 3200, 3200, 41, 41, 0)`,
    ).bind(CHANNEL_ID).run();
    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, polling, stream_id, belabox_stream_id, history_sample_json, history_module_revision,
         fetch_phase_json, recent_json, revision)
       VALUES (?, 0, NULL, NULL, ?, 1, '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, JSON.stringify(normalizedSample("2026-10-05T12:00:00.000Z", 3_200))).run();

    const handleEvent = belaboxModule.handleEvent;
    if (handleEvent === undefined) throw new Error("BELABOX event handler missing.");
    await handleEvent({
      channelId: CHANNEL_ID,
      subscriptionType: "stream.offline",
      triggerId: "ended-after-url-removal",
      payload: {},
      settings: BELABOX_DEFAULT_SETTINGS,
      receivedAt: "2026-10-05T12:01:00.000Z",
      eventSubTimestamp: "2026-10-05T12:01:00.000Z",
      actor: null,
      chatStatus: null,
    }, {
      DB: database as unknown as D1Database,
      streamStateTransitionAccepted: true,
      streamSession: { streamId: "ended-stream", startedAt },
      scheduleAlarm: () => Promise.resolve(),
    } as unknown as ModuleExecutionContext);

    await expect(database.prepare(
      `SELECT ended_at, bitrate_p10 FROM belabox_streams WHERE channel_id = ? AND stream_id = 'ended-stream'`,
    ).bind(CHANNEL_ID).first<Record<string, unknown>>()).resolves.toEqual({
      ended_at: null,
      bitrate_p10: null,
    });
    await expect(getBelaboxStatus(database as unknown as D1Database, CHANNEL_ID)).resolves.toMatchObject({
      historySample: normalizedSample("2026-10-05T12:00:00.000Z", 3_200),
      historyModuleRevision: 1,
    });
  });

  it("finalizes every open summary when the offline poll alarm is the fallback", async () => {
    await database.prepare(
      `INSERT INTO belabox_streams (channel_id, stream_id, started_at, samples, bitrate_avg)
       VALUES (?, 'open-a', '2026-10-05T09:00:00.000Z', 1, 1000),
              (?, 'open-b', '2026-10-05T10:00:00.000Z', 1, 2000)`,
    ).bind(CHANNEL_ID, CHANNEL_ID).run();
    await setStoredStreamState(database, "offline", null);
    const { context } = alarmContext(database, { streamState: "offline", streamId: null });

    await handleBelaboxPollAlarm(context, BELABOX_POLL_ALARM_KEY, Date.now());

    await expect(database.prepare(
      `SELECT stream_id, ended_at FROM belabox_streams WHERE channel_id = ? ORDER BY stream_id`,
    ).bind(CHANNEL_ID).all<{ stream_id: string; ended_at: string | null }>()).resolves.toMatchObject({
      results: [
        { stream_id: "open-a", ended_at: "2026-10-05T12:00:00.000Z" },
        { stream_id: "open-b", ended_at: "2026-10-05T12:00:00.000Z" },
      ],
    });
  });

  it("ensures after every lifecycle signal and leaves mode decisions to the poll alarm", async () => {
    await insertModule(database, { mode: "on_demand", intervalSeconds: 15 });
    const previous = normalizedSample("2026-10-05T11:59:45.000Z", 2_400, 7);
    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, polling, stream_id, belabox_stream_id, history_sample_json,
         history_module_revision, fetch_phase_json, recent_json, revision)
       VALUES (?, 1, ?, ?, ?, 1, '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, STREAM_ID, STREAM_ID, JSON.stringify(previous)).run();
    await database.prepare(
      `INSERT INTO belabox_streams (channel_id, stream_id, started_at, samples, bitrate_avg)
       VALUES (?, ?, '2026-10-05T11:50:00.000Z', 1, 2_400)`,
    ).bind(CHANNEL_ID, STREAM_ID).run();
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
      settings: { ...BELABOX_DEFAULT_SETTINGS, mode: "on_demand" },
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
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      polling: true,
      historySample: previous,
      historyModuleRevision: 1,
    });
    await expect(database.prepare(
      "SELECT ended_at FROM belabox_streams WHERE channel_id = ? AND stream_id = ?",
    ).bind(CHANNEL_ID, STREAM_ID).first<{ ended_at: string | null }>()).resolves.toEqual({ ended_at: null });
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
    await expect(database.prepare("SELECT COUNT(*) AS count FROM belabox_minutes WHERE channel_id = ?")
      .bind(CHANNEL_ID).first<{ count: number }>()).resolves.toEqual({ count: 0 });
    await expect(database.prepare("SELECT COUNT(*) AS count FROM belabox_streams WHERE channel_id = ?")
      .bind(CHANNEL_ID).first<{ count: number }>()).resolves.toEqual({ count: 0 });

    vi.setSystemTime(Date.now() + 60_000);
    await handleBelaboxPollAlarm(context, BELABOX_POLL_ALARM_KEY, Date.now(), undefined, fetcher);
    expect(scheduled.at(-1)?.deadline).toBe(Date.now() + 15_000);
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      belaboxStreamId: STREAM_ID,
      recent: [{ bitrateKbps: 3_200, connected: true }],
      sample: { connected: true },
    });

    vi.setSystemTime(Date.now() + 15_000);
    await handleBelaboxPollAlarm(context, BELABOX_POLL_ALARM_KEY, Date.now(), undefined, fetcher);
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      belaboxStreamId: STREAM_ID,
      recent: [
        { bitrateKbps: 3_200, connected: true },
        { bitrateKbps: 3_200, connected: true },
      ],
    });
  });

  it("upserts minute and stream aggregates and treats a dropped-packet reset as a fresh counter", async () => {
    await insertModule(database);
    const { context } = alarmContext(database, { streamId: STREAM_ID });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(relayPayload(true, 500, 10)))
      .mockResolvedValueOnce(jsonResponse(relayPayload(true, 800, 14)))
      .mockResolvedValueOnce(jsonResponse(relayPayload(true, 3_200, 2)))
      .mockResolvedValueOnce(jsonResponse(relayPayload(false)));

    for (let index = 0; index < 4; index += 1) {
      vi.setSystemTime(new Date(`2026-10-05T12:00:${String(index * 15).padStart(2, "0")}.000Z`));
      await handleBelaboxPollAlarm(context, BELABOX_POLL_ALARM_KEY, Date.now(), undefined, fetcher);
    }

    const minute = await database.prepare(
      `SELECT stream_id, samples, connected_samples, bitrate_min, bitrate_max, bitrate_sum,
              rtt_max, rtt_sum, dropped_delta
         FROM belabox_minutes WHERE channel_id = ? AND stream_id = ?`,
    ).bind(CHANNEL_ID, STREAM_ID).first<Record<string, unknown>>();
    expect((await getBelaboxStatus(database as unknown as D1Database, CHANNEL_ID))?.recent).toHaveLength(4);
    expect(minute).toEqual({
      stream_id: STREAM_ID,
      samples: 4,
      connected_samples: 3,
      bitrate_min: 0,
      bitrate_max: 3_200,
      bitrate_sum: 4_500,
      rtt_max: 41,
      rtt_sum: 123,
      dropped_delta: 16,
    });
    await expect(database.prepare(
      `SELECT stream_id, samples, bitrate_avg, ended_at, dropped_total
         FROM belabox_streams WHERE channel_id = ? AND stream_id = ?`,
    ).bind(CHANNEL_ID, STREAM_ID).first<Record<string, unknown>>()).resolves.toEqual({
      stream_id: STREAM_ID,
      samples: 4,
      bitrate_avg: 1_125,
      ended_at: null,
      dropped_total: 16,
    });

    vi.setSystemTime("2026-10-05T12:01:00.000Z");
    await setStoredStreamState(database, "offline", null);
    context.streamState = () => Promise.resolve("offline");
    context.streamStartedAt = () => Promise.resolve({ streamId: null, startedAt: null });
    await handleBelaboxPollAlarm(context, BELABOX_POLL_ALARM_KEY, Date.now());
    await expect(database.prepare(
      `SELECT ended_at, bitrate_p10 FROM belabox_streams WHERE channel_id = ? AND stream_id = ?`,
    ).bind(CHANNEL_ID, STREAM_ID).first<Record<string, unknown>>()).resolves.toEqual({
      ended_at: "2026-10-05T12:01:00.000Z",
      bitrate_p10: 1_125,
    });
    await expect(database.prepare(
      `SELECT low_seconds, disconnected_seconds, disconnect_count
         FROM belabox_streams WHERE channel_id = ? AND stream_id = ?`,
    ).bind(CHANNEL_ID, STREAM_ID).first<Record<string, unknown>>()).resolves.toEqual({
      low_seconds: 30,
      disconnected_seconds: 15,
      disconnect_count: 1,
    });
  });

  it("keeps separate minute aggregates when two BELABOX streams start in the same minute", async () => {
    await insertModule(database);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(relayPayload(true, 1_000)))
      .mockResolvedValueOnce(jsonResponse(relayPayload(true, 2_000)));
    vi.setSystemTime("2026-10-05T12:00:05.000Z");
    await setStoredStreamId(database, "stream-first");
    await handleBelaboxPollAlarm(alarmContext(database, { streamId: "stream-first" }).context,
      BELABOX_POLL_ALARM_KEY, Date.now(), undefined, fetcher);
    vi.setSystemTime("2026-10-05T12:00:20.000Z");
    await setStoredStreamId(database, "stream-second");
    await handleBelaboxPollAlarm(alarmContext(database, { streamId: "stream-second" }).context,
      BELABOX_POLL_ALARM_KEY, Date.now(), undefined, fetcher);

    await expect(database.prepare(
      `SELECT stream_id, samples, bitrate_sum FROM belabox_minutes
        WHERE channel_id = ? ORDER BY stream_id`,
    ).bind(CHANNEL_ID).all<Record<string, unknown>>()).resolves.toMatchObject({
      results: [
        { stream_id: "stream-first", samples: 1, bitrate_sum: 1_000 },
        { stream_id: "stream-second", samples: 1, bitrate_sum: 2_000 },
      ],
    });
  });

  it("lists only the latest twenty BELABOX stream summaries", async () => {
    for (let index = 0; index < 25; index += 1) {
      const startedAt = new Date(Date.parse("2026-10-01T00:00:00.000Z") + index * 60_000).toISOString();
      await database.prepare(
        `INSERT INTO belabox_streams (channel_id, stream_id, started_at, samples, bitrate_avg)
         VALUES (?, ?, ?, 1, ?)`,
      ).bind(CHANNEL_ID, `history-stream-${String(index).padStart(2, "0")}`, startedAt, index + 1).run();
    }

    const streams = await listBelaboxStreams(database as unknown as D1Database, CHANNEL_ID);

    expect(streams).toHaveLength(20);
    expect(streams[0]?.streamId).toBe("history-stream-24");
    expect(streams.at(-1)?.streamId).toBe("history-stream-05");
  });

  it("retains minute data for thirty days and keeps stream summaries", async () => {
    const secondChannel = `${CHANNEL_ID}-second`;
    await insertChannel(database, secondChannel);
    await database.prepare(
      `INSERT INTO belabox_minutes
        (channel_id, minute_at, stream_id, samples, connected_samples, bitrate_min, bitrate_max,
         bitrate_sum, rtt_max, rtt_sum, dropped_delta)
       VALUES (?, '2026-09-04T11:59:00.000Z', 'old-stream', 1, 1, 1000, 1000, 1000, 20, 20, 0),
              (?, '2026-09-05T12:00:00.000Z', 'recent-stream', 1, 1, 2000, 2000, 2000, 30, 30, 0),
              (?, '2026-09-04T11:59:00.000Z', 'old-stream-b', 1, 1, 1100, 1100, 1100, 21, 21, 0),
              (?, '2026-09-05T12:00:00.000Z', 'recent-stream-b', 1, 1, 2100, 2100, 2100, 31, 31, 0)`,
    ).bind(CHANNEL_ID, CHANNEL_ID, secondChannel, secondChannel).run();
    await database.prepare(
      `INSERT INTO belabox_streams
        (channel_id, stream_id, started_at, samples, bitrate_avg, low_seconds, disconnected_seconds,
         disconnect_count, dropped_total)
       VALUES (?, 'old-stream', '2026-09-01T12:00:00.000Z', 1, 1000, 0, 0, 0, 0)`,
    ).bind(CHANNEL_ID).run();

    await belaboxModule.scheduledMaintenance?.(database as unknown as D1Database, "2026-10-05T12:00:00.000Z");

    await expect(database.prepare("SELECT channel_id, minute_at FROM belabox_minutes WHERE channel_id IN (?, ?) ORDER BY channel_id")
      .bind(CHANNEL_ID, secondChannel).all<{ channel_id: string; minute_at: string }>()).resolves.toMatchObject({
      results: [
        { channel_id: CHANNEL_ID, minute_at: "2026-09-05T12:00:00.000Z" },
        { channel_id: secondChannel, minute_at: "2026-09-05T12:00:00.000Z" },
      ],
    });
    await expect(database.prepare("SELECT stream_id FROM belabox_streams WHERE channel_id = ?")
      .bind(CHANNEL_ID).all<{ stream_id: string }>()).resolves.toMatchObject({
      results: [{ stream_id: "old-stream" }],
    });
  });

  it("accumulates dropped deltas, tracks the unhealthy episode, and publishes changed samples", async () => {
    await insertModule(database, { mode: "interval", intervalSeconds: 15 });
    const { context, overlayMessages } = alarmContext(database);
    const payload = (connected: boolean, bitrate: number, dropped: number) => ({ publishers: {
      [SECRET_SENTINEL]: { connected, bitrate, rtt: connected ? 41 : 0, latency: 115, network: 2, dropped_pkts: dropped },
    } });
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(payload(false, 0, 0)))
      .mockResolvedValueOnce(jsonResponse(payload(true, 900, 7)))
      .mockResolvedValueOnce(jsonResponse(payload(true, 800, 9)))
      .mockResolvedValueOnce(jsonResponse(payload(true, 800, 9)))
      .mockResolvedValueOnce(jsonResponse(payload(false, 0, 0)));

    await handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, fetcher);
    vi.setSystemTime(Date.now() + 60_000);
    await handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, fetcher);
    const lowStartedAt = new Date().toISOString();
    vi.setSystemTime(Date.now() + 15_000);
    await handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, fetcher);
    vi.setSystemTime(Date.now() + 15_000);
    await handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, fetcher);
    vi.setSystemTime(Date.now() + 15_000);
    await handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, fetcher);

    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      sample: { phase: "disconnected", alertStartedAt: lowStartedAt, droppedTotal: 9 },
    });
    expect(overlayMessages.map(({ type, elementKind, payload: message }) => ({ type, elementKind, phase: message.phase })))
      .toEqual([
        { type: "sample", elementKind: "belabox.status", phase: "inactive" },
        { type: "sample", elementKind: "belabox.status", phase: "low" },
        { type: "sample", elementKind: "belabox.status", phase: "low" },
        { type: "sample", elementKind: "belabox.status", phase: "low" },
        { type: "sample", elementKind: "belabox.status", phase: "disconnected" },
      ]);
  });

  it("sends a held low-bitrate alert through the shared idempotent chat gate", async () => {
    await insertModule(database, {
      ...BELABOX_DEFAULT_SETTINGS,
      mode: "interval",
      intervalSeconds: 5,
      holdSeconds: 5,
      recoverHoldSeconds: 5,
      chatEnabled: true,
    });
    const { context, sendChat, diagnostics } = alarmContext(database);
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(relayPayload(true, 900))));

    await handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, fetcher);
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({ alertState: { phase: "pending", kind: "low" } });
    expect(diagnostics).toEqual([]);
    expect(sendChat).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 5_000);
    await handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, fetcher);

    const status = await getBelaboxStatus(context.DB, CHANNEL_ID);
    expect(status).toMatchObject({ alertState: { phase: "alarm", kind: "low", chatSentInEpisode: true } });
    expect(sendChat).toHaveBeenCalledOnce();
    expect(sendChat.mock.calls[0]?.[1]).toBe(`belabox:${STREAM_ID}:${String(status?.alertState.episodeStartedAt)}:alert`);
    expect(diagnostics.map(({ code }) => code)).toEqual(["belabox.alert_started"]);
  });

  it("does not use S1's hold timestamp for S2's first poll after Check now", async () => {
    await insertModule(database, {
      ...BELABOX_DEFAULT_SETTINGS,
      mode: "interval",
      intervalSeconds: 5,
      holdSeconds: 5,
      recoverHoldSeconds: 5,
      chatEnabled: true,
    });
    const { context, sendChat } = alarmContext(database);
    const s1StartedAt = new Date(Date.now()).toISOString();
    let liveStreamId = "stream-s1";
    context.streamStartedAt = () => Promise.resolve({ streamId: liveStreamId, startedAt: null });
    await database.prepare(
      `UPDATE channel_stream_state
          SET state = 'online', changed_at = ?, started_at = ?, stream_id = ?
        WHERE channel_id = ?`,
    ).bind(s1StartedAt, s1StartedAt, "stream-s1", CHANNEL_ID).run();

    const lowRelay = () => Promise.resolve(jsonResponse(relayPayload(true, 900)));
    await handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, lowRelay);
    const s1HoldStartedAt = (await getBelaboxStatus(context.DB, CHANNEL_ID))?.alertState.since;
    expect(s1HoldStartedAt).toBe(new Date(Date.now()).toISOString());
    expect(sendChat).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 1_000);
    await handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, lowRelay);
    expect((await getBelaboxStatus(context.DB, CHANNEL_ID))?.alertState.since).toBe(s1HoldStartedAt);

    vi.setSystemTime(Date.now() + 59_000);
    const s2StartedAt = new Date(Date.now()).toISOString();
    await database.prepare(
      `UPDATE channel_stream_state
          SET changed_at = ?, started_at = ?, stream_id = ?
        WHERE channel_id = ?`,
    ).bind(s2StartedAt, s2StartedAt, "stream-s2", CHANNEL_ID).run();
    liveStreamId = "stream-s2";
    await database.prepare(
      "UPDATE belabox_status SET fetch_phase_json = ?, recent_json = ? WHERE channel_id = ?",
    ).bind(
      JSON.stringify({ consecutiveFailures: 3, fetchFailing: true }),
      JSON.stringify([[new Date(Date.now() - 5_000).toISOString(), 900, 41, true]]),
      CHANNEL_ID,
    ).run();

    await handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, lowRelay, { reason: "check_now" });
    const s2Status = await getBelaboxStatus(context.DB, CHANNEL_ID);
    const s2CheckAt = s2Status?.sample?.at;
    expect(s2Status).toMatchObject({
      streamSessionKey: "stream:stream-s2",
      fetchPhase: { consecutiveFailures: 0, failing: false },
      recent: [{ connected: true, bitrateKbps: 900 }],
      alertState: {
        phase: "pending",
        kind: "low",
        since: s2CheckAt,
      },
    });
    const summaries = await listBelaboxStreams(context.DB, CHANNEL_ID);
    expect(summaries).toEqual(expect.arrayContaining([
      expect.objectContaining({ streamId: "stream-s1", endedAt: s2CheckAt }),
      expect.objectContaining({ streamId: "stream-s2", endedAt: null }),
    ]));

    vi.setSystemTime(Date.now() + 1_000);
    await handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, lowRelay);

    expect(sendChat).not.toHaveBeenCalled();
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      alertState: { phase: "pending", kind: "low", since: s2CheckAt },
    });
  });

  it("uses configured low-bitrate thresholds for alert state and session-tags realtime samples", async () => {
    await insertModule(database, {
      ...BELABOX_DEFAULT_SETTINGS,
      lowBitrateKbps: 2_000,
      recoverBitrateKbps: 3_000,
    });
    const { context, overlayMessages } = alarmContext(database);

    await handleBelaboxPollAlarm(
      context,
      BELABOX_POLL_ALARM_KEY,
      Date.now(),
      undefined,
      () => Promise.resolve(jsonResponse(relayPayload(true, 1_500))),
    );

    const status = await getBelaboxStatus(context.DB, CHANNEL_ID);
    expect(status).toMatchObject({
      sample: { bitrateKbps: 1_500, phase: "low" },
      alertState: { phase: "pending", kind: "low" },
    });
    expect(overlayMessages).toHaveLength(1);
    expect(overlayMessages[0]?.payload).toMatchObject({ streamSessionKey: `stream:${STREAM_ID}` });
  });

  it("retries a retryable alert send on the next successful poll with the same key", async () => {
    await insertModule(database, {
      ...BELABOX_DEFAULT_SETTINGS,
      mode: "interval",
      intervalSeconds: 5,
      holdSeconds: 5,
      recoverHoldSeconds: 5,
      chatEnabled: true,
    });
    const { context, sendChat } = alarmContext(database);
    sendChat.mockResolvedValueOnce({ sent: false, reason: "temporary_failure", retryable: true });
    sendChat.mockResolvedValueOnce({ sent: true, reason: null, retryable: true });
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(relayPayload(true, 900))));

    await handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, fetcher);
    vi.setSystemTime(Date.now() + 5_000);
    await handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, fetcher);
    const firstKey = sendChat.mock.calls[0]?.[1];
    expect(firstKey).toBeDefined();
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({ alertState: { pendingChat: { idempotencyKind: "alert" } } });

    vi.setSystemTime(Date.now() + 5_000);
    await handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, fetcher);

    expect(sendChat).toHaveBeenCalledTimes(2);
    expect(sendChat.mock.calls[1]?.[1]).toBe(firstKey);
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({ alertState: { chatSentInEpisode: true, pendingChat: null } });
  });

  it("settles recovery after a concurrent Check now write and keeps the chat cooldown", async () => {
    await insertModule(database, {
      ...BELABOX_DEFAULT_SETTINGS,
      mode: "interval",
      intervalSeconds: 5,
      holdSeconds: 5,
      recoverHoldSeconds: 5,
      chatCooldownSeconds: 300,
      chatEnabled: true,
    });
    const settlementReadStarted = deferred<undefined>();
    const allowSettlementRead = deferred<undefined>();
    let interceptSettlementRead = false;
    let interceptedSettlementRead = false;
    const databaseBinding = {
      prepare: (sql: string) => {
        const statement = database.prepare(sql);
        const wrapped = {
          bind: (...values: Parameters<typeof statement.bind>) => {
            statement.bind(...values);
            return wrapped;
          },
          first: <Value>() => {
            if (interceptSettlementRead && !interceptedSettlementRead && sql.includes("SELECT sampled_at") && sql.includes("FROM belabox_status")) {
              interceptedSettlementRead = true;
              return statement.first<Value>().then(async (value) => {
                settlementReadStarted.resolve(undefined);
                await allowSettlementRead.promise;
                return value;
              });
            }
            return statement.first<Value>();
          },
          all: <Value>(...typeHint: readonly Value[]) => statement.all<Value>(...typeHint),
          run: () => statement.run(),
          runSync: () => statement.runSync(),
        };
        return wrapped;
      },
      batch: database.batch.bind(database),
    } as unknown as D1Database;
    const { context, sendChat } = alarmContext(database, { databaseBinding });
    sendChat.mockImplementation(async (_message, idempotencyKey, _attributions, stillValid) => {
      if (stillValid !== undefined && !await stillValid()) return { sent: false, reason: "stale_before_send", retryable: false };
      if (idempotencyKey.endsWith(":recovered")) interceptSettlementRead = true;
      return { sent: true, reason: null, retryable: false };
    });
    const poll = (bitrateKbps: number): Promise<BelaboxPollRoutineResult | undefined> => handleBelaboxPollAlarm(
      context,
      "poll",
      Date.now(),
      undefined,
      () => Promise.resolve(jsonResponse(relayPayload(true, bitrateKbps))),
    );
    const startedAt = Date.now();

    await poll(3_200);
    vi.setSystemTime(Date.now() + 5_000);
    await poll(900);
    vi.setSystemTime(Date.now() + 5_000);
    await poll(900);
    expect(sendChat).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 5_000);
    await poll(3_200);
    vi.setSystemTime(Date.now() + 5_000);
    const recoveryPoll = poll(3_200);
    await settlementReadStarted.promise;
    const concurrentSample = normalizedSample(new Date(Date.now()).toISOString(), 3_200);
    await database.prepare(
      `UPDATE belabox_status SET sampled_at = ?, sample_json = ?, revision = revision + 1
        WHERE channel_id = ?`,
    ).bind(concurrentSample.at, JSON.stringify(concurrentSample), CHANNEL_ID).run();
    allowSettlementRead.resolve(undefined);
    await recoveryPoll;

    expect(interceptedSettlementRead).toBe(true);
    expect(sendChat).toHaveBeenCalledTimes(2);
    expect(sendChat.mock.calls[1]?.[1]).toBe(`belabox:${STREAM_ID}:${new Date(startedAt + 5_000).toISOString()}:recovered`);
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      alertState: {
        phase: "ok",
        pendingChat: null,
        completedEpisodeAt: new Date(startedAt + 5_000).toISOString(),
        lastChatSentAt: new Date(startedAt + 10_000).toISOString(),
      },
    });

    vi.setSystemTime(startedAt + 21_000);
    await poll(900);
    vi.setSystemTime(startedAt + 26_000);
    await poll(900);
    expect(sendChat).toHaveBeenCalledTimes(2);
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      alertState: { phase: "alarm", pendingChat: { idempotencyKind: "alert" } },
    });

    vi.setSystemTime(startedAt + 310_000);
    await poll(900);
    expect(sendChat).toHaveBeenCalledTimes(3);
  });

  it("keeps relay fetch failures out of chat and raises the notice phase on failure three", async () => {
    await insertModule(database, { ...BELABOX_DEFAULT_SETTINGS, mode: "interval", intervalSeconds: 5, chatEnabled: true });
    const { context, sendChat } = alarmContext(database);
    await handleBelaboxPollAlarm(
      context,
      "poll",
      Date.now(),
      undefined,
      () => Promise.resolve(jsonResponse(relayPayload(true))),
    );
    const fail = (): Promise<Response> => Promise.reject(new TypeError(`relay failed ${STATS_URL}`));

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      vi.setSystemTime(Date.now() + 5_000);
      await handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, fail);
      expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
        fetchPhase: { consecutiveFailures: attempt, failing: attempt === 3 },
      });
    }

    expect(sendChat).not.toHaveBeenCalled();
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
    await setStoredStreamState(database, "offline", null);
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

  it("discards a delayed S1 fetch and resets polling after the current stream changes to S2", async () => {
    await insertModule(database);
    await setStoredStreamId(database, "stream-s1");
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
    await setStoredStreamId(database, "stream-s2");
    response.resolve(jsonResponse(relayPayload(true)));
    await running;

    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      polling: false,
      streamId: null,
      belaboxStreamId: null,
      sample: null,
    });
    expect(scheduled).toHaveLength(1);
    expect(scheduled.at(-1)?.deadline).toBe(Date.now());
  });

  it("preserves the poll flag when an on-demand sample writes status", async () => {
    await insertModule(database, { mode: "on_demand", intervalSeconds: 15 });
    const { context } = alarmContext(database);
    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, polling, stream_id, fetch_phase_json, recent_json, revision)
       VALUES (?, 1, ?, '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, STREAM_ID).run();

    await pollOnDemand(context, () => Promise.resolve(jsonResponse(relayPayload(true))));

    expect(await getBelaboxStatus(database as unknown as D1Database, CHANNEL_ID)).toMatchObject({ polling: true });
  });

  it("keeps connection tests out of stored samples and history baseline accounting", async () => {
    await insertModule(database);
    const { context } = alarmContext(database);
    vi.setSystemTime("2026-10-05T12:00:00.000Z");
    await handleBelaboxPollAlarm(
      context,
      BELABOX_POLL_ALARM_KEY,
      Date.now(),
      undefined,
      () => Promise.resolve(jsonResponse(relayPayload(true, 500, 10))),
    );
    vi.setSystemTime("2026-10-05T12:00:25.000Z");
    await expect(handleBelaboxPollAlarm(
      context,
      BELABOX_POLL_ALARM_KEY,
      Date.now(),
      undefined,
      () => Promise.resolve(jsonResponse(relayPayload(true, 2_000, 14))),
      { reason: "connection_test", statsUrl: STATS_URL },
    )).resolves.toMatchObject({ ok: true, sample: { bitrateKbps: 2_000, droppedPackets: 14 } });
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      sample: { at: "2026-10-05T12:00:00.000Z", droppedPackets: 10, bitrateKbps: 500 },
      historySample: { at: "2026-10-05T12:00:00.000Z", droppedPackets: 10, bitrateKbps: 500 },
    });

    vi.setSystemTime("2026-10-05T12:00:15.000Z");
    await handleBelaboxPollAlarm(
      context,
      BELABOX_POLL_ALARM_KEY,
      Date.now(),
      undefined,
      () => Promise.resolve(jsonResponse(relayPayload(true, 500, 14))),
    );
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      sample: { at: "2026-10-05T12:00:15.000Z", droppedPackets: 14, bitrateKbps: 500 },
      historySample: { at: "2026-10-05T12:00:15.000Z", droppedPackets: 14, bitrateKbps: 500 },
    });

    vi.setSystemTime("2026-10-05T12:00:30.000Z");
    await handleBelaboxPollAlarm(
      context,
      BELABOX_POLL_ALARM_KEY,
      Date.now(),
      undefined,
      () => Promise.resolve(jsonResponse(relayPayload(true, 500, 18))),
    );

    await expect(database.prepare(
      `SELECT samples, dropped_delta FROM belabox_minutes WHERE channel_id = ? AND stream_id = ?`,
    ).bind(CHANNEL_ID, STREAM_ID).first<Record<string, unknown>>()).resolves.toEqual({ samples: 3, dropped_delta: 18 });
    await expect(database.prepare(
      `SELECT samples, low_seconds, dropped_total FROM belabox_streams WHERE channel_id = ? AND stream_id = ?`,
    ).bind(CHANNEL_ID, STREAM_ID).first<Record<string, unknown>>()).resolves.toEqual({ samples: 3, low_seconds: 30, dropped_total: 18 });
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      sample: { droppedPackets: 18, bitrateKbps: 500 },
      historySample: { droppedPackets: 18, bitrateKbps: 500 },
    });
  });

  it("does not count dropped packets across a missing publisher", async () => {
    await insertModule(database);
    const { context } = alarmContext(database);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(relayPayload(true, 3_200, 10)))
      .mockResolvedValueOnce(jsonResponse({ publishers: {} }))
      .mockResolvedValueOnce(jsonResponse(relayPayload(true, 3_200, 12)));

    const times = [
      "2026-10-05T12:00:00.000Z",
      "2026-10-05T12:01:00.000Z",
      "2026-10-05T12:02:00.000Z",
    ];
    for (const [index, at] of times.entries()) {
      vi.setSystemTime(new Date(at));
      await handleBelaboxPollAlarm(context, BELABOX_POLL_ALARM_KEY, Date.now(), undefined, fetcher);
      if (index === 1) {
        expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
          sample: { connected: false, droppedPackets: 0 },
          historySample: { connected: false, droppedPackets: 0 },
        });
      }
    }

    await expect(database.prepare(
      `SELECT minute_at, dropped_delta FROM belabox_minutes WHERE channel_id = ? AND stream_id = ? ORDER BY minute_at`,
    ).bind(CHANNEL_ID, STREAM_ID).all<Record<string, unknown>>()).resolves.toMatchObject({
      results: [
        { minute_at: "2026-10-05T12:00:00.000Z", dropped_delta: 10 },
        { minute_at: "2026-10-05T12:01:00.000Z", dropped_delta: 0 },
        { minute_at: "2026-10-05T12:02:00.000Z", dropped_delta: 0 },
      ],
    });
    await expect(database.prepare(
      `SELECT dropped_total FROM belabox_streams WHERE channel_id = ? AND stream_id = ?`,
    ).bind(CHANNEL_ID, STREAM_ID).first<Record<string, unknown>>()).resolves.toEqual({ dropped_total: 10 });
  });

  it("does not count a disconnected publisher's counter again after reconnection", async () => {
    await insertModule(database);
    const { context } = alarmContext(database);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(relayPayload(true, 3_200, 10)))
      .mockResolvedValueOnce(jsonResponse(disconnectedRelayPayload(12)))
      .mockResolvedValueOnce(jsonResponse(relayPayload(true, 3_200, 12)));

    for (const at of [
      "2026-10-05T12:00:00.000Z",
      "2026-10-05T12:01:00.000Z",
      "2026-10-05T12:02:00.000Z",
    ]) {
      vi.setSystemTime(new Date(at));
      await handleBelaboxPollAlarm(context, BELABOX_POLL_ALARM_KEY, Date.now(), undefined, fetcher);
    }

    await expect(database.prepare(
      `SELECT minute_at, dropped_delta FROM belabox_minutes WHERE channel_id = ? AND stream_id = ? ORDER BY minute_at`,
    ).bind(CHANNEL_ID, STREAM_ID).all<Record<string, unknown>>()).resolves.toMatchObject({
      results: [
        { minute_at: "2026-10-05T12:00:00.000Z", dropped_delta: 10 },
        { minute_at: "2026-10-05T12:01:00.000Z", dropped_delta: 0 },
        { minute_at: "2026-10-05T12:02:00.000Z", dropped_delta: 0 },
      ],
    });
    await expect(database.prepare(
      `SELECT dropped_total FROM belabox_streams WHERE channel_id = ? AND stream_id = ?`,
    ).bind(CHANNEL_ID, STREAM_ID).first<Record<string, unknown>>()).resolves.toEqual({ dropped_total: 10 });
  });

  it("uses the current sample as a dropped-packet baseline after the stats URL is replaced", async () => {
    await insertModule(database);
    const { context } = alarmContext(database);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(relayPayload(true, 3_200, 10)))
      .mockResolvedValueOnce(jsonResponse(relayPayload(true, 3_200, 12)));

    await handleBelaboxPollAlarm(context, BELABOX_POLL_ALARM_KEY, Date.now(), undefined, fetcher);
    await prepareBelaboxSampleClear(context.DB, CHANNEL_ID, { sql: "", values: [] }).run();
    vi.setSystemTime("2026-10-05T12:01:00.000Z");
    await handleBelaboxPollAlarm(context, BELABOX_POLL_ALARM_KEY, Date.now(), undefined, fetcher);

    await expect(database.prepare(
      `SELECT minute_at, dropped_delta FROM belabox_minutes WHERE channel_id = ? AND stream_id = ? ORDER BY minute_at`,
    ).bind(CHANNEL_ID, STREAM_ID).all<Record<string, unknown>>()).resolves.toMatchObject({
      results: [
        { minute_at: "2026-10-05T12:00:00.000Z", dropped_delta: 10 },
        { minute_at: "2026-10-05T12:01:00.000Z", dropped_delta: 0 },
      ],
    });
    await expect(database.prepare(
      `SELECT dropped_total FROM belabox_streams WHERE channel_id = ? AND stream_id = ?`,
    ).bind(CHANNEL_ID, STREAM_ID).first<Record<string, unknown>>()).resolves.toEqual({ dropped_total: 10 });
  });

  it("keeps polling when a stored-URL test writes a sample during the fetch", async () => {
    await insertModule(database);
    const { context, scheduled, cleared, overlayMessages } = alarmContext(database);
    const started = deferred<undefined>();
    const response = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>(() => {
      started.resolve(undefined);
      return response.promise;
    });

    const running = handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, fetcher);
    await started.promise;
    const testedAt = new Date(Date.now() + 60_000).toISOString();
    await database.prepare(
      `UPDATE belabox_status
          SET sampled_at = ?, sample_json = ?, stream_id = ?, stream_session_key = ?,
              belabox_stream_id = ?, revision = revision + 1
        WHERE channel_id = ?`,
    ).bind(
      testedAt,
      JSON.stringify({ ...normalizedSample(testedAt, 7_777), droppedTotal: 0 }),
      STREAM_ID,
      `stream:${STREAM_ID}`,
      STREAM_ID,
      CHANNEL_ID,
    ).run();
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      streamSessionKey: `stream:${STREAM_ID}`,
      sample: { at: testedAt, bitrateKbps: 7_777 },
    });
    response.resolve(jsonResponse(relayPayload(true, 3_200)));
    await running;

    expect(scheduled).toHaveLength(1);
    expect(cleared).toEqual([]);
    expect(overlayMessages).toEqual([]);
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
      await database.prepare(
        `UPDATE belabox_status
            SET sampled_at = ?, sample_json = ?, stream_id = ?, stream_session_key = ?,
                belabox_stream_id = ?, revision = revision + 1
          WHERE channel_id = ?`,
      ).bind(
        testedAt,
        JSON.stringify({ ...normalizedSample(testedAt, 7_777), droppedTotal: 0 }),
        STREAM_ID,
        `stream:${STREAM_ID}`,
        STREAM_ID,
        CHANNEL_ID,
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
    const previous = normalizedSample("2026-10-05T11:59:45.000Z", 2_400, 7);
    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, polling, stream_id, belabox_stream_id, history_sample_json,
         history_module_revision, fetch_phase_json, recent_json, revision)
       VALUES (?, 1, ?, ?, ?, 1, '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, STREAM_ID, STREAM_ID, JSON.stringify(previous)).run();
    await database.prepare(
      `INSERT INTO belabox_streams (channel_id, stream_id, started_at, samples, bitrate_avg)
       VALUES (?, ?, '2026-10-05T11:50:00.000Z', 1, 2_400)`,
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
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      polling: false,
      historySample: null,
      historyModuleRevision: null,
    });
    await expect(database.prepare(
      "SELECT ended_at FROM belabox_streams WHERE channel_id = ? AND stream_id = ?",
    ).bind(CHANNEL_ID, STREAM_ID).first<{ ended_at: string | null }>()).resolves.toEqual({
      ended_at: new Date().toISOString(),
    });
  });

  it("does not carry history deltas across a fast interval to on-demand to interval save", async () => {
    await insertModule(database);
    const previous = normalizedSample("2026-10-05T11:59:50.000Z", 100, 7);
    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, polling, stream_id, belabox_stream_id, history_sample_json,
         history_module_revision, fetch_phase_json, recent_json, revision)
       VALUES (?, 1, ?, ?, ?, 1, '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, STREAM_ID, STREAM_ID, JSON.stringify(previous)).run();
    await database.prepare(
      `INSERT INTO belabox_streams
        (channel_id, stream_id, started_at, samples, bitrate_avg, low_seconds, dropped_total)
       VALUES (?, ?, '2026-10-05T11:50:00.000Z', 1, 100, 5, 7)`,
    ).bind(CHANNEL_ID, STREAM_ID).run();
    await database.prepare(
      "UPDATE channel_modules SET settings = ?, revision = revision + 1 WHERE channel_id = ? AND module_id = 'belabox'",
    ).bind(JSON.stringify({ mode: "on_demand", intervalSeconds: 15 }), CHANNEL_ID).run();
    await database.prepare(
      "UPDATE channel_modules SET settings = ?, revision = revision + 1 WHERE channel_id = ? AND module_id = 'belabox'",
    ).bind(JSON.stringify(BELABOX_DEFAULT_SETTINGS), CHANNEL_ID).run();

    const { context } = alarmContext(database);
    await handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, () => Promise.resolve(jsonResponse(relayPayload(true, 3_200, 12))));

    const status = await getBelaboxStatus(context.DB, CHANNEL_ID);
    const stream = await database.prepare(
      "SELECT low_seconds, dropped_total FROM belabox_streams WHERE channel_id = ? AND stream_id = ?",
    ).bind(CHANNEL_ID, STREAM_ID).first<{ low_seconds: number; dropped_total: number }>();
    const minutes = await database.prepare(
      "SELECT dropped_delta FROM belabox_minutes WHERE channel_id = ? AND stream_id = ?",
    ).bind(CHANNEL_ID, STREAM_ID).first<{ dropped_delta: number }>();
    expect(status?.historyModuleRevision).toBe(3);
    expect(status?.historySample?.at).toBe(new Date().toISOString());
    expect(stream).toEqual({ low_seconds: 5, dropped_total: 7 });
    expect(minutes?.dropped_delta).toBe(0);
  });

  it("does not let a delayed disable finalizer close a summary after re-enable", async () => {
    await insertModule(database, BELABOX_DEFAULT_SETTINGS, false);
    const previous = normalizedSample("2026-10-05T11:59:50.000Z", 2_400, 7);
    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, polling, stream_id, belabox_stream_id, history_sample_json,
         history_module_revision, fetch_phase_json, recent_json, revision)
       VALUES (?, 1, ?, ?, ?, 1, '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, STREAM_ID, STREAM_ID, JSON.stringify(previous)).run();
    await database.prepare(
      `INSERT INTO belabox_streams (channel_id, stream_id, started_at, samples, bitrate_avg)
       VALUES (?, ?, '2026-10-05T11:50:00.000Z', 1, 2_400)`,
    ).bind(CHANNEL_ID, STREAM_ID).run();

    const batchStarted = deferred<boolean>();
    const releaseBatch = deferred<boolean>();
    const delayedDatabase = {
      prepare: (sql: string) => database.prepare(sql),
      batch: async (statements: Parameters<TestD1Database["batch"]>[0]) => {
        batchStarted.resolve(true);
        await releaseBatch.promise;
        return database.batch(statements);
      },
    } as unknown as D1Database;
    const { context, scheduled } = alarmContext(database);
    const delayedContext = { ...context, DB: delayedDatabase };
    const stopRun = handleBelaboxPollAlarm(delayedContext, "poll", Date.now());
    await batchStarted.promise;
    await database.prepare(
      "UPDATE channel_modules SET enabled = 1, revision = revision + 1 WHERE channel_id = ? AND module_id = 'belabox'",
    ).bind(CHANNEL_ID).run();
    releaseBatch.resolve(true);
    await stopRun;

    const stream = await database.prepare(
      "SELECT ended_at FROM belabox_streams WHERE channel_id = ? AND stream_id = ?",
    ).bind(CHANNEL_ID, STREAM_ID).first<{ ended_at: string | null }>();
    expect(stream?.ended_at).toBeNull();
    expect(await getBelaboxStatus(delayedDatabase, CHANNEL_ID)).toMatchObject({ polling: true, historySample: previous });
    expect(scheduled).toEqual([{ key: "poll", deadline: Date.now() }]);
  });

  it("rejects a poll batch if the module is disabled after its state snapshot", async () => {
    await insertModule(database);
    const previous = normalizedSample("2026-10-05T11:59:45.000Z", 3_200, 7);
    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, polling, stream_id, belabox_stream_id, history_sample_json,
         history_module_revision, fetch_phase_json, recent_json, revision)
       VALUES (?, 1, ?, ?, ?, 1, '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, STREAM_ID, STREAM_ID, JSON.stringify(previous)).run();
    await database.prepare(
      `INSERT INTO belabox_streams (channel_id, stream_id, started_at, samples, bitrate_avg)
       VALUES (?, ?, '2026-10-05T11:50:00.000Z', 1, 3_200)`,
    ).bind(CHANNEL_ID, STREAM_ID).run();

    let changed = false;
    const delayedDatabase = {
      prepare: (sql: string) => database.prepare(sql),
      batch: async (statements: Parameters<TestD1Database["batch"]>[0]) => {
        if (!changed && statements.length === 3) {
          changed = true;
          await database.prepare(
            `UPDATE channel_modules SET enabled = 0, revision = revision + 1
              WHERE channel_id = ? AND module_id = 'belabox'`,
          ).bind(CHANNEL_ID).run();
        }
        return database.batch(statements);
      },
    } as unknown as D1Database;
    const { context } = alarmContext(database);
    await handleBelaboxPollAlarm(
      { ...context, DB: delayedDatabase },
      BELABOX_POLL_ALARM_KEY,
      Date.now(),
      undefined,
      () => Promise.resolve(jsonResponse(relayPayload(true, 3_200, 12))),
    );

    const summary = await database.prepare(
      `SELECT samples, ended_at FROM belabox_streams WHERE channel_id = ? AND stream_id = ?`,
    ).bind(CHANNEL_ID, STREAM_ID).first<{ samples: number; ended_at: string | null }>();
    const minutes = await database.prepare(
      "SELECT COUNT(*) AS count FROM belabox_minutes WHERE channel_id = ? AND stream_id = ?",
    ).bind(CHANNEL_ID, STREAM_ID).first<{ count: number }>();
    expect(summary).toEqual({ samples: 1, ended_at: new Date().toISOString() });
    expect(minutes).toEqual({ count: 0 });
    expect(await getBelaboxStatus(delayedDatabase, CHANNEL_ID)).toMatchObject({
      polling: false,
      historySample: null,
      historyModuleRevision: null,
    });
  });

  it("rejects history writes when the stored live stream changes after the poll snapshot", async () => {
    await insertModule(database);
    const previous = normalizedSample("2026-10-05T11:59:45.000Z", 3_200, 7);
    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, polling, stream_id, belabox_stream_id, history_sample_json,
         history_module_revision, fetch_phase_json, recent_json, revision)
       VALUES (?, 1, ?, ?, ?, 1, '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, STREAM_ID, STREAM_ID, JSON.stringify(previous)).run();

    let changed = false;
    const delayedDatabase = {
      prepare: (sql: string) => database.prepare(sql),
      batch: async (statements: Parameters<TestD1Database["batch"]>[0]) => {
        if (!changed && statements.length === 3) {
          changed = true;
          await setStoredStreamId(database, "stream-after-snapshot");
        }
        return database.batch(statements);
      },
    } as unknown as D1Database;
    const { context, scheduled } = alarmContext(database);
    await handleBelaboxPollAlarm(
      { ...context, DB: delayedDatabase },
      BELABOX_POLL_ALARM_KEY,
      Date.now(),
      undefined,
      () => Promise.resolve(jsonResponse(relayPayload(true, 3_200, 12))),
    );

    expect(await getBelaboxStatus(delayedDatabase, CHANNEL_ID)).toMatchObject({
      sample: null,
      historySample: null,
      historyModuleRevision: null,
    });
    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM belabox_minutes WHERE channel_id = ?",
    ).bind(CHANNEL_ID).first<{ count: number }>()).resolves.toEqual({ count: 0 });
    expect(scheduled).toHaveLength(1);
  });

  it.each([
    ["low bitrate", normalizedSample("2026-10-05T11:59:00.000Z", 500), 6, 9],
    ["disconnected", { ...normalizedSample("2026-10-05T11:59:00.000Z", 0), connected: false }, 6, 9],
  ] as const)("does not add a stale %s baseline to a finalized summary", async (_name, sample, lowSeconds, disconnectedSeconds) => {
    await insertModule(database);
    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, polling, stream_id, belabox_stream_id, history_sample_json,
         history_module_revision, fetch_phase_json, recent_json, revision)
       VALUES (?, 1, ?, ?, ?, 1, '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, STREAM_ID, STREAM_ID, JSON.stringify(sample)).run();
    await database.prepare(
      `INSERT INTO belabox_streams
        (channel_id, stream_id, started_at, samples, bitrate_avg, low_seconds, disconnected_seconds)
       VALUES (?, ?, '2026-10-05T11:50:00.000Z', 1, 2_400, ?, ?)`,
    ).bind(CHANNEL_ID, STREAM_ID, lowSeconds, disconnectedSeconds).run();
    await database.prepare(
      `UPDATE channel_modules SET settings = ?, revision = revision + 1
        WHERE channel_id = ? AND module_id = 'belabox'`,
    ).bind(JSON.stringify({ mode: "on_demand", intervalSeconds: 15 }), CHANNEL_ID).run();
    const { context } = alarmContext(database);

    await handleBelaboxPollAlarm(context, BELABOX_POLL_ALARM_KEY, Date.now());

    await expect(database.prepare(
      `SELECT ended_at, low_seconds, disconnected_seconds
         FROM belabox_streams WHERE channel_id = ? AND stream_id = ?`,
    ).bind(CHANNEL_ID, STREAM_ID).first<Record<string, unknown>>()).resolves.toEqual({
      ended_at: new Date().toISOString(),
      low_seconds: lowSeconds,
      disconnected_seconds: disconnectedSeconds,
    });
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      polling: false,
      historySample: null,
      historyModuleRevision: null,
    });
  });

  it("finalizes an offline summary at the offline time when the alarm runs late", async () => {
    await insertModule(database);
    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, polling, stream_id, belabox_stream_id, history_sample_json,
         history_module_revision, fetch_phase_json, recent_json, revision)
       VALUES (?, 1, ?, ?, ?, 1, '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, STREAM_ID, STREAM_ID, JSON.stringify(normalizedSample("2026-10-05T12:00:00.000Z", 500))).run();
    await database.prepare(
      `INSERT INTO belabox_streams (channel_id, stream_id, started_at, samples, bitrate_avg)
       VALUES (?, ?, '2026-10-05T11:50:00.000Z', 1, 500)`,
    ).bind(CHANNEL_ID, STREAM_ID).run();
    vi.setSystemTime(new Date("2026-10-05T12:00:10.000Z"));
    await setStoredStreamState(database, "offline", null);
    vi.setSystemTime(new Date("2026-10-05T12:00:25.000Z"));
    const { context } = alarmContext(database);

    await handleBelaboxPollAlarm(context, BELABOX_POLL_ALARM_KEY, Date.now());

    await expect(database.prepare(
      `SELECT ended_at, low_seconds FROM belabox_streams WHERE channel_id = ? AND stream_id = ?`,
    ).bind(CHANNEL_ID, STREAM_ID).first<Record<string, unknown>>()).resolves.toEqual({
      ended_at: "2026-10-05T12:00:10.000Z",
      low_seconds: 10,
    });
  });

  it("does not let a delayed finalizer commit after the stream snapshot changes", async () => {
    await insertModule(database);
    const previous = normalizedSample("2026-10-05T11:59:45.000Z", 500, 7);
    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, polling, stream_id, belabox_stream_id, history_sample_json,
         history_module_revision, fetch_phase_json, recent_json, revision)
       VALUES (?, 1, ?, ?, ?, 1, '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, STREAM_ID, STREAM_ID, JSON.stringify(previous)).run();
    await database.prepare(
      `INSERT INTO belabox_streams (channel_id, stream_id, started_at, samples, bitrate_avg)
       VALUES (?, ?, '2026-10-05T11:50:00.000Z', 1, 2_400)`,
    ).bind(CHANNEL_ID, STREAM_ID).run();
    await setStoredStreamState(database, "offline", null);

    const batchStarted = deferred<undefined>();
    const releaseBatch = deferred<undefined>();
    let delayed = false;
    const delayedDatabase = {
      prepare: (sql: string) => database.prepare(sql),
      batch: async (statements: Parameters<TestD1Database["batch"]>[0]) => {
        if (!delayed) {
          delayed = true;
          batchStarted.resolve(undefined);
          await releaseBatch.promise;
        }
        return database.batch(statements);
      },
    } as unknown as D1Database;
    const { context, scheduled } = alarmContext(database);
    const running = handleBelaboxPollAlarm(
      { ...context, DB: delayedDatabase },
      BELABOX_POLL_ALARM_KEY,
      Date.now(),
    );

    await batchStarted.promise;
    await setStoredStreamState(database, "online", "stream-after-finalizer-snapshot");
    releaseBatch.resolve(undefined);
    await running;

    await expect(database.prepare(
      `SELECT ended_at, low_seconds FROM belabox_streams WHERE channel_id = ? AND stream_id = ?`,
    ).bind(CHANNEL_ID, STREAM_ID).first<Record<string, unknown>>()).resolves.toEqual({
      ended_at: null,
      low_seconds: 0,
    });
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      polling: true,
      historySample: previous,
      historyModuleRevision: 1,
    });
    expect(scheduled).toEqual([{ key: "poll", deadline: Date.now() }]);
  });

  it("clears the history baseline when a relay poll fails", async () => {
    await insertModule(database);
    const previous = normalizedSample("2026-10-05T11:59:50.000Z", 2_400, 7);
    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, polling, stream_id, belabox_stream_id, history_sample_json,
         history_module_revision, fetch_phase_json, recent_json, revision)
       VALUES (?, 1, ?, ?, ?, 1, '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, STREAM_ID, STREAM_ID, JSON.stringify(previous)).run();
    const { context } = alarmContext(database);

    await handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, () => Promise.resolve(new Response("unavailable", { status: 503 })));

    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({ historySample: null, historyModuleRevision: null });
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
    if (scenario.state === "offline") await setStoredStreamState(database, "offline", null);
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
        (channel_id, polling, stream_id, belabox_stream_id, history_sample_json,
         history_module_revision, fetch_phase_json, recent_json, revision)
       VALUES (?, 1, ?, ?, ?, 1, '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, STREAM_ID, STREAM_ID,
      JSON.stringify(normalizedSample("2026-10-05T11:59:45.000Z", 3_200, 7))).run();
    const { context, scheduled, cleared } = alarmContext(database);
    const originalPrepare = context.DB.prepare.bind(context.DB);
    let failed = false;
    vi.spyOn(context.DB, "prepare").mockImplementation((sql) => {
        const statement = originalPrepare(sql);
        if (!sql.includes("SELECT enabled, settings, revision FROM channel_modules")) return statement;
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
    expect(await getBelaboxStatus(database as unknown as D1Database, CHANNEL_ID)).toMatchObject({
      polling: true,
      historySample: null,
      historyModuleRevision: null,
    });
  });

  it("stops with a fixed status code when the secret is missing or undecryptable", async () => {
    await insertModule(database);
    const { context, scheduled, cleared } = alarmContext(database, {
      secrets: { ...secretAccess(), readWithVersion: () => Promise.resolve(null) },
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

  it("keeps the alarm on a storage failure reading the secret and polls on the retry", async () => {
    await insertModule(database);
    let failed = false;
    const { context, scheduled, cleared } = alarmContext(database, {
      secrets: {
        ...secretAccess(),
        readWithVersion: () => {
          if (failed) return secretAccess().readWithVersion("x");
          failed = true;
          return Promise.reject(new Error(SECRET_SENTINEL));
        },
      },
    });
    const fetcher = vi.fn<typeof fetch>(() => Promise.resolve(jsonResponse(relayPayload(true))));

    await expect(handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, fetcher)).resolves.toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect(cleared).toEqual([]);
    expect(scheduled).toHaveLength(1);
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).not.toMatchObject({ errorCode: "not_configured" });

    await expect(handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, fetcher)).resolves.toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(scheduled).toHaveLength(2);
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({ polling: true });
  });

  it("checks disabled offline stop conditions before reading the secret", async () => {
    await insertModule(database, BELABOX_DEFAULT_SETTINGS, false);
    await setStoredStreamState(database, "offline", null);
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

  it("clears the prior stream sample and enrichment on an offline reset", async () => {
    await insertModule(database);
    await setStoredStreamState(database, "offline", null);
    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, sampled_at, sample_json, polling, stream_id, belabox_stream_id,
         fetch_phase_json, recent_json, revision)
       VALUES (?, ?, ?, 1, ?, ?, '{}', '[]', 1)`,
    ).bind(
      CHANNEL_ID,
      "2026-10-05T11:59:50.000Z",
      JSON.stringify({
        ...normalizedSample("2026-10-05T11:59:50.000Z", 900),
        droppedTotal: 42,
        phase: "low",
        alertStartedAt: "2026-10-05T11:58:00.000Z",
      }),
      STREAM_ID,
      STREAM_ID,
    ).run();
    const { context, overlayMessages } = alarmContext(database, { streamState: "offline" });

    await handleBelaboxPollAlarm(context, BELABOX_POLL_ALARM_KEY, Date.now());

    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      polling: false,
      streamId: null,
      belaboxStreamId: null,
      sample: null,
      recent: [],
    });
    expect(overlayMessages).toEqual([{
      type: "state_changed",
      elementKind: "belabox.status",
      payload: { reason: "stream.state.changed" },
    }]);
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
    await database.prepare("DELETE FROM channel_stream_state WHERE channel_id = ?").bind(CHANNEL_ID).run();
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

  it("does not emit fetch diagnostics before the stream is classified as BELABOX", async () => {
    await insertModule(database);
    const { context, diagnostics } = alarmContext(database);
    const failing = vi.fn<typeof fetch>(() => Promise.reject(new TypeError("relay unavailable")));

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await handleBelaboxPollAlarm(context, "poll", Date.now(), undefined, failing);
      vi.setSystemTime(Date.now() + 15_000);
    }

    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      fetchPhase: { consecutiveFailures: 4, failing: true },
      belaboxStreamId: null,
    });
    expect(diagnostics).toEqual([]);
    await expect(database.prepare(
      "SELECT COUNT(*) AS count FROM event_log WHERE channel_id = ?",
    ).bind(CHANNEL_ID).first()).resolves.toEqual({ count: 0 });
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
    const { context } = alarmContext(database, { externalFetchBudget });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(relayPayload(true)));

    const first = await pollOnDemand(context, fetcher);
    vi.setSystemTime(Date.now() + 9_999);
    const cached = await pollOnDemand(context, fetcher);
    expect(cached).toEqual(first);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(externalFetchBudget.claim).toHaveBeenCalledOnce();
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({ polling: false, recent: [] });

    vi.setSystemTime(Date.now() + 2);
    await pollOnDemand(context, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps accumulated enrichment for online sessions without a Twitch stream ID", async () => {
    await insertModule(database, { mode: "on_demand", intervalSeconds: 15 });
    const changedAt = "2026-10-05T11:59:00.000Z";
    const startedAt = "2026-10-05T11:50:00.000Z";
    await database.prepare(
      `UPDATE channel_stream_state
          SET state = 'online', changed_at = ?, source = 'eventsub', started_at = ?, stream_id = NULL
        WHERE channel_id = ?`,
    ).bind(changedAt, startedAt, CHANNEL_ID).run();
    const { context } = alarmContext(database);
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(relayPayload(true, 800, 7)))
      .mockResolvedValueOnce(jsonResponse(relayPayload(true, 800, 11)));

    const first = await pollOnDemand(context, fetcher);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("The first sample should be stored.");
    vi.setSystemTime(Date.now() + 10_001);
    const second = await pollOnDemand(context, fetcher);

    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("The second sample should be stored.");
    expect(second.sample).toMatchObject({ droppedTotal: 4, phase: "low", alertStartedAt: first.sample.at });
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
      streamSessionKey: `started:${startedAt}:${changedAt}`,
      sample: { droppedTotal: 4, phase: "low", alertStartedAt: first.sample.at },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each(["interval", "on_demand"] as const)(
    "starts sample enrichment fresh when the first fetch for a new stream fails in %s mode",
    async (mode) => {
      await insertModule(database, { mode, intervalSeconds: 15 });
      const previousAt = new Date(Date.now() - 30_000).toISOString();
      const previousAlertStartedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
      await database.prepare(
        `UPDATE channel_stream_state
            SET state = 'online', changed_at = ?, source = 'eventsub', started_at = ?, stream_id = 'stream-s2'
          WHERE channel_id = ?`,
      ).bind(new Date(Date.now() - 1_000).toISOString(), new Date(Date.now() - 1_000).toISOString(), CHANNEL_ID).run();
      await database.prepare(
        `INSERT INTO belabox_status
          (channel_id, sampled_at, sample_json, polling, stream_id, stream_session_key, belabox_stream_id,
           fetch_phase_json, recent_json, revision)
         VALUES (?, ?, ?, 1, 'stream-s1', 'stream:stream-s1', 'stream-s1', '{}', '[]', 1)`,
      ).bind(CHANNEL_ID, previousAt, JSON.stringify({
        ...normalizedSample(previousAt, 800),
        droppedPackets: 4,
        droppedTotal: 5,
        phase: "low",
        alertStartedAt: previousAlertStartedAt,
      })).run();

      const { context } = alarmContext(database);
      const fetcher = vi.fn<typeof fetch>()
        .mockRejectedValueOnce(new TypeError("relay unavailable"))
        .mockResolvedValueOnce(jsonResponse(relayPayload(true, 800, 10)));
      const fetchSample = async (): Promise<void> => {
        if (mode === "on_demand") {
          await pollOnDemand(context, fetcher);
        } else {
          await handleBelaboxPollAlarm(context, BELABOX_POLL_ALARM_KEY, Date.now(), undefined, fetcher);
        }
      };

      await fetchSample();
      expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toMatchObject({
        errorCode: "network",
        streamSessionKey: "stream:stream-s2",
        sample: null,
      });
      const afterFailure = await database.prepare(
        "SELECT sampled_at, sample_json FROM belabox_status WHERE channel_id = ?",
      ).bind(CHANNEL_ID).first();
      expect(afterFailure).toEqual({ sampled_at: null, sample_json: null });

      await fetchSample();
      const status = await getBelaboxStatus(context.DB, CHANNEL_ID);
      expect(status).toMatchObject({
        streamSessionKey: "stream:stream-s2",
        sample: { droppedTotal: 0, phase: "low" },
      });
      expect(status?.sample?.alertStartedAt).toBe(status?.sample?.at);
      expect(status?.sample?.alertStartedAt).not.toBe(previousAlertStartedAt);
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it("discards a delayed on-demand sample across offline reset and starts new-stream enrichment fresh", async () => {
    await insertModule(database, { mode: "on_demand", intervalSeconds: 15 });
    const firstAt = "2026-10-05T11:59:00.000Z";
    const previousAlertStartedAt = "2026-10-05T10:00:00.000Z";
    const firstSession = {
      state: "online",
      changed_at: firstAt,
      source: "eventsub",
      started_at: "2026-10-05T11:50:00.000Z",
      stream_id: "stream-s1",
    };
    await database.prepare(
      `UPDATE channel_stream_state
          SET state = ?, changed_at = ?, source = ?, started_at = ?, stream_id = ?
        WHERE channel_id = ?`,
    ).bind(firstSession.state, firstSession.changed_at, firstSession.source,
      firstSession.started_at, firstSession.stream_id, CHANNEL_ID).run();
    await database.prepare(
      `INSERT INTO belabox_status
        (channel_id, sampled_at, sample_json, polling, stream_id, belabox_stream_id,
         fetch_phase_json, recent_json, revision)
       VALUES (?, ?, ?, 1, 'stream-s1', 'stream-s1', '{}', '[]', 1)`,
    ).bind(CHANNEL_ID, firstAt, JSON.stringify({
      ...normalizedSample(firstAt, 800),
      droppedTotal: 5,
      phase: "low",
      alertStartedAt: previousAlertStartedAt,
    })).run();

    const { context } = alarmContext(database);
    const started = deferred<undefined>();
    const delayedResponse = deferred<Response>();
    let fetchCount = 0;
    const fetcher = vi.fn<typeof fetch>(() => {
      fetchCount += 1;
      if (fetchCount === 1) {
        started.resolve(undefined);
        return delayedResponse.promise;
      }
      return Promise.resolve(jsonResponse(relayPayload(true, 900)));
    });
    const delayed = pollOnDemand(context, fetcher);
    await started.promise;

    await database.prepare(
      `UPDATE channel_stream_state
          SET state = 'offline', changed_at = ?, started_at = NULL, stream_id = NULL
        WHERE channel_id = ?`,
    ).bind("2026-10-05T12:00:00.000Z", CHANNEL_ID).run();
    await handleBelaboxPollAlarm(context, BELABOX_POLL_ALARM_KEY, Date.now());
    await database.prepare(
      `UPDATE channel_stream_state
          SET state = 'online', changed_at = ?, started_at = ?, stream_id = ?
        WHERE channel_id = ?`,
    ).bind("2026-10-05T12:00:05.000Z", "2026-10-05T12:00:05.000Z", "stream-s2", CHANNEL_ID).run();

    const newStream = await pollOnDemand(context, fetcher);
    expect(newStream.ok).toBe(true);
    if (!newStream.ok) throw new Error("The new stream sample should be persisted.");
    expect(newStream.sample).toMatchObject({ droppedTotal: 0, phase: "low" });
    expect(newStream.sample.alertStartedAt).toBe(newStream.sample.at);
    const storedNewStream = await getBelaboxStatus(context.DB, CHANNEL_ID);
    expect(storedNewStream).toMatchObject({
      streamId: "stream-s2",
      sample: { droppedTotal: 0, phase: "low", alertStartedAt: newStream.sample.at },
    });

    delayedResponse.resolve(jsonResponse(relayPayload(true, 1_000)));
    await expect(delayed).resolves.toEqual({ ok: false, reason: "stream_changed" });
    expect(await getBelaboxStatus(context.DB, CHANNEL_ID)).toEqual(storedNewStream);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("discards a delayed fetch when the offline session changes through a new stream", async () => {
    await insertModule(database, { mode: "on_demand", intervalSeconds: 15 });
    const offlineAt = "2026-10-05T12:00:00.000Z";
    await database.prepare(
      `UPDATE channel_stream_state
          SET state = 'offline', changed_at = ?, source = 'eventsub', started_at = NULL, stream_id = NULL
        WHERE channel_id = ?`,
    ).bind(offlineAt, CHANNEL_ID).run();
    const { context } = alarmContext(database);
    const started = deferred<undefined>();
    const delayedResponse = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>(() => {
      started.resolve(undefined);
      return delayedResponse.promise;
    });
    const delayed = pollOnDemand(context, fetcher);
    await started.promise;

    await database.prepare(
      `UPDATE channel_stream_state
          SET state = 'online', changed_at = ?, started_at = ?, stream_id = ?
        WHERE channel_id = ?`,
    ).bind("2026-10-05T12:00:05.000Z", "2026-10-05T12:00:05.000Z", "stream-cycle", CHANNEL_ID).run();
    await database.prepare(
      `UPDATE channel_stream_state
          SET state = 'offline', changed_at = ?, started_at = NULL, stream_id = NULL
        WHERE channel_id = ?`,
    ).bind("2026-10-05T12:00:10.000Z", CHANNEL_ID).run();

    delayedResponse.resolve(jsonResponse(relayPayload(true)));
    await expect(delayed).resolves.toEqual({ ok: false, reason: "stream_changed" });
    await expect(getBelaboxStatus(context.DB, CHANNEL_ID)).resolves.toBeNull();
  });

  it("writes on-demand fetch diagnostics only at phase changes for a classified BELABOX stream", async () => {
    await insertModule(database, { mode: "on_demand", intervalSeconds: 15 });
    await database.prepare(
      `UPDATE channel_stream_state
          SET state = 'online', changed_at = '2026-10-05T11:59:00.000Z', source = 'eventsub', stream_id = ?
        WHERE channel_id = ?`,
    ).bind(STREAM_ID, CHANNEL_ID).run();
    await database.prepare(
      "INSERT INTO belabox_status (channel_id, polling, stream_id, belabox_stream_id, fetch_phase_json, recent_json, revision) VALUES (?, 0, ?, ?, '{}', '[]', 1)",
    ).bind(CHANNEL_ID, STREAM_ID, STREAM_ID).run();
    const { context } = alarmContext(database, {
      writeDiagnostics: (triggerId, entries, now) =>
        writeModuleDiagnostics(database as unknown as D1Database, CHANNEL_ID, "belabox", triggerId, null, entries, now),
    });
    const failing = vi.fn<typeof fetch>(() => Promise.reject(new TypeError(`failed ${STATS_URL}`)));

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await pollOnDemand(context, failing);
      vi.setSystemTime(Date.now() + 1_000);
    }
    await pollOnDemand(context, () => Promise.resolve(jsonResponse(relayPayload(true))));

    const logged = await database.prepare(
      "SELECT code, detail_json FROM event_log WHERE channel_id = ? ORDER BY created_at, rowid",
    ).bind(CHANNEL_ID).all<{ code: string; detail_json: string }>();
    expect(logged.results).toEqual([
      { code: "belabox.fetch_failing", detail_json: JSON.stringify({ reason: "network" }) },
      { code: "belabox.fetch_recovered", detail_json: JSON.stringify({ reason: "fetch_succeeded" }) },
    ]);
  });

});
