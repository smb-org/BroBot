import { describe, expect, it, vi } from "vitest";

import type { ModuleDryRunContext, ModuleEvent } from "../../src/modules/contract";
import { clipsModule } from "../../src/modules/clips";
import { clipsSettingsSchema, type ClipsSettings } from "../../src/modules/clips/contracts";

const eventFor = (
  overrides: Partial<ModuleEvent<ClipsSettings>> = {},
): ModuleEvent<ClipsSettings> => ({
  channelId: "clip-dry-run-channel",
  subscriptionType: "channel.chat.message",
  triggerId: "dry-run-trigger",
  payload: { message: { text: "!clip" }, chatter_user_id: "dry-run:viewer" },
  settings: clipsSettingsSchema.parse({}),
  receivedAt: "2026-10-19T10:00:00.000Z",
  actor: null,
  chatStatus: ["viewer"],
  ...overrides,
});

const contextFor = (remainingSeconds: number) => ({
  pointCooldownRemaining: vi.fn().mockResolvedValue(remainingSeconds),
}) as unknown as ModuleDryRunContext;

const dryRun = async (event: ModuleEvent<ClipsSettings>, context: ModuleDryRunContext) => {
  const handler = clipsModule.dryRunChatMessage;
  expect(handler).toBeTypeOf("function");
  return await handler?.(event, context) ?? [];
};

describe("clips dry-run", () => {
  it("reports an allowed !clip without claiming cooldown or creating a clip", async () => {
    const context = contextFor(0);

    const result = await dryRun(eventFor(), context);

    expect(result).toMatchObject([{
      moduleId: "clips",
      entry: { kind: "clip", id: "clip", label: "!clip" },
      outcome: "fires",
      effects: [{ kind: "clip" }],
      blocks: [],
    }]);
    expect(context.pointCooldownRemaining).toHaveBeenCalledWith("clips", "clip");
  });

  it("does not query an old cooldown after the command cooldown is set to zero", async () => {
    const context = contextFor(27);
    const event = eventFor({ settings: clipsSettingsSchema.parse({ commandCooldownSeconds: 0 }) });

    const result = await dryRun(event, context);

    expect(result[0]).toMatchObject({ outcome: "fires", effects: [{ kind: "clip" }], blocks: [] });
    expect(context.pointCooldownRemaining).not.toHaveBeenCalled();
  });

  it("explains when the sender's role is too low", async () => {
    const result = await dryRun(eventFor({
      settings: clipsSettingsSchema.parse({ commandMinimumRole: "moderator" }),
      chatStatus: ["vip"],
    }), contextFor(0));

    expect(result[0]).toMatchObject({ outcome: "blocked", effects: [], blocks: [{ code: "clips.permission_denied" }] });
  });

  it("explains an active cooldown without claiming it", async () => {
    const context = contextFor(27);

    const result = await dryRun(eventFor(), context);

    expect(result[0]).toMatchObject({
      outcome: "blocked",
      effects: [],
      blocks: [{ code: "clips.cooldown", detail: { remainingSeconds: 27 } }],
    });
    expect(context.pointCooldownRemaining).toHaveBeenCalledTimes(1);
  });
});
