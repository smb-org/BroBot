import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleBlitzAutoStartAlarm, onBlitzPointRoundOpened, onBlitzPointRoundResolved, reconcileBlitzAutoStart } from "../../src/modules/blitz_round/auto-start";
import { blitzRoundSettingsSchema } from "../../src/modules/blitz_round/contracts";
import type { ModuleAlarmContext } from "../../src/modules/contract";
import { openBlitzRound } from "../../src/modules/blitz_round/service";

vi.mock("../../src/modules/blitz_round/service", () => ({ openBlitzRound: vi.fn() }));

const minute = 60_000;
const intervalMs = 15 * minute;
const stateKey = "auto-start-state";
const alarmKey = "auto-start";
const openingRound = (roundId: string, baseline = "0:1") => ({
  roundId,
  data: { autoStartBaseline: baseline },
  text: "Blitz round",
});

const setup = () => {
  let moduleEnabled = true;
  let moduleRevision = 1;
  let settingsRevision = 1;
  let settings = { autoStart: true, autoStartIntervalMinutes: 15 };
  let stream: "online" | "offline" | "unknown" = "online";
  let active: { roundId: string; state: "announcing" | "open"; data: unknown; deadlineAt: number | null } | null = null;
  let failSchedule = false;
  const storage = new Map<string, unknown>();
  const scheduled = new Map<string, { deadline: number; identity: unknown }>();
  const context = {
    DB: {
      prepare: () => ({ bind: () => ({ first: () => Promise.resolve({
        enabled: moduleEnabled ? 1 : 0,
        settings: JSON.stringify(settings),
        revision: moduleRevision,
        settings_revision: settingsRevision,
      }) }) }),
    },
    channelId: "fictional_blitz_channel",
    storage: {
      get: (key: string) => Promise.resolve(storage.get(key)),
      put: (key: string, value: unknown) => { storage.set(key, value); return Promise.resolve(); },
      delete: (key: string) => { storage.delete(key); return Promise.resolve(); },
    },
    schedule: (key: string, deadline: number, _owner: number | undefined, _stream: number | null | undefined,
      identity: unknown) => {
      if (failSchedule) {
        failSchedule = false;
        return Promise.reject(new Error("schedule_failed"));
      }
      scheduled.set(key, { deadline, identity });
      return Promise.resolve();
    },
    clear: (key: string) => { scheduled.delete(key); return Promise.resolve(); },
    getAlarmPlan: (key: string) => {
      const entry = scheduled.get(key);
      return Promise.resolve(entry === undefined ? null : { identity: entry.identity as never, planSequence: null });
    },
    streamState: () => Promise.resolve(stream),
    points: { rounds: { active: () => Promise.resolve(active) } },
    channelLanguage: () => Promise.resolve("en"),
    state: {
      setModule: (enabled: boolean, revision: number) => { moduleEnabled = enabled; moduleRevision = revision; },
      setSettings: (next: typeof settings, revision: number, moduleRowRevision = moduleRevision) => {
        settings = next;
        settingsRevision = revision;
        moduleRevision = moduleRowRevision;
      },
      setStream: (next: typeof stream) => { stream = next; },
      setActive: (next: typeof active) => { active = next; },
      failNextSchedule: () => { failSchedule = true; },
      storage,
      scheduled,
      deliverAlarm: async (key: string) => {
        const alarm = scheduled.get(key);
        if (alarm === undefined) throw new Error(`No scheduled alarm for ${key}.`);
        scheduled.delete(key);
        await handleBlitzAutoStartAlarm(context as unknown as ModuleAlarmContext, key, alarm.deadline);
      },
    },
  };
  vi.mocked(openBlitzRound).mockImplementation((input) => {
    const opened = { roundId: "fictional-auto-round", data: { autoStartBaseline: input.autoStartBaseline } } as
      unknown as Awaited<ReturnType<typeof openBlitzRound>>;
    active = { roundId: opened.roundId, state: "announcing", data: opened.data, deadlineAt: null };
    return Promise.resolve(opened);
  });
  return { context: context as unknown as ModuleAlarmContext, state: context.state };
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2030, 0, 1));
  vi.mocked(openBlitzRound).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Blitz automatic start settings", () => {
  it("defaults automatic start to off with a 15 minute interval", () => {
    expect(blitzRoundSettingsSchema.parse({}).autoStart).toBe(false);
    expect(blitzRoundSettingsSchema.parse({}).autoStartIntervalMinutes).toBe(15);
  });

  it.each([15, 240])("accepts the %i minute interval boundary", (minutes) => {
    expect(blitzRoundSettingsSchema.safeParse({ autoStart: true, autoStartIntervalMinutes: minutes }).success).toBe(true);
  });

  it.each([14, 241, 15.5])("rejects an invalid %s minute interval", (minutes) => {
    expect(blitzRoundSettingsSchema.safeParse({ autoStartIntervalMinutes: minutes }).success).toBe(false);
  });
});

