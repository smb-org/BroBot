import { describe, expect, it } from "vitest";

import { adsModule, processAdBreak } from "../../src/modules/ads";
import type { ModuleEvent } from "../../src/modules/contract";

const event = (payload: Record<string, unknown>, settings = adsModule.defaultSettings): ModuleEvent<typeof settings> => ({
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
  it("declares both ad events with version 1 and channel:read:ads", () => {
    expect(adsModule.eventSubTypes).toEqual(["stream.online", "channel.ad_break.begin"]);
    expect(adsModule.broadcasterScopes).toEqual(["channel:read:ads"]);
  });

  it("distinguishes automatic and manual breaks and states the duration", () => {
    const automatisch = processAdBreak(event({
      duration_seconds: 30,
      started_at: "2026-09-20T10:00:00.000Z",
      is_automatic: true,
      requester_user_login: "streamer",
    }));
    const manuell = processAdBreak(event({
      duration_seconds: 90,
      started_at: "2026-09-20T10:00:00.000Z",
      is_automatic: false,
    }));

    expect(automatisch.actions).toEqual([{ kind: "chat", text: "Automatische Werbepause: 30 Sekunden. Bin gleich zurück!" }]);
    expect(manuell.actions).toEqual([{ kind: "chat", text: "Werbepause: 90 Sekunden. Bin gleich zurück!" }]);
    expect(automatisch.diagnostics[0]).toEqual({
      code: "ads.ankuendigung",
      detail: {
        duration: 30,
        automatic: true,
        gestartet: "2026-09-20T10:00:00.000Z",
        endsAt: "2026-09-20T10:00:30.000Z",
        ausloeser: "streamer",
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
        code: "ads.uebersprungen",
        detail: { reason: "dauer_null", duration: 0, automatic: false },
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
      prewarningText: "Vorwarnung {seconds}",
    }));

    expect(result.actions).toEqual([{ kind: "chat", text: "Pause läuft (45 Sekunden)" }]);
  });

  it("replaces the English placeholder, not a German legacy name", () => {
    const result = processAdBreak(event({
      duration_seconds: 45,
      started_at: "2026-09-20T10:00:00.000Z",
      is_automatic: false,
    }, {
      automatic: "auto {duration}",
      manual: "Pause {dauer}",
      prewarning: true,
      leadSeconds: 60,
      prewarningText: "Vorwarnung {seconds}",
    }));

    expect(result.actions).toEqual([{ kind: "chat", text: "Pause {dauer} (45 Sekunden)" }]);
  });
});
