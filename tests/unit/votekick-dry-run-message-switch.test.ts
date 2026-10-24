import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleDryRunContext, ModuleEvent } from "../../src/modules/contract";
import { votekickModule } from "../../src/modules/votekick";
import { votekickSettingsSchema, type VotekickSettings } from "../../src/modules/votekick/contracts";
import { dryRunVotekickMessage } from "../../src/modules/votekick/dry-run";
import { readOnlyD1 } from "../../src/worker/db/read-only";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

describe("votekick message-switch dry run", () => {
  let database: TestD1Database | undefined;

  afterEach(() => {
    database?.close();
    database = undefined;
  });

  it("keeps the saved start text but omits its chat effect when disabled", async () => {
    database = new TestD1Database();
    const channelId = "dry-run-message-switch-channel";
    await insertChannel(database, channelId);
    const settings = votekickSettingsSchema.parse({
      ...votekickModule.defaultSettings,
      startText: "Saved start announcement",
      startTextEnabled: false,
    });
    const event: ModuleEvent<VotekickSettings> = {
      channelId,
      subscriptionType: "channel.chat.message",
      triggerId: "dry-run-message-switch",
      payload: {
        message: { text: "!votekick sampleviewer" },
        chatter_user_id: "starter-user",
      },
      settings,
      receivedAt: new Date().toISOString(),
      eventSubTimestamp: new Date().toISOString(),
      actor: null,
      chatStatus: ["vip"],
    };
    const context = {
      DB: readOnlyD1(database as unknown as D1Database),
      defaultChatTarget: "source_only",
      ballots: {
        hasOpenBallotSnapshot: vi.fn(() => Promise.resolve(false)),
        readSnapshot: vi.fn(() => Promise.resolve(null)),
      },
      botUserId: vi.fn(() => Promise.resolve("bot-user")),
      channelLanguage: vi.fn(() => Promise.resolve("en" as const)),
      lookupUserByLogin: vi.fn((login: string) => Promise.resolve({ userId: "target-user", login, displayName: login })),
      isChannelModerator: vi.fn(() => Promise.resolve(false)),
      activeChatters: {
        count: vi.fn(() => Promise.resolve(20)),
        seen: vi.fn(() => Promise.resolve({ firstSeenAt: new Date(Date.now() - 30_000).toISOString(), lastSeenAt: new Date().toISOString() })),
      },
      streamState: vi.fn(() => Promise.resolve("offline" as const)),
      secureRandomInteger: vi.fn(() => 0),
      renderTemplate: vi.fn((text: string) => Promise.resolve({ text, diagnostics: [] })),
    } as unknown as ModuleDryRunContext;

    const report = await dryRunVotekickMessage(event, context);

    expect(report).toHaveLength(1);
    expect(report[0]?.effects).toEqual([expect.objectContaining({ kind: "ballot", action: "start", label: "sampleviewer" })]);
    expect(report[0]?.effects.some((effect) => effect.kind === "chat")).toBe(false);
    expect(event.settings.startText).toBe("Saved start announcement");
  });
});
