import { describe, expect, it } from "vitest";

import type { ChatVoteDraft } from "../../src/modules/chat_voting/contracts";
import { DEFAULT_CHAT_VOTING_SETTINGS } from "../../src/modules/chat_voting/contracts";
import { createChatVotingRepository } from "../../src/modules/chat_voting/repository";
import { processChatVotingMessage } from "../../src/modules/chat_voting/service";
import type { ModuleExecutionContext } from "../../src/modules/contract";
import { authorizeModuleMutation } from "../../src/worker/module-authorization";
import { prepareModuleAudit } from "../../src/worker/module-audit";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

const setChatVotingEnabled = async (database: TestD1Database, enabled: boolean): Promise<void> => {
  await database.prepare(
    `INSERT INTO channel_modules (channel_id, module_id, enabled, settings)
     VALUES ('fictional-channel', 'chat_voting', ?, '{}')
     ON CONFLICT (channel_id, module_id) DO UPDATE SET enabled = excluded.enabled`,
  ).bind(Number(enabled)).run();
};

const processVoteCommand = async (
  command: string,
  database: TestD1Database,
  repository: ReturnType<typeof createChatVotingRepository>,
) => processChatVotingMessage({
  channelId: "fictional-channel",
  subscriptionType: "channel.chat.message",
  triggerId: "fictional-trigger",
  payload: { message: { text: command }, chatter_user_id: "fictional-operator" },
  settings: DEFAULT_CHAT_VOTING_SETTINGS,
  receivedAt: "2026-10-04T10:00:00.000Z",
  actor: null,
  chatStatus: ["moderator"],
}, repository, {
  DB: database,
  ballots: { open: () => Promise.resolve({ status: "opened" as const }) },
  channelLanguage: () => Promise.resolve("en" as const),
  scheduleAlarm: () => Promise.resolve(),
} as unknown as ModuleExecutionContext);

