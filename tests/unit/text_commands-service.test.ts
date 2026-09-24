import { describe, expect, it, vi } from "vitest";

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
  aliases: [],
  userCooldownSeconds: 0,
  streamCondition: "any",
  responseType: "reply",
  variableAction: null,
  useCount: 0,
  lastUsedAt,
  createdAt: NOW,
  updatedAt: NOW,
  revision: 1,
});

const repositoryFor = (commands: TextCommand[]): TextCommandRepository => ({
  list: () => Promise.resolve(commands),
  find: (_channelId: string, name: string) => Promise.resolve(commands.find((entry) => entry.name === name) ?? null),
  findByAlias: (_channelId: string, alias: string) => Promise.resolve(commands.find((entry) => entry.aliases.includes(alias)) ?? null),
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
      code: "text_commands.triggered",
      detail: { name: "hallo", response: "Hallo alice in kanal-a-login" },
    }]);
  });

  it("uses the shared renderer for system and channel variables", async () => {
    const renderTemplate = vi.fn((text: string) => Promise.resolve({
      text: text.replace("{user}", "alice").replace("{var.points}", "42"),
      diagnostics: [],
    }));
    const result = await processTextCommandMessage(
      eventFor("!hallo"),
      repositoryFor([command("hallo", "Hello {user}: {var.points}")]),
      { renderTemplate },
    );

    expect(result.actions[0]).toMatchObject({ kind: "chat", text: "Hello alice: 42" });
    expect(renderTemplate).toHaveBeenCalledWith("Hello {user}: {var.points}", expect.objectContaining({
      target: "alice", command: "hallo", uses: 0,
    }), undefined);
  });

  it("runs a shoutout before its template reply and uses the usage template without a target", async () => {
    const shoutout = await processTextCommandMessage(
      eventFor("!so Streamerin"),
      repositoryFor([{ ...command("so", "Hey {user}, folgt {target}!"), kind: "shoutout" }]),
    );
    const usage = await processTextCommandMessage(
      eventFor("!so"),
      repositoryFor([{ ...command("so", "unused"), kind: "shoutout", usageText: "Nutzung: !so <name>" }]),
    );

    expect(shoutout.actions).toEqual([
      { kind: "shoutout", targetLogin: "streamerin" },
      { kind: "chat", text: "Hey alice, folgt streamerin!" },
    ]);
    expect(usage.actions).toEqual([{ kind: "chat", text: "Nutzung: !so <name>" }]);
    expect(usage.diagnostics).toContainEqual({ code: "text_commands.argument_missing", detail: { name: "so" } });
  });

  it("logs the command, arguments, and resolved response", async () => {
    const result = await processTextCommandMessage(
      eventFor("!hallo erster   zweiter"),
      repositoryFor([command("hallo", "Antwort für {user}")]),
    );

    expect(result.diagnostics).toEqual([{
      code: "text_commands.triggered",
      detail: { name: "hallo", arguments: "erster   zweiter", response: "Antwort für alice" },
    }]);
  });

  it("trims arguments after multiple spaces between name and argument", async () => {
    const result = await processTextCommandMessage(
      eventFor("!wiki   foo bar"),
      repositoryFor([command("wiki", "Antwort")]),
    );

    expect(result.diagnostics).toEqual([{
      code: "text_commands.triggered",
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
    expect(result.diagnostics).toEqual([{ code: "text_commands.unknown", detail: { name: "gibt-es-nicht" } }]);
  });

  it("stays silent for an unrecognized command shape and gives a reason", async () => {
    const result = await processTextCommandMessage(eventFor("!befehl unbekannt"), repositoryFor([]));

    expect(result.actions).toEqual([]);
    expect(result.diagnostics).toEqual([{ code: "text_commands.unknown", detail: { name: "befehl" } }]);
  });

  it("stays silent during the cooldown and reports the remaining time", async () => {
    const result = await processTextCommandMessage(
      eventFor("!hallo"),
      repositoryFor([command("hallo", "Antwort", NOW)]),
    );

    expect(result.actions).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe("text_commands.cooldown");
  });

  it("stays silent for a disabled command and gives a separate reason", async () => {
    const result = await processTextCommandMessage(
      eventFor("!hallo"),
      repositoryFor([{ ...command("hallo", "Antwort"), enabled: false }]),
    );

    expect(result.actions).toEqual([]);
    expect(result.diagnostics).toEqual([{
      code: "text_commands.disabled",
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
    expect(result.diagnostics[0]?.code).toBe("text_commands.cooldown");
  });

  it("resolves aliases after names and claims the canonical command name", async () => {
    const entry = { ...command("hallo", "Antwort"), aliases: ["hi"] };
    const repository = repositoryFor([entry]);
    const findByAlias = vi.spyOn(repository, "findByAlias");
    const claim = vi.spyOn(repository, "claim");

    const result = await processTextCommandMessage(eventFor("!HI"), repository);

    expect(findByAlias).toHaveBeenCalledWith("kanal-a", "hi");
    expect(claim).toHaveBeenCalledWith("kanal-a", "hallo", NOW, "user-1", 0, undefined, undefined, entry);
    expect(result.actions).toEqual([{ kind: "chat", text: "Antwort", replyToMessageId: "twitch-message-1" }]);
    expect(result.diagnostics).toEqual([{
      code: "text_commands.triggered",
      detail: { name: "hallo", alias: "hi", response: "Antwort" },
    }]);
  });

  it("shares the cooldown claim between the command name and its alias", async () => {
    const entry = { ...command("hallo", "Antwort"), aliases: ["hi"] };
    const repository = repositoryFor([entry]);
    const claim = vi.spyOn(repository, "claim")
      .mockResolvedValueOnce({ command: entry, claimed: true })
      .mockResolvedValueOnce({
        command: { ...entry, lastUsedAt: NOW }, claimed: false, reason: "cooldown", remainingSeconds: 5,
      });

    const byName = await processTextCommandMessage(eventFor("!hallo"), repository);
    const byAlias = await processTextCommandMessage(eventFor("!hi"), repository);

    expect(byName.actions).toHaveLength(1);
    expect(byAlias.actions).toEqual([]);
    expect(byAlias.diagnostics[0]?.code).toBe("text_commands.cooldown");
    expect(claim.mock.calls.map((call) => call[1])).toEqual(["hallo", "hallo"]);
  });

  it("skips alias and stream lookups when their command features are unused", async () => {
    const entry = command("hallo", "Antwort");
    const repository = repositoryFor([entry]);
    const find = vi.spyOn(repository, "find");
    const findByAlias = vi.spyOn(repository, "findByAlias");
    const claim = vi.spyOn(repository, "claim");
    const streamState = vi.fn(() => Promise.resolve("online" as const));
    const renderTemplate = vi.fn(() => Promise.resolve({ text: "Antwort", diagnostics: [] }));

    await processTextCommandMessage(eventFor("!hallo"), repository, { streamState, renderTemplate });

    expect(find).toHaveBeenCalledTimes(1);
    expect(findByAlias).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith("kanal-a", "hallo", NOW, "user-1", 0, undefined, undefined, entry);
    expect(streamState).not.toHaveBeenCalled();
    expect(renderTemplate).toHaveBeenCalledTimes(1);
  });

  it("checks tier before stream state and rejects an incompatible stream without claiming", async () => {
    const entry = { ...command("hallo", "Antwort"), minimumTier: "moderator" as const, streamCondition: "online" as const };
    const repository = repositoryFor([entry]);
    const claim = vi.spyOn(repository, "claim");
    const streamState = vi.fn(() => Promise.resolve("offline" as const));

    const deniedByTier = await processTextCommandMessage(eventFor("!hallo"), repository, { streamState });
    expect(deniedByTier.diagnostics[0]?.code).toBe("text_commands.permission_denied");
    expect(streamState).not.toHaveBeenCalled();
    expect(claim).not.toHaveBeenCalled();

    const streamDenied = await processTextCommandMessage(
      { ...eventFor("!hallo"), chatStatus: ["moderator"] },
      repository,
      { streamState },
    );
    expect(streamDenied.actions).toEqual([]);
    expect(streamDenied.diagnostics).toEqual([{
      code: "text_commands.stream_state",
      detail: { name: "hallo", allowed: "online", streamState: "offline" },
    }]);
    expect(claim).not.toHaveBeenCalled();
  });

  it("allows a command when stream state is unknown and records that state", async () => {
    const entry = { ...command("hallo", "Antwort"), streamCondition: "online" as const };
    const result = await processTextCommandMessage(
      eventFor("!hallo"),
      repositoryFor([entry]),
      { streamState: () => Promise.resolve("unknown") },
    );

    expect(result.actions).toEqual([{ kind: "chat", text: "Antwort", replyToMessageId: "twitch-message-1" }]);
    expect(result.diagnostics[0]?.detail).toMatchObject({ name: "hallo", streamState: "unknown" });
  });

  it.each([
    ["text", "say", { kind: "chat", text: "Antwort" }],
    ["text", "reply", { kind: "chat", text: "Antwort", replyToMessageId: "twitch-message-1" }],
    ["text", "announcement", { kind: "announcement", text: "Antwort" }],
    ["list", "say", { kind: "chat", text: "Befehle: !befehle" }],
    ["list", "reply", { kind: "chat", text: "Befehle: !befehle", replyToMessageId: "twitch-message-1" }],
    ["list", "announcement", { kind: "announcement", text: "Befehle: !befehle" }],
  ] as const)("maps %s commands with response type %s to the matching action", async (kind, responseType, expected) => {
    const entry = { ...command("befehle", kind === "list" ? "" : "Antwort"), kind, responseType, aliases: ["hi"] };
    const result = await processTextCommandMessage(eventFor("!befehle"), repositoryFor([entry]));

    expect(result.actions).toEqual([expected]);
    const action = result.actions[0];
    if (kind === "list" && (action?.kind === "chat" || action?.kind === "announcement")) {
      expect(action.text).not.toContain("hi");
    }
  });

  it("uses the first set_argument token and leaves the claim untouched for invalid input", async () => {
    const entry = {
      ...command("score", "Score updated"),
      usageText: "Usage: !score <number>",
      variableAction: { name: "score", operation: "set_argument" as const, amount: 0 },
    };
    const repository = repositoryFor([entry]);
    const claim = vi.spyOn(repository, "claim");

    const invalid = await processTextCommandMessage(eventFor("!score nope 5"), repository);
    expect(invalid.actions).toEqual([{ kind: "chat", text: "Usage: !score <number>" }]);
    expect(invalid.diagnostics).toContainEqual({ code: "text_commands.argument_invalid", detail: { name: "score" } });
    expect(claim).not.toHaveBeenCalled();

    const valid = await processTextCommandMessage(eventFor("!score 5 add a note"), repository);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim.mock.calls[0]?.[6]).toBe(5);
    expect(valid.actions).toEqual([{ kind: "chat", text: "Score updated", replyToMessageId: "twitch-message-1" }]);
  });

  it.each([
    ["permission", { minimumTier: "moderator" as const }, "text_commands.permission_denied"],
    ["cooldown", { cooldownSeconds: 60, lastUsedAt: NOW }, "text_commands.cooldown"],
  ] as const)("rechecks %s after a stale command claim", async (_scenario, change, diagnostic) => {
    const initial = command("hallo", "Original");
    const commands = [initial];
    const repository = repositoryFor(commands);
    const updated = { ...initial, ...change, text: "Updated" };
    const claim = vi.spyOn(repository, "claim").mockImplementationOnce(() => {
      commands[0] = updated;
      return Promise.resolve({ command: updated, claimed: false, stale: true });
    });

    const result = await processTextCommandMessage(eventFor("!hallo"), repository);

    expect(result.actions).toEqual([]);
    expect(result.diagnostics[0]?.code).toBe(diagnostic);
    expect(claim).toHaveBeenCalledTimes(_scenario === "permission" ? 1 : 2);
  });

});
