import { describe, expect, it, vi } from "vitest";

import type { ModuleEvent, ModuleResult } from "../../src/modules/contract";
import { formatFollowage, formatUptime } from "../../src/modules/text_commands/domain";
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
  lastUsedAt,
  createdAt: NOW,
  updatedAt: NOW,
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

  it("renders uptime and its offline template through the same declared command path", async () => {
    const online = await processTextCommandMessage(
      eventFor("!uptime"),
      repositoryFor([{ ...command("uptime", "{user}|{channel}|{uptime}"), kind: "uptime" }]),
      {
        channelInfo: () => Promise.resolve({ title: "Title", gameName: "Game", startedAt: "2026-09-19T10:00:00.000Z" }),
        channelLanguage: () => Promise.resolve("de"),
      },
    );
    const offline = await processTextCommandMessage(
      eventFor("!uptime"),
      repositoryFor([{ ...command("uptime", "Live"), kind: "uptime", offlineText: "{channel} ist offline" }]),
      { channelInfo: () => Promise.resolve({ title: "Title", gameName: "Game", startedAt: null }) },
    );

    expect(online.actions[0]).toMatchObject({ kind: "chat", text: "alice|kanal-a-login|2 Std. 0 Min." });
    expect(offline.actions[0]).toMatchObject({ kind: "chat", text: "kanal-a-login ist offline" });
    expect(formatUptime("2026-09-19T10:00:00.000Z", NOW, "en")).toBe("2 h 0 min");
  });

  it("renders followage, not-following, and unavailable templates with diagnostics", async () => {
    const following = await processTextCommandMessage(
      eventFor("!followage"),
      repositoryFor([{ ...command("followage", "{user}|{channel}|{followage}"), kind: "followage" }]),
      { followedAt: () => Promise.resolve("2025-09-19T12:00:00.000Z"), channelLanguage: () => Promise.resolve("de") },
    );
    const notFollowing = await processTextCommandMessage(
      eventFor("!followage"),
      repositoryFor([{ ...command("followage", "Default"), kind: "followage", notFollowingText: "{user} folgt {channel} noch nicht" }]),
      { followedAt: () => Promise.resolve(null) },
    );
    const unavailable = await processTextCommandMessage(
      eventFor("!followage"),
      repositoryFor([{ ...command("followage", "Default"), kind: "followage", unavailableText: "Followage fehlt" }]),
      { followedAt: () => Promise.resolve("unavailable") },
    );

    expect(following.actions[0]).toMatchObject({ kind: "chat", text: "alice|kanal-a-login|1 Jahr" });
    expect(notFollowing.actions[0]).toMatchObject({ kind: "chat", text: "alice folgt kanal-a-login noch nicht" });
    expect(unavailable.actions[0]).toMatchObject({ kind: "chat", text: "Followage fehlt" });
    expect(unavailable.diagnostics[0]?.code).toBe("text_commands.lookup_unavailable");
    expect(formatFollowage("2025-06-19T12:00:00.000Z", NOW, "de")).toBe("1 Jahr, 3 Monate");
    expect(formatFollowage("2025-06-19T12:00:00.000Z", NOW, "en")).toBe("1 year, 3 months");
  });

  it("renders current game and title, and diagnoses a Helix lookup failure", async () => {
    const commandEntry = { ...command("game", "{channel}|{game}|{title}"), kind: "game" as const };
    const result = await processTextCommandMessage(
      eventFor("!game"),
      repositoryFor([commandEntry]),
      { channelInfo: () => Promise.resolve({ title: "A stream title", gameName: "Minecraft", startedAt: null }) },
    );
    const failed = await processTextCommandMessage(
      eventFor("!game"),
      repositoryFor([commandEntry]),
      { channelInfo: () => Promise.resolve(null) },
    );

    expect(result.actions[0]).toMatchObject({ kind: "chat", text: "kanal-a-login|Minecraft|A stream title" });
    expect(failed.actions).toEqual([]);
    expect(failed.diagnostics[0]).toMatchObject({ code: "text_commands.lookup_unavailable", detail: { kind: "game" } });
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
    expect(claim).toHaveBeenCalledWith("kanal-a", "hallo", NOW, "user-1", 0);
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
    const channelInfo = vi.fn(() => Promise.resolve(null));
    const followedAt = vi.fn(() => Promise.resolve("unavailable" as const));
    const channelLanguage = vi.fn(() => Promise.resolve("de" as const));

    await processTextCommandMessage(eventFor("!hallo"), repository, { streamState, channelInfo, followedAt, channelLanguage });

    expect(find).toHaveBeenCalledTimes(1);
    expect(findByAlias).not.toHaveBeenCalled();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(claim).toHaveBeenCalledWith("kanal-a", "hallo", NOW, "user-1", 0);
    expect(streamState).not.toHaveBeenCalled();
    expect(channelInfo).not.toHaveBeenCalled();
    expect(followedAt).not.toHaveBeenCalled();
    expect(channelLanguage).not.toHaveBeenCalled();
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

});