describe("chat voting repository mutation guards", () => {
  it("starts a template whose old-worker insert defaults to empty colors and whose labels changed after migration", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "fictional-channel");
      await setChatVotingEnabled(database, true);
      await database.prepare(
        `INSERT INTO chat_vote_templates
           (id, channel_id, shortcut, title, result_text, labels, offer_in_cockpit, free_text_mode, duration_seconds, revision,
            legacy_alias, last_used_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, NULL, 120, 1, NULL, NULL, ?, ?)`,
      ).bind(
        "legacy-template-default-colors", "fictional-channel", "dinner", "Dinner", "{vote.result}", JSON.stringify(["Pizza", "Burger"]),
        "2026-10-04T10:00:00.000Z", "2026-10-04T10:00:00.000Z",
      ).run();
      await database.prepare("UPDATE chat_vote_templates SET labels = ? WHERE id = ?")
        .bind(JSON.stringify(["Pizza", "Burger", "Kebab"]), "legacy-template-default-colors").run();
      const repository = createChatVotingRepository(database as unknown as D1Database);

      await expect(repository.templates.templateByShortcut("fictional-channel", "dinner"))
        .resolves.toMatchObject({ labels: ["Pizza", "Burger", "Kebab"], answerColors: ["#5b8cff", "#ff9f43", "#2ed3a3"] });

      const result = await processVoteCommand("!vote dinner", database, repository);
      expect(result.actions[0]).toMatchObject({ kind: "overlay", type: "opened" });
      await expect(repository.open("fictional-channel"))
        .resolves.toMatchObject({ labels: ["Pizza", "Burger", "Kebab"], answerColors: ["#5b8cff", "#ff9f43", "#2ed3a3"] });
      const written = await database.prepare("SELECT answer_colors_json FROM chat_votes WHERE channel_id = ?")
        .bind("fictional-channel").first<{ answer_colors_json: string }>();
      expect(written?.answer_colors_json).toBe('["#5b8cff","#ff9f43","#2ed3a3"]');
    } finally {
      database.close();
    }
  });

  it("replays a post-migration fixed-answer vote with default empty colors through !vote again", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "fictional-channel");
      await setChatVotingEnabled(database, true);
      await database.prepare(
        `INSERT INTO chat_votes
           (channel_id, poll_id, kind, option_count, labels_json, status, opened_at, closes_at, closed_at, close_reason, counts_json, voter_count)
         VALUES (?, ?, 'options', 3, ?, 'closed', ?, ?, ?, 'manual', '[2, 1, 0]', 3)`,
      ).bind(
        "fictional-channel", "legacy-closed-vote", JSON.stringify(["Pizza", "Burger", "Kebab"]),
        "2026-10-04T09:00:00.000Z", "2026-10-04T10:00:00.000Z", "2026-10-04T10:00:00.000Z",
      ).run();
      const repository = createChatVotingRepository(database as unknown as D1Database);

      const result = await processVoteCommand("!vote again", database, repository);

      expect(result.actions[0]).toMatchObject({ kind: "overlay", type: "opened" });
      await expect(repository.open("fictional-channel"))
        .resolves.toMatchObject({ labels: ["Pizza", "Burger", "Kebab"], answerColors: ["#5b8cff", "#ff9f43", "#2ed3a3"] });
    } finally {
      database.close();
    }
  });

  it("preserves valid template colors, replaces invalid entries with unused defaults, and drops extras", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "fictional-channel");
      await database.prepare(
        `INSERT INTO chat_vote_templates
           (id, channel_id, shortcut, title, result_text, labels, answer_colors, offer_in_cockpit, free_text_mode, duration_seconds,
            revision, legacy_alias, last_used_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, 120, 1, NULL, NULL, ?, ?)`,
      ).bind(
        "legacy-template-mismatched-colors", "fictional-channel", "colors", "Colors", "{vote.result}",
        JSON.stringify(["Burger", "Kebab", "Tacos"]), JSON.stringify(["#ff9f43", "#2ed3a3", "#000000", "#ff6fae"]),
        "2026-10-04T10:00:00.000Z", "2026-10-04T10:00:00.000Z",
      ).run();
      const repository = createChatVotingRepository(database as unknown as D1Database);

      await expect(repository.templates.template("fictional-channel", "legacy-template-mismatched-colors"))
        .resolves.toMatchObject({ answerColors: ["#ff9f43", "#2ed3a3", "#5b8cff"] });
    } finally {
      database.close();
    }
  });

  it("stores a complete normalized color array when a template is written", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "fictional-channel");
      await setChatVotingEnabled(database, true);
      const repository = createChatVotingRepository(database as unknown as D1Database);

      await expect(repository.templates.createTemplate("fictional-channel", "template-normalized-write", {
        shortcut: "normalized",
        title: "Normalized colors",
        labels: ["Pizza", "Burger", "Kebab"],
        answerColors: [],
        offerInCockpit: true,
        freeTextMode: null,
        durationSeconds: 120,
      }, "2026-10-04T10:00:00.000Z", { sql: "", values: [] })).resolves.toBe("created");

      const written = await database.prepare("SELECT answer_colors FROM chat_vote_templates WHERE id = ?")
        .bind("template-normalized-write").first<{ answer_colors: string }>();
      expect(written?.answer_colors).toBe('["#5b8cff","#ff9f43","#2ed3a3"]');
    } finally {
      database.close();
    }
  });

  it("creates, revision-saves, conflicts, deletes, and resolves a legacy alias", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "fictional-channel");
      await insertLoginIdentityAndSession(database, "fictional-operator");
      await insertMember(database, "fictional-channel", "fictional-operator", "operator");
      await setChatVotingEnabled(database, true);
      const repository = createChatVotingRepository(database as unknown as D1Database);
      const authorization = authorizeModuleMutation(
        "fictional-channel",
        { userId: "fictional-operator", sessionId: "session-fictional-operator" },
        "2026-10-04T10:00:00.000Z",
      );
      const draft = { shortcut: "essen", title: "Was essen wir?", labels: ["Pizza", "Burger"], answerColors: ["#5b8cff", "#ff9f43"], offerInCockpit: true, freeTextMode: null, durationSeconds: 120 } as const;

      await expect(repository.templates.createTemplate("fictional-channel", "template-a", draft, "2026-10-04T10:00:00.000Z", authorization))
        .resolves.toBe("created");
      const created = await repository.templates.template("fictional-channel", "template-a");
      expect(created).toMatchObject({ shortcut: "essen", title: "Was essen wir?", labels: ["Pizza", "Burger"], answerColors: ["#5b8cff", "#ff9f43"], offerInCockpit: true, revision: 1 });
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
      await setChatVotingEnabled(database, true);
      const repository = createChatVotingRepository(database as unknown as D1Database);
      const authorization = authorizeModuleMutation(
        "fictional-channel",
        { userId: "fictional-operator", sessionId: "session-fictional-operator" },
        "2026-10-04T10:00:00.000Z",
      );
      const draft = { shortcut: null, title: "", labels: [], answerColors: [], offerInCockpit: true, freeTextMode: null, durationSeconds: 0 } as const;
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

  it("keeps template usage timestamps monotonic when an older start is recorded late", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "fictional-channel");
      await insertLoginIdentityAndSession(database, "fictional-operator");
      await insertMember(database, "fictional-channel", "fictional-operator", "operator");
      await setChatVotingEnabled(database, true);
      const repository = createChatVotingRepository(database as unknown as D1Database);
      const authorization = authorizeModuleMutation(
        "fictional-channel",
        { userId: "fictional-operator", sessionId: "session-fictional-operator" },
        "2026-10-04T10:00:00.000Z",
      );
      const draft = { shortcut: null, title: "Dinner", labels: ["Pizza", "Burger"], answerColors: ["#5b8cff", "#ff9f43"], offerInCockpit: true, freeTextMode: null, durationSeconds: 120 } as const;
      await repository.templates.createTemplate("fictional-channel", "template-monotonic", draft, "2026-10-04T10:00:00.000Z", authorization);

      await repository.templates.markTemplateUsed("fictional-channel", "template-monotonic", "2030-01-01T12:30:00.000Z");
      await repository.templates.markTemplateUsed("fictional-channel", "template-monotonic", "2030-01-01T12:00:00.000Z");

      await expect(repository.templates.template("fictional-channel", "template-monotonic"))
        .resolves.toMatchObject({ lastUsedAt: "2030-01-01T12:30:00.000Z" });
    } finally {
      database.close();
    }
  });

  it("checks module activation and member permission in every saved-template mutation", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "fictional-channel");
      await insertLoginIdentityAndSession(database, "fictional-operator");
      await insertMember(database, "fictional-channel", "fictional-operator", "operator");
      await setChatVotingEnabled(database, true);
      const repository = createChatVotingRepository(database as unknown as D1Database);
      const authorization = authorizeModuleMutation(
        "fictional-channel",
        { userId: "fictional-operator", sessionId: "session-fictional-operator" },
        "2026-10-04T10:00:00.000Z",
      );
      const draft = { shortcut: null, title: "Dinner", labels: ["Pizza", "Burger"], answerColors: ["#5b8cff", "#ff9f43"], offerInCockpit: true, freeTextMode: null, durationSeconds: 120 } as const;
      await expect(repository.templates.createTemplate("fictional-channel", "template-guard", draft, "2026-10-04T10:00:00.000Z", authorization))
        .resolves.toBe("created");

      await setChatVotingEnabled(database, false);
      await expect(repository.templates.createTemplate("fictional-channel", "template-disabled", draft, "2026-10-04T10:00:00.000Z", authorization))
        .resolves.toBe("unauthorized");
      await expect(repository.templates.saveTemplate("fictional-channel", "template-guard", 1, { ...draft, title: "Edited" }, "2026-10-04T10:00:00.000Z", authorization))
        .resolves.toMatchObject({ status: "unauthorized" });
      await expect(repository.templates.deleteTemplate("fictional-channel", "template-guard", 1, authorization))
        .resolves.toBe("unauthorized");
      await expect(repository.templates.template("fictional-channel", "template-guard"))
        .resolves.toMatchObject({ title: "Dinner" });
    } finally {
      database.close();
    }
  });

  it("rejects a vote start when its saved result text template revision changed after it was read", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "fictional-channel");
      await setChatVotingEnabled(database, true);
      const repository = createChatVotingRepository(database as unknown as D1Database);
      await repository.templates.createTemplate(
        "fictional-channel",
        "template-race",
        { shortcut: "essen", title: "Dinner", resultText: "Result: {var.score}", labels: ["Yes", "No"], answerColors: ["#5b8cff", "#ff9f43"], offerInCockpit: true, freeTextMode: null, durationSeconds: 120 },
        "2026-10-04T10:00:00.000Z",
        { sql: "", values: [] },
      );
      const vote: ChatVoteDraft = {
        id: "vote-template-race",
        channelId: "fictional-channel",
        kind: "yes_no",
        optionCount: 2,
        labels: ["Yes", "No"],
        answerColors: ["#5b8cff", "#ff9f43"],
        title: "Dinner",
        resultText: "Result: {var.score}",
        openedAt: "2026-10-04T10:00:00.000Z",
        closesAt: "2026-10-04T10:02:00.000Z",
        requestedDurationSeconds: 120,
        closeReason: "timer",
        status: "open",
      };

      await database.prepare(
        "UPDATE chat_vote_templates SET result_text = ?, revision = revision + 1 WHERE channel_id = ? AND id = ?",
      ).bind("Result: {var.points}", "fictional-channel", "template-race").run();
      const insertAtTemplateRevision = repository.insertOpen(vote, undefined, {
        id: "template-race",
        revision: 1,
        resultText: "Result: {var.score}",
      });

      await expect(insertAtTemplateRevision).resolves.toBe("busy");
      await expect(database.prepare("SELECT poll_id FROM chat_votes WHERE channel_id = ? AND poll_id = ?")
        .bind("fictional-channel", vote.id).first()).resolves.toBeNull();
    } finally {
      database.close();
    }
  });

  it("returns the PATCH acknowledgement from its UPDATE batch during a concurrent write", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "fictional-channel");
      await insertLoginIdentityAndSession(database, "fictional-operator");
      await insertMember(database, "fictional-channel", "fictional-operator", "operator");
      await setChatVotingEnabled(database, true);
      const base = database as unknown as D1Database;
      const authorization = authorizeModuleMutation(
        "fictional-channel",
        { userId: "fictional-operator", sessionId: "session-fictional-operator" },
        "2026-10-04T10:00:00.000Z",
      );
      const initial = { shortcut: "dinner", title: "Dinner", labels: ["Pizza", "Burger"], answerColors: ["#5b8cff", "#ff9f43"], offerInCockpit: true, freeTextMode: null, durationSeconds: 120 } as const;
      await createChatVotingRepository(base).templates.createTemplate("fictional-channel", "template-race", initial, "2026-10-04T10:00:00.000Z", authorization);
      let injected = false;
      const concurrentDatabase = {
        prepare: base.prepare.bind(base),
        batch: async (statements: D1PreparedStatement[]) => {
          const result = await base.batch(statements);
          if (!injected) {
            injected = true;
            await database.prepare(
              "UPDATE chat_vote_templates SET title = ?, revision = revision + 1 WHERE channel_id = ? AND id = ? AND revision = ?",
            ).bind("Concurrent writer", "fictional-channel", "template-race", 2).run();
          }
          return result;
        },
      } as unknown as D1Database;
      const audit = prepareModuleAudit(concurrentDatabase, "fictional-operator", "2026-10-04T10:00:01.000Z", {
        channelId: "fictional-channel",
        moduleId: "chat_voting",
        action: "chat_voting.template.updated",
        before: { id: "template-race", revision: 1 },
        after: { id: "template-race", revision: 2 },
      });

      const result = await createChatVotingRepository(concurrentDatabase).templates.saveTemplate(
        "fictional-channel", "template-race", 1, { ...initial, title: "Acknowledged write" },
        "2026-10-04T10:00:01.000Z", authorization, audit,
      );

      expect(result).toMatchObject({ status: "saved", template: { title: "Acknowledged write", revision: 2 } });
      await expect(createChatVotingRepository(base).templates.template("fictional-channel", "template-race"))
        .resolves.toMatchObject({ title: "Concurrent writer", revision: 3 });
      await expect(database.prepare("SELECT action FROM audit_log WHERE action = 'chat_voting.template.updated'").all())
        .resolves.toMatchObject({ results: [{ action: "chat_voting.template.updated" }] });
    } finally {
      database.close();
    }
  });

  it("round-trips a vote question through open state and closed history", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "fictional-channel");
      await setChatVotingEnabled(database, true);
      const repository = createChatVotingRepository(database as unknown as D1Database);
      const vote: ChatVoteDraft = {
        id: "question-poll",
        channelId: "fictional-channel",
        kind: "yes_no",
        optionCount: 2,
        labels: ["Yes", "No"],
      answerColors: ["#5b8cff", "#ff9f43"],
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
      await setChatVotingEnabled(database, true);
      await insertLoginIdentityAndSession(database, "fictional-operator");
      await insertMember(database, "fictional-channel", "fictional-operator", "operator");
      const repository = createChatVotingRepository(database as unknown as D1Database);
      const vote: ChatVoteDraft = {
        id: "fictional-poll",
        channelId: "fictional-channel",
        kind: "yes_no",
        optionCount: 2,
        labels: ["Yes", "No"],
      answerColors: ["#5b8cff", "#ff9f43"],
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

      await expect(repository.requestManualClose("fictional-channel", vote.id, vote.closesAt, authorization)).resolves.toBe(false);
      await expect(repository.open("fictional-channel")).resolves.toMatchObject({ id: vote.id, status: "open" });
    } finally {
      database.close();
    }
  });

  it("accepts repeated manual-close requests for an open vote", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "fictional-channel");
      await setChatVotingEnabled(database, true);
      const repository = createChatVotingRepository(database as unknown as D1Database);
      const vote: ChatVoteDraft = {
        id: "fictional-poll",
        channelId: "fictional-channel",
        kind: "yes_no",
        optionCount: 2,
        labels: ["Yes", "No"],
      answerColors: ["#5b8cff", "#ff9f43"],
        title: null,
        openedAt: "2026-10-04T10:00:00.000Z",
        closesAt: "2026-10-04T14:00:00.000Z",
        requestedDurationSeconds: 120,
        closeReason: "limit",
      };
      await repository.insertOpen(vote);
      await expect(repository.requestManualClose("fictional-channel", vote.id, vote.closesAt)).resolves.toBe(true);
      await expect(repository.open("fictional-channel")).resolves.toMatchObject({
        id: vote.id,
        status: "closing",
        closeReason: "manual",
      });

      await expect(repository.requestManualClose("fictional-channel", vote.id, vote.closesAt)).resolves.toBe(true);

      await expect(repository.open("fictional-channel")).resolves.toMatchObject({
        status: "closing",
        closeReason: "manual",
        requestedDurationSeconds: 120,
      });
    } finally {
      database.close();
    }
  });

  it("fences alarms, extensions, and manual close against the persisted deadline", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "fictional-channel");
      await setChatVotingEnabled(database, true);
      const repository = createChatVotingRepository(database as unknown as D1Database);
      const vote: ChatVoteDraft = {
        id: "fictional-poll",
        channelId: "fictional-channel",
        kind: "yes_no",
        optionCount: 2,
        labels: ["Yes", "No"],
      answerColors: ["#5b8cff", "#ff9f43"],
        title: null,
        openedAt: "2026-10-04T10:00:00.000Z",
        closesAt: "2026-10-04T14:00:00.000Z",
        requestedDurationSeconds: 120,
        closeReason: "timer",
      };
      await repository.insertOpen(vote);
      const extendedDeadline = "2026-10-04T14:02:00.000Z";
      const nextExtension = "2026-10-04T14:04:00.000Z";

      await expect(repository.extendClose("fictional-channel", vote.id, vote.closesAt, extendedDeadline)).resolves.toBe(true);
      await expect(repository.requestManualClose("fictional-channel", vote.id, vote.closesAt)).resolves.toBe(false);
      await expect(repository.claimAlarmClose("fictional-channel", vote.id, vote.closesAt, "2026-10-04T14:01:00.000Z")).resolves.toBe(false);
      await expect(repository.claimAlarmClose("fictional-channel", vote.id, extendedDeadline, "2026-10-04T14:01:00.000Z")).resolves.toBe(false);
      await expect(repository.extendClose("fictional-channel", vote.id, vote.closesAt, nextExtension)).resolves.toBe(false);

      await expect(repository.requestManualClose("fictional-channel", vote.id, extendedDeadline)).resolves.toBe(true);
      await expect(repository.extendClose("fictional-channel", vote.id, extendedDeadline, nextExtension)).resolves.toBe(false);
      await expect(repository.open("fictional-channel")).resolves.toMatchObject({
        status: "closing",
        closesAt: extendedDeadline,
        closeReason: "manual",
        deadlineRevision: 2,
      });
    } finally {
      database.close();
    }
  });

  it("increments the deadline revision when an alarm first claims the close", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "fictional-channel");
      await setChatVotingEnabled(database, true);
      const repository = createChatVotingRepository(database as unknown as D1Database);
      const vote: ChatVoteDraft = {
        id: "alarm-claim-poll",
        channelId: "fictional-channel",
        kind: "yes_no",
        optionCount: 2,
        labels: ["Yes", "No"],
      answerColors: ["#5b8cff", "#ff9f43"],
        title: null,
        openedAt: "2026-10-04T10:00:00.000Z",
        closesAt: "2026-10-04T14:00:00.000Z",
        requestedDurationSeconds: 120,
        closeReason: "timer",
      };
      await repository.insertOpen(vote);

      await expect(repository.claimAlarmClose("fictional-channel", vote.id, vote.closesAt, "2026-10-04T14:01:00.000Z"))
        .resolves.toBe(true);
      await expect(repository.byId("fictional-channel", vote.id)).resolves.toMatchObject({
        status: "closing",
        deadlineRevision: 1,
      });
      await expect(repository.claimAlarmClose("fictional-channel", vote.id, vote.closesAt, "2026-10-04T14:02:00.000Z"))
        .resolves.toBe(false);
    } finally {
      database.close();
    }
  });

  it("does not start a vote in the SQL statement when chat voting is disabled", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "fictional-channel");
      await setChatVotingEnabled(database, false);
      const repository = createChatVotingRepository(database as unknown as D1Database);
      const vote: ChatVoteDraft = {
        id: "disabled-start-poll",
        channelId: "fictional-channel",
        kind: "yes_no",
        optionCount: 2,
        labels: ["Yes", "No"],
      answerColors: ["#5b8cff", "#ff9f43"],
        title: null,
        openedAt: "2026-10-04T10:00:00.000Z",
        closesAt: "2026-10-04T14:00:00.000Z",
        requestedDurationSeconds: 120,
        closeReason: "timer",
      };

      await expect(repository.insertOpen(vote)).resolves.toBe("busy");
      await expect(repository.open("fictional-channel")).resolves.toBeNull();
    } finally {
      database.close();
    }
  });

  it("does not close or extend a vote after chat voting is disabled", async () => {
    const database = new TestD1Database();
    try {
      await insertChannel(database, "fictional-channel");
      await setChatVotingEnabled(database, true);
      const repository = createChatVotingRepository(database as unknown as D1Database);
      const vote: ChatVoteDraft = {
        id: "disabled-mutation-poll",
        channelId: "fictional-channel",
        kind: "yes_no",
        optionCount: 2,
        labels: ["Yes", "No"],
      answerColors: ["#5b8cff", "#ff9f43"],
        title: null,
        openedAt: "2026-10-04T10:00:00.000Z",
        closesAt: "2026-10-04T14:00:00.000Z",
        requestedDurationSeconds: 120,
        closeReason: "timer",
      };
      await expect(repository.insertOpen(vote)).resolves.toBe("inserted");
      await setChatVotingEnabled(database, false);

      await expect(repository.requestManualClose("fictional-channel", vote.id, vote.closesAt)).resolves.toBe(false);
      await expect(repository.extendClose("fictional-channel", vote.id, vote.closesAt, "2026-10-04T14:02:00.000Z"))
        .resolves.toBe(false);
      await expect(repository.open("fictional-channel")).resolves.toMatchObject({
        id: vote.id,
        status: "open",
        closesAt: vote.closesAt,
        deadlineRevision: 0,
      });
    } finally {
      database.close();
    }
  });
});
