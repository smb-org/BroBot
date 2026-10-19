import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ModulePointsAccess, ModuleRouteEnvironment } from "../../src/modules/contract";
import { pointsRoutes } from "../../src/modules/points/routes";
import { writeModuleAudit } from "../../src/worker/module-audit";
import { insertChannel } from "./fixtures";
import { TestD1Database } from "./test-d1";

const CHANNEL_ID = "kanal_demo";
const ACTOR_ID = "manager_demo";
const OPERATION_ID = "admin:01234567-89ab-42cd-8abc-0123456789ab";
const databases: TestD1Database[] = [];

interface Operation {
  operationId: string;
  accountId: string;
  delta: number;
  reason: string;
  actorId: string;
  actorLogin: string;
  createdAt: string;
}

const createHarness = (options: { role?: "manager" | "operator"; failFirstAudit?: boolean; initialBalance?: number } = {}) => {
  const database = new TestD1Database();
  databases.push(database);
  const operations = new Map<string, Operation>();
  const pending = new Map<string, Operation>();
  let balance = options.initialBalance ?? 50;
  let failFirstAudit = options.failFirstAudit ?? false;
  const pointAccess = {
    apply: vi.fn((operationId: string, _kind: string, movements: { accountId: string; delta?: number }[], result: unknown) => {
      const existing = operations.get(operationId);
      if (existing !== undefined) {
        const detail = result as Operation;
        if (existing.accountId !== detail.accountId || existing.delta !== detail.delta || existing.reason !== detail.reason) {
          throw new Error("operation_conflict");
        }
        return Promise.resolve({ replayed: true, result: existing, balances: { [existing.accountId]: balance } });
      }
      const userMovement = movements.find((movement) => movement.accountId !== "__house");
      if (userMovement === undefined) throw new Error("invalid_account");
      if (balance + (userMovement.delta ?? 0) < 0) throw new Error("insufficient_balance");
      const detail = result as Operation;
      operations.set(operationId, detail);
      pending.set(operationId, detail);
      balance += userMovement.delta ?? 0;
      return Promise.resolve({ replayed: false, result: detail, balances: { [detail.accountId]: balance } });
    }),
    touchAccount: vi.fn(() => Promise.resolve({ welcomePending: false })),
    ackWelcome: vi.fn(() => Promise.resolve()),
    creditActivity: vi.fn(() => Promise.resolve({ credited: 0 })),
    balance: vi.fn((accountId: string) => Promise.resolve(accountId === "viewer_demo" ? balance : 0)),
    listAccounts: vi.fn(() => Promise.resolve({ rows: [{ accountId: "viewer_demo", login: "pixelpilz", balance, monthNet: 0 }] })),
    history: vi.fn(() => Promise.resolve({ rows: [] })),
    summary: vi.fn(() => Promise.resolve({ circulation: balance, jackpots: {}, inRounds: 0, accounts: 1, month: "2026-10" })),
    ranking: vi.fn(() => Promise.resolve([])),
    rankOf: vi.fn(() => Promise.resolve({ rank: null, net: 0 })),
    markAuditWritten: vi.fn((operationId: string) => { pending.delete(operationId); return Promise.resolve(); }),
    pendingAudits: vi.fn(() => Promise.resolve([...pending].map(([operationId, detail]) => ({ operationId, detail })))),
    claimCooldown: vi.fn(() => Promise.resolve(true)),
    rounds: {} as ModulePointsAccess["rounds"],
  } satisfies ModulePointsAccess;
  const auditWriter: ModuleRouteEnvironment["Variables"]["writeModuleAudit"] = vi.fn(async (
    entry: Parameters<ModuleRouteEnvironment["Variables"]["writeModuleAudit"]>[0],
    changedAt: Parameters<ModuleRouteEnvironment["Variables"]["writeModuleAudit"]>[1],
    options: Parameters<ModuleRouteEnvironment["Variables"]["writeModuleAudit"]>[2],
  ) => {
    if (failFirstAudit) {
      failFirstAudit = false;
      throw new Error("audit_unavailable");
    }
    await writeModuleAudit(database as unknown as D1Database, ACTOR_ID, changedAt, entry, "member", options);
  });
  const app = new Hono<ModuleRouteEnvironment>();
  app.use("*", async (context, next) => {
    context.set("channelRole", options.role ?? "manager");
    context.set("actor", { userId: ACTOR_ID, sessionId: "session_demo" });
    context.set("session", { userId: ACTOR_ID, sessionId: "session_demo", login: "kanal_demo" });
    context.set("points", () => pointAccess);
    context.set("writeModuleAudit", auditWriter);
    await next();
  });
  app.route("/channels/:channelId/modules/points", pointsRoutes);

  const request = (path: string, body?: unknown): Request => new Request(`https://brobot.example/channels/${CHANNEL_ID}/modules/points${path}`, {
    ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  return { database, pointAccess, auditWriter, operations, pending, request, app };
};

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("points routes", () => {
  it("rejects a correction that would take the balance below zero (protects=correction guard preserves nonnegative viewer balances; fails_when=a negative balance or persisted operation is written; no_claim=the route access is backed by an in-memory ledger double)", async () => {
    const harness = createHarness();
    await insertChannel(harness.database, CHANNEL_ID);

    const response = await harness.app.fetch(harness.request("/accounts/viewer_demo/adjust", {
      operationId: "01234567-89ab-42cd-8abc-0123456789ab", delta: -51, reason: "manual correction",
    }), { DB: harness.database as unknown as D1Database });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "insufficient_balance" });
    expect(harness.pointAccess.apply).toHaveBeenCalledOnce();
    expect(harness.operations.size).toBe(0);
    expect(harness.pending.size).toBe(0);
    expect(harness.auditWriter).not.toHaveBeenCalled();
  });

  it("retries a pending audit with the same operation without another booking (protects=partial success can finish audit idempotently; fails_when=retry changes balance twice or writes duplicate audit rows; no_claim=the Durable Object apply is represented by a replay-aware fake)", async () => {
    const harness = createHarness({ failFirstAudit: true });
    await insertChannel(harness.database, CHANNEL_ID);
    const body = { operationId: "01234567-89ab-42cd-8abc-0123456789ab", delta: 12, reason: "stream prize" };

    const first = await harness.app.fetch(harness.request("/accounts/viewer_demo/adjust", body), { DB: harness.database as unknown as D1Database });
    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toEqual({ balance: 62, auditPending: true });
    await expect(harness.app.fetch(harness.request("/accounts/viewer_demo/adjust", body), { DB: harness.database as unknown as D1Database }))
      .resolves.toMatchObject({ status: 200 });

    expect(harness.pointAccess.apply).toHaveBeenCalledTimes(1);
    expect(harness.pending.size).toBe(0);
    await expect(harness.database.prepare(
      "SELECT COUNT(*) AS count FROM audit_log WHERE channel_id = ? AND action = 'points_adjusted'",
    ).bind(CHANNEL_ID).first()).resolves.toEqual({ count: 1 });
    expect([...harness.operations.keys()]).toEqual([OPERATION_ID]);
  });

  it("completes a pending correction audit on manager account load (protects=page reload reconciles a committed pending audit once; fails_when=load omits or duplicates points_adjusted; no_claim=the ledger's pending audit list is represented by an in-memory fake)", async () => {
    const harness = createHarness();
    await insertChannel(harness.database, CHANNEL_ID);
    const pending: Operation = {
      operationId: OPERATION_ID,
      accountId: "viewer_demo",
      delta: 8,
      reason: "stream prize",
      actorId: ACTOR_ID,
      actorLogin: "kanal_demo",
      createdAt: "2026-10-19T12:00:00.000Z",
    };
    harness.operations.set(OPERATION_ID, pending);
    harness.pending.set(OPERATION_ID, pending);

    const response = await harness.app.fetch(harness.request("/accounts"), { DB: harness.database as unknown as D1Database });
    expect(response.status).toBe(200);
    expect(harness.auditWriter).toHaveBeenCalledTimes(1);
    expect(harness.pointAccess.markAuditWritten).toHaveBeenCalledWith(OPERATION_ID);
    await expect(harness.database.prepare(
      "SELECT action, json_extract(after_json, '$.operationId') AS operation_id FROM audit_log WHERE channel_id = ?",
    ).bind(CHANNEL_ID).first()).resolves.toEqual({ action: "points_adjusted", operation_id: OPERATION_ID });

    const operatorHarness = createHarness({ role: "operator" });
    operatorHarness.pending.set(OPERATION_ID, pending);
    const operatorResponse = await operatorHarness.app.fetch(operatorHarness.request("/accounts"), {
      DB: operatorHarness.database as unknown as D1Database,
    });
    expect(operatorResponse.status).toBe(200);
    expect(operatorHarness.auditWriter).not.toHaveBeenCalled();
    expect(operatorHarness.pointAccess.markAuditWritten).not.toHaveBeenCalled();
  });

  it("rejects an operation ID reused with a different correction payload (protects=adjustment idempotency includes account, amount, and reason; fails_when=a conflicting retry returns success or mutates balance; no_claim=the ledger apply is represented by an in-memory fake)", async () => {
    const harness = createHarness();
    await insertChannel(harness.database, CHANNEL_ID);
    const original = { operationId: "01234567-89ab-42cd-8abc-0123456789ab", delta: 12, reason: "stream prize" };
    const initial = await harness.app.fetch(harness.request("/accounts/viewer_demo/adjust", original), { DB: harness.database as unknown as D1Database });
    expect(initial.status).toBe(200);

    const conflict = await harness.app.fetch(harness.request("/accounts/viewer_demo/adjust", { ...original, reason: "different reason" }), {
      DB: harness.database as unknown as D1Database,
    });

    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({ error: "operation_conflict" });
    expect(await harness.pointAccess.balance("viewer_demo")).toBe(62);
    expect(harness.pointAccess.apply).toHaveBeenCalledTimes(1);
  });

  it("denies correction writes to an operator (protects=only managers and broadcasters can mutate points; fails_when=an operator books an adjustment; no_claim=authorization role is supplied to the route context)", async () => {
    const harness = createHarness({ role: "operator" });
    const response = await harness.app.fetch(harness.request("/accounts/viewer_demo/adjust", {
      operationId: "01234567-89ab-42cd-8abc-0123456789ab", delta: 1, reason: "manual correction",
    }), { DB: harness.database as unknown as D1Database });

    expect(response.status).toBe(403);
    expect(harness.pointAccess.apply).not.toHaveBeenCalled();
    expect(harness.auditWriter).not.toHaveBeenCalled();
  });

  it("lists account pages and history through read-only ledger calls (protects=member reads expose the requested sort, search, and page sizes; fails_when=route skips the read API or forwards a wrong query; no_claim=results are supplied by an in-memory ledger double)", async () => {
    const harness = createHarness({ role: "operator" });
    const accounts = await harness.app.fetch(new Request(
      `https://brobot.example/channels/${CHANNEL_ID}/modules/points/accounts?sort=month&q=pixel&cursor=page-2`,
    ), { DB: harness.database as unknown as D1Database });
    const history = await harness.app.fetch(harness.request("/accounts/viewer_demo/history?cursor=page-2"), {
      DB: harness.database as unknown as D1Database,
    });

    expect(accounts.status).toBe(200);
    expect(harness.pointAccess.listAccounts).toHaveBeenCalledWith({ sort: "month", search: "pixel", cursor: "page-2", limit: 50 });
    expect(history.status).toBe(200);
    expect(harness.pointAccess.history).toHaveBeenCalledWith("viewer_demo", "page-2", 25);
    expect(harness.auditWriter).not.toHaveBeenCalled();
  });
});
