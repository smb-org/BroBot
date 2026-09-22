import { describe, expect, it } from "vitest";

import { raidModul, verarbeiteRaid } from "../../src/modules/raid";
import { raidSettingsSchema } from "../../src/modules/raid/contracts";
import type { ModuleEvent } from "../../src/modules/contract";

const event = (
  payload: Record<string, unknown>,
  settings = raidModul.defaultSettings,
  subscriptionVariant = "incoming",
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
      textLong: "voll",
      textShort: "klein",
    })).toEqual({
      shoutoutEnabled: true,
      shoutoutThreshold: 3,
      textThreshold: 3,
      textLong: "voll",
      textShort: "klein",
    });
  });

  it("abonniert channel.raid ohne Broadcaster-Scope", () => {
    expect(raidModul.eventSubTypes).toEqual(["channel.raid"]);
    expect(raidModul.broadcasterScopes).toBeUndefined();
  });

  it("erzeugt ab der Shoutout-Schwelle Shoutout und volle Chatzeile", () => {
    const result = verarbeiteRaid(event(eingehenderRaid(8), {
      shoutoutEnabled: true,
      shoutoutThreshold: 3,
      textThreshold: 3,
      textLong: "Willkommen {channel} mit {viewers} Zuschauern!",
      textShort: "Danke {channel}!",
    }));

    expect(result.actions).toEqual([
      { kind: "shoutout", targetChannelId: "quelle-1" },
      { kind: "chat", text: "Willkommen quelle mit 8 Zuschauern!" },
    ]);
  });

  it("erzeugt ab der Shoutout-Schwelle ohne Schalter nur die volle Chatzeile", () => {
    const result = verarbeiteRaid(event(eingehenderRaid(8), {
      shoutoutEnabled: false,
      shoutoutThreshold: 3,
      textThreshold: 3,
      textLong: "Voll {channel} {viewers}",
      textShort: "Danke {channel} für {viewers}!",
    }));

    expect(result.actions).toEqual([
      { kind: "chat", text: "Voll quelle 8" },
    ]);
    expect(result.diagnostics).toEqual([{
      code: "shoutout.unterdrueckt",
      detail: { reason: "abgeschaltet", viewers: 8, schwelle: 3 },
    }]);
  });

  it("erzeugt unter der Shoutout-Schwelle nur die kurze Chatzeile", () => {
    const result = verarbeiteRaid(event(eingehenderRaid(2), {
      shoutoutEnabled: true,
      shoutoutThreshold: 3,
      textThreshold: 3,
      textLong: "Voll {channel} {viewers}",
      textShort: "Danke {channel} für {viewers}!",
    }));

    expect(result.actions).toEqual([
      { kind: "chat", text: "Danke quelle für 2!" },
    ]);
    expect(result.diagnostics).toEqual([{
      code: "shoutout.unterdrueckt",
      detail: { reason: "unter_schwelle", viewers: 2, schwelle: 3 },
    }]);
  });

  it("wendet Shoutout- und Text-Schwelle unabhängig an", () => {
    const result = verarbeiteRaid(event(eingehenderRaid(10), {
      shoutoutEnabled: true,
      shoutoutThreshold: 50,
      textThreshold: 5,
      textLong: "Voll {channel} {viewers}",
      textShort: "Klein {channel} {viewers}",
    }));

    expect(result.actions).toEqual([
      { kind: "chat", text: "Voll quelle 10" },
    ]);
    expect(result.diagnostics).toEqual([{
      code: "shoutout.unterdrueckt",
      detail: { reason: "unter_schwelle", viewers: 10, schwelle: 50 },
    }]);
  });

  it("meldet einen ausgehenden Raid und erzeugt keine Aktion", () => {
    const result = verarbeiteRaid(event({
      from_broadcaster_user_id: "kanal-a",
      to_broadcaster_user_id: "ziel-1",
      viewers: 20,
    }, raidModul.defaultSettings, "outgoing"));

    expect(result.actions).toEqual([]);
    expect(result.diagnostics).toEqual([{
      code: "raid.outgoing",
      detail: { targetChannelId: "ziel-1", viewers: 20 },
    }]);
  });

  it("ersetzt beide Platzhalter und behandelt Schwelle null inklusiv", () => {
    const result = verarbeiteRaid(event(eingehenderRaid(0), {
      shoutoutEnabled: true,
      shoutoutThreshold: 0,
      textThreshold: 0,
      textLong: "{channel}/{viewers}",
      textShort: "klein",
    }));

    expect(result.actions).toEqual([
      { kind: "shoutout", targetChannelId: "quelle-1" },
      { kind: "chat", text: "quelle/0" },
    ]);
  });

  it("begründet einen Raid unter der Schwelle", () => {
    const result = verarbeiteRaid(event(eingehenderRaid(2), {
      shoutoutEnabled: true,
      shoutoutThreshold: 3,
      textThreshold: 3,
      textLong: "voll",
      textShort: "klein",
    }));

    expect(result.diagnostics).toEqual([{
      code: "shoutout.unterdrueckt",
      detail: { reason: "unter_schwelle", viewers: 2, schwelle: 3 },
    }]);
  });

  it("ersetzt deutsche Raid-Platzhalter nicht mehr", () => {
    const result = verarbeiteRaid(event(eingehenderRaid(8), {
      shoutoutEnabled: false,
      shoutoutThreshold: 3,
      textThreshold: 3,
      textLong: "{kanal} {zuschauer}",
      textShort: "klein",
    }));

    expect(result.actions).toEqual([{ kind: "chat", text: "{kanal} {zuschauer}" }]);
  });
});
