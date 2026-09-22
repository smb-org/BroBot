import { describe, expect, it } from "vitest";

import type { ModuleEvent, ModuleResult } from "../../src/modules/contract";
import { processTextCommandMessage } from "../../src/modules/text_commands/service";
import type { TextCommand, TextCommandRepository } from "../../src/modules/text_commands";

const NOW = "2026-09-19T12:00:00.000Z";

const command = (name: string, text: string, lastUsedAt: string | null = null): TextCommand => ({
  channelId: "kanal-a",
  name,
  text,
  kind: "text",
  enabled: true,
  minimumTier: "everyone",
  cooldownSeconds: 5,
  lastUsedAt,
  createdAt: NOW,
  updatedAt: NOW,
});

const repositoryFor = (commands: TextCommand[]): TextCommandRepository => ({
  list: () => Promise.resolve(commands),
  find: (_channelId: string, name: string) => Promise.resolve(commands.find((entry) => entry.name === name) ?? null),
  create: () => Promise.resolve({ ok: true }),
  change: () => Promise.resolve({ ok: true }),
  delete: () => Promise.resolve({ ok: true }),
  claim: (_channelId: string, name: string) => {
    const entry = commands.find((candidate) => candidate.name === name);
    return Promise.resolve(entry === undefined ? null : { command: entry, claimed: entry.lastUsedAt === null });
  },
});

const eventFor = (text: string, actor: ModuleEvent["actor"] = {
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
  receivedAt: NOW,
  actor,
  chatStatus: ["viewer"],
});

describe("Text commands service", () => {
  it("replaces user and channel in the stored response text", async () => {
    const result: ModuleResult = await processTextCommandMessage(
      eventFor("!hallo"),
      repositoryFor([command("hallo", "Hallo {user} in {channel}")]),
    );

    expect(result.actions).toEqual([{
      kind: "chat",
      text: "Hallo alice in kanal-a-login",
      replyToMessageId: "twitch-message-1",
    }]);
    expect(result.diagnostics).toEqual([{
      code: "text_commands.ausgeloest",
      detail: { name: "hallo", response: "Hallo alice in kanal-a-login" },
    }]);
  });

  it("logs the command, arguments, and resolved response", async () => {
    const result = await processTextCommandMessage(
      eventFor("!hallo erster   zweiter"),
      repositoryFor([command("hallo", "Antwort für {user}")]),
    );

    expect(result.diagnostics).toEqual([{
      code: "text_commands.ausgeloest",
      detail: { name: "hallo", arguments: "erster   zweiter", response: "Antwort für alice" },
    }]);
  });

  it("trims arguments after multiple spaces between name and argument", async () => {
    const result = await processTextCommandMessage(
      eventFor("!wiki   foo bar"),
      repositoryFor([command("wiki", "Antwort")]),
    );

    expect(result.diagnostics).toEqual([{
      code: "text_commands.ausgeloest",
      detail: { name: "wiki", arguments: "foo bar", response: "Antwort" },
    }]);
  });

  it("visibly truncates arguments and response, but leaves exactly 200 characters unchanged", async () => {
    const exactlyTwoHundred = "x".repeat(200);
    const tooLong = "y".repeat(201);
    const exact = await processTextCommandMessage(
      eventFor(`!hallo ${exactlyTwoHundred}`),
      repositoryFor([command("hallo", exactlyTwoHundred)]),
    );
    const truncated = await processTextCommandMessage(
      eventFor(`!hallo ${tooLong}`),
      repositoryFor([command("hallo", tooLong)]),
    );

    expect(exact.diagnostics[0]?.detail).toEqual({
      name: "hallo", arguments: exactlyTwoHundred, response: exactlyTwoHundred,
    });
    expect(truncated.diagnostics[0]?.detail).toEqual({
      name: "hallo", arguments: `${"y".repeat(199)}…`, response: `${"y".repeat(199)}…`,
    });
  });

  it("stays silent for an unknown command and gives a reason", async () => {
    const result = await processTextCommandMessage(eventFor("!gibt-es-nicht"), repositoryFor([]));

    expect(result.actions).toEqual([]);
    expect(result.diagnostics).toEqual([{ code: "text_commands.unbekannt", detail: { name: "gibt-es-nicht" } }]);
  });

  it("stays silent for an unrecognized command shape and gives a reason", async () => {
    const result = await processTextCommandMessage(eventFor("!befehl unbekannt"), repositoryFor([]));

    expect(result.actions).toEqual([]);
    expect(result.diagnostics).toEqual([{ code: "text_commands.unbekannt", detail: { name: "befehl" } }]);
  });

  it("stays silent during the cooldown and reports the remaining time", async () => {
    const result = await processTextCommandMessage(
      eventFor("!hallo"),
      repositoryFor([command("hallo", "Antwort", NOW)]),
    );

    expect(result.actions).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("text_commands.abgekuehlt");
  });

  it("stays silent for a disabled command and gives a separate reason", async () => {
    const result = await processTextCommandMessage(
      eventFor("!hallo"),
      repositoryFor([{ ...command("hallo", "Antwort"), enabled: false }]),
    );

    expect(result.actions).toEqual([]);
    expect(result.diagnostics).toEqual([{
      code: "text_commands.deaktiviert",
      detail: { name: "hallo" },
    }]);
  });

  it("lists only enabled commands and counts its own list row too", async () => {
    const result = await processTextCommandMessage(
      eventFor("!befehle"),
      repositoryFor([
        { ...command("befehle", ""), kind: "list" },
        { ...command("aktiv", "Antwort") },
        { ...command("aus", "Antwort"), enabled: false },
      ]),
    );

    expect(result.actions).toEqual([{
      kind: "chat",
      text: "Befehle: !aktiv, !befehle",
      replyToMessageId: "twitch-message-1",
    }]);
  });

  it("applies the cooldown to list rows too", async () => {
    const result = await processTextCommandMessage(
      eventFor("!befehle"),
      repositoryFor([{ ...command("befehle", "", NOW), kind: "list" }]),
    );

    expect(result.actions).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("text_commands.abgekuehlt");
  });

});
