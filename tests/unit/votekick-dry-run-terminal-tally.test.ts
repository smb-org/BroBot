import { describe, expect, it, vi } from "vitest";
import type * as VotekickService from "../../src/modules/votekick/service";

vi.mock("../../src/modules/votekick/service", async (importOriginal) => {
  const actual = await importOriginal<typeof VotekickService>();
  return { ...actual, processVotekickMessage: vi.fn() };
});

import type { ModuleDryRunContext, ModuleEvent } from "../../src/modules/contract";
import { votekickModule } from "../../src/modules/votekick";
import { votekickSettingsSchema, type VotekickSettings } from "../../src/modules/votekick/contracts";
import { createVotekickRepository } from "../../src/modules/votekick/adapters/d1";
import { dryRunVotekickMessage } from "../../src/modules/votekick/dry-run";
import { processVotekickMessage } from "../../src/modules/votekick/service";
import { readOnlyD1 } from "../../src/worker/db/read-only";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

describe("votekick dry-run terminal tallies", () => {
  it("reports a cancelled tally from the fixed terminal result without becoming silent", async () => {
    const database = new TestD1Database();
    try {
      const channelId = "terminal-votekick-channel";
      await insertChannel(database, channelId);
      const repository = createVotekickRepository(database as unknown as D1Database);
      const startedAt = "2026-10-19T11:58:00.000Z";
      await repository.admit(channelId, {
        id: "cancelled-votekick",
        targetUserId: "target-user",
        targetLogin: "protected_viewer",
        initiatorUserId: "fictional-starter",
        threshold: 3,
        yesVotes: 3,
        ballotRevision: 3,
        startedAt,
        endsAt: "2026-10-19T12:03:00.000Z",
      }, "2026-10-19T11:58:00.000Z", 0, 0);
      await repository.cancel(channelId, "cancelled-votekick", "2026-10-19T11:59:00.000Z");
      const settings = votekickSettingsSchema.parse(votekickModule.defaultSettings);
      const event: ModuleEvent<VotekickSettings> = {
        channelId,
        subscriptionType: "channel.chat.message",
        triggerId: "terminal-votekick-tally",
        payload: { message: { text: "ordinary chat" }, chatter_user_id: "fictional-viewer" },
        settings,
        receivedAt: "2026-10-19T12:00:00.000Z",
        eventSubTimestamp: "2026-10-19T12:00:00.000Z",
        actor: null,
        chatStatus: ["viewer"],
      };
      vi.mocked(processVotekickMessage).mockResolvedValue({
        actions: [{
          kind: "overlay",
          type: "tally",
          elementKind: "votekick.tally",
          payload: {
            votekickId: "cancelled-votekick",
            targetLogin: "protected_viewer",
            yesVotes: 3,
            noVotes: 0,
            status: "cancelled",
          },
        }],
        diagnostics: [],
      });
      const context = {
        DB: readOnlyD1(database as unknown as D1Database),
        defaultChatTarget: "everyone",
        ballots: {
          hasOpenBallotSnapshot: () => Promise.resolve(false),
          readSnapshot: () => Promise.resolve(null),
        },
        botUserId: () => Promise.resolve("bot-user"),
        channelLanguage: () => Promise.resolve("en"),
      } as unknown as ModuleDryRunContext;

      const report = await dryRunVotekickMessage(event, context);

      expect(report).toHaveLength(1);
      expect(report[0]?.effects).toContainEqual({
        kind: "ballot",
        moduleId: "votekick",
        action: "finalize",
        label: "protected_viewer",
        counts: [3, 0],
      });
    } finally {
      database.close();
    }
  });
});
