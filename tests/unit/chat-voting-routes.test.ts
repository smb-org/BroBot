import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleBallotAccess, ModuleRouteEnvironment } from "../../src/modules/contract";
import { DEFAULT_CHAT_VOTING_SETTINGS, type ChatVoteDraft, type ChatVoteTemplate } from "../../src/modules/chat_voting/contracts";
import { chatVotingRoutes } from "../../src/modules/chat_voting/routes";
import { createChatVotingRepository } from "../../src/modules/chat_voting/repository";
import { authorizeModuleMutation } from "../../src/worker/module-authorization";
import { prepareModuleAudit } from "../../src/worker/module-audit";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "chat-voting-route-channel";
const ACTOR_ID = "chat-voting-route-actor";
const databases: TestD1Database[] = [];

const openTextVote: ChatVoteDraft = {
  id: "current-text-poll",
  channelId: CHANNEL_ID,
  kind: "free_text",
  optionCount: 0,
  labels: [],
  title: null,
  textMode: "whole_message",
  termFilterReady: true,
  openedAt: "2026-10-04T10:00:00.000Z",
  closesAt: "2026-10-04T14:00:00.000Z",
  requestedDurationSeconds: null,
  closeReason: "limit",
};

const createDatabase = async (): Promise<TestD1Database> => {
  const database = new TestD1Database();
  databases.push(database);
  await insertChannel(database, CHANNEL_ID);
  await database.prepare(
    "INSERT INTO channel_modules (channel_id, module_id, enabled, settings) VALUES (?, 'chat_voting', 1, ?)",
  ).bind(CHANNEL_ID, JSON.stringify({ ...DEFAULT_CHAT_VOTING_SETTINGS, autoCloseSeconds: 120 })).run();
  await insertLoginIdentityAndSession(database, ACTOR_ID);
  await insertMember(database, CHANNEL_ID, ACTOR_ID, "operator");
  await createChatVotingRepository(database as unknown as D1Database).insertOpen(openTextVote);
  return database;
};

const ballotAccess = (overrides: Partial<ModuleBallotAccess> = {}): ModuleBallotAccess => ({
  open: vi.fn(() => Promise.resolve({ status: "opened" as const })),
  cast: vi.fn(() => Promise.resolve({ status: "not_open" as const, counts: [], revision: 0 })),
  read: vi.fn(() => Promise.resolve(null)),
  close: vi.fn(() => Promise.resolve(null)),
  finalize: vi.fn(() => Promise.resolve({ outcome: "not_open" as const, counts: [], revision: 0 })),
  ...overrides,
});

const appFor = (
  ballots: ModuleBallotAccess,
  readBlockedTerms: (channelId: string) => Promise<readonly string[] | null>,
  publish = vi.fn(() => Promise.resolve()),
  authorize = authorizeModuleMutation,
  writeAudit = vi.fn(() => Promise.resolve()),
): Hono<ModuleRouteEnvironment> => {
  const app = new Hono<ModuleRouteEnvironment>();
  app.use("*", async (context, next) => {
    context.set("channelRole", "operator");
    context.set("actor", { userId: ACTOR_ID, sessionId: `session-${ACTOR_ID}` });
    context.set("authorizeMutation", authorize);
    context.set("ballots", () => ballots);
    context.set("readChannelBlockedTerms", readBlockedTerms);
    context.set("publishModuleOverlayMessage", publish);
    context.set("writeModuleAudit", writeAudit);
    context.set("prepareModuleAudit", (entry, changedAt) => prepareModuleAudit(context.env.DB, ACTOR_ID, changedAt, entry));
    await next();
  });
  app.route(`/channels/:channelId/modules/chat_voting`, chatVotingRoutes);
  return app;
};

