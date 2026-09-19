import { describe, expect, it } from "vitest";

import type { ModuleEvent, ModuleResult } from "../../src/modules/contract";
import { verarbeiteTextbefehlNachricht } from "../../src/modules/textbefehle/service";
import type { Textbefehl, TextbefehlRepository } from "../../src/modules/textbefehle";

const JETZT = "2026-09-19T12:00:00.000Z";

const befehl = (name: string, text: string, zuletztVerwendetAt: string | null = null): Textbefehl => ({
  channelId: "kanal-a",
  name,
  text,
  cooldownSekunden: 5,
  zuletztVerwendetAt,
  createdAt: JETZT,
  updatedAt: JETZT,
});

const repositoryFuer = (befehle: Textbefehl[]): TextbefehlRepository => ({
  auflisten: () => Promise.resolve(befehle),
  finden: (_channelId, name) => Promise.resolve(befehle.find((eintrag) => eintrag.name === name) ?? null),
  anlegen: () => Promise.resolve(true),
  aendern: () => Promise.resolve(true),
  loeschen: () => Promise.resolve(true),
  beanspruchen: (_channelId, name) => {
    const eintrag = befehle.find((candidate) => candidate.name === name);
    return Promise.resolve(eintrag === undefined ? null : { befehl: eintrag, beansprucht: eintrag.zuletztVerwendetAt === null });
  },
});

const eventFuer = (text: string, actor: ModuleEvent["actor"] = {
  userId: "user-1", login: "alice", role: "bediener",
}): ModuleEvent => ({
  channelId: "kanal-a",
  subscriptionType: "channel.chat.message",
  triggerId: "nachricht-1",
  payload: {
    message: { text },
    message_id: "twitch-message-1",
    broadcaster_user_login: "kanal-a-login",
  },
  settings: {},
  receivedAt: JETZT,
  actor,
});

describe("Textbefehle-Service", () => {
  it("ersetzt User und Kanal im gespeicherten Antworttext", async () => {
    const result: ModuleResult = await verarbeiteTextbefehlNachricht(
      eventFuer("!hallo"),
      repositoryFuer([befehl("hallo", "Hallo {user} in {channel}")]),
    );

    expect(result.actions).toEqual([{
      kind: "chat",
      text: "Hallo alice in kanal-a-login",
      replyToMessageId: "twitch-message-1",
    }]);
  });

  it("schweigt bei einem unbekannten Befehl und begründet das", async () => {
    const result = await verarbeiteTextbefehlNachricht(eventFuer("!gibt-es-nicht"), repositoryFuer([]));

    expect(result.actions).toEqual([]);
    expect(result.diagnostics).toEqual([{ code: "textbefehle.unbekannt", detail: { name: "gibt-es-nicht" } }]);
  });

  it("schweigt bei einer unbekannten Befehlsform und begründet das", async () => {
    const result = await verarbeiteTextbefehlNachricht(eventFuer("!befehl unbekannt"), repositoryFuer([]));

    expect(result.actions).toEqual([]);
    expect(result.diagnostics).toEqual([{ code: "textbefehle.unbekannt" }]);
  });

  it("schweigt während der Abkühlzeit und meldet die Restzeit", async () => {
    const result = await verarbeiteTextbefehlNachricht(
      eventFuer("!hallo"),
      repositoryFuer([befehl("hallo", "Antwort", JETZT)]),
    );

    expect(result.actions).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("textbefehle.abgekuehlt");
  });

  it("verweigert Änderungen ohne Kanalmitgliedschaft", async () => {
    const result = await verarbeiteTextbefehlNachricht(
      eventFuer("!befehl hinzufuegen hallo Antwort", { userId: "fremd", login: "fremd", role: null }),
      repositoryFuer([]),
    );

    expect(result.actions).toEqual([]);
    expect(result.diagnostics).toEqual([{ code: "textbefehle.nicht_berechtigt" }]);
  });
});
