import { describe, expect, it } from "vitest";

import type { ChatVoteDraft } from "../../src/modules/chat_voting/contracts";
import { createChatVotingRepository } from "../../src/modules/chat_voting/repository";
import { authorizeModuleMutation } from "../../src/worker/module-authorization";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

describe("chat voting repository mutation guards", () => {
  it("creates, revision-saves, conflicts, deletes, and resolves a legacy alias", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "fictional-channel");
      await insertLoginIdentityAndSession(database, "fictional-operator");
      await insertMember(database, "fictional-channel", "fictional-operator", "operator");
      const repository = createChatVotingRepository(database as unknown as D1Database);
      const authorization = authorizeModuleMutation(
        "fictional-channel",
        { userId: "fictional-operator", sessionId: "session-fictional-operator" },
        "2026-10-04T10:00:00.000Z",
      );
      const draft = { shortcut: "essen", title: "Was essen wir?", labels: ["Pizza", "Burger"], freeTextMode: null, durationSeconds: 120 } as const;

      await expect(repository.templates.createTemplate("fictional-channel", "template-a", draft, "2026-10-04T10:00:00.000Z", authorization))
        .resolves.toBe("created");
      const created = await repository.templates.template("fictional-channel", "template-a");
      expect(created).toMatchObject({ shortcut: "essen", title: "Was essen wir?", labels: ["Pizza", "Burger"], revision: 1 });
      await expect(repository.templates.createTemplate("fictional-channel", "template-b", { ...draft, title: "Other" }, "2026-10-04T10:00:01.000Z", authorization))
        .resolves.toBe("conflict");

      const firstAcknowledgment = await repository.templates.saveTemplate("fictional-channel", "template-a", 1, { ...draft, title: "Pizza?" }, "2026-10-04T10:00:02.000Z", authorization);
      expect(firstAcknowledgment).toMatchObject({ status: "saved", template: { title: "Pizza?", revision: 2 } });
      await expect(repository.templates.saveTemplate("fictional-channel", "template-a", 1, draft, "2026-10-04T10:00:03.000Z", authorization))
        .resolves.toEqual({ status: "conflict" });
      await repository.templates.saveTemplate("fictional-channel", "template-a", 2, { ...draft, title: "Burger?" }, "2026-10-04T10:00:04.000Z", authorization);
      expect(firstAcknowledgment).toMatchObject({ template: { title: "Pizza?", revision: 2 } });
      await expect(repository.templates.template("fictional-channel", "template-a")).resolves.toMatchObject({ title: "Burger?", revision: 3 });

      await database.prepare(`UPDATE chat_vote_templates SET legacy_alias = 'yesno' WHERE id = 'template-a'`).run();
      await expect(repository.templates.templateByLegacyAlias("fictional-channel", "yesno")).resolves.toMatchObject({ id: "template-a" });
      await expect(repository.templates.deleteTemplate("fictional-channel", "template-a", 3, authorization)).resolves.toBe("saved");
      await expect(repository.templates.template("fictional-channel", "template-a")).resolves.toBeNull();
    } finally {
      database.close();
    }
  });

  it("checks the 100-template cap atomically in the insert", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "fictional-channel");
      await insertLoginIdentityAndSession(database, "fictional-operator");
      await insertMember(database, "fictional-channel", "fictional-operator", "operator");
      const repository = createChatVotingRepository(database as unknown as D1Database);
      const authorization = authorizeModuleMutation(
        "fictional-channel",
        { userId: "fictional-operator", sessionId: "session-fictional-operator" },
        "2026-10-04T10:00:00.000Z",
      );
      const draft = { shortcut: null, title: "", labels: [], freeTextMode: null, durationSeconds: 0 } as const;
      for (let index = 0; index < 100; index += 1) {
        await expect(repository.templates.createTemplate("fictional-channel", `template-${String(index)}`, draft, "2026-10-04T10:00:00.000Z", authorization))
          .resolves.toBe("created");
      }
      await expect(repository.templates.createTemplate("fictional-channel", "template-over-limit", draft, "2026-10-04T10:00:00.000Z", authorization))
        .resolves.toBe("limit");
      await expect(repository.templates.templates("fictional-channel")).resolves.toHaveLength(100);
    } finally {
      database.close();
    }
  });

  it("round-trips a vote question through open state and closed history", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "fictional-channel");
      const repository = createChatVotingRepository(database as unknown as D1Database);
      const vote: ChatVoteDraft = {
        id: "question-poll",
        channelId: "fictional-channel",
        kind: "yes_no",
        optionCount: 2,
        labels: ["Yes", "No"],
        title: "Pizza today?",
        openedAt: "2026-10-04T10:00:00.000Z",
        closesAt: "2026-10-04T14:00:00.000Z",
        requestedDurationSeconds: null,
        closeReason: "limit",
      };

      await repository.insertOpen(vote);
      await expect(repository.open("fictional-channel")).resolves.toMatchObject({ title: "Pizza today?", status: "open" });
      await repository.finish("fictional-channel", vote.id, "manual", "2026-10-04T11:00:00.000Z", [3, 1]);

      await expect(repository.latest("fictional-channel")).resolves.toMatchObject({
        title: "Pizza today?",
        status: "closed",
        counts: [3, 1],
      });
    } finally {
      database.close();
    }
  });

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
        kind: "yes_no",
        optionCount: 2,
        labels: ["Yes", "No"],
        title: null,
        openedAt: "2026-10-04T10:00:00.000Z",
        closesAt: "2026-10-04T14:00:00.000Z",
        requestedDurationSeconds: null,
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

      await expect(repository.requestManualClose("fictional-channel", vote.id, authorization)).resolves.toBe(false);
      await expect(repository.open("fictional-channel")).resolves.toMatchObject({ id: vote.id, status: "open" });
    } finally {
      database.close();
    }
  });

  it("accepts repeated manual-close requests for an open vote", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "fictional-channel");
      const repository = createChatVotingRepository(database as unknown as D1Database);
      const vote: ChatVoteDraft = {
        id: "fictional-poll",
        channelId: "fictional-channel",
        kind: "yes_no",
        optionCount: 2,
        labels: ["Yes", "No"],
        title: null,
        openedAt: "2026-10-04T10:00:00.000Z",
        closesAt: "2026-10-04T14:00:00.000Z",
        requestedDurationSeconds: 120,
        closeReason: "limit",
      };
      await repository.insertOpen(vote);
      await expect(repository.requestManualClose("fictional-channel", vote.id)).resolves.toBe(true);
      await expect(repository.open("fictional-channel")).resolves.toMatchObject({
        id: vote.id,
        status: "open",
        closeReason: "manual",
      });

      await expect(repository.requestManualClose("fictional-channel", vote.id)).resolves.toBe(true);

      await expect(repository.open("fictional-channel")).resolves.toMatchObject({
        status: "open",
        closeReason: "manual",
        requestedDurationSeconds: 120,
      });
    } finally {
      database.close();
    }
  });
});
