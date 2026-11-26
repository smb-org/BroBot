import { describe, expect, it } from "vitest";

import type { ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import { discordModule, processDiscordMessage } from "../../src/modules/discord";
import { MODULES } from "../../src/modules/registry";
import { selectModulesForEvent } from "../../src/worker/dispatch";

const eventFor = (text: string, subscriptionType = "channel.chat.message"): ModuleEvent => ({
  channelId: "fictional_channel",
  subscriptionType,
  triggerId: "fictional-message",
  payload: { message: { text } },
  settings: {},
  receivedAt: "2026-11-24T10:00:00.000Z",
  actor: null,
  chatStatus: [],
});

const context = {
  environment: { PUBLIC_ORIGIN: "https://brobot.example" },
} as unknown as ModuleExecutionContext;

describe("Discord module", () => {
  it("registers with the Twitch ranks resource and answers !discord with the absolute global page URL", () => {
    expect(MODULES.find(({ id }) => id === "discord")).toBe(discordModule);
    expect(discordModule.consumes).toEqual(["twitch_ranks"]);

    const result = processDiscordMessage(eventFor("!discord"), context);

    expect(result.actions).toEqual([{ kind: "chat", text: "https://brobot.example/discord/link", automated: false }]);
  });

  it("does not answer unrelated messages", () => {
    expect(processDiscordMessage(eventFor("hello"), context)).toMatchObject({ actions: [] });
    expect(processDiscordMessage(eventFor("!discord", "channel.raid"), context)).toMatchObject({ actions: [] });
  });

  it("activates the command for a channel only while that channel enables the module", () => {
    const registry = [discordModule];
    expect(selectModulesForEvent([
      { moduleId: "discord", enabled: false, settings: "{}" },
    ], "channel.chat.message", registry).matches).toEqual([]);
    expect(selectModulesForEvent([
      { moduleId: "discord", enabled: true, settings: "{}" },
    ], "channel.chat.message", registry).matches.map(({ module }) => module.id)).toEqual(["discord"]);
  });
});
