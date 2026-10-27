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
  const operationIdentities = new Map<string, unknown>();
  const pending = new Map<string, Operation>();
  let balance = options.initialBalance ?? 50;
  let failFirstAudit = options.failFirstAudit ?? false;
  const pointAccess = {
    apply: vi.fn((operationId: string, _kind: string, movements: { accountId: string; delta?: number }[], result: unknown, payloadIdentity?: unknown) => {
      const existing = operations.get(operationId);
      if (existing !== undefined) {
        const detail = result as Operation;
        if (existing.accountId !== detail.accountId || existing.delta !== detail.delta || existing.reason !== detail.reason ||
          JSON.stringify(operationIdentities.get(operationId)) !== JSON.stringify(payloadIdentity)) {
          throw new Error("operation_conflict");
        }
        return Promise.resolve({ replayed: true, result: existing, balances: { [existing.accountId]: balance } });
      }
      const userMovement = movements.find((movement) => movement.accountId !== "__house");
      if (userMovement === undefined) throw new Error("invalid_account");
      if (balance + (userMovement.delta ?? 0) < 0) throw new Error("insufficient_balance");
      if (!Number.isSafeInteger(balance + (userMovement.delta ?? 0))) throw new Error("balance_overflow");
      const detail = result as Operation;
      operations.set(operationId, detail);
      if (payloadIdentity !== undefined) operationIdentities.set(operationId, payloadIdentity);
      pending.set(operationId, detail);
      balance += userMovement.delta ?? 0;
      return Promise.resolve({ replayed: false, result: detail, balances: { [detail.accountId]: balance } });
    }),
    settle: vi.fn(() => Promise.resolve({ replayed: false, result: null, balances: {} })),
    touchAccount: vi.fn(() => Promise.resolve({ welcomePending: false, startBonus: null })),
    prepareChatActivity: vi.fn(() => Promise.resolve({
      accountExisted: true,
      welcomePending: false,
      startBonus: null,
      pendingWelcome: null,
    })),
    ackWelcome: vi.fn(() => Promise.resolve()),
    creditActivity: vi.fn(() => Promise.resolve({ credited: 0 })),
    balance: vi.fn((accountId: string) => Promise.resolve(accountId === "viewer_demo" ? balance : 0)),
    getAccount: vi.fn((accountId: string) => Promise.resolve(accountId === "viewer_demo"
      ? { accountId, login: "pixelpilz", balance }
      : null)),
    listAccounts: vi.fn((query: Parameters<ModulePointsAccess["listAccounts"]>[0]) => {
      const row = { accountId: "viewer_demo", login: "pixelpilz", balance, monthNet: 0 };
      const matchesSearch = query.search === undefined || row.login.includes(query.search) || row.accountId.includes(query.search);
      return Promise.resolve({ rows: query.limit > 0 && matchesSearch ? [row] : [] });
    }),
    history: vi.fn(() => Promise.resolve({ rows: [] })),
    summary: vi.fn(() => Promise.resolve({ circulation: balance, jackpots: {}, inRounds: 0, accounts: 1, month: "2026-10" })),
    ranking: vi.fn(() => Promise.resolve([])),
    rankOf: vi.fn(() => Promise.resolve({ rank: null, net: 0 })),
    markAuditWritten: vi.fn((operationId: string) => { pending.delete(operationId); return Promise.resolve(); }),
    pendingAudits: vi.fn(() => Promise.resolve([...pending].map(([operationId, detail]) => ({ operationId, detail })))),
    claimCooldown: vi.fn(() => Promise.resolve(true)),
    rounds: {} as ModulePointsAccess["rounds"],
  } satisfies ModulePointsAccess;
  const auditWriter = vi.fn<ModuleRouteEnvironment["Variables"]["writeModuleAudit"]>(async (
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

  it("rejects a correction whose resulting balance exceeds the safe range in the ledger (protects=balance overflow is a definite response and never persists an operation; fails_when=the route returns 500 or writes a pending or completed operation; no_claim=the ledger is represented by a safe-range in-memory double)", async () => {
    const harness = createHarness({ initialBalance: Number.MAX_SAFE_INTEGER });
    await insertChannel(harness.database, CHANNEL_ID);

    const response = await harness.app.fetch(harness.request("/accounts/viewer_demo/adjust", {
      operationId: "01234567-89ab-42cd-8abc-0123456789ab", delta: 1, reason: "manual correction",
    }), { DB: harness.database as unknown as D1Database });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "balance_overflow" });
    expect(harness.pointAccess.balance).not.toHaveBeenCalled();
    expect(harness.pointAccess.apply).toHaveBeenCalledOnce();
    expect(harness.operations.size).toBe(0);
    expect(harness.pending.size).toBe(0);
    expect(harness.auditWriter).not.toHaveBeenCalled();
  });

  it("reports an identical concurrent correction as booked after reaching the safe maximum (protects=replayed corrections return the persisted booking after another request fills the balance; fails_when=one identical request returns balance_overflow even though one operation is persisted; no_claim=the replay-aware ledger and its serialized operation are represented by an in-memory double)", async () => {
    const harness = createHarness({ initialBalance: Number.MAX_SAFE_INTEGER - 1 });
    await insertChannel(harness.database, CHANNEL_ID);
    harness.pointAccess.pendingAudits.mockResolvedValue([]);

    const ledgerApply = harness.pointAccess.apply.getMockImplementation();
    if (ledgerApply === undefined) throw new Error("The replay-aware ledger double is missing its implementation.");
    let releaseFirstApply = (): void => undefined;
    let signalFirstApply: () => void = () => undefined;
    const release = new Promise<void>((resolve) => { releaseFirstApply = resolve; });
    const firstApplied = new Promise<void>((resolve) => { signalFirstApply = resolve; });
    let applyCalls = 0;
    harness.pointAccess.apply.mockImplementation(async (operationId, kind, movements, result, payloadIdentity) => {
      const applied = await ledgerApply(operationId, kind, movements, result, payloadIdentity);
      applyCalls += 1;
      if (applyCalls === 1) {
        signalFirstApply();
        await release;
      }
      return applied;
    });

    const body = { operationId: "01234567-89ab-42cd-8abc-0123456789ab", delta: 1, reason: "concurrent safe maximum" };
    const firstRequest = harness.app.fetch(harness.request("/accounts/viewer_demo/adjust", body), {
      DB: harness.database as unknown as D1Database,
    });
    await firstApplied;
    const secondResponse = await harness.app.fetch(harness.request("/accounts/viewer_demo/adjust", body), {
      DB: harness.database as unknown as D1Database,
    });
    releaseFirstApply();
    const firstResponse = await firstRequest;

    expect([firstResponse.status, secondResponse.status].every((status) => status === 200 || status === 202)).toBe(true);
    expect([firstResponse.status, secondResponse.status]).not.toContain(400);
    await expect(firstResponse.json()).resolves.toMatchObject({ balance: Number.MAX_SAFE_INTEGER });
    await expect(secondResponse.json()).resolves.toMatchObject({ balance: Number.MAX_SAFE_INTEGER });
    expect(harness.pointAccess.apply).toHaveBeenCalledTimes(2);
    expect(harness.operations.size).toBe(1);
    expect(harness.operations.get(OPERATION_ID)).toMatchObject({ accountId: "viewer_demo", delta: 1 });
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

  it.each(["__house", "__jackpot:game_demo", "__escrow:round_demo", "__bosspot:round_demo", "viewer!", "x".repeat(33)])(
    "rejects reserved or invalid correction target %s before ledger work (protects=corrections only target viewer ids; fails_when=system or malformed ids reach the ledger; no_claim=the ledger access is an in-memory fake)",
    async (accountId) => {
      const harness = createHarness();
      await insertChannel(harness.database, CHANNEL_ID);

      const response = await harness.app.fetch(harness.request(`/accounts/${accountId}/adjust`, {
        operationId: "01234567-89ab-42cd-8abc-0123456789ab", delta: 1, reason: "manual correction",
      }), { DB: harness.database as unknown as D1Database });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({ error: "invalid_account" });
      expect(harness.pointAccess.getAccount).not.toHaveBeenCalled();
      expect(harness.pointAccess.pendingAudits).not.toHaveBeenCalled();
      expect(harness.pointAccess.apply).not.toHaveBeenCalled();
      expect(harness.auditWriter).not.toHaveBeenCalled();
    },
  );

  it("rejects a correction for an unknown viewer without creating an account (protects=adjustments require an exact existing viewer account; fails_when=an unknown id is booked or audit recovery starts; no_claim=the ledger access is an in-memory fake)", async () => {
    const harness = createHarness();
    await insertChannel(harness.database, CHANNEL_ID);

    const response = await harness.app.fetch(harness.request("/accounts/viewer_missing/adjust", {
      operationId: "01234567-89ab-42cd-8abc-0123456789ab", delta: 1, reason: "manual correction",
    }), { DB: harness.database as unknown as D1Database });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "account_not_found" });
    expect(harness.pointAccess.getAccount).toHaveBeenCalledExactlyOnceWith("viewer_missing");
    expect(harness.pointAccess.pendingAudits).not.toHaveBeenCalled();
    expect(harness.pointAccess.apply).not.toHaveBeenCalled();
    expect(harness.auditWriter).not.toHaveBeenCalled();
  });

  it("passes correction identity to the ledger and audits its persisted replay result (protects=correction identity and audit use the persisted operation; fails_when=the route loses server metadata or writes a different identity; no_claim=ledger apply is represented by an in-memory replay result)", async () => {
    const harness = createHarness();
    await insertChannel(harness.database, CHANNEL_ID);
    const persistedAt = "2026-10-19T11:59:00.000Z";
    harness.pointAccess.apply.mockImplementation((_operationId, _kind, movements, result) => {
      const detail = result as Operation;
      const userMovement = movements.find((movement) => movement.accountId !== "__house");
      if (userMovement === undefined) throw new Error("invalid_account");
      const persistedResult = { ...detail, actorLogin: "original_login", createdAt: persistedAt };
      harness.operations.set(detail.operationId, persistedResult);
      harness.pending.set(detail.operationId, persistedResult);
      return Promise.resolve({ replayed: true, result: persistedResult, balances: { [detail.accountId]: 62 } });
    });
    const body = { operationId: "01234567-89ab-42cd-8abc-0123456789ab", delta: 12, reason: "stream prize" };

    const response = await harness.app.fetch(harness.request("/accounts/viewer_demo/adjust", body), {
      DB: harness.database as unknown as D1Database,
    });

    expect(response.status).toBe(200);
    expect(harness.pointAccess.apply.mock.calls[0]?.[4]).toEqual({
      accountId: "viewer_demo", delta: 12, reason: "stream prize", actorId: ACTOR_ID,
    });
    expect(harness.auditWriter.mock.calls[0]?.[1]).toBe(persistedAt);
    expect(harness.auditWriter.mock.calls[0]?.[0].after).toMatchObject({ accountLogin: "pixelpilz", delta: 12, reason: "stream prize" });
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

  it("recovers an audit for the exact account beyond the first 50 substring matches (protects=pending audits resolve exact viewer ids outside the first page; fails_when=a substring match is audited as the target; no_claim=the ledger and account list are supplied by in-memory fakes)", async () => {
    const harness = createHarness();
    await insertChannel(harness.database, CHANNEL_ID);
    const accounts = Array.from({ length: 50 }, (_, index) => ({
      accountId: `richer_123_${String(index).padStart(2, "0")}`,
      login: `richer_demo_${String(index).padStart(2, "0")}`,
      balance: 10_000 - index,
      monthNet: 0,
    }));
    const target = { accountId: "123", login: "target_demo", balance: 1, monthNet: 0 };
    accounts.push(target);
    harness.pointAccess.listAccounts.mockImplementation((query) => {
      const matching = query.search === undefined
        ? accounts
        : accounts.filter((account) => account.accountId.includes(query.search ?? ""));
      return Promise.resolve({ rows: matching.sort((left, right) => right.balance - left.balance).slice(0, query.limit) });
    });
    const exactLookup = harness.pointAccess.getAccount;
    exactLookup.mockImplementation((accountId) => Promise.resolve(accounts.find((account) => account.accountId === accountId) ?? null));

    const pending: Operation = {
      operationId: OPERATION_ID,
      accountId: target.accountId,
      delta: 8,
      reason: "stream prize",
      actorId: ACTOR_ID,
      actorLogin: "kanal_demo",
      createdAt: "2026-10-19T12:00:00.000Z",
    };
    harness.pending.set(OPERATION_ID, pending);

    const response = await harness.app.fetch(harness.request("/accounts"), { DB: harness.database as unknown as D1Database });

    expect(response.status).toBe(200);
    expect(exactLookup).toHaveBeenCalledExactlyOnceWith("123");
    expect(harness.auditWriter).toHaveBeenCalledOnce();
    expect(harness.auditWriter.mock.calls[0]?.[0].after).toMatchObject({ accountId: "123", accountLogin: "target_demo" });
    expect(harness.pointAccess.markAuditWritten).toHaveBeenCalledWith(OPERATION_ID);
    expect(harness.pointAccess.listAccounts).toHaveBeenCalledOnce();
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

  it("loads an exact account detail by viewer ID (protects=selected accounts can refresh independently of their current page; fails_when=the route lists or returns a different account; no_claim=account detail comes from the in-memory ledger double)", async () => {
    const harness = createHarness({ role: "operator" });

    const response = await harness.app.fetch(harness.request("/accounts/viewer_demo"), { DB: harness.database as unknown as D1Database });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ accountId: "viewer_demo", login: "pixelpilz", balance: 50 });
    expect(harness.pointAccess.getAccount).toHaveBeenCalledExactlyOnceWith("viewer_demo");
    expect(harness.pointAccess.listAccounts).not.toHaveBeenCalled();
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
