import { describe, expect, it, vi } from "vitest";

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
  return { database: { prepare } as unknown as D1Database, prepare };
};

describe("module overlay realtime routing", () => {
  it("clears the overlay duration when the schedule has no next ad", () => {
    expect(adCountdownStateForSchedule({ nextAdAt: null, duration: 60 })).toEqual({ nextAdAt: null, duration: null });
  });

  it("prefixes the action and resolves only overlays containing the module kind", async () => {
    const database = databaseFor(["overlay-a", "overlay-c", "overlay-a"]);
    const action = createAdCountdownOverlayAction({ nextAdAt: "2026-09-25T12:01:00.000Z", duration: 90 });

    const result = await prepareModuleOverlayRealtimeMessage(database.database, "kanal-a", "ads", action);

    expect(database.prepare.mock.calls[0]?.[0]).toContain("element.kind LIKE ?");
    expect(result).toMatchObject({
      outcome: "ready",
      message: {
        channelId: "kanal-a",
        type: "modul.ads.countdown",
        payload: { nextAdAt: "2026-09-25T12:01:00.000Z", duration: 90 },
        overlayIds: ["overlay-a", "overlay-c"],
      },
    });
  });

  it("does not publish actions when no overlay uses that module element", async () => {
    const result = await prepareModuleOverlayRealtimeMessage(
      databaseFor([]).database,
      "kanal-a",
      "ads",
      createAdCountdownOverlayAction({ nextAdAt: null, duration: null }),
    );

    expect(result).toEqual({ outcome: "no_recipients" });
  });
});
