import { describe, expect, it } from "vitest";

import type { ChatVoteDraft } from "../../src/modules/chat_voting/contracts";
import { createChatVotingRepository } from "../../src/modules/chat_voting/repository";
import { authorizeModuleMutation } from "../../src/worker/module-authorization";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

describe("chat voting repository mutation guards", () => {
  it("rechecks channel membership when a manual close is written", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "fictional-channel");
      await insertLoginIdentityAndSession(database, "fictional-operator");
      await insertMember(database, "fictional-channel", "fictional-operator", "operator");
      const repository = createChatVotingRepository(database as unknown as D1Database);
      const vote: ChatVoteDraft = {
        id: "fictional-poll",
        channelId: "fictional-channel",
        preset: "yes_no",
        optionCount: 2,
        labels: ["Yes", "No"],
        openedAt: "2026-10-04T10:00:00.000Z",
        closesAt: "2026-10-04T14:00:00.000Z",
        closeReason: "limit",
      };
      await repository.insertOpen(vote);
      const authorization = authorizeModuleMutation(
        "fictional-channel",
        { userId: "fictional-operator", sessionId: "session-fictional-operator" },
        "2026-10-04T10:00:00.000Z",
      );

      await database.prepare(
        "DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?",
      ).bind("fictional-channel", "fictional-operator").run();

      await expect(repository.requestManualClose("fictional-channel", vote.id, "owner-token", authorization)).resolves.toBe(false);
      await expect(repository.open("fictional-channel")).resolves.toMatchObject({ id: vote.id, status: "open" });
    } finally {
      database.close();
    }
  });

  it("only lets the manual-close owner restore the prior reason", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "fictional-channel");
      const repository = createChatVotingRepository(database as unknown as D1Database);
      const vote: ChatVoteDraft = {
        id: "fictional-poll",
        channelId: "fictional-channel",
        preset: "yes_no",
        optionCount: 2,
        labels: ["Yes", "No"],
        openedAt: "2026-10-04T10:00:00.000Z",
        closesAt: "2026-10-04T14:00:00.000Z",
        closeReason: "limit",
      };
      await repository.insertOpen(vote);
      await repository.requestManualClose("fictional-channel", vote.id, "owner-token");

      await repository.restoreCloseReason("fictional-channel", vote.id, "other-owner");
      await expect(repository.open("fictional-channel")).resolves.toMatchObject({
        id: vote.id,
        status: "open",
        closeReason: "manual",
      });

      await repository.restoreCloseReason("fictional-channel", vote.id, "owner-token");

      await expect(repository.open("fictional-channel")).resolves.toMatchObject({
        id: vote.id,
        status: "open",
        closeReason: "limit",
      });
    } finally {
      database.close();
    }
  });
});
