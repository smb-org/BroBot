import { describe, expect, it } from "vitest";

import type { ModuleEvent, ModuleExecutionContext } from "../../src/modules/contract";
import { clipsModule } from "../../src/modules/clips";
import { clipsSettingsSchema, type ClipsSettings } from "../../src/modules/clips/contracts";

const NOW = "2026-10-19T10:00:00.000Z";
const context = {} as ModuleExecutionContext;

const eventFor = (
  settings: ClipsSettings,
  chatStatus: ModuleEvent<ClipsSettings>["chatStatus"],
  text = "!clip",
): ModuleEvent<ClipsSettings> => ({
  channelId: "channel-a",
  subscriptionType: "channel.chat.message",
  triggerId: "message-1",
  payload: { message: { text }, chatter_user_id: "viewer-1" },
  settings,
  receivedAt: NOW,
  actor: { userId: "viewer-1", login: "viewer", role: null },
  chatStatus,
});

describe("clips chat command", () => {
  it("creates a clip action carrying its cooldown for an allowed role", async () => {
    const settings = clipsSettingsSchema.parse({
      commandMinimumRole: "vip",
      commandCooldownSeconds: 120,
      postClipLinkInChat: true,
      chatLinkTemplate: "New clip: {clip.title} {clip.url}",
    });
    const handler = clipsModule.handleEvent;

    const result = await handler?.(eventFor(settings, ["vip"]), context);

    expect(clipsModule.chatCommands?.map(({ name, minimumChatStatus }) => ({ name, minimumChatStatus })))
      .toContainEqual({ name: "!clip", minimumChatStatus: "configurable" });
    expect(result?.actions).toMatchObject([{
      kind: "clip",
      cooldownSeconds: 120,
      chatLinkTemplate: "New clip: {clip.title} {clip.url}",
    }]);
  });

  it("does not claim the cooldown or create a clip for a role below the configured minimum", async () => {
    const settings = clipsSettingsSchema.parse({ commandMinimumRole: "moderator" });
    const handler = clipsModule.handleEvent;

    const result = await handler?.(eventFor(settings, ["vip"]), context);

    expect(result?.actions).toEqual([]);
  });

  it("carries the default cooldown for the channel enqueue operation", async () => {
    const settings = clipsSettingsSchema.parse({ commandCooldownSeconds: 60 });
    const handler = clipsModule.handleEvent;

    const result = await handler?.(eventFor(settings, ["viewer"]), context);

    expect(result?.actions).toMatchObject([{ kind: "clip", cooldownSeconds: 60 }]);
  });
});
