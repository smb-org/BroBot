import { describe, expect, it } from "vitest";

import { werbungModul, verarbeiteWerbepause } from "../../src/modules/werbung";
import type { ModuleEvent } from "../../src/modules/contract";

const event = (payload: Record<string, unknown>, settings = werbungModul.defaultSettings): ModuleEvent<typeof settings> => ({
  channelId: "kanal-a",
  subscriptionType: "channel.ad_break.begin",
  triggerId: "trigger-1",
  payload,
  settings,
  receivedAt: "2026-09-20T10:00:00.000Z",
  actor: null,
  chatStatus: null,
});

describe("Werbung-Modul", () => {
  it("deklariert die beiden Werbe-Anlässe mit Version 1 und channel:read:ads", () => {
    expect(werbungModul.eventSubTypes).toEqual(["stream.online", "channel.ad_break.begin"]);
    expect(werbungModul.broadcasterScopes).toEqual(["channel:read:ads"]);
  });

  it("unterscheidet automatische und manuelle Pausen und nennt die Dauer", () => {
    const automatisch = verarbeiteWerbepause(event({
      duration_seconds: 30,
      started_at: "2026-09-20T10:00:00.000Z",
      is_automatic: true,
      requester_user_login: "streamer",
    }));
    const manuell = verarbeiteWerbepause(event({
      duration_seconds: 90,
      started_at: "2026-09-20T10:00:00.000Z",
      is_automatic: false,
    }));

    expect(automatisch.actions).toEqual([{ kind: "chat", text: "Automatische Werbepause: 30 Sekunden. Bin gleich zurück!" }]);
    expect(manuell.actions).toEqual([{ kind: "chat", text: "Werbepause: 90 Sekunden. Bin gleich zurück!" }]);
    expect(automatisch.diagnostics[0]).toEqual({
      code: "ads.ankuendigung",
      detail: {
        dauer: 30,
        automatisch: true,
        gestartet: "2026-09-20T10:00:00.000Z",
        ende: "2026-09-20T10:00:30.000Z",
        ausloeser: "streamer",
      },
    });
  });

  it("überspringt eine Pause mit Dauer null und begründet das", () => {
    expect(verarbeiteWerbepause(event({
      duration_seconds: 0,
      started_at: "2026-09-20T10:00:00.000Z",
      is_automatic: false,
    }))).toEqual({
      actions: [],
      diagnostics: [{
        code: "ads.uebersprungen",
        detail: { grund: "dauer_null", dauer: 0, automatisch: false },
      }],
    });
  });

  it("verwendet die Einstellung auch ohne Platzhalter und ergänzt dann die Dauer", () => {
    const result = verarbeiteWerbepause(event({
      duration_seconds: 45,
      started_at: "2026-09-20T10:00:00.000Z",
      is_automatic: false,
    }, {
      automatisch: "auto",
      manuell: "Pause läuft",
      vorwarnung: true,
      vorlaufSekunden: 60,
      vorwarnungText: "Vorwarnung {seconds}",
    }));

    expect(result.actions).toEqual([{ kind: "chat", text: "Pause läuft (45 Sekunden)" }]);
  });

  it("ersetzt den englischen Platzhalter und keinen deutschen Altname", () => {
    const result = verarbeiteWerbepause(event({
      duration_seconds: 45,
      started_at: "2026-09-20T10:00:00.000Z",
      is_automatic: false,
    }, {
      automatisch: "auto {duration}",
      manuell: "Pause {dauer}",
      vorwarnung: true,
      vorlaufSekunden: 60,
      vorwarnungText: "Vorwarnung {seconds}",
    }));

    expect(result.actions).toEqual([{ kind: "chat", text: "Pause {dauer} (45 Sekunden)" }]);
  });
});
