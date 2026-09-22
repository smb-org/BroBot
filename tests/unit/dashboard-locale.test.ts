import { afterEach, describe, expect, it } from "vitest";

import { dashboardLanguage, ereignisText, ereignisTon, type EreignisCode } from "../../src/dashboard/locale";
import { roleLabel } from "../../src/dashboard/labels";
import { eventSubName } from "../../src/dashboard/module-labels";

const setBrowserLanguage = (language: string): void => {
  Object.defineProperty(window.navigator, "language", { value: language, configurable: true });
};

describe("Dashboard-Locale", () => {
  afterEach(() => {
    setBrowserLanguage("de-DE");
  });

  it("bestimmt die Panel-Sprache aus der Browsersprache", () => {
    setBrowserLanguage("en-US");

    expect(dashboardLanguage()).toBe("en");
    expect(roleLabel("manager")).toBe("Manager");
  });

  it("verwendet Deutsch für deutsche Browser", () => {
    setBrowserLanguage("de-AT");

    expect(dashboardLanguage()).toBe("de");
    expect(roleLabel("operator")).toBe("Bediener");
  });

  it("löst Ereignistexte mit Detail auf und behält feste Texte bei", () => {
    setBrowserLanguage("de-DE");

    expect(ereignisText("text_commands.ausgeloest", { name: "wiki" })).toBe("Befehl !wiki ausgeführt");
    expect(ereignisText("text_commands.ausgeloest")).toBe("Befehl ausgeführt");
    expect(ereignisText("text_commands.abgekuehlt", { name: "wiki", restSekunden: 4 })).toBe("Befehl !wiki abgekühlt, noch 4 s");
    expect(ereignisText("text_commands.abgekuehlt", { name: "wiki" })).toBe("Textbefehl abgekühlt");
    expect(ereignisText("text_commands.unbekannt", { name: "wiki" })).toBe("Textbefehl !wiki unbekannt");
    expect(ereignisText("text_commands.deaktiviert", { name: "wiki" })).toBe("Textbefehl !wiki ausgeschaltet");
    expect(ereignisText("text_commands.berechtigung", { name: "wiki", geforderteStufe: "moderator", vorhandeneStufe: ["viewer"] })).toBe("Befehl !wiki nicht ausgelöst: Mindeststufe Moderatoren, vorhanden Zuschauer");
    expect(ereignisText("host.chat.gesendet", { name: "wiki" })).toBe("Chat-Nachricht gesendet");
  });

  it("liefert die englischen Detailtexte", () => {
    setBrowserLanguage("en-US");

    expect(ereignisText("text_commands.ausgeloest", { name: "wiki" })).toBe("Command !wiki executed");
    expect(ereignisText("text_commands.abgekuehlt", { name: "wiki", restSekunden: 4 })).toBe("Command !wiki on cooldown, 4s left");
    expect(ereignisText("text_commands.bereits_vorhanden", { name: "wiki" })).toBe("Text command !wiki already exists");
    expect(ereignisText("text_commands.unbekannt", { name: "wiki" })).toBe("Unknown text command !wiki");
    expect(ereignisText("text_commands.deaktiviert", { name: "wiki" })).toBe("Text command !wiki disabled");
    expect(ereignisText("text_commands.berechtigung", { name: "wiki", geforderteStufe: "moderator", vorhandeneStufe: ["viewer"] })).toBe("Command !wiki not executed: minimum level moderators, present viewer");
  });

  it("unterscheidet abgeschalteten Shoutout von der Schwelle", () => {
    setBrowserLanguage("de-DE");
    expect(ereignisText("shoutout.unterdrueckt", { reason: "abgeschaltet" })).toBe("Shoutout abgeschaltet");
    expect(ereignisText("shoutout.unterdrueckt", { reason: "unter_schwelle", viewers: 2, schwelle: 3 }))
      .toBe("Shoutout unter der Schwelle (2 von 3 Zuschauern)");

    setBrowserLanguage("en-US");
    expect(ereignisText("shoutout.unterdrueckt", { reason: "abgeschaltet" })).toBe("Shoutout disabled");
    expect(ereignisText("shoutout.unterdrueckt", { reason: "unter_schwelle", viewers: 2, schwelle: 3 }))
      .toBe("Shoutout below threshold (2 of 3 viewers)");
  });

  it("rendert Moderationsdetails zweisprachig mit Bedeutungston", () => {
    setBrowserLanguage("de-DE");
    expect(ereignisText("channel_events.moderation.timeout", {
      person: "Alice", moderator: "Mod", dauer: 300, reason: "Spam",
    })).toBe("Alice für 300 Sekunden getimeoutet von Mod: Spam");
    expect(ereignisTon["channel_events.moderation.timeout"]).toMatchObject({ familie: "moderation", stufe: "voll", zahlSchluessel: "dauer" });
    expect(ereignisTon["channel_events.moderation.untimeout"]).toMatchObject({ familie: "moderation", stufe: "gezeichnet" });
    expect(ereignisTon["channel_events.moderation.unban"]).toMatchObject({ familie: "moderation", stufe: "gezeichnet" });
    expect(ereignisTon["channel_events.moderation.unbekannt"]).toMatchObject({ familie: "moderation", stufe: "voll" });

    setBrowserLanguage("en-US");
    expect(ereignisText("channel_events.moderation.unbekannt", { aktion: "shared_chat_ban" })).toBe("Unknown moderation action: shared_chat_ban");
  });

  it("führt für jeden bekannten Ereigniscode Familie, Stufe, Wort und Zahl-Schlüssel", () => {
    const codes: EreignisCode[] = [
      "host.aktion.fehler", "host.chat.fehlgeschlagen", "host.chat.gesendet", "host.modul.fehler",
      "host.modul.unbekannt", "host.overlay.nicht_ausgefuehrt", "host.shoutout.fehlgeschlagen", "host.shoutout.gesendet", "channel_events.raid.incoming",
      "channel_events.raid.outgoing", "channel_events.shoutout.gesendet", "channel_events.shoutout.empfangen",
      "channel_events.chat.sub", "channel_events.chat.resub", "channel_events.chat.gift_sub",
      "channel_events.chat.community_gift", "channel_events.chat.ankuendigung", "channel_events.chat.unbekannt",
      "channel_events.moderation.ban", "channel_events.moderation.timeout", "channel_events.moderation.untimeout",
      "channel_events.moderation.unban", "channel_events.moderation.delete", "channel_events.moderation.warn",
      "channel_events.moderation.unbekannt", "channel_events.automod.halte", "channel_events.verdacht.nachricht",
      "channel_events.verdacht.einstufung", "channel_events.verdacht.entwarnung", "raid.outgoing", "raid.shoutout", "raid.ungueltig", "shoutout.unterdrueckt",
      "ads.ankuendigung", "ads.uebersprungen", "ads.vorwarnung.angekuendigt", "ads.vorwarnung.kein_termin",
      "ads.vorwarnung.zu_spaet", "ads.vorwarnung.pause_begonnen", "ads.vorwarnung.termin_verschoben",
      "ads.vorwarnung.scope_fehlt", "ads.vorwarnung.zeitplan_fehler", "ads.snooze", "text_commands.abgekuehlt", "text_commands.ausgeloest",
      "text_commands.deaktiviert", "text_commands.berechtigung", "text_commands.bereits_vorhanden",
      "text_commands.nicht_berechtigt", "text_commands.unbekannt", "text_commands.ungueltig",
    ];

    expect(Object.keys(ereignisTon).sort()).toEqual([...codes].sort());
    expect(ereignisTon["channel_events.chat.community_gift"]).toEqual({
      familie: "gemeinschaft", stufe: "voll", wort: { de: "Gift", en: "Gift" }, zahlSchluessel: "count",
    });
    expect(ereignisTon["channel_events.raid.incoming"]).toEqual({
      familie: "raid", stufe: "voll", wort: { de: "Raid", en: "Raid" }, zahlSchluessel: "viewers",
    });
    expect(ereignisTon["channel_events.moderation.untimeout"]).toEqual({
      familie: "moderation", stufe: "gezeichnet", wort: { de: "Entsperrt", en: "Untimeout" }, zahlSchluessel: null,
    });
    expect(ereignisTon["host.chat.gesendet"]).toEqual({
      familie: "betrieb", stufe: "gezeichnet", wort: { de: "Info", en: "Info" }, zahlSchluessel: null, tone: "info",
    });
    for (const code of codes) {
      expect(ereignisTon[code].wort.de.length).toBeLessThanOrEqual(12);
      expect(ereignisTon[code].wort.en.length).toBeLessThanOrEqual(12);
    }
  });

  it("benennt EventSub-Abos im Panel zweisprachig", () => {
    setBrowserLanguage("de-DE");
    expect(eventSubName("channel.moderate")).toBe("Moderationsereignisse");
    expect(eventSubName("automod.message.hold")).toBe("AutoMod-Haltevorgänge");
    expect(eventSubName("channel.suspicious_user.message")).toBe("Nachrichten auffälliger Nutzer");
    expect(eventSubName("channel.suspicious_user.update")).toBe("Einstufungen auffälliger Nutzer");

    setBrowserLanguage("en-US");
    expect(eventSubName("channel.moderate")).toBe("Moderation events");
    expect(eventSubName("automod.message.hold")).toBe("AutoMod holds");
    expect(eventSubName("channel.suspicious_user.message")).toBe("Suspicious user messages");
    expect(eventSubName("channel.suspicious_user.update")).toBe("Suspicious user classifications");
  });

  it("rendert AutoMod- und Verdachtsereignisse zweisprachig mit ihrem Bedeutungston", () => {
    setBrowserLanguage("de-DE");
    expect(ereignisText("channel_events.automod.halte", {
      person: "Alice", reason: "aggressive", text: "Nachricht",
    })).toBe("AutoMod hielt die Nachricht von Alice wegen aggressive: Nachricht");
    expect(ereignisText("channel_events.verdacht.nachricht", {
      person: "Alice", einstufung: "restricted / ban_evader / possible", text: "Nachricht",
    })).toBe("Nachricht von auffälligem Nutzer Alice (restricted / ban_evader / possible): Nachricht");
    expect(ereignisText("channel_events.verdacht.einstufung", {
      person: "Alice", einstufung: "restricted", moderator: "Mod",
    })).toBe("Einstufung von Alice verschärft von Mod: restricted");
    expect(ereignisText("channel_events.verdacht.entwarnung", {
      person: "Alice", einstufung: "none", moderator: "Mod",
    })).toBe("Einstufung von Alice aufgehoben von Mod");
    expect(ereignisTon["channel_events.automod.halte"]).toMatchObject({ familie: "moderation", stufe: "voll" });
    expect(ereignisTon["channel_events.verdacht.nachricht"]).toMatchObject({ familie: "moderation", stufe: "voll" });
    expect(ereignisTon["channel_events.verdacht.einstufung"]).toMatchObject({ familie: "moderation", stufe: "voll" });
    expect(ereignisTon["channel_events.verdacht.entwarnung"]).toMatchObject({ familie: "moderation", stufe: "gezeichnet" });

    setBrowserLanguage("en-US");
    expect(ereignisText("channel_events.automod.halte", {
      person: "Alice", reason: "aggressive", text: "Message",
    })).toBe("AutoMod held a message from Alice for aggressive: Message");
    expect(ereignisText("channel_events.verdacht.entwarnung", {
      person: "Alice", moderator: "Mod",
    })).toBe("Classification for Alice cleared by Mod");
  });
});
