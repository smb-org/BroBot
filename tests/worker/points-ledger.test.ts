import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  insertPointChannel,
  pointObject,
  pointTestModule,
  capturePointError,
  clearPointObjectAlarms,
  runPointObject,
  runMigrations,
  testCard,
} from "./points-test-helpers";

const now = (): number => Date.now();
const utcMonth = (): string => new Date().toISOString().slice(0, 7);

beforeAll(runMigrations);
afterEach(clearPointObjectAlarms);

describe("points ledger in the worker Durable Object", () => {
  it(`serializes parallel jackpot shares against refills (${testCard("all concurrent pot shares use the current pot balance", "two viewers can both receive the same jackpot balance")})`, async () => {
    const channelId = `points-parallel-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.applyPointOperation(pointTestModule, "seed-jackpot", "bonus", [
      { accountId: "__jackpot:test_game", delta: 300 },
      { accountId: "__house", delta: -300 },
    ], { source: "seed" });
    const players = Array.from({ length: 20 }, (_, index) => `viewer-${String(index)}`);
    const operations = players.map((accountId, index) => object.applyPointOperation(
      pointTestModule,
      `spin-${String(index)}`,
      "game",
      [
        { accountId: "__jackpot:test_game", delta: 50 },
        { accountId: "__house", delta: -50 },
        { accountId, potShare: { pot: "__jackpot:test_game", numerator: 1, denominator: 1 } },
      ],
      { winner: accountId },
    ));

    await Promise.all(operations);

    const winners = await Promise.all(players.map((accountId) => object.pointBalance(pointTestModule, accountId)));
    const summary = await object.pointSummary(pointTestModule);
    expect(winners.reduce((total, balance) => total + balance, 0)).toBe(1_300);
    expect(winners.every((balance) => balance >= 0)).toBe(true);
    expect(summary.jackpots).toEqual({ test_game: 0 });
    expect(summary.circulation).toBe(1_300);
    const invariant = await runPointObject(object, (_target, state) => state.storage.sql.exec<{
      balance_sum: number;
      min_non_house: number;
    }>(
      "SELECT COALESCE(SUM(balance), 0) AS balance_sum, MIN(CASE WHEN account_id = '__house' THEN NULL ELSE balance END) AS min_non_house FROM point_accounts",
    ).one());
    expect(invariant).toEqual({ balance_sum: 0, min_non_house: 0 });
    expect(summary.accounts).toBe(20);
    expect(summary.circulation).toBe(winners.reduce((total, balance) => total + balance, 0) + summary.inRounds +
      Object.values(summary.jackpots).reduce((total, balance) => total + balance, 0));
  });

  it(`keeps account balances zero-sum and replays an operation without another booking (${testCard("the ledger books each idempotency key once and preserves the channel sum", "a retry changes a viewer balance twice")})`, async () => {
    const channelId = `points-replay-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 100);
    const movement = [{ accountId: "viewer-a", delta: -15 }, { accountId: "__house", delta: 15 }];
    const first = await object.applyPointOperation(pointTestModule, "msg:spin-1", "game", movement, { symbols: ["x", "y"] });
    const beforeReplay = await object.pointBalance(pointTestModule, "viewer-a");
    const replay = await object.applyPointOperation(pointTestModule, "msg:spin-1", "game", movement, { symbols: ["x", "y"] });
    const history = await object.pointHistory(pointTestModule, "viewer-a");

    expect(first.replayed).toBe(false);
    expect(replay).toMatchObject({ replayed: true, result: { symbols: ["x", "y"] } });
    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(beforeReplay);
    expect(history.rows.filter((row) => row.operationId === "msg:spin-1")).toHaveLength(1);
    await expect(object.pointSummary(pointTestModule)).resolves.toMatchObject({ circulation: 85, accounts: 1 });
  });

  it(`replays concurrent identical admin corrections with the first metadata (${testCard("correction identity ignores server-generated result metadata while the ledger atomically books once", "identical concurrent corrections conflict because their timestamps differ or both book")})`, async () => {
    const channelId = `points-admin-replay-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 50);
    const operationId = "admin:01234567-89ab-42cd-8abc-0123456789ab";
    const movements = [{ accountId: "viewer-a", delta: 12 }, { accountId: "__house", delta: -12 }];
    const identity = { accountId: "viewer-a", delta: 12, reason: "stream prize", actorId: "manager-demo" };

    const results = await Promise.all([
      object.applyPointOperation(pointTestModule, operationId, "admin", movements, {
        ...identity, actorLogin: "kanal_demo", createdAt: "2026-10-19T12:00:00.000Z",
      }, identity),
      object.applyPointOperation(pointTestModule, operationId, "admin", movements, {
        ...identity, actorLogin: "kanal_demo", createdAt: "2026-10-19T12:00:01.000Z",
      }, identity),
    ]);

    expect(results.map(({ replayed }) => replayed).sort((left, right) => Number(left) - Number(right))).toEqual([false, true]);
    expect(results[0].result).toEqual(results[1].result);
    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(62);
    const history = await object.pointHistory(pointTestModule, "viewer-a");
    const correctionRows = history.rows.filter((row) => row.operationId === operationId);
    expect(correctionRows).toHaveLength(1);
    expect(correctionRows[0]).toMatchObject({ kind: "admin", delta: 12, detail: results[0].result });
  });

  it(`nets large repeated deltas exactly before booking (${testCard("same-account movements use exact net totals even when intermediate sums exceed safe integer precision", "viewer and house deltas drift by one after [M, 2, -M] cancellation")})`, async () => {
    const channelId = `points-large-netting-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    const max = Number.MAX_SAFE_INTEGER;

    await object.applyPointOperation(pointTestModule, "msg:large-net", "bonus", [
      { accountId: "viewer-a", delta: max },
      { accountId: "__house", delta: -max },
      { accountId: "viewer-a", delta: 2 },
      { accountId: "__house", delta: -2 },
      { accountId: "viewer-a", delta: -max },
      { accountId: "__house", delta: max },
    ], { reason: "exact netting" });

    await expect(runPointObject(object, (_target, state) => state.storage.sql.exec<{
      account_id: string;
      delta: number;
      balance_after: number;
    }>(
      "SELECT account_id, delta, balance_after FROM point_ledger WHERE operation_id = ? ORDER BY account_id",
      "msg:large-net",
    ).toArray())).resolves.toEqual([
      { account_id: "__house", delta: -2, balance_after: -2 },
      { account_id: "viewer-a", delta: 2, balance_after: 2 },
    ]);
    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(2);
    await expect(object.pointHistory(pointTestModule, "viewer-a")).resolves.toMatchObject({
      rows: [expect.objectContaining({ operationId: "msg:large-net", delta: 2, balanceAfter: 2 })],
    });
  });

  it(`rejects a game operation that overflows the cumulative monthly net atomically (${testCard("monthly game net stays within the safe-integer range and failed bookings roll back", "game credit MAX_SAFE_INTEGER, admin debit MAX_SAFE_INTEGER, then game credit 2 stores an inexact monthly score and rank 2 for the sole account")})`, async () => {
    const channelId = `points-monthly-overflow-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    const max = Number.MAX_SAFE_INTEGER;

    await object.applyPointOperation(pointTestModule, "game-monthly-max", "game", [
      { accountId: "viewer-a", delta: max, login: "nachtfalke" },
      { accountId: "__house", delta: -max },
    ], { payout: max });
    await object.applyPointOperation(pointTestModule, "admin-monthly-reset", "admin", [
      { accountId: "viewer-a", delta: -max },
      { accountId: "__house", delta: max },
    ], { reason: "reset balance" });

    await expect(capturePointError(object, (target) => target.applyPointOperation(
      pointTestModule,
      "game-monthly-overflow",
      "game",
      [
        { accountId: "viewer-a", delta: 2, login: "nachtfalke" },
        { accountId: "__house", delta: -2 },
      ],
      { payout: 2 },
    ))).resolves.toBe("monthly_overflow");

    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(0);
    await expect(object.pointRankOf(pointTestModule, "viewer-a", utcMonth())).resolves.toEqual({
      rank: 1,
      net: max,
    });
    const history = await object.pointHistory(pointTestModule, "viewer-a");
    expect(history.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: "game-monthly-max", delta: max }),
      expect.objectContaining({ operationId: "admin-monthly-reset", delta: -max }),
    ]));
    await expect(runPointObject(object, (_target, state) => state.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM point_operations WHERE operation_id = ?", "game-monthly-overflow",
    ).one().count)).resolves.toBe(0);
  });

  it(`returns the same JSON result on first execution and replay (${testCard("an operation returns exactly the representation persisted as JSON", "undefined returns before persistence as undefined and replays as null")})`, async () => {
    const channelId = `points-result-canonical-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    const movements = [{ accountId: "viewer-a", delta: 1 }, { accountId: "__house", delta: -1 }];

    const first = await object.applyPointOperation(pointTestModule, "msg:undefined-result", "bonus", movements, undefined);
    const replay = await object.applyPointOperation(pointTestModule, "msg:undefined-result", "bonus", movements, undefined);

    expect(first.replayed).toBe(false);
    expect(first.result).toBeNull();
    expect(replay.replayed).toBe(true);
    expect(replay.result).toBe(first.result);
  });

  it(`rejects an overdraft without writing either side of the transfer (${testCard("a failed apply rolls back the viewer and house together", "the viewer goes below zero or the house is credited")})`, async () => {
    const channelId = `points-overdraft-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointTestModule, "viewer-a", "pixelpilz", 0);

    await expect(capturePointError(object, (target) => target.applyPointOperation(pointTestModule, "msg:too-large", "game", [
      { accountId: "viewer-a", delta: -1 },
      { accountId: "__house", delta: 1 },
    ], { stake: 1 }))).resolves.toBe("insufficient_balance");

    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(0);
    await expect(object.pointHistory(pointTestModule, "viewer-a")).resolves.toMatchObject({ rows: [] });
    await expect(object.pointSummary(pointTestModule)).resolves.toMatchObject({ circulation: 0, accounts: 1 });
  });

  it(`rejects invalid viewer and malformed system account IDs through apply (${testCard("generic ledger movements enforce viewer and reserved account formats", "an invalid account is accepted by apply but rejected by balance and history")})`, async () => {
    const channelId = `points-invalid-accounts-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);

    for (const accountId of ["a".repeat(33), "viewer/invalid"]) {
      await expect(capturePointError(object, (target) => target.applyPointOperation(pointTestModule,
        `invalid-viewer:${accountId}`, "bonus", [
          { accountId, delta: 1 }, { accountId: "__house", delta: -1 },
        ], {}))).resolves.toBe("invalid_account_id");
    }
    await expect(capturePointError(object, (target) => target.applyPointOperation(pointTestModule,
      "invalid-system-account", "bonus", [
        { accountId: "__escrow:round/invalid", delta: 1 }, { accountId: "__house", delta: -1 },
      ], {}))).resolves.toBe("invalid_account");

    await expect(object.pointSummary(pointTestModule)).resolves.toMatchObject({ circulation: 0, accounts: 0 });
  });

  it(`rejects an idempotency key reused with a different payload (${testCard("payload hashes distinguish conflicting requests", "the second payload is silently treated as the first")})`, async () => {
    const channelId = `points-conflict-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 25);
    await object.applyPointOperation(pointTestModule, "msg:same", "game", [
      { accountId: "viewer-a", delta: -3 }, { accountId: "__house", delta: 3 },
    ], { bet: 3 });

    await expect(capturePointError(object, (target) => target.applyPointOperation(pointTestModule, "msg:same", "game", [
      { accountId: "viewer-a", delta: -4 }, { accountId: "__house", delta: 4 },
    ], { bet: 4 }))).resolves.toBe("operation_conflict");

    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(22);
    const history = await object.pointHistory(pointTestModule, "viewer-a");
    expect(history.rows.some((row) => row.operationId === "msg:same")).toBe(true);
  });

  it(`nets repeated movements before recording one account row (${testCard("same-account deltas collapse into one ledger row", "history shows multiple rows for one operation and account")})`, async () => {
    const channelId = `points-netting-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 40);

    await object.applyPointOperation(pointTestModule, "msg:net", "bonus", [
      { accountId: "viewer-a", delta: 8 },
      { accountId: "viewer-a", delta: -3 },
      { accountId: "__house", delta: -5 },
    ], { reason: "net test" });

    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(45);
    const history = await object.pointHistory(pointTestModule, "viewer-a");
    expect(history.rows.some((row) => row.operationId === "msg:net" && row.delta === 5 && row.balanceAfter === 45)).toBe(true);
  });

  it(`isolates accounts by channel Durable Object (${testCard("same account ids have independent tenant balances", "a write in one channel changes another channel")})`, async () => {
    const firstChannel = `points-channel-a-${crypto.randomUUID()}`;
    const secondChannel = `points-channel-b-${crypto.randomUUID()}`;
    await Promise.all([insertPointChannel(firstChannel), insertPointChannel(secondChannel)]);
    const first = pointObject(firstChannel);
    const second = pointObject(secondChannel);
    await first.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 30);
    await second.touchPointAccount(pointTestModule, "viewer-a", "pixelpilz", 7);

    await expect(Promise.all([
      first.pointBalance(pointTestModule, "viewer-a"),
      second.pointBalance(pointTestModule, "viewer-a"),
    ])).resolves.toEqual([30, 7]);
  });

  it(`evaluates ordered pot shares around a refill (${testCard("the second jackpot winner receives only the post-refill pot", "a winner receives the pre-refill pot more than once")})`, async () => {
    const channelId = `points-potshare-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 500);
    await object.touchPointAccount(pointTestModule, "viewer-b", "pixelpilz", 500);
    await object.applyPointOperation(pointTestModule, "seed-jackpot", "bonus", [
      { accountId: "__jackpot:test_game", delta: 1_256 },
      { accountId: "__house", delta: -1_256 },
    ], { source: "seed" });

    for (const [operationId, accountId] of [["spin-a", "viewer-a"], ["spin-b", "viewer-b"]] as const) {
      await object.applyPointOperation(pointTestModule, operationId, "game", [
        { accountId, delta: -500 },
        { accountId: "__jackpot:test_game", delta: 35 },
        { accountId: "__house", delta: 465 },
        { accountId, potShare: { pot: "__jackpot:test_game", numerator: 1, denominator: 1 } },
        { accountId: "__jackpot:test_game", delta: 500 },
        { accountId: "__house", delta: -500 },
      ], { winner: accountId });
    }

    await expect(Promise.all([
      object.pointBalance(pointTestModule, "viewer-a"),
      object.pointBalance(pointTestModule, "viewer-b"),
    ])).resolves.toEqual([1_291, 535]);
    await expect(object.pointSummary(pointTestModule)).resolves.toMatchObject({ circulation: 2_326, jackpots: { test_game: 500 } });
  });

  it(`floors pot shares using exact integer arithmetic (${testCard("large valid ratios preserve the exact floored payout", "floating point rounds a payout up by one")})`, async () => {
    const channelId = `points-potshare-boundary-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.applyPointOperation(pointTestModule, "seed-boundary-pot", "bonus", [
      { accountId: "__jackpot:test_game", delta: 3 },
      { accountId: "__house", delta: -3 },
    ], { source: "boundary" });

    await object.applyPointOperation(pointTestModule, "boundary-share", "game", [
      { accountId: "viewer-a", potShare: {
        pot: "__jackpot:test_game",
        numerator: 9_007_199_254_740_986,
        denominator: 9_007_199_254_740_987,
      } },
    ], { payout: "boundary" });

    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(2);
    await expect(object.pointSummary(pointTestModule)).resolves.toMatchObject({ jackpots: { test_game: 1 } });
  });

  it(`creates a rankable account after a zero-payout first game (${testCard("zero-net participants exist in ranking, rank lookup, account listing, and summary", "rankOf counts a participant missing from the ranking and account APIs", "a zero-payout first game has no prior account setup")})`, async () => {
    const channelId = `points-zero-payout-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    const month = utcMonth();

    await object.applyPointOperation(pointTestModule, "game-zero", "game", [
      { accountId: "viewer-zero", delta: 0, login: "funkenfuchs" },
      { accountId: "__house", delta: 0 },
    ], { payout: 0 });

    await expect(object.pointRanking(pointTestModule, month, 10)).resolves.toEqual([
      { accountId: "viewer-zero", login: "funkenfuchs", net: 0 },
    ]);
    await expect(object.pointRankOf(pointTestModule, "viewer-zero", month)).resolves.toEqual({ rank: 1, net: 0 });
    await expect(object.listPointAccounts(pointTestModule, { sort: "month", limit: 10 })).resolves.toMatchObject({
      rows: [{ accountId: "viewer-zero", login: "funkenfuchs", balance: 0, monthNet: 0 }],
    });
    await expect(object.pointSummary(pointTestModule)).resolves.toMatchObject({ accounts: 1 });
  });

  it(`credits at most once per message-time window and clips to the UTC daily cap (${testCard("activity uses UTC message timestamps and cap remaining", "offline messages or retries create extra points")})`, async () => {
    const channelId = `points-activity-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    const day = Date.UTC(2026, 9, 18, 12, 2);
    const rules = { amount: 4, windowMinutes: 10, dailyCap: 7 };

    await expect(object.creditPointActivity(pointTestModule, "viewer-a", "nachtfalke", day, false, rules)).resolves.toEqual({ credited: 0 });
    await expect(object.creditPointActivity(pointTestModule, "viewer-a", "nachtfalke", day, true, rules)).resolves.toEqual({ credited: 4 });
    await expect(object.creditPointActivity(pointTestModule, "viewer-a", "nachtfalke", day + 2_000, false, rules)).resolves.toEqual({ credited: 0 });
    await expect(object.creditPointActivity(pointTestModule, "viewer-a", "nachtfalke", day + 10 * 60_000, true, rules)).resolves.toEqual({ credited: 3 });
    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(7);
  });

  it(`clips twenty concurrent activity windows to one daily cap (${testCard("parallel UTC windows share the remaining daily allowance", "concurrent credits exceed the configured cap")})`, async () => {
    const channelId = `points-activity-parallel-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    const day = Date.UTC(2026, 9, 18, 0, 0);
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
      object.creditPointActivity(pointTestModule, "viewer-a", "pixelpilz", day + index * 10 * 60_000,
        true, { amount: 2, windowMinutes: 10, dailyCap: 11 }),
    ));

    expect(results.reduce((total, result) => total + result.credited, 0)).toBe(11);
    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(11);
  });

  it(`creates the account and start bonus together, then waits for the welcome acknowledgement (${testCard("first contact is atomic and welcome state clears only after acknowledgement", "the account lacks its bonus or welcome is cleared early")})`, async () => {
    const channelId = `points-first-contact-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);

    await expect(object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 75)).resolves.toEqual({ welcomePending: true, startBonus: 75 });
    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(75);
    await expect(object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke_neu", 75)).resolves.toEqual({ welcomePending: true, startBonus: 75 });
    await expect(object.pointHistory(pointTestModule, "viewer-a")).resolves.toMatchObject({ rows: [{ operationId: "bonus:viewer-a" }] });

    await object.storePendingPointWelcome(pointTestModule, {
      accountId: "viewer-a",
      messageId: "message-first-contact",
      text: "Start bonus 75 points",
    });
    expect(await object.claimPointWelcome(pointTestModule, "viewer-a", "dispatch:first-contact:points:0")).toBe(true);
    await object.acknowledgePointWelcome(pointTestModule, "viewer-a", "dispatch:first-contact:points:0");

    await expect(object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke_neu", 75)).resolves.toEqual({ welcomePending: false, startBonus: 75 });
    await expect(object.pointBalance(pointTestModule, "viewer-a")).resolves.toBe(75);
    await expect(object.pointSummary(pointTestModule)).resolves.toMatchObject({ accounts: 1, circulation: 75 });
  });

  it(`rolls back first contact if bonus booking fails inside its transaction (${testCard("account creation and its first bonus commit together", "a failed bonus leaves a zero-balance account behind", "a conflicting preexisting bonus operation simulates failure after the account insert")})`, async () => {
    const channelId = `points-first-contact-failure-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);

    await runPointObject(object, async (target, state) => {
      await target.pointBalance(pointTestModule, "viewer-a");
      state.storage.sql.exec(
        `INSERT INTO point_operations (operation_id, module_id, kind, result_json, payload_hash, audit_state, created_at)
         VALUES ('bonus:viewer-a', ?, 'bonus', 'null', 'existing-operation', NULL, ?)`,
        pointTestModule,
        new Date().toISOString(),
      );
    });

    await expect(capturePointError(object, (target) => target.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 25)))
      .resolves.toBe("operation_conflict");
    const accountRows = await runPointObject(object, (_target, state) =>
      state.storage.sql.exec("SELECT account_id FROM point_accounts WHERE account_id = 'viewer-a'").toArray());
    expect(accountRows).toEqual([]);
    await expect(object.pointSummary(pointTestModule)).resolves.toMatchObject({ accounts: 0, circulation: 0 });
  });

  it(`paginates account search, operation history, summary, ranking ties and rank lookup (${testCard("read APIs use persisted balances and deterministic monthly order", "pages overlap, non-game credits rank, or equal scores drift")})`, async () => {
    const channelId = `points-read-api-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 20);
    await object.touchPointAccount(pointTestModule, "viewer-b", "nachtfalke_zwei", 10);
    await object.touchPointAccount(pointTestModule, "viewer-c", "pixelpilz", 0);
    await object.applyPointOperation(pointTestModule, "game-a", "game", [
      { accountId: "viewer-a", delta: 5 }, { accountId: "__house", delta: -5 },
    ], { payout: 5 });
    await object.applyPointOperation(pointTestModule, "game-b", "game", [
      { accountId: "viewer-b", delta: 5 }, { accountId: "__house", delta: -5 },
    ], { payout: 5 });

    const firstPage = await object.listPointAccounts(pointTestModule, { sort: "balance", limit: 2 });
    const secondPage = await object.listPointAccounts(pointTestModule, {
      sort: "balance",
      limit: 2,
      ...(firstPage.cursor === undefined ? {} : { cursor: firstPage.cursor }),
    });
    const monthFirstPage = await object.listPointAccounts(pointTestModule, { sort: "month", limit: 2 });
    const monthSecondPage = await object.listPointAccounts(pointTestModule, {
      sort: "month",
      limit: 2,
      ...(monthFirstPage.cursor === undefined ? {} : { cursor: monthFirstPage.cursor }),
    });
    const searched = await object.listPointAccounts(pointTestModule, { sort: "balance", search: "nachtfalke", limit: 10 });
    const history = await object.pointHistory(pointTestModule, "viewer-a", undefined, 1);
    const ranking = await object.pointRanking(pointTestModule, utcMonth(), 10);
    const summary = await object.pointSummary(pointTestModule);

    expect(firstPage.rows.map((row) => row.accountId)).toEqual(["viewer-a", "viewer-b"]);
    expect(secondPage.rows.map((row) => row.accountId)).toEqual(["viewer-c"]);
    expect(monthFirstPage.rows.map((row) => [row.accountId, row.monthNet])).toEqual([[
      "viewer-a", 5,
    ], ["viewer-b", 5]]);
    expect(monthSecondPage.rows.map((row) => [row.accountId, row.monthNet])).toEqual([["viewer-c", null]]);
    expect(searched.rows.map((row) => row.login)).toEqual(["nachtfalke", "nachtfalke_zwei"]);
    expect(history.rows).toMatchObject([{ operationId: "game-a", delta: 5, balanceAfter: 25, detail: { payout: 5 } }]);
    expect(ranking).toEqual([
      { accountId: "viewer-a", login: "nachtfalke", net: 5 },
      { accountId: "viewer-b", login: "nachtfalke_zwei", net: 5 },
    ]);
    await expect(object.pointRankOf(pointTestModule, "viewer-a", utcMonth())).resolves.toEqual({ rank: 1, net: 5 });
    await expect(object.pointRankOf(pointTestModule, "viewer-c", utcMonth())).resolves.toEqual({ rank: null, net: 0 });
    expect(summary).toMatchObject({ accounts: 3, circulation: 40, jackpots: {}, inRounds: 0 });
  });

  it(`claims each cooldown once until its deadline (${testCard("cooldown claims serialize concurrent callers", "two callers both claim the same key")})`, async () => {
    const channelId = `points-cooldown-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);

    const results = await Promise.all(Array.from({ length: 10 }, () =>
      object.claimPointCooldown(pointTestModule, "daily-bonus", 60),
    ));

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(now()).toBeGreaterThan(0);
  });

  it(`keeps admin audit details pending until the host marks them written (${testCard("admin operation audit state forms a durable outbox", "a pending correction disappears before its host audit is written")})`, async () => {
    const channelId = `points-audit-${crypto.randomUUID()}`;
    await insertPointChannel(channelId);
    const object = pointObject(channelId);
    await object.touchPointAccount(pointTestModule, "viewer-a", "nachtfalke", 0);
    await object.applyPointOperation(pointTestModule, "admin:demo", "admin", [
      { accountId: "viewer-a", delta: 9 }, { accountId: "__house", delta: -9 },
    ], { reason: "missed award", actor: "manager" });

    await expect(object.pendingPointAudits(pointTestModule)).resolves.toEqual([
      { operationId: "admin:demo", detail: { reason: "missed award", actor: "manager" } },
    ]);
    await object.markPointAuditWritten(pointTestModule, "admin:demo");
    await expect(object.pendingPointAudits(pointTestModule)).resolves.toEqual([]);
  });
});
