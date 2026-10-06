import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModuleBallotAccess, ModuleRouteEnvironment } from "../../src/modules/contract";
import type { ChatVoteDraft } from "../../src/modules/chat_voting/contracts";
import { chatVotingRoutes } from "../../src/modules/chat_voting/routes";
import { createChatVotingRepository } from "../../src/modules/chat_voting/repository";
import { authorizeModuleMutation } from "../../src/worker/module-authorization";
import { insertChannel, insertLoginIdentityAndSession, insertMember } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "chat-voting-route-channel";
const ACTOR_ID = "chat-voting-route-actor";
const databases: TestD1Database[] = [];

const openTextVote: ChatVoteDraft = {
  id: "current-text-poll",
  channelId: CHANNEL_ID,
  preset: "free_text",
  optionCount: 0,
  labels: [],
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
): Hono<ModuleRouteEnvironment> => {
  const app = new Hono<ModuleRouteEnvironment>();
  app.use("*", async (context, next) => {
    context.set("channelRole", "operator");
    context.set("actor", { userId: ACTOR_ID, sessionId: `session-${ACTOR_ID}` });
    context.set("authorizeMutation", authorize);
    context.set("ballots", () => ballots);
    context.set("readChannelBlockedTerms", readBlockedTerms);
    context.set("publishModuleOverlayMessage", publish);
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
  it.each([
    ["missing", { preset: "yes_no" }],
    ["negative", { preset: "yes_no", durationSeconds: -1 }],
    ["fractional", { preset: "yes_no", durationSeconds: 1.5 }],
    ["above four hours", { preset: "yes_no", durationSeconds: 14_401 }],
    ["wrong type", { preset: "yes_no", durationSeconds: "60" }],
  ])("rejects a %s per-vote duration before starting", async (_case, body) => {
    const response = await chatVotingRoutes.request("/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "chat_voting_request_invalid" });
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
