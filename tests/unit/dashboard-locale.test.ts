import { afterEach, describe, expect, it } from "vitest";

import { dashboardLanguage, ereignisText, ereignisTon } from "../../src/dashboard/locale";
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
    expect(roleLabel("verwalter")).toBe("Manager");
  });

  it("verwendet Deutsch für deutsche Browser", () => {
    setBrowserLanguage("de-AT");

    expect(dashboardLanguage()).toBe("de");
    expect(roleLabel("bediener")).toBe("Bediener");
  });

  it("löst Ereignistexte mit Detail auf und behält feste Texte bei", () => {
    setBrowserLanguage("de-DE");

    expect(ereignisText("textbefehle.ausgeloest", { name: "wiki" })).toBe("Befehl !wiki ausgeführt");
    expect(ereignisText("textbefehle.ausgeloest")).toBe("Befehl ausgeführt");
    expect(ereignisText("textbefehle.abgekuehlt", { name: "wiki", restSekunden: 4 })).toBe("Befehl !wiki abgekühlt, noch 4 s");
    expect(ereignisText("textbefehle.abgekuehlt", { name: "wiki" })).toBe("Textbefehl abgekühlt");
    expect(ereignisText("textbefehle.unbekannt", { name: "wiki" })).toBe("Textbefehl !wiki unbekannt");
    expect(ereignisText("textbefehle.deaktiviert", { name: "wiki" })).toBe("Textbefehl !wiki ausgeschaltet");
    expect(ereignisText("textbefehle.berechtigung", { name: "wiki", geforderteStufe: "moderator", vorhandeneStufe: ["zuschauer"] })).toBe("Befehl !wiki nicht ausgelöst: Mindeststufe Moderatoren, vorhanden Zuschauer");
    expect(ereignisText("host.chat.gesendet", { name: "wiki" })).toBe("Chat-Nachricht gesendet");
  });

  it("liefert die englischen Detailtexte", () => {
    setBrowserLanguage("en-US");

    expect(ereignisText("textbefehle.ausgeloest", { name: "wiki" })).toBe("Command !wiki executed");
    expect(ereignisText("textbefehle.abgekuehlt", { name: "wiki", restSekunden: 4 })).toBe("Command !wiki on cooldown, 4s left");
    expect(ereignisText("textbefehle.bereits_vorhanden", { name: "wiki" })).toBe("Text command !wiki already exists");
    expect(ereignisText("textbefehle.unbekannt", { name: "wiki" })).toBe("Unknown text command !wiki");
    expect(ereignisText("textbefehle.deaktiviert", { name: "wiki" })).toBe("Text command !wiki disabled");
    expect(ereignisText("textbefehle.berechtigung", { name: "wiki", geforderteStufe: "moderator", vorhandeneStufe: ["zuschauer"] })).toBe("Command !wiki not executed: minimum level moderators, present viewer");
  });

  it("rendert Moderationsdetails zweisprachig mit Bedeutungston", () => {
    setBrowserLanguage("de-DE");
    expect(ereignisText("kanalereignisse.moderation.timeout", {
      person: "Alice", moderator: "Mod", dauer: 300, grund: "Spam",
    })).toBe("Alice für 300 Sekunden getimeoutet von Mod: Spam");
    expect(ereignisTon["kanalereignisse.moderation.timeout"]).toBe("amber");
    expect(ereignisTon["kanalereignisse.moderation.untimeout"]).toBe("green");
    expect(ereignisTon["kanalereignisse.moderation.unban"]).toBe("green");
    expect(ereignisTon["kanalereignisse.moderation.unbekannt"]).toBe("off");

    setBrowserLanguage("en-US");
    expect(ereignisText("kanalereignisse.moderation.unbekannt", { aktion: "shared_chat_ban" })).toBe("Unknown moderation action: shared_chat_ban");
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
    expect(ereignisText("kanalereignisse.automod.halte", {
      person: "Alice", grund: "aggressive", text: "Nachricht",
    })).toBe("AutoMod hielt die Nachricht von Alice wegen aggressive: Nachricht");
    expect(ereignisText("kanalereignisse.verdacht.nachricht", {
      person: "Alice", einstufung: "restricted / ban_evader / possible", text: "Nachricht",
    })).toBe("Nachricht von auffälligem Nutzer Alice (restricted / ban_evader / possible): Nachricht");
    expect(ereignisText("kanalereignisse.verdacht.einstufung", {
      person: "Alice", einstufung: "restricted", moderator: "Mod",
    })).toBe("Einstufung von Alice verschärft von Mod: restricted");
    expect(ereignisText("kanalereignisse.verdacht.entwarnung", {
      person: "Alice", einstufung: "none", moderator: "Mod",
    })).toBe("Einstufung von Alice aufgehoben von Mod");
    expect(ereignisTon["kanalereignisse.automod.halte"]).toBe("amber");
    expect(ereignisTon["kanalereignisse.verdacht.nachricht"]).toBe("amber");
    expect(ereignisTon["kanalereignisse.verdacht.einstufung"]).toBe("amber");
    expect(ereignisTon["kanalereignisse.verdacht.entwarnung"]).toBe("green");

    setBrowserLanguage("en-US");
    expect(ereignisText("kanalereignisse.automod.halte", {
      person: "Alice", grund: "aggressive", text: "Message",
    })).toBe("AutoMod held a message from Alice for aggressive: Message");
    expect(ereignisText("kanalereignisse.verdacht.entwarnung", {
      person: "Alice", moderator: "Mod",
    })).toBe("Classification for Alice cleared by Mod");
  });
});
