import { describe, expect, it, vi } from "vitest";

import type { BotModule, ModuleOverlayElementDefinition } from "../../src/modules/contract";
import { adCountdownStateForSchedule, createAdCountdownOverlayAction } from "../../src/modules/ads/overlay/countdown-action";
import { prepareModuleOverlayRealtimeMessage } from "../../src/worker/module-overlay-realtime";

const databaseFor = (overlayIds: readonly string[]) => {
  const statement = {
    bind: vi.fn(() => ({ all: () => Promise.resolve({ results: overlayIds.map((overlay_id) => ({ overlay_id })) }) })),
  };
  const prepare = vi.fn((sql: string) => {
    void sql;
    return statement;
  });
  return { database: { prepare } as unknown as D1Database, prepare, statement };
};

const declaration = (kind: `${string}.${string}`): ModuleOverlayElementDefinition => ({
  kind,
  configVersion: 1,
  defaultSize: { width: 100, height: 80 },
  defaultConfig: {},
  parseConfig: () => ({}),
  load: () => Promise.resolve({ default: () => null }),
});

describe("module overlay realtime routing", () => {
  it("clears duration when there is no next ad and preserves Twitch snooze fields", () => {
    expect(adCountdownStateForSchedule({
      nextAdAt: null,
      duration: 60,
      snoozeCount: 2,
      snoozeRefreshAt: "2026-09-25T12:30:00.000Z",
    }, "2026-09-25T12:00:00.000Z")).toEqual({
      nextAdAt: null,
      duration: null,
      snoozeCount: 2,
      snoozeRefreshAt: "2026-09-25T12:30:00.000Z",
      serverNow: "2026-09-25T12:00:00.000Z",
    });
  });

  it("routes to overlays with the exact declared element kind", async () => {
    const database = databaseFor(["overlay-a", "overlay-c", "overlay-a"]);
    const state = adCountdownStateForSchedule({
      nextAdAt: "2026-09-25T12:01:00.000Z",
      duration: 90,
      snoozeCount: 2,
      snoozeRefreshAt: "2026-09-25T12:30:00.000Z",
    }, "2026-09-25T12:00:00.000Z");

    const result = await prepareModuleOverlayRealtimeMessage(
      database.database,
      "kanal-a",
      "ads",
      createAdCountdownOverlayAction(state),
    );

    expect(database.prepare.mock.calls[0]?.[0]).toContain("element.kind = ?");
    expect(database.prepare.mock.calls[0]?.[0]).not.toContain("element.kind LIKE ?");
    expect(database.statement.bind.mock.calls[0]).toEqual(["kanal-a", "ads.countdown", 0, "ads"]);
    expect(result).toMatchObject({
      outcome: "ready",
      message: {
        channelId: "kanal-a",
        type: "modul.ads.countdown",
        payload: {
          nextAdAt: "2026-09-25T12:01:00.000Z",
          duration: 90,
          snoozeCount: 2,
          snoozeRefreshAt: "2026-09-25T12:30:00.000Z",
          serverNow: "2026-09-25T12:00:00.000Z",
        },
        overlayIds: ["overlay-a", "overlay-c"],
      },
    });
  });

  it("treats underscores in module identifiers literally", async () => {
    const module: BotModule = {
      id: "ads_beta",
      settingsSchema: { parse: (value: unknown) => value } as never,
      defaultSettings: {},
      overlayElements: [declaration("ads_beta.countdown")],
    };
    const database = databaseFor(["overlay-underscore"]);

    const result = await prepareModuleOverlayRealtimeMessage(database.database, "kanal-a", "ads_beta", {
      kind: "overlay",
      type: "countdown",
      elementKind: "ads_beta.countdown",
      payload: {},
    }, false, [module]);

    expect(database.prepare.mock.calls[0]?.[0]).toContain("element.kind = ?");
    expect(database.statement.bind.mock.calls[0]).toEqual(["kanal-a", "ads_beta.countdown", 0, "ads_beta"]);
    expect(result).toMatchObject({ outcome: "ready", message: { type: "modul.ads_beta.countdown" } });
  });

  it("rejects actions targeting undeclared element kinds", async () => {
    await expect(prepareModuleOverlayRealtimeMessage(databaseFor([]).database, "kanal-a", "ads", {
      kind: "overlay",
      type: "countdown",
      elementKind: "ads.other",
      payload: {},
    })).resolves.toEqual({ outcome: "rejected" });
  });

  it("does not publish actions when no overlay uses that element kind", async () => {
    const result = await prepareModuleOverlayRealtimeMessage(
      databaseFor([]).database,
      "kanal-a",
      "ads",
      createAdCountdownOverlayAction(adCountdownStateForSchedule({
        nextAdAt: null,
        duration: null,
        snoozeCount: null,
        snoozeRefreshAt: null,
      }, "2026-09-25T12:00:00.000Z")),
    );

    expect(result).toEqual({ outcome: "no_recipients" });
  });
});
