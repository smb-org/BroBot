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

    expect(eventText("text_commands.triggered", { name: "wiki" })).toBe("Befehl !wiki ausgeführt");
    expect(eventText("text_commands.triggered")).toBe("Befehl ausgeführt");
    expect(eventText("text_commands.cooldown", { name: "wiki", remainingSeconds: 4 })).toBe("Befehl !wiki abgekühlt, noch 4 s");
    expect(eventText("text_commands.cooldown", { name: "wiki" })).toBe("Textbefehl abgekühlt");
    expect(eventText("text_commands.unknown", { name: "wiki" })).toBe("Textbefehl !wiki unbekannt");
    expect(eventText("text_commands.disabled", { name: "wiki" })).toBe("Textbefehl !wiki ausgeschaltet");
    expect(eventText("text_commands.permission_denied", { name: "wiki", requiredTier: "moderator", currentTier: ["viewer"] })).toBe("Befehl !wiki nicht ausgelöst: Mindeststufe Moderatoren, vorhanden Zuschauer");
    expect(eventText("host.chat.sent", { name: "wiki" })).toBe("Chat-Nachricht gesendet");
  });

  it("returns the English detail texts", () => {
    setBrowserLanguage("en-US");

    expect(eventText("text_commands.triggered", { name: "wiki" })).toBe("Command !wiki executed");
    expect(eventText("text_commands.cooldown", { name: "wiki", remainingSeconds: 4 })).toBe("Command !wiki on cooldown, 4s left");
    expect(eventText("text_commands.already_exists", { name: "wiki" })).toBe("Text command !wiki already exists");
    expect(eventText("text_commands.unknown", { name: "wiki" })).toBe("Unknown text command !wiki");
    expect(eventText("text_commands.disabled", { name: "wiki" })).toBe("Text command !wiki disabled");
    expect(eventText("text_commands.permission_denied", { name: "wiki", requiredTier: "moderator", currentTier: ["viewer"] })).toBe("Command !wiki not executed: minimum level moderators, present viewer");
  });

  it("distinguishes a disabled shoutout from the threshold", () => {
    setBrowserLanguage("de-DE");
    expect(eventText("shoutout.suppressed", { reason: "abgeschaltet" })).toBe("Shoutout abgeschaltet");
    expect(eventText("shoutout.suppressed", { reason: "unter_schwelle", viewers: 2, threshold: 3 }))
      .toBe("Shoutout unter der Schwelle (2 von 3 Zuschauern)");

    setBrowserLanguage("en-US");
    expect(eventText("shoutout.suppressed", { reason: "abgeschaltet" })).toBe("Shoutout disabled");
    expect(eventText("shoutout.suppressed", { reason: "unter_schwelle", viewers: 2, threshold: 3 }))
      .toBe("Shoutout below threshold (2 of 3 viewers)");
  });

  it("renders moderation details bilingually with a meaning-carrying tone", () => {
    setBrowserLanguage("de-DE");
    expect(eventText("channel_events.moderation.timeout", {
      person: "Alice", moderator: "Mod", duration: 300, reason: "Spam",
    })).toBe("Alice für 300 Sekunden getimeoutet von Mod: Spam");
    expect(eventToneEntries["channel_events.moderation.timeout"]).toMatchObject({ family: "moderation", tier: "voll", numberKey: "duration" });
    expect(eventToneEntries["channel_events.moderation.untimeout"]).toMatchObject({ family: "moderation", tier: "gezeichnet" });
    expect(eventToneEntries["channel_events.moderation.unban"]).toMatchObject({ family: "moderation", tier: "gezeichnet" });
    expect(eventToneEntries["channel_events.moderation.unknown"]).toMatchObject({ family: "moderation", tier: "voll" });

    setBrowserLanguage("en-US");
    expect(eventText("channel_events.moderation.unknown", { action: "shared_chat_ban" })).toBe("Unknown moderation action: shared_chat_ban");
  });

  it("carries family, tier, word, and number key for every known event code", () => {
    const codes: EventCode[] = [
      "host.action.failed", "host.chat.failed", "host.chat.sent", "host.module.error",
      "host.module.unknown", "host.overlay.not_executed", "host.shoutout.failed", "host.shoutout.sent", "channel_events.raid.incoming",
      "channel_events.raid.outgoing", "channel_events.shoutout.sent", "channel_events.shoutout.received",
      "channel_events.chat.sub", "channel_events.chat.resub", "channel_events.chat.gift_sub",
      "channel_events.chat.community_gift", "channel_events.chat.announcement", "channel_events.chat.unknown",
      "channel_events.moderation.ban", "channel_events.moderation.timeout", "channel_events.moderation.untimeout",
      "channel_events.moderation.unban", "channel_events.moderation.delete", "channel_events.moderation.warn",
      "channel_events.moderation.unknown", "channel_events.automod.held", "channel_events.suspicious.message",
      "channel_events.suspicious.classified", "channel_events.suspicious.cleared", "raid.outgoing", "raid.shoutout", "raid.invalid", "shoutout.suppressed",
      "ads.announcement", "ads.skipped", "ads.prewarning.announced", "ads.prewarning.no_schedule",
      "ads.prewarning.too_late", "ads.prewarning.break_started", "ads.prewarning.rescheduled",
      "ads.prewarning.scope_missing", "ads.prewarning.schedule_error", "ads.snooze", "text_commands.cooldown", "text_commands.triggered",
      "text_commands.disabled", "text_commands.permission_denied", "text_commands.already_exists",
      "text_commands.not_authorized", "text_commands.unknown", "text_commands.invalid",
    ];

    expect(Object.keys(eventToneEntries).sort()).toEqual([...codes].sort());
    expect(eventToneEntries["channel_events.chat.community_gift"]).toEqual({
      family: "gemeinschaft", tier: "voll", word: { de: "Gift", en: "Gift" }, numberKey: "count",
    });
    expect(eventToneEntries["channel_events.raid.incoming"]).toEqual({
      family: "raid", tier: "voll", word: { de: "Raid", en: "Raid" }, numberKey: "viewers",
    });
    expect(eventToneEntries["channel_events.moderation.untimeout"]).toEqual({
      family: "moderation", tier: "gezeichnet", word: { de: "Entsperrt", en: "Untimeout" }, numberKey: null,
    });
    expect(eventToneEntries["host.chat.sent"]).toEqual({
      family: "betrieb", tier: "gezeichnet", word: { de: "Info", en: "Info" }, numberKey: null, tone: "info",
    });
    for (const code of codes) {
      expect(eventToneEntries[code].word.de.length).toBeLessThanOrEqual(12);
      expect(eventToneEntries[code].word.en.length).toBeLessThanOrEqual(12);
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
    expect(eventText("channel_events.automod.held", {
      person: "Alice", reason: "aggressive", text: "Nachricht",
    })).toBe("AutoMod hielt die Nachricht von Alice wegen aggressive: Nachricht");
    expect(eventText("channel_events.suspicious.message", {
      person: "Alice", einstufung: "restricted / ban_evader / possible", text: "Nachricht",
    })).toBe("Nachricht von auffälligem Nutzer Alice (restricted / ban_evader / possible): Nachricht");
    expect(eventText("channel_events.suspicious.classified", {
      person: "Alice", einstufung: "restricted", moderator: "Mod",
    })).toBe("Einstufung von Alice verschärft von Mod: restricted");
    expect(eventText("channel_events.suspicious.cleared", {
      person: "Alice", einstufung: "none", moderator: "Mod",
    })).toBe("Einstufung von Alice aufgehoben von Mod");
    expect(eventToneEntries["channel_events.automod.held"]).toMatchObject({ family: "moderation", tier: "voll" });
    expect(eventToneEntries["channel_events.suspicious.message"]).toMatchObject({ family: "moderation", tier: "voll" });
    expect(eventToneEntries["channel_events.suspicious.classified"]).toMatchObject({ family: "moderation", tier: "voll" });
    expect(eventToneEntries["channel_events.suspicious.cleared"]).toMatchObject({ family: "moderation", tier: "gezeichnet" });

    setBrowserLanguage("en-US");
    expect(eventText("channel_events.automod.held", {
      person: "Alice", reason: "aggressive", text: "Message",
    })).toBe("AutoMod held a message from Alice for aggressive: Message");
    expect(eventText("channel_events.suspicious.cleared", {
      person: "Alice", moderator: "Mod",
    })).toBe("Classification for Alice cleared by Mod");
  });
});
