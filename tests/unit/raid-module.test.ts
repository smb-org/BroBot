import { describe, expect, it } from "vitest";

import { raidModul, verarbeiteRaid } from "../../src/modules/raid";
import type { ModuleEvent } from "../../src/modules/contract";

const event = (
  payload: Record<string, unknown>,
  settings = raidModul.defaultSettings,
  subscriptionVariant = "eingehend",
): ModuleEvent<typeof settings> => ({
  channelId: "kanal-a",
  subscriptionType: "channel.raid",
  subscriptionVariant,
  triggerId: "trigger-raid",
  payload,
  settings,
  receivedAt: "2026-09-20T10:00:00.000Z",
  actor: null,
  chatStatus: null,
});

const eingehenderRaid = (viewers: number): Record<string, unknown> => ({
  from_broadcaster_user_id: "quelle-1",
  from_broadcaster_user_login: "quelle",
  to_broadcaster_user_id: "kanal-a",
  viewers,
});

describe("Raid-Modul", () => {
  it("abonniert channel.raid ohne Broadcaster-Scope", () => {
    expect(raidModul.eventSubTypes).toEqual(["channel.raid"]);
    expect(raidModul.broadcasterScopes).toBeUndefined();
  });

  it("erzeugt über der Schwelle zuerst Shoutout und dann die volle Chatzeile", () => {
    const result = verarbeiteRaid(event(eingehenderRaid(8), {
      mindestZuschauer: 3,
      textVoll: "Willkommen {kanal} mit {zuschauer} Zuschauern!",
      textKlein: "Danke {kanal}!",
    }));

    expect(result.actions).toEqual([
      { kind: "shoutout", zielKanalId: "quelle-1" },
      { kind: "chat", text: "Willkommen quelle mit 8 Zuschauern!" },
    ]);
  });

  it("erzeugt unter der Schwelle nur den kurzen Dank", () => {
    const result = verarbeiteRaid(event(eingehenderRaid(2), {
      mindestZuschauer: 3,
      textVoll: "Voll {kanal} {zuschauer}",
      textKlein: "Danke {kanal} für {zuschauer}!",
    }));

    expect(result.actions).toEqual([
      { kind: "chat", text: "Danke quelle für 2!" },
    ]);
  });

  it("meldet einen ausgehenden Raid und erzeugt keine Aktion", () => {
    const result = verarbeiteRaid(event({
      from_broadcaster_user_id: "kanal-a",
      to_broadcaster_user_id: "ziel-1",
      viewers: 20,
    }, raidModul.defaultSettings, "ausgehend"));

    expect(result.actions).toEqual([]);
    expect(result.diagnostics).toEqual([{
      code: "raid.ausgehend",
      detail: { zielKanalId: "ziel-1", zuschauer: 20 },
    }]);
  });

  it("ersetzt beide Platzhalter und behandelt Schwelle null inklusiv", () => {
    const result = verarbeiteRaid(event(eingehenderRaid(0), {
      mindestZuschauer: 0,
      textVoll: "{kanal}/{zuschauer}",
      textKlein: "klein",
    }));

    expect(result.actions).toEqual([
      { kind: "shoutout", zielKanalId: "quelle-1" },
      { kind: "chat", text: "quelle/0" },
    ]);
  });

  it("begründet einen Raid unter der Schwelle", () => {
    const result = verarbeiteRaid(event(eingehenderRaid(2), {
      mindestZuschauer: 3,
      textVoll: "voll",
      textKlein: "klein",
    }));

    expect(result.diagnostics).toEqual([{
      code: "shoutout.unterdrueckt",
      detail: { grund: "unter_schwelle", zuschauer: 2, schwelle: 3 },
    }]);
  });
});