const approveRequest = (pollId: string, term: string): Request => new Request(
  `https://brobot.example/channels/${CHANNEL_ID}/modules/chat_voting/approve-term`,
  { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pollId, term }) },
);

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("chat voting routes", () => {
  it("creates and revision-saves templates, retains invalid drafts, and rejects shortcuts and stale writes", async () => {
    const database = await createDatabase();
    const app = appFor(ballotAccess(), () => Promise.resolve([]));
    const templatesPath = `/channels/${CHANNEL_ID}/modules/chat_voting/templates`;
    const blankResponse = await app.fetch(new Request(`https://brobot.example${templatesPath}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}),
    }), { DB: database as unknown as D1Database });
    expect(blankResponse.status).toBe(400);
    const whitespaceLabelResponse = await app.fetch(new Request(`https://brobot.example${templatesPath}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shortcut: null, title: "  ", labels: [" ", ""], freeTextMode: null, durationSeconds: 120 }),
    }), { DB: database as unknown as D1Database });
    expect(whitespaceLabelResponse.status).toBe(400);
    const createdResponse = await app.fetch(new Request(`https://brobot.example${templatesPath}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shortcut: null, title: "Dinner", labels: ["Pizza", "Burger"], freeTextMode: null, durationSeconds: 120 }),
    }), {
      DB: database as unknown as D1Database,
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json<{ template: ChatVoteTemplate }>();
    expect(created.template).toMatchObject({ title: "Dinner", labels: ["Pizza", "Burger"], durationSeconds: 120, revision: 1 });
    const entryPath = `${templatesPath}/${encodeURIComponent(created.template.id)}`;
    const savedResponse = await app.fetch(new Request(`https://brobot.example${entryPath}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shortcut: null, title: "One answer draft", labels: ["Only one"], freeTextMode: null, durationSeconds: 120, revision: 1 }),
    }), { DB: database as unknown as D1Database });
    expect(savedResponse.status).toBe(200);
    await expect(savedResponse.json()).resolves.toMatchObject({ template: { title: "One answer draft", labels: ["Only one"], revision: 2 } });
    const blankPatchResponse = await app.fetch(new Request(`https://brobot.example${entryPath}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shortcut: null, title: " ", labels: [" ", ""], freeTextMode: null, durationSeconds: 120, revision: 2 }),
    }), { DB: database as unknown as D1Database });
    expect(blankPatchResponse.status).toBe(400);
    await expect(blankPatchResponse.json()).resolves.toEqual({ error: "chat_vote_template_request_invalid" });
    const staleResponse = await app.fetch(new Request(`https://brobot.example${entryPath}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shortcut: null, title: "Stale", labels: ["A", "B"], freeTextMode: null, durationSeconds: 120, revision: 1 }),
    }), { DB: database as unknown as D1Database });
    expect(staleResponse.status).toBe(409);
    await expect(staleResponse.json()).resolves.toEqual({ error: "chat_vote_template_conflict" });
    const invalidShortcutResponse = await app.fetch(new Request(`https://brobot.example${entryPath}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shortcut: "Bad!", title: "Valid title", labels: ["A", "B"], freeTextMode: null, durationSeconds: 120, revision: 2 }),
    }), { DB: database as unknown as D1Database });
    expect(invalidShortcutResponse.status).toBe(400);
    await expect(invalidShortcutResponse.json()).resolves.toEqual({ error: "chat_vote_template_shortcut_invalid" });
    const deleteResponse = await app.fetch(new Request(`https://brobot.example${entryPath}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: 2 }),
    }), { DB: database as unknown as D1Database });
    expect(deleteResponse.status).toBe(200);
    const auditEntries = await database.prepare(
      "SELECT action, actor_user_id, before_json, after_json FROM audit_log WHERE channel_id = ? AND action LIKE 'chat_voting.template.%'",
    ).bind(CHANNEL_ID).all<{ action: string; actor_user_id: string; before_json: string | null; after_json: string | null }>();
    expect(auditEntries.results).toHaveLength(3);
    expect(auditEntries.results.map((entry) => entry.action).sort((left, right) => left.localeCompare(right))).toEqual([
      "chat_voting.template.created",
      "chat_voting.template.deleted",
      "chat_voting.template.updated",
    ]);
    expect(auditEntries.results.every((entry) => entry.actor_user_id === ACTOR_ID)).toBe(true);
    const updatedAudit = auditEntries.results.find((entry) => entry.action === "chat_voting.template.updated");
    expect(updatedAudit?.before_json).toContain('"revision":1');
    expect(updatedAudit?.after_json).toContain('"name":"One answer draft"');
    const deletedAudit = auditEntries.results.find((entry) => entry.action === "chat_voting.template.deleted");
    expect(deletedAudit?.before_json).toContain('"name":"One answer draft"');
    expect(deletedAudit?.after_json).toBe("null");
  });

  it("keeps a successful template start successful when usage bookkeeping fails", async () => {
    const database = await createDatabase();
    const repository = createChatVotingRepository(database as unknown as D1Database);
    await repository.finish(CHANNEL_ID, openTextVote.id, "manual", "2026-10-04T10:01:00.000Z", [], [], 0, true);
    const authorization = authorizeModuleMutation(
      CHANNEL_ID,
      { userId: ACTOR_ID, sessionId: `session-${ACTOR_ID}` },
      "2026-10-04T10:02:00.000Z",
    );
    const createStatus = await repository.templates.createTemplate(CHANNEL_ID, "usage-failure-template", {
      shortcut: "essen", title: "Dinner", labels: ["Pizza", "Burger"], freeTextMode: null, durationSeconds: 120,
    }, "2026-10-04T10:02:00.000Z", authorization);
    expect(createStatus).toBe("created");
    await database.prepare(
      "CREATE TRIGGER fail_template_usage BEFORE UPDATE OF last_used_at ON chat_vote_templates BEGIN SELECT RAISE(FAIL, 'usage write failed'); END",
    ).run();
    const app = appFor(ballotAccess(), () => Promise.resolve([]));
    const scheduleModuleAlarm = vi.fn(() => Promise.resolve());
    const namespace = {
      idFromName: vi.fn(() => ({})),
      get: vi.fn(() => ({ scheduleModuleAlarm })),
    } as unknown as Env["CHANNEL"];
    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/modules/chat_voting/start`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ templateId: "usage-failure-template" }),
    }), { DB: database as unknown as D1Database, CHANNEL: namespace });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ vote: { title: "Dinner", status: "open" } });
    expect(scheduleModuleAlarm).toHaveBeenCalled();
  });

  it.each(["broadcaster", "manager", "operator"] as const)("allows template CRUD for the %s channel member role", async (role) => {
    const database = await createDatabase();
    await database.prepare("UPDATE channel_members SET role = ? WHERE channel_id = ? AND user_id = ?")
      .bind(role, CHANNEL_ID, ACTOR_ID).run();
    const app = appFor(ballotAccess(), () => Promise.resolve([]));
    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/modules/chat_voting/templates`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shortcut: null, title: "Dinner", labels: ["Pizza", "Burger"], freeTextMode: null, durationSeconds: 120 }),
    }), { DB: database as unknown as D1Database });
    expect(response.status).toBe(201);
  });

  it.each([
    ["missing", { preset: "yes_no" }],
    ["negative", { preset: "yes_no", durationSeconds: -1 }],
    ["fractional", { preset: "yes_no", durationSeconds: 1.5 }],
    ["above four hours", { preset: "yes_no", durationSeconds: 14_401 }],
    ["wrong type", { preset: "yes_no", durationSeconds: "60" }],
    ["overlong question", { preset: "yes_no", durationSeconds: 60, title: "😀".repeat(81) }],
  ])("rejects a %s per-vote duration before starting", async (_case, body) => {
    const response = await chatVotingRoutes.request("/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "chat_voting_request_invalid" });
  });

  it.each([
    ["the wrong number of labels", { preset: "yes_no", durationSeconds: 60, labels: ["Yes"] }],
    ["a blank label", { preset: "yes_no", durationSeconds: 60, labels: ["Yes", "  "] }],
    ["an overlong label", { preset: "yes_no", durationSeconds: 60, labels: ["x".repeat(33), "No"] }],
    ["labels on a free-text vote", { preset: "free_text", durationSeconds: 60, labels: [] }],
    ["a non-string label", { preset: "yes_no", durationSeconds: 60, labels: ["Yes", 2] }],
  ])("rejects %s before starting", async (_case, body) => {
    const response = await chatVotingRoutes.request("/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "chat_voting_request_invalid" });
  });

  it("returns only the default duration now that answer defaults are templates", async () => {
    const database = await createDatabase();
    const app = appFor(ballotAccess(), () => Promise.resolve([]));
    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/modules/chat_voting/current`), {
      DB: database as unknown as D1Database,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ defaultDurationSeconds: 120 });
  });

  it("returns a legacy-written open vote without scheduling a close alarm", async () => {
    const database = await createDatabase();
    await database.prepare("UPDATE chat_votes SET legacy_written = 1 WHERE channel_id = ? AND poll_id = ?")
      .bind(CHANNEL_ID, openTextVote.id).run();
    const app = appFor(ballotAccess(), () => Promise.resolve([]));
    const scheduleModuleAlarm = vi.fn(() => Promise.resolve());
    const namespace = {
      idFromName: vi.fn(() => ({})),
      get: vi.fn(() => ({ scheduleModuleAlarm })),
    } as unknown as Env["CHANNEL"];

    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/modules/chat_voting/current`), {
      DB: database as unknown as D1Database,
      CHANNEL: namespace,
    });

    expect(response.status).toBe(200);
    expect(scheduleModuleAlarm).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({ vote: { id: openTextVote.id, status: "open" } });
  });

  it("starts a panel vote with a trimmed question and Unicode labels counted in code points", async () => {
    const database = await createDatabase();
    await createChatVotingRepository(database as unknown as D1Database).finish(
      CHANNEL_ID, openTextVote.id, "manual", "2026-10-04T10:01:00.000Z", [], [], 0, true,
    );
    const writeAudit = vi.fn(() => Promise.resolve());
    const app = appFor(ballotAccess(), () => Promise.resolve([]), vi.fn(() => Promise.resolve()), authorizeModuleMutation, writeAudit);
    const scheduleModuleAlarm = vi.fn(() => Promise.resolve());
    const namespace = {
      idFromName: vi.fn(() => ({})),
      get: vi.fn(() => ({ scheduleModuleAlarm })),
    } as unknown as Env["CHANNEL"];
    const labels = ["😀".repeat(17), "Burger"];
    const title = "Pizza today?";
    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/modules/chat_voting/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "options", optionCount: 2, durationSeconds: 60, labels, title: `  ${title}  ` }),
    }), {
      DB: database as unknown as D1Database,
      CHANNEL: namespace,
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ vote: { labels, title } });
    const auditInput = (writeAudit.mock.calls[0] as unknown as readonly [Record<string, unknown>, string] | undefined)?.[0];
    expect(auditInput).toMatchObject({
      action: "chat_voting.started",
      after: { labels, title },
    });
    expect(scheduleModuleAlarm).toHaveBeenCalledWith("chat_voting", "announce_start", expect.stringMatching(/^start:/u), expect.any(Number), 0);
  });

  it.each(["digit_01", "digit_12"])("does not accept the retired %s preset wire value", async (preset) => {
    const database = await createDatabase();
    await createChatVotingRepository(database as unknown as D1Database).finish(
      CHANNEL_ID, openTextVote.id, "manual", "2026-10-04T10:01:00.000Z", [], [], 0, true,
    );
    const app = appFor(ballotAccess(), () => Promise.resolve([]));
    const namespace = {
      idFromName: vi.fn(() => ({})),
      get: vi.fn(() => ({ scheduleModuleAlarm: vi.fn(() => Promise.resolve()) })),
    } as unknown as Env["CHANNEL"];
    const response = await app.fetch(new Request(`https://brobot.example/channels/${CHANNEL_ID}/modules/chat_voting/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset, durationSeconds: 60, labels: ["Nope", "Sure"] }),
    }), { DB: database as unknown as D1Database, CHANNEL: namespace });

    expect(response.status).toBe(400);
  });

  it("rejects an approval from a stale displayed poll before refreshing or mutating ballots", async () => {
    const database = await createDatabase();
    const readBlockedTerms = vi.fn(() => Promise.resolve([]));
    const setBlockedTerms = vi.fn(() => Promise.resolve({ counts: [], terms: [], more: 0, termFilterReady: true, revision: 1 }));
    const app = appFor(ballotAccess({
      setBlockedTerms,
      read: vi.fn(() => Promise.resolve({ counts: [], terms: [{ term: "alpha", count: 1, approved: false }], more: 0, termFilterReady: true, revision: 1 })),
      approveTerm: vi.fn(() => Promise.resolve({ status: "approved" as const, snapshot: null })),
    }), readBlockedTerms);

    const response = await app.fetch(approveRequest("stale-text-poll", "alpha"), {
      DB: database as unknown as D1Database,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "chat_voting_poll_changed" });
    expect(readBlockedTerms).not.toHaveBeenCalled();
    expect(setBlockedTerms).not.toHaveBeenCalled();
  });

  it("rechecks membership after the blocked-term request and before storage mutation", async () => {
    const database = await createDatabase();
    const readBlockedTerms = vi.fn(async () => {
      await database.prepare("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?")
        .bind(CHANNEL_ID, ACTOR_ID).run();
      return [];
    });
    const setBlockedTerms = vi.fn(() => Promise.resolve({ counts: [], terms: [], more: 0, termFilterReady: true, revision: 1 }));
    const app = appFor(ballotAccess({
      setBlockedTerms,
      read: vi.fn(() => Promise.resolve({ counts: [], terms: [{ term: "alpha", count: 1, approved: false }], more: 0, termFilterReady: true, revision: 1 })),
      approveTerm: vi.fn(() => Promise.resolve({ status: "approved" as const, snapshot: null })),
    }), readBlockedTerms);

    const response = await app.fetch(approveRequest(openTextVote.id, "alpha"), {
      DB: database as unknown as D1Database,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "chat_voting_not_authorized" });
    expect(setBlockedTerms).not.toHaveBeenCalled();
  });

  it("guards the D1 approval write when membership is revoked while the mutation batch is pending", async () => {
    const database = await createDatabase();
    const publish = vi.fn(() => Promise.resolve());
    const setBlockedTerms = vi.fn(() => Promise.resolve({ counts: [], terms: [], more: 0, termFilterReady: true, revision: 1 }));
    const approveTerm = vi.fn(() => Promise.resolve({ status: "approved" as const, snapshot: {
      counts: [], terms: [{ term: "alpha", count: 1, approved: true }], more: 0, termFilterReady: true, revision: 2,
    } }));
    const app = appFor(ballotAccess({
      read: vi.fn(() => Promise.resolve({ counts: [], terms: [{ term: "alpha", count: 1, approved: false }], more: 0, termFilterReady: true, revision: 1 })),
      setBlockedTerms,
      approveTerm,
    }), () => Promise.resolve([]), publish);
    const originalBatch = database.batch.bind(database);
    let signalBatchStarted!: () => void;
    const batchStarted = new Promise<void>((resolve) => { signalBatchStarted = resolve; });
    let releaseBatch!: () => void;
    const batchGate = new Promise<void>((resolve) => { releaseBatch = resolve; });
    database.batch = async (statements) => {
      signalBatchStarted();
      await batchGate;
      return await originalBatch(statements);
    };

    const responsePromise = app.fetch(approveRequest(openTextVote.id, "alpha"), {
      DB: database as unknown as D1Database,
    });
    await batchStarted;
    await database.prepare("DELETE FROM channel_members WHERE channel_id = ? AND user_id = ?")
      .bind(CHANNEL_ID, ACTOR_ID).run();
    releaseBatch();
    const response = await responsePromise;

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "chat_voting_not_authorized" });
    await expect(database.prepare("SELECT 1 FROM chat_vote_term_approvals WHERE channel_id = ? AND poll_id = ? AND term = ?")
      .bind(CHANNEL_ID, openTextVote.id, "alpha").first()).resolves.toBeNull();
    expect(setBlockedTerms).not.toHaveBeenCalled();
    expect(approveTerm).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("publishes a refreshed blocked filter before rejecting the now-blocked approval", async () => {
    const database = await createDatabase();
    const publish = vi.fn(() => Promise.resolve());
    const refreshed = {
      counts: [],
      terms: [{ term: "alpha", count: 1, approved: false }],
      more: 0,
      termFilterReady: true,
      revision: 2,
    };
    const setBlockedTerms = vi.fn(() => Promise.resolve(refreshed));
    const approveTerm = vi.fn(() => Promise.resolve({ status: "approved" as const, snapshot: refreshed }));
    const app = appFor(ballotAccess({ setBlockedTerms, approveTerm }), () => Promise.resolve(["beta*"]), publish);

    const response = await app.fetch(approveRequest(openTextVote.id, "beta"), {
      DB: database as unknown as D1Database,
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "chat_voting_term_blocked" });
    expect(approveTerm).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledWith(CHANNEL_ID, "chat_voting", "tally", "chat_voting.tally", expect.objectContaining({
      pollId: openTextVote.id,
      closesAt: openTextVote.closesAt,
      requestedDurationSeconds: openTextVote.requestedDurationSeconds,
      revision: 2,
      terms: [{ term: "alpha", count: 1, approved: false }],
    }));
  });

  it("records an approval in D1 with the current actor in the guarded write batch", async () => {
    const database = await createDatabase();
    const calls: ReturnType<typeof authorizeModuleMutation>[] = [];
    const authorize = vi.fn((channelId: string, actor: { userId: string; sessionId?: string }, now: string) => {
      const result = authorizeModuleMutation(channelId, actor, now);
      calls.push(result);
      return result;
    });
    const refreshed = {
      counts: [],
      terms: [{ term: "alpha", count: 1, approved: false }],
      more: 0,
      termFilterReady: true,
      revision: 1,
    };
    const approveTerm = vi.fn(() => Promise.resolve({
      status: "approved" as const,
      snapshot: { ...refreshed, terms: [{ term: "alpha", count: 1, approved: true }], revision: 2 },
    }));
    const app = appFor(ballotAccess({
      read: vi.fn(() => Promise.resolve(refreshed)),
      setBlockedTerms: vi.fn(() => Promise.resolve(refreshed)),
      approveTerm,
    }), () => Promise.resolve([]), vi.fn(() => Promise.resolve()), authorize);

    const response = await app.fetch(approveRequest(openTextVote.id, "alpha"), {
      DB: database as unknown as D1Database,
    });

    expect(response.status).toBe(200);
    expect(authorize).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(1);
    expect(approveTerm).toHaveBeenCalledWith(openTextVote.id, "alpha");
    await expect(database.prepare(
      "SELECT approved_by FROM chat_vote_term_approvals WHERE channel_id = ? AND poll_id = ? AND term = ?",
    ).bind(CHANNEL_ID, openTextVote.id, "alpha").first()).resolves.toEqual({ approved_by: ACTOR_ID });
  });
});
