import { describe, expect, it, vi } from "vitest";

import { adsModule, processAdBreak } from "../../src/modules/ads";
import { renderAdBreakText } from "../../src/modules/ads/domain";
import { adsSettingsSchema, type AdsSettings } from "../../src/modules/ads/contracts";
import type { ModuleEvent } from "../../src/modules/contract";

const event = (payload: Record<string, unknown>, settings: AdsSettings = adsModule.defaultSettings): ModuleEvent<AdsSettings> => ({
  channelId: "kanal-a",
  subscriptionType: "channel.ad_break.begin",
  triggerId: "trigger-1",
  payload,
  settings,
  receivedAt: "2026-09-20T10:00:00.000Z",
  actor: null,
  chatStatus: null,
});

describe("ads module", () => {
  it("adds a grammatical duration label in the selected dashboard language", () => {
    expect(renderAdBreakText("Werbung läuft", 90, "de")).toBe("Werbung läuft (90 Sekunden)");
    expect(renderAdBreakText("Ads running", 90, "en")).toBe("Ads running (90 seconds)");
  });

  it("declares both ad events with version 1 and channel:read:ads", () => {
    expect(adsModule.eventSubTypes).toEqual(["stream.online", "channel.ad_break.begin"]);
    expect(adsModule.broadcasterScopes).toEqual(["channel:read:ads"]);
  });

  it("derives an active break from the persisted channel.ad_break.begin data", async () => {
    const now = Date.parse("2026-09-20T10:00:30.000Z");
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      schedule: {
        nextAdAt: null,
        duration: null,
        lastAdAt: "2026-09-20T10:00:00.000Z",
        prerollFreeTime: null,
        snoozeCount: 2,
        snoozeRefreshAt: null,
      },
      recentAdBreaks: [{ timestamp: "2026-09-20T10:00:00.000Z", durationSeconds: 90 }],
      snoozeScopeAvailable: true,
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetcher);
    try {
      const snapshots = await adsModule.liveTile?.load("kanal-a", new AbortController().signal);
      expect(snapshots).toEqual([{
        kind: "ad_schedule",
        nextAdAt: null,
        duration: null,
        snoozeCount: 2,
        snoozeScopeAvailable: true,
        runningBreakEndsAt: "2026-09-20T10:01:30.000Z",
      }]);
    } finally {
      clock.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("distinguishes automatic and manual breaks and states the duration", () => {
    const automatic = processAdBreak(event({
      duration_seconds: 30,
      started_at: "2026-09-20T10:00:00.000Z",
      is_automatic: true,
      requester_user_login: "streamer",
    }));
    const manual = processAdBreak(event({
      duration_seconds: 90,
      started_at: "2026-09-20T10:00:00.000Z",
      is_automatic: false,
    }));

    expect(automatic.actions).toEqual([{ kind: "chat", text: "Automatische Werbepause: 30 Sekunden. Bin gleich zurück!", target: "source_only" }]);
    expect(manual.actions).toEqual([{ kind: "chat", text: "Werbepause: 90 Sekunden. Bin gleich zurück!", target: "source_only" }]);
    expect(automatic.diagnostics[0]).toEqual({
      code: "ads.announcement",
      detail: {
        duration: 30,
        automatic: true,
        startedAt: "2026-09-20T10:00:00.000Z",
        endsAt: "2026-09-20T10:00:30.000Z",
        triggerLogin: "streamer",
      },
    });
  });

  it("skips a break with zero duration and gives the reason", () => {
    expect(processAdBreak(event({
      duration_seconds: 0,
      started_at: "2026-09-20T10:00:00.000Z",
      is_automatic: false,
    }))).toEqual({
      actions: [],
      diagnostics: [{
        code: "ads.skipped",
        detail: { reason: "duration_zero", duration: 0, automatic: false },
      }],
    });
  });

  it("uses the setting even without a placeholder and then appends the duration", () => {
    const result = processAdBreak(event({
      duration_seconds: 45,
      started_at: "2026-09-20T10:00:00.000Z",
      is_automatic: false,
    }, {
      automatic: "auto",
      manual: "Pause läuft",
      prewarning: true,
      leadSeconds: 60,
      prewarningText: "Vorwarnung {ads.seconds}",
    }));

    expect(result.actions).toEqual([{ kind: "chat", text: "Pause läuft (45 Sekunden)", target: "source_only" }]);
  });

  it("replaces the English placeholder, not a German legacy name", () => {
    const result = processAdBreak(event({
      duration_seconds: 45,
      started_at: "2026-09-20T10:00:00.000Z",
      is_automatic: false,
    }, {
      automatic: "auto {ads.duration}",
      manual: "Pause {dauer}",
      prewarning: true,
      leadSeconds: 60,
      prewarningText: "Vorwarnung {ads.seconds}",
    }));

    expect(result.actions).toEqual([{ kind: "chat", text: "Pause {dauer} (45 Sekunden)", target: "source_only" }]);
  });

  it("allows the automatic announcement to be turned off independently", () => {
    const settings = {
      ...adsModule.defaultSettings,
      automaticEnabled: false,
      manual: "Manuelle Pause",
    };
    expect(adsSettingsSchema.safeParse(settings).success).toBe(true);
    expect(processAdBreak(event({ duration_seconds: 30, started_at: "2026-09-20T10:00:00.000Z", is_automatic: true }, settings)).actions).toEqual([]);
    expect(processAdBreak(event({ duration_seconds: 30, started_at: "2026-09-20T10:00:00.000Z", is_automatic: false }, settings)).actions)
      .toEqual([{ kind: "chat", text: "Manuelle Pause (30 Sekunden)", target: "source_only" }]);
  });

  it("keeps a disabled automatic message saved while disabling its send", () => {
    const settings = { ...adsModule.defaultSettings, automatic: "Saved automatic text", automaticEnabled: false };
    expect(adsSettingsSchema.safeParse(settings).success).toBe(true);
    expect(processAdBreak(event({ duration_seconds: 30, started_at: "2026-09-20T10:00:00.000Z", is_automatic: true }, settings)).actions)
      .toEqual([]);
    expect(settings.automatic).toBe("Saved automatic text");
  });

  it("keeps a disabled manual message saved while automatic breaks remain enabled", () => {
    const settings = { ...adsModule.defaultSettings, manual: "Saved manual text", manualEnabled: false };

    expect(processAdBreak(event({ duration_seconds: 30, started_at: "2026-09-20T10:00:00.000Z", is_automatic: false }, settings)).actions).toEqual([]);
    expect(processAdBreak(event({ duration_seconds: 30, started_at: "2026-09-20T10:00:00.000Z", is_automatic: true }, settings)).actions).toHaveLength(1);
    expect(settings.manual).toBe("Saved manual text");
  });

  it("rejects an enabled message with no text", () => {
    const result = adsSettingsSchema.safeParse({ ...adsModule.defaultSettings, automatic: "  ", automaticEnabled: true });

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.map((issue) => issue.path)).toContainEqual(["automatic"]);
  });
});
