import { afterEach, describe, expect, it } from "vitest";

import { dashboardLanguage, ereignisText, ereignisTon } from "../../src/dashboard/locale";
import { roleLabel } from "../../src/dashboard/labels";

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
    expect(ereignisText("host.chat.gesendet", { name: "wiki" })).toBe("Chat-Nachricht gesendet");
  });

  it("liefert die englischen Detailtexte", () => {
    setBrowserLanguage("en-US");

    expect(ereignisText("textbefehle.ausgeloest", { name: "wiki" })).toBe("Command !wiki executed");
    expect(ereignisText("textbefehle.abgekuehlt", { name: "wiki", restSekunden: 4 })).toBe("Command !wiki on cooldown, 4s left");
    expect(ereignisText("textbefehle.bereits_vorhanden", { name: "wiki" })).toBe("Text command !wiki already exists");
    expect(ereignisText("textbefehle.unbekannt", { name: "wiki" })).toBe("Unknown text command !wiki");
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
});