describe("Blitz automatic start scheduling", () => {
  it("keeps the preserved live time when a delayed resolution is replayed after offline time", async () => {
    const fixture = setup();
    await reconcileBlitzAutoStart(fixture.context, "activation");
    const round = openingRound("fictional-round-one");
    fixture.state.setActive({ roundId: round.roundId, state: "announcing", data: round.data, deadlineAt: null });
    await onBlitzPointRoundOpened(fixture.context, round);
    fixture.state.setActive(null);
    const watchdog = fixture.state.scheduled.get(alarmKey);
    vi.setSystemTime(watchdog?.deadline ?? Date.now());
    Object.assign(fixture.context, { alarmIdentity: watchdog?.identity });
    await handleBlitzAutoStartAlarm(fixture.context, alarmKey, watchdog?.deadline ?? 0);

    vi.advanceTimersByTime(5 * minute);
    fixture.state.setStream("offline");
    await reconcileBlitzAutoStart(fixture.context, "stream_state");
    expect(fixture.state.storage.get(stateKey)).toMatchObject({ remainingMs: 10 * minute, deadlineAt: null, mode: "paused" });

    vi.advanceTimersByTime(60 * minute);
    fixture.state.setStream("online");
    await reconcileBlitzAutoStart(fixture.context, "stream_state");
    const resumedDeadline = fixture.state.scheduled.get(alarmKey)?.deadline;
    await onBlitzPointRoundResolved(fixture.context, { ...openingRound("fictional-round-one"), result: {}, resolvedAt: new Date().toISOString() });

    expect(fixture.state.scheduled.get(alarmKey)?.deadline).toBe(resumedDeadline);
    expect(resumedDeadline).toBe(Date.now() + 10 * minute);
  });

  it("keeps the watchdog armed when a round remains open through a watchdog check", async () => {
    const fixture = setup();
    await reconcileBlitzAutoStart(fixture.context, "activation");
    const round = openingRound("fictional-long-round");
    fixture.state.setActive({ roundId: round.roundId, state: "announcing", data: round.data, deadlineAt: null });
    await onBlitzPointRoundOpened(fixture.context, round);
    fixture.state.setActive({ roundId: round.roundId, state: "open", data: round.data, deadlineAt: null });
    const firstWatchdog = fixture.state.scheduled.get(alarmKey);
    vi.setSystemTime(firstWatchdog?.deadline ?? Date.now());
    Object.assign(fixture.context, { alarmIdentity: firstWatchdog?.identity });

    await handleBlitzAutoStartAlarm(fixture.context, alarmKey, firstWatchdog?.deadline ?? 0);

    expect(fixture.state.scheduled.get(alarmKey)?.deadline).toBe(Date.now() + 60_000);
    expect(fixture.state.storage.get(stateKey)).toMatchObject({ awaitingRoundId: "fictional-long-round" });
    expect(openBlitzRound).not.toHaveBeenCalled();
  });

  it("finishes watchdog recovery when only an older-baseline round is active", async () => {
    const fixture = setup();
    await reconcileBlitzAutoStart(fixture.context, "activation");
    const oldRound = openingRound("fictional-watchdog-old-round", "0:1");
    fixture.state.setActive({ roundId: oldRound.roundId, state: "open", data: oldRound.data, deadlineAt: null });
    await onBlitzPointRoundOpened(fixture.context, oldRound);

    fixture.state.setSettings({ autoStart: true, autoStartIntervalMinutes: 30 }, 2, 2);
    await reconcileBlitzAutoStart(fixture.context, "settings");
    const currentRound = openingRound("fictional-watchdog-current-round", "0:2");
    fixture.state.setActive({ roundId: currentRound.roundId, state: "open", data: currentRound.data, deadlineAt: null });
    await onBlitzPointRoundOpened(fixture.context, currentRound);

    fixture.state.setActive({ roundId: oldRound.roundId, state: "open", data: oldRound.data, deadlineAt: null });
    const watchdog = fixture.state.scheduled.get(alarmKey);
    vi.setSystemTime(watchdog?.deadline ?? Date.now());
    Object.assign(fixture.context, { alarmIdentity: watchdog?.identity });

    await handleBlitzAutoStartAlarm(fixture.context, alarmKey, watchdog?.deadline ?? 0);

    expect(fixture.state.storage.get(stateKey)).toMatchObject({ baseline: "0:2", awaitingRoundId: null });
    expect(fixture.state.scheduled.get(alarmKey)?.deadline).toBe(Date.now() + 30 * minute);
  });

  it("starts a full new interval when Blitz is re-enabled", async () => {
    const fixture = setup();
    await reconcileBlitzAutoStart(fixture.context, "activation");
    vi.advanceTimersByTime(5 * minute);
    fixture.state.setModule(false, 2);
    await reconcileBlitzAutoStart(fixture.context, "activation");
    expect(fixture.state.scheduled.has(alarmKey)).toBe(false);

    vi.advanceTimersByTime(5 * minute);
    fixture.state.setModule(true, 3);
    await reconcileBlitzAutoStart(fixture.context, "activation");

    expect(fixture.state.scheduled.get(alarmKey)?.deadline).toBe(Date.now() + intervalMs);
    expect(fixture.state.storage.get(stateKey)).toMatchObject({ moduleActivationRevision: 2 });
  });

  it("clears the schedule while automatic start is off and starts fresh when it is turned on", async () => {
    const fixture = setup();
    await reconcileBlitzAutoStart(fixture.context, "activation");
    vi.advanceTimersByTime(5 * minute);
    fixture.state.setSettings({ autoStart: false, autoStartIntervalMinutes: 15 }, 2, 2);
    await reconcileBlitzAutoStart(fixture.context, "settings");

    expect(fixture.state.storage.has(stateKey)).toBe(false);
    expect(fixture.state.scheduled.has(alarmKey)).toBe(false);

    fixture.state.setSettings({ autoStart: true, autoStartIntervalMinutes: 30 }, 3, 3);
    await reconcileBlitzAutoStart(fixture.context, "settings");

    expect(fixture.state.storage.get(stateKey)).toMatchObject({ baseline: "0:3", intervalMinutes: 30 });
    expect(fixture.state.scheduled.get(alarmKey)?.deadline).toBe(Date.now() + 30 * minute);
  });

  it("does not carry an awaiting round across coalesced disable and re-enable notifications", async () => {
    const fixture = setup();
    await reconcileBlitzAutoStart(fixture.context, "activation");
    const oldRound = openingRound("fictional-coalesced-old-round", "0:1");
    fixture.state.setActive({ roundId: oldRound.roundId, state: "announcing", data: oldRound.data, deadlineAt: null });
    await onBlitzPointRoundOpened(fixture.context, oldRound);

    fixture.state.setActive(null);
    fixture.state.setModule(false, 2);
    fixture.state.setModule(true, 3);
    await reconcileBlitzAutoStart(fixture.context, "activation");

    expect(fixture.state.storage.get(stateKey)).toMatchObject({
      baseline: "2:1",
      awaitingRoundId: null,
      deadlineAt: Date.now() + intervalMs,
    });
  });

  it("ignores a delayed opening callback from an older round after a newer round is active", async () => {
    const fixture = setup();
    await reconcileBlitzAutoStart(fixture.context, "activation");
    const oldRound = openingRound("fictional-delayed-old-round", "0:1");
    fixture.state.setActive({ roundId: oldRound.roundId, state: "announcing", data: oldRound.data, deadlineAt: null });
    await onBlitzPointRoundOpened(fixture.context, oldRound);

    fixture.state.setModule(false, 2);
    await reconcileBlitzAutoStart(fixture.context, "activation");
    fixture.state.setModule(true, 3);
    const currentRound = openingRound("fictional-current-round", "2:1");
    fixture.state.setActive({ roundId: currentRound.roundId, state: "announcing", data: currentRound.data, deadlineAt: null });
    await reconcileBlitzAutoStart(fixture.context, "activation");
    const currentState = fixture.state.storage.get(stateKey);
    const currentAlarm = fixture.state.scheduled.get(alarmKey);

    await onBlitzPointRoundOpened(fixture.context, oldRound);

    expect(fixture.state.storage.get(stateKey)).toEqual(currentState);
    expect(fixture.state.scheduled.get(alarmKey)).toEqual(currentAlarm);
    expect(fixture.state.storage.get(stateKey)).toMatchObject({ awaitingRoundId: currentRound.roundId });
  });

  it("does not let a resolution from an older settings baseline replace the current deadline", async () => {
    const fixture = setup();
    await reconcileBlitzAutoStart(fixture.context, "activation");
    const oldRound = openingRound("fictional-old-round", "0:1");
    fixture.state.setActive({ roundId: oldRound.roundId, state: "open", data: oldRound.data, deadlineAt: null });
    await onBlitzPointRoundOpened(fixture.context, oldRound);
    fixture.state.setSettings({ autoStart: true, autoStartIntervalMinutes: 30 }, 2, 2);
    await reconcileBlitzAutoStart(fixture.context, "settings");
    const currentDeadline = fixture.state.scheduled.get(alarmKey)?.deadline;
    fixture.state.setActive(null);
    vi.advanceTimersByTime(5 * minute);

    await onBlitzPointRoundResolved(fixture.context, { ...oldRound, result: {}, resolvedAt: new Date().toISOString() });

    expect(fixture.state.scheduled.get(alarmKey)?.deadline).toBe(currentDeadline);
    expect(fixture.state.storage.get(stateKey)).toMatchObject({ baseline: "0:2", awaitingRoundId: null });
  });

  it("keeps the saved interval when unrelated activation reconciliation sees an older active round", async () => {
    const fixture = setup();
    await reconcileBlitzAutoStart(fixture.context, "activation");
    const oldRound = openingRound("fictional-old-active-round", "0:1");
    fixture.state.setActive({ roundId: oldRound.roundId, state: "open", data: oldRound.data, deadlineAt: null });
    await onBlitzPointRoundOpened(fixture.context, oldRound);

    fixture.state.setSettings({ autoStart: true, autoStartIntervalMinutes: 30 }, 2, 2);
    await reconcileBlitzAutoStart(fixture.context, "settings");
    const savedDeadline = fixture.state.scheduled.get(alarmKey)?.deadline;
    expect(fixture.state.storage.get(stateKey)).toMatchObject({ baseline: "0:2", awaitingRoundId: null });

    await reconcileBlitzAutoStart(fixture.context, "activation");
    vi.advanceTimersByTime(2 * minute);
    fixture.state.setActive(null);
    await onBlitzPointRoundResolved(fixture.context, { ...oldRound, result: {}, resolvedAt: new Date().toISOString() });

    expect(fixture.state.scheduled.get(alarmKey)?.deadline).toBe(savedDeadline);
    expect(fixture.state.storage.get(stateKey)).toMatchObject({ baseline: "0:2", awaitingRoundId: null });
  });

  it("retries a due interval while an older-baseline round is active", async () => {
    const fixture = setup();
    await reconcileBlitzAutoStart(fixture.context, "activation");
    const oldRound = openingRound("fictional-due-old-round", "0:1");
    fixture.state.setActive({ roundId: oldRound.roundId, state: "open", data: oldRound.data, deadlineAt: null });
    await onBlitzPointRoundOpened(fixture.context, oldRound);

    fixture.state.setSettings({ autoStart: true, autoStartIntervalMinutes: 30 }, 2, 2);
    await reconcileBlitzAutoStart(fixture.context, "settings");
    const originalDeadline = fixture.state.scheduled.get(alarmKey)?.deadline ?? Date.now();
    vi.setSystemTime(originalDeadline);
    const dueAlarm = fixture.state.scheduled.get(alarmKey);
    Object.assign(fixture.context, { alarmIdentity: dueAlarm?.identity });
    fixture.state.scheduled.delete(alarmKey);

    await handleBlitzAutoStartAlarm(fixture.context, alarmKey, originalDeadline);

    expect(fixture.state.storage.get(stateKey)).toMatchObject({ baseline: "0:2", awaitingRoundId: null, deadlineAt: originalDeadline });
    expect(fixture.state.scheduled.get("settings-changed")?.deadline).toBe(Date.now() + 60_000);
    expect(openBlitzRound).not.toHaveBeenCalled();

    fixture.state.setActive(null);
    vi.advanceTimersByTime(60_000);
    await fixture.state.deliverAlarm("settings-changed");
    const retriedAlarm = fixture.state.scheduled.get(alarmKey);
    expect(retriedAlarm?.deadline).toBeLessThanOrEqual(Date.now());
    Object.assign(fixture.context, { alarmIdentity: retriedAlarm?.identity });
    fixture.state.scheduled.delete(alarmKey);
    await handleBlitzAutoStartAlarm(fixture.context, alarmKey, retriedAlarm?.deadline ?? 0);

    expect(openBlitzRound).toHaveBeenCalledOnce();
    expect(fixture.state.storage.get(stateKey)).toMatchObject({ baseline: "0:2", awaitingRoundId: "fictional-auto-round" });
  });

  it("ignores a previous activation resolution after the module is re-enabled", async () => {
    const fixture = setup();
    await reconcileBlitzAutoStart(fixture.context, "activation");
    const oldRound = openingRound("fictional-previous-activation-round", "0:1");
    fixture.state.setActive({ roundId: oldRound.roundId, state: "open", data: oldRound.data, deadlineAt: null });
    await onBlitzPointRoundOpened(fixture.context, oldRound);

    fixture.state.setModule(false, 2);
    await reconcileBlitzAutoStart(fixture.context, "activation");
    fixture.state.setActive(null);
    fixture.state.setModule(true, 3);
    await reconcileBlitzAutoStart(fixture.context, "activation");
    const currentDeadline = fixture.state.scheduled.get(alarmKey)?.deadline;

    await onBlitzPointRoundResolved(fixture.context, {
      ...oldRound,
      result: {},
      resolvedAt: new Date().toISOString(),
    });

    expect(fixture.state.storage.get(stateKey)).toMatchObject({ baseline: "2:1", awaitingRoundId: null });
    expect(fixture.state.scheduled.get(alarmKey)?.deadline).toBe(currentDeadline);
  });

  it("automatically reconciles when the first interval alarm fails during an autostart settings save", async () => {
    const fixture = setup();
    fixture.state.setSettings({ autoStart: false, autoStartIntervalMinutes: 15 }, 2, 2);
    await reconcileBlitzAutoStart(fixture.context, "settings");

    fixture.state.setSettings({ autoStart: true, autoStartIntervalMinutes: 30 }, 3, 3);
    const expectedDeadline = Date.now() + 30 * minute;
    fixture.state.failNextSchedule();
    await reconcileBlitzAutoStart(fixture.context, "settings");

    expect(fixture.state.scheduled.get("settings-changed")?.deadline).toBe(Date.now() + 5_000);
    vi.advanceTimersByTime(5_000);
    await fixture.state.deliverAlarm("settings-changed");

    expect(fixture.state.storage.get(stateKey)).toMatchObject({ baseline: "0:3", intervalMinutes: 30 });
    expect(fixture.state.scheduled.get(alarmKey)?.deadline).toBe(expectedDeadline);
  });

  it("keeps an existing deadline when an unrelated module activation is reconciled", async () => {
    const fixture = setup();
    await reconcileBlitzAutoStart(fixture.context, "activation");
    const deadline = fixture.state.scheduled.get(alarmKey)?.deadline;
    vi.advanceTimersByTime(5 * minute);

    await reconcileBlitzAutoStart(fixture.context, "activation");

    expect(fixture.state.scheduled.get(alarmKey)?.deadline).toBe(deadline);
  });

  it("pauses offline time and resumes the remaining interval", async () => {
    const fixture = setup();
    await reconcileBlitzAutoStart(fixture.context, "activation");
    vi.advanceTimersByTime(4 * minute);
    fixture.state.setStream("offline");
    await reconcileBlitzAutoStart(fixture.context, "stream_state");
    vi.advanceTimersByTime(120 * minute);
    fixture.state.setStream("online");
    await reconcileBlitzAutoStart(fixture.context, "stream_state");

    expect(fixture.state.scheduled.get(alarmKey)?.deadline).toBe(Date.now() + 11 * minute);
  });

  it("keeps the interval unarmed until the stream is known online", async () => {
    const fixture = setup();
    fixture.state.setStream("unknown");
    await reconcileBlitzAutoStart(fixture.context, "activation");
    vi.advanceTimersByTime(60 * minute);

    expect(fixture.state.storage.get(stateKey)).toMatchObject({ mode: "paused", deadlineAt: null });
    expect(fixture.state.scheduled.has(alarmKey)).toBe(false);

    fixture.state.setStream("online");
    await reconcileBlitzAutoStart(fixture.context, "stream_state");
    expect(fixture.state.scheduled.get(alarmKey)?.deadline).toBe(Date.now() + intervalMs);
  });

  it("skips a late alarm and schedules a new full interval without catch-up", async () => {
    const fixture = setup();
    await reconcileBlitzAutoStart(fixture.context, "activation");
    const plan = fixture.state.scheduled.get(alarmKey);
    vi.setSystemTime((plan?.deadline ?? Date.now()) + 10 * minute);
    Object.assign(fixture.context, { alarmIdentity: plan?.identity });

    await handleBlitzAutoStartAlarm(fixture.context, alarmKey, plan?.deadline ?? 0);

    expect(openBlitzRound).not.toHaveBeenCalled();
    expect(fixture.state.scheduled.get(alarmKey)?.deadline).toBe(Date.now() + intervalMs);
  });

  it("opens a due round through the shared service and arms its resolution watchdog", async () => {
    const fixture = setup();
    await reconcileBlitzAutoStart(fixture.context, "activation");
    const plan = fixture.state.scheduled.get(alarmKey);
    vi.setSystemTime(plan?.deadline ?? Date.now());
    Object.assign(fixture.context, { alarmIdentity: plan?.identity });

    await handleBlitzAutoStartAlarm(fixture.context, alarmKey, plan?.deadline ?? 0);

    expect(openBlitzRound).toHaveBeenCalledOnce();
    const openedInput = vi.mocked(openBlitzRound).mock.calls[0]?.[0];
    expect(openedInput).toMatchObject({
      channelId: "fictional_blitz_channel",
      autoStartBaseline: "0:1",
      settings: { autoStart: true, autoStartIntervalMinutes: 15 },
    });
    expect(fixture.state.storage.get(stateKey)).toMatchObject({
      awaitingRoundId: "fictional-auto-round",
      awaitingRoundBaseline: "0:1",
      deadlineAt: null,
    });
    expect(fixture.state.scheduled.get(alarmKey)?.deadline).toBe(Date.now() + 60_000);
  });

  it("resets the next interval after a manual round opens", async () => {
    const fixture = setup();
    await reconcileBlitzAutoStart(fixture.context, "activation");
    vi.advanceTimersByTime(8 * minute);
    const round = openingRound("fictional-manual-round");
    fixture.state.setActive({ roundId: round.roundId, state: "announcing", data: round.data, deadlineAt: null });

    await onBlitzPointRoundOpened(fixture.context, round);
    await onBlitzPointRoundResolved(fixture.context, { ...round, result: {}, resolvedAt: new Date().toISOString() });

    expect(fixture.state.scheduled.get(alarmKey)?.deadline).toBe(Date.now() + intervalMs);
  });

  it("waits a full interval after an automatic start cannot find a question", async () => {
    const fixture = setup();
    await reconcileBlitzAutoStart(fixture.context, "activation");
    const plan = fixture.state.scheduled.get(alarmKey);
    vi.setSystemTime(plan?.deadline ?? Date.now());
    Object.assign(fixture.context, { alarmIdentity: plan?.identity });
    vi.mocked(openBlitzRound).mockRejectedValueOnce(new Error("question_pool_empty"));

    await handleBlitzAutoStartAlarm(fixture.context, alarmKey, plan?.deadline ?? 0);

    expect(openBlitzRound).toHaveBeenCalledOnce();
    expect(fixture.state.scheduled.get(alarmKey)?.deadline).toBe(Date.now() + intervalMs);
  });
});
