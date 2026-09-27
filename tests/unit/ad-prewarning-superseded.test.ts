import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getChannelModuleForChannel: vi.fn(),
  moduleBroadcasterScopeState: vi.fn(),
  getAdSchedule: vi.fn(),
  sendChatMessage: vi.fn(),
  writeModuleDiagnostics: vi.fn(),
}));

vi.mock("../../src/worker/db/channel-modules", () => ({ getChannelModuleForChannel: mocks.getChannelModuleForChannel }));
vi.mock("../../src/worker/module-scopes", () => ({ moduleBroadcasterScopeState: mocks.moduleBroadcasterScopeState }));
vi.mock("../../src/modules/ads/adapters/ad-schedule", () => ({ getAdSchedule: mocks.getAdSchedule }));
vi.mock("../../src/worker/chat", () => ({ sendChatMessage: mocks.sendChatMessage }));
vi.mock("../../src/worker/event-log", () => ({ writeModuleDiagnostics: mocks.writeModuleDiagnostics }));

import { processAdPrewarning, type AdScheduler } from "../../src/worker/ad-prewarning";
import type { AdSchedule, AdScheduleResult } from "../../src/modules/ads/adapters/ad-schedule";

describe("ad prewarning schedule generations", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses the snoozed cache when an in-flight alarm fetch loses its generation", async () => {
    const original: AdSchedule = {
      nextAdAt: "2026-09-24T12:05:00.000Z",
      duration: 60,
      lastAdAt: null,
      prerollFreeTime: 120,
      snoozeCount: 0,
      snoozeRefreshAt: null,
    };
    const snoozed: AdSchedule = { ...original, nextAdAt: "2026-09-24T12:20:00.000Z", snoozeCount: 1 };
    let generation = 1;
    let currentSchedule = original;
    let resolveFetch: ((result: AdScheduleResult) => void) | undefined;
    mocks.getChannelModuleForChannel.mockResolvedValue({
      channelId: "kanal-a",
      moduleId: "ads",
      enabled: true,
      revision: 1,
      settings: JSON.stringify({
        automatic: "a",
        manual: "m",
        prewarning: true,
        leadSeconds: 60,
        prewarningText: "In {ads.seconds} Sekunden startet die Werbung.",
      }),
    });
    mocks.moduleBroadcasterScopeState.mockResolvedValue({ required: ["channel:read:ads"], missing: [] });
    mocks.getAdSchedule.mockImplementationOnce(() => new Promise((resolve) => { resolveFetch = resolve; }));
    mocks.writeModuleDiagnostics.mockResolvedValue([]);
    mocks.sendChatMessage.mockResolvedValue({ sent: true, truncated: false, reason: null, detail: {} });
    const scheduled: number[] = [];
    const scheduler: AdScheduler = {
      schedule: (dueAtMs) => { scheduled.push(dueAtMs); return Promise.resolve(); },
      clear: () => Promise.resolve(),
      readScheduleGeneration: () => Promise.resolve(generation),
      readSchedule: () => Promise.resolve(currentSchedule),
      // Match the alarm adapter's old behavior: await the guarded save but
      // drop its null result when a snooze has already advanced the generation.
      storeSchedule: (schedule, _asOf, options) => {
        if (options?.expectedGeneration !== generation) {
          // The guarded ChannelObject call returned null, but this adapter
          // discarded it by not returning its awaited result.
          return Promise.resolve(undefined);
        }
        currentSchedule = schedule;
        generation += 1;
        return Promise.resolve(undefined);
      },
    };
    const environment = {
      DB: {} as D1Database,
      TWITCH_CLIENT_ID: "client",
      TWITCH_CLIENT_SECRET: "secret",
    };

    const processing = processAdPrewarning(
      environment,
      "kanal-a",
      Date.parse("2026-09-24T12:04:00.000Z"),
      "alarm-1",
      "2026-09-24T12:04:00.000Z",
      vi.fn() as typeof fetch,
      scheduler,
    );
    await vi.waitFor(() => { expect(mocks.getAdSchedule).toHaveBeenCalledOnce(); });

    currentSchedule = snoozed;
    generation += 1;
    resolveFetch?.({ fetched: true, reason: null, detail: {}, schedule: original });
    await processing;

    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
    expect(scheduled).toEqual([Date.parse("2026-09-24T12:19:00.000Z")]);
    expect(mocks.writeModuleDiagnostics.mock.calls[0]?.[5]).toMatchObject([
      { code: "ads.prewarning.rescheduled" },
    ]);
  });

  it("recheck a snooze landing between decision and send skips the stale announcement", async () => {
    const original: AdSchedule = {
      nextAdAt: "2026-09-24T12:05:00.000Z",
      duration: 60,
      lastAdAt: null,
      prerollFreeTime: 120,
      snoozeCount: 0,
      snoozeRefreshAt: null,
    };
    const snoozed: AdSchedule = { ...original, nextAdAt: "2026-09-24T12:20:00.000Z", snoozeCount: 1 };
    mocks.getChannelModuleForChannel.mockResolvedValue({
      channelId: "kanal-a",
      moduleId: "ads",
      enabled: true,
      revision: 1,
      settings: JSON.stringify({
        automatic: "a",
        manual: "m",
        prewarning: true,
        leadSeconds: 60,
        prewarningText: "In {ads.seconds} Sekunden startet die Werbung.",
      }),
    });
    mocks.moduleBroadcasterScopeState.mockResolvedValue({ required: ["channel:read:ads"], missing: [] });
    mocks.getAdSchedule.mockResolvedValue({ fetched: true, reason: null, detail: {}, schedule: original });
    mocks.writeModuleDiagnostics.mockResolvedValue([]);
    mocks.sendChatMessage.mockResolvedValue({ sent: true, truncated: false, reason: null, detail: {} });
    const scheduled: number[] = [];
    const scheduler: AdScheduler = {
      schedule: (dueAtMs) => { scheduled.push(dueAtMs); return Promise.resolve(); },
      clear: () => Promise.resolve(),
      readScheduleGeneration: () => Promise.resolve(1),
      // The fetch-and-store step above already landed the original schedule
      // (matching generation, no race there). A snooze then completes in the
      // window between that decision and the chat send: the cache this read
      // resolves against has already moved on.
      readSchedule: () => Promise.resolve(snoozed),
      storeSchedule: (schedule) => Promise.resolve(schedule),
    };
    const environment = {
      DB: {} as D1Database,
      TWITCH_CLIENT_ID: "client",
      TWITCH_CLIENT_SECRET: "secret",
    };

    await processAdPrewarning(
      environment,
      "kanal-a",
      Date.parse("2026-09-24T12:04:00.000Z"),
      "alarm-1",
      "2026-09-24T12:04:00.000Z",
      vi.fn() as typeof fetch,
      scheduler,
    );

    expect(mocks.sendChatMessage).not.toHaveBeenCalled();
    expect(scheduled).toEqual([Date.parse("2026-09-24T12:19:00.000Z")]);
    expect(mocks.writeModuleDiagnostics.mock.calls[0]?.[5]).toMatchObject([
      { code: "ads.prewarning.rescheduled" },
    ]);
  });

  it("does not send the prewarning twice when a retry follows a diagnostics failure", async () => {
    const dueAt = Date.parse("2026-09-24T12:04:00.000Z");
    const schedule: AdSchedule = {
      nextAdAt: "2026-09-24T12:05:00.000Z",
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
        automatic: "a",
        manual: "m",
        prewarning: true,
        leadSeconds: 60,
        prewarningText: "In {ads.seconds} Sekunden startet die Werbung.",
      }),
    });
    mocks.moduleBroadcasterScopeState.mockResolvedValue({ required: ["channel:read:ads"], missing: [] });
    mocks.getAdSchedule.mockResolvedValue({ fetched: true, reason: null, detail: {}, schedule });
    mocks.writeModuleDiagnostics.mockRejectedValueOnce(new Error("diagnostics unavailable"))
      .mockResolvedValueOnce([]);
    let claimed = false;
    let postAttempts = 0;
    mocks.sendChatMessage.mockImplementation(async (...args) => {
      const claimBeforePost = args[6] as (() => Promise<boolean>) | undefined;
      if (claimBeforePost !== undefined && !(await claimBeforePost())) {
        return { sent: false, truncated: false, reason: "already_attempted", detail: {} };
      }
      postAttempts += 1;
      return { sent: true, truncated: false, reason: null, detail: {} };
    });
    const scheduler: AdScheduler = {
      schedule: () => Promise.resolve(),
      clear: () => Promise.resolve(),
      readScheduleGeneration: () => Promise.resolve(1),
      readSchedule: () => Promise.resolve(schedule),
      storeSchedule: (freshSchedule) => Promise.resolve(freshSchedule),
      claimPrewarningSend: (scheduledDueAtMs) => {
        expect(scheduledDueAtMs).toBe(dueAt);
        if (claimed) return Promise.resolve(false);
        claimed = true;
        return Promise.resolve(true);
      },
    };
    const environment = {
      DB: {} as D1Database,
      TWITCH_CLIENT_ID: "client",
      TWITCH_CLIENT_SECRET: "secret",
    };
    const args = [environment, "kanal-a", dueAt, "alarm-1", "2026-09-24T12:04:00.000Z", vi.fn() as typeof fetch, scheduler] as const;

    await expect(processAdPrewarning(...args)).rejects.toThrow("diagnostics unavailable");
    await processAdPrewarning(...args);

    expect(mocks.sendChatMessage).toHaveBeenCalledTimes(2);
    expect(postAttempts).toBe(1);
    expect(mocks.writeModuleDiagnostics).toHaveBeenCalledTimes(2);
    expect(mocks.writeModuleDiagnostics.mock.calls[1]?.[5]).toMatchObject([
      { code: "ads.prewarning.announced" },
      { code: "host.chat.skipped", detail: { reason: "already_attempted" } },
    ]);
  });
});
