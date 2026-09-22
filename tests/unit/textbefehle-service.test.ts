import { describe, expect, it } from "vitest";

import type { ModuleEvent, ModuleResult } from "../../src/modules/contract";
import { verarbeiteTextbefehlNachricht } from "../../src/modules/textbefehle/service";
import type { Textbefehl, TextbefehlRepository } from "../../src/modules/textbefehle";

const JETZT = "2026-09-19T12:00:00.000Z";

const befehl = (name: string, text: string, zuletztVerwendetAt: string | null = null): Textbefehl => ({
  channelId: "kanal-a",
  name,
  text,
  art: "text",
  enabled: true,
  mindeststufe: "everyone",
  cooldownSekunden: 5,
  zuletztVerwendetAt,
  createdAt: JETZT,
  updatedAt: JETZT,
});

const repositoryFuer = (befehle: Textbefehl[]): TextbefehlRepository => ({
  auflisten: () => Promise.resolve(befehle),
  finden: (_channelId, name) => Promise.resolve(befehle.find((eintrag) => eintrag.name === name) ?? null),
  anlegen: () => Promise.resolve({ ok: true }),
  aendern: () => Promise.resolve({ ok: true }),
  loeschen: () => Promise.resolve({ ok: true }),
  beanspruchen: (_channelId, name) => {
    const eintrag = befehle.find((candidate) => candidate.name === name);
    return Promise.resolve(eintrag === undefined ? null : { befehl: eintrag, beansprucht: eintrag.zuletztVerwendetAt === null });
  },
});

const eventFuer = (text: string, actor: ModuleEvent["actor"] = {
  userId: "user-1", login: "alice", role: "operator",
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
  chatStatus: ["viewer"],
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
    expect(result.diagnostics).toEqual([{
      code: "text_commands.ausgeloest",
      detail: { name: "hallo", antwort: "Hallo alice in kanal-a-login" },
    }]);
  });

  it("protokolliert Befehl, Argumente und aufgelöste Antwort", async () => {
    const result = await verarbeiteTextbefehlNachricht(
      eventFuer("!hallo erster   zweiter"),
      repositoryFuer([befehl("hallo", "Antwort für {user}")]),
    );

    expect(result.diagnostics).toEqual([{
      code: "text_commands.ausgeloest",
      detail: { name: "hallo", argumente: "erster   zweiter", antwort: "Antwort für alice" },
    }]);
  });

  it("trimmt Argumente nach mehreren Leerzeichen zwischen Name und Argument", async () => {
    const result = await verarbeiteTextbefehlNachricht(
      eventFuer("!wiki   foo bar"),
      repositoryFuer([befehl("wiki", "Antwort")]),
    );

    expect(result.diagnostics).toEqual([{
      code: "text_commands.ausgeloest",
      detail: { name: "wiki", argumente: "foo bar", antwort: "Antwort" },
    }]);
  });

  it("kürzt Argumente und Antwort sichtbar, lässt genau 200 Zeichen aber unverändert", async () => {
    const exaktZweihundert = "x".repeat(200);
    const zuLang = "y".repeat(201);
    const exakt = await verarbeiteTextbefehlNachricht(
      eventFuer(`!hallo ${exaktZweihundert}`),
      repositoryFuer([befehl("hallo", exaktZweihundert)]),
    );
    const gekuerzt = await verarbeiteTextbefehlNachricht(
      eventFuer(`!hallo ${zuLang}`),
      repositoryFuer([befehl("hallo", zuLang)]),
    );

    expect(exakt.diagnostics[0]?.detail).toEqual({
      name: "hallo", argumente: exaktZweihundert, antwort: exaktZweihundert,
    });
    expect(gekuerzt.diagnostics[0]?.detail).toEqual({
      name: "hallo", argumente: `${"y".repeat(199)}…`, antwort: `${"y".repeat(199)}…`,
    });
  });

  it("schweigt bei einem unbekannten Befehl und begründet das", async () => {
    const result = await verarbeiteTextbefehlNachricht(eventFuer("!gibt-es-nicht"), repositoryFuer([]));

    expect(result.actions).toEqual([]);
    expect(result.diagnostics).toEqual([{ code: "text_commands.unbekannt", detail: { name: "gibt-es-nicht" } }]);
  });

  it("schweigt bei einer unbekannten Befehlsform und begründet das", async () => {
    const result = await verarbeiteTextbefehlNachricht(eventFuer("!befehl unbekannt"), repositoryFuer([]));

    expect(result.actions).toEqual([]);
    expect(result.diagnostics).toEqual([{ code: "text_commands.unbekannt", detail: { name: "befehl" } }]);
  });

  it("schweigt während der Abkühlzeit und meldet die Restzeit", async () => {
    const result = await verarbeiteTextbefehlNachricht(
      eventFuer("!hallo"),
      repositoryFuer([befehl("hallo", "Antwort", JETZT)]),
    );

    expect(result.actions).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("text_commands.abgekuehlt");
  });

  it("schweigt bei einem ausgeschalteten Befehl und begründet das separat", async () => {
    const result = await verarbeiteTextbefehlNachricht(
      eventFuer("!hallo"),
      repositoryFuer([{ ...befehl("hallo", "Antwort"), enabled: false }]),
    );

    expect(result.actions).toEqual([]);
    expect(result.diagnostics).toEqual([{
      code: "text_commands.deaktiviert",
      detail: { name: "hallo" },
    }]);
  });

  it("listet nur eingeschaltete Befehle und zählt die eigene Listenzeile mit auf", async () => {
    const result = await verarbeiteTextbefehlNachricht(
      eventFuer("!befehle"),
      repositoryFuer([
        { ...befehl("befehle", ""), art: "list" },
        { ...befehl("aktiv", "Antwort") },
        { ...befehl("aus", "Antwort"), enabled: false },
      ]),
    );

    expect(result.actions).toEqual([{
      kind: "chat",
      text: "Befehle: !aktiv, !befehle",
      replyToMessageId: "twitch-message-1",
    }]);
  });

  it("wendet die Abkühlzeit auch auf Listenzeilen an", async () => {
    const result = await verarbeiteTextbefehlNachricht(
      eventFuer("!befehle"),
      repositoryFuer([{ ...befehl("befehle", "", JETZT), art: "list" }]),
    );

    expect(result.actions).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("text_commands.abgekuehlt");
  });

});
