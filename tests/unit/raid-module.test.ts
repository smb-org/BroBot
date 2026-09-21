import { describe, expect, it } from "vitest";

import { raidModul, verarbeiteRaid } from "../../src/modules/raid";
import { raidSettingsSchema } from "../../src/modules/raid/contracts";
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
  it("setzt alte gespeicherte Schwellen still auf die neuen Defaults zurück", () => {
    expect(raidSettingsSchema.parse({
      mindestZuschauer: 50,
      textVoll: "voll",
      textKlein: "klein",
    })).toEqual({
      shoutoutAktiv: true,
      shoutoutSchwelle: 3,
      textSchwelle: 3,
      textVoll: "voll",
      textKlein: "klein",
    });
  });

  it("abonniert channel.raid ohne Broadcaster-Scope", () => {
    expect(raidModul.eventSubTypes).toEqual(["channel.raid"]);
    expect(raidModul.broadcasterScopes).toBeUndefined();
  });

  it("erzeugt ab der Shoutout-Schwelle Shoutout und volle Chatzeile", () => {
    const result = verarbeiteRaid(event(eingehenderRaid(8), {
      shoutoutAktiv: true,
      shoutoutSchwelle: 3,
      textSchwelle: 3,
      textVoll: "Willkommen {channel} mit {viewers} Zuschauern!",
      textKlein: "Danke {channel}!",
    }));

    expect(result.actions).toEqual([
      { kind: "shoutout", zielKanalId: "quelle-1" },
      { kind: "chat", text: "Willkommen quelle mit 8 Zuschauern!" },
    ]);
  });

  it("erzeugt ab der Shoutout-Schwelle ohne Schalter nur die volle Chatzeile", () => {
    const result = verarbeiteRaid(event(eingehenderRaid(8), {
      shoutoutAktiv: false,
      shoutoutSchwelle: 3,
      textSchwelle: 3,
      textVoll: "Voll {channel} {viewers}",
      textKlein: "Danke {channel} für {viewers}!",
    }));

    expect(result.actions).toEqual([
      { kind: "chat", text: "Voll quelle 8" },
    ]);
    expect(result.diagnostics).toEqual([{
      code: "shoutout.unterdrueckt",
      detail: { grund: "abgeschaltet", zuschauer: 8, schwelle: 3 },
    }]);
  });

  it("erzeugt unter der Shoutout-Schwelle nur die kurze Chatzeile", () => {
    const result = verarbeiteRaid(event(eingehenderRaid(2), {
      shoutoutAktiv: true,
      shoutoutSchwelle: 3,
      textSchwelle: 3,
      textVoll: "Voll {channel} {viewers}",
      textKlein: "Danke {channel} für {viewers}!",
    }));

    expect(result.actions).toEqual([
      { kind: "chat", text: "Danke quelle für 2!" },
    ]);
    expect(result.diagnostics).toEqual([{
      code: "shoutout.unterdrueckt",
      detail: { grund: "unter_schwelle", zuschauer: 2, schwelle: 3 },
    }]);
  });

  it("wendet Shoutout- und Text-Schwelle unabhängig an", () => {
    const result = verarbeiteRaid(event(eingehenderRaid(10), {
      shoutoutAktiv: true,
      shoutoutSchwelle: 50,
      textSchwelle: 5,
      textVoll: "Voll {channel} {viewers}",
      textKlein: "Klein {channel} {viewers}",
    }));

    expect(result.actions).toEqual([
      { kind: "chat", text: "Voll quelle 10" },
    ]);
    expect(result.diagnostics).toEqual([{
      code: "shoutout.unterdrueckt",
      detail: { grund: "unter_schwelle", zuschauer: 10, schwelle: 50 },
    }]);
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
      shoutoutAktiv: true,
      shoutoutSchwelle: 0,
      textSchwelle: 0,
      textVoll: "{channel}/{viewers}",
      textKlein: "klein",
    }));

    expect(result.actions).toEqual([
      { kind: "shoutout", zielKanalId: "quelle-1" },
      { kind: "chat", text: "quelle/0" },
    ]);
  });

  it("begründet einen Raid unter der Schwelle", () => {
    const result = verarbeiteRaid(event(eingehenderRaid(2), {
      shoutoutAktiv: true,
      shoutoutSchwelle: 3,
      textSchwelle: 3,
      textVoll: "voll",
      textKlein: "klein",
    }));

    expect(result.diagnostics).toEqual([{
      code: "shoutout.unterdrueckt",
      detail: { grund: "unter_schwelle", zuschauer: 2, schwelle: 3 },
    }]);
  });

  it("ersetzt deutsche Raid-Platzhalter nicht mehr", () => {
    const result = verarbeiteRaid(event(eingehenderRaid(8), {
      shoutoutAktiv: false,
      shoutoutSchwelle: 3,
      textSchwelle: 3,
      textVoll: "{kanal} {zuschauer}",
      textKlein: "klein",
    }));

    expect(result.actions).toEqual([{ kind: "chat", text: "{kanal} {zuschauer}" }]);
  });
});
