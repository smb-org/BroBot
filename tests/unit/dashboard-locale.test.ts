import { afterEach, describe, expect, it } from "vitest";

import { dashboardLanguage, eventText, eventToneEntries, type EventCode } from "../../src/dashboard/locale";
import { roleLabel } from "../../src/dashboard/labels";
import { eventSubName } from "../../src/dashboard/module-labels";

const setBrowserLanguage = (language: string): void => {
  Object.defineProperty(window.navigator, "language", { value: language, configurable: true });
};

describe("dashboard locale", () => {
  afterEach(() => {
    setBrowserLanguage("de-DE");
  });

  it("determines the panel language from the browser language", () => {
    setBrowserLanguage("en-US");

    expect(dashboardLanguage()).toBe("en");
    expect(roleLabel("manager")).toBe("Manager");
  });

  it("uses German for German browsers", () => {
    setBrowserLanguage("de-AT");

    expect(dashboardLanguage()).toBe("de");
    expect(roleLabel("operator")).toBe("Bediener");
  });

  it("resolves event texts with detail and keeps fixed texts intact", () => {
    setBrowserLanguage("de-DE");

    expect(eventText("text_commands.ausgeloest", { name: "wiki" })).toBe("Befehl !wiki ausgeführt");
    expect(eventText("text_commands.ausgeloest")).toBe("Befehl ausgeführt");
    expect(eventText("text_commands.abgekuehlt", { name: "wiki", remainingSeconds: 4 })).toBe("Befehl !wiki abgekühlt, noch 4 s");
    expect(eventText("text_commands.abgekuehlt", { name: "wiki" })).toBe("Textbefehl abgekühlt");
    expect(eventText("text_commands.unbekannt", { name: "wiki" })).toBe("Textbefehl !wiki unbekannt");
    expect(eventText("text_commands.deaktiviert", { name: "wiki" })).toBe("Textbefehl !wiki ausgeschaltet");
    expect(eventText("text_commands.berechtigung", { name: "wiki", requiredTier: "moderator", currentTier: ["viewer"] })).toBe("Befehl !wiki nicht ausgelöst: Mindeststufe Moderatoren, vorhanden Zuschauer");
    expect(eventText("host.chat.gesendet", { name: "wiki" })).toBe("Chat-Nachricht gesendet");
  });

  it("returns the English detail texts", () => {
    setBrowserLanguage("en-US");

    expect(eventText("text_commands.ausgeloest", { name: "wiki" })).toBe("Command !wiki executed");
    expect(eventText("text_commands.abgekuehlt", { name: "wiki", remainingSeconds: 4 })).toBe("Command !wiki on cooldown, 4s left");
    expect(eventText("text_commands.bereits_vorhanden", { name: "wiki" })).toBe("Text command !wiki already exists");
    expect(eventText("text_commands.unbekannt", { name: "wiki" })).toBe("Unknown text command !wiki");
    expect(eventText("text_commands.deaktiviert", { name: "wiki" })).toBe("Text command !wiki disabled");
    expect(eventText("text_commands.berechtigung", { name: "wiki", requiredTier: "moderator", currentTier: ["viewer"] })).toBe("Command !wiki not executed: minimum level moderators, present viewer");
  });

  it("distinguishes a disabled shoutout from the threshold", () => {
    setBrowserLanguage("de-DE");
    expect(eventText("shoutout.unterdrueckt", { reason: "abgeschaltet" })).toBe("Shoutout abgeschaltet");
    expect(eventText("shoutout.unterdrueckt", { reason: "unter_schwelle", viewers: 2, threshold: 3 }))
      .toBe("Shoutout unter der Schwelle (2 von 3 Zuschauern)");

    setBrowserLanguage("en-US");
    expect(eventText("shoutout.unterdrueckt", { reason: "abgeschaltet" })).toBe("Shoutout disabled");
    expect(eventText("shoutout.unterdrueckt", { reason: "unter_schwelle", viewers: 2, threshold: 3 }))
      .toBe("Shoutout below threshold (2 of 3 viewers)");
  });

  it("renders moderation details bilingually with a meaning-carrying tone", () => {
    setBrowserLanguage("de-DE");
    expect(eventText("channel_events.moderation.timeout", {
      person: "Alice", moderator: "Mod", duration: 300, reason: "Spam",
    })).toBe("Alice für 300 Sekunden getimeoutet von Mod: Spam");
    expect(eventToneEntries["channel_events.moderation.timeout"]).toMatchObject({ familie: "moderation", tier: "voll", zahlSchluessel: "duration" });
    expect(eventToneEntries["channel_events.moderation.untimeout"]).toMatchObject({ familie: "moderation", tier: "gezeichnet" });
    expect(eventToneEntries["channel_events.moderation.unban"]).toMatchObject({ familie: "moderation", tier: "gezeichnet" });
    expect(eventToneEntries["channel_events.moderation.unbekannt"]).toMatchObject({ familie: "moderation", tier: "voll" });

    setBrowserLanguage("en-US");
    expect(eventText("channel_events.moderation.unbekannt", { action: "shared_chat_ban" })).toBe("Unknown moderation action: shared_chat_ban");
  });

  it("carries family, tier, word, and number key for every known event code", () => {
    const codes: EventCode[] = [
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

    expect(Object.keys(eventToneEntries).sort()).toEqual([...codes].sort());
    expect(eventToneEntries["channel_events.chat.community_gift"]).toEqual({
      familie: "gemeinschaft", tier: "voll", wort: { de: "Gift", en: "Gift" }, zahlSchluessel: "count",
    });
    expect(eventToneEntries["channel_events.raid.incoming"]).toEqual({
      familie: "raid", tier: "voll", wort: { de: "Raid", en: "Raid" }, zahlSchluessel: "viewers",
    });
    expect(eventToneEntries["channel_events.moderation.untimeout"]).toEqual({
      familie: "moderation", tier: "gezeichnet", wort: { de: "Entsperrt", en: "Untimeout" }, zahlSchluessel: null,
    });
    expect(eventToneEntries["host.chat.gesendet"]).toEqual({
      familie: "betrieb", tier: "gezeichnet", wort: { de: "Info", en: "Info" }, zahlSchluessel: null, tone: "info",
    });
    for (const code of codes) {
      expect(eventToneEntries[code].wort.de.length).toBeLessThanOrEqual(12);
      expect(eventToneEntries[code].wort.en.length).toBeLessThanOrEqual(12);
    }
  });

  it("names EventSub subscriptions bilingually in the panel", () => {
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

  it("renders AutoMod and suspicious-user events bilingually with their meaning-carrying tone", () => {
    setBrowserLanguage("de-DE");
    expect(eventText("channel_events.automod.halte", {
      person: "Alice", reason: "aggressive", text: "Nachricht",
    })).toBe("AutoMod hielt die Nachricht von Alice wegen aggressive: Nachricht");
    expect(eventText("channel_events.verdacht.nachricht", {
      person: "Alice", einstufung: "restricted / ban_evader / possible", text: "Nachricht",
    })).toBe("Nachricht von auffälligem Nutzer Alice (restricted / ban_evader / possible): Nachricht");
    expect(eventText("channel_events.verdacht.einstufung", {
      person: "Alice", einstufung: "restricted", moderator: "Mod",
    })).toBe("Einstufung von Alice verschärft von Mod: restricted");
    expect(eventText("channel_events.verdacht.entwarnung", {
      person: "Alice", einstufung: "none", moderator: "Mod",
    })).toBe("Einstufung von Alice aufgehoben von Mod");
    expect(eventToneEntries["channel_events.automod.halte"]).toMatchObject({ familie: "moderation", tier: "voll" });
    expect(eventToneEntries["channel_events.verdacht.nachricht"]).toMatchObject({ familie: "moderation", tier: "voll" });
    expect(eventToneEntries["channel_events.verdacht.einstufung"]).toMatchObject({ familie: "moderation", tier: "voll" });
    expect(eventToneEntries["channel_events.verdacht.entwarnung"]).toMatchObject({ familie: "moderation", tier: "gezeichnet" });

    setBrowserLanguage("en-US");
    expect(eventText("channel_events.automod.halte", {
      person: "Alice", reason: "aggressive", text: "Message",
    })).toBe("AutoMod held a message from Alice for aggressive: Message");
    expect(eventText("channel_events.verdacht.entwarnung", {
      person: "Alice", moderator: "Mod",
    })).toBe("Classification for Alice cleared by Mod");
  });
});
