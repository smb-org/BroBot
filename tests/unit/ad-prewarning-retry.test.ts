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

import { processAdPrewarning, type AdScheduler } from "../../src/worker/ad-prewarning";
import type { AdSchedule } from "../../src/modules/ads/adapters/ad-schedule";

describe("ad prewarning retry before chat POST", () => {
  afterEach(() => vi.clearAllMocks());

  it("leaves the occurrence claim available when bot identity lookup fails before POST", async () => {
    const dueAt = Date.parse("2026-09-24T12:03:00.000Z");
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
    mocks.getBotIdentity.mockRejectedValueOnce(new Error("D1 temporarily unavailable"))
      .mockResolvedValue({ userId: "bot-1" });
    mocks.getAppAccessToken.mockResolvedValue("app-token");

    let claimedDueAt: number | null = null;
    const scheduler: AdScheduler = {
      schedule: () => Promise.resolve(),
      clear: () => Promise.resolve(),
      readScheduleGeneration: () => Promise.resolve(1),
      readSchedule: () => Promise.resolve(schedule),
      storeSchedule: (freshSchedule) => Promise.resolve(freshSchedule),
      claimPrewarningSend: (scheduledDueAtMs) => {
        if (claimedDueAt === scheduledDueAtMs) return Promise.resolve(false);
        claimedDueAt = scheduledDueAtMs;
        return Promise.resolve(true);
      },
    };
    const environment = {
      DB: {} as D1Database,
      TWITCH_CLIENT_ID: "client",
      TWITCH_CLIENT_SECRET: "secret",
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [{ is_sent: true, message_id: "message-1" }],
    }), { status: 200 }));
    const args = [environment, "kanal-a", dueAt, "alarm-1", "2026-09-24T12:03:00.000Z", fetcher, scheduler] as const;

    // A retryable pre-POST failure (identity lookup throws) surfaces as a
    // thrown error, not a swallowed "sent: false" -- that is what lets
    // ChannelObject's alarm dispatcher retry it at a short delay instead of
    // the default 60s+ backoff (see tests/worker/ad-prewarning-retry-alarm
    // for that retry actually landing before the ad through alarm()).
    await expect(processAdPrewarning(...args)).rejects.toThrow("bot_identity_missing");
    expect(claimedDueAt).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();

    await processAdPrewarning(...args);

    expect(mocks.getBotIdentity).toHaveBeenCalledTimes(2);
    expect(claimedDueAt).toBe(dueAt);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(mocks.writeModuleDiagnostics.mock.calls.at(-1)?.[5]).toMatchObject([
      { code: "ads.prewarning.announced" },
      { code: "host.chat.sent" },
    ]);
  });

  it("surfaces app access token unavailability the same way, as a retryable pre-POST failure", async () => {
    const dueAt = Date.parse("2026-09-24T12:03:00.000Z");
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
    mocks.getAppAccessToken.mockRejectedValueOnce(new Error("app token endpoint unavailable"))
      .mockResolvedValue("app-token");

    let claimedDueAt: number | null = null;
    const scheduler: AdScheduler = {
      schedule: () => Promise.resolve(),
      clear: () => Promise.resolve(),
      readScheduleGeneration: () => Promise.resolve(1),
      readSchedule: () => Promise.resolve(schedule),
      storeSchedule: (freshSchedule) => Promise.resolve(freshSchedule),
      claimPrewarningSend: (scheduledDueAtMs) => {
        if (claimedDueAt === scheduledDueAtMs) return Promise.resolve(false);
        claimedDueAt = scheduledDueAtMs;
        return Promise.resolve(true);
      },
    };
    const environment = {
      DB: {} as D1Database,
      TWITCH_CLIENT_ID: "client",
      TWITCH_CLIENT_SECRET: "secret",
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      data: [{ is_sent: true, message_id: "message-1" }],
    }), { status: 200 }));
    const args = [environment, "kanal-a", dueAt, "alarm-1", "2026-09-24T12:03:00.000Z", fetcher, scheduler] as const;

    // Previously this returned normally with "app_token_unavailable" and got
    // no retry at all; it must now throw just like the identity case above.
    await expect(processAdPrewarning(...args)).rejects.toThrow("app_token_unavailable");
    expect(claimedDueAt).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();

    await processAdPrewarning(...args);

    expect(claimedDueAt).toBe(dueAt);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
